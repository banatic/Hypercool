//! 시스템 트레이 아이콘과 메뉴.

use std::path::PathBuf;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::commands::window;

const ICON_SIZE: u32 = 32;

pub(super) fn build(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "창 열기", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => window::show_main_window(app),
            "quit" => std::process::exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button: MouseButton::Left, .. }
            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                window::show_main_window(tray.app_handle());
            }
            _ => {}
        });

    match load_icon(app) {
        Some(icon) => tray_builder = tray_builder.icon(icon),
        None => eprintln!("경고: 트레이 아이콘이 설정되지 않았습니다"),
    }

    let tray = tray_builder.build(app).map_err(|e| {
        eprintln!("트레이 아이콘 빌드 실패: {:?}", e);
        e
    })?;

    #[cfg(target_os = "windows")]
    if let Err(e) = tray.set_visible(true) {
        eprintln!("트레이 아이콘 표시 설정 실패: {:?}", e);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = tray;

    Ok(())
}

/// 트레이 아이콘: 리소스 폴더 → 개발 경로(실행 파일 옆, 작업 폴더) → 빌드 내장본 순으로 시도.
fn load_icon(app: &tauri::App) -> Option<Image<'static>> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("icons"));
    }
    if let Some(parent) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        dirs.push(parent.join("src-tauri").join("icons"));
    }
    dirs.push(PathBuf::from("src-tauri/icons"));

    for dir in dirs {
        for name in ["32x32.png", "icon.ico"] {
            let path = dir.join(name);
            if let Some(icon) = std::fs::read(&path).ok().and_then(|b| decode_icon(&b)) {
                return Some(icon);
            }
        }
    }

    decode_icon(include_bytes!("../../icons/32x32.png"))
        .or_else(|| decode_icon(include_bytes!("../../icons/icon.ico")))
}

/// 이미지 바이트를 32x32 RGBA 트레이 아이콘으로 변환.
fn decode_icon(bytes: &[u8]) -> Option<Image<'static>> {
    let rgba = image::load_from_memory(bytes).ok()?.to_rgba8();
    let rgba = if rgba.dimensions() != (ICON_SIZE, ICON_SIZE) {
        image::imageops::resize(&rgba, ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        rgba
    };
    Some(Image::new_owned(rgba.into_raw(), ICON_SIZE, ICON_SIZE))
}
