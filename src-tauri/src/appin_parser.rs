// 압핀시간표 amc42.dat 파서. 포맷 명세: docs/appin_amc42_format.md
// 레퍼런스 구현(왕복 검증 포함): scripts/appin_amc42.py
use std::fs;
use std::path::Path;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use chrono::{NaiveDate, Datelike, Duration as ChronoDuration};
use encoding_rs::EUC_KR;

const DAT_PATH: &str = r"C:\Program Files (x86)\압핀시간표\amc42.dat";
const XOR_KEY: &[u8] = b"7n1bmu";
// #hensa 종류 1 = 행사(교과수업병행): 행사 중에도 수업은 그대로 진행된다
const EVENT_KIND_WITH_CLASSES: u8 = 1;
const PERIODS_PER_DAY: usize = 9;

// 줄마다 키 위치가 0 부터 다시 시작한다. XOR 결과가 0x20 이하가 되는 바이트는 평문 그대로.
fn decrypt_bytes(raw: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(raw.len());
    for (i, &byte) in raw.iter().enumerate() {
        if byte > 0x20 {
            let dec = byte ^ XOR_KEY[i % 6];
            result.push(if dec > 0x20 { dec } else { byte });
        } else {
            result.push(byte);
        }
    }
    result
}

fn decode_euc_kr(bytes: &[u8]) -> String {
    let (cow, _, _) = EUC_KR.decode(bytes);
    cow.into_owned()
}

/// CRLF 로 나눈 뒤 줄 단위로 복호화·디코딩한 문자열 목록
fn load_lines(filepath: &Path) -> Result<Vec<String>, String> {
    let content = fs::read(filepath).map_err(|e| e.to_string())?;
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i + 1 < content.len() {
        if content[i] == 0x0D && content[i + 1] == 0x0A {
            lines.push(decode_euc_kr(&decrypt_bytes(&content[start..i])));
            i += 2;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < content.len() {
        lines.push(decode_euc_kr(&decrypt_bytes(&content[start..])));
    }
    Ok(lines)
}

/// "#tag 본문" 줄의 본문
fn tag_body<'a>(lines: &'a [String], tag: &str) -> Option<&'a str> {
    let prefix = format!("{} ", tag);
    lines.iter()
        .take_while(|l| l.starts_with('#'))
        .find_map(|l| l.strip_prefix(prefix.as_str()))
}

fn clean(s: &str) -> String {
    s.trim_matches(|c| c == '\x00' || c == '\x06').trim().to_string()
}

fn parse_subjects(body: &str) -> Vec<String> {
    body.split(',')
        .enumerate()
        .map(|(i, item)| {
            let name = clean(item.split('^').next().unwrap_or(""));
            if name.is_empty() { format!("(S{})", i) } else { name }
        })
        .collect()
}

// 교사 목록은 슬롯의 1-based 인덱스로 참조되므로 항목을 건너뛰면 안 된다.
// '^코드'가 없는 항목(코드 미부여 교사)도 자리를 차지하므로 그대로 유지한다.
// 빈 항목도 인덱스 자리를 지켜야 하므로 빈 문자열로 채운다 (UI에서 걸러짐)
fn parse_teachers(body: &str) -> Vec<String> {
    body.split(',').map(|item| clean(item.split('^').next().unwrap_or(""))).collect()
}

// "학년^학반명[*]@담임1[/담임2]^학생…" — 학반도 1-based 인덱스로 참조되므로 자리를 유지한다
fn parse_classes(body: &str) -> Vec<String> {
    body.split(',')
        .map(|item| {
            let rest = item.split_once('^').map(|(_, r)| r).unwrap_or(item);
            clean(rest.split('@').next().unwrap_or("").trim_end_matches('*'))
        })
        .collect()
}

