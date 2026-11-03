//! AI CLI(Claude Code / Codex) 탐색·실행·모델 목록·인증 확인, 출력 파싱.

use super::*;

pub(super) struct AiOutput {
    pub(super) result: String,
    pub(super) stderr: String,
    pub(super) is_error: bool,
}

/// 선택한 AI CLI를 비대화형으로 실행한다. 타임아웃 시 프로세스를 종료한다.
pub(super) fn spawn_ai(
    app: &AppHandle,
    config: &AiConfig,
    prompt: &str,
    cwd: &PathBuf,
) -> Result<AiOutput, String> {
    match config.provider {
        AiProvider::Claude => spawn_claude(
            config.executable.as_ref().expect("checked executable"),
            prompt,
            &ensure_mcp_config(app)?,
            cwd,
            config.model.as_deref(),
        ),
        AiProvider::Codex => spawn_codex(
            config.executable.as_ref().expect("checked executable"),
            prompt,
            cwd,
            config.model.as_deref(),
        ),
    }
}

pub(super) fn spawn_claude(
    claude: &PathBuf,
    prompt: &str,
    mcp_path: &PathBuf,
    cwd: &PathBuf,
    model: Option<&str>,
) -> Result<AiOutput, String> {
    let mut cmd = std::process::Command::new(claude);
    cmd.arg("-p");
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    cmd.arg(prompt)
        .arg("--mcp-config")
        .arg(mcp_path)
        .arg("--strict-mcp-config")
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--permission-mode")
        .arg("default")
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg("30")
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (stdout, stderr, status_ok) = run_child(cmd, "Claude Code", None)?;

    if stdout.trim().is_empty() {
        let tail = tail_chars(&stderr, 300);
        return Err(if tail.is_empty() {
            "claude 가 빈 출력을 반환했습니다 (인증/네트워크 확인).".to_string()
        } else {
            format!("claude 출력이 비었습니다. stderr: {}", tail)
        });
    }

    let envelope: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Claude Code 출력(JSON 봉투) 파싱 실패: {}", e))?;
    let is_error = !status_ok
        || envelope.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
    let result = envelope
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(AiOutput { result, stderr, is_error })
}

