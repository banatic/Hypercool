//! 브리핑 에이전트: 새 쿨메신저 메시지가 들어오면 Claude Code(headless, `claude -p`)를
//! 호출해 "할 일·일정"을 추출하고, 기존 일정 생성 경로(`db::create_schedule_impl`)로 등록한다.
//!
//! 설계 원칙:
//! - 쓰기 주체는 앱이다. Claude 에는 hypercool MCP 읽기 도구만 allowlist 로 허용하고,
//!   최종 stdout 의 JSON 배열만 파싱해 Rust 가 검증·등록한다.
//! - 트리거는 배치·단일 실행. sync 성공 후 debounce 로 모아 1회, single-flight 로 동시 1개.
//! - 증분 처리. `BriefingLastSeenId` 보다 큰 메시지만 대상으로 하고, 성공 시에만 전진.
//! - 멱등. event id 는 메시지 ID 기반 결정적 값(`msg-<id>`)이며, 이미 있으면 skip → 사용자 편집 보존.
//! - CLI 미설치/미인증 시 기능 자동 비활성화, 앱 크래시 없음.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::system::{get_registry_value, set_registry_value};

// ─── 상수 ─────────────────────────────────────────────────────────────────────

/// claude 프로세스 최대 실행 시간(초). 첨부 파싱 + 다중 tool 호출을 고려해 넉넉히 잡는다.
const TIMEOUT_SECS: u64 = 240;
/// 새 메시지 감지 후 실행까지 모으는 trailing debounce(초).
const DEBOUNCE_SECS: u64 = 45;
/// claude 가 headless 로 사용할 수 있는 읽기 전용 MCP 도구 allowlist.
const ALLOWED_TOOLS: &str = "mcp__hypercool__get_messages,mcp__hypercool__get_message_by_id,mcp__hypercool__read_attachment,mcp__hypercool__search_messages,mcp__hypercool__list_attachments";
/// AI 자동 생성 일정을 시각적으로 구분하기 위한 색상(달력 위젯이 color 를 렌더에 사용).
const AI_COLOR: &str = "#8B5CF6";
/// content 에 남기는 AI 생성 마커.
const AI_MARKER: &str = "🤖 AI 자동 생성";

const REG_ENABLED: &str = "BriefingAgentEnabled";
const REG_LAST_SEEN: &str = "BriefingLastSeenId";
const REG_CLAUDE_PATH: &str = "ClaudeCliPath";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ─── 전역 상태 ────────────────────────────────────────────────────────────────

static ENABLED: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
static LAST_TRIGGER_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static LAST_STATUS: OnceLock<Mutex<BriefingStatusSnapshot>> = OnceLock::new();

fn status_slot() -> &'static Mutex<BriefingStatusSnapshot> {
    LAST_STATUS.get_or_init(|| Mutex::new(BriefingStatusSnapshot::default()))
}

// ─── 직렬화 타입 ──────────────────────────────────────────────────────────────

/// claude 가 반환하는 일정 항목(프롬프트 스키마). 필드는 모두 관대하게 Option 처리.
#[derive(Deserialize, Default)]
#[serde(default)]
struct ExtractedItem {
    id: Option<String>,
    source_message_id: Option<i64>,
    received_at: Option<String>,
    sender: Option<String>,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    item_type: Option<String>,
    title: Option<String>,
    detail: Option<String>,
    date: Option<String>,
    time: Option<String>,
    all_day: Option<bool>,
    period: Option<String>,
    #[allow(dead_code)]
    has_attachment: Option<bool>,
    #[allow(dead_code)]
    urgency: Option<String>,
    active_from: Option<String>,
    #[allow(dead_code)]
    active_until: Option<String>,
    source_text: Option<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct BriefingStatusSnapshot {
    pub last_run_at: Option<String>,
    pub last_new_count: i64,
    pub last_error: Option<String>,
    pub last_seen_id: i64,
}

#[derive(Serialize)]
pub struct BriefingStatus {
    pub enabled: bool,
    pub claude_installed: bool,
    pub claude_path: Option<String>,
    pub authed: bool,
    pub running: bool,
    pub last_run_at: Option<String>,
    pub last_new_count: i64,
    pub last_error: Option<String>,
    pub last_seen_id: i64,
}

#[derive(Serialize)]
pub struct BriefingRunResult {
    /// 실제로 claude 를 실행했는지(단일 flight 로 스킵되면 false).
    pub ran: bool,
    pub new_count: i64,
    pub skipped: i64,
    pub error: Option<String>,
    /// 실행하지 않은 이유(있을 때만).
    pub reason: Option<String>,
}

// ─── on/off & 상태 ────────────────────────────────────────────────────────────

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 시작 시 레지스트리에서 활성 상태를 복원한다(기본 OFF, 옵트인).
pub fn restore_state(_app: &AppHandle) {
    let enabled = get_registry_value(REG_ENABLED.to_string())
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    ENABLED.store(enabled, Ordering::Relaxed);

    // 상태 스냅샷에 last_seen_id 를 미리 채워둔다.
    status_slot().lock().unwrap().last_seen_id = read_last_seen_id();
}

#[tauri::command]
pub fn set_briefing_agent_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    ENABLED.store(enabled, Ordering::Relaxed);
    let saved = set_registry_value(
        REG_ENABLED.to_string(),
        if enabled { "true" } else { "false" }.to_string(),
    );

