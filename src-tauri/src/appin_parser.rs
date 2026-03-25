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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppinSlot {
    pub subject: Option<usize>,
    pub teacher: Option<usize>,
    pub room: Option<usize>,
}

fn parse_daily(body_text: &str) -> HashMap<usize, HashMap<usize, AppinSlot>> {
    let mut tt = HashMap::new();
    for sec in body_text.split('{').skip(1) {
        let fields: Vec<&str> = sec.split(',').collect();
        if fields.len() < 3 { continue; }
        let cls: usize = match fields[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        
        let mut periods = HashMap::new();
        let max_p = std::cmp::min(9, fields.len() - 2);
        for pi in 0..max_p {
            let pd = fields[pi+2];
            if pd.trim().is_empty() { continue; }
            let mut slot = AppinSlot { subject: None, teacher: None, room: None };
            
            let mut core = pd.split('|').next().unwrap_or("");
            if core.contains('>') {
                core = core.splitn(2, '>').nth(1).unwrap_or(core);
            }
            
            if core.contains('(') {
                let mut sp = core.splitn(2, '(');
                let subj_part = sp.next().unwrap_or("");
                let rest_part = sp.next().unwrap_or("");
                
                if let Ok(v) = subj_part.parse::<usize>() {
                    if v > 0 { slot.subject = Some(v - 1); }
                }
                
                if rest_part.contains('\\') {
                    let mut rp = rest_part.splitn(2, '\\');
                    let tch_part = rp.next().unwrap_or("");
                    let rm_part = rp.next().unwrap_or("");
                    
                    if let Ok(v) = tch_part.parse::<usize>() {
                        if v > 0 { slot.teacher = Some(v - 1); }
                    }
                    if let Ok(v) = rm_part.parse::<usize>() {
                        if v > 0 { slot.room = Some(v - 1); }
                    }
                } else {
                    if let Ok(v) = rest_part.parse::<usize>() {
                        if v > 0 { slot.teacher = Some(v - 1); }
                    }
                }
            } else if !core.trim().is_empty() {
                if let Ok(v) = core.parse::<usize>() {
                    if v > 0 { slot.subject = Some(v - 1); }
                }
            }
            
            if slot.subject.is_some() || slot.teacher.is_some() || slot.room.is_some() {
                periods.insert(pi + 1, slot);
            }
        }
        tt.insert(cls, periods);
    }
    tt
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppinTimetableData {
    pub teachers: Vec<String>,
    pub subjects: Vec<String>,
    pub classes: Vec<String>,
    pub days: HashMap<String, HashMap<String, HashMap<String, AppinSlot>>>, // Date -> Class -> Period -> Slot
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
    
    let base = NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
    let mut days_map = HashMap::new();
    
    for ri in 8..records.len() {
        let d = base + ChronoDuration::try_days((ri as i64) - 9).unwrap();
        if d.weekday().number_from_monday() >= 6 { continue; } // Exclude Sat/Sun
        
        let body = decrypt_text(&records[ri]);
        let tt = parse_daily(&body);
        if tt.is_empty() { continue; }
        
        let mut day_classes = HashMap::new();
        for (&ci, periods) in &tt {
            if ci == 0 || ci > classes.len() { continue; }
            let mut str_periods = HashMap::new();
            for (&p, s) in periods {
                str_periods.insert(p.to_string(), s.clone());
            }
            day_classes.insert(classes[ci - 1].clone(), str_periods);
        }
        
        days_map.insert(d.format("%Y-%m-%d").to_string(), day_classes);
    }
    
    Ok(AppinTimetableData {
        teachers,
        subjects,
        classes,
        days: days_map,
    })
}

#[tauri::command]
pub fn get_appin_timetable_data() -> Result<AppinTimetableData, String> {
    parse_appin_timetable()
}
