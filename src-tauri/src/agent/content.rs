//! AI 일정 content(원문 섹션) 재구성·마이그레이션과 쿨메신저 연결 상태.

use super::*;

/// 검색 DB에서 메시지 원문 HTML 조회. 정제/절단 없이 원문 전체를 그대로 반환한다.
/// 달력 위젯은 이 HTML 을 메시지 뷰어와 동일하게 렌더링하므로, 원문이 그대로 보여야 한다.
pub(super) fn fetch_message_html(app: &AppHandle, id: i64) -> Option<String> {
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
pub(super) fn rebuild_ai_content(old_content: &str, fresh_original_html: Option<&str>) -> String {
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
pub(super) fn is_ai_color(color: Option<&str>) -> bool {
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
pub(super) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 검색 DB에서 id > since 메시지 수.
pub(super) fn count_messages_since(app: &AppHandle, since: i64) -> i64 {
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
