//! 에듀파인 공문 분석 경로.

use super::*;

// ─── 공문 실행 ────────────────────────────────────────────────────────────────

/// 일정 추출 대상 공문(붙임 파일 등은 걸러진 뒤).
pub(super) struct DocInput {
    pub(super) doc_id: i64,
    pub(super) doc_no: String,
    pub(super) title: String,
    pub(super) viewed_date: String,
    pub(super) text: String,
}

pub(super) fn edufine_db_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_data_dir().ok()?.join("edufine_docs.db");
    path.exists().then_some(path)
}

/// 공문 본문의 문서번호("시행 교육과정과-1234 (2026. 10. 1.)" → "교육과정과-1234").
/// 붙임 파일(계획서·서식 등)에는 수신/제목/시행 줄이 없으므로, 없으면 공문 본문이 아닌 것으로 본다.
pub(super) fn extract_doc_no(content: &str) -> Option<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"시행\s+([^\s()]+-\d+)").unwrap());
    if !(content.contains("수신") && content.contains("제목")) {
        return None;
    }
    re.captures(content).map(|c| c[1].to_string())
}

/// 결정적 일정 id 용 문서번호 정규화(Firestore 문서 id 에 '/' 불가).
pub(super) fn doc_key(doc_no: &str) -> String {
    let key: String = doc_no
        .chars()
        .map(|c| if c.is_whitespace() || c == '/' { '_' } else { c })
        .collect();
    format!("doc-{}", key)
}

/// docs.detected_at(SQLite CURRENT_TIMESTAMP, UTC "YYYY-MM-DD HH:MM:SS") → 서울 기준 날짜.
pub(super) fn detected_to_seoul_date(detected_at: &str) -> String {
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
pub(super) fn doc_text_to_html(text: &str) -> String {
    head_chars(text, DOC_ORIGINAL_CHARS)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| format!("<div>{}</div>", html_escape(l)))
        .collect()
}

/// 저장된 공문 → 분석 대상. 붙임 파일은 빼고, 같은 문서번호가 여러 번 있으면(재열람) 마지막 것만 쓴다.
pub(super) fn docs_to_targets(docs: Vec<crate::edufine_db::EdufineDoc>) -> Vec<DocInput> {
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
pub(super) fn analyze_docs(
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

/// 새 공문 1회 처리. 공문은 열람 시점에 저장되므로 증분 기준은 docs.id.
pub(super) fn run_docs_pass(app: &AppHandle) -> Result<(i64, i64), String> {
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

pub(super) fn load_docs_prompt_template(app: &AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("briefing_docs_prompt.md");
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    include_str!("../../resources/briefing_docs_prompt.md").to_string()
}
