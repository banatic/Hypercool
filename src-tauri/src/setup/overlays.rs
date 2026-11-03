//! 미리 만들어 두는 숨김 창들: 검색 모달, GIF·수업 상태·다운로드 헬퍼 오버레이 풀.

use tauri::{Manager, WebviewWindowBuilder};

use crate::commands::{download, window};
use crate::utils::{apply_rounded_corners, apply_vibrancy_effect};
use crate::{download_watcher, gif_watcher};

fn make_url(path: &str) -> tauri::WebviewUrl {
    if cfg!(dev) {
        tauri::WebviewUrl::External(format!("http://localhost:1420/{}", path).parse().unwrap())
    } else {
        tauri::WebviewUrl::App(path.into())
    }
}

/// 오버레이 공통 창: 테두리·그림자·작업표시줄 없음, 투명, 숨김 상태로 생성.
fn overlay(app: &tauri::App, label: &str, page: &str, title: &str, w: f64, h: f64) -> Option<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(app, label, make_url(page))
        .title(title)
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .ok()
}

pub(super) fn build(app: &mut tauri::App) {
    // search-modal: 전역 단축키로 토글되는 화면 중앙 검색 창.
    // 즉시 표시되도록 숨김 상태로 미리 빌드해 둔다.
    if let Ok(search_win) = WebviewWindowBuilder::new(app, "search-modal", make_url("pages/search-modal.html"))
        .title("메시지 검색")
        .inner_size(960.0, 620.0)
        .min_inner_size(720.0, 480.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .build()
    {
        apply_vibrancy_effect(&search_win);
        // 아크릴이 사각 창 밖으로 삐져나오지 않도록 창 자체를 둥글게 클리핑
        apply_rounded_corners(&search_win);
    }

    // 저장된(또는 기본) 검색 단축키 등록
    window::init_search_hotkey(app.app_handle());

    // gif-btn-N / gif-widget-N 쌍 (각 N은 메시지 전송창 하나에 대응).
    // gif-widget 그림자는 CSS box-shadow 로만 처리.
    for &btn_label in gif_watcher::POOL {
        let widget_label = btn_label.replace("gif-btn", "gif-widget");
        let btn_win = overlay(app, btn_label, "pages/gif-btn.html", "GIF 버튼", 70.0, 27.0);
        let widget_win = overlay(app, &widget_label, "pages/gif-widget.html", "GIF 위젯", 420.0, 580.0);
        // owner chain: gif-widget-N의 owner = gif-btn-N (영구 설정)
        if let (Some(btn), Some(widget)) = (btn_win, widget_win) {
            gif_watcher::set_panel_owner(&widget, &btn);
        }
    }

    // class-btn-N: 수업 상태 표시 버튼
    for &class_label in gif_watcher::CLASS_POOL {
        overlay(app, class_label, "pages/class-btn.html", "수업 상태", 100.0, 28.0);
    }

    let gif_app = app.app_handle().clone();
    std::thread::spawn(move || gif_watcher::start_watcher(gif_app));

    // download-panel-N: 메시지 관리함에 부착될 다운로드 헬퍼 패널.
    // 초기 사이즈는 칩 모드. hover 시 확장.
    for &label in download_watcher::POOL {
        overlay(
            app,
            label,
            "pages/download-panel.html",
            "다운로드 헬퍼",
            download_watcher::COLLAPSED_W as f64,
            download_watcher::COLLAPSED_H as f64,
        );
    }
    download::restore_settings();

    let dl_app = app.app_handle().clone();
    std::thread::spawn(move || download_watcher::start_watcher(dl_app));
}
