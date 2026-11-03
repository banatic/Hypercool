//! 시작 직후 레지스트리 설정에 따른 자동 동작: 메인 창 숨김, 위젯 열기, 탁상달력 동기화.

use std::time::Duration;

use tauri::Manager;

use crate::commands::{system, window};
use crate::db;

fn reg_flag(key: &str) -> bool {
    matches!(system::get_registry_value(key.to_string()), Ok(Some(v)) if v == "true")
}

pub(super) fn spawn(app: &mut tauri::App) {
    let app = app.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1000)).await; // 앱 초기화 대기

        if reg_flag("AutoStartHideMain") {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }

        if reg_flag("AutoStartCalendar") {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = window::open_calendar_widget(app.clone()).await;
        }

        if reg_flag("AutoStartSchool") {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = window::open_school_widget(app.clone()).await;
        }

        // 탁상달력 자동 동기화 (양방향)
        if let Ok(Some(dkcal_path)) = db::detect_desktopcal() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            // 1) DeskTopCal → Hypercool (가져오기)
            match db::import_desktopcal_db(app.clone(), dkcal_path.clone()) {
                Ok(result) if result.imported > 0 => {
                    eprintln!("탁상달력 가져오기 완료: {}개 가져옴, {}개 건너뜀", result.imported, result.skipped);
                }
                Ok(_) => {}
                Err(e) => eprintln!("탁상달력 가져오기 실패: {}", e),
            }
            // 2) Hypercool → DeskTopCal (내보내기)
            match db::sync_to_desktopcal(app.clone(), dkcal_path) {
                Ok(result) if result.exported > 0 => {
                    eprintln!("탁상달력 내보내기 완료: {}개 내보냄", result.exported);
                }
                Ok(_) => {}
                Err(e) => eprintln!("탁상달력 내보내기 실패: {}", e),
            }
        }
    });
}
