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

/// "N교시" → 시작 시각 "HH:MM"(학교 위젯 types.ts PERIOD_TIMES / main.rs get_current_period 과 동일).
/// 점심(인덱스 4)은 교시가 아니므로 5~7교시는 한 칸 밀어 인덱싱한다. 1~7교시 외에는 None.
pub(super) fn period_to_start_time(period: &str) -> Option<String> {
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
