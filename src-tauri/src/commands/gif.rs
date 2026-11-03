//! GIF 오버레이: Tenor 검색, 클립보드 붙여넣기, 패널 토글.

use tauri::Manager;

use crate::{gif_clipboard, gif_watcher, tenor};

#[tauri::command]
pub async fn cmd_search_tenor(query: String, offset: u32) -> Result<serde_json::Value, String> {
    tenor::search_tenor(&query, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_copy_html(html: String) -> Result<(), String> {
    gif_clipboard::copy_html_to_clipboard(&html).map_err(|e| e.to_string())
}

/// gif-btn-N 클릭 시 페어 gif-widget-N을 토글. 새 visibility(bool)를 반환.
#[tauri::command]
pub fn toggle_gif_panel(app: tauri::AppHandle, btn_label: String) -> Result<bool, String> {
    let widget_label = btn_label.replace("gif-btn", "gif-widget");
    let btn_win = app.get_webview_window(&btn_label)
        .ok_or_else(|| format!("{} not found", btn_label))?;
    let panel_win = app.get_webview_window(&widget_label)
        .ok_or_else(|| format!("{} not found", widget_label))?;

    if panel_win.is_visible().unwrap_or(false) {
        let _ = panel_win.hide();
        Ok(false)
    } else {
        let btn_pos = btn_win.outer_position().map_err(|e| e.to_string())?;
        let (px, py) = gif_watcher::compute_panel_position(btn_pos.x, btn_pos.y);
        let _ = panel_win.set_position(tauri::PhysicalPosition::new(px, py));
        panel_win.show().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

