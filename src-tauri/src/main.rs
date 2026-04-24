// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hypercool::commands::{messages, mcp as mcp_commands, system, window};
use hypercool::db;
use hypercool::edufine_db;
use hypercool::gif_clipboard;
use hypercool::gif_watcher;
use hypercool::models::CacheState;
use hypercool::school_data;
use hypercool::search_db;
use hypercool::tenor;
use hypercool::timetable_parser;
use hypercool::appin_parser;
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

#[tauri::command]
async fn cmd_search_tenor(query: String, offset: u32) -> Result<serde_json::Value, String> {
    tenor::search_tenor(&query, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_copy_html(html: String) -> Result<(), String> {
    gif_clipboard::copy_html_to_clipboard(&html).map_err(|e| e.to_string())
}

/// 학교 위젯(types.ts PERIOD_TIMES)과 동일한 하드코딩 시간으로 현재 교시의 시간표 인덱스를 반환.
/// 점심(12:20-13:20)은 None. 5교시 이후는 점심 슬롯을 건너뛰어 timetable 인덱스에 맞게 조정.
fn get_current_period() -> Option<usize> {
    use chrono::Timelike;
    // (시작분, 종료분) — types.ts PERIOD_TIMES와 동일
    const PERIOD_TIMES: &[(u32, u32)] = &[
        (8*60+30, 9*60+20),   // 0 → timetable[0] (1교시)
        (9*60+30, 10*60+20),  // 1 → timetable[1] (2교시)
        (10*60+30, 11*60+20), // 2 → timetable[2] (3교시)
        (11*60+30, 12*60+20), // 3 → timetable[3] (4교시)
        (12*60+20, 13*60+20), // 4 = 점심 → None
        (13*60+20, 14*60+10), // 5 → timetable[4] (5교시)
        (14*60+20, 15*60+10), // 6 → timetable[5] (6교시)
        (15*60+20, 16*60+10), // 7 → timetable[6] (7교시)
    ];
    let now = chrono::Local::now();
    let mins = now.hour() * 60 + now.minute();
    for (i, &(start, end)) in PERIOD_TIMES.iter().enumerate() {
        if mins >= start && mins <= end {
            if i == 4 { return None; } // 점심시간
            return Some(if i < 4 { i } else { i - 1 });
        }
    }
    None
}

fn parse_recipient_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() { return None; }
    let name = s.split('(').next()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[derive(serde::Serialize)]
struct RecipientStatus {
    name: String,
    subject: Option<String>,
    room: Option<String>,
}

#[derive(serde::Serialize)]
struct ClassStatusResult {
    is_broadcast: bool,
    in_class_period: bool,
    current_period: Option<usize>,
    recipients: Vec<RecipientStatus>,
}

/// class-btn-N 레이블에서 슬롯 번호 파싱
fn parse_btn_slot(label: &str) -> Option<usize> {
    label.rsplit('-').next()?.parse().ok()
}

fn lookup_appin_subject(
    data: &appin_parser::AppinTimetableData,
    teacher_name: &str,
    period_idx: usize,
) -> (String, Option<String>) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let period_str = (period_idx + 1).to_string();
    let teacher_idx = match data.teachers.iter().position(|t| t == teacher_name) {
        Some(i) => i,
        None => return (String::new(), None),
    };
    let day_data = match data.days.get(&today) {
        Some(d) => d,
        None => return (String::new(), None),
    };
    for (class_name, period_map) in day_data {
        if let Some(slot) = period_map.get(&period_str) {
            if slot.teacher == Some(teacher_idx) {
                let subject = slot.subject
                    .and_then(|si| data.subjects.get(si))
                    .cloned()
                    .unwrap_or_default();
                return (subject, if class_name.is_empty() { None } else { Some(class_name.clone()) });
            }
        }
    }
    (String::new(), None)
}

#[tauri::command]
fn get_class_status(btn_label: String, timetable_source: Option<String>) -> Result<ClassStatusResult, String> {
    let slot = parse_btn_slot(&btn_label).ok_or("invalid label")?;
    let hwnd_val = gif_watcher::get_slot_hwnd(slot).ok_or("not tracking")?;

    let raw = gif_watcher::extract_recipients(hwnd_val);
    let names: Vec<String> = raw.iter().filter_map(|t| parse_recipient_name(t)).collect();

    if names.len() >= 5 {
        return Ok(ClassStatusResult {
            is_broadcast: true,
            in_class_period: is_class_time(),
            current_period: None,
            recipients: Vec::new(),
        });
    }

    let current_period = get_current_period();
    let in_class_period = current_period.is_some();

    if !in_class_period || names.is_empty() {
        return Ok(ClassStatusResult {
            is_broadcast: false,
            in_class_period,
            current_period: None,
            recipients: names.iter().map(|n| RecipientStatus {
                name: n.clone(), subject: None, room: None,
            }).collect(),
        });
    }

    let period_idx = current_period.unwrap();
    use chrono::Datelike;
    let day_idx = match chrono::Local::now().weekday() {
        chrono::Weekday::Mon => 0usize,
        chrono::Weekday::Tue => 1,
        chrono::Weekday::Wed => 2,
        chrono::Weekday::Thu => 3,
        chrono::Weekday::Fri => 4,
        _ => {
            return Ok(ClassStatusResult {
                is_broadcast: false,
                in_class_period: true,
                current_period: Some(period_idx),
                recipients: names.iter().map(|n| RecipientStatus {
                    name: n.clone(), subject: None, room: None,
                }).collect(),
            });
        }
    };

    let use_appin = timetable_source.as_deref() == Some("appin");

    let recipients = if use_appin {
        let appin_data = appin_parser::parse_appin_timetable().ok();
        names.iter().map(|name| {
            let (subject, room) = appin_data.as_ref()
                .map(|d| lookup_appin_subject(d, name, period_idx))
                .unwrap_or((String::new(), None));
            RecipientStatus {
                name: name.clone(),
                subject: if subject.is_empty() { None } else { Some(subject) },
                room,
            }
        }).collect()
    } else {
        let timetable = match timetable_parser::parse_timetable() {
            Ok(t) => t,
            Err(_) => {
                return Ok(ClassStatusResult {
                    is_broadcast: false,
                    in_class_period: true,
                    current_period: Some(period_idx),
                    recipients: names.iter().map(|n| RecipientStatus {
                        name: n.clone(), subject: None, room: None,
                    }).collect(),
                });
            }
        };
        names.iter().map(|name| {
            let (subject, room) = timetable.timetables.get(name)
                .and_then(|tt| tt.get(period_idx))
                .and_then(|day_row| day_row.get(day_idx))
                .and_then(|cell| {
                    let subj = cell.first().filter(|s| !s.is_empty()).cloned()?;
                    let rm = cell.get(1).filter(|r| !r.is_empty()).cloned();
                    Some((subj, rm))
                })
                .unwrap_or((String::new(), None));
            RecipientStatus {
                name: name.clone(),
                subject: if subject.is_empty() { None } else { Some(subject) },
                room,
            }
        }).collect()
    };

    Ok(ClassStatusResult {
        is_broadcast: false,
        in_class_period: true,
        current_period: Some(period_idx),
        recipients,
    })
}

#[tauri::command]
fn resize_class_btn(app: tauri::AppHandle, label: String, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("window not found")?;
    win.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// gif-btn-N 클릭 시 페어 gif-widget-N을 토글. 새 visibility(bool)를 반환.
#[tauri::command]
fn toggle_gif_panel(app: tauri::AppHandle, btn_label: String) -> Result<bool, String> {
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

fn main() {
    hypercool::dummy_window::init();

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
            system::setup_claude_mcp,
            system::check_node_installed,
            
            window::notify_hidden,
            window::hide_main_window,
            window::open_calendar_widget,
            window::set_calendar_widget_pinned,
            window::get_calendar_widget_pinned,
            window::open_school_widget,
            window::set_school_widget_pinned,
            window::get_school_widget_pinned,
            window::send_window_to_bottom,
            
            db::get_schedules,
            db::create_schedule,
            db::update_schedule,
            db::delete_schedule,
            db::migrate_registry_to_db_command,
            db::detect_desktopcal,
            db::import_desktopcal_db,
            db::export_desktopcal_db,
            db::sync_to_desktopcal,
            
            search_db::sync_search_db,
            search_db::search_messages_fts,
            search_db::get_cached_message,
            search_db::get_search_db_stats,
            search_db::read_cached_messages,
            search_db::get_cached_message_count,
            search_db::is_cache_ready,

            mcp_commands::get_mcp_status,
            mcp_commands::toggle_edufine_mcp,
            mcp_commands::get_edufine_stats,
            mcp_commands::list_edufine_docs_recent,
            mcp_commands::open_edufine_watch_dir,

            timetable_parser::get_timetable_data,
            appin_parser::get_appin_timetable_data,
            school_data::get_meal_data,
            school_data::get_attendance_data,
            school_data::get_points_data,
            school_data::get_stock_quotes,

            cmd_search_tenor,
            cmd_copy_html,
            toggle_gif_panel,
            get_class_status,
            resize_class_btn,
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
            
            // Initialize Search DB
            if let Err(e) = search_db::init_search_db(app.app_handle()) {
                eprintln!("Failed to initialize Search DB: {}", e);
                // Don't return error - search is optional
            }

            // Initialize Edufine DB + restore watcher state + start MCP server
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let search_db_path = app_data_dir.join("hypercool_search.db");
                let edufine_db_path = app_data_dir.join("edufine_docs.db");

                if let Err(e) = edufine_db::init_db(&edufine_db_path) {
                    eprintln!("[Edufine] DB 초기화 실패: {}", e);
                }

                mcp_commands::restore_edufine_state(app.app_handle());
                hypercool::mcp_server::start(search_db_path, edufine_db_path, 3737);
            }

            // gif-btn-N / gif-widget-N 쌍 생성 (각 N은 메시지 전송창 하나에 대응)
            {
                let make_url = |path: &str| -> tauri::WebviewUrl {
                    if cfg!(dev) {
                        tauri::WebviewUrl::External(
                            format!("http://localhost:1420/{}", path).parse().unwrap()
                        )
                    } else {
                        tauri::WebviewUrl::App(path.into())
                    }
                };

                for &btn_label in gif_watcher::POOL {
                    let widget_label = btn_label.replace("gif-btn", "gif-widget");

                    // gif-btn: 오버레이 버튼 (shadow 없음)
                    let btn_win = tauri::WebviewWindowBuilder::new(
                        app, btn_label, make_url("gif-btn.html"))
                        .title("GIF 버튼")
                        .inner_size(70.0, 27.0)
                        .resizable(false)
                        .decorations(false)
                        .transparent(true)
                        .shadow(false)
                        .skip_taskbar(true)
                        .visible(false)
                        .build()
                        .ok();

                    // gif-widget: GIF 검색 패널 (shadow 없음 — CSS box-shadow로만 처리)
                    let widget_win = tauri::WebviewWindowBuilder::new(
                        app, &widget_label, make_url("gif-widget.html"))
                        .title("GIF 위젯")
                        .inner_size(420.0, 580.0)
                        .resizable(false)
                        .decorations(false)
                        .transparent(true)
                        .shadow(false)
                        .skip_taskbar(true)
                        .visible(false)
                        .build()
                        .ok();

                    // owner chain: gif-widget-N의 owner = gif-btn-N (영구 설정)
                    if let (Some(btn), Some(widget)) = (btn_win, widget_win) {
                        gif_watcher::set_panel_owner(&widget, &btn);
                    }
                }

                // class-btn-N: 수업 상태 표시 버튼
                for &class_label in gif_watcher::CLASS_POOL {
                    let _ = tauri::WebviewWindowBuilder::new(
                        app, class_label, make_url("class-btn.html"))
                        .title("수업 상태")
                        .inner_size(100.0, 28.0)
                        .resizable(false)
                        .decorations(false)
                        .transparent(true)
                        .shadow(false)
                        .skip_taskbar(true)
                        .visible(false)
                        .build();
                }

                let gif_app = app.app_handle().clone();
                std::thread::spawn(move || {
                    gif_watcher::start_watcher(gif_app);
                });
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

                // 탁상달력 자동 동기화 (양방향)
                if let Ok(Some(dkcal_path)) = db::detect_desktopcal() {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    // 1) DeskTopCal → Hypercool (가져오기)
                    match db::import_desktopcal_db(app_handle_for_auto_start.clone(), dkcal_path.clone()) {
                        Ok(result) => {
                            if result.imported > 0 {
                                eprintln!("탁상달력 가져오기 완료: {}개 가져옴, {}개 건너뜀", result.imported, result.skipped);
                            }
                        }
                        Err(e) => eprintln!("탁상달력 가져오기 실패: {}", e),
                    }
                    // 2) Hypercool → DeskTopCal (내보내기)
                    match db::sync_to_desktopcal(app_handle_for_auto_start.clone(), dkcal_path) {
                        Ok(result) => {
                            if result.exported > 0 {
                                eprintln!("탁상달력 내보내기 완료: {}개 내보냄", result.exported);
                            }
                        }
                        Err(e) => eprintln!("탁상달력 내보내기 실패: {}", e),
                    }
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
                                    
                                    // Sync search DB in background
                                    let app_for_sync = app_handle.clone();
                                    let path_for_sync = path.clone();
                                    std::thread::spawn(move || {
                                        if let Err(e) = search_db::sync_from_udb(&app_for_sync, path_for_sync) {
                                            eprintln!("Search DB sync failed: {}", e);
                                        }
                                    });
                                    
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
