//! 브리핑 에이전트: 새 쿨메신저 메시지가 들어오면 Claude Code(headless, `claude -p`)를
//! 호출해 "할 일·일정"을 추출하고, 기존 일정 생성 경로(`db::create_schedule_impl`)로 등록한다.
//!
//! 설계 원칙:
//! - 쓰기 주체는 앱이다. Claude 에는 hypercool MCP 읽기 도구만 allowlist 로 허용하고,
//!   최종 stdout 의 JSON 배열만 파싱해 Rust 가 검증·등록한다.
//! - 트리거는 배치·단일 실행. sync 성공 후 debounce 로 모아 1회, single-flight 로 동시 1개.
//! - 증분 처리. `BriefingLastSeenId` 보다 큰 메시지만 대상으로 하고, 성공 시에만 전진.
//! - 멱등. event id 는 메시지 ID 기반 결정적 값(`msg-<id>`)이며, 이미 있으면 skip → 사용자 편집 보존.
//!   재전송·정정처럼 메시지 ID 가 달라도 내용이 사실상 같은 경우는 (날짜, 제목/원문 유사도)
//!   기준의 내용 중복 판정으로 이중 등록을 막는다.
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
const AI_MARKER: &str = "AI 자동 생성";
/// 구버전 이모지 마커(마이그레이션에서 제거 대상).
const AI_MARKER_LEGACY: &str = "🤖 AI 자동 생성";
/// [원문] 섹션 구분선+제목. to_schedule_item 과 마이그레이션이 공유(형식 동기화).
const ORIGINAL_SECTION_HEADER: &str =
    "<hr><div style=\"color:#888;font-size:12px;margin-bottom:4px\">원문</div>";

/// 내용 중복 판정: 같은 날짜의 AI 일정과 제목 유사도(문자 bigram Dice)가 이 값 이상이면 중복.
const TITLE_SIM_THRESHOLD: f64 = 0.85;
/// 내용 중복 판정: 원문 유사도가 이 값 이상이면 재전송/정정 메시지로 본다.
const BODY_SIM_THRESHOLD: f64 = 0.90;
/// 원문 유사도 비교를 적용할 최소 길이(정규화 후 문자 수) — 짧은 본문의 우연 일치 방지.
const MIN_BODY_CHARS: usize = 20;

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

/// 디버그/테스트 실행: 검색 DB를 먼저 UDB와 동기화한 뒤, 최근 `count`(기본 10)개
/// 메시지를 대상으로 강제 1회 실행하고 상세 진단 리포트를 반환한다.
/// 저장된 last_seen_id 는 무시·미전진하므로 자동 흐름에 영향을 주지 않으며,
/// 등록은 여전히 멱등(id 중복 skip)이라 반복 실행해도 중복 일정이 생기지 않는다.
#[tauri::command]
pub async fn run_briefing_agent_debug(
    app: AppHandle,
    count: Option<i64>,
) -> Result<BriefingDebugReport, String> {
    let n = count.unwrap_or(10).clamp(1, 100);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_debug_report(&app2, n))
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

/// 디버그 실행의 상세 진단 리포트. "신규 0건" 원인 파악용 정보를 모두 노출한다.
#[derive(Serialize, Default)]
pub struct BriefingDebugReport {
    pub claude_installed: bool,
    pub claude_path: Option<String>,
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
    /// 이번 디버그가 사용한 기준 id(이보다 큰 메시지만 claude에 전달).
    pub since_used: i64,
    /// since 초과 대상 메시지 수(claude가 실제로 살펴볼 대상).
    pub target_messages: i64,
    pub ran_claude: bool,
    pub duration_ms: u64,
    pub claude_is_error: bool,
    /// claude 최종 응답(.result) 원문 발췌.
    pub raw_result: Option<String>,
    /// claude stderr 꼬리(있으면).
    pub raw_stderr_tail: Option<String>,
    /// claude가 추출한 항목 수(중복/검증 이전).
    pub extracted_count: i64,
    pub registered_new: i64,
    pub skipped_dedup: i64,
    pub skipped_invalid: i64,
    pub error: Option<String>,
    pub notes: Vec<String>,
}