pub(super) fn spawn_codex(
    codex: &PathBuf,
    prompt: &str,
    cwd: &PathBuf,
    model: Option<&str>,
) -> Result<AiOutput, String> {
    let result_path = cwd.join(format!(
        "briefing-codex-{}-{}.txt",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let schema_path = write_codex_output_schema(cwd)?;
    let mut cmd = std::process::Command::new(codex);
    // `--approve-for-me`는 현재 Codex CLI에서 sandbox 옵션과 같이 쓸 수 없다.
    // 대신 읽기 전용 sandbox + 자동 검토자를 명시해 MCP 조회 승인만 headless로 처리한다.
    cmd.arg("--ask-for-approval")
        .arg("on-request")
        .arg("exec");
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    cmd.arg("--sandbox")
        .arg("read-only")
        .arg("--ignore-user-config")
        .arg("--skip-git-repo-check")
        .arg("--ephemeral")
        .arg("--color")
        .arg("never")
        .arg("--output-last-message")
        .arg(&result_path)
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("-c")
        .arg("mcp_servers.hypercool.url=\"http://localhost:3737/mcp\"")
        .arg("-c")
        .arg("approvals_reviewer=\"auto_review\"")
        .arg("-")
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (stdout, stderr, status_ok) = match run_child(cmd, "Codex", Some(prompt)) {
        Ok(output) => output,
        Err(error) => {
            let _ = std::fs::remove_file(&result_path);
            let _ = std::fs::remove_file(&schema_path);
            return Err(error);
        }
    };
    let result = std::fs::read_to_string(&result_path).unwrap_or_else(|_| stdout.clone());
    let _ = std::fs::remove_file(&result_path);
    let _ = std::fs::remove_file(&schema_path);
    if result.trim().is_empty() {
        let tail = tail_chars(&stderr, 300);
        return Err(if tail.is_empty() {
            "Codex가 빈 출력을 반환했습니다 (로그인/네트워크 확인).".to_string()
        } else {
            format!("Codex 출력이 비었습니다. stderr: {}", tail)
        });
    }
    Ok(AiOutput { result, stderr, is_error: !status_ok })
}

/// Codex `--output-schema`용 일정 목록 스키마를 만든다.
/// Codex는 스키마 루트 객체만 지원하므로 결과를 {"items": [...]}로 감싼다.
pub(super) fn write_codex_output_schema(cwd: &PathBuf) -> Result<PathBuf, String> {
    let schema_path = cwd.join(format!(
        "briefing-codex-schema-{}-{}.json",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let nullable_string = serde_json::json!({ "type": ["string", "null"] });
    let schema = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": nullable_string.clone(),
                        "source_message_id": { "type": ["integer", "null"] },
                        "received_at": nullable_string.clone(),
                        "sender": nullable_string.clone(),
                        "type": nullable_string.clone(),
                        "title": nullable_string.clone(),
                        "detail": nullable_string.clone(),
                        "date": nullable_string.clone(),
                        "time": nullable_string.clone(),
                        "all_day": { "type": ["boolean", "null"] },
                        "period": nullable_string.clone(),
                        "has_attachment": { "type": ["boolean", "null"] },
                        "urgency": nullable_string.clone(),
                        "active_from": nullable_string.clone(),
                        "active_until": nullable_string.clone(),
                        "source_text": nullable_string,
                        "source_doc_id": { "type": ["integer", "null"] }
                    },
                    "required": [
                        "id", "source_message_id", "received_at", "sender", "type", "title",
                        "detail", "date", "time", "all_day", "period", "has_attachment",
                        "urgency", "active_from", "active_until", "source_text",
                        "source_doc_id"
                    ]
                }
            }
        },
        "required": ["items"]
    });
    let content = serde_json::to_vec(&schema)
        .map_err(|e| format!("Codex 출력 스키마 직렬화 실패: {}", e))?;
    std::fs::write(&schema_path, content)
        .map_err(|e| format!("Codex 출력 스키마 저장 실패: {}", e))?;
    Ok(schema_path)
}

pub(super) fn run_child(
    mut cmd: std::process::Command,
    label: &str,
    stdin_input: Option<&str>,
) -> Result<(String, String, bool), String> {
    use std::io::{Read, Write};

    let mut child = cmd.spawn().map_err(|e| format!("{} 실행 실패: {}", label, e))?;
    if let Some(input) = stdin_input {
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} stdin 연결 실패", label))
            .and_then(|mut stdin| {
                stdin
                    .write_all(input.as_bytes())
                    .map_err(|e| format!("{} 프롬프트 전송 실패: {}", label, e))
            });
        if let Err(error) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut p) = out_pipe { let _ = p.read_to_string(&mut buf); }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut p) = err_pipe { let _ = p.read_to_string(&mut buf); }
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(TIMEOUT_SECS);
    let status_ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(format!("{} 실행이 {}초 내에 끝나지 않아 중단했습니다.", label, TIMEOUT_SECS));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(format!("{} 프로세스 상태 확인 실패: {}", label, e));
            }
        }
    };
    Ok((out_handle.join().unwrap_or_default(), err_handle.join().unwrap_or_default(), status_ok))
}

// ─── 파싱 ─────────────────────────────────────────────────────────────────────

pub(super) fn parse_items_from_result(result: &str) -> Result<Vec<ExtractedItem>, String> {
    // Codex --output-schema는 {"items":[...]}를 반환한다. Claude와 이전 출력의
    // 최상위 배열도 유지해 기존 등록 결과를 깨지 않는다.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(result.trim()) {
        if let Some(items) = value.get("items").and_then(|v| v.as_array()) {
            return serde_json::from_value(serde_json::Value::Array(items.clone()))
                .map_err(|e| format!("일정 JSON 배열 파싱 실패: {}", e));
        }
        if value.is_array() {
            return serde_json::from_value(value)
                .map_err(|e| format!("일정 JSON 배열 파싱 실패: {}", e));
        }
    }
    let arr_text = extract_json_array(result)
        .ok_or_else(|| "AI 결과에서 JSON 배열을 찾지 못했습니다.".to_string())?;

    serde_json::from_str(&arr_text).map_err(|e| format!("일정 JSON 배열 파싱 실패: {}", e))
}

