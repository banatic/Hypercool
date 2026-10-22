//! 브리핑 에이전트: 새 쿨메신저 메시지가 들어오면 선택한 AI CLI
//! (Claude Code headless 또는 Codex non-interactive)를 호출해 "할 일·일정"을 추출하고,
//! 기존 일정 생성 경로(`db::create_schedule_impl`)로 등록한다.
//!
//! 설계 원칙:
//! - 쓰기 주체는 앱이다. AI에는 hypercool MCP 읽기 도구만 제공하고,
//!   최종 stdout 의 JSON 배열만 파싱해 Rust 가 검증·등록한다.
//! - 트리거는 배치·단일 실행. sync 성공 후 debounce 로 모아 1회, single-flight 로 동시 1개.
//! - 증분 처리. `BriefingLastSeenId` 보다 큰 메시지만 대상으로 하고, 성공 시에만 전진.
//! - 멱등. event id 는 메시지 ID 기반 결정적 값(`msg-<id>`)이며, 이미 있으면 skip → 사용자 편집 보존.
//!   재전송·정정처럼 메시지 ID 가 달라도 내용이 사실상 같은 경우는 (날짜, 제목/원문 유사도)
//!   기준의 내용 중복 판정으로 이중 등록을 막는다.
//! - 선택한 CLI 미설치/미인증 시 기능 자동 비활성화, 앱 크래시 없음.

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
/// 공문에서 만든 AI 일정 색상(메시지 출처 보라색과 구분).
const DOC_COLOR: &str = "#F59E0B";
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
const REG_CODEX_PATH: &str = "CodexCliPath";
const REG_PROVIDER: &str = "BriefingAgentProvider";
const REG_MODEL: &str = "BriefingAgentModel";
const REG_DOCS_ENABLED: &str = "BriefingDocsEnabled";
const REG_DOCS_LAST_SEEN: &str = "BriefingDocsLastSeenId";

/// 공문 1회 실행에서 처리할 최대 공문 수(프롬프트 길이 제한).
const DOCS_PER_PASS: i64 = 5;
/// 프롬프트에 넣을 공문 1건당 최대 문자 수.
const DOC_PROMPT_CHARS: usize = 8000;
/// 일정 content 원문 섹션에 넣을 공문 본문 최대 문자 수.
const DOC_ORIGINAL_CHARS: usize = 20000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ─── 전역 상태 ────────────────────────────────────────────────────────────────

static ENABLED: AtomicBool = AtomicBool::new(false);
/// 에듀파인 공문도 일정 추출 대상에 포함할지(ENABLED 의 하위 옵션).
static DOCS_ENABLED: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
/// CLI 로그인 만료 감지. 켜져 있으면 자동 실행을 멈추고, 수동 "지금 실행"이 성공하면 풀린다.
static AUTH_EXPIRED: AtomicBool = AtomicBool::new(false);
static LAST_TRIGGER_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static LAST_STATUS: OnceLock<Mutex<BriefingStatusSnapshot>> = OnceLock::new();

fn status_slot() -> &'static Mutex<BriefingStatusSnapshot> {
    LAST_STATUS.get_or_init(|| Mutex::new(BriefingStatusSnapshot::default()))
}

// ─── 직렬화 타입 ──────────────────────────────────────────────────────────────

/// claude 가 반환하는 일정 항목(프롬프트 스키마). 필드는 모두 관대하게 Option 처리.
#[derive(Deserialize, Default, Clone)]
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
    /// 공문 출처일 때 edufine_docs.db 의 docs.id.
    source_doc_id: Option<i64>,
    /// 앱이 채우는 값(AI 출력 아님): 원문 섹션 HTML, 참조 id, 출처 표기.
    #[serde(skip)]
    original_html: Option<String>,
    #[serde(skip)]
    reference: Option<String>,
    #[serde(skip)]
    source_label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiProvider {
    Claude,
    Codex,
}

impl AiProvider {
    fn from_saved(value: Option<String>) -> Self {
        match value.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("codex") => Self::Codex,
            _ => Self::Claude,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

#[derive(Clone)]
struct AiConfig {
    provider: AiProvider,
    model: Option<String>,
    executable: Option<PathBuf>,
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
    pub provider: String,
    pub model: Option<String>,
    pub agent_installed: bool,
    pub agent_path: Option<String>,
    pub claude_installed: bool,
    pub claude_path: Option<String>,
    pub codex_installed: bool,
    pub codex_path: Option<String>,
    pub authed: bool,
    /// 최근 실행이 인증 오류로 실패해 자동 실행이 멈춘 상태.
    pub auth_expired: bool,
    pub running: bool,
    pub last_run_at: Option<String>,
    pub last_new_count: i64,
    pub last_error: Option<String>,
    pub last_seen_id: i64,
    pub docs_enabled: bool,
    /// 에듀파인 공문 감시기(MCP 페이지 토글과 공유)가 켜져 있는지.
    pub edufine_enabled: bool,
    pub docs_last_seen_id: i64,
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

#[derive(Clone, Serialize)]
pub struct BriefingModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub is_default: bool,
}

/// 활동 피드 1건: AI 실행 1회(메시지) 또는 공문 1건의 처리 결과.
#[derive(Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    /// 실행 시각(로컬 RFC3339).
    pub at: String,
    /// "messages" | "docs"
    pub source: String,
    pub title: String,
    pub registered: Vec<ActivityItem>,
    pub skipped_dedup: i64,
    pub skipped_invalid: i64,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    pub title: String,
    /// 일정 시작(YYYY-MM-DD 또는 RFC3339).
    pub date: Option<String>,
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
    let docs_enabled = get_registry_value(REG_DOCS_ENABLED.to_string())
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    DOCS_ENABLED.store(docs_enabled, Ordering::Relaxed);

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
    let codex = find_codex();
    let provider = read_provider();
    let selected_path = match provider {
        AiProvider::Claude => claude.clone(),
        AiProvider::Codex => codex.clone(),
    };
    let snapshot = status_slot().lock().unwrap().clone();
    BriefingStatus {
        enabled: is_enabled(),
        provider: provider.as_str().to_string(),
        model: read_model(),
        agent_installed: selected_path.is_some(),
        agent_path: selected_path.map(|p| p.to_string_lossy().to_string()),
        claude_installed: claude.is_some(),
        claude_path: claude.map(|p| p.to_string_lossy().to_string()),
        codex_installed: codex.is_some(),
        codex_path: codex.map(|p| p.to_string_lossy().to_string()),
        authed: is_authed(provider) && !AUTH_EXPIRED.load(Ordering::Relaxed),
        auth_expired: AUTH_EXPIRED.load(Ordering::Relaxed),
        running: RUNNING.load(Ordering::Relaxed),
        last_run_at: snapshot.last_run_at,
        last_new_count: snapshot.last_new_count,
        last_error: snapshot.last_error,
        last_seen_id: read_last_seen_id(),
        docs_enabled: DOCS_ENABLED.load(Ordering::Relaxed),
        edufine_enabled: crate::edufine_watcher::is_enabled(),
        docs_last_seen_id: read_docs_last_seen_id(),
    }
}

/// "공문도 분석" 토글. 켜면 에듀파인 공문 감시기도 함께 켜고,
/// 기준선을 현재 최신 공문으로 잡아 이미 저장된 공문은 소급 처리하지 않는다.
#[tauri::command]
pub fn set_briefing_docs_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        if !crate::edufine_watcher::is_enabled() {
            crate::commands::mcp::toggle_edufine_mcp(app.clone(), true)?;
        }
        if !DOCS_ENABLED.load(Ordering::Relaxed) {
            if let Some(db) = edufine_db_path(&app) {
                let baseline = crate::edufine_db::max_doc_id(&db).unwrap_or(0);
                write_docs_last_seen_id(baseline);
            }
        }
    }
    DOCS_ENABLED.store(enabled, Ordering::Relaxed);
    set_registry_value(
        REG_DOCS_ENABLED.to_string(),
        if enabled { "true" } else { "false" }.to_string(),
    )
}

