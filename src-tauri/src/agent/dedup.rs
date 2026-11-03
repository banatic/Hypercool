//! 내용 기반 중복 판정(날짜 + 제목/원문 유사도).

use super::*;

// ─── 내용 기반 중복 판정 ──────────────────────────────────────────────────────

/// 중복 판정 키: 달력 날짜 + 정규화 제목 + 정규화 원문 + 출처 메시지 id.
pub(super) struct DedupKey {
    pub(super) date: String,
    pub(super) norm_title: String,
    pub(super) norm_body: String,
    pub(super) source_ref: Option<String>,
}

pub(super) fn dedup_key_for(sched: &crate::db::ScheduleItem) -> Option<DedupKey> {
    let date = sched.start_date.as_deref()?.get(..10)?.to_string();
    Some(DedupKey {
        date,
        norm_title: normalize_for_match(&sched.title),
        norm_body: normalized_original_body(sched.content.as_deref().unwrap_or("")),
        source_ref: sched.reference_id.clone(),
    })
}

/// 두 키가 "사실상 같은 일정"인지. `fuzzy` 가 false 면(수동 일정과 비교) 제목 완전 일치만 본다.
pub(super) fn keys_similar(a: &DedupKey, b: &DedupKey, fuzzy: bool) -> bool {
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
pub(super) fn find_semantic_duplicate(conn: &Connection, key: &DedupKey) -> Option<String> {
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
pub(super) fn normalized_original_body(content: &str) -> String {
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
pub(super) fn strip_html_tags(html: &str) -> String {
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
pub(super) fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 문자열의 숫자만 순서대로 추출(제목 속 학년·반·차수 구분용).
pub(super) fn digits_of(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// 문자 bigram Dice 유사도(0.0~1.0). 빈 문자열 또는 1글자 불일치면 0.0.
pub(super) fn bigram_dice(a: &str, b: &str) -> f64 {
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
