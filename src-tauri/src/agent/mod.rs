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

mod debug;
pub mod content;
mod pass;
mod activity;
mod docs;
pub mod backfill;
mod cli;
mod register;
mod dedup;
mod util;

use self::{debug::*, content::*, pass::*, activity::*, docs::*, cli::*, register::*, dedup::*, util::*};

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
