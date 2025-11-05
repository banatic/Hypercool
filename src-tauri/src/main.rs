// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use rusqlite::types::ValueRef;
use std::fs;
use winreg::enums::*;
use winreg::RegKey;
use base64::Engine;
use flate2::read::ZlibDecoder;
use tauri::{tray::TrayIconBuilder, menu::{Menu, MenuItem}, image::Image};
use notify::{Watcher, recommended_watcher, RecursiveMode, EventKind};
use std::sync::{mpsc, OnceLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, Emitter};
use lru::LruCache;
use std::num::NonZeroUsize;
#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;
use chrono::{Local, NaiveTime};
use single_instance::SingleInstance;
#[cfg(target_os = "windows")]
use winapi::um::winuser::{MessageBoxW, MB_OK, MB_ICONINFORMATION};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

#[derive(serde::Serialize, Clone)]
struct Message {
    id: i64,
    sender: String,
    content: String,
    receive_date: Option<String>,
}

#[derive(serde::Serialize)]
struct PaginatedMessages {
    messages: Vec<Message>,
    total_count: i64,
}

#[derive(serde::Serialize, Clone)]
struct SearchResultItem {
    id: i64,
    sender: String,
    snippet: String,
}

/// UDB 파일에서 메시지를 읽어오는 함수
#[tauri::command]
fn read_udb_messages(db_path: String, limit: Option<i64>, offset: Option<i64>, search_term: Option<String>) -> Result<PaginatedMessages, String> {
    if !fs::metadata(&db_path).is_ok() {
        return Err(format!("데이터베이스 파일을 찾을 수 없습니다: {}", db_path));
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("데이터베이스 연결 실패: {}", e))?;

    // 요구사항: tbl_recv만 처리
    if table_exists(&conn, "tbl_recv").unwrap_or(false) {
        read_from_recv_only(&conn, limit, offset, search_term)
    } else {
        Err("tbl_recv 테이블을 찾을 수 없습니다".into())
    }
}

#[tauri::command]
fn search_messages(db_path: String, search_term: String, cache: tauri::State<CacheState>) -> Result<Vec<SearchResultItem>, String> {
    if search_term.is_empty() {
        return Ok(Vec::new());
    }

    // 1. Check cache first
    {
        let mut search_cache = cache.search_cache.lock().unwrap();
        if let Some(cached_results) = search_cache.get(&search_term) {
            return Ok(cached_results.clone());
        }
    }

    // 2. Cache miss, proceed with DB query
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 연결 실패: {}", e))?;
    let pattern = format!("%{}%", search_term);
    let mut stmt = conn.prepare(
        "SELECT MessageKey, Sender, substr(MessageText, 1, 100) FROM tbl_recv WHERE Sender LIKE ?1 OR MessageText LIKE ?1 ORDER BY ReceiveDate DESC, MessageKey DESC"
    ).map_err(|e| format!("검색 쿼리 준비 실패: {}", e))?;
    
    let iter = stmt.query_map([&pattern], |row| {
        Ok(SearchResultItem {
            id: row.get(0)?,
            sender: row.get(1)?,
            snippet: row.get(2)?,
        })
    }).map_err(|e| format!("검색 쿼리 실행 실패: {}", e))?;

    let results: Result<Vec<_>, _> = iter.collect();
    let results = results.map_err(|e| format!("검색 결과 처리 실패: {}", e))?;

    // 3. Store result in cache before returning
    {
        let mut search_cache = cache.search_cache.lock().unwrap();
        search_cache.put(search_term, results.clone());
    }
    
    Ok(results)
}

