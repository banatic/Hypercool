//! 소급 실행(진단 탭): 미리보기 → 선택 항목만 반영.

use super::*;

// ─── 소급 실행(진단 탭) ───────────────────────────────────────────────────────
// 미리보기: 과거 메시지·저장된 공문을 AI 로 분석하되 DB 에 쓰지 않고 예상 결과만 보여준다.
// 반영: 미리보기에서 고른 항목만 등록한다(AI 재실행 없음). 자동 실행 진행 위치는 건드리지 않는다.

/// 소급 미리보기 최대 메시지 수(프롬프트·타임아웃 한계).
pub(super) const BACKFILL_MAX_MESSAGES: i64 = 50;
/// 소급 미리보기 최대 공문 수(DOCS_PER_PASS 단위로 나눠 실행).
pub(super) const BACKFILL_MAX_DOCS: usize = 20;

pub(super) struct BackfillStash {
    pub(super) id: u64,
    pub(super) source: String,
    pub(super) title: String,
    pub(super) items: Vec<ExtractedItem>,
}

pub(super) static BACKFILL: Mutex<Option<BackfillStash>> = Mutex::new(None);

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

pub(super) fn preview_backfill_locked(
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
