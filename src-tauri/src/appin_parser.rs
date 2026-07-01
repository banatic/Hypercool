use std::fs;
use std::path::Path;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use chrono::{NaiveDate, Datelike, Duration as ChronoDuration};
use encoding_rs::EUC_KR;

const XOR_KEY: &[u8] = b"7n1bmu";

fn decrypt_bytes(raw: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(raw.len());
    for (i, &byte) in raw.iter().enumerate() {
        if byte > 0x20 {
            let dec = byte ^ XOR_KEY[i % 6];
            if dec > 0x20 {
                result.push(dec);
            } else {
                result.push(byte);
            }
        } else {
            result.push(byte);
        }
    }
    result
}

fn decrypt_text(raw: &[u8]) -> String {
    let dec = decrypt_bytes(raw);
    String::from_utf8_lossy(&dec).into_owned()
}

fn load_dat(filepath: &Path) -> Result<Vec<Vec<u8>>, String> {
    let content = fs::read(filepath).map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    let mut current = Vec::new();

    let mut i = 0;
    while i < content.len() {
        if i + 1 < content.len() && content[i] == 0x0D && content[i+1] == 0x0A {
            records.push(current);
            current = Vec::new();
            i += 2;
        } else {
            current.push(content[i]);
            i += 1;
        }
    }
    records.push(current);

    Ok(records)
}

fn parse_meta(rec_bytes: &[u8]) -> &[u8] {
    if let Some(pos) = rec_bytes.iter().position(|&b| b == 0x20) {
        &rec_bytes[pos+1..]
    } else {
        rec_bytes
    }
}

fn decode_euc_kr(bytes: &[u8]) -> String {
    let (cow, _, _) = EUC_KR.decode(bytes);
    cow.into_owned()
}

fn parse_subjects(records: &[Vec<u8>]) -> Vec<String> {
    let dec = decrypt_bytes(&records[3]);
    let body = parse_meta(&dec);
    let mut subjects = Vec::new();

    for item in body.split(|&b| b == b',') {
        if let Some(pos) = item.iter().position(|&b| b == 0x5e) {
            let mut name = decode_euc_kr(&item[..pos]);
            name = name.trim_matches(|c| c == '\x00' || c == '\x06').to_string();
            if name.is_empty() {
                subjects.push(format!("(S{})", subjects.len()));
            } else {
                subjects.push(name);
            }
        } else {
             subjects.push(decode_euc_kr(item).replace('\x00', ""));
        }
    }
    subjects
}

fn parse_teachers(records: &[Vec<u8>]) -> Vec<String> {
    let dec = decrypt_bytes(&records[4]);
    let body = parse_meta(&dec);
    let mut teachers = Vec::new();

    for item in body.split(|&b| b == b',') {
        if let Some(pos) = item.iter().position(|&b| b == 0x5e) {
            let name = decode_euc_kr(&item[..pos]).replace('\x00', "");
            teachers.push(name);
        }
    }
    teachers
}

fn parse_classes(records: &[Vec<u8>]) -> Vec<String> {
    let dec = decrypt_bytes(&records[5]);
    let body_bytes = parse_meta(&dec);
    let body_str = decode_euc_kr(body_bytes);

    let mut classes = Vec::new();
    for item in body_str.split(',') {
        let parts: Vec<&str> = item.split('^').collect();
        if parts.len() > 1 {
            let class_part = parts[1].split('@').next().unwrap_or("").trim();
            if !class_part.is_empty() {
                classes.push(class_part.to_string());
            }
        }
    }
    classes
}

