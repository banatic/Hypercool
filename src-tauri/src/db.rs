use rusqlite::{params, Connection, Result};
use tauri::AppHandle;
use tauri::Manager;
use serde::{Serialize, Deserialize};
use chrono::{Utc, Datelike};
use crate::commands::system::{get_registry_value, set_registry_value};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleItem {
    pub id: String,
    #[serde(rename = "type")]
    pub schedule_type: String,
    pub title: String,
    pub content: Option<String>,
    #[serde(rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
    #[serde(rename = "isAllDay")]
    pub is_all_day: bool,
    #[serde(rename = "referenceId")]
    pub reference_id: Option<String>,
    pub color: Option<String>,
    #[serde(rename = "isCompleted")]
    pub is_completed: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "isDeleted")]
    pub is_deleted: bool,
}

#[derive(Deserialize)]
struct RegistryManualTodo {
    id: String,
    content: String,
    deadline: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "calendarTitle")]
    calendar_title: Option<String>,
    #[serde(rename = "isDeleted")]
    is_deleted: Option<bool>,
}

#[derive(Deserialize)]
struct RegistryPeriodSchedule {
    id: String,
    content: String,
    #[serde(rename = "startDate")]
    start_date: String,
    #[serde(rename = "endDate")]
    end_date: String,
    #[serde(rename = "calendarTitle")]
    calendar_title: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "isDeleted")]
    is_deleted: Option<bool>,
}