/// 디버그 실행(단일 flight). 검색 DB 동기화 → 최근 count 개 대상 강제 1회 → 상세 리포트.
/// last_seen 미전진, 지속 상태 스냅샷도 건드리지 않는다.
fn run_debug_report(app: &AppHandle, count: i64) -> BriefingDebugReport {
    let mut rep = BriefingDebugReport::default();
    let claude = find_claude();
    rep.claude_installed = claude.is_some();
    rep.claude_path = claude.as_ref().map(|p| p.to_string_lossy().to_string());
    rep.authed = is_authed();
    rep.last_seen_id = read_last_seen_id();

    // single-flight: claude 프로세스가 이미 돌고 있으면 진단만 하고 실행은 생략.
    let acquired = RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if !acquired {
        rep.notes.push("이미 브리핑 에이전트가 실행 중이라 claude 실행은 생략했습니다.".to_string());
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

    // 4) claude 실행(획득했고 CLI 있고 대상 있으면).
    if acquired {
        if let Some(claude_path) = claude {
            if rep.target_messages > 0 {
                let started = Instant::now();
                match run_claude_debug(app, &claude_path, since) {
                    Ok(dbg) => {
                        rep.ran_claude = true;
                        rep.claude_is_error = dbg.is_error;
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
                rep.notes.push("대상 메시지가 없어 claude 를 실행하지 않았습니다.".to_string());
            }
        } else {
            rep.notes.push("Claude Code CLI를 찾지 못해 실행하지 않았습니다.".to_string());
        }
        RUNNING.store(false, Ordering::SeqCst);
    }

    // 5) 결과 해석 노트.
    if rep.ran_claude && !rep.claude_is_error && rep.error.is_none() {
        if rep.extracted_count == 0 {
            rep.notes.push("claude가 대상 메시지에서 할 일/일정을 추출하지 않았습니다(비업무성이거나 판단상 제외). raw_result 를 확인하세요.".to_string());
        } else {
            if rep.registered_new == 0 && rep.skipped_dedup > 0 {
                rep.notes.push(format!("claude가 {}건 추출했으나 모두 이미 등록됨(중복 제외) — 정상 동작입니다.", rep.extracted_count));
            }
            if rep.skipped_invalid > 0 {
                rep.notes.push(format!("{}건이 과거 날짜/날짜 없음으로 제외되었습니다.", rep.skipped_invalid));
            }
        }
    }

    rep
}

/// claude 디버그 실행 결과(내부).
struct ClaudeDebugRun {
    is_error: bool,
    result_text: String,
    stderr_tail: Option<String>,
    extracted: i64,
    registered: i64,
    skipped_dedup: i64,
    skipped_invalid: i64,
    parse_error: Option<String>,
}

/// claude 를 실행하고 원문/추출/등록 breakdown 을 채운다(디버그 전용).
fn run_claude_debug(app: &AppHandle, claude: &PathBuf, since: i64) -> Result<ClaudeDebugRun, String> {
    let mcp_path = ensure_mcp_config(app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let today = seoul_today();
    let prompt = build_prompt(app, &today, since);

    let (stdout, stderr) = spawn_claude(claude, &prompt, &mcp_path, &app_data_dir)?;
    let stderr_tail = {
        let t = tail_chars(&stderr, 400);
        if t.is_empty() { None } else { Some(t) }
    };

    // 봉투 파싱 → result 텍스트.
    let envelope: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("claude 출력(JSON 봉투) 파싱 실패: {} / 원문: {}", e, head_chars(&stdout, 400)))?;
    let is_error = envelope.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
    let result_text = envelope
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut run = ClaudeDebugRun {
        is_error,
        result_text: head_chars(&result_text, 4000),
        stderr_tail,
        extracted: 0,
        registered: 0,
        skipped_dedup: 0,
        skipped_invalid: 0,
        parse_error: None,
    };

    if is_error {
        run.parse_error = Some("claude가 오류로 종료했습니다(is_error). raw_result/stderr 확인.".to_string());
        return Ok(run);
    }

    // 배열 추출 + 등록(멱등, breakdown 포함).
    match extract_json_array(&result_text) {
        Some(arr_text) => match serde_json::from_str::<Vec<ExtractedItem>>(&arr_text) {
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
            Err(e) => run.parse_error = Some(format!("일정 JSON 배열 파싱 실패: {}", e)),
        },
        None => run.parse_error = Some("claude 결과에서 JSON 배열([...])을 찾지 못했습니다.".to_string()),
    }

    Ok(run)
}

/// register_items 와 동일하되 (신규, 중복skip, 검증skip) breakdown 을 반환.
fn register_items_breakdown(app: &AppHandle, items: Vec<ExtractedItem>, today: &str) -> (i64, i64, i64) {
    let total = items.len() as i64;
    register_items_core(app, items, today).unwrap_or((0, 0, total))
}

/// 검색 DB 통계: (존재, 메시지 수, 최신 id).
fn search_db_stats(app: &AppHandle) -> (bool, i64, i64) {
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

/// 검색 DB에서 메시지 원문 HTML 조회. 정제/절단 없이 원문 전체를 그대로 반환한다.
/// 달력 위젯은 이 HTML 을 메시지 뷰어와 동일하게 렌더링하므로, 원문이 그대로 보여야 한다.
fn fetch_message_html(app: &AppHandle, id: i64) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let db = dir.join("hypercool_search.db");
    if !db.exists() {
        return None;
    }
    let conn = Connection::open(&db).ok()?;
    let html: Option<String> = conn
        .query_row(
            "SELECT content FROM messages WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let trimmed = html?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 기등록 AI 일정의 content 를 최신 형식으로 재구성한다.
/// - `<hr>` 앞(head: 요점/교시/발신 + 마커)은 유지하되 구버전 이모지 마커만 정리.
/// - 원문을 새로 가져왔으면 [원문] 섹션을 정제 없이 다시 가져온 전체 원문으로 교체.
/// - 원문을 못 가져오면(참조 없음/검색 DB 미색인) 기존 content 를 보존(데이터 손실 방지).
fn rebuild_ai_content(old_content: &str, fresh_original_html: Option<&str>) -> String {
    match fresh_original_html.map(str::trim).filter(|s| !s.is_empty()) {
        Some(orig) => {
            let head = match old_content.find("<hr>") {
                Some(idx) => &old_content[..idx],
                None => old_content,
            };
            let mut content = head.replace(AI_MARKER_LEGACY, AI_MARKER).trim_end().to_string();
            content.push_str(ORIGINAL_SECTION_HEADER);
            content.push_str(orig);
            content
        }
        None => old_content.replace(AI_MARKER_LEGACY, AI_MARKER),
    }
}

/// 기등록 AI 일정(color = AI_COLOR)의 content 를 최신 형식으로 다시 만든다.
/// reference_id(원본 메시지 id)로 원문 HTML 을 정제 없이 재조회해 [원문] 섹션을 갱신하고,
/// 구버전 이모지 마커를 제거한다. 멱등 — 반복 실행해도 결과가 같다. 반환: 갱신한 항목 수.
#[tauri::command]
pub fn migrate_ai_schedules_content(app: AppHandle) -> Result<u32, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("hypercool.db")).map_err(|e| e.to_string())?;
    // 시작 시점 동시 쓰기(동기화 등)와 겹칠 수 있어 잠금 대기 여유를 둔다.
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    let rows: Vec<(String, Option<String>, Option<String>)> = {
        let mut stmt = conn
            .prepare("SELECT id, content, reference_id FROM tbl_schedules WHERE color = ?1")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([AI_COLOR], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped.filter_map(Result::ok).collect()
    };

    // 밀리초 + 'Z' (iOS 파싱 가능). to_rfc3339() 의 나노초+'+00:00' 은 iOS 가 버린다.
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut updated = 0u32;
    for (id, content, ref_id) in rows {
        let old = content.unwrap_or_default();
        let fresh = ref_id
            .as_deref()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .and_then(|mid| fetch_message_html(&app, mid));
        let rebuilt = rebuild_ai_content(&old, fresh.as_deref());
        if rebuilt != old {
            conn.execute(
                "UPDATE tbl_schedules SET content = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![rebuilt, now, id],
            )
            .map_err(|e| e.to_string())?;
            updated += 1;
        }
    }
    Ok(updated)
}

/// AI 연동 탭 "준비 상태" 패널용: 쿨메신저 원본 연결 상태를 조회한다.
#[derive(Serialize)]
pub struct CoolMessengerStatus {
    /// UdbPath 레지스트리가 지정되어 있고 실제 파일이 존재하는지.
    pub udb_configured: bool,
    /// 검색(FTS) DB에 색인된 메시지 수(0이면 아직 동기화 전).
    pub search_db_count: i64,
}

#[tauri::command]
pub fn get_coolmessenger_status(app: AppHandle) -> CoolMessengerStatus {
    let udb_configured = get_registry_value("UdbPath".to_string())
        .ok()
        .flatten()
        .map(|p| {
            let p = p.trim();
            !p.is_empty() && std::path::Path::new(p).exists()
        })
        .unwrap_or(false);
    CoolMessengerStatus {
        udb_configured,
        search_db_count: count_messages_since(&app, 0),
    }
}

/// HTML 텍스트 노드용 최소 이스케이프(평문 파트를 HTML 에 넣을 때).
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 검색 DB에서 id > since 메시지 수.
fn count_messages_since(app: &AppHandle, since: i64) -> i64 {
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
            .query_row("SELECT COUNT(*) FROM messages WHERE id > ?1", [since], |r| r.get::<_, i64>(0))
            .unwrap_or(0),
        Err(_) => 0,
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
    let prompt = build_prompt(app, &today, last_seen);

    let (stdout, _stderr) = spawn_claude(&claude, &prompt, &mcp_path, &app_data_dir)?;
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

/// claude headless 프로세스를 실행하고 (stdout, stderr)을 반환한다. 타임아웃 시 kill.
fn spawn_claude(
    claude: &PathBuf,
    prompt: &str,
    mcp_path: &PathBuf,
    cwd: &PathBuf,
) -> Result<(String, String), String> {
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

    Ok((stdout, stderr))
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
    register_items_core(app, items, today).map(|(new_c, dedup_c, invalid_c)| (new_c, dedup_c + invalid_c))
}

/// 등록 공통 경로: (신규, 중복 skip, 검증/실패 skip)을 반환.
/// 중복 방지는 2단계다.
/// ① 결정적 id(msg-<id>) 존재 여부 — 같은 메시지의 재처리를 막는다.
/// ② 내용 기반 — 재전송·정정으로 메시지 ID 가 달라져도 같은 날짜에 사실상 같은
///    일정이 이미 있으면 skip. 프롬프트에 기등록 일정을 주입해 claude 가 1차로
///    거르지만, LLM 출력은 비결정적이므로 여기서 결정적으로 한 번 더 막는다.
fn register_items_core(
    app: &AppHandle,
    items: Vec<ExtractedItem>,
    today: &str,
) -> Result<(i64, i64, i64), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("hypercool.db"))
        .map_err(|e| format!("일정 DB 연결 실패: {}", e))?;

    let today_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok();

    let (mut new_c, mut dedup_c, mut invalid_c) = (0i64, 0i64, 0i64);
    // 이번 배치에서 등록한 항목 키 — 한 실행 안에서 온 재전송 메시지끼리도 중복 방지.
    let mut batch_keys: Vec<DedupKey> = Vec::new();

    for item in items {
        let full = item.source_message_id.and_then(|mid| fetch_message_html(app, mid));
        let sched = match to_schedule_item(&item, today_date, full.as_deref()) {
            Some(s) => s,
            None => {
                invalid_c += 1;
                continue;
            }
        };

        // ① 멱등: 같은 id 가 이미 있으면(사용자가 완료/수정/삭제했더라도) 덮어쓰지 않고 skip.
        let exists = conn
            .query_row(
                "SELECT 1 FROM tbl_schedules WHERE id = ?1 LIMIT 1",
                rusqlite::params![sched.id],
                |_| Ok(true),
            )
            .optional()
            .unwrap_or(None)
            .unwrap_or(false);
        if exists {
            dedup_c += 1;
            continue;
        }

        // ② 내용 기반: 같은 날짜의 기존 일정(삭제·완료 포함 — 사용자 결정 존중)과
        //    제목/원문이 사실상 같으면 skip.
        let key = dedup_key_for(&sched);
        if let Some(k) = &key {
            let dup_in_batch = batch_keys.iter().any(|b| keys_similar(k, b, true));
            if dup_in_batch || find_semantic_duplicate(&conn, k).is_some() {
                dedup_c += 1;
                continue;
            }
        }

        match crate::db::create_schedule_impl(&conn, sched) {
            Ok(_) => {
                new_c += 1;
                if let Some(k) = key {
                    batch_keys.push(k);
                }
            }
            Err(_) => invalid_c += 1,
        }
    }

    Ok((new_c, dedup_c, invalid_c))
}

// ─── 내용 기반 중복 판정 ──────────────────────────────────────────────────────

/// 중복 판정 키: 달력 날짜 + 정규화 제목 + 정규화 원문 + 출처 메시지 id.
struct DedupKey {
    date: String,
    norm_title: String,
    norm_body: String,
    source_ref: Option<String>,
}

fn dedup_key_for(sched: &crate::db::ScheduleItem) -> Option<DedupKey> {
    let date = sched.start_date.as_deref()?.get(..10)?.to_string();
    Some(DedupKey {
        date,
        norm_title: normalize_for_match(&sched.title),
        norm_body: normalized_original_body(sched.content.as_deref().unwrap_or("")),
        source_ref: sched.reference_id.clone(),
    })
}

/// 두 키가 "사실상 같은 일정"인지. `fuzzy` 가 false 면(수동 일정과 비교) 제목 완전 일치만 본다.
fn keys_similar(a: &DedupKey, b: &DedupKey, fuzzy: bool) -> bool {
    if a.date != b.date {
        return false;
    }
    if !a.norm_title.is_empty() && a.norm_title == b.norm_title {
        return true;
    }
    if !fuzzy {
        return false;
    }
    // 제목의 숫자열이 다르면(1학년 vs 2학년, 3반 vs 4반 …) 유사해 보여도 별개 일정로 본다.
    if digits_of(&a.norm_title) != digits_of(&b.norm_title) {
        return false;
    }
    if bigram_dice(&a.norm_title, &b.norm_title) >= TITLE_SIM_THRESHOLD {
        return true;
    }
    // 원문 비교는 서로 다른 메시지에서 온 항목끼리만 — 한 메시지에서 분리된 여러
    // 항목은 원문이 같을 수밖에 없으므로 제외.
    let different_source = match (&a.source_ref, &b.source_ref) {
        (Some(x), Some(y)) => x != y,
        _ => true,
    };
    different_source
        && a.norm_body.chars().count() >= MIN_BODY_CHARS
        && b.norm_body.chars().count() >= MIN_BODY_CHARS
        && bigram_dice(&a.norm_body, &b.norm_body) >= BODY_SIM_THRESHOLD
}

/// 같은 날짜의 기존 일정 중 후보와 사실상 같은 것을 찾는다(삭제·완료 포함 — 사용자
/// 결정 존중). AI 생성 일정(color = AI_COLOR)과는 유사도까지, 그 외(수동 등)와는
/// 제목 완전 일치만 비교해 오탐을 줄인다. 반환: 기존 일정 id.
fn find_semantic_duplicate(conn: &Connection, key: &DedupKey) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, color, reference_id FROM tbl_schedules
             WHERE substr(COALESCE(start_date, ''), 1, 10) = ?1",
        )
        .ok()?;
    let rows = stmt
        .query_map([&key.date], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .ok()?;
    for row in rows.flatten() {
        let (id, title, content, color, ref_id) = row;
        let existing = DedupKey {
            date: key.date.clone(),
            norm_title: normalize_for_match(&title),
            norm_body: normalized_original_body(content.as_deref().unwrap_or("")),
            source_ref: ref_id,
        };
        let fuzzy = color.as_deref() == Some(AI_COLOR);
        if keys_similar(key, &existing, fuzzy) {
            return Some(id);
        }
    }
    None
}

/// content 의 [원문] 섹션(<hr> 이후)을 비교용 평문으로 정규화. 원문 섹션이 없으면 빈 문자열.
fn normalized_original_body(content: &str) -> String {
    let orig = match content.find(ORIGINAL_SECTION_HEADER) {
        Some(i) => &content[i + ORIGINAL_SECTION_HEADER.len()..],
        None => match content.find("<hr>") {
            Some(i) => &content[i + "<hr>".len()..],
            None => "",
        },
    };
    normalize_for_match(&strip_html_tags(orig))
}

/// 태그 제거 + 대표 엔티티 복원(비교용 단순 변환 — 렌더링 용도 아님).
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// 비교용 정규화: 문자·숫자만 남기고 소문자화(공백·구두점·서식 차이 무시).
fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 문자열의 숫자만 순서대로 추출(제목 속 학년·반·차수 구분용).
fn digits_of(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// 문자 bigram Dice 유사도(0.0~1.0). 빈 문자열 또는 1글자 불일치면 0.0.
fn bigram_dice(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let bigrams = |s: &str| {
        let cs: Vec<char> = s.chars().collect();
        cs.windows(2).map(|w| (w[0], w[1])).collect::<Vec<_>>()
    };
    let (mut xa, mut xb) = (bigrams(a), bigrams(b));
    if xa.is_empty() || xb.is_empty() {
        return 0.0;
    }
    xa.sort_unstable();
    xb.sort_unstable();
    let (mut i, mut j, mut inter) = (0usize, 0usize, 0usize);
    while i < xa.len() && j < xb.len() {
        match xa[i].cmp(&xb[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                inter += 1;
                i += 1;
                j += 1;
            }
        }
    }
    2.0 * inter as f64 / (xa.len() + xb.len()) as f64
}

/// ExtractedItem → db::ScheduleItem 변환 및 검증. 등록 불가(날짜 없음/과거)면 None.
/// `full_body`: 검색 DB에서 가져온 원문 메시지 전체(있으면 content 에 [원문]으로 첨부).
fn to_schedule_item(
    item: &ExtractedItem,
    today: Option<chrono::NaiveDate>,
    full_body: Option<&str>,
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

    // 시각 결정: 명시 time 우선, 없으면 교시(period)를 학교 시간표로 환산한다.
    // (예: "6교시" → 14:20) 교시만 있는 메시지도 종일이 아니라 해당 슬롯 시각에 배치된다.
    let resolved_time = item
        .time
        .as_deref()
        .and_then(parse_start_time)
        .or_else(|| item.period.as_deref().and_then(period_to_start_time));
    // 시각(명시 또는 교시 환산)이 잡히면 시간 지정 일정. 그 외에는 all_day(LLM 값 우선, 기본 종일).
    let all_day = match &resolved_time {
        Some(_) => false,
        None => item.all_day.unwrap_or(true),
    };
    let start_date = match &resolved_time {
        Some(t) => format!("{}T{}:00+09:00", date_str, t),
        None => date_str.clone(),
    };

    // content(HTML): 요점/교시/발신 + AI 마커 + <hr> + 원문 HTML.
    // 달력 위젯 EditTodoModal / 메인 앱 TodosPage 는 content 를 HTML 로 렌더링하므로
    // 원문을 HTML 로 넣어야 줄바꿈·서식이 보존된다.
    let line = |label: &str, val: &Option<String>| -> Option<String> {
        val.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|v| {
                if label.is_empty() {
                    format!("<div>{}</div>", html_escape(v))
                } else {
                    format!("<div>{}: {}</div>", label, html_escape(v))
                }
            })
    };
    let mut content = String::new();
    if let Some(s) = line("", &item.detail) { content.push_str(&s); }
    if let Some(s) = line("교시", &item.period) { content.push_str(&s); }
    if let Some(s) = line("시간", &item.time) { content.push_str(&s); }
    if let Some(s) = line("발신", &item.sender) { content.push_str(&s); }
    content.push_str(&format!("<div>{}</div>", AI_MARKER));

    // 원문: full_body 는 이미 정제된 HTML. 없으면 source_text 발췌를 escape 해서 사용.
    let original_html = full_body
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            item.source_text
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| format!("<div>{}</div>", html_escape(s)))
        });
    if let Some(orig) = original_html {
        content.push_str(ORIGINAL_SECTION_HEADER);
        content.push_str(&orig);
    }

    // iOS 의 엄격한 날짜 디코더가 파싱할 수 있도록 밀리초 + 'Z' 형식으로 쓴다.
    // (기본 to_rfc3339() 는 나노초 + '+00:00' 이라 iOS 가 문서째 버린다.)
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // 반드시 "manual_todo" 로 등록한다. 달력 위젯(calendar-widget.tsx loadTodos)은
    // manual_todo/desktopcal_memo 만 그리드에 할 일로 렌더링한다. "message_task"(+숫자
    // referenceId)는 "보관한 메시지에 붙는 마감" 메타로만 취급되어 달력에 안 뜬다.
    Some(crate::db::ScheduleItem {
        id,
        schedule_type: "manual_todo".to_string(),
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

/// 프롬프트 템플릿 치환: 오늘 날짜 + 기준 id + 기등록 일정 목록.
/// 기등록 일정을 주입해 claude 가 재전송·정정·표현만 다른 동일 업무를 의미 수준에서
/// 거를 수 있게 한다(등록 측의 내용 중복 백스톱과 이중 방어).
fn build_prompt(app: &AppHandle, today: &str, since: i64) -> String {
    load_prompt_template(app)
        .replace("{{TODAY}}", today)
        .replace("{{LAST_SEEN_ID}}", &since.to_string())
        .replace("{{EXISTING_SCHEDULES}}", &existing_schedules_snippet(app, today))
}

/// 프롬프트에 주입할 "이미 등록된 일정" 목록. 오늘 이후 일정만:
/// - AI 생성분(color = AI_COLOR)은 삭제·완료된 것도 포함 — 사용자가 지운/끝낸 일정을
///   재전송 메시지로 되살리지 않도록 상태를 함께 보여준다.
/// - 수동 일정(manual_todo/desktopcal_memo)은 살아있는 것만.
fn existing_schedules_snippet(app: &AppHandle, today: &str) -> String {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return "(조회 실패)".to_string(),
    };
    let conn = match Connection::open(dir.join("hypercool.db")) {
        Ok(c) => c,
        Err(_) => return "(조회 실패)".to_string(),
    };
    let mut stmt = match conn.prepare(
        "SELECT substr(COALESCE(start_date, ''), 1, 10), title, color, reference_id, is_completed, is_deleted
         FROM tbl_schedules
         WHERE substr(COALESCE(start_date, ''), 1, 10) >= ?1
           AND (color = ?2 OR (is_deleted = 0 AND type IN ('manual_todo', 'desktopcal_memo')))
         ORDER BY 1
         LIMIT 150",
    ) {
        Ok(s) => s,
        Err(_) => return "(조회 실패)".to_string(),
    };
    let rows = stmt.query_map(rusqlite::params![today, AI_COLOR], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, bool>(4)?,
            r.get::<_, bool>(5)?,
        ))
    });
    let mut lines = Vec::new();
    if let Ok(rows) = rows {
        for (date, title, color, ref_id, done, deleted) in rows.flatten() {
            let source = if color.as_deref() == Some(AI_COLOR) {
                match ref_id {
                    Some(r) => format!("AI(msg-{})", r),
                    None => "AI".to_string(),
                }
            } else {
                "수동".to_string()
            };
            let mut line = format!("- {} | {} | {}", date, title, source);
            if deleted {
                line.push_str(" (삭제됨)");
            } else if done {
                line.push_str(" (완료)");
            }
            lines.push(line);
        }
    }
    if lines.is_empty() {
        "(없음)".to_string()
    } else {
        lines.join("\n")
    }
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