    // 처음 켤 때(기준선이 아직 없으면) 최근 메시지 근방으로 기준선을 잡는다.
    // 과거 전체를 한 번에 처리하는 대량 실행을 막고 "새 메시지" 의미에 맞추되,
    // 최근 소량은 곧바로 "지금 실행"으로 처리할 수 있게 약간의 여유(10개)를 둔다.
    if enabled && read_last_seen_id() == 0 {
        let baseline = (current_max_message_id(&app) - 10).max(0);
        if baseline > 0 {
            write_last_seen_id(baseline);
            status_slot().lock().unwrap().last_seen_id = baseline;
        }
    }

    saved
}

#[tauri::command]
pub fn get_briefing_agent_status() -> BriefingStatus {
    let claude = find_claude();
    let snapshot = status_slot().lock().unwrap().clone();
    BriefingStatus {
        enabled: is_enabled(),
        claude_installed: claude.is_some(),
        claude_path: claude.map(|p| p.to_string_lossy().to_string()),
        authed: is_authed(),
        running: RUNNING.load(Ordering::Relaxed),
        last_run_at: snapshot.last_run_at,
        last_new_count: snapshot.last_new_count,
        last_error: snapshot.last_error,
        last_seen_id: read_last_seen_id(),
    }
}

/// 수동 실행(설정 페이지 "지금 실행"). ENABLED 여부와 무관하게 즉시 1회(단, CLI 필요).
#[tauri::command]
pub async fn run_briefing_agent_now(app: AppHandle) -> Result<BriefingRunResult, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_briefing_locked(&app2))
        .await
        .map_err(|e| format!("실행 작업 실패: {}", e))
}

/// 디버그/테스트 실행: 최근 `count`(기본 10)개 메시지를 대상으로 강제 1회 실행한다.
/// 저장된 last_seen_id 를 무시하고 전진시키지도 않으므로 자동 흐름에 영향을 주지 않는다.
/// 등록은 여전히 멱등(id 중복 skip)이라 반복 실행해도 중복 일정이 생기지 않는다.
#[tauri::command]
pub async fn run_briefing_agent_debug(
    app: AppHandle,
    count: Option<i64>,
) -> Result<BriefingRunResult, String> {
    let n = count.unwrap_or(10).clamp(1, 100);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_briefing_debug_locked(&app2, n))
        .await
        .map_err(|e| format!("실행 작업 실패: {}", e))
}

// ─── 트리거(watcher 연결) ─────────────────────────────────────────────────────

/// 새 메시지 sync 성공 후 워처에서 호출한다. ENABLED + CLI 존재 시 debounce 실행.
pub fn on_new_messages(app: &AppHandle) {
    if !is_enabled() || find_claude().is_none() {
        return;
    }

    let trigger_at = Instant::now();
    *LAST_TRIGGER_AT.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(trigger_at);

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(DEBOUNCE_SECS));

        // 그동안 더 최신 트리거가 왔으면 그쪽 스레드가 처리하도록 양보한다(trailing debounce).
        let is_latest = LAST_TRIGGER_AT
            .get()
            .and_then(|m| m.lock().ok().and_then(|g| *g))
            .map(|t| t == trigger_at)
            .unwrap_or(false);
        if !is_latest || !is_enabled() {
            return;
        }

        let _ = run_briefing_locked(&app);
    });
}

// ─── 실행 (single-flight) ─────────────────────────────────────────────────────