pub fn init_db(app: &AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }
    let db_path = app_dir.join("hypercool.db");
    
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tbl_schedules (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            start_date TEXT,
            end_date TEXT,
            is_all_day BOOLEAN NOT NULL DEFAULT 0,
            reference_id TEXT,
            color TEXT,
            is_completed BOOLEAN NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_deleted BOOLEAN NOT NULL DEFAULT 0
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("hypercool.db");
    Connection::open(db_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_schedules(app: AppHandle, start: String, end: String, include_deleted: Option<bool>) -> Result<Vec<ScheduleItem>, String> {
    let conn = get_connection(&app)?;
    get_schedules_impl(&conn, start, end, include_deleted.unwrap_or(false))
}

pub fn get_schedules_impl(conn: &Connection, start: String, end: String, include_deleted: bool) -> Result<Vec<ScheduleItem>, String> {
    let query_str = if include_deleted {
        "SELECT id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted 
         FROM tbl_schedules 
         WHERE (
            (start_date BETWEEN ?1 AND ?2) OR 
            (end_date BETWEEN ?1 AND ?2) OR
            (start_date <= ?1 AND end_date >= ?2)
         )"
    } else {
        "SELECT id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted 
         FROM tbl_schedules 
         WHERE is_deleted = 0 AND (
            (start_date BETWEEN ?1 AND ?2) OR 
            (end_date BETWEEN ?1 AND ?2) OR
            (start_date <= ?1 AND end_date >= ?2)
         )"
    };

    let mut stmt = conn.prepare(query_str).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![start, end], |row| {
        Ok(ScheduleItem {
            id: row.get(0)?,
            schedule_type: row.get(1)?,
            title: row.get(2)?,
            content: row.get(3)?,
            start_date: row.get(4)?,
            end_date: row.get(5)?,
            is_all_day: row.get(6)?,
            reference_id: row.get(7)?,
            color: row.get(8)?,
            is_completed: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            is_deleted: row.get(12)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut schedules = Vec::new();
    for row in rows {
        schedules.push(row.map_err(|e| e.to_string())?);
    }

    Ok(schedules)
}

fn trigger_desktopcal_sync(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(Some(db_path)) = detect_desktopcal() {
            // First import from DeskTopCal to ensure we have latest data
            let _ = import_desktopcal_db(app_handle.clone(), db_path.clone());
            // Then export our updates back to DeskTopCal
            let _ = sync_to_desktopcal(app_handle, db_path);
        }
    });
}

#[tauri::command]
pub fn create_schedule(app: AppHandle, item: ScheduleItem) -> Result<ScheduleItem, String> {
    let conn = get_connection(&app)?;
    let result = create_schedule_impl(&conn, item);
    if result.is_ok() {
        trigger_desktopcal_sync(&app);
    }
    result
}

pub fn create_schedule_impl(conn: &Connection, item: ScheduleItem) -> Result<ScheduleItem, String> {
    conn.execute(
        "INSERT INTO tbl_schedules (id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            item.id, item.schedule_type, item.title, item.content, item.start_date, item.end_date, 
            item.is_all_day, item.reference_id, item.color, item.is_completed, item.created_at, item.updated_at, item.is_deleted
        ],
    ).map_err(|e| e.to_string())?;

    Ok(item)
}

#[tauri::command]
pub fn update_schedule(app: AppHandle, id: String, item: ScheduleItem) -> Result<ScheduleItem, String> {
    let conn = get_connection(&app)?;
    let result = update_schedule_impl(&conn, id, item);
    if result.is_ok() {
        trigger_desktopcal_sync(&app);
    }
    result
}

pub fn update_schedule_impl(conn: &Connection, id: String, item: ScheduleItem) -> Result<ScheduleItem, String> {
    conn.execute(
        "UPDATE tbl_schedules SET 
            type = ?1, title = ?2, content = ?3, start_date = ?4, end_date = ?5, is_all_day = ?6, 
            reference_id = ?7, color = ?8, is_completed = ?9, updated_at = ?10, is_deleted = ?11
         WHERE id = ?12",
        params![
            item.schedule_type, item.title, item.content, item.start_date, item.end_date, 
            item.is_all_day, item.reference_id, item.color, item.is_completed, item.updated_at, item.is_deleted,
            id
        ],
    ).map_err(|e| e.to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn delete_schedule(app: AppHandle, id: String) -> Result<(), String> {
    let conn = get_connection(&app)?;
    let result = delete_schedule_impl(&conn, id);
    if result.is_ok() {
        trigger_desktopcal_sync(&app);
    }
    result
}

pub fn delete_schedule_impl(conn: &Connection, id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tbl_schedules SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── DeskTopCal Sync ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub conflicts: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportResult {
    pub exported: u32,
}

const DESKTOPCAL_RELATIVE_PATH: &str = r"CalendarTask\Db\calendar.db";

/// Detect DeskTopCal installation by checking the known AppData path.
#[tauri::command]
pub fn detect_desktopcal() -> Result<Option<String>, String> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let db_path = std::path::Path::new(&appdata).join(DESKTOPCAL_RELATIVE_PATH);
        if db_path.exists() {
            return Ok(Some(db_path.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// Strip DeskTopCal HTML-like font markup from event content.
/// e.g. `|&lt;|font color=|&quot;|#FFD700|&quot;||&gt;|급여|&lt;|/font|&gt;|` → `급여`
fn strip_desktopcal_markup(s: &str) -> String {
    let mut result = s.to_string();
    // Replace HTML entity escapes used by DeskTopCal
    result = result.replace("|&lt;|", "<");
    result = result.replace("|&gt;|", ">");
    result = result.replace("|&quot;|", "\"");
    result = result.replace("|&amp;|", "&");
    // Strip <font ...>...</font> tags
    let re_font = regex::Regex::new(r"<font[^>]*>").unwrap();
    result = re_font.replace_all(&result, "").to_string();
    result = result.replace("</font>", "");
    result.trim().to_string()
}

/// Extract color from DeskTopCal font markup if present.
/// e.g. `|&lt;|font color=|&quot;|#FFD700|&quot;||&gt;|text|&lt;|/font|&gt;|` → Some("#FFD700")
fn extract_desktopcal_color(s: &str) -> Option<String> {
    let decoded = s.replace("|&quot;|", "\"").replace("|&lt;|", "<").replace("|&gt;|", ">");
    let re = regex::Regex::new(r#"color="(#[0-9A-Fa-f]{6})""#).unwrap();
    re.captures(&decoded).map(|c| c[1].to_string())
}

/// Parse RRULE recurrence and expand into a list of start dates (YYYY-MM-DD).
fn expand_rrule(start_date_str: &str, recurrence_json: &str) -> Vec<String> {
    let mut dates = Vec::new();

    // Parse start date from ISO format like "2025-06-14T00:00:00.000+0900"
    let date_str = &start_date_str[..10]; // "2025-06-14"
    let start = match chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return vec![date_str.to_string()],
    };

    // Parse recurrence JSON: {"RRULE":{"FREQ":"DAILY","COUNT":5}} etc.
    let parsed: serde_json::Value = match serde_json::from_str(recurrence_json) {
        Ok(v) => v,
        Err(_) => {
            dates.push(date_str.to_string());
            return dates;
        }
    };

    let rrule = match parsed.get("RRULE") {
        Some(r) => r,
        None => {
            dates.push(date_str.to_string());
            return dates;
        }
    };

    let freq = rrule.get("FREQ").and_then(|v| v.as_str()).unwrap_or("DAILY");
    let count = rrule.get("COUNT").and_then(|v| v.as_u64());
    let until_str = rrule.get("UNTIL").and_then(|v| v.as_str());
    let custom_count = rrule.get("CUSTOMCOUNT").and_then(|v| v.as_u64()).unwrap_or(1);
    let by_monthday = rrule.get("BYMONTHDAY").and_then(|v| v.as_u64());

    // Determine end boundary
    let until_date = until_str.and_then(|s| {
        // Format: "20250803T000000" or "20250803T235959"
        if s.len() >= 8 {
            chrono::NaiveDate::parse_from_str(&s[..8], "%Y%m%d").ok()
        } else {
            None
        }
    });

    // Max expansion limit to prevent unbounded expansion
    let max_iterations = 365 * 3; // 3 years max

    match freq {
        "DAILY" => {
            if let Some(c) = count {
                for i in 0..c {
                    dates.push((start + chrono::Duration::days(i as i64)).format("%Y-%m-%d").to_string());
                }
            } else if let Some(until) = until_date {
                let mut current = start;
                let mut iterations = 0;
                while current <= until && iterations < max_iterations {
                    dates.push(current.format("%Y-%m-%d").to_string());
                    current += chrono::Duration::days(1);
                    iterations += 1;
                }
            } else {
                dates.push(date_str.to_string());
            }
        }
        "CUSTOMDAY" => {
            // CUSTOMDAY with CUSTOMCOUNT = interval in days
            if let Some(c) = count {
                for i in 0..c {
                    dates.push((start + chrono::Duration::days(i as i64 * custom_count as i64)).format("%Y-%m-%d").to_string());
                }
            } else if let Some(until) = until_date {
                let mut current = start;
                let mut iterations = 0;
                while current <= until && iterations < max_iterations {
                    dates.push(current.format("%Y-%m-%d").to_string());
                    current += chrono::Duration::days(custom_count as i64);
                    iterations += 1;
                }
            } else {
                dates.push(date_str.to_string());
            }
        }
        "MONTHLY" => {
            // Repeat monthly on a specific day
            let day = by_monthday.unwrap_or(start.day() as u64) as u32;
            let limit = count.unwrap_or(12); // default 12 months
            let mut current = start;
            for _ in 0..limit {
                if let Some(d) = current.with_day(day) {
                    dates.push(d.format("%Y-%m-%d").to_string());
                }
                // Move to next month
                if current.month() == 12 {
                    current = current.with_year(current.year() + 1).unwrap_or(current).with_month(1).unwrap_or(current);
                } else {
                    current = current.with_month(current.month() + 1).unwrap_or(current);
                }
                if let Some(until) = until_date {
                    if current > until { break; }
                }
            }
        }
        _ => {
            dates.push(date_str.to_string());
        }
    }

    if dates.is_empty() {
        dates.push(date_str.to_string());
    }

    dates
}

/// Normalize title for duplicate detection (trim, lowercase).
fn normalize_title(s: &str) -> String {
    s.trim().to_lowercase().replace('\r', "").replace('\n', " ")
}

/// Import calendar data from a DeskTopCal .db file into Hypercool's tbl_schedules.
#[tauri::command]
pub fn import_desktopcal_db(app: AppHandle, db_path: String) -> Result<ImportResult, String> {
    let conn = get_connection(&app)?;

    // Open DeskTopCal DB as read-only
    let ext_conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| format!("탁상달력 DB 열기 실패: {}", e))?;

    let mut imported: u32 = 0;
    let mut skipped: u32 = 0;
    let conflicts: u32 = 0;

    // Begin transaction on our DB
    conn.execute("BEGIN TRANSACTION", []).map_err(|e| e.to_string())?;

    // Helper: check if a schedule with matching date+title already exists
    let check_existing = |conn: &Connection, date: &str, title_norm: &str| -> Result<bool, String> {
        let mut stmt = conn.prepare(
            "SELECT title FROM tbl_schedules WHERE substr(start_date, 1, 10) = ?1"
        ).map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt.query_map(params![date], |row| {
            row.get::<_, String>(0)
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        Ok(rows.iter().any(|t| normalize_title(t) == title_norm))
    };

    // ── 1. Import item_table (date memos) ──
    {
        let mut stmt = ext_conn.prepare(
            "SELECT it_id, it_unique_id, it_bgcolor, it_content, it_cdate, it_mdate FROM item_table"
        ).map_err(|e| format!("item_table 읽기 실패: {}", e))?;

        let items: Vec<(i64, String, String, String, String, String)> = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        for (it_id, unique_id, bgcolor, content, cdate, mdate) in items {
            // Extract date from unique_id: "dkcal_mdays_20250512" → "2025-05-12"
            let date_part = unique_id.replace("dkcal_mdays_", "");
            if date_part.len() < 8 { continue; }
            let formatted_date = format!("{}-{}-{}", &date_part[..4], &date_part[4..6], &date_part[6..8]);

            // Title: first line of content; content: full text
            let content_trimmed = content.trim().to_string();
            let title = content_trimmed.lines().next().unwrap_or("메모").to_string();
            let title_norm = normalize_title(&title);

            // Check for duplicates
            if check_existing(&conn, &formatted_date, &title_norm)? {
                skipped += 1;
                continue;
            }

            let color = if bgcolor.is_empty() { None } else { Some(bgcolor) };

            let id = uuid::Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();

            let item = ScheduleItem {
                id,
                schedule_type: "desktopcal_memo".to_string(),
                title,
                content: Some(content_trimmed),
                start_date: Some(formatted_date.clone()),
                end_date: Some(formatted_date),
                is_all_day: true,
                reference_id: Some(format!("dkcal_item_{}", it_id)),
                color,
                is_completed: false,
                created_at: if cdate.is_empty() { now.clone() } else { cdate },
                updated_at: if mdate.is_empty() { now } else { mdate },
                is_deleted: false,
            };

            conn.execute(
                "INSERT INTO tbl_schedules (id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    item.id, item.schedule_type, item.title, item.content, item.start_date, item.end_date,
                    item.is_all_day, item.reference_id, item.color, item.is_completed, item.created_at, item.updated_at, item.is_deleted
                ],
            ).map_err(|e| {
                let _ = conn.execute("ROLLBACK", []);
                format!("메모 가져오기 실패: {}", e)
            })?;

            imported += 1;
        }
    }

    // ── 2. Import event_table (recurring events) ──
    {
        let mut stmt = ext_conn.prepare(
            "SELECT ev_id, ev_content, ev_start_date, ev_end_date, ev_recurrence, ev_cdate, ev_mdate FROM event_table"
        ).map_err(|e| format!("event_table 읽기 실패: {}", e))?;

        let events: Vec<(i64, String, String, String, String, String, String)> = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        for (ev_id, ev_content, ev_start_date, _ev_end_date, ev_recurrence, ev_cdate, ev_mdate) in events {
            let title = strip_desktopcal_markup(&ev_content);
            let color = extract_desktopcal_color(&ev_content);
            let title_norm = normalize_title(&title);

            if title.is_empty() { continue; }

            // Expand recurrence into concrete dates
            let expanded_dates = if ev_recurrence.is_empty() {
                let date_part = if ev_start_date.len() >= 10 { &ev_start_date[..10] } else { &ev_start_date };
                vec![date_part.to_string()]
            } else {
                expand_rrule(&ev_start_date, &ev_recurrence)
            };

            for date in expanded_dates {
                // Check for duplicates
                if check_existing(&conn, &date, &title_norm)? {
                    skipped += 1;
                    continue;
                }

                let id = uuid::Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();

                let item = ScheduleItem {
                    id,
                    schedule_type: "desktopcal_event".to_string(),
                    title: title.clone(),
                    content: None,
                    start_date: Some(date.clone()),
                    end_date: Some(date),
                    is_all_day: true,
                    reference_id: Some(format!("dkcal_event_{}", ev_id)),
                    color: color.clone(),
                    is_completed: false,
                    created_at: if ev_cdate.is_empty() { now.clone() } else { ev_cdate.clone() },
                    updated_at: if ev_mdate.is_empty() { now } else { ev_mdate.clone() },
                    is_deleted: false,
                };

                conn.execute(
                    "INSERT INTO tbl_schedules (id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        item.id, item.schedule_type, item.title, item.content, item.start_date, item.end_date,
                        item.is_all_day, item.reference_id, item.color, item.is_completed, item.created_at, item.updated_at, item.is_deleted
                    ],
                ).map_err(|e| {
                    let _ = conn.execute("ROLLBACK", []);
                    format!("이벤트 가져오기 실패: {}", e)
                })?;

                imported += 1;
            }
        }
    }

    // Commit transaction
    conn.execute("COMMIT", []).map_err(|e| format!("트랜잭션 커밋 실패: {}", e))?;

    Ok(ImportResult { imported, skipped, conflicts })
}

/// Export Hypercool schedule data to a DeskTopCal-format .db file.
#[tauri::command]
pub fn export_desktopcal_db(app: AppHandle, db_path: String) -> Result<ExportResult, String> {
    let conn = get_connection(&app)?;

    // Create/overwrite the export DB
    let ext_conn = Connection::open(&db_path).map_err(|e| format!("내보내기 DB 생성 실패: {}", e))?;
    create_desktopcal_schema(&ext_conn)?;
    export_schedules_to_desktopcal_db(&conn, &ext_conn)
}

/// Sync Hypercool's native items into the existing DeskTopCal DB (bidirectional).
/// Only writes items that don't already exist. Skips desktopcal-origin items.
#[tauri::command]
pub fn sync_to_desktopcal(app: AppHandle, db_path: String) -> Result<ExportResult, String> {
    let conn = get_connection(&app)?;
    let ext_conn = Connection::open(&db_path)
        .map_err(|e| format!("탁상달력 DB 열기 실패: {}", e))?;
    export_schedules_to_desktopcal_db(&conn, &ext_conn)
}

fn create_desktopcal_schema(ext_conn: &Connection) -> Result<(), String> {
    ext_conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS setting_table (
            st_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0,
            st_name VARCHAR(255) DEFAULT '', st_nval INTEGER DEFAULT 0,
            st_sval TEXT DEFAULT '', st_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime'))
        );
        CREATE TABLE IF NOT EXISTS project_table (
            pj_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0,
            pj_name VARCHAR(255) DEFAULT '',
            pj_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            pj_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime'))
        );
        CREATE TABLE IF NOT EXISTS item_table (
            it_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0, pj_id INTEGER DEFAULT 0,
            u_mid VARCHAR(128) DEFAULT '', it_unique_id VARCHAR(255) DEFAULT '',
            it_bgcolor VARCHAR(255) DEFAULT '', it_content TEXT DEFAULT '',
            it_history TEXT DEFAULT '', it_appinfo TEXT DEFAULT '',
            it_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            it_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            it_stime INTEGER DEFAULT 0, it_mtime INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS event_table (
            ev_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0, pj_id INTEGER DEFAULT 0,
            u_mid VARCHAR(128) DEFAULT '', ev_mid VARCHAR(128) DEFAULT '',
            ev_unique_id VARCHAR(255) DEFAULT '', ev_date DATETIME DEFAULT (datetime('now')),
            ev_content TEXT DEFAULT '', ev_type INTEGER DEFAULT 0,
            ev_start_date VARCHAR(64) DEFAULT '', ev_end_date VARCHAR(64) DEFAULT '',
            ev_status INTEGER DEFAULT 0, ev_recurrence TEXT DEFAULT '',
            ev_reminder TEXT DEFAULT '', ev_subs TEXT DEFAULT '', ev_info TEXT DEFAULT '',
            ev_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            ev_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            ev_stime INTEGER DEFAULT 0, ev_mtime INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS subs_table (
            ev_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0, pj_id INTEGER DEFAULT 0,
            u_mid VARCHAR(128) DEFAULT '', s_name VARCHAR(128) DEFAULT '',
            s_mid VARCHAR(128) DEFAULT '', se_status INTEGER DEFAULT 0,
            ev_mid VARCHAR(128) DEFAULT '', ev_unique_id VARCHAR(255) DEFAULT '',
            ev_date DATETIME DEFAULT (datetime('now')), ev_content TEXT DEFAULT '',
            ev_type INTEGER DEFAULT 0, ev_start_date VARCHAR(64) DEFAULT '',
            ev_end_date VARCHAR(64) DEFAULT '', ev_status INTEGER DEFAULT 0,
            ev_recurrence TEXT DEFAULT '', ev_reminder TEXT DEFAULT '',
            ev_subs TEXT DEFAULT '', ev_info TEXT DEFAULT '',
            ev_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            ev_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            ev_stime INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS picture_table (
            pic_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0, pj_id INTEGER DEFAULT 0,
            pic_ffn_md5 VARCHAR(255) NOT NULL, pic_fcnt_md5 VARCHAR(255) NOT NULL,
            pic_fullfilename TEXT DEFAULT '', pic_disp_type INTEGER DEFAULT 0,
            pic_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            pic_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime'))
        );
        CREATE TABLE IF NOT EXISTS capture_table (
            cap_id INTEGER PRIMARY KEY, u_id INTEGER DEFAULT 0, pj_id INTEGER DEFAULT 0,
            cap_ffn_md5 VARCHAR(255) NOT NULL, cap_fcnt_md5 VARCHAR(255) NOT NULL,
            cap_fullfilename TEXT DEFAULT '', cap_disp_type INTEGER DEFAULT 0,
            cap_cdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime')),
            cap_mdate DATETIME DEFAULT (datetime(CURRENT_TIMESTAMP,'localtime'))
        );"
    ).map_err(|e| format!("스키마 생성 실패: {}", e))?;
    Ok(())
}

/// Shared: export Hypercool-native schedules into a DeskTopCal item_table.
/// Skips desktopcal-origin items. Appends to existing memos if date already has content.
fn export_schedules_to_desktopcal_db(conn: &Connection, ext_conn: &Connection) -> Result<ExportResult, String> {
    let mut stmt = conn.prepare(
        "SELECT id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at
         FROM tbl_schedules WHERE is_deleted = 0 AND type NOT IN ('desktopcal_memo', 'desktopcal_event')"
    ).map_err(|e| e.to_string())?;

    let schedules: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, bool, Option<String>, Option<String>, bool, String, String)> = stmt.query_map([], |row| {
        Ok((
            row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
            row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?,
            row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
        ))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    let mut exported: u32 = 0;
    ext_conn.execute("BEGIN TRANSACTION", []).map_err(|e| e.to_string())?;

    // Get u_mid from existing entries (DeskTopCal user ID)
    let u_mid: String = ext_conn.query_row(
        "SELECT u_mid FROM item_table WHERE u_mid != '' LIMIT 1",
        [],
        |row| row.get(0),
    ).unwrap_or_default();

    for (_id, _stype, title, _content, start_date, end_date, _is_all_day, _ref_id, _color, _completed, _created_at, _updated_at) in &schedules {
        let get_local_date = |date_str: &Option<String>| -> Option<chrono::NaiveDate> {
            let s = date_str.as_ref()?;
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(dt.with_timezone(&chrono::Local).naive_local().date());
            }
            if s.len() >= 10 {
                return chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d").ok();
            }
            None
        };

        let start_naive = match get_local_date(start_date) {
            Some(d) => d,
            None => continue,
        };
        let end_naive = get_local_date(end_date).unwrap_or(start_naive);

        let mut current = start_naive;
        let max_days = 365;
        let mut day_count = 0;
        while current <= end_naive && day_count < max_days {
            let date_key = current.format("%Y%m%d").to_string();
            let unique_id = format!("dkcal_mdays_{}", date_key);
            let display_content = title.clone();

            let escape_content = |content: &str| -> String {
                content.chars().map(|c| {
                    if c as u32 > 127 {
                        format!("\\u{:04X}", c as u32)
                    } else if c == '\\' {
                        "\\\\".to_string()
                    } else if c == '"' {
                        "\\\"".to_string()
                    } else if c == '\n' {
                        "\\n".to_string()
                    } else if c == '\r' {
                        "\\r".to_string()
                    } else {
                        c.to_string()
                    }
                }).collect()
            };

            // DeskTopCal native format fields
            let now_ts = chrono::Local::now();
            let stime = now_ts.timestamp();
            let mdate_local = now_ts.format("%Y-%m-%d %H:%M:%S").to_string();

            let existing: Option<(String, String)> = ext_conn.query_row(
                "SELECT it_content, it_history FROM item_table WHERE it_unique_id = ?1",
                params![unique_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();

            if let Some((ext_content, _ext_history)) = existing {
                // Check if we need to append
                if !ext_content.contains(&display_content) {
                    let new_content = if ext_content.is_empty() {
                        display_content.clone()
                    } else {
                        format!("{}\n{}", ext_content, display_content)
                    };

                    let content_escaped = escape_content(&new_content);
                    let history = format!("[{{|&quot;|content|&quot;|:|&quot;|{}|&quot;|,|&quot;|time|&quot;|:{}}}]", content_escaped, stime);

                    ext_conn.execute(
                        "UPDATE item_table SET it_content = ?1, it_history = ?2, it_mdate = ?3, it_mtime = ?4 WHERE it_unique_id = ?5",
                        params![new_content, history, mdate_local, stime, unique_id],
                    ).map_err(|e| {
                        let _ = ext_conn.execute("ROLLBACK", []);
                        format!("업데이트 실패: {}", e)
                    })?;
                    exported += 1;
                }
            } else {
                let content_escaped = escape_content(&display_content);
                let history = format!("[{{|&quot;|content|&quot;|:|&quot;|{}|&quot;|,|&quot;|time|&quot;|:{}}}]", content_escaped, stime);

                // New date — insert with DeskTopCal-native format
                ext_conn.execute(
                    "INSERT INTO item_table (u_id, pj_id, u_mid, it_unique_id, it_bgcolor, it_content, it_history, it_appinfo, it_cdate, it_mdate, it_stime, it_mtime)
                     VALUES (0, 0, ?1, ?2, '', ?3, ?4, '', '', ?5, ?6, 0)",
                    params![u_mid, unique_id, display_content, history, mdate_local, stime],
                ).map_err(|e| {
                    let _ = ext_conn.execute("ROLLBACK", []);
                    format!("내보내기 실패: {}", e)
                })?;
                exported += 1;
            }

            current += chrono::Duration::days(1);
            day_count += 1;
        }
    }

    ext_conn.execute("COMMIT", []).map_err(|e| format!("커밋 실패: {}", e))?;
    Ok(ExportResult { exported })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tbl_schedules (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT,
                start_date TEXT,
                end_date TEXT,
                is_all_day BOOLEAN NOT NULL DEFAULT 0,
                reference_id TEXT,
                color TEXT,
                is_completed BOOLEAN NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                is_deleted BOOLEAN NOT NULL DEFAULT 0
            )",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn test_crud_schedule() {
        let conn = setup_db();
        let id = "test-id".to_string();
        let now = Utc::now().to_rfc3339();

        let item = ScheduleItem {
            id: id.clone(),
            schedule_type: "todo".to_string(),
            title: "Test Todo".to_string(),
            content: Some("Content".to_string()),
            start_date: Some(now.clone()),
            end_date: Some(now.clone()),
            is_all_day: false,
            reference_id: None,
            color: None,
            is_completed: false,
            created_at: now.clone(),
            updated_at: now.clone(),
            is_deleted: false,
        };

        // Create
        create_schedule_impl(&conn, item).unwrap();

        // Read
        let schedules = get_schedules_impl(&conn, "2000-01-01".to_string(), "2100-01-01".to_string()).unwrap();
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0].title, "Test Todo");

        // Update
        let mut updated_item = schedules[0].clone();
        updated_item.title = "Updated Title".to_string();
        update_schedule_impl(&conn, id.clone(), updated_item.clone()).unwrap();
        
        let schedules_after_update = get_schedules_impl(&conn, "2000-01-01".to_string(), "2100-01-01".to_string()).unwrap();
        assert_eq!(schedules_after_update[0].title, "Updated Title");

        // Delete
        delete_schedule_impl(&conn, id.clone()).unwrap();
        let schedules_after_delete = get_schedules_impl(&conn, "2000-01-01".to_string(), "2100-01-01".to_string()).unwrap();
        assert!(schedules_after_delete.is_empty());
    }
}

#[tauri::command]
pub fn migrate_registry_to_db_command(app: AppHandle) -> Result<String, String> {
    // Check if migration is already done
    if let Ok(Some(val)) = get_registry_value("DbMigrationDone".to_string()) {
        if val == "true" {
            return Ok("Already migrated".to_string());
        }
    }

    let mut count = 0;

    // 1. Migrate ManualTodos
    if let Ok(Some(json)) = get_registry_value("ManualTodos".to_string()) {
        if let Ok(todos) = serde_json::from_str::<Vec<RegistryManualTodo>>(&json) {
            for todo in todos {
                let item = ScheduleItem {
                    id: todo.id,
                    schedule_type: "manual_todo".to_string(),
                    title: todo.calendar_title.unwrap_or_else(|| "할 일".to_string()),
                    content: Some(todo.content),
                    start_date: todo.deadline.clone(),
                    end_date: todo.deadline, // For point-in-time todos, start=end
                    is_all_day: false,
                    reference_id: None,
                    color: None,
                    is_completed: false, // Registry doesn't track completion separately?
                    created_at: todo.created_at,
                    updated_at: todo.updated_at,
                    is_deleted: todo.is_deleted.unwrap_or(false),
                };
                let _ = create_schedule(app.clone(), item);
                count += 1;
            }
        }
    }

    // 2. Migrate PeriodSchedules
    if let Ok(Some(json)) = get_registry_value("PeriodSchedules".to_string()) {
        if let Ok(schedules) = serde_json::from_str::<Vec<RegistryPeriodSchedule>>(&json) {
            for schedule in schedules {
                let item = ScheduleItem {
                    id: schedule.id,
                    schedule_type: "period_schedule".to_string(),
                    title: schedule.calendar_title.unwrap_or_else(|| "일정".to_string()),
                    content: Some(schedule.content),
                    start_date: Some(schedule.start_date),
                    end_date: Some(schedule.end_date),
                    is_all_day: true, // Period schedules are usually all-day
                    reference_id: None,
                    color: None,
                    is_completed: false,
                    created_at: schedule.created_at,
                    updated_at: schedule.updated_at,
                    is_deleted: schedule.is_deleted.unwrap_or(false),
                };
                let _ = create_schedule(app.clone(), item);
                count += 1;
            }
        }
    }

    // 3. Migrate Message Metadata (Deadlines & Titles)
    let deadlines: HashMap<String, String> = 
        if let Ok(Some(json)) = get_registry_value("TodoDeadlineMap".to_string()) {
            serde_json::from_str(&json).unwrap_or_default()
        } else {
            HashMap::new()
        };
        
    let titles: HashMap<String, String> = 
        if let Ok(Some(json)) = get_registry_value("CalendarTitles".to_string()) {
            serde_json::from_str(&json).unwrap_or_default()
        } else {
            HashMap::new()
        };
    
    // Merge keys
    let mut all_msg_ids: Vec<String> = deadlines.keys().cloned().collect();
    for k in titles.keys() {
        if !all_msg_ids.contains(k) {
            all_msg_ids.push(k.clone());
        }
    }

    for msg_id in all_msg_ids {
        let deadline = deadlines.get(&msg_id);
        let title = titles.get(&msg_id).cloned().unwrap_or_else(|| "메시지 일정".to_string());
        
        if let Some(d) = deadline {
             let now = Utc::now().to_rfc3339();
             let item = ScheduleItem {
                id: uuid::Uuid::new_v4().to_string(),
                schedule_type: "message_task".to_string(),
                title: title,
                content: None,
                start_date: Some(d.clone()),
                end_date: Some(d.clone()),
                is_all_day: false,
                reference_id: Some(msg_id),
                color: None,
                is_completed: false,
                created_at: now.clone(),
                updated_at: now,
                is_deleted: false,
            };
            let _ = create_schedule(app.clone(), item);
            count += 1;
        }
    }

    // Mark migration as done
    let _ = set_registry_value("DbMigrationDone".to_string(), "true".to_string());

    Ok(format!("Migrated {} items", count))
}
