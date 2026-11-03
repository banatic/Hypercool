//! AI 추출 항목 → 일정 변환·검증·등록.

use super::*;

// ─── 등록 ─────────────────────────────────────────────────────────────────────

pub(super) fn register_items(
    app: &AppHandle,
    items: Vec<ExtractedItem>,
    today: &str,
) -> Result<(i64, i64, Vec<RegItem>), String> {
    register_items_core(app, items, today)
        .map(|(new_c, dedup_c, invalid_c, regs)| (new_c, dedup_c + invalid_c, regs))
}

/// 등록 시도 1건의 결과(활동 기록용).
pub(super) struct RegItem {
    /// 출처 참조(메시지 id 문자열 또는 doc-<문서번호>).
    pub(super) reference: Option<String>,
    pub(super) title: String,
    pub(super) date: Option<String>,
    pub(super) status: RegStatus,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RegStatus {
    New,
    Duplicate,
    /// 기한이 오늘보다 과거라 등록하지 않음.
    Past,
    /// 날짜 없음 등 검증 실패.
    Invalid,
}

impl RegStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Duplicate => "duplicate",
            Self::Past => "past",
            Self::Invalid => "invalid",
        }
    }
}

/// 항목의 달력 날짜(date → active_from → received_at)가 오늘보다 과거인지.
pub(super) fn is_past_item(item: &ExtractedItem, today: Option<chrono::NaiveDate>) -> bool {
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
pub(super) fn register_items_core(
    app: &AppHandle,
    items: Vec<ExtractedItem>,
    today: &str,
) -> Result<(i64, i64, i64, Vec<RegItem>), String> {
    register_items_opts(app, items, today, false)
}

/// `dry_run` 이면 DB 에 쓰지 않고 각 항목의 예상 결과만 돌려준다(소급 미리보기).
/// regs 는 입력 items 와 같은 순서·같은 개수다.
pub(super) fn register_items_opts(
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

/// ExtractedItem → db::ScheduleItem 변환 및 검증. 등록 불가(날짜 없음/과거)면 None.
/// `full_body`: 검색 DB에서 가져온 원문 메시지 전체(있으면 content 에 [원문]으로 첨부).
pub(super) fn to_schedule_item(
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