// record 1 (#hensa) — 1-based 행사명 카탈로그
fn parse_events(records: &[Vec<u8>]) -> Vec<String> {
    if records.len() < 2 { return Vec::new(); }
    let dec = decrypt_bytes(&records[1]);
    let body_bytes = parse_meta(&dec);
    let body_str = decode_euc_kr(body_bytes);
    let mut events = Vec::new();
    for item in body_str.split(',') {
        let parts: Vec<&str> = item.split('^').collect();
        let name = if parts.len() >= 2 { parts[1] } else { parts[0] };
        events.push(name.trim_matches(|c: char| c == '\x00' || c == '\x06').trim().to_string());
    }
    events
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppinSlot {
    pub subject: Option<usize>,
    pub teacher: Option<usize>,
    pub room: Option<usize>,
}

fn parse_leading_usize(s: &str) -> Option<usize> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

// "<digits>*..." 또는 "~<digits>*..." 형태에서 행사 인덱스 추출
fn extract_event_idx(core: &str) -> Option<usize> {
    let s = core.strip_prefix('~').unwrap_or(core);
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { return None; }
    let rest = &s[digits.len()..];
    if rest.starts_with('*') {
        digits.parse().ok()
    } else {
        None
    }
}

struct DailyParse {
    // class_idx -> period -> AppinSlot (정상 슬롯만)
    timetable: HashMap<usize, HashMap<usize, AppinSlot>>,
    // class_idx -> 행사 인덱스 (1-based) — 슬롯 prefix에서 발견된 가장 빈도 높은 값
    class_events: HashMap<usize, usize>,
}

fn parse_daily(body_text: &str) -> DailyParse {
    let mut tt: HashMap<usize, HashMap<usize, AppinSlot>> = HashMap::new();
    let mut class_events: HashMap<usize, usize> = HashMap::new();

    for sec in body_text.split('{').skip(1) {
        let fields: Vec<&str> = sec.split(',').collect();
        if fields.len() < 3 { continue; }
        let cls: usize = match fields[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mut periods: HashMap<usize, AppinSlot> = HashMap::new();
        let mut event_counts: HashMap<usize, u32> = HashMap::new();
        let max_p = std::cmp::min(9, fields.len() - 2);

        for pi in 0..max_p {
            let pd = fields[pi+2];
            if pd.trim().is_empty() { continue; }

            // Strip trailing "|metadata" (date/marker info)
            let mut core = pd.split('|').next().unwrap_or("");
            // "orig>new" substitution form — take the new value
            if core.contains('>') {
                core = core.splitn(2, '>').nth(1).unwrap_or(core);
            }

            // <eventIdx>* prefix 인지 — 정상 슬롯 등록에서 제외하고 행사 카운트만 누적
            if let Some(ev) = extract_event_idx(core) {
                *event_counts.entry(ev).or_insert(0) += 1;
                continue;
            }

            let mut slot = AppinSlot { subject: None, teacher: None, room: None };

            if core.contains('(') {
                let mut sp = core.splitn(2, '(');
                let subj_part = sp.next().unwrap_or("");
                let rest_part = sp.next().unwrap_or("");

                if let Some(v) = parse_leading_usize(subj_part) {
                    if v > 0 { slot.subject = Some(v - 1); }
                }

                if rest_part.contains('\\') {
                    let mut rp = rest_part.splitn(2, '\\');
                    let tch_part = rp.next().unwrap_or("");
                    let rm_part = rp.next().unwrap_or("");

                    if let Some(v) = parse_leading_usize(tch_part) {
                        if v > 0 { slot.teacher = Some(v - 1); }
                    }
                    if let Some(v) = parse_leading_usize(rm_part) {
                        if v > 0 { slot.room = Some(v - 1); }
                    }
                } else {
                    if let Some(v) = parse_leading_usize(rest_part) {
                        if v > 0 { slot.teacher = Some(v - 1); }
                    }
                }
            } else if !core.trim().is_empty() {
                if let Some(v) = parse_leading_usize(core) {
                    if v > 0 { slot.subject = Some(v - 1); }
                }
            }

            if slot.subject.is_some() || slot.teacher.is_some() || slot.room.is_some() {
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

    DailyParse { timetable: tt, class_events }
}

fn parse_header_grade_events(body_text: &str) -> [Option<usize>; 3] {
    let head = body_text.split('{').next().unwrap_or("");
    let fields: Vec<&str> = head.split(',').collect();
    let mut out: [Option<usize>; 3] = [None, None, None];
    for i in 0..3 {
        if let Some(field) = fields.get(i + 1) {
            if let Ok(v) = field.trim().parse::<usize>() {
                if v > 0 { out[i] = Some(v); }
            }
        }
    }
    out
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppinTimetableData {
    pub teachers: Vec<String>,
    pub subjects: Vec<String>,
    pub classes: Vec<String>,
    pub events: Vec<String>,
    pub days: HashMap<String, HashMap<String, HashMap<String, AppinSlot>>>, // Date -> Class -> Period -> Slot
    // Date -> Class -> 행사 라벨 (슬롯 prefix 기반)
    pub events_by_date_class: HashMap<String, HashMap<String, String>>,
    // Date -> [학년1, 학년2, 학년3] 행사 라벨 (헤더 기반 fallback)
    pub events_by_date_grade: HashMap<String, Vec<Option<String>>>,
}

pub fn parse_appin_timetable() -> Result<AppinTimetableData, String> {
    let fp = Path::new(r"C:\Program Files (x86)\압핀시간표\amc42.dat");
    if !fp.exists() {
        return Err("amc42.dat file not found".to_string());
    }

    let records = load_dat(fp)?;
    if records.len() < 10 {
        return Err("Invalid amc42.dat".to_string());
    }

    let subjects = parse_subjects(&records);
    let teachers = parse_teachers(&records);
    let classes = parse_classes(&records);
    let events = parse_events(&records);

    let event_label = |idx_1based: usize| -> Option<String> {
        if idx_1based == 0 || idx_1based > events.len() { return None; }
        let name = events[idx_1based - 1].trim();
        if name.is_empty() { None } else { Some(name.to_string()) }
    };

    let base = NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
    let mut days_map: HashMap<String, HashMap<String, HashMap<String, AppinSlot>>> = HashMap::new();
    let mut events_by_date_class: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut events_by_date_grade: HashMap<String, Vec<Option<String>>> = HashMap::new();

    for ri in 8..records.len() {
        let d = base + ChronoDuration::try_days((ri as i64) - 9).unwrap();
        if d.weekday().number_from_monday() >= 6 { continue; } // Exclude Sat/Sun

        let body = decrypt_text(&records[ri]);
        let header_events = parse_header_grade_events(&body);
        let parsed = parse_daily(&body);

        let date_str = d.format("%Y-%m-%d").to_string();

        // 학년별 행사 (헤더 기반 fallback)
        let grade_events: Vec<Option<String>> = header_events
            .iter()
            .map(|e| e.and_then(|i| event_label(i)))
            .collect();
        if grade_events.iter().any(|e| e.is_some()) {
            events_by_date_grade.insert(date_str.clone(), grade_events);
        }

        // 반별 행사 라벨
        let mut class_event_map: HashMap<String, String> = HashMap::new();
        for (&ci, &ev) in &parsed.class_events {
            if ci == 0 || ci > classes.len() { continue; }
            if let Some(label) = event_label(ev) {
                class_event_map.insert(classes[ci - 1].clone(), label);
            }
        }
        if !class_event_map.is_empty() {
            events_by_date_class.insert(date_str.clone(), class_event_map);
        }

        // 정상 슬롯
        if !parsed.timetable.is_empty() {
            let mut day_classes = HashMap::new();
            for (&ci, periods) in &parsed.timetable {
                if ci == 0 || ci > classes.len() { continue; }
                let mut str_periods = HashMap::new();
                for (&p, s) in periods {
                    str_periods.insert(p.to_string(), s.clone());
                }
                day_classes.insert(classes[ci - 1].clone(), str_periods);
            }
            days_map.insert(date_str.clone(), day_classes);
        }
    }

    Ok(AppinTimetableData {
        teachers,
        subjects,
        classes,
        events,
        days: days_map,
        events_by_date_class,
        events_by_date_grade,
    })
}

#[tauri::command]
pub fn get_appin_timetable_data() -> Result<AppinTimetableData, String> {
    parse_appin_timetable()
}