#[tauri::command]
fn get_message_by_id(db_path: String, id: i64) -> Result<Message, String> {
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 연결 실패: {}", e))?;
    conn.query_row(
        "SELECT MessageKey, Sender, MessageText, MessageBody, ReceiveDate FROM tbl_recv WHERE MessageKey = ?1",
        [id],
        |row| {
            // read_from_recv_only에 있는 변환 로직과 유사하게 구현
            let id: i64 = row.get(0)?;
            let sender: String = row.get(1)?;
            let text_ref = row.get_ref(2)?;
            let body_ref = row.get_ref(3)?;
            let receive_date: Option<String> = row.get(4)?;

            let text_value = match text_ref {
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(b) => Some(decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패"))),
                _ => None,
            };
            let mut prefer_body = false;
            let body_value = match body_ref {
                ValueRef::Text(t) => {
                    let s = String::from_utf8_lossy(t).to_string();
                    if let Some(rest) = s.strip_prefix("{COMP}") {
                        prefer_body = true;
                        decode_comp_zlib_utf16le(rest).unwrap_or_else(|_| String::from("압축 해제 실패"))
                    } else { s }
                }
                ValueRef::Blob(b) => {
                    prefer_body = true;
                    decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패"))
                }
                _ => String::new(),
            };
            let content = if prefer_body {
                body_value
            } else if let Some(t) = text_value {
                if !t.is_empty() { t } else { body_value }
            } else { body_value };

            Ok(Message { id, sender, content, receive_date })
        }
    ).map_err(|e| format!("ID로 메시지 조회 실패: {}", e))
}


fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1")
        .map_err(|e| format!("table_exists 쿼리 준비 실패: {}", e))?;
    let exists = stmt.query_row([table], |_| Ok(())).is_ok();
    Ok(exists)
}

fn read_from_recv_only(conn: &Connection, limit: Option<i64>, offset: Option<i64>, search_term: Option<String>) -> Result<PaginatedMessages, String> {
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let where_clause = match search_term.filter(|s| !s.is_empty()) {
        Some(term) => {
            let pattern = format!("%{}%", term);
            params.push(Box::new(pattern.clone()));
            params.push(Box::new(pattern));
            "WHERE (Sender LIKE ? OR MessageText LIKE ?)".to_string()
        }
        None => "".to_string(),
    };

    let total_count_sql = format!("SELECT COUNT(MessageKey) FROM tbl_recv {}", where_clause);
    let total_count: i64 = conn.query_row(
        &total_count_sql,
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        |row| row.get(0),
    ).map_err(|e| format!("총 메시지 수 조회 실패: {}", e))?;

    params.push(Box::new(limit.unwrap_or(50)));
    params.push(Box::new(offset.unwrap_or(0)));

    let query_sql = format!(
        "SELECT MessageKey as id, Sender, MessageText, MessageBody, ReceiveDate FROM tbl_recv {} ORDER BY ReceiveDate DESC, MessageKey DESC LIMIT ? OFFSET ?",
        where_clause
    );

    let mut stmt = conn.prepare(&query_sql)
        .map_err(|e| format!("tbl_recv 쿼리 준비 실패: {}", e))?;

    let iter = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        |row| -> Result<Message, rusqlite::Error> {
            let id: i64 = row.get(0)?;
            let sender: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();

            // 1) MessageText가 있으면 우선 사용
            let text_ref = row.get_ref(2)?;
            let body_ref = row.get_ref(3)?;
            let receive_date: Option<String> = row.get(4)?;

            // MessageText 처리
            let text_value = match text_ref {
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(b) => Some(decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패"))),
                _ => None,
            };

            // MessageBody 처리: {COMP} base64+brotli 또는 텍스트/블랍 그대로
            let mut prefer_body = false;
            let body_value = match body_ref {
                ValueRef::Text(t) => {
                    let s = String::from_utf8_lossy(t).to_string();
                    if let Some(rest) = s.strip_prefix("{COMP}") {
                        prefer_body = true;
                        decode_comp_zlib_utf16le(rest).unwrap_or_else(|_| String::from("압축 해제 실패"))
                    } else {
                        s
                    }
                }
                ValueRef::Blob(b) => {
                    prefer_body = true;
                    // Blob은 기존 브로틀리 가정 유지(구형 호환). 필요 시 zlib 시도 추가 가능
                    decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패"))
                }
                _ => String::new(),
            };

            let content = if prefer_body {
                body_value
            } else if let Some(t) = text_value {
                if !t.is_empty() { t } else { body_value }
            } else { body_value };

            Ok(Message { id, sender, content, receive_date })
        })
        .map_err(|e| format!("tbl_recv 데이터 조회 실패: {}", e))?;

    let mut messages = Vec::new();
    for m in iter {
        messages.push(m.map_err(|e| format!("tbl_recv 데이터 처리 실패: {}", e))?);
    }
    Ok(PaginatedMessages { messages, total_count })
}