/// 문자열에서 첫 '[' ~ 마지막 ']' 구간을 JSON 배열로 추출(코드펜스·머리말 방어).
pub(super) fn extract_json_array(s: &str) -> Option<String> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(s[start..=end].to_string())
}

/// app_data_dir 에 claude 용 mcp.json 을 보장(항상 최신 내용으로 기록).
pub(super) fn ensure_mcp_config(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let path = dir.join("mcp.json");
    let content = serde_json::json!({
        "mcpServers": {
            "hypercool": { "type": "http", "url": "http://localhost:3737/mcp" }
        }
    });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

/// claude 실행 파일 경로 탐색: 레지스트리 override → `where claude` → 공통 경로.
pub(super) fn find_claude() -> Option<PathBuf> {
    // 1) 사용자 지정 경로.
    if let Ok(Some(p)) = get_registry_value(REG_CLAUDE_PATH.to_string()) {
        let pb = PathBuf::from(p.trim());
        if pb.exists() {
            return Some(pb);
        }
    }

    // 2) where claude (PATH 해석).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(out) = std::process::Command::new("cmd")
            .args(["/C", "where", "claude"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if out.status.success() {
                if let Ok(s) = String::from_utf8(out.stdout) {
                    // .exe/.cmd 우선, 없으면 첫 유효 라인.
                    let mut fallback: Option<PathBuf> = None;
                    for line in s.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let lower = line.to_lowercase();
                        let pb = PathBuf::from(line);
                        if (lower.ends_with(".exe") || lower.ends_with(".cmd")) && pb.exists() {
                            return Some(pb);
                        }
                        if fallback.is_none() && pb.exists() {
                            fallback = Some(pb);
                        }
                    }
                    if fallback.is_some() {
                        return fallback;
                    }
                }
            }
        }
    }

    // 3) 공통 설치 경로.
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let pb = PathBuf::from(&userprofile).join(".local").join("bin").join("claude.exe");
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        for name in ["claude.cmd", "claude.exe"] {
            let pb = PathBuf::from(&appdata).join("npm").join(name);
            if pb.exists() {
                return Some(pb);
            }
        }
    }

    None
}

/// codex 실행 파일 경로 탐색: 레지스트리 override → `where codex` → 공통 경로.
pub(super) fn find_codex() -> Option<PathBuf> {
    if let Ok(Some(p)) = get_registry_value(REG_CODEX_PATH.to_string()) {
        let pb = PathBuf::from(p.trim());
        if pb.exists() { return Some(pb); }
    }
    find_on_windows_path("codex").or_else(|| find_common_cli("codex"))
}

pub(super) fn claude_fallback_models() -> Vec<BriefingModelOption> {
    ["sonnet", "opus", "haiku"]
        .iter()
        .map(|id| BriefingModelOption {
            id: id.to_string(),
            label: id.to_string(),
            description: "Claude Code 모델 별칭".to_string(),
            is_default: false,
        })
        .collect()
}

/// Claude Code 를 stream-json 모드로 띄워 SDK 제어 요청 `initialize` 를 보내고,
/// 응답의 `models`(현재 계정에서 /model 선택기에 보이는 목록)를 읽는다. API 호출 없음.
pub(super) fn list_claude_models(claude: &PathBuf) -> Result<Vec<BriefingModelOption>, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;

    let mut cmd = std::process::Command::new(claude);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Claude Code 실행 실패: {}", e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "Claude stdin 연결 실패".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Claude stdout 연결 실패".to_string())?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = tx.send(value);
            }
        }
    });

    let request = serde_json::json!({
        "type": "control_request",
        "request_id": "hypercool-models",
        "request": { "subtype": "initialize" }
    });
    let sent = writeln!(stdin, "{}", request).and_then(|_| stdin.flush());
    if let Err(e) = sent {
        let _ = child.kill();
        return Err(format!("Claude 요청 전송 실패: {}", e));
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let response = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(value) if value.get("type").and_then(|v| v.as_str()) == Some("control_response") => break value,
            Ok(_) => continue,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude 모델 목록 조회 시간이 초과되었습니다.".to_string());
            }
        }
    };
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    parse_claude_model_response(&response)
}

