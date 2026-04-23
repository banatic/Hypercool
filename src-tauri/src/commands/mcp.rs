use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::edufine_db::{self, EdufineDocPreview};
use crate::edufine_watcher;

const REG_BASE: &str = r"Software\HyperCool";

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
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(subkey) = hkcu.open_subkey_with_flags(REG_BASE, winreg::enums::KEY_SET_VALUE) {
        let _ = subkey.set_value("EdufineEnabled", &if enabled { "true" } else { "false" });
    } else if let Ok((subkey, _)) = hkcu.create_subkey(REG_BASE) {
        let _ = subkey.set_value("EdufineEnabled", &if enabled { "true" } else { "false" });
    }

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
    let enabled = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(REG_BASE)
        .ok()
        .and_then(|k| k.get_value::<String, _>("EdufineEnabled").ok())
        .map(|v| v == "true")
        .unwrap_or(false);

    if enabled {
        let db_path = get_edufine_db_path(app);
        edufine_watcher::start(db_path);
    }
}