// 레지스트리 경로 상수
const REG_BASE: &str = r"Software\\HyperCool";

#[tauri::command]
fn get_registry_value(key: String) -> Result<Option<String>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(REG_BASE) {
        Ok(subkey) => {
            match subkey.get_value::<String, _>(key) {
                Ok(v) => Ok(Some(v)),
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("레지스트리 읽기 실패: {}", e)),
            }
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("레지스트리 키 열기 실패: {}", e)),
    }
}

#[tauri::command]
fn set_registry_value(key: String, value: String) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (subkey, _) = hkcu
        .create_subkey(REG_BASE)
        .map_err(|e| format!("레지스트리 키 생성 실패: {}", e))?;
    subkey
        .set_value(key, &value)
        .map_err(|e| format!("레지스트리 쓰기 실패: {}", e))
}

/// Brotli로 압축된 데이터를 압축 해제
fn decompress_brotli(compressed_data: &[u8]) -> Result<String, std::io::Error> {
    use brotli::Decompressor;
    use std::io::Read;
    
    let mut decompressor = Decompressor::new(compressed_data, 4096);
    let mut decompressed = Vec::new();
    decompressor.read_to_end(&mut decompressed)?;
    
    Ok(String::from_utf8_lossy(&decompressed).to_string())
}



fn decode_comp_zlib_utf16le(b64: &str) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 디코딩 실패: {}", e))?;
    let mut zr = ZlibDecoder::new(&data[..]);
    let mut out: Vec<u8> = Vec::new();
    use std::io::Read;
    zr.read_to_end(&mut out).map_err(|e| format!("zlib inflate 실패: {}", e))?;
    // UTF-16LE -> String
    if out.len() % 2 != 0 {
        return Err("UTF-16LE 길이가 홀수입니다".into());
    }
    let mut u16s = Vec::with_capacity(out.len() / 2);
    for chunk in out.chunks_exact(2) {
        u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    String::from_utf16(&u16s).map_err(|e| format!("UTF-16LE 변환 실패: {}", e))
}

// 최근 숨김 시각 (워처 자동 표시 억제용)
static LAST_HIDE_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

#[tauri::command]
fn notify_hidden() {
    let cell = LAST_HIDE_AT.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = cell.lock() {
        *slot = Some(Instant::now());
    }
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 현재 시간이 수업 시간인지 확인하는 함수
fn is_class_time() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let reg_base = REG_BASE;
    
    let class_times_json = match hkcu.open_subkey(reg_base) {
        Ok(subkey) => {
            match subkey.get_value::<String, _>("ClassTimes") {
                Ok(v) if !v.is_empty() => Some(v),
                _ => None,
            }
        }
        _ => None,
    };
    
    // 수업 시간이 설정되지 않았으면 false 반환 (항상 표시)
    let class_times: Vec<String> = match class_times_json {
        Some(json) => {
            match serde_json::from_str::<Vec<String>>(&json) {
                Ok(times) if !times.is_empty() => times,
                _ => return false,
            }
        }
        None => return false,
    };
    
    let now = Local::now().time();
    
    // 각 수업 시간대를 체크
    for time_range in class_times {
        // HHMM-HHMM 형식 파싱 (예: "0830-0920")
        let parts: Vec<&str> = time_range.split('-').collect();
        if parts.len() != 2 {
            continue;
        }
        
        let start_str = parts[0].trim();
        let end_str = parts[1].trim();
        
        // HHMM 형식을 NaiveTime으로 변환
        let start_time = match parse_hhmm(start_str) {
            Some(t) => t,
            None => continue,
        };
        
        let end_time = match parse_hhmm(end_str) {
            Some(t) => t,
            None => continue,
        };
        
        // 현재 시간이 이 시간대 내에 있는지 확인
        let in_range = if start_time <= end_time {
            now >= start_time && now <= end_time
        } else {
            // 자정을 넘어가는 경우
            now >= start_time || now <= end_time
        };
        
        if in_range {
            return true;
        }
    }
    
    false
}

