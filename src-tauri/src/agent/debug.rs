//! 디버그 실행: 최근 메시지 강제 1회 실행 + 상세 진단 리포트.

use super::*;

/// 디버그 실행의 상세 진단 리포트. "신규 0건" 원인 파악용 정보를 모두 노출한다.
#[derive(Serialize, Default)]
pub struct BriefingDebugReport {
    pub provider: String,
    pub model: Option<String>,
    pub agent_installed: bool,
    pub agent_path: Option<String>,
    pub authed: bool,
    /// 레지스트리 UdbPath(원본 메시지 DB 경로).
    pub udb_path: Option<String>,
    /// UDB 원본의 최신 MessageKey(있으면).
    pub udb_max_id: Option<i64>,
    pub search_db_exists: bool,
    /// 검색 DB(MCP가 읽는 hypercool_search.db) 메시지 수.
    pub search_db_count: i64,
    /// 검색 DB 최신 메시지 id.
    pub search_db_max_id: i64,
    /// 이번 실행에서 UDB→검색 DB로 새로 동기화된 메시지 수.
    pub synced_new: i64,
    pub last_seen_id: i64,
    /// 이번 디버그가 사용한 기준 id(이보다 큰 메시지만 AI에 전달).
    pub since_used: i64,
    /// since 초과 대상 메시지 수(AI가 실제로 살펴볼 대상).
    pub target_messages: i64,
    pub ran_agent: bool,
    pub duration_ms: u64,
    pub agent_is_error: bool,
    /// AI 최종 응답 원문 발췌.
    pub raw_result: Option<String>,
    /// AI CLI stderr 꼬리(있으면).
    pub raw_stderr_tail: Option<String>,
    /// AI가 추출한 항목 수(중복/검증 이전).
    pub extracted_count: i64,
    pub registered_new: i64,
    pub skipped_dedup: i64,
    pub skipped_invalid: i64,
    pub error: Option<String>,
    pub notes: Vec<String>,
}

/// 디버그 실행(단일 flight). 검색 DB 동기화 → 최근 count 개 대상 강제 1회 → 상세 리포트.
/// last_seen 미전진, 지속 상태 스냅샷도 건드리지 않는다.
pub(super) fn run_debug_report(app: &AppHandle, count: i64) -> BriefingDebugReport {
    let mut rep = BriefingDebugReport::default();
    let config = read_ai_config();
    rep.provider = config.provider.as_str().to_string();
    rep.model = config.model.clone();
    rep.agent_installed = config.executable.is_some();
    rep.agent_path = config.executable.as_ref().map(|p| p.to_string_lossy().to_string());
    rep.authed = is_authed(config.provider);
    rep.last_seen_id = read_last_seen_id();

    // single-flight: AI 프로세스가 이미 돌고 있으면 진단만 하고 실행은 생략.
    let acquired = RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if !acquired {
        rep.notes.push("이미 브리핑 에이전트가 실행 중이라 AI 실행은 생략했습니다.".to_string());
    }

    // 1) 검색 DB를 UDB와 강제 동기화(신규 메시지가 검색 DB/MCP에 보이도록).
    match get_registry_value("UdbPath".to_string()).ok().flatten() {
        Some(path) => {
            rep.udb_path = Some(path.clone());
            match crate::commands::messages::get_latest_message_id_internal(path.clone()) {
                Ok(v) => rep.udb_max_id = v,
                Err(e) => rep.notes.push(format!("UDB 최신 id 조회 실패: {}", e)),
            }
            match crate::search_db::sync_from_udb(app, path) {
                Ok(stats) => {
                    rep.synced_new = stats.new_messages as i64;
                    if stats.new_messages > 0 {
                        rep.notes.push(format!("검색 DB에 새로 {}건 동기화됨.", stats.new_messages));
                    }
                }
                Err(e) => rep.notes.push(format!("검색 DB 동기화 실패: {}", e)),
            }
        }
        None => rep.notes.push("레지스트리에 UdbPath가 없습니다 — 메인 앱에서 UDB 파일을 먼저 지정/로드하세요.".to_string()),
    }

    // 2) 검색 DB 통계.
    let (exists, cnt, max_id) = search_db_stats(app);
    rep.search_db_exists = exists;
    rep.search_db_count = cnt;
    rep.search_db_max_id = max_id;

    if !exists || cnt == 0 {
        rep.notes.push("검색 DB가 비어 있습니다 — MCP가 볼 메시지가 없습니다. 메인 앱에서 메시지 동기화가 필요합니다.".to_string());
    }
    if let Some(udb_max) = rep.udb_max_id {
        if udb_max > max_id {
            rep.notes.push(format!(
                "UDB 최신 id({})가 검색 DB({})보다 큽니다 — 동기화가 덜 된 상태일 수 있습니다.",
                udb_max, max_id
            ));
        }
    }

    // 3) 대상 범위 계산.
    let since = (max_id - count).max(0);
    rep.since_used = since;
    rep.target_messages = count_messages_since(app, since);
    if rep.target_messages == 0 {
        rep.notes.push(format!("id > {} 인 대상 메시지가 0건입니다 (최근 {}개 범위에 신규 없음).", since, count));
    }

    // 4) 선택한 AI 실행(획득했고 CLI 있고 대상 있으면).
    if acquired {
        if config.executable.is_some() {
            if rep.target_messages > 0 {
                let started = Instant::now();
                match run_ai_debug(app, &config, since) {
                    Ok(dbg) => {
                        rep.ran_agent = true;
                        rep.agent_is_error = dbg.is_error;
                        rep.raw_result = Some(dbg.result_text);
                        rep.raw_stderr_tail = dbg.stderr_tail;
                        rep.extracted_count = dbg.extracted;
                        rep.registered_new = dbg.registered;
                        rep.skipped_dedup = dbg.skipped_dedup;
                        rep.skipped_invalid = dbg.skipped_invalid;
                        if let Some(e) = dbg.parse_error {
                            rep.error = Some(e);
                        }
                    }
                    Err(e) => rep.error = Some(e),
                }
                rep.duration_ms = started.elapsed().as_millis() as u64;
            } else {
                rep.notes.push("대상 메시지가 없어 AI를 실행하지 않았습니다.".to_string());
            }
        } else {
            rep.notes.push(format!("{} CLI를 찾지 못해 실행하지 않았습니다.", config.provider.display_name()));
        }
        RUNNING.store(false, Ordering::SeqCst);
    }

    // 5) 결과 해석 노트.
    if rep.ran_agent && !rep.agent_is_error && rep.error.is_none() {
        if rep.extracted_count == 0 {
            rep.notes.push("AI가 대상 메시지에서 할 일/일정을 추출하지 않았습니다(비업무성이거나 판단상 제외). raw_result 를 확인하세요.".to_string());
        } else {
            if rep.registered_new == 0 && rep.skipped_dedup > 0 {
                rep.notes.push(format!("AI가 {}건 추출했으나 모두 이미 등록됨(중복 제외) — 정상 동작입니다.", rep.extracted_count));
            }
            if rep.skipped_invalid > 0 {
                rep.notes.push(format!("{}건이 과거 날짜/날짜 없음으로 제외되었습니다.", rep.skipped_invalid));
            }
        }
    }

    rep
}

