use rusqlite::{params, Connection, Result};
use tauri::AppHandle;
use tauri::Manager;
use serde::{Serialize, Deserialize};
use chrono::Utc;
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
pub fn get_schedules(app: AppHandle, start: String, end: String) -> Result<Vec<ScheduleItem>, String> {
    let conn = get_connection(&app)?;
    get_schedules_impl(&conn, start, end)
}

pub fn get_schedules_impl(conn: &Connection, start: String, end: String) -> Result<Vec<ScheduleItem>, String> {
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

#[tauri::command]
pub fn create_schedule(app: AppHandle, item: ScheduleItem) -> Result<ScheduleItem, String> {
    let conn = get_connection(&app)?;
    create_schedule_impl(&conn, item)
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
    update_schedule_impl(&conn, id, item)
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
    delete_schedule_impl(&conn, id)
}

pub fn delete_schedule_impl(conn: &Connection, id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tbl_schedules SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
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