fn run_briefing_locked(app: &AppHandle) -> BriefingRunResult {
    // single-flight: 이미 실행 중이면 PENDING 만 세우고 반환.
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        PENDING.store(true, Ordering::SeqCst);
        return BriefingRunResult {
            ran: false,
            new_count: 0,
            skipped: 0,
            error: None,
            reason: Some("이미 실행 중입니다.".to_string()),
        };
    }

    let mut total_new = 0i64;
    let mut total_skipped = 0i64;
    let mut last_err: Option<String> = None;

    loop {
        PENDING.store(false, Ordering::SeqCst);
        match run_pass(app, &PassOpts { since_override: None, advance: true }) {
            Ok((n, s)) => {
                total_new += n;
                total_skipped += s;
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
        update_and_emit_status(app, total_new, last_err.clone());

        // 실행 중 새 메시지가 또 들어왔으면(PENDING) 한 번 더 처리. 단, 오류 시엔 다음 틱에 맡긴다.
        if !PENDING.load(Ordering::SeqCst) || last_err.is_some() {
            break;
        }
    }

    RUNNING.store(false, Ordering::SeqCst);

    BriefingRunResult {
        ran: true,
        new_count: total_new,
        skipped: total_skipped,
        error: last_err,
        reason: None,
    }
}

/// 디버그 실행(단일 flight). 최근 count 개를 대상으로 1회, last_seen 미전진.
/// 지속 상태 스냅샷(마지막 실행 표시)은 건드리지 않고 결과만 인라인 반환한다.
fn run_briefing_debug_locked(app: &AppHandle, count: i64) -> BriefingRunResult {
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return BriefingRunResult {
            ran: false,
            new_count: 0,
            skipped: 0,
            error: None,
            reason: Some("이미 실행 중입니다.".to_string()),
        };
    }

    let current_max = current_max_message_id(app);
    let since = (current_max - count).max(0);
    let (new_count, skipped, error) =
        match run_pass(app, &PassOpts { since_override: Some(since), advance: false }) {
            Ok((n, s)) => (n, s, None),
            Err(e) => (0, 0, Some(e)),
        };

    RUNNING.store(false, Ordering::SeqCst);

    BriefingRunResult {
        ran: true,
        new_count,
        skipped,
        error,
        reason: None,
    }
}

/// run_pass 옵션.
struct PassOpts {
    /// 프롬프트에 넣을 기준 id(이 값보다 큰 메시지만 신규). None 이면 저장된 last_seen 사용.
    since_override: Option<i64>,
    /// 성공 시 저장된 last_seen_id 를 current_max 로 전진시킬지. 디버그 실행은 false.
    advance: bool,
}

/// 실제 1회 실행: claude 호출 → 파싱 → 검증 → 등록 → (옵션) last_seen 전진.
/// 반환: (신규 등록 수, skip 수). 실패 시 Err(사유) — last_seen 은 전진하지 않음.
fn run_pass(app: &AppHandle, opts: &PassOpts) -> Result<(i64, i64), String> {
    let claude = find_claude()
        .ok_or_else(|| "Claude Code CLI(claude)를 찾을 수 없습니다. 설치 후 다시 시도하세요.".to_string())?;
    let mcp_path = ensure_mcp_config(app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let last_seen = opts.since_override.unwrap_or_else(read_last_seen_id);
    let current_max = current_max_message_id(app);
    // 신규 메시지가 없으면 claude 실행 없이 즉시 종료(증분).
    if current_max <= last_seen {
        return Ok((0, 0));
    }

    let today = seoul_today();
    let prompt = load_prompt_template(app)
        .replace("{{TODAY}}", &today)
        .replace("{{LAST_SEEN_ID}}", &last_seen.to_string());

    let stdout = spawn_claude(&claude, &prompt, &mcp_path, &app_data_dir)?;
    let items = parse_items_from_output(&stdout)?;
    let (new_count, skipped) = register_items(app, items, &today)?;

    // 성공(프로세스 정상 종료 + 파싱 성공)했으므로 last_seen 을 전진시킨다(추출 0건이어도).
    if opts.advance {
        write_last_seen_id(current_max);
    }

    if new_count > 0 {
        // best-effort: 탁상달력에도 반영(실패 무시).
        if let Ok(Some(path)) = crate::db::detect_desktopcal() {
            let _ = crate::db::sync_to_desktopcal(app.clone(), path);
        }
        // 프론트가 loadSchedules + Firestore sync 를 돌리도록 알림.
        let _ = app.emit("calendar-update", ());
    }

    Ok((new_count, skipped))
}

/// claude headless 프로세스를 실행하고 stdout(전체)을 반환한다. 타임아웃 시 kill.
fn spawn_claude(
    claude: &PathBuf,
    prompt: &str,
    mcp_path: &PathBuf,
    cwd: &PathBuf,
) -> Result<String, String> {
    use std::io::Read;

    let mut cmd = std::process::Command::new(claude);
    cmd.arg("-p")
        .arg(prompt)
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

    let mut child = cmd.spawn().map_err(|e| format!("claude 실행 실패: {}", e))?;

    // 파이프 데드락 방지를 위해 stdout/stderr 를 별도 스레드에서 끝까지 읽는다.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut p) = out_pipe {
            let _ = p.read_to_string(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut p) = err_pipe {
            let _ = p.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(TIMEOUT_SECS);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("claude 프로세스 상태 확인 실패: {}", e)),
        }
    }

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    if timed_out {
        return Err(format!("claude 실행이 {}초 내에 끝나지 않아 중단했습니다.", TIMEOUT_SECS));
    }

    if stdout.trim().is_empty() {
        let tail = tail_chars(&stderr, 300);
        return Err(if tail.is_empty() {
            "claude 가 빈 출력을 반환했습니다 (인증/네트워크 확인).".to_string()
        } else {
            format!("claude 출력이 비었습니다. stderr: {}", tail)
        });
    }

    Ok(stdout)
}

