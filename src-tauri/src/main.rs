// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use rusqlite::types::ValueRef;
use std::fs;
use winreg::enums::*;
use winreg::RegKey;
use base64::Engine;
use flate2::read::ZlibDecoder;
use tauri::{tray::TrayIconBuilder, menu::{Menu, MenuItem}};
use notify::{Watcher, recommended_watcher, RecursiveMode, EventKind};
use std::sync::{mpsc, OnceLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, Emitter};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;

#[derive(serde::Serialize)]
struct Message {
    id: i64,
    content: String,
}

/// UDB 파일에서 메시지를 읽어오는 함수
#[tauri::command]
fn read_udb_messages(db_path: String) -> Result<Vec<Message>, String> {
    if !fs::metadata(&db_path).is_ok() {
        return Err(format!("데이터베이스 파일을 찾을 수 없습니다: {}", db_path));
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("데이터베이스 연결 실패: {}", e))?;

    // 요구사항: tbl_recv만 처리
    if table_exists(&conn, "tbl_recv").unwrap_or(false) {
        read_from_recv_only(&conn)
    } else {
        Err("tbl_recv 테이블을 찾을 수 없습니다".into())
    }
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1")
        .map_err(|e| format!("table_exists 쿼리 준비 실패: {}", e))?;
    let exists = stmt.query_row([table], |_| Ok(())).is_ok();
    Ok(exists)
}

fn read_from_recv_only(conn: &Connection) -> Result<Vec<Message>, String> {
    // MessageBody가 {COMP}로 시작하면 base64 브로틀리, 아니면 TEXT로 사용.
    let mut stmt = conn
        .prepare(
            "SELECT MessageKey as id, MessageText, MessageBody FROM tbl_recv ORDER BY ReceiveDate DESC, MessageKey DESC",
        )
        .map_err(|e| format!("tbl_recv 쿼리 준비 실패: {}", e))?;

    let iter = stmt
        .query_map([], |row| -> Result<Message, rusqlite::Error> {
            let id: i64 = row.get(0)?;

            // 1) MessageText가 있으면 우선 사용
            let text_ref = row.get_ref(1)?;
            let body_ref = row.get_ref(2)?;

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

            Ok(Message { id, content })
        })
        .map_err(|e| format!("tbl_recv 데이터 조회 실패: {}", e))?;

    let mut messages = Vec::new();
    for m in iter {
        messages.push(m.map_err(|e| format!("tbl_recv 데이터 처리 실패: {}", e))?);
    }
    Ok(messages)
}

fn read_from_legacy_message(conn: &Connection) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare("SELECT id, msg FROM message ORDER BY id DESC")
        .map_err(|e| format!("쿼리 준비 실패: {}", e))?;
    let iter = stmt
        .query_map([], |row| -> Result<Message, rusqlite::Error> {
            let id: i64 = row.get(0)?;
            let msg_blob: Vec<u8> = row.get(1)?;
            let content = decompress_brotli(&msg_blob).unwrap_or_else(|_| String::from("압축 해제 실패"));
            Ok(Message { id, content })
        })
        .map_err(|e| format!("데이터 조회 실패: {}", e))?;
    let mut messages = Vec::new();
    for m in iter {
        messages.push(m.map_err(|e| format!("데이터 처리 실패: {}", e))?);
    }
    Ok(messages)
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

fn decode_comp_brotli(_b64: &str) -> Result<String, String> { unreachable!("replaced by zlib UTF-16LE") }

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_udb_messages,
            get_registry_value,
            set_registry_value,
            notify_hidden,
            hide_main_window
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

            TrayIconBuilder::new()
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
                })
                .build(app)?;
            // Watchdog for UDB file: read from registry and watch (spawn dedicated thread)
            if let Ok(subkey) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(REG_BASE) {
                if let Ok(path) = subkey.get_value::<String, _>("UdbPath") {
                    let app_handle = app.app_handle().clone();
                    std::thread::spawn(move || {
                        let (tx, rx) = mpsc::channel();
                        let mut watcher = recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                            if let Ok(event) = res { let _ = tx.send(event); }
                        }).ok();
                        if let Some(w) = watcher.as_mut() {
                            let _ = w.watch(std::path::Path::new(&path), RecursiveMode::NonRecursive);
                        }
                        while let Ok(event) = rx.recv() {
                            match event.kind {
                                EventKind::Modify(_) | EventKind::Create(_) => {
                                    let _ = app_handle.emit("udb-changed", ());
                                    // 최근 숨김 직후에는 자동 표시 억제 (2초)
                                    let suppress = LAST_HIDE_AT
                                        .get_or_init(|| Mutex::new(None))
                                        .lock()
                                        .ok()
                                        .and_then(|slot| *slot)
                                        .map(|t| t.elapsed() < Duration::from_secs(2))
                                        .unwrap_or(false);
                                    if !suppress {
                                        if let Some(wv) = app_handle.get_webview_window("main") { let _ = wv.show(); let _ = wv.set_focus(); }
                                    }
                                }
                                _ => {}
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