pub(super) fn parse_claude_model_response(value: &serde_json::Value) -> Result<Vec<BriefingModelOption>, String> {
    let inner = value.get("response").ok_or_else(|| "Claude 응답 형식이 올바르지 않습니다.".to_string())?;
    if inner.get("subtype").and_then(|v| v.as_str()) == Some("error") {
        return Err(format!(
            "Claude 초기화 실패: {}",
            inner.get("error").and_then(|v| v.as_str()).unwrap_or("알 수 없는 오류")
        ));
    }
    let models = inner
        .pointer("/response/models")
        .or_else(|| inner.get("models"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Claude 응답에 모델 목록이 없습니다.".to_string())?;

    // "default" 항목은 별도 선택지로 두지 않고(빈 값 = CLI 기본), 그것이 가리키는 모델에 기본 표시만 단다.
    let default_resolved = models
        .iter()
        .find(|m| m.get("value").and_then(|v| v.as_str()) == Some("default"))
        .and_then(|m| m.get("resolvedModel").and_then(|v| v.as_str()))
        .map(str::to_string);
    let mut default_marked = false;
    let out: Vec<BriefingModelOption> = models
        .iter()
        .filter_map(|m| {
            let id = m.get("value")?.as_str()?.trim();
            if id.is_empty() || id == "default" {
                return None;
            }
            let resolved = m.get("resolvedModel").and_then(|v| v.as_str());
            let is_default = !default_marked && resolved.is_some() && resolved == default_resolved.as_deref();
            if is_default {
                default_marked = true;
            }
            Some(BriefingModelOption {
                id: id.to_string(),
                label: m.get("displayName").and_then(|v| v.as_str()).unwrap_or(id).to_string(),
                description: m.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                is_default,
            })
        })
        .collect();
    if out.is_empty() {
        return Err("Claude 모델 목록이 비어 있습니다.".to_string());
    }
    Ok(out)
}

/// Codex App Server와 짧게 연결해 현재 선택기에 노출되는 모델만 가져온다.
pub(super) fn list_codex_models(codex: &PathBuf) -> Result<Vec<BriefingModelOption>, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;

    let mut cmd = std::process::Command::new(codex);
    cmd.arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Codex App Server 실행 실패: {}", e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "Codex stdin 연결 실패".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Codex stdout 연결 실패".to_string())?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = tx.send(value);
            }
        }
    });

    let send = |writer: &mut std::process::ChildStdin, value: serde_json::Value| -> Result<(), String> {
        writeln!(writer, "{}", value).map_err(|e| format!("Codex 요청 전송 실패: {}", e))?;
        writer.flush().map_err(|e| format!("Codex 요청 전송 실패: {}", e))
    };
    send(&mut stdin, serde_json::json!({
        "method": "initialize",
        "id": 1,
        "params": { "clientInfo": { "name": "hypercool", "title": "HyperCool", "version": env!("CARGO_PKG_VERSION") } }
    }))?;

    let init_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = init_deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(value) if value.get("id").and_then(|v| v.as_i64()) == Some(1) => {
                if value.get("error").is_some() {
                    let _ = child.kill();
                    return Err(format!("Codex 초기화 실패: {}", value["error"]));
                }
                break;
            }
            Ok(_) => continue,
            Err(_) => {
                let _ = child.kill();
                return Err("Codex 모델 목록 초기화 시간이 초과되었습니다.".to_string());
            }
        }
    }

    send(&mut stdin, serde_json::json!({ "method": "initialized", "params": {} }))?;
    send(&mut stdin, serde_json::json!({
        "method": "model/list", "id": 2, "params": { "limit": 100, "includeHidden": false }
    }))?;

    let list_deadline = Instant::now() + Duration::from_secs(10);
    let response = loop {
        let remaining = list_deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(value) if value.get("id").and_then(|v| v.as_i64()) == Some(2) => break value,
            Ok(_) => continue,
            Err(_) => {
                let _ = child.kill();
                return Err("Codex 모델 목록 조회 시간이 초과되었습니다.".to_string());
            }
        }
    };
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    if let Some(error) = response.get("error") {
        return Err(format!("Codex 모델 목록 조회 실패: {}", error));
    }
    parse_codex_model_response(&response)
}

