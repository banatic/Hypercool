//! 날짜·교시·문자열 보조 함수.

pub(super) fn seoul_offset() -> chrono::FixedOffset {
    chrono::FixedOffset::east_opt(9 * 3600).unwrap()
}

pub(super) fn seoul_today() -> String {
    chrono::Utc::now()
        .with_timezone(&seoul_offset())
        .format("%Y-%m-%d")
        .to_string()
}

/// "YYYY-MM-DD" 또는 RFC3339/ISO 문자열에서 (KST 기준) 날짜를 뽑는다.
pub(super) fn parse_date_loose(s: &str) -> Option<chrono::NaiveDate> {
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

/// "N교시" → 시작 시각 "HH:MM"(utils::PERIOD_TIMES 기준). 1~7교시 외에는 None.
pub(super) fn period_to_start_time(period: &str) -> Option<String> {
    let n: u32 = period
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    let (start, _) = crate::utils::PERIOD_TIMES[crate::utils::period_table_index(n)?];
    Some(format!("{:02}:{:02}", start / 60, start % 60))
}

/// "HH:MM" 또는 "HH:MM~HH:MM"/"HH:MM-HH:MM"에서 시작 시각 "HH:MM"을 정규화.
pub(super) fn parse_start_time(s: &str) -> Option<String> {
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
pub(super) fn tail_chars(s: &str, n: usize) -> String {
    let s = s.trim();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        chars[chars.len() - n..].iter().collect()
    }
}

/// 문자열의 처음 n글자(초과 시 말줄임 표시).
pub(super) fn head_chars(s: &str, n: usize) -> String {
    let s = s.trim();
    let mut it = s.chars();
    let head: String = it.by_ref().take(n).collect();
    if it.next().is_some() {
        format!("{}…", head)
    } else {
        head
    }
}