#[tauri::command]
pub fn set_briefing_agent_config(provider: String, model: Option<String>) -> Result<(), String> {
    let provider = match provider.trim().to_ascii_lowercase().as_str() {
        "claude" => AiProvider::Claude,
        "codex" => AiProvider::Codex,
        _ => return Err("지원하지 않는 AI 공급자입니다.".to_string()),
    };
    let model = normalize_model(model)?;
    if provider != read_provider() {
        // 다른 CLI 로 바꾸면 이전 CLI 의 로그인 만료 상태는 의미가 없다.
        AUTH_EXPIRED.store(false, Ordering::Relaxed);
    }
    set_registry_value(REG_PROVIDER.to_string(), provider.as_str().to_string())?;
    set_registry_value(REG_MODEL.to_string(), model.unwrap_or_default())
}

/// 선택한 CLI가 현재 노출하는 모델 목록. Codex는 app-server `model/list`에서 동적으로 읽는다.
#[tauri::command]
pub async fn get_briefing_agent_models(provider: String) -> Result<Vec<BriefingModelOption>, String> {
    let provider = match provider.trim().to_ascii_lowercase().as_str() {
        "claude" => AiProvider::Claude,
        "codex" => AiProvider::Codex,
        _ => return Err("지원하지 않는 AI 공급자입니다.".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || match provider {
        AiProvider::Claude => {
            let claude = find_claude().ok_or_else(|| "Claude Code CLI를 찾을 수 없습니다.".to_string())?;
            // initialize 를 지원하지 않는 구버전 CLI 는 고정 별칭으로 대체한다.
            Ok(list_claude_models(&claude).unwrap_or_else(|e| {
                eprintln!("[agent] Claude 모델 목록 조회 실패, 기본 별칭 사용: {}", e);
                claude_fallback_models()
            }))
        }
        AiProvider::Codex => {
            let codex = find_codex().ok_or_else(|| "Codex CLI를 찾을 수 없습니다.".to_string())?;
            list_codex_models(&codex)
        }
    })
    .await
    .map_err(|e| format!("모델 목록 조회 작업 실패: {}", e))?
}

/// 활동 피드(최신순).
#[tauri::command]
pub fn get_briefing_activity(app: AppHandle, limit: Option<usize>) -> Vec<ActivityEntry> {
    let mut entries = read_activity(&app);
    entries.reverse();
    entries.truncate(limit.unwrap_or(50).clamp(1, ACTIVITY_MAX));
    entries
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
    schedule_debounced_run(app);
}

/// 에듀파인 감시기가 새 공문을 저장한 뒤 호출한다. "공문도 분석"이 켜져 있을 때만 실행.
pub fn on_new_docs(app: &AppHandle) {
    if DOCS_ENABLED.load(Ordering::Relaxed) {
        schedule_debounced_run(app);
    }
}

/// ENABLED + CLI 존재 시 trailing debounce 후 1회 실행(메시지·공문 공용).
fn schedule_debounced_run(app: &AppHandle) {
    if !is_enabled() || read_ai_config().executable.is_none() {
        return;
    }
    // 로그인 만료 중엔 같은 오류만 반복되므로 자동 실행을 건너뛴다(새 메시지는 last_seen 이 그대로라 나중에 처리됨).
    if AUTH_EXPIRED.load(Ordering::Relaxed) {
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
        if !is_latest || !is_enabled() || AUTH_EXPIRED.load(Ordering::Relaxed) {
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
        let mut auth_failed = false;
        match run_pass(app, &PassOpts { since_override: None, advance: true }) {
            Ok((n, s)) => {
                total_new += n;
                total_skipped += s;
            }
            Err(e) => {
                auth_failed = is_auth_error(&e);
                last_err = Some(e);
            }
        }
        // 메시지에서 인증 오류가 났으면 공문도 같은 이유로 실패하므로 건너뛴다.
        if DOCS_ENABLED.load(Ordering::Relaxed) && !auth_failed {
            match run_docs_pass(app) {
                Ok((n, s)) => {
                    total_new += n;
                    total_skipped += s;
                }
                Err(e) => {
                    auth_failed = is_auth_error(&e);
                    last_err = Some(match last_err {
                        Some(prev) => format!("{} / 공문: {}", prev, e),
                        None => format!("공문: {}", e),
                    });
                }
            }
        }
        if auth_failed {
            AUTH_EXPIRED.store(true, Ordering::Relaxed);
        } else if last_err.is_none() {
            AUTH_EXPIRED.store(false, Ordering::Relaxed);
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
fn run_debug_report(app: &AppHandle, count: i64) -> BriefingDebugReport {
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
struct AiDebugRun {
    is_error: bool,
    result_text: String,
    stderr_tail: Option<String>,
    extracted: i64,
    registered: i64,
    skipped_dedup: i64,
    skipped_invalid: i64,
    parse_error: Option<String>,
}

/// 선택한 AI를 실행하고 원문/추출/등록 breakdown 을 채운다(디버그 전용).
fn run_ai_debug(app: &AppHandle, config: &AiConfig, since: i64) -> Result<AiDebugRun, String> {
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
fn register_items_breakdown(app: &AppHandle, items: Vec<ExtractedItem>, today: &str) -> (i64, i64, i64) {
    let total = items.len() as i64;
    register_items_core(app, items, today)
        .map(|(n, d, i, _)| (n, d, i))
        .unwrap_or((0, 0, total))
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
            .prepare("SELECT id, content, reference_id FROM tbl_schedules WHERE color IN (?1, ?2)")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([AI_COLOR, DOC_COLOR], |r| {
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
    // 공문 출처 일정이 구버전(보라색)으로 등록돼 있으면 공문 색으로 바꾼다.
    let recolored = conn
        .execute(
            "UPDATE tbl_schedules SET color = ?1, updated_at = ?2
             WHERE color = ?3 AND reference_id LIKE 'doc-%'",
            rusqlite::params![DOC_COLOR, now, AI_COLOR],
        )
        .map_err(|e| e.to_string())?;
    Ok(updated + recolored as u32)
}

/// AI 가 만든 일정(메시지·공문 출처)인지 색상으로 판정.
fn is_ai_color(color: Option<&str>) -> bool {
    matches!(color, Some(c) if c.eq_ignore_ascii_case(AI_COLOR) || c.eq_ignore_ascii_case(DOC_COLOR))
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

/// 실제 1회 실행: 선택한 AI 호출 → 파싱 → 검증 → 등록 → (옵션) last_seen 전진.
/// 반환: (신규 등록 수, skip 수). 실패 시 Err(사유) — last_seen 은 전진하지 않음.
fn run_pass(app: &AppHandle, opts: &PassOpts) -> Result<(i64, i64), String> {
    let config = read_ai_config();
    if config.executable.is_none() {
        return Err(format!(
            "{} CLI를 찾을 수 없습니다. 설치 후 다시 시도하세요.",
            config.provider.display_name()
        ));
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let last_seen = opts.since_override.unwrap_or_else(read_last_seen_id);
    let current_max = current_max_message_id(app);
    // 신규 메시지가 없으면 AI 실행 없이 즉시 종료(증분).
    if current_max <= last_seen {
        return Ok((0, 0));
    }

    let today = seoul_today();
    let prompt = build_prompt(app, &today, last_seen);
    let msg_title = format!("메시지 {}건", count_messages_since(app, last_seen));

    let attempt = (|| -> Result<(i64, i64, Vec<RegItem>), String> {
        let output = spawn_ai(app, &config, &prompt, &app_data_dir)?;
        if output.is_error {
            let detail = if output.result.trim().is_empty() {
                tail_chars(&output.stderr, 300)
            } else {
                tail_chars(&output.result, 300)
            };
            return Err(format!("{} 오류: {}", config.provider.display_name(), detail));
        }
        let items = parse_items_from_result(&output.result)?;
        register_items(app, items, &today)
    })();
    let (new_count, skipped) = match attempt {
        Ok((n, s, regs)) => {
            push_activity(app, vec![activity_entry("messages", msg_title, &regs.iter().collect::<Vec<_>>(), None)]);
            (n, s)
        }
        Err(e) => {
            push_activity(app, vec![activity_entry("messages", msg_title, &[], Some(e.clone()))]);
            return Err(e);
        }
    };

    // 성공(프로세스 정상 종료 + 파싱 성공)했으므로 last_seen 을 전진시킨다(추출 0건이어도).
    if opts.advance {
        write_last_seen_id(current_max);
    }

    if new_count > 0 {
        notify_calendar_changed(app);
    }

    Ok((new_count, skipped))
}

fn notify_calendar_changed(app: &AppHandle) {
    // best-effort: 탁상달력에도 반영(실패 무시).
    if let Ok(Some(path)) = crate::db::detect_desktopcal() {
        let _ = crate::db::sync_to_desktopcal(app.clone(), path);
    }
    // 프론트가 loadSchedules + Firestore sync 를 돌리도록 알림.
    let _ = app.emit("calendar-update", ());
}

// ─── 활동 기록 ────────────────────────────────────────────────────────────────

const ACTIVITY_FILE: &str = "briefing_activity.json";
const ACTIVITY_MAX: usize = 100;
static ACTIVITY_LOCK: Mutex<()> = Mutex::new(());

fn activity_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(ACTIVITY_FILE))
}

/// 오래된 순으로 저장된 활동 기록.
fn read_activity(app: &AppHandle) -> Vec<ActivityEntry> {
    activity_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn push_activity(app: &AppHandle, new_entries: Vec<ActivityEntry>) {
    if new_entries.is_empty() {
        return;
    }
    let Some(path) = activity_path(app) else { return };
    let _guard = ACTIVITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_activity(app);
    entries.extend(new_entries);
    if entries.len() > ACTIVITY_MAX {
        let cut = entries.len() - ACTIVITY_MAX;
        entries.drain(..cut);
    }
    if let Ok(text) = serde_json::to_string(&entries) {
        let _ = std::fs::write(path, text);
    }
}

fn activity_entry(source: &str, title: String, regs: &[&RegItem], error: Option<String>) -> ActivityEntry {
    ActivityEntry {
        at: chrono::Local::now().to_rfc3339(),
        source: source.to_string(),
        title,
        registered: regs
            .iter()
            .filter(|r| r.status == RegStatus::New)
            .map(|r| ActivityItem { title: r.title.clone(), date: r.date.clone() })
            .collect(),
        skipped_dedup: regs.iter().filter(|r| r.status == RegStatus::Duplicate).count() as i64,
        skipped_invalid: regs
            .iter()
            .filter(|r| matches!(r.status, RegStatus::Invalid | RegStatus::Past))
            .count() as i64,
        error,
    }
}

// ─── 공문 실행 ────────────────────────────────────────────────────────────────

/// 일정 추출 대상 공문(붙임 파일 등은 걸러진 뒤).
struct DocInput {
    doc_id: i64,
    doc_no: String,
    title: String,
    viewed_date: String,
    text: String,
}

fn edufine_db_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_data_dir().ok()?.join("edufine_docs.db");
    path.exists().then_some(path)
}

/// 공문 본문의 문서번호("시행 교육과정과-1234 (2026. 10. 1.)" → "교육과정과-1234").
/// 붙임 파일(계획서·서식 등)에는 수신/제목/시행 줄이 없으므로, 없으면 공문 본문이 아닌 것으로 본다.
fn extract_doc_no(content: &str) -> Option<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"시행\s+([^\s()]+-\d+)").unwrap());
    if !(content.contains("수신") && content.contains("제목")) {
        return None;
    }
    re.captures(content).map(|c| c[1].to_string())
}

/// 결정적 일정 id 용 문서번호 정규화(Firestore 문서 id 에 '/' 불가).
fn doc_key(doc_no: &str) -> String {
    let key: String = doc_no
        .chars()
        .map(|c| if c.is_whitespace() || c == '/' { '_' } else { c })
        .collect();
    format!("doc-{}", key)
}

/// docs.detected_at(SQLite CURRENT_TIMESTAMP, UTC "YYYY-MM-DD HH:MM:SS") → 서울 기준 날짜.
fn detected_to_seoul_date(detected_at: &str) -> String {
    chrono::NaiveDateTime::parse_from_str(detected_at.trim(), "%Y-%m-%d %H:%M:%S")
        .map(|dt| {
            dt.and_utc()
                .with_timezone(&seoul_offset())
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|_| detected_at.chars().take(10).collect())
}

/// 평문 공문 본문 → 원문 섹션 HTML(줄 단위 div).
fn doc_text_to_html(text: &str) -> String {
    head_chars(text, DOC_ORIGINAL_CHARS)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| format!("<div>{}</div>", html_escape(l)))
        .collect()
}

/// 저장된 공문 → 분석 대상. 붙임 파일은 빼고, 같은 문서번호가 여러 번 있으면(재열람) 마지막 것만 쓴다.
fn docs_to_targets(docs: Vec<crate::edufine_db::EdufineDoc>) -> Vec<DocInput> {
    let mut targets: Vec<DocInput> = Vec::new();
    for d in docs {
        let Some(doc_no) = extract_doc_no(&d.content) else { continue };
        targets.retain(|t| t.doc_no != doc_no);
        targets.push(DocInput {
            doc_id: d.id,
            doc_no,
            title: crate::edufine_watcher::doc_title(&d.content, &d.file_name),
            viewed_date: detected_to_seoul_date(&d.detected_at),
            text: d.content,
        });
    }
    targets
}

/// 공문 본문을 프롬프트에 직접 넣어 AI 호출 → 문서번호 기반 id·출처를 채운 항목. 반환: (항목, AI 원문 응답).
fn analyze_docs(
    app: &AppHandle,
    config: &AiConfig,
    targets: &[DocInput],
    today: &str,
) -> Result<(Vec<ExtractedItem>, String), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let docs_block = targets
        .iter()
        .map(|t| {
            format!(
                "=== 공문 doc_id={} ===\n문서번호: {}\n제목: {}\n열람일: {}\n본문:\n{}\n",
                t.doc_id,
                t.doc_no,
                t.title,
                t.viewed_date,
                head_chars(&t.text, DOC_PROMPT_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = load_docs_prompt_template(app)
        .replace("{{TODAY}}", today)
        .replace("{{EXISTING_SCHEDULES}}", &existing_schedules_snippet(app, today))
        .replace("{{DOCS}}", &docs_block);

    let output = spawn_ai(app, config, &prompt, &app_data_dir)?;
    if output.is_error {
        let detail = if output.result.trim().is_empty() {
            tail_chars(&output.stderr, 300)
        } else {
            tail_chars(&output.result, 300)
        };
        return Err(format!("{} 오류: {}", config.provider.display_name(), detail));
    }
    let raw_items = parse_items_from_result(&output.result)?;

    // id 는 AI 값 대신 문서번호로 결정적으로 부여한다(재열람·재실행 멱등).
    // 한 공문에서 2건 이상이면 doc-<번호>, doc-<번호>-1, ...
    let mut per_doc: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    let mut items = Vec::new();
    for mut item in raw_items {
        let Some(t) = item
            .source_doc_id
            .and_then(|id| targets.iter().find(|t| t.doc_id == id))
        else {
            continue;
        };
        let n = per_doc.entry(t.doc_id).or_insert(0);
        let key = doc_key(&t.doc_no);
        item.id = Some(if *n == 0 { key.clone() } else { format!("{}-{}", key, n) });
        *n += 1;
        item.source_message_id = None;
        item.received_at = Some(t.viewed_date.clone());
        item.period = None;
        item.reference = Some(key);
        item.source_label = Some(format!("공문 {}", t.doc_no));
        item.original_html = Some(doc_text_to_html(&t.text));
        items.push(item);
    }
    Ok((items, output.result))
}

/// 메시지 분석: last_seen 기준 프롬프트로 AI 호출 → 항목. 반환: (항목, AI 원문 응답).
fn analyze_messages(
    app: &AppHandle,
    config: &AiConfig,
    since: i64,
    today: &str,
) -> Result<(Vec<ExtractedItem>, String), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let prompt = build_prompt(app, today, since);
    let output = spawn_ai(app, config, &prompt, &app_data_dir)?;
    if output.is_error {
        let detail = if output.result.trim().is_empty() {
            tail_chars(&output.stderr, 300)
        } else {
            tail_chars(&output.result, 300)
        };
        return Err(format!("{} 오류: {}", config.provider.display_name(), detail));
    }
    let items = parse_items_from_result(&output.result)?;
    Ok((items, output.result))
}

/// 새 공문 1회 처리. 공문은 열람 시점에 저장되므로 증분 기준은 docs.id.
fn run_docs_pass(app: &AppHandle) -> Result<(i64, i64), String> {
    let config = read_ai_config();
    if config.executable.is_none() {
        return Err(format!("{} CLI를 찾을 수 없습니다.", config.provider.display_name()));
    }
    let Some(db) = edufine_db_path(app) else {
        return Ok((0, 0));
    };
    let last_seen = read_docs_last_seen_id();
    let docs = crate::edufine_db::list_docs_after(&db, last_seen, DOCS_PER_PASS)
        .map_err(|e| format!("공문 DB 조회 실패: {}", e))?;
    let Some(max_id) = docs.last().map(|d| d.id) else {
        return Ok((0, 0));
    };
    let targets = docs_to_targets(docs);
    if targets.is_empty() {
        write_docs_last_seen_id(max_id);
        return Ok((0, 0));
    }

    let today = seoul_today();
    let items = match analyze_docs(app, &config, &targets, &today) {
        Ok((items, _)) => items,
        Err(e) => {
            push_activity(
                app,
                vec![activity_entry("docs", format!("공문 {}건", targets.len()), &[], Some(e.clone()))],
            );
            return Err(e);
        }
    };

    let (new_count, skipped, regs) = register_items(app, items, &today)?;
    // 공문마다 한 줄씩 기록(등록 0건이면 "기한 있는 조치 없음"으로 보인다).
    let entries = targets
        .iter()
        .map(|t| {
            let key = doc_key(&t.doc_no);
            let mine: Vec<&RegItem> = regs.iter().filter(|r| r.reference.as_deref() == Some(key.as_str())).collect();
            activity_entry("docs", format!("{} · {}", t.doc_no, t.title), &mine, None)
        })
        .collect();
    push_activity(app, entries);
    write_docs_last_seen_id(max_id);
    if new_count > 0 {
        notify_calendar_changed(app);
    }
    Ok((new_count, skipped))
}

// ─── 소급 실행(진단 탭) ───────────────────────────────────────────────────────
// 미리보기: 과거 메시지·저장된 공문을 AI 로 분석하되 DB 에 쓰지 않고 예상 결과만 보여준다.
// 반영: 미리보기에서 고른 항목만 등록한다(AI 재실행 없음). 자동 실행 진행 위치는 건드리지 않는다.

/// 소급 미리보기 최대 메시지 수(프롬프트·타임아웃 한계).
const BACKFILL_MAX_MESSAGES: i64 = 50;
/// 소급 미리보기 최대 공문 수(DOCS_PER_PASS 단위로 나눠 실행).
const BACKFILL_MAX_DOCS: usize = 20;

struct BackfillStash {
    id: u64,
    source: String,
    title: String,
    items: Vec<ExtractedItem>,
}

static BACKFILL: Mutex<Option<BackfillStash>> = Mutex::new(None);

#[derive(Serialize)]
pub struct BackfillDoc {
    pub id: i64,
    pub title: String,
    /// None 이면 붙임·초안 등 공문 본문이 아님(분석 대상 아님).
    pub doc_no: Option<String>,
    pub detected_at: String,
    /// 이 공문으로 이미 등록된 일정 수(삭제·완료 포함).
    pub registered: i64,
}

#[derive(Serialize)]
pub struct BackfillPreviewItem {
    pub index: usize,
    pub title: String,
    pub date: Option<String>,
    pub source_label: String,
    pub detail: Option<String>,
    /// new | duplicate | past | invalid
    pub status: String,
}

#[derive(Serialize)]
pub struct BackfillPreview {
    pub preview_id: u64,
    pub source: String,
    /// 분석한 메시지/공문 수.
    pub scanned: i64,
    /// 붙임·초안이라 건너뛴 공문 수.
    pub skipped_docs: i64,
    pub items: Vec<BackfillPreviewItem>,
    pub duration_ms: u64,
    pub raw_result: Option<String>,
}

#[derive(Serialize)]
pub struct BackfillApplyResult {
    pub new_count: i64,
    pub skipped: i64,
}

/// 소급 대상으로 고를 수 있는 저장된 공문 목록(최신순).
#[tauri::command]
pub fn list_backfill_docs(app: AppHandle, limit: Option<i64>) -> Vec<BackfillDoc> {
    let Some(db) = edufine_db_path(&app) else { return Vec::new() };
    let previews = crate::edufine_db::list_docs(&db, limit.unwrap_or(30).clamp(1, 100), 0).unwrap_or_default();
    let conn = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| Connection::open(d.join("hypercool.db")).ok());
    previews
        .into_iter()
        .filter_map(|p| crate::edufine_db::get_doc(&db, p.id).ok().flatten())
        .map(|d| {
            let doc_no = extract_doc_no(&d.content);
            let registered = match (&conn, &doc_no) {
                (Some(c), Some(no)) => {
                    let key = doc_key(no);
                    c.query_row(
                        "SELECT COUNT(*) FROM tbl_schedules WHERE reference_id = ?1",
                        [&key],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
                }
                _ => 0,
            };
            BackfillDoc {
                id: d.id,
                title: crate::edufine_watcher::doc_title(&d.content, &d.file_name),
                doc_no,
                detected_at: d.detected_at,
                registered,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn preview_backfill(
    app: AppHandle,
    source: String,
    count: Option<i64>,
    doc_ids: Option<Vec<i64>>,
) -> Result<BackfillPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("자동 실행이 진행 중입니다. 잠시 후 다시 시도하세요.".to_string());
        }
        let result = preview_backfill_locked(&app, &source, count, doc_ids.unwrap_or_default());
        RUNNING.store(false, Ordering::SeqCst);
        // 미리보기 중 들어온 자동 실행 요청은 여기서 이어서 처리한다.
        if PENDING.swap(false, Ordering::SeqCst) {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let _ = run_briefing_locked(&app2);
            });
        }
        result
    })
    .await
    .map_err(|e| format!("실행 작업 실패: {}", e))?
}

fn preview_backfill_locked(
    app: &AppHandle,
    source: &str,
    count: Option<i64>,
    doc_ids: Vec<i64>,
) -> Result<BackfillPreview, String> {
    let config = read_ai_config();
    if config.executable.is_none() {
        return Err(format!("{} CLI를 찾을 수 없습니다.", config.provider.display_name()));
    }
    let today = seoul_today();
    let started = Instant::now();

    let (items, raw, scanned, skipped_docs, title) = match source {
        "messages" => {
            // 검색 DB 를 UDB 와 먼저 맞춘다(최근 메시지가 MCP 에 보이도록).
            if let Some(path) = get_registry_value("UdbPath".to_string()).ok().flatten() {
                let _ = crate::search_db::sync_from_udb(app, path);
            }
            let n = count.unwrap_or(10).clamp(1, BACKFILL_MAX_MESSAGES);
            let (_, _, max_id) = search_db_stats(app);
            let since = (max_id - n).max(0);
            let scanned = count_messages_since(app, since);
            if scanned == 0 {
                return Err("분석할 메시지가 없습니다. 쿨메신저 연결을 확인하세요.".to_string());
            }
            let (items, raw) = analyze_messages(app, &config, since, &today)?;
            (items, raw, scanned, 0, format!("소급 · 메시지 최근 {}개", n))
        }
        "docs" => {
            let db = edufine_db_path(app).ok_or_else(|| "저장된 공문이 없습니다.".to_string())?;
            let mut ids = doc_ids;
            ids.sort_unstable();
            ids.dedup();
            ids.truncate(BACKFILL_MAX_DOCS);
            if ids.is_empty() {
                return Err("분석할 공문을 고르세요.".to_string());
            }
            let docs: Vec<_> = ids
                .iter()
                .filter_map(|id| crate::edufine_db::get_doc(&db, *id).ok().flatten())
                .collect();
            let picked = docs.len() as i64;
            let targets = docs_to_targets(docs);
            let skipped = picked - targets.len() as i64;
            if targets.is_empty() {
                return Err("고른 문서가 모두 붙임·초안이라 분석할 공문이 없습니다.".to_string());
            }
            let mut items = Vec::new();
            let mut raws = Vec::new();
            for chunk in targets.chunks(DOCS_PER_PASS as usize) {
                let (mut part, raw) = analyze_docs(app, &config, chunk, &today)?;
                items.append(&mut part);
                raws.push(raw);
            }
            let n = targets.len();
            (items, raws.join("\n\n"), n as i64, skipped, format!("소급 · 공문 {}건", n))
        }
        _ => return Err("지원하지 않는 소급 대상입니다.".to_string()),
    };

    let (_, _, _, regs) = register_items_opts(app, items.clone(), &today, true)?;
    let preview_items = items
        .iter()
        .zip(regs.iter())
        .enumerate()
        .map(|(index, (item, reg))| BackfillPreviewItem {
            index,
            title: reg.title.clone(),
            date: reg.date.clone(),
            source_label: item.source_label.clone().unwrap_or_else(|| {
                let mut label = item
                    .source_message_id
                    .map(|m| format!("메시지 #{}", m))
                    .unwrap_or_else(|| "메시지".to_string());
                if let Some(sender) = item.sender.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    label.push_str(" · ");
                    label.push_str(sender);
                }
                label
            }),
            detail: item.detail.clone(),
            status: reg.status.as_str().to_string(),
        })
        .collect();

    let preview_id = chrono::Utc::now().timestamp_millis() as u64;
    *BACKFILL.lock().unwrap_or_else(|e| e.into_inner()) = Some(BackfillStash {
        id: preview_id,
        source: source.to_string(),
        title,
        items,
    });

    Ok(BackfillPreview {
        preview_id,
        source: source.to_string(),
        scanned,
        skipped_docs,
        items: preview_items,
        duration_ms: started.elapsed().as_millis() as u64,
        raw_result: Some(raw),
    })
}

/// 미리보기에서 고른 항목만 등록한다. 등록 시점에 중복을 다시 확인한다.
#[tauri::command]
pub fn apply_backfill(app: AppHandle, preview_id: u64, indices: Vec<usize>) -> Result<BackfillApplyResult, String> {
    let stash = {
        let mut slot = BACKFILL.lock().unwrap_or_else(|e| e.into_inner());
        match slot.take() {
            Some(s) if s.id == preview_id => s,
            other => {
                *slot = other;
                return Err("미리보기가 만료되었습니다. 다시 실행하세요.".to_string());
            }
        }
    };
    let selected: Vec<ExtractedItem> = indices
        .into_iter()
        .filter_map(|i| stash.items.get(i).cloned())
        .collect();
    if selected.is_empty() {
        return Ok(BackfillApplyResult { new_count: 0, skipped: 0 });
    }
    let today = seoul_today();
    let (new_count, skipped, regs) = register_items(&app, selected, &today)?;
    push_activity(
        &app,
        vec![activity_entry(&stash.source, stash.title, &regs.iter().collect::<Vec<_>>(), None)],
    );
    if new_count > 0 {
        notify_calendar_changed(&app);
    }
    let snapshot = status_slot().lock().unwrap().clone();
    let _ = app.emit("briefing-status", snapshot);
    Ok(BackfillApplyResult { new_count, skipped })
}

fn load_docs_prompt_template(app: &AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("briefing_docs_prompt.md");
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    include_str!("../resources/briefing_docs_prompt.md").to_string()
}

struct AiOutput {
    result: String,
    stderr: String,
    is_error: bool,
}

/// 선택한 AI CLI를 비대화형으로 실행한다. 타임아웃 시 프로세스를 종료한다.
fn spawn_ai(
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

fn spawn_claude(
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

fn spawn_codex(
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
fn write_codex_output_schema(cwd: &PathBuf) -> Result<PathBuf, String> {
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

fn run_child(
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

fn parse_items_from_result(result: &str) -> Result<Vec<ExtractedItem>, String> {
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
) -> Result<(i64, i64, Vec<RegItem>), String> {
    register_items_core(app, items, today)
        .map(|(new_c, dedup_c, invalid_c, regs)| (new_c, dedup_c + invalid_c, regs))
}

/// 등록 시도 1건의 결과(활동 기록용).
struct RegItem {
    /// 출처 참조(메시지 id 문자열 또는 doc-<문서번호>).
    reference: Option<String>,
    title: String,
    date: Option<String>,
    status: RegStatus,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RegStatus {
    New,
    Duplicate,
    /// 기한이 오늘보다 과거라 등록하지 않음.
    Past,
    /// 날짜 없음 등 검증 실패.
    Invalid,
}

impl RegStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Duplicate => "duplicate",
            Self::Past => "past",
            Self::Invalid => "invalid",
        }
    }
}

/// 항목의 달력 날짜(date → active_from → received_at)가 오늘보다 과거인지.
fn is_past_item(item: &ExtractedItem, today: Option<chrono::NaiveDate>) -> bool {
    let Some(t) = today else { return false };
    [item.date.as_deref(), item.active_from.as_deref(), item.received_at.as_deref()]
        .into_iter()
        .flatten()
        .find_map(parse_date_loose)
        .is_some_and(|d| d < t)
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
) -> Result<(i64, i64, i64, Vec<RegItem>), String> {
    register_items_opts(app, items, today, false)
}

/// `dry_run` 이면 DB 에 쓰지 않고 각 항목의 예상 결과만 돌려준다(소급 미리보기).
/// regs 는 입력 items 와 같은 순서·같은 개수다.
fn register_items_opts(
    app: &AppHandle,
    items: Vec<ExtractedItem>,
    today: &str,
    dry_run: bool,
) -> Result<(i64, i64, i64, Vec<RegItem>), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("hypercool.db"))
        .map_err(|e| format!("일정 DB 연결 실패: {}", e))?;

    let today_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok();

    let (mut new_c, mut dedup_c, mut invalid_c) = (0i64, 0i64, 0i64);
    // 이번 배치에서 등록한 항목 키 — 한 실행 안에서 온 재전송 메시지끼리도 중복 방지.
    let mut batch_keys: Vec<DedupKey> = Vec::new();
    let mut regs: Vec<RegItem> = Vec::new();

    for item in items {
        let reference = item
            .source_message_id
            .map(|m| m.to_string())
            .or_else(|| item.reference.clone());
        let full = item
            .source_message_id
            .and_then(|mid| fetch_message_html(app, mid))
            .or_else(|| item.original_html.clone());
        let sched = match to_schedule_item(&item, today_date, full.as_deref()) {
            Some(s) => s,
            None => {
                invalid_c += 1;
                regs.push(RegItem {
                    reference,
                    title: item.title.clone().unwrap_or_default(),
                    date: item.date.clone(),
                    status: if is_past_item(&item, today_date) { RegStatus::Past } else { RegStatus::Invalid },
                });
                continue;
            }
        };
        let mut reg = RegItem {
            reference,
            title: sched.title.clone(),
            date: sched.start_date.clone(),
            status: RegStatus::Duplicate,
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
            regs.push(reg);
            continue;
        }

        // ② 내용 기반: 같은 날짜의 기존 일정(삭제·완료 포함 — 사용자 결정 존중)과
        //    제목/원문이 사실상 같으면 skip.
        let key = dedup_key_for(&sched);
        if let Some(k) = &key {
            let dup_in_batch = batch_keys.iter().any(|b| keys_similar(k, b, true));
            if dup_in_batch || find_semantic_duplicate(&conn, k).is_some() {
                dedup_c += 1;
                regs.push(reg);
                continue;
            }
        }

        if dry_run {
            new_c += 1;
            if let Some(k) = key {
                batch_keys.push(k);
            }
            reg.status = RegStatus::New;
            regs.push(reg);
            continue;
        }

        match crate::db::create_schedule_impl(&conn, sched) {
            Ok(_) => {
                new_c += 1;
                if let Some(k) = key {
                    batch_keys.push(k);
                }
                reg.status = RegStatus::New;
                regs.push(reg);
            }
            Err(_) => {
                invalid_c += 1;
                reg.status = RegStatus::Invalid;
                regs.push(reg);
            }
        }
    }

    Ok((new_c, dedup_c, invalid_c, regs))
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
        let fuzzy = is_ai_color(color.as_deref());
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
    if let Some(s) = line("출처", &item.source_label) { content.push_str(&s); }
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
        reference_id: item
            .source_message_id
            .map(|m| m.to_string())
            .or_else(|| item.reference.clone()),
        color: Some(
            if item.reference.as_deref().is_some_and(|r| r.starts_with("doc-")) { DOC_COLOR } else { AI_COLOR }
                .to_string(),
        ),
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

fn read_docs_last_seen_id() -> i64 {
    get_registry_value(REG_DOCS_LAST_SEEN.to_string())
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

fn write_docs_last_seen_id(id: i64) {
    let _ = set_registry_value(REG_DOCS_LAST_SEEN.to_string(), id.to_string());
}

fn read_provider() -> AiProvider {
    AiProvider::from_saved(get_registry_value(REG_PROVIDER.to_string()).ok().flatten())
}

fn read_model() -> Option<String> {
    get_registry_value(REG_MODEL.to_string())
        .ok()
        .flatten()
        .and_then(|value| normalize_model(Some(value)).ok().flatten())
}

fn read_ai_config() -> AiConfig {
    let provider = read_provider();
    let executable = match provider {
        AiProvider::Claude => find_claude(),
        AiProvider::Codex => find_codex(),
    };
    AiConfig { provider, model: read_model(), executable }
}

fn normalize_model(model: Option<String>) -> Result<Option<String>, String> {
    let model = model.unwrap_or_default().trim().to_string();
    if model.is_empty() || model.eq_ignore_ascii_case("default") {
        return Ok(None);
    }
    if model.len() > 120
        || !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
    {
        return Err("모델 ID에는 영문, 숫자, -, _, ., /, :만 사용할 수 있습니다.".to_string());
    }
    Ok(Some(model))
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
           AND (color IN (?2, ?3) OR (is_deleted = 0 AND type IN ('manual_todo', 'desktopcal_memo')))
         ORDER BY 1
         LIMIT 150",
    ) {
        Ok(s) => s,
        Err(_) => return "(조회 실패)".to_string(),
    };
    let rows = stmt.query_map(rusqlite::params![today, AI_COLOR, DOC_COLOR], |r| {
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
            let source = if is_ai_color(color.as_deref()) {
                match ref_id {
                    Some(r) if r.starts_with("doc-") => format!("AI({})", r),
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

/// codex 실행 파일 경로 탐색: 레지스트리 override → `where codex` → 공통 경로.
fn find_codex() -> Option<PathBuf> {
    if let Ok(Some(p)) = get_registry_value(REG_CODEX_PATH.to_string()) {
        let pb = PathBuf::from(p.trim());
        if pb.exists() { return Some(pb); }
    }
    find_on_windows_path("codex").or_else(|| find_common_cli("codex"))
}

fn claude_fallback_models() -> Vec<BriefingModelOption> {
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
fn list_claude_models(claude: &PathBuf) -> Result<Vec<BriefingModelOption>, String> {
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

fn parse_claude_model_response(value: &serde_json::Value) -> Result<Vec<BriefingModelOption>, String> {
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
fn list_codex_models(codex: &PathBuf) -> Result<Vec<BriefingModelOption>, String> {
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

fn parse_codex_model_response(value: &serde_json::Value) -> Result<Vec<BriefingModelOption>, String> {
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
fn find_on_windows_path(command: &str) -> Option<PathBuf> {
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
fn find_on_windows_path(_command: &str) -> Option<PathBuf> { None }

fn find_common_cli(name: &str) -> Option<PathBuf> {
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
fn is_auth_error(msg: &str) -> bool {
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
fn is_authed(provider: AiProvider) -> bool {
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
    fn detects_cli_auth_errors() {
        assert!(is_auth_error("Claude Code 오류: Failed to authenticate: OAuth session expired and could not be refreshed"));
        assert!(is_auth_error("Invalid API key · Please run /login"));
        assert!(is_auth_error("error: Not logged in. Run `codex login`"));
        assert!(!is_auth_error("Claude Code 출력(JSON 봉투) 파싱 실패: EOF"));
        assert!(!is_auth_error("시간 초과(240초)"));
    }

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
    fn provider_defaults_to_claude_and_accepts_codex() {
        assert_eq!(AiProvider::from_saved(None), AiProvider::Claude);
        assert_eq!(AiProvider::from_saved(Some("codex".to_string())), AiProvider::Codex);
        assert_eq!(AiProvider::from_saved(Some("unknown".to_string())), AiProvider::Claude);
    }

    #[test]
    fn model_normalization_supports_cli_model_ids() {
        assert_eq!(normalize_model(None).unwrap(), None);
        assert_eq!(normalize_model(Some(" default ".to_string())).unwrap(), None);
        assert_eq!(
            normalize_model(Some(" gpt-5.3-codex ".to_string())).unwrap().as_deref(),
            Some("gpt-5.3-codex")
        );
        assert!(normalize_model(Some("model; rm".to_string())).is_err());
    }

    #[test]
    fn parses_items_from_plain_agent_result() {
        let items = parse_items_from_result(
            "```json\n[{\"source_message_id\":42,\"title\":\"회의\",\"date\":\"2026-09-20\"}]\n```",
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_message_id, Some(42));
    }

    #[test]
    fn parses_empty_structured_output_as_no_schedule() {
        let items = parse_items_from_result("[]").unwrap();
        assert!(items.is_empty());

        let items = parse_items_from_result(r#"{"items":[]}"#).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn parses_visible_models_from_codex_app_server() {
        let response = serde_json::json!({
            "id": 2,
            "result": { "data": [
                { "id": "gpt-5.6-luna", "model": "gpt-5.6-luna", "displayName": "GPT-5.6-Luna", "description": "Fast", "hidden": false, "isDefault": false },
                { "id": "hidden-model", "model": "hidden-model", "hidden": true }
            ] }
        });
        let models = parse_codex_model_response(&response).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.6-luna");
        assert_eq!(models[0].label, "GPT-5.6-Luna");
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

    #[test]
    fn doc_no_requires_official_header() {
        let body = "○○교육청
수신 수신자 참조
제목 2026학년도 학업성적관리 규정 제출
시행 교육과정과-12345 (2026. 10. 1.)";
        assert_eq!(extract_doc_no(body).as_deref(), Some("교육과정과-12345"));
        // 붙임(계획서 등): 수신/제목/시행 줄이 없으면 공문 본문이 아니다.
        assert_eq!(extract_doc_no("2026 운영 계획
1. 목적
2. 일정"), None);
        // 결재 전 초안 번호(@N)는 숫자가 아니므로 제외.
        assert_eq!(extract_doc_no("수신 내부결재
제목 x
시행 교무부-@N"), None);
    }

    #[test]
    fn doc_items_get_doc_reference_and_original() {
        let item = ExtractedItem {
            id: Some("doc-교육과정과-12345".into()),
            source_doc_id: Some(3),
            title: Some("규정 제출".into()),
            date: Some("2099-01-02".into()),
            reference: Some("doc-교육과정과-12345".into()),
            source_label: Some("공문 교육과정과-12345".into()),
            ..Default::default()
        };
        let sched = to_schedule_item(&item, None, Some("<div>본문</div>")).unwrap();
        assert_eq!(sched.reference_id.as_deref(), Some("doc-교육과정과-12345"));
        let content = sched.content.unwrap();
        assert!(content.contains("출처: 공문 교육과정과-12345"));
        assert!(content.contains("<div>본문</div>"));
        assert_eq!(doc_key("a/b c-1"), "doc-a_b_c-1");
        assert_eq!(sched.color.as_deref(), Some(DOC_COLOR));
        assert!(is_ai_color(Some("#f59e0b")) && is_ai_color(Some(AI_COLOR)) && !is_ai_color(None));

        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 19);
        let past = ExtractedItem { date: Some("2026-10-01".into()), ..Default::default() };
        let future = ExtractedItem { date: Some("2026-10-20".into()), ..Default::default() };
        assert!(is_past_item(&past, today) && !is_past_item(&future, today));
        assert!(!is_past_item(&ExtractedItem::default(), today));
    }

    #[test]
    fn claude_models_parse_marks_default_and_drops_default_entry() {
        let v = serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"models":[
            {"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default"},
            {"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"d"},
            {"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet 5.5"}
        ]}}});
        let m = parse_claude_model_response(&v).unwrap();
        assert_eq!(m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["opus", "sonnet"]);
        assert!(m[0].is_default && !m[1].is_default);
        let err = serde_json::json!({"type":"control_response","response":{"subtype":"error","error":"boom"}});
        assert!(parse_claude_model_response(&err).is_err());
    }

    /// 실제 설치된 CLI 로 모델 목록을 읽는다: cargo test --lib live_model_lists -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_model_lists() {
        let claude = find_claude().expect("claude 없음");
        let t = Instant::now();
        let cm = list_claude_models(&claude).expect("claude 모델 조회 실패");
        println!("claude {:?} {}개 {:?}", claude, cm.len(), t.elapsed());
        for m in &cm { println!("  {}{} | {}", m.id, if m.is_default { " (기본)" } else { "" }, m.label); }
        let codex = find_codex().expect("codex 없음");
        let t = Instant::now();
        let xm = list_codex_models(&codex).expect("codex 모델 조회 실패");
        println!("codex {:?} {}개 {:?}", codex, xm.len(), t.elapsed());
        for m in &xm { println!("  {}{} | {}", m.id, if m.is_default { " (기본)" } else { "" }, m.label); }
        assert!(!cm.is_empty() && !xm.is_empty());
    }
}
