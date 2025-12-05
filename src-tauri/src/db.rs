use rusqlite::{params, Connection, Result};
use tauri::AppHandle;
use tauri::Manager;
use serde::{Serialize, Deserialize};
use chrono::Utc;

#[derive(Debug, Serialize, Deserialize)]
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

pub fn get_schedules(app: &AppHandle, start: &str, end: &str) -> Result<Vec<ScheduleItem>, String> {
    let conn = get_connection(app)?;
    let mut stmt = conn.prepare(
        "SELECT id, type, title, content, start_date, end_date, is_all_day, reference_id, color, is_completed, created_at, updated_at, is_deleted 
         FROM tbl_schedules 
         WHERE is_deleted = 0 AND (
            (start_date BETWEEN ?1 AND ?2) OR 
            (end_date BETWEEN ?1 AND ?2) OR
            (start_date <= ?1 AND end_date >= ?2)
         )"
    ).map_err(|e| e.to_string())?;

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

pub fn create_schedule(app: &AppHandle, item: ScheduleItem) -> Result<ScheduleItem, String> {
    let conn = get_connection(app)?;
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

pub fn update_schedule(app: &AppHandle, id: String, item: ScheduleItem) -> Result<ScheduleItem, String> {
    let conn = get_connection(app)?;
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

pub fn delete_schedule(app: &AppHandle, id: String) -> Result<(), String> {
    let conn = get_connection(app)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tbl_schedules SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

