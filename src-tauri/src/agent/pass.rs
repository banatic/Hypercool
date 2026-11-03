//! 메시지 1회 실행(run_pass)과 메시지용 프롬프트 생성.

use super::*;

/// run_pass 옵션.
pub(super) struct PassOpts {
    /// 프롬프트에 넣을 기준 id(이 값보다 큰 메시지만 신규). None 이면 저장된 last_seen 사용.
    pub(super) since_override: Option<i64>,
    /// 성공 시 저장된 last_seen_id 를 current_max 로 전진시킬지. 디버그 실행은 false.
    pub(super) advance: bool,
}

/// 실제 1회 실행: 선택한 AI 호출 → 파싱 → 검증 → 등록 → (옵션) last_seen 전진.
/// 반환: (신규 등록 수, skip 수). 실패 시 Err(사유) — last_seen 은 전진하지 않음.
pub(super) fn run_pass(app: &AppHandle, opts: &PassOpts) -> Result<(i64, i64), String> {
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

pub(super) fn notify_calendar_changed(app: &AppHandle) {
    // best-effort: 탁상달력에도 반영(실패 무시).
    if let Ok(Some(path)) = crate::db::detect_desktopcal() {
        let _ = crate::db::sync_to_desktopcal(app.clone(), path);
    }
    // 프론트가 loadSchedules + Firestore sync 를 돌리도록 알림.
    let _ = app.emit("calendar-update", ());
}

/// 메시지 분석: last_seen 기준 프롬프트로 AI 호출 → 항목. 반환: (항목, AI 원문 응답).
pub(super) fn analyze_messages(
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

/// 프롬프트 템플릿 치환: 오늘 날짜 + 기준 id + 기등록 일정 목록.
/// 기등록 일정을 주입해 claude 가 재전송·정정·표현만 다른 동일 업무를 의미 수준에서
/// 거를 수 있게 한다(등록 측의 내용 중복 백스톱과 이중 방어).
pub(super) fn build_prompt(app: &AppHandle, today: &str, since: i64) -> String {
    load_prompt_template(app)
        .replace("{{TODAY}}", today)
        .replace("{{LAST_SEEN_ID}}", &since.to_string())
        .replace("{{EXISTING_SCHEDULES}}", &existing_schedules_snippet(app, today))
}

/// 프롬프트에 주입할 "이미 등록된 일정" 목록. 오늘 이후 일정만:
/// - AI 생성분(color = AI_COLOR)은 삭제·완료된 것도 포함 — 사용자가 지운/끝낸 일정을
///   재전송 메시지로 되살리지 않도록 상태를 함께 보여준다.
/// - 수동 일정(manual_todo/desktopcal_memo)은 살아있는 것만.
pub(super) fn existing_schedules_snippet(app: &AppHandle, today: &str) -> String {
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
pub(super) fn load_prompt_template(app: &AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("briefing_prompt.md");
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    include_str!("../../resources/briefing_prompt.md").to_string()
}

/// search DB(hypercool_search.db)의 최대 메시지 id(=UDB MessageKey).
pub(super) fn current_max_message_id(app: &AppHandle) -> i64 {
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
