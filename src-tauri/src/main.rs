// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hypercool::commands::{messages, system, window};
use hypercool::db;
use hypercool::models::CacheState;
use hypercool::school_data;
use hypercool::timetable_parser;
use hypercool::utils::is_class_time;
use hypercool::commands::window::LAST_HIDE_AT;
use hypercool::commands::messages::{read_udb_messages_internal, get_latest_message_id_internal};
#[cfg(target_os = "windows")]
use hypercool::commands::system::register_custom_scheme;
use hypercool::utils::apply_vibrancy_effect;

use std::sync::{mpsc, Mutex};
use std::time::Duration;
use lru::LruCache;
use std::num::NonZeroUsize;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use std::fs;
use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use winreg::enums::*;
use winreg::RegKey;

const REG_BASE: &str = r"Software\\HyperCool";

fn main() {
    let cache_size = NonZeroUsize::new(50).unwrap();
    let cache_state = CacheState {
        search_cache: Mutex::new(LruCache::new(cache_size)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(cache_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            window::show_main_window(app);
            
            // Windows: Deep link is passed as an argument to the second instance
            for arg in args {
                if arg.starts_with("hypercool://") {
                    let _ = app.emit("deep-link-url", arg);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            messages::read_udb_messages,
            messages::search_messages,
            messages::get_message_by_id,
            messages::get_all_messages_for_sync,
            messages::open_message_viewer,
            messages::close_message_viewer,
            
            system::get_registry_value,
            system::set_registry_value,
            system::get_download_path,
            system::check_file_exists,
            system::open_file,
            system::set_auto_start,
            
            window::notify_hidden,
            window::hide_main_window,
            window::open_calendar_widget,
            window::set_calendar_widget_pinned,
            window::get_calendar_widget_pinned,
            window::open_school_widget,
            window::set_school_widget_pinned,
            window::get_school_widget_pinned,
            
            db::get_schedules,
            db::create_schedule,
            db::update_schedule,
            db::delete_schedule,
            db::migrate_registry_to_db_command,
            
            timetable_parser::get_timetable_data,
            school_data::get_meal_data,
            school_data::get_attendance_data,
            school_data::get_points_data,
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                // Ensure custom scheme is registered on startup
                if let Err(e) = register_custom_scheme() {
                    eprintln!("Failed to register custom scheme: {}", e);
                }
            }

            // Initialize DB
            if let Err(e) = db::init_db(app.app_handle()) {
                eprintln!("Failed to initialize DB: {}", e);
                return Err(e.into());
            }

            // Apply window vibrancy (Windows: Acrylic; macOS: Vibrancy; fallback: Blur)
            if let Some(win) = app.get_webview_window("main") {
                // apply_vibrancy_effect(&win); // Removed for performance
                // 새로운 아크릴 효과는 포커스가 없어도 유지되므로 이벤트 리스너 불필요
            }

            // Build system tray
            eprintln!("트레이 메뉴 생성 시작...");
            let show_item = match MenuItem::with_id(app, "show", "창 열기", true, None::<&str>) {
                Ok(item) => {
                    eprintln!("show 메뉴 항목 생성 성공");
                    item
                },
                Err(e) => {
                    eprintln!("메뉴 항목 생성 실패: {:?}", e);
                    return Err(e.into());
                }
            };
            let quit_item = match MenuItem::with_id(app, "quit", "종료", true, None::<&str>) {
                Ok(item) => {
                    eprintln!("quit 메뉴 항목 생성 성공");
                    item
                },
                Err(e) => {
                    eprintln!("메뉴 항목 생성 실패: {:?}", e);
                    return Err(e.into());
                }
            };
            eprintln!("메뉴 생성 시도...");
            let menu = match Menu::with_items(app, &[&show_item, &quit_item]) {
                Ok(m) => {
                    eprintln!("메뉴 생성 성공");
                    m
                },
                Err(e) => {
                    eprintln!("메뉴 생성 실패: {:?}", e);
                    return Err(e.into());
                }
            };

            // Load tray icon - try multiple paths and formats
            let icon_path = {
                // Try resource directory first (production)
                let resource_icon = app.path().resource_dir().ok().and_then(|dir| {
                    let png_path = dir.join("icons").join("32x32.png");
                    let ico_path = dir.join("icons").join("icon.ico");
                    if png_path.exists() {
                        Some(png_path)
                    } else if ico_path.exists() {
                        Some(ico_path)
                    } else {
                        None
                    }
                });

                // Fallback to development path - try from current executable directory
                let dev_icon = resource_icon.or_else(|| {
                    // Try relative to executable
                    if let Ok(exe_dir) = std::env::current_exe() {
                        if let Some(parent) = exe_dir.parent() {
                            let png_path = parent.join("src-tauri").join("icons").join("32x32.png");
                            let ico_path = parent.join("src-tauri").join("icons").join("icon.ico");
                            if png_path.exists() {
                                return Some(png_path);
                            } else if ico_path.exists() {
                                return Some(ico_path);
                            }
                        }
                    }
                    // Try relative to current working directory
                    let dev_png = std::path::PathBuf::from("src-tauri/icons/32x32.png");
                    let dev_ico = std::path::PathBuf::from("src-tauri/icons/icon.ico");
                    if dev_png.exists() {
                        Some(dev_png)
                    } else if dev_ico.exists() {
                        Some(dev_ico)
                    } else {
                        None
                    }
                });

                dev_icon
            };

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        window::show_main_window(app);
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } | tauri::tray::TrayIconEvent::DoubleClick { button: tauri::tray::MouseButton::Left, .. } => {
                            let app = tray.app_handle();
                            window::show_main_window(app);
                        }
                        _ => {}
                    }
                });

            // Set icon - try file path first, then fallback to embedded icon
            let mut icon_set = false;

            // Try loading from file path
            if let Some(path) = icon_path {
                eprintln!("트레이 아이콘 경로 찾음: {:?}", path);
                if let Ok(icon_bytes) = fs::read(&path) {
                    eprintln!("아이콘 파일 읽기 성공: {} bytes", icon_bytes.len());
                    match image::load_from_memory(&icon_bytes) {
                        Ok(img) => {
                            let rgba = img.to_rgba8();
                            let (width, height) = rgba.dimensions();
                            eprintln!("이미지 디코딩 성공: {}x{}", width, height);
                            // Resize to 32x32 if needed for tray icon
                            let resized = if width != 32 || height != 32 {
                                image::imageops::resize(
                                    &rgba,
                                    32,
                                    32,
                                    image::imageops::FilterType::Lanczos3,
                                )
                            } else {
                                rgba
                            };
                            let image = Image::new_owned(resized.into_raw(), 32, 32);
                            tray_builder = tray_builder.icon(image);
                            icon_set = true;
                            eprintln!("트레이 아이콘 설정 완료 (파일에서)");
                        }
                        Err(e) => {
                            eprintln!("이미지 디코딩 실패: {}", e);
                        }
                    }
                } else {
                    eprintln!("아이콘 파일 읽기 실패");
                }
            }

            // Fallback: try embedded icon using include_bytes!
            if !icon_set {
                eprintln!("파일 경로에서 아이콘을 찾지 못함, 포함된 아이콘 시도...");
                // Try to use include_bytes! at compile time
                // Note: This path is relative to src-tauri/src/main.rs
                #[cfg(not(test))]
                {
                    let icon_bytes = include_bytes!("../icons/32x32.png");
                    match image::load_from_memory(icon_bytes) {
                        Ok(img) => {
                            let rgba = img.to_rgba8();
                            let (width, height) = rgba.dimensions();
                            eprintln!("포함된 이미지 디코딩 성공: {}x{}", width, height);
                            let resized = if width != 32 || height != 32 {
                                image::imageops::resize(
                                    &rgba,
                                    32,
                                    32,
                                    image::imageops::FilterType::Lanczos3,
                                )
                            } else {
                                rgba
                            };
                            let image = Image::new_owned(resized.into_raw(), 32, 32);
                            tray_builder = tray_builder.icon(image);
                            icon_set = true;
                            eprintln!("트레이 아이콘 설정 완료 (포함된 아이콘에서)");
                        }
                        Err(e) => {
                            eprintln!("포함된 이미지 디코딩 실패: {}", e);
                            // Try icon.ico as fallback
                            let ico_bytes = include_bytes!("../icons/icon.ico");
                            if let Ok(img) = image::load_from_memory(ico_bytes) {
                                let rgba = img.to_rgba8();
                                let (width, height) = rgba.dimensions();
                                let resized = if width != 32 || height != 32 {
                                    image::imageops::resize(
                                        &rgba,
                                        32,
                                        32,
                                        image::imageops::FilterType::Lanczos3,
                                    )
                                } else {
                                    rgba
                                };
                                let image = Image::new_owned(resized.into_raw(), 32, 32);
                                tray_builder = tray_builder.icon(image);
                                icon_set = true;
                                eprintln!("트레이 아이콘 설정 완료 (포함된 ICO에서)");
                            }
                        }
                    }
                }
            }

            if !icon_set {
                eprintln!("경고: 트레이 아이콘이 설정되지 않았습니다");
            }

            let tray = match tray_builder.build(app) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("트레이 아이콘 빌드 실패: {:?}", e);
                    return Err(e.into());
                }
            };

            // Ensure tray icon is visible
            #[cfg(target_os = "windows")]
            {
                // On Windows, make sure the tray icon is visible
                if let Err(e) = tray.set_visible(true) {
                    eprintln!("트레이 아이콘 표시 설정 실패: {:?}", e);
                } else {
                    eprintln!("트레이 아이콘 표시 설정 성공");
                }
            }

            // 자동 실행 설정 확인 및 실행
            let app_handle_for_auto_start = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1000)).await; // 앱 초기화 대기
                
                // 자동 실행 시 메인 윈도우 숨기기 확인
                let hide_main = match system::get_registry_value("AutoStartHideMain".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if hide_main {
                    if let Some(window) = app_handle_for_auto_start.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                
                // 달력 위젯 자동 실행 확인
                let auto_start_calendar = match system::get_registry_value("AutoStartCalendar".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if auto_start_calendar {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = window::open_calendar_widget(app_handle_for_auto_start.clone()).await;
                }
                
                // 학교 위젯 자동 실행 확인
                let auto_start_school = match system::get_registry_value("AutoStartSchool".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if auto_start_school {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = window::open_school_widget(app_handle_for_auto_start.clone()).await;
                }
            });

            // Watchdog for UDB file: read from registry and watch (spawn dedicated thread)
            if let Ok(subkey) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(REG_BASE) {
                if let Ok(path) = subkey.get_value::<String, _>("UdbPath") {
                    let app_handle = app.app_handle().clone();
                    let udb_path = std::path::PathBuf::from(&path);
                    let mut wal_path_os = udb_path.as_os_str().to_owned();
                    wal_path_os.push("-wal");
                    let wal_path = std::path::PathBuf::from(wal_path_os);

                    std::thread::spawn(move || {
                        let (tx, rx) = mpsc::channel();
                        let mut watcher = recommended_watcher(
                            move |res: Result<notify::Event, notify::Error>| {
                                if let Ok(event) = res {
                                    let _ = tx.send(event);
                                }
                            },
                        )
                        .ok();

                        if let Some(w) = watcher.as_mut() {
                            // udb-wal 파일의 생성/삭제/변경을 안정적으로 감지하기 위해 부모 디렉토리를 감시합니다.
                            if let Some(parent) = udb_path.parent() {
                                let _ = w.watch(parent, RecursiveMode::NonRecursive);
                            }
                        }

                        let mut last_seen_id =
                            get_latest_message_id_internal(path.clone())
                                .ok()
                                .flatten();
                        let mut baseline_initialized = last_seen_id.is_some();
                        while let Ok(event) = rx.recv() {
                            // 이벤트가 udb-wal 파일과 관련된 경우에만 처리합니다.
                            // 경로 비교를 정규화하여 정확하게 비교합니다.
                            let wal_path_canonical = wal_path.canonicalize().ok();
                            let is_wal_related = event.paths.iter().any(|p| {
                                // 정규화된 경로로 비교 시도
                                if let Ok(canonical) = p.canonicalize() {
                                    if let Some(ref wal_canonical) = wal_path_canonical {
                                        return canonical == *wal_canonical;
                                    }
                                }
                                // 정규화 실패 시 원본 경로로 비교
                                p == &wal_path
                            });

                            if !is_wal_related {
                                continue;
                            }

                            // udb-wal 파일이 존재하는지 확인 (오프라인 상태에서는 파일이 없을 수 있음)
                            let wal_exists = wal_path.exists();

                            // Create 이벤트는 파일이 실제로 생성되었을 때만 처리
                            // Modify 이벤트는 파일이 존재할 때만 처리 (오프라인 상태 방지)
                            let should_process = match event.kind {
                                EventKind::Create(_) => wal_exists, // Create 이벤트 발생 시 실제로 파일이 존재하는지 확인
                                EventKind::Modify(_) => wal_exists,
                                _ => false,
                            };

                            if should_process {
                                let mut has_new_message = false;
                                if let Ok(current_id_opt) = get_latest_message_id_internal(path.clone()) {
                                    if let Some(current_id) = current_id_opt
                                    {
                                        has_new_message = match last_seen_id {
                                            Some(prev) => current_id > prev,
                                            None => !baseline_initialized,
                                        };
                                        last_seen_id = Some(current_id);
                                        baseline_initialized = true;
                                    }
                                }

                                // 메시지가 실제로 변경되었을 때만 이벤트 발생
                                if has_new_message {
                                    let _ = app_handle.emit("udb-changed", ());
                                    // 최근 숨김 직후에는 자동 표시 억제 (2초)
                                    let suppress_hide = LAST_HIDE_AT
                                        .get_or_init(|| Mutex::new(None))
                                        .lock()
                                        .ok()
                                        .and_then(|slot| *slot)
                                        .map(|t| t.elapsed() < Duration::from_secs(2))
                                        .unwrap_or(false);

                                    // 수업 시간 체크
                                    let suppress_class_time = is_class_time();

                                    if !suppress_hide && !suppress_class_time {
                                        if let Some(wv) = app_handle.get_webview_window("main") {
                                            let _ = wv.show();
                                            let _ = wv.set_focus();
                                        }
                                    }
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