/// HHMM 형식 문자열을 NaiveTime으로 변환하는 헬퍼 함수
fn parse_hhmm(hhmm: &str) -> Option<NaiveTime> {
    if hhmm.len() != 4 {
        return None;
    }
    
    let hour_str = &hhmm[0..2];
    let min_str = &hhmm[2..4];
    
    let hour: u32 = hour_str.parse().ok()?;
    let minute: u32 = min_str.parse().ok()?;
    
    if hour >= 24 || minute >= 60 {
        return None;
    }
    
    NaiveTime::from_hms_opt(hour, minute, 0)
}

struct CacheState {
    search_cache: Mutex<LruCache<String, Vec<SearchResultItem>>>,
}

#[cfg(target_os = "windows")]
fn show_message_box(message: &str, title: &str) {
    unsafe {
        let message_wide: Vec<u16> = OsStr::new(message).encode_wide().chain(Some(0)).collect();
        let title_wide: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
        MessageBoxW(
            std::ptr::null_mut(),
            message_wide.as_ptr(),
            title_wide.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

fn main() {
    // 단일 인스턴스 체크 - 이미 실행 중이면 종료
    // instance 변수를 유지하여 mutex가 해제되지 않도록 함
    let _instance = SingleInstance::new("hypercool-app").unwrap();
    if !_instance.is_single() {
        #[cfg(target_os = "windows")]
        show_message_box("이미 실행 중입니다.", "HyperCool");
        #[cfg(not(target_os = "windows"))]
        eprintln!("이미 실행 중입니다.");
        std::process::exit(1);
    }

    let cache_size = NonZeroUsize::new(50).unwrap();
    let cache_state = CacheState {
        search_cache: Mutex::new(LruCache::new(cache_size)),
    };

    tauri::Builder::default()
        .manage(cache_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_udb_messages,
            get_registry_value,
            set_registry_value,
            notify_hidden,
            hide_main_window,
            search_messages,
            get_message_by_id
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let handle = app.handle();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = apply_mica(&window, None);
                }
            }

            // Build system tray
            let show_item = MenuItem::with_id(app, "show", "창 열기", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Load tray icon - try multiple paths and formats
            let icon_path = {
                // Try resource directory first (production)
                let resource_icon = app.path().resource_dir()
                    .ok()
                    .and_then(|dir| {
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
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                        }
                        "quit" => { std::process::exit(0); }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, _event| {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
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
                                image::imageops::resize(&rgba, 32, 32, image::imageops::FilterType::Lanczos3)
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
                                image::imageops::resize(&rgba, 32, 32, image::imageops::FilterType::Lanczos3)
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
                                    image::imageops::resize(&rgba, 32, 32, image::imageops::FilterType::Lanczos3)
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

            let tray = tray_builder.build(app)?;
            
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
                        let mut watcher = recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                            if let Ok(event) = res { let _ = tx.send(event); }
                        }).ok();

                        if let Some(w) = watcher.as_mut() {
                            // udb-wal 파일의 생성/삭제/변경을 안정적으로 감지하기 위해 부모 디렉토리를 감시합니다.
                            if let Some(parent) = udb_path.parent() {
                                let _ = w.watch(parent, RecursiveMode::NonRecursive);
                            }
                        }

                        let mut last_seen_id = read_udb_messages(path.clone(), Some(1), Some(0), None)
                            .ok()
                            .and_then(|result| result.messages.first().map(|m| m.id));
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
                                if let Ok(result) = read_udb_messages(path.clone(), Some(1), Some(0), None) {
                                    if let Some(current_id) = result.messages.first().map(|m| m.id) {
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
                                        if let Some(wv) = app_handle.get_webview_window("main") { let _ = wv.show(); let _ = wv.set_focus(); }
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

