//! 메시지 관리함 다운로드 헬퍼 패널 명령과 설정.

use crate::commands::system::{get_registry_value, set_registry_value};
use crate::download_watcher;

const REG_ENABLED: &str = "DownloadHelperEnabled";
const REG_AUTO_SAVE: &str = "DownloadHelperAutoSave";

/// 다운로드 패널 칩↔확장 모드 토글. 윈도우 크기 + 위치 갱신.
#[tauri::command]
pub fn download_panel_set_expanded(app: tauri::AppHandle, label: String, expanded: bool) -> Result<(), String> {
    download_watcher::reposition_by_label(&app, &label, expanded);
    Ok(())
}

/// 특정 첨부파일 경로의 현재 디스크 상태(존재/크기/수정시각)를 즉석 재조회.
/// 폴링 루프가 메신저 엔트리 텍스트 변화에만 재emit 하므로, 저장 직후처럼
/// 텍스트는 그대로인데 디스크에는 파일이 생긴 경우 stale 한 `exists` 를 갱신하기 위함.
/// (파일 열기 행위 시점에 프런트에서 호출)
#[tauri::command]
pub fn download_panel_recheck_file(path: String) -> download_watcher::FileMeta {
    download_watcher::recheck_file(&path)
}

/// 다운로드 헬퍼 ON/OFF (전역). 레지스트리에도 반영.
#[tauri::command]
pub fn download_helper_set_enabled(enabled: bool) -> Result<(), String> {
    download_watcher::set_enabled(enabled);
    save_bool_reg(REG_ENABLED, enabled);
    Ok(())
}

/// 자동 저장 클릭 ON/OFF. 레지스트리에도 반영.
#[tauri::command]
pub fn download_helper_set_auto_save(enabled: bool) -> Result<(), String> {
    download_watcher::set_auto_save(enabled);
    save_bool_reg(REG_AUTO_SAVE, enabled);
    Ok(())
}

#[tauri::command]
pub fn download_helper_get_settings() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "enabled": download_watcher::is_enabled(),
        "auto_save": download_watcher::is_auto_save(),
    }))
}

/// 시작 시 레지스트리에서 토글 상태를 복원한다(기본 ON).
pub fn restore_settings() {
    download_watcher::set_enabled(load_bool_reg(REG_ENABLED, true));
    download_watcher::set_auto_save(load_bool_reg(REG_AUTO_SAVE, true));
}

fn save_bool_reg(key: &str, value: bool) {
    let _ = set_registry_value(key.to_string(), (if value { "1" } else { "0" }).to_string());
}

fn load_bool_reg(key: &str, default: bool) -> bool {
    match get_registry_value(key.to_string()) {
        Ok(Some(v)) => v == "1" || v.eq_ignore_ascii_case("true"),
        _ => default,
    }
}