pub(super) fn parse_codex_model_response(value: &serde_json::Value) -> Result<Vec<BriefingModelOption>, String> {
    let data = value
        .pointer("/result/data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Codex 모델 목록 응답 형식이 올바르지 않습니다.".to_string())?;
    let models: Vec<BriefingModelOption> = data
        .iter()
        .filter(|item| !item.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|item| {
            let id = item.get("model").or_else(|| item.get("id"))?.as_str()?.trim();
            if id.is_empty() { return None; }
            Some(BriefingModelOption {
                id: id.to_string(),
                label: item.get("displayName").and_then(|v| v.as_str()).unwrap_or(id).to_string(),
                description: item.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                is_default: item.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect();
    if models.is_empty() {
        Err("Codex에서 선택 가능한 모델을 반환하지 않았습니다.".to_string())
    } else {
        Ok(models)
    }
}

#[cfg(windows)]
pub(super) fn find_on_windows_path(command: &str) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("cmd")
        .args(["/C", "where", command])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8(out.stdout).ok()?;
    let paths: Vec<PathBuf> = text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .collect();
    paths.iter()
        .find(|path| path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("exe")).unwrap_or(false))
        .cloned()
        .or_else(|| paths.iter()
            .find(|path| path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("cmd")).unwrap_or(false))
            .cloned())
        .or_else(|| paths.into_iter().next())
}

#[cfg(not(windows))]
pub(super) fn find_on_windows_path(_command: &str) -> Option<PathBuf> { None }

pub(super) fn find_common_cli(name: &str) -> Option<PathBuf> {
    // Codex Desktop installs a native executable here. Prefer it over the npm
    // .cmd shim because direct batch-file execution is fragile on Windows.
    if name == "codex" {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let bin_dir = PathBuf::from(local_app_data)
                .join("OpenAI")
                .join("Codex")
                .join("bin");
            if let Ok(entries) = std::fs::read_dir(bin_dir) {
                for entry in entries.flatten() {
                    let path = entry.path().join("codex.exe");
                    if path.exists() { return Some(path); }
                }
            }
        }
    }

    let filenames = [format!("{}.cmd", name), format!("{}.exe", name)];
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        for filename in &filenames {
            let path = PathBuf::from(&userprofile).join(".local").join("bin").join(filename);
            if path.exists() { return Some(path); }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        for filename in &filenames {
            let path = PathBuf::from(&appdata).join("npm").join(filename);
            if path.exists() { return Some(path); }
        }
    }
    None
}

/// CLI 오류 메시지가 로그인 만료/미로그인 때문인지 판별한다.
/// 예: Claude Code "Failed to authenticate: OAuth session expired and could not be refreshed"
pub(super) fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    [
        "failed to authenticate",
        "authentication_error",
        "oauth session expired",
        "invalid api key",
        "not logged in",
        "please run /login",
        "codex login",
        "401 unauthorized",
    ]
    .iter()
    .any(|k| m.contains(k))
}

/// 선택한 CLI 인증 여부 best-effort 확인.
pub(super) fn is_authed(provider: AiProvider) -> bool {
    let env_key = match provider {
        AiProvider::Claude => "ANTHROPIC_API_KEY",
        AiProvider::Codex => "OPENAI_API_KEY",
    };
    if std::env::var(env_key).map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    let Ok(userprofile) = std::env::var("USERPROFILE") else { return false; };
    let base = PathBuf::from(userprofile);
    match provider {
        AiProvider::Claude => [
            base.join(".claude").join(".credentials.json"),
            base.join(".claude.json"),
        ].iter().any(|path| path.exists()),
        AiProvider::Codex => base.join(".codex").join("auth.json").exists(),
    }
}