/// #hensa "종류^이름" — (이름, 종류)
fn parse_events(body: &str) -> (Vec<String>, Vec<u8>) {
    body.split(',')
        .map(|item| match item.split_once('^') {
            Some((kind, name)) => (clean(name), kind.trim().parse().unwrap_or(0)),
            None => (clean(item), 0),
        })
        .unzip()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppinSlot {
    pub subject: Option<usize>,
    pub teacher: Option<usize>,
    pub room: Option<usize>,
    // 보강·교체로 교사가 바뀐 경우 원래 교사
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig_teacher: Option<usize>,
    // 결강 사유 (#gbsynames, 0-based)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absence: Option<usize>,
    // 결강 교사 ('#사유(교사'). 다른 수업을 옮겨와 보강한 경우 교사 변경 없이 여기에만 남는다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent_teacher: Option<usize>,
    // 다른 시간에서 옮겨온 수업이면 원래 위치 "YYYY-MM-DD/교시"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
    // 분반: 같은 학반·교시에 동시에 진행되는 나머지 수업
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<AppinSlot>,
}

impl AppinSlot {
    pub fn all(&self) -> impl Iterator<Item = &AppinSlot> {
        std::iter::once(self).chain(self.extra.iter())
    }
}

/// 셀 문법: [블록 '>'] ['~'] [행사 '*'] 수업 ('/' 수업)* ['<' 일.교시]* ['|' 묶음]
/// 수업:    과목 '(' 교사 ['#' 사유 ['(' 결강교사]] ['\' 특별실], 각 값은 [원 '+'] [새]
struct Cell {
    event: usize,
    entries: Vec<AppinSlot>,
    // '<일.교시' 원래 위치 (없으면 자기 자리)
    origin: Option<(i64, usize)>,
}

/// 1-based 번호 문자열 → 0-based. 0·빈 값 = None
fn index_of(s: &str) -> Option<usize> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<usize>().ok().filter(|&v| v > 0).map(|v| v - 1)
}

/// "원+새" 에서 현재 값(새). 원만 있고 '+' 가 없으면 변경 없음
fn current_index(part: &str) -> Option<usize> {
    index_of(part.rsplit_once('+').map(|(_, n)| n).unwrap_or(part))
}

/// "원+새" 에서 원래 값. 바뀌지 않았으면 None
fn changed_from(part: &str) -> Option<usize> {
    let (orig, new) = part.rsplit_once('+')?;
    let orig = index_of(orig);
    if orig == index_of(new) { None } else { orig }
}

fn parse_cell(raw: &str) -> Cell {
    let mut s = raw;
    if let Some((_, rest)) = s.split_once('>') { s = rest; }   // 선택과목 군 번호
    let unfixed = s.replacen('~', "", 1);                        // 고정 표시
    let mut s = unfixed.as_str();
    let mut event = 0;
    if let Some((ev, rest)) = s.split_once('*') {
        event = ev.parse().unwrap_or(0);
        s = rest;
    }
    if let Some((body, _)) = s.split_once('|') { s = body; }   // 동시수업 묶음
    let mut origin = None;
    if let Some((body, hist)) = s.split_once('<') {             // 원래 위치 이력
        s = body;
        origin = hist.split('<').next()
            .and_then(|o| o.split_once('.'))
            .and_then(|(d, p)| Some((d.parse().ok()?, p.parse().ok()?)));
    }

    let entries = s.split('/')
        .filter(|e| !e.is_empty())
        .map(|e| {
            let (e, room) = e.split_once('\\').unwrap_or((e, ""));
            let (e, absence) = e.split_once('#').unwrap_or((e, ""));  // '#사유(결강교사'
            let (absence, absent_teacher) = absence.split_once('(').unwrap_or((absence, ""));
            let (subj, tch) = e.split_once('(').unwrap_or((e, ""));
            AppinSlot {
                subject: current_index(subj),
                teacher: current_index(tch),
                room: current_index(room),
                orig_teacher: changed_from(tch),
                absence: index_of(absence),
                absent_teacher: index_of(absent_teacher),
                ..Default::default()
            }
        })
        .filter(|slot| slot.subject.is_some() || slot.teacher.is_some() || slot.room.is_some())
        .collect();
    Cell { event, entries, origin }
}

struct DailyParse {
    // class_idx(1-based) -> period -> AppinSlot (수업이 있는 칸만)
    timetable: HashMap<usize, HashMap<usize, AppinSlot>>,
    // class_idx -> 행사 인덱스 (1-based) — 수업을 대체하는 행사 셀 중 가장 빈도 높은 값
    class_events: HashMap<usize, usize>,
    // 그날 모든 학반의 모든 칸이 수업 대신 행사면 그 행사 (1-based). 헤더 G1..G3 는
    // 체육대회·방학식처럼 하루를 다 쓰는 행사를 빠뜨리므로 칸 기준으로 판정한다
    full_day_event: Option<usize>,
}