/// "N교시" → 시작 시각 "HH:MM"(학교 위젯 types.ts PERIOD_TIMES / main.rs get_current_period 과 동일).
/// 점심(인덱스 4)은 교시가 아니므로 5~7교시는 한 칸 밀어 인덱싱한다. 1~7교시 외에는 None.
fn period_to_start_time(period: &str) -> Option<String> {
    // (시작시, 분) — types.ts PERIOD_TIMES 시작값과 동일. 점심(index 4) 포함 8칸.
    const PERIOD_START: [(u32, u32); 8] = [
        (8, 30),  // 1교시
        (9, 30),  // 2교시
        (10, 30), // 3교시
        (11, 30), // 4교시
        (12, 20), // 점심(교시 아님)
        (13, 20), // 5교시
        (14, 20), // 6교시
        (15, 20), // 7교시
    ];
    let n: u32 = period
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    if !(1..=7).contains(&n) {
        return None;
    }
    // 점심(4) 슬롯을 건너뛰어 5교시부터 한 칸 민다.
    let idx = if n <= 4 { (n - 1) as usize } else { n as usize };
    let (h, m) = PERIOD_START[idx];
    Some(format!("{:02}:{:02}", h, m))
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

/// 문자열의 처음 n글자(초과 시 말줄임 표시).
fn head_chars(s: &str, n: usize) -> String {
    let s = s.trim();
    let mut it = s.chars();
    let head: String = it.by_ref().take(n).collect();
    if it.next().is_some() {
        format!("{}…", head)
    } else {
        head
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
    fn period_to_start_time_matches_school_timetable() {
        // 1~4교시는 그대로, 5~7교시는 점심 슬롯을 건너뛴 시각.
        assert_eq!(period_to_start_time("1교시").as_deref(), Some("08:30"));
        assert_eq!(period_to_start_time("4교시").as_deref(), Some("11:30"));
        assert_eq!(period_to_start_time("5교시").as_deref(), Some("13:20"));
        assert_eq!(period_to_start_time("6교시").as_deref(), Some("14:20"));
        assert_eq!(period_to_start_time("7교시").as_deref(), Some("15:20"));
        // 범위 밖/무효.
        assert_eq!(period_to_start_time("8교시"), None);
        assert_eq!(period_to_start_time("교시"), None);
        assert_eq!(period_to_start_time("점심"), None);
    }

    #[test]
    fn to_schedule_item_derives_time_from_period_when_no_explicit_time() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        // 교시만 있고 명시 시각이 없는 메시지(LLM 이 all_day=true 로 보내도) → 교시 시각으로 배치.
        let item = ExtractedItem {
            source_message_id: Some(6472),
            date: Some("2026-07-09".to_string()),
            all_day: Some(true),
            period: Some("6교시".to_string()),
            title: Some("성적 확인".to_string()),
            ..Default::default()
        };
        let s = to_schedule_item(&item, today, None).unwrap();
        assert!(!s.is_all_day);
        assert_eq!(s.start_date.as_deref(), Some("2026-07-09T14:20:00+09:00"));
        // 명시 time 이 있으면 교시보다 time 우선.
        let item2 = ExtractedItem {
            source_message_id: Some(6473),
            date: Some("2026-07-09".to_string()),
            time: Some("09:00".to_string()),
            period: Some("6교시".to_string()),
            title: Some("회의".to_string()),
            ..Default::default()
        };
        let s2 = to_schedule_item(&item2, today, None).unwrap();
        assert_eq!(s2.start_date.as_deref(), Some("2026-07-09T09:00:00+09:00"));
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
        assert!(to_schedule_item(&past, today, None).is_none());

        let dateless = ExtractedItem {
            source_message_id: Some(11),
            title: Some("날짜없음".to_string()),
            ..Default::default()
        };
        assert!(to_schedule_item(&dateless, today, None).is_none());
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
        let s = to_schedule_item(&item, today, Some("<p>회의 전체 원문 본문입니다.</p>")).unwrap();
        assert_eq!(s.id, "msg-6377");
        assert_eq!(s.schedule_type, "manual_todo");
        assert_eq!(s.reference_id.as_deref(), Some("6377"));
        assert_eq!(s.start_date.as_deref(), Some("2026-07-05T14:00:00+09:00"));
        assert!(!s.is_all_day);
        let content = s.content.as_deref().unwrap();
        assert!(content.contains(AI_MARKER));
        // content 는 HTML 이고 원문 HTML 이 <hr> 뒤에 그대로 첨부되어야 한다.
        assert!(content.contains("<div>발신: 황정환</div>"));
        assert!(content.contains("<hr>"));
        assert!(content.contains("<p>회의 전체 원문 본문입니다.</p>"));
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
        let s = to_schedule_item(&item, today, None).unwrap();
        assert_eq!(s.id, "msg-6377-1");
    }

    #[test]
    fn rebuild_ai_content_replaces_original_and_strips_emoji() {
        let old = format!(
            "<div>요점</div><div>{}</div><hr><div style=\"color:#888;font-size:12px;margin-bottom:4px\">원문</div><div>잘린 원문…</div>",
            AI_MARKER_LEGACY
        );
        let rebuilt = rebuild_ai_content(&old, Some("<p>전체 원문 본문</p>"));
        // 이모지 마커 제거 + 신 마커 유지.
        assert!(!rebuilt.contains(AI_MARKER_LEGACY));
        assert!(rebuilt.contains(AI_MARKER));
        // 요점(head)은 보존, 원문은 새 전체 원문으로 교체.
        assert!(rebuilt.contains("<div>요점</div>"));
        assert!(rebuilt.contains("<p>전체 원문 본문</p>"));
        assert!(!rebuilt.contains("잘린 원문"));
        // 멱등: 같은 입력으로 다시 돌리면 동일.
        assert_eq!(rebuild_ai_content(&rebuilt, Some("<p>전체 원문 본문</p>")), rebuilt);
    }

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tbl_schedules (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT,
                start_date TEXT,
                end_date TEXT,
                is_all_day BOOLEAN NOT NULL DEFAULT 0,
                reference_id TEXT,
                color TEXT,
                is_completed BOOLEAN NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                is_deleted BOOLEAN NOT NULL DEFAULT 0
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn normalize_and_dice_basics() {
        assert_eq!(normalize_for_match("[필독] 창체 소감문, 제출!"), "필독창체소감문제출");
        assert_eq!(bigram_dice("창체소감문제출", "창체소감문제출"), 1.0);
        // 학년만 다른 제목은 임계값 미만이어야 한다.
        assert!(bigram_dice("1학년급식지도", "2학년급식지도") < TITLE_SIM_THRESHOLD);
        // 꼬리에 "안내"만 붙은 재안내 제목은 임계값 이상.
        assert!(bigram_dice("창체소감문제출", "창체소감문제출안내") >= TITLE_SIM_THRESHOLD);
    }

    #[test]
    fn semantic_dedup_blocks_resent_message_with_new_id() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let conn = mem_conn();
        let body = "<p>7월 10일(금)까지 창의적 체험활동 소감문을 학년부로 제출해 주시기 바랍니다.</p><p>미제출 학급은 담임 선생님께서 명단을 회신해 주시기 바랍니다.</p>";

        let first = ExtractedItem {
            source_message_id: Some(100),
            date: Some("2026-07-10".to_string()),
            title: Some("창체 소감문 제출".to_string()),
            ..Default::default()
        };
        let s1 = to_schedule_item(&first, today, Some(body)).unwrap();
        crate::db::create_schedule_impl(&conn, s1).unwrap();

        // 같은 내용이 새 메시지 ID(110)로 재전송 — id 는 다르지만 내용으로 중복 감지.
        let resent = ExtractedItem {
            source_message_id: Some(110),
            date: Some("2026-07-10".to_string()),
            title: Some("창체 소감문 제출 안내".to_string()),
            ..Default::default()
        };
        let s2 = to_schedule_item(&resent, today, Some(body)).unwrap();
        assert_eq!(s2.id, "msg-110");
        let k2 = dedup_key_for(&s2).unwrap();
        assert_eq!(find_semantic_duplicate(&conn, &k2).as_deref(), Some("msg-100"));
    }

    #[test]
    fn semantic_dedup_blocks_near_identical_body_even_when_title_differs() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let conn = mem_conn();
        let body1 = "<p>7월 10일(금)까지 창의적 체험활동 소감문을 학년부로 제출해 주시기 바랍니다.</p><p>미제출 학급은 담임 선생님께서 명단을 회신해 주시기 바랍니다.</p><p>제출 양식은 지난주 배부한 안내문을 참고해 주세요.</p>";
        // 사소한 문구 정정("학년부로" → "교무실로")만 다른 재공지.
        let body2 = "<p>7월 10일(금)까지 창의적 체험활동 소감문을 교무실로 제출해 주시기 바랍니다.</p><p>미제출 학급은 담임 선생님께서 명단을 회신해 주시기 바랍니다.</p><p>제출 양식은 지난주 배부한 안내문을 참고해 주세요.</p>";

        let first = ExtractedItem {
            source_message_id: Some(100),
            date: Some("2026-07-10".to_string()),
            title: Some("소감문 수거".to_string()),
            ..Default::default()
        };
        crate::db::create_schedule_impl(&conn, to_schedule_item(&first, today, Some(body1)).unwrap()).unwrap();

        let corrected = ExtractedItem {
            source_message_id: Some(110),
            date: Some("2026-07-10".to_string()),
            title: Some("소감문 제출 요청".to_string()),
            ..Default::default()
        };
        let s2 = to_schedule_item(&corrected, today, Some(body2)).unwrap();
        let k2 = dedup_key_for(&s2).unwrap();
        // 제목 유사도는 낮지만 원문이 거의 같아 중복으로 잡혀야 한다.
        assert!(find_semantic_duplicate(&conn, &k2).is_some());
    }

    #[test]
    fn different_grade_titles_stay_separate_despite_template_body() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let conn = mem_conn();
        let body = "<p>7월 10일(금) 오전에 학년별 백신 접종이 있습니다. 담임 선생님께서는 접종 동의서를 미리 확인해 주시기 바랍니다.</p>";

        let g1 = ExtractedItem {
            source_message_id: Some(100),
            date: Some("2026-07-10".to_string()),
            title: Some("1학년 백신접종".to_string()),
            ..Default::default()
        };
        crate::db::create_schedule_impl(&conn, to_schedule_item(&g1, today, Some(body)).unwrap()).unwrap();

        // 학년(숫자)만 다른 같은 형식의 메시지 — 별개 일정으로 유지되어야 한다.
        let g2 = ExtractedItem {
            source_message_id: Some(101),
            date: Some("2026-07-10".to_string()),
            title: Some("2학년 백신접종".to_string()),
            ..Default::default()
        };
        let s2 = to_schedule_item(&g2, today, Some(body)).unwrap();
        let k2 = dedup_key_for(&s2).unwrap();
        assert!(find_semantic_duplicate(&conn, &k2).is_none());
    }

    #[test]
    fn items_from_same_message_are_not_body_deduped() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let body = "<p>7월 10일까지 설문 입력과 미참여 학생 명단 제출을 부탁드립니다. 자세한 내용은 첨부 문서를 확인해 주시기 바랍니다.</p>";

        let a = ExtractedItem {
            id: Some("msg-200".to_string()),
            source_message_id: Some(200),
            date: Some("2026-07-10".to_string()),
            title: Some("설문 입력".to_string()),
            ..Default::default()
        };
        let b = ExtractedItem {
            id: Some("msg-200-1".to_string()),
            source_message_id: Some(200),
            date: Some("2026-07-10".to_string()),
            title: Some("명단 제출".to_string()),
            ..Default::default()
        };
        let ka = dedup_key_for(&to_schedule_item(&a, today, Some(body)).unwrap()).unwrap();
        let kb = dedup_key_for(&to_schedule_item(&b, today, Some(body)).unwrap()).unwrap();
        // 한 메시지에서 분리된 두 항목은 원문이 같아도 중복이 아니다.
        assert!(!keys_similar(&ka, &kb, true));
    }

    #[test]
    fn manual_schedule_dedups_by_exact_title_only() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1);
        let conn = mem_conn();
        let now = "2026-07-01T00:00:00Z".to_string();
        // 사용자가 직접 만든 일정(color 없음).
        crate::db::create_schedule_impl(
            &conn,
            crate::db::ScheduleItem {
                id: "manual-1".to_string(),
                schedule_type: "manual_todo".to_string(),
                title: "교직원 회의".to_string(),
                content: None,
                start_date: Some("2026-07-10".to_string()),
                end_date: Some("2026-07-10".to_string()),
                is_all_day: true,
                reference_id: None,
                color: None,
                is_completed: false,
                created_at: now.clone(),
                updated_at: now,
                is_deleted: false,
            },
        )
        .unwrap();

        // 같은 제목의 AI 항목은 수동 일정에 막힌다(완전 일치).
        let same = ExtractedItem {
            source_message_id: Some(300),
            date: Some("2026-07-10".to_string()),
            title: Some("교직원 회의".to_string()),
            ..Default::default()
        };
        let ks = dedup_key_for(&to_schedule_item(&same, today, None).unwrap()).unwrap();
        assert_eq!(find_semantic_duplicate(&conn, &ks).as_deref(), Some("manual-1"));

        // 비슷하지만 다른 제목은 수동 일정과는 fuzzy 비교하지 않으므로 통과.
        let similar = ExtractedItem {
            source_message_id: Some(301),
            date: Some("2026-07-10".to_string()),
            title: Some("교직원 회식".to_string()),
            ..Default::default()
        };
        let kd = dedup_key_for(&to_schedule_item(&similar, today, None).unwrap()).unwrap();
        assert!(find_semantic_duplicate(&conn, &kd).is_none());
    }

    #[test]
    fn rebuild_ai_content_preserves_old_body_when_no_fresh_original() {
        let old = format!(
            "<div>요점</div><div>{}</div><hr><div>원문</div><div>기존 원문 보존</div>",
            AI_MARKER_LEGACY
        );
        let rebuilt = rebuild_ai_content(&old, None);
        // 새 원문을 못 가져오면 기존 content 보존(데이터 손실 방지), 마커만 정리.
        assert!(rebuilt.contains("기존 원문 보존"));
        assert!(!rebuilt.contains(AI_MARKER_LEGACY));
        assert!(rebuilt.contains(AI_MARKER));
    }
}
