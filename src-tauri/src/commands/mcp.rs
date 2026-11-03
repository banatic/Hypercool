use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::commands::system::{get_registry_value, set_registry_value};

use crate::edufine_db::{self, EdufineDocPreview};
use crate::edufine_watcher;


#[derive(Serialize)]
pub struct McpStatus {
    pub server_running: bool,
    pub port: u16,
    pub edufine_enabled: bool,
    pub edufine_running: bool,
}

#[derive(Serialize)]
pub struct EdufineStats {
    pub total_docs: i64,
    pub last_detected_at: Option<String>,
    pub watch_dir: String,
}

fn get_edufine_db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("edufine_docs.db")
}

#[tauri::command]
pub fn get_mcp_status(_app: AppHandle) -> McpStatus {
    let edufine_enabled = edufine_watcher::is_enabled();
    let edufine_running = edufine_watcher::is_running();
    McpStatus {
        server_running: true, // MCP 서버는 항상 실행 중
        port: 3737,
        edufine_enabled,
        edufine_running,
    }
}

#[tauri::command]
pub fn toggle_edufine_mcp(app: AppHandle, enabled: bool) -> Result<(), String> {
    let db_path = get_edufine_db_path(&app);

    if enabled {
        edufine_watcher::start(db_path);
    } else {
        edufine_watcher::stop();
    }

    // 레지스트리에 상태 저장
    let _ = set_registry_value("EdufineEnabled".to_string(), (if enabled { "true" } else { "false" }).to_string());

    Ok(())
}

#[tauri::command]
pub fn get_edufine_stats(app: AppHandle) -> EdufineStats {
    let db_path = get_edufine_db_path(&app);
    let watch_dir = edufine_watcher::get_watch_dir()
        .to_string_lossy()
        .to_string();

    match edufine_db::get_stats(&db_path) {
        Ok((total, last)) => EdufineStats {
            total_docs: total,
            last_detected_at: last,
            watch_dir,
        },
        Err(_) => EdufineStats {
            total_docs: 0,
            last_detected_at: None,
            watch_dir,
        },
    }
}

#[tauri::command]
pub fn list_edufine_docs_recent(app: AppHandle, limit: Option<i64>) -> Vec<EdufineDocPreview> {
    let db_path = get_edufine_db_path(&app);
    let limit = limit.unwrap_or(10).min(50);
    edufine_db::list_docs(&db_path, limit, 0).unwrap_or_default()
}

#[tauri::command]
pub fn open_edufine_watch_dir() -> Result<(), String> {
    let dir = edufine_watcher::get_watch_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// main.rs 시작 시 레지스트리에서 Edufine 활성화 상태를 읽어 복원
pub fn restore_edufine_state(app: &AppHandle) {
    let enabled = matches!(get_registry_value("EdufineEnabled".to_string()), Ok(Some(v)) if v == "true");

    if enabled {
        let db_path = get_edufine_db_path(app);
        edufine_watcher::start(db_path);
    }
}