// ─── 파싱 ─────────────────────────────────────────────────────────────────────

fn parse_items_from_output(stdout: &str) -> Result<Vec<ExtractedItem>, String> {
    let envelope: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("claude 출력(JSON 봉투) 파싱 실패: {}", e))?;

    if envelope
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let msg = envelope
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("알 수 없는 오류");
        return Err(format!("claude 오류: {}", tail_chars(msg, 300)));
    }

    let result_str = envelope
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "claude 출력에 result 필드가 없습니다.".to_string())?;

    let arr_text = extract_json_array(result_str)
        .ok_or_else(|| "claude 결과에서 JSON 배열을 찾지 못했습니다.".to_string())?;

    serde_json::from_str(&arr_text).map_err(|e| format!("일정 JSON 배열 파싱 실패: {}", e))
}

/// 문자열에서 첫 '[' ~ 마지막 ']' 구간을 JSON 배열로 추출(코드펜스·머리말 방어).
fn extract_json_array(s: &str) -> Option<String> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(s[start..=end].to_string())
}

// ─── 등록 ─────────────────────────────────────────────────────────────────────

fn register_items(
    app: &AppHandle,
    items: Vec<ExtractedItem>,
    today: &str,
) -> Result<(i64, i64), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = dir.join("hypercool.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("일정 DB 연결 실패: {}", e))?;

    let today_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok();

    let mut new_count = 0i64;
    let mut skipped = 0i64;

    for item in items {
        let sched = match to_schedule_item(&item, today_date) {
            Some(s) => s,
            None => {
                skipped += 1;
                continue;
            }
        };

        // 멱등: 같은 id 가 이미 있으면(사용자가 완료/수정/삭제했더라도) 덮어쓰지 않고 skip.
        let exists = conn
            .query_row(
                "SELECT 1 FROM tbl_schedules WHERE id = ?1 LIMIT 1",
                rusqlite::params![sched.id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if exists {
            skipped += 1;
            continue;
        }

        match crate::db::create_schedule_impl(&conn, sched) {
            Ok(_) => new_count += 1,
            Err(_) => skipped += 1,
        }
    }

    Ok((new_count, skipped))
}

/// ExtractedItem → db::ScheduleItem 변환 및 검증. 등록 불가(날짜 없음/과거)면 None.
fn to_schedule_item(
    item: &ExtractedItem,
    today: Option<chrono::NaiveDate>,
) -> Option<crate::db::ScheduleItem> {
    // id: 명시된 값 우선, 없으면 msg-<source_id>.
    let id = item
        .id
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| item.source_message_id.map(|m| format!("msg-{}", m)))?;

    let title = item
        .title
        .clone()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "할 일".to_string());

    // 달력에 배치할 날짜: date → active_from → received_at 순으로 첫 유효값.
    let mut effective: Option<chrono::NaiveDate> = None;
    for cand in [
        item.date.as_deref(),
        item.active_from.as_deref(),
        item.received_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(d) = parse_date_loose(cand) {
            effective = Some(d);
            break;
        }
    }
    let date = effective?; // 날짜가 전혀 없으면 달력 등록 불가 → skip.

    // 과거 날짜 방어(프롬프트에서도 걸러지지만 이중 방어).
    if let Some(t) = today {
        if date < t {
            return None;
        }
    }
    let date_str = date.format("%Y-%m-%d").to_string();

    let all_day = item.all_day.unwrap_or(item.time.is_none());
    let start_date = if !all_day {
        match item.time.as_deref().and_then(parse_start_time) {
            Some(t) => format!("{}T{}:00+09:00", date_str, t),
            None => date_str.clone(),
        }
    } else {
        date_str.clone()
    };

    // content: 요점 + 교시/시간/발신/원문 + AI 마커.
    let mut parts: Vec<String> = Vec::new();
    let push = |parts: &mut Vec<String>, label: &str, val: &Option<String>| {
        if let Some(v) = val.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if label.is_empty() {
                parts.push(v.to_string());
            } else {
                parts.push(format!("{}: {}", label, v));
            }
        }
    };
    push(&mut parts, "", &item.detail);
    push(&mut parts, "교시", &item.period);
    push(&mut parts, "시간", &item.time);
    push(&mut parts, "발신", &item.sender);
    push(&mut parts, "원문", &item.source_text);
    parts.push(AI_MARKER.to_string());
    let content = parts.join("\n");

    let now = chrono::Utc::now().to_rfc3339();

    Some(crate::db::ScheduleItem {
        id,
        schedule_type: "message_task".to_string(),
        title,
        content: Some(content),
        start_date: Some(start_date.clone()),
        end_date: Some(start_date),
        is_all_day: all_day,
        reference_id: item.source_message_id.map(|m| m.to_string()),
        color: Some(AI_COLOR.to_string()),
        is_completed: false,
        created_at: now.clone(),
        updated_at: now,
        is_deleted: false,
    })
}