/// AI 디버그 실행 결과(내부).
pub(super) struct AiDebugRun {
    pub(super) is_error: bool,
    pub(super) result_text: String,
    pub(super) stderr_tail: Option<String>,
    pub(super) extracted: i64,
    pub(super) registered: i64,
    pub(super) skipped_dedup: i64,
    pub(super) skipped_invalid: i64,
    pub(super) parse_error: Option<String>,
}

/// 선택한 AI를 실행하고 원문/추출/등록 breakdown 을 채운다(디버그 전용).
pub(super) fn run_ai_debug(app: &AppHandle, config: &AiConfig, since: i64) -> Result<AiDebugRun, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let today = seoul_today();
    let prompt = build_prompt(app, &today, since);

    let output = spawn_ai(app, config, &prompt, &app_data_dir)?;
    let stderr_tail = {
        let t = tail_chars(&output.stderr, 400);
        if t.is_empty() { None } else { Some(t) }
    };

    let mut run = AiDebugRun {
        is_error: output.is_error,
        result_text: head_chars(&output.result, 4000),
        stderr_tail,
        extracted: 0,
        registered: 0,
        skipped_dedup: 0,
        skipped_invalid: 0,
        parse_error: None,
    };

    if output.is_error {
        run.parse_error = Some("AI CLI가 오류로 종료했습니다. raw_result/stderr를 확인하세요.".to_string());
        return Ok(run);
    }

    // Codex는 --output-schema로 바로 배열을 반환하고, Claude의 기존 출력은
    // 코드펜스/머리말을 포함할 수 있어 parse_items_from_result가 함께 처리한다.
    match parse_items_from_result(&output.result) {
        Ok(items) => {
            run.extracted = items.len() as i64;
            let (new_c, dedup_c, invalid_c) = register_items_breakdown(app, items, &today);
            run.registered = new_c;
            run.skipped_dedup = dedup_c;
            run.skipped_invalid = invalid_c;
            if run.registered > 0 {
                let _ = app.emit("calendar-update", ());
            }
        }
        Err(e) => run.parse_error = Some(e),
    }

    Ok(run)
}

/// register_items 와 동일하되 (신규, 중복skip, 검증skip) breakdown 을 반환.
pub(super) fn register_items_breakdown(app: &AppHandle, items: Vec<ExtractedItem>, today: &str) -> (i64, i64, i64) {
    let total = items.len() as i64;
    register_items_core(app, items, today)
        .map(|(n, d, i, _)| (n, d, i))
        .unwrap_or((0, 0, total))
}

/// 검색 DB 통계: (존재, 메시지 수, 최신 id).
pub(super) fn search_db_stats(app: &AppHandle) -> (bool, i64, i64) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return (false, 0, 0),
    };
    let db = dir.join("hypercool_search.db");
    if !db.exists() {
        return (false, 0, 0);
    }
    match Connection::open(&db) {
        Ok(conn) => {
            let cnt = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0);
            let max_id = conn
                .query_row("SELECT COALESCE(MAX(id), 0) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0);
            (true, cnt, max_id)
        }
        Err(_) => (false, 0, 0),
    }
}