// "{학반,X,c1,…,c9" 반복. 행사 셀도 원래 수업이 뒤에 남아 있으므로
// 수업을 대체하는 행사(종류 2~5)일 때만 수업 대신 행사로 집계한다.
fn parse_daily(sections: &str, event_kinds: &[u8], day_no: i64, start: NaiveDate) -> DailyParse {
    let mut tt: HashMap<usize, HashMap<usize, AppinSlot>> = HashMap::new();
    let mut class_events: HashMap<usize, usize> = HashMap::new();
    let mut day_events: HashMap<usize, u32> = HashMap::new();
    let (mut total_cells, mut event_cells) = (0u32, 0u32);

    for sec in sections.split('{').skip(1) {
        let fields: Vec<&str> = sec.split(',').collect();
        let cls: usize = match fields[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mut periods: HashMap<usize, AppinSlot> = HashMap::new();
        let mut event_counts: HashMap<usize, u32> = HashMap::new();

        for (pi, raw) in fields.iter().skip(2).take(PERIODS_PER_DAY).enumerate() {
            if raw.is_empty() { continue; }
            let cell = parse_cell(raw);
            total_cells += 1;
            let replaces_class = cell.event > 0
                && event_kinds.get(cell.event - 1).copied() != Some(EVENT_KIND_WITH_CLASSES);
            if replaces_class {
                *event_counts.entry(cell.event).or_insert(0) += 1;
                *day_events.entry(cell.event).or_insert(0) += 1;
                event_cells += 1;
                continue;
            }
            let moved_from = cell.origin
                .filter(|&o| o != (day_no, pi + 1) && o.0 >= 1)
                .map(|(d, p)| format!("{}/{}", (start + ChronoDuration::days(d - 1)).format("%Y-%m-%d"), p));
            let mut entries = cell.entries.into_iter().map(|mut e| {
                e.moved_from = moved_from.clone();
                e
            });
            if let Some(mut slot) = entries.next() {
                slot.extra = entries.collect();
                periods.insert(pi + 1, slot);
            }
        }

        if !periods.is_empty() {
            tt.insert(cls, periods);
        }
        if let Some((&ev, _)) = event_counts.iter().max_by_key(|&(_, c)| *c) {
            class_events.insert(cls, ev);
        }
    }

    let full_day_event = (total_cells > 0 && event_cells == total_cells)
        .then(|| day_events.iter().max_by_key(|&(_, c)| *c).map(|(&ev, _)| ev))
        .flatten();
    DailyParse { timetable: tt, class_events, full_day_event }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppinTimetableData {
    pub teachers: Vec<String>,
    pub subjects: Vec<String>,
    pub classes: Vec<String>,
    pub events: Vec<String>,
    pub rooms: Vec<String>,
    // #gbsynames 결강 사유 (출장, 연가, 병가 …)
    pub absences: Vec<String>,
    pub days: HashMap<String, HashMap<String, HashMap<String, AppinSlot>>>, // Date -> Class -> Period -> Slot
    // Date -> Class -> 행사 라벨 (슬롯 prefix 기반)
    pub events_by_date_class: HashMap<String, HashMap<String, String>>,
    // Date -> [학년1, 학년2, 학년3] 행사 라벨 (헤더 기반 fallback)
    pub events_by_date_grade: HashMap<String, Vec<Option<String>>>,
    // Date -> 학교 전체가 하루 종일 행사인 날의 행사 라벨 (공휴일·방학·체육대회 등)
    pub full_day_events: HashMap<String, String>,
    // Date -> Period -> [시작 "HH:MM", 종료 "HH:MM"] (#sjp 시정표, 평일만)
    pub period_times: HashMap<String, HashMap<String, [String; 2]>>,
}

/// #sjp: 설정 12자 뒤로 일련일마다 9교시 × "HHMMHHMM"
fn parse_period_times(sjp: &str, start: NaiveDate, n_days: i64) -> HashMap<String, HashMap<String, [String; 2]>> {
    let bytes = sjp.as_bytes();
    let hhmm = |b: &[u8]| format!("{}:{}", String::from_utf8_lossy(&b[0..2]), String::from_utf8_lossy(&b[2..4]));
    let mut out = HashMap::new();
    for n in 0..n_days {
        let d = start + ChronoDuration::days(n);
        if d.weekday().number_from_monday() >= 6 { continue; }
        let mut day = HashMap::new();
        for p in 0..PERIODS_PER_DAY {
            let off = 12 + (n as usize * PERIODS_PER_DAY + p) * 8;
            let Some(b) = bytes.get(off..off + 8) else { break };
            if b.iter().all(|c| c.is_ascii_digit()) {
                day.insert((p + 1).to_string(), [hhmm(&b[0..4]), hhmm(&b[4..8])]);
            }
        }
        if !day.is_empty() {
            out.insert(d.format("%Y-%m-%d").to_string(), day);
        }
    }
    out
}

pub fn parse_appin_timetable() -> Result<AppinTimetableData, String> {
    let fp = Path::new(DAT_PATH);
    if !fp.exists() {
        return Err("amc42.dat file not found".to_string());
    }

    let lines = load_lines(fp)?;
    let missing = |tag: &str| format!("Invalid amc42.dat: {} 없음", tag);

    // "#hnd 학년도,2학기시작(TDateTime),플래그" — 학년도는 3/1 ~ 다음해 2월 말일
    let hnd = tag_body(&lines, "#hnd").ok_or_else(|| missing("#hnd"))?;
    let year: i32 = hnd.split(',').next().and_then(|y| y.trim().parse().ok())
        .ok_or("Invalid amc42.dat: 학년도")?;
    let start = NaiveDate::from_ymd_opt(year, 3, 1).ok_or("Invalid amc42.dat: 학년도")?;
    let n_days = (NaiveDate::from_ymd_opt(year + 1, 3, 1).unwrap() - start).num_days();

    let subjects = parse_subjects(tag_body(&lines, "#sbjnames").ok_or_else(|| missing("#sbjnames"))?);
    let teachers = parse_teachers(tag_body(&lines, "#tcrnames").ok_or_else(|| missing("#tcrnames"))?);
    let classes = parse_classes(tag_body(&lines, "#clsnames").ok_or_else(|| missing("#clsnames"))?);
    let (events, event_kinds) = parse_events(tag_body(&lines, "#hensa").unwrap_or(""));
    let absences: Vec<String> = tag_body(&lines, "#gbsynames")
        .map(|b| parse_events(b).0)
        .unwrap_or_default();
    let rooms: Vec<String> = tag_body(&lines, "#tbsnames")
        .map(|b| b.split(',').map(clean).collect())
        .unwrap_or_default();
    let period_times = tag_body(&lines, "#sjp")
        .map(|b| parse_period_times(b, start, n_days))
        .unwrap_or_default();

    // 수업을 대체하는 행사만 라벨로 쓴다 (교과수업병행 행사는 수업을 그대로 보여준다)
    let event_label = |idx_1based: usize| -> Option<String> {
        if idx_1based == 0 || idx_1based > events.len() { return None; }
        if event_kinds[idx_1based - 1] == EVENT_KIND_WITH_CLASSES { return None; }
        let name = events[idx_1based - 1].trim();
        if name.is_empty() { None } else { Some(name.to_string()) }
    };
    let class_name = |ci: usize| -> Option<&String> {
        if ci == 0 { None } else { classes.get(ci - 1) }
    };

    let mut days_map: HashMap<String, HashMap<String, HashMap<String, AppinSlot>>> = HashMap::new();
    let mut events_by_date_class: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut events_by_date_grade: HashMap<String, Vec<Option<String>>> = HashMap::new();
    let mut full_day_events: HashMap<String, String> = HashMap::new();

    // 일별 레코드: "일련일,G1,G2,G3,…{학반,X,c1..c9{…[:미배정]"
    for line in lines.iter().skip_while(|l| l.starts_with('#')) {
        let main = line.split(':').next().unwrap_or("");
        let (head, sections) = main.split_at(main.find('{').unwrap_or(main.len()));
        let head_fields: Vec<&str> = head.split(',').collect();
        let Some(day_no) = head_fields[0].trim().parse::<i64>().ok().filter(|&n| n >= 1 && n <= n_days) else {
            continue;
        };
        let d = start + ChronoDuration::days(day_no - 1);
        if d.weekday().number_from_monday() >= 6 { continue; } // Exclude Sat/Sun
        let date_str = d.format("%Y-%m-%d").to_string();

        // 학년별 하루 전체 행사 (헤더 G1..G3)
        let grade_events: Vec<Option<String>> = (1..=3)
            .map(|i| head_fields.get(i).and_then(|f| f.trim().parse().ok()).and_then(|v| event_label(v)))
            .collect();
        if grade_events.iter().any(|e| e.is_some()) {
            events_by_date_grade.insert(date_str.clone(), grade_events);
        }

        let parsed = parse_daily(sections, &event_kinds, day_no, start);
        if let Some(label) = parsed.full_day_event.and_then(|ev| event_label(ev)) {
            full_day_events.insert(date_str.clone(), label);
        }

        let class_event_map: HashMap<String, String> = parsed.class_events.iter()
            .filter_map(|(&ci, &ev)| Some((class_name(ci)?.clone(), event_label(ev)?)))
            .collect();
        if !class_event_map.is_empty() {
            events_by_date_class.insert(date_str.clone(), class_event_map);
        }

        let day_classes: HashMap<String, HashMap<String, AppinSlot>> = parsed.timetable.into_iter()
            .filter_map(|(ci, periods)| {
                let name = class_name(ci)?.clone();
                Some((name, periods.into_iter().map(|(p, s)| (p.to_string(), s)).collect()))
            })
            .collect();
        if !day_classes.is_empty() {
            days_map.insert(date_str, day_classes);
        }
    }

    Ok(AppinTimetableData {
        teachers,
        subjects,
        classes,
        events,
        rooms,
        absences,
        days: days_map,
        events_by_date_class,
        events_by_date_grade,
        full_day_events,
        period_times,
    })
}

#[tauri::command]
pub fn get_appin_timetable_data() -> Result<AppinTimetableData, String> {
    parse_appin_timetable()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(c: &Cell) -> (Option<usize>, Option<usize>, Option<usize>) {
        let e = &c.entries[0];
        (e.subject, e.teacher, e.room)
    }

    #[test]
    fn plain_and_room() {
        assert_eq!(slot(&parse_cell("4(28")), (Some(3), Some(27), None));
        assert_eq!(slot(&parse_cell("10(50\\1")), (Some(9), Some(49), Some(0)));
    }

    #[test]
    fn substitute_teacher_uses_new_value() {
        // 교사 20 → 22 보강, 결강 사유 5, 결강 교사 20
        let c = parse_cell("24(20+22#5(20");
        assert_eq!(slot(&c), (Some(23), Some(21), None));
        assert_eq!((c.entries[0].orig_teacher, c.entries[0].absence, c.entries[0].absent_teacher), (Some(19), Some(4), Some(19)));
        assert_eq!(parse_cell("4(28").entries[0].orig_teacher, None);
    }

    #[test]
    fn removed_values() {
        // 특별실 5 해제, 원래 위치 이력
        assert_eq!(slot(&parse_cell("4>20(46\\5+<6.1")), (Some(19), Some(45), None));
        // 과목 삭제
        assert!(parse_cell("5+(").entries.is_empty());
    }

    #[test]
    fn block_event_fixed_group() {
        let c = parse_cell("3>19*14(61|1");
        assert_eq!(c.event, 19);
        assert_eq!(slot(&c), (Some(13), Some(60), None));
        let c = parse_cell("~64(");
        assert_eq!(c.event, 0);
        assert_eq!(slot(&c), (Some(63), None, None));
        assert_eq!(parse_cell("~16*64(").event, 16);
    }

    #[test]
    fn split_class_entries() {
        let c = parse_cell("3(17/5(26\\2<10.1<10.5");
        assert_eq!(c.entries.len(), 2);
        assert_eq!((c.entries[1].subject, c.entries[1].teacher, c.entries[1].room), (Some(4), Some(25), Some(1)));
    }

    #[test]
    fn event_kind_decides_replacement() {
        // 행사 1 = 교과수업병행, 2 = 수업안함
        let kinds = [1u8, 2];
        let start = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let p = parse_daily("{1,0,1*3(5,2*3(5,3(5<4.2,,,,,,", &kinds, 6, start);
        let row = &p.timetable[&1];
        assert!(row.contains_key(&1) && !row.contains_key(&2) && row.contains_key(&3));
        assert_eq!(p.class_events[&1], 2);
        assert_eq!(p.full_day_event, None);
        let all = parse_daily("{1,0,2*3(5,2*4(6,,,,,,,{2,0,2*3(5,,,,,,,,", &kinds, 6, start);
        assert_eq!(all.full_day_event, Some(2));
        assert_eq!(row[&1].moved_from, None);
        assert_eq!(row[&3].moved_from.as_deref(), Some("2026-03-04/2"));
    }
}