// ─── 보조 ─────────────────────────────────────────────────────────────────────

fn read_last_seen_id() -> i64 {
    get_registry_value(REG_LAST_SEEN.to_string())
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

fn write_last_seen_id(id: i64) {
    let _ = set_registry_value(REG_LAST_SEEN.to_string(), id.to_string());
}

fn update_and_emit_status(app: &AppHandle, new_count: i64, error: Option<String>) {
    let snapshot = {
        let mut slot = status_slot().lock().unwrap();
        slot.last_run_at = Some(chrono::Local::now().to_rfc3339());
        slot.last_new_count = new_count;
        slot.last_error = error;
        slot.last_seen_id = read_last_seen_id();
        slot.clone()
    };
    let _ = app.emit("briefing-status", snapshot);
}

/// app_data_dir 에 claude 용 mcp.json 을 보장(항상 최신 내용으로 기록).
fn ensure_mcp_config(app: &AppHandle) -> Result<PathBuf, String> {
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

/// 런타임 프롬프트 템플릿: 번들 resource 우선, 실패 시 컴파일 임베드본 폴백.
fn load_prompt_template(app: &AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("briefing_prompt.md");
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    include_str!("../resources/briefing_prompt.md").to_string()
}

/// search DB(hypercool_search.db)의 최대 메시지 id(=UDB MessageKey).
fn current_max_message_id(app: &AppHandle) -> i64 {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let db = dir.join("hypercool_search.db");
    if !db.exists() {
        return 0;
    }
    match Connection::open(&db) {
        Ok(conn) => conn
            .query_row("SELECT COALESCE(MAX(id), 0) FROM messages", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// claude 실행 파일 경로 탐색: 레지스트리 override → `where claude` → 공통 경로.
fn find_claude() -> Option<PathBuf> {
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

/// 인증 여부 best-effort: ANTHROPIC_API_KEY 또는 claude 자격/설정 파일 존재.
fn is_authed() -> bool {
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(&userprofile);
        for rel in [
            PathBuf::from(".claude").join(".credentials.json"),
            PathBuf::from(".claude.json"),
        ] {
            if base.join(rel).exists() {
                return true;
            }
        }
    }
    false
}

fn seoul_offset() -> chrono::FixedOffset {
    chrono::FixedOffset::east_opt(9 * 3600).unwrap()
}

fn seoul_today() -> String {
    chrono::Utc::now()
        .with_timezone(&seoul_offset())
        .format("%Y-%m-%d")
        .to_string()
}

/// "YYYY-MM-DD" 또는 RFC3339/ISO 문자열에서 (KST 기준) 날짜를 뽑는다.
fn parse_date_loose(s: &str) -> Option<chrono::NaiveDate> {
    let s = s.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&seoul_offset()).date_naive());
    }
    if s.len() >= 10 {
        if let Ok(d) = chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
            return Some(d);
        }
    }
    None
}

/// "HH:MM" 또는 "HH:MM~HH:MM"/"HH:MM-HH:MM"에서 시작 시각 "HH:MM"을 정규화.
fn parse_start_time(s: &str) -> Option<String> {
    let first = s.split(['~', '-']).next()?.trim();
    let mut it = first.split(':');
    let h: u32 = it.next()?.trim().parse().ok()?;
    let m: u32 = it.next()?.trim().parse().ok()?;
    if h < 24 && m < 60 {
        Some(format!("{:02}:{:02}", h, m))
    } else {
        None
    }
}

/// 문자열의 마지막 n글자(로그/오류 축약용).
fn tail_chars(s: &str, n: usize) -> String {
    let s = s.trim();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        chars[chars.len() - n..].iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_array_strips_fences_and_prose() {
        let s = "설명\n```json\n[{\"a\":1}]\n```\n끝";
        assert_eq!(extract_json_array(s).as_deref(), Some("[{\"a\":1}]"));
    }

    #[test]
    fn extract_array_none_when_no_brackets() {
        assert_eq!(extract_json_array("no array here"), None);
    }

    #[test]
    fn parse_start_time_handles_ranges() {
        assert_eq!(parse_start_time("13:20~14:10").as_deref(), Some("13:20"));
        assert_eq!(parse_start_time("9:05").as_deref(), Some("09:05"));
        assert_eq!(parse_start_time("25:00"), None);
        assert_eq!(parse_start_time("점심"), None);
    }

    #[test]
    fn parse_date_loose_accepts_plain_and_rfc3339() {
        assert_eq!(
            parse_date_loose("2026-07-01"),
            chrono::NaiveDate::from_ymd_opt(2026, 7, 1)
        );
        // 2026-07-01 23:00 UTC == 2026-07-02 08:00 KST
        assert_eq!(
            parse_date_loose("2026-07-01T23:00:00Z"),
            chrono::NaiveDate::from_ymd_opt(2026, 7, 2)
        );
    }

    #[test]
    fn to_schedule_item_skips_past_and_dateless() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);

        let past = ExtractedItem {
            source_message_id: Some(10),
            date: Some("2026-06-01".to_string()),
            title: Some("지난 일".to_string()),
            ..Default::default()
        };
        assert!(to_schedule_item(&past, today).is_none());

        let dateless = ExtractedItem {
            source_message_id: Some(11),
            title: Some("날짜없음".to_string()),
            ..Default::default()
        };
        assert!(to_schedule_item(&dateless, today).is_none());
    }

    #[test]
    fn to_schedule_item_builds_deterministic_id_and_fields() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let item = ExtractedItem {
            source_message_id: Some(6377),
            date: Some("2026-07-05".to_string()),
            time: Some("14:00~15:00".to_string()),
            all_day: Some(false),
            title: Some("회의".to_string()),
            detail: Some("부장 회의".to_string()),
            sender: Some("황정환".to_string()),
            ..Default::default()
        };
        let s = to_schedule_item(&item, today).unwrap();
        assert_eq!(s.id, "msg-6377");
        assert_eq!(s.schedule_type, "message_task");
        assert_eq!(s.reference_id.as_deref(), Some("6377"));
        assert_eq!(s.start_date.as_deref(), Some("2026-07-05T14:00:00+09:00"));
        assert!(!s.is_all_day);
        assert!(s.content.as_deref().unwrap().contains(AI_MARKER));
    }

    #[test]
    fn explicit_id_is_preferred_for_multi_item() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let item = ExtractedItem {
            id: Some("msg-6377-1".to_string()),
            source_message_id: Some(6377),
            date: Some("2026-07-05".to_string()),
            title: Some("두 번째 마감".to_string()),
            ..Default::default()
        };
        let s = to_schedule_item(&item, today).unwrap();
        assert_eq!(s.id, "msg-6377-1");
    }
}
