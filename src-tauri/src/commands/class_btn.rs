//! class-btn 오버레이: 메시지 수신자의 현재 교시 수업 상태.

use tauri::Manager;

use crate::utils::is_class_time;
use crate::{appin_parser, gif_watcher, timetable_parser};

/// 현재 교시의 시간표 인덱스(utils::PERIOD_TIMES 기준).
/// 점심은 None. 5교시 이후는 점심 슬롯을 건너뛰어 timetable 인덱스에 맞게 조정.
fn get_current_period() -> Option<usize> {
    use chrono::Timelike;
    use crate::utils::{LUNCH_INDEX, PERIOD_TIMES};
    let now = chrono::Local::now();
    let mins = now.hour() * 60 + now.minute();
    for (i, &(start, end)) in PERIOD_TIMES.iter().enumerate() {
        if mins >= start && mins <= end {
            if i == LUNCH_INDEX { return None; }
            return Some(if i < LUNCH_INDEX { i } else { i - 1 });
        }
    }
    None
}

fn parse_recipient_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() { return None; }
    let name = s.split('(').next()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[derive(serde::Serialize)]
pub struct RecipientStatus {
    pub name: String,
    pub subject: Option<String>,
    pub room: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ClassStatusResult {
    pub is_broadcast: bool,
    pub in_class_period: bool,
    pub current_period: Option<usize>,
    pub recipients: Vec<RecipientStatus>,
}

/// class-btn-N 레이블에서 슬롯 번호 파싱
fn parse_btn_slot(label: &str) -> Option<usize> {
    label.rsplit('-').next()?.parse().ok()
}

fn lookup_appin_subject(
    data: &appin_parser::AppinTimetableData,
    teacher_name: &str,
    period_idx: usize,
) -> (String, Option<String>) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let period_str = (period_idx + 1).to_string();
    let teacher_idx = match data.teachers.iter().position(|t| t == teacher_name) {
        Some(i) => i,
        None => return (String::new(), None),
    };
    let day_data = match data.days.get(&today) {
        Some(d) => d,
        None => return (String::new(), None),
    };
    for (class_name, period_map) in day_data {
        let Some(cell) = period_map.get(&period_str) else { continue };
        for slot in cell.all() {
            if slot.teacher == Some(teacher_idx) {
                let subject = slot.subject
                    .and_then(|si| data.subjects.get(si))
                    .cloned()
                    .unwrap_or_default();
                return (subject, if class_name.is_empty() { None } else { Some(class_name.clone()) });
            }
        }
    }
    (String::new(), None)
}

#[tauri::command]
pub fn get_class_status(btn_label: String, timetable_source: Option<String>) -> Result<ClassStatusResult, String> {
    let slot = parse_btn_slot(&btn_label).ok_or("invalid label")?;
    let hwnd_val = gif_watcher::get_slot_hwnd(slot).ok_or("not tracking")?;

    let raw = gif_watcher::extract_recipients(hwnd_val);
    let names: Vec<String> = raw.iter().filter_map(|t| parse_recipient_name(t)).collect();

    if names.len() >= 5 {
        return Ok(ClassStatusResult {
            is_broadcast: true,
            in_class_period: is_class_time(),
            current_period: None,
            recipients: Vec::new(),
        });
    }

    let current_period = get_current_period();
    let in_class_period = current_period.is_some();

    if !in_class_period || names.is_empty() {
        return Ok(ClassStatusResult {
            is_broadcast: false,
            in_class_period,
            current_period: None,
            recipients: names.iter().map(|n| RecipientStatus {
                name: n.clone(), subject: None, room: None,
            }).collect(),
        });
    }

    let period_idx = current_period.unwrap();
    use chrono::Datelike;
    let day_idx = match chrono::Local::now().weekday() {
        chrono::Weekday::Mon => 0usize,
        chrono::Weekday::Tue => 1,
        chrono::Weekday::Wed => 2,
        chrono::Weekday::Thu => 3,
        chrono::Weekday::Fri => 4,
        _ => {
            return Ok(ClassStatusResult {
                is_broadcast: false,
                in_class_period: true,
                current_period: Some(period_idx),
                recipients: names.iter().map(|n| RecipientStatus {
                    name: n.clone(), subject: None, room: None,
                }).collect(),
            });
        }
    };

    let use_appin = timetable_source.as_deref() == Some("appin");

    let recipients = if use_appin {
        let appin_data = appin_parser::parse_appin_timetable().ok();
        names.iter().map(|name| {
            let (subject, room) = appin_data.as_ref()
                .map(|d| lookup_appin_subject(d, name, period_idx))
                .unwrap_or((String::new(), None));
            RecipientStatus {
                name: name.clone(),
                subject: if subject.is_empty() { None } else { Some(subject) },
                room,
            }
        }).collect()
    } else {
        let timetable = match timetable_parser::parse_timetable() {
            Ok(t) => t,
            Err(_) => {
                return Ok(ClassStatusResult {
                    is_broadcast: false,
                    in_class_period: true,
                    current_period: Some(period_idx),
                    recipients: names.iter().map(|n| RecipientStatus {
                        name: n.clone(), subject: None, room: None,
                    }).collect(),
                });
            }
        };
        names.iter().map(|name| {
            let (subject, room) = timetable.timetables.get(name)
                .and_then(|tt| tt.get(period_idx))
                .and_then(|day_row| day_row.get(day_idx))
                .and_then(|cell| {
                    let subj = cell.first().filter(|s| !s.is_empty()).cloned()?;
                    let rm = cell.get(1).filter(|r| !r.is_empty()).cloned();
                    Some((subj, rm))
                })
                .unwrap_or((String::new(), None));
            RecipientStatus {
                name: name.clone(),
                subject: if subject.is_empty() { None } else { Some(subject) },
                room,
            }
        }).collect()
    };

    Ok(ClassStatusResult {
        is_broadcast: false,
        in_class_period: true,
        current_period: Some(period_idx),
        recipients,
    })
}

#[tauri::command]
pub fn resize_class_btn(app: tauri::AppHandle, label: String, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("window not found")?;
    win.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}
