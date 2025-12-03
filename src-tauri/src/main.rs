// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod window_blur;

use base64::Engine;
use chrono::{Local, NaiveTime};
use flate2::read::ZlibDecoder;
use lru::LruCache;
use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ToSql};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
use std::fs;
use std::num::NonZeroUsize;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri::{Emitter, Manager, Runtime};
#[cfg(target_os = "windows")]
use winapi::um::winuser::{FindWindowW, ShowWindow, SetForegroundWindow, SW_RESTORE, SW_HIDE, SW_SHOW, SetWindowPos, HWND_BOTTOM, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_acrylic;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
use window_vibrancy::apply_blur;

// 윈도우에 vibrancy 효과를 적용하는 헬퍼 함수
fn apply_vibrancy_effect<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        // 윈도우 타이틀로 핸들 찾기
        if let Ok(title) = window.title() {
            let title_wide: Vec<u16> = OsStr::new(&title).encode_wide().chain(Some(0)).collect();
            unsafe {
                let hwnd = FindWindowW(std::ptr::null_mut(), title_wide.as_ptr());
                if !hwnd.is_null() {
                    // winapi::HWND를 windows::Win32::Foundation::HWND로 변환
                    let hwnd_ptr = hwnd as *mut std::ffi::c_void;
                    let hwnd_windows = windows::Win32::Foundation::HWND(hwnd_ptr);
                    window_blur::enable_acrylic(hwnd_windows);
                    return;
                }
            }
        }
        // 폴백: 기존 방식 사용
        let _ = apply_acrylic(window, Some((18, 18, 18, 125)));
    }

    #[cfg(target_os = "macos")]
    {
        let _ = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None);
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = apply_blur(window, Some((18, 18, 18, 125)));
    }
}
use winreg::enums::*;
use winreg::RegKey;

#[derive(serde::Serialize, Clone)]
struct Message {
    id: i64,
    sender: String,
    content: String,
    receive_date: Option<String>,
    file_paths: Vec<String>,
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

/// UDB 파일에서 메시지를 읽어오는 내부 함수 (watchdog 등에서 직접 호출 가능)
fn read_udb_messages_internal(
    db_path: String,
    limit: Option<i64>,
    offset: Option<i64>,
    search_term: Option<String>,
    min_id: Option<i64>,
) -> Result<PaginatedMessages, String> {
    if !fs::metadata(&db_path).is_ok() {
        return Err(format!("데이터베이스 파일을 찾을 수 없습니다: {}", db_path));
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("데이터베이스 연결 실패: {}", e))?;

    // 요구사항: tbl_recv만 처리
    if table_exists(&conn, "tbl_recv").unwrap_or(false) {
        read_from_recv_only(&conn, limit, offset, search_term, min_id)
    } else {
        Err("tbl_recv 테이블을 찾을 수 없습니다".into())
    }
}

/// UDB 파일에서 메시지를 읽어오는 함수 (Tauri command)
#[tauri::command]
fn read_udb_messages(
    db_path: String,
    limit: Option<i64>,
    offset: Option<i64>,
    search_term: Option<String>,
    min_id: Option<i64>,
) -> Result<PaginatedMessages, String> {
    read_udb_messages_internal(db_path, limit, offset, search_term, min_id)
}

#[tauri::command]
fn search_messages(
    db_path: String,
    search_term: String,
    cache: tauri::State<'_, CacheState>,
) -> Result<Vec<SearchResultItem>, String> {
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

    let iter = stmt
        .query_map([&pattern], |row| {
            Ok(SearchResultItem {
                id: row.get(0)?,
                sender: row.get(1)?,
                snippet: row.get(2)?,
            })
        })
        .map_err(|e| format!("검색 쿼리 실행 실패: {}", e))?;

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
        "SELECT MessageKey, Sender, MessageText, MessageBody, ReceiveDate, FilePath FROM tbl_recv WHERE MessageKey = ?1",
        [id],
        |row| {
            // read_from_recv_only에 있는 변환 로직과 유사하게 구현
            let id: i64 = row.get(0)?;
            let sender: String = row.get(1)?;
            let text_ref = row.get_ref(2)?;
            let body_ref = row.get_ref(3)?;
            let receive_date: Option<String> = row.get(4)?;
            let file_path: Option<String> = row.get(5)?;

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

            let file_paths = parse_file_paths(&file_path.unwrap_or_default());
            Ok(Message { id, sender, content, receive_date, file_paths })
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

fn read_from_recv_only(
    conn: &Connection,
    limit: Option<i64>,
    offset: Option<i64>,
    search_term: Option<String>,
    min_id: Option<i64>,
) -> Result<PaginatedMessages, String> {
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut conditions = Vec::new();

    if let Some(mid) = min_id {
        conditions.push("MessageKey > ?");
        params.push(Box::new(mid));
    }


    if let Some(term) = search_term.as_ref().filter(|s| !s.is_empty()) {
        conditions.push("(Sender LIKE ? OR MessageText LIKE ?)");
        let pattern = format!("%{}%", term);
        params.push(Box::new(pattern.clone()));
        params.push(Box::new(pattern));
    }

    let where_clause = if !conditions.is_empty() {
        format!("WHERE {}", conditions.join(" AND "))
    } else {
        "".to_string()
    };

    let total_count_sql = format!("SELECT COUNT(MessageKey) FROM tbl_recv {}", where_clause);
    let _total_count: i64 = conn
        .query_row(
            &total_count_sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| row.get(0),
        )
        .map_err(|e| format!("총 메시지 수 조회 실패: {}", e))?;

    params.push(Box::new(limit.unwrap_or(50)));
    params.push(Box::new(offset.unwrap_or(0)));

    let query_sql = format!(
        "SELECT MessageKey as id, Sender, MessageText, MessageBody, ReceiveDate, FilePath FROM tbl_recv {} ORDER BY ReceiveDate DESC, MessageKey DESC LIMIT ? OFFSET ?",
        where_clause
    );

    let mut stmt = conn
        .prepare(&query_sql)
        .map_err(|e| format!("tbl_recv 쿼리 준비 실패: {}", e))?;

    let iter = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| -> Result<Message, rusqlite::Error> {
                let id: i64 = row.get(0)?;
                let sender: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();

                // 1) MessageText가 있으면 우선 사용
                let text_ref = row.get_ref(2)?;
                let body_ref = row.get_ref(3)?;
                let receive_date: Option<String> = row.get(4)?;
                let file_path: Option<String> = row.get(5)?;

                // MessageText 처리
                let text_value = match text_ref {
                    ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                    ValueRef::Blob(b) => Some(
                        decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패")),
                    ),
                    _ => None,
                };

                // MessageBody 처리: {COMP} base64+brotli 또는 텍스트/블랍 그대로
                let mut prefer_body = false;
                let body_value = match body_ref {
                    ValueRef::Text(t) => {
                        let s = String::from_utf8_lossy(t).to_string();
                        if let Some(rest) = s.strip_prefix("{COMP}") {
                            prefer_body = true;
                            decode_comp_zlib_utf16le(rest)
                                .unwrap_or_else(|_| String::from("압축 해제 실패"))
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
                    if !t.is_empty() {
                        t
                    } else {
                        body_value
                    }
                } else {
                    body_value
                };

                // FilePath 파싱: |로 split하고 5+3n번째 인덱스에서 파일명 추출
                let file_paths = parse_file_paths(&file_path.unwrap_or_default());

                Ok(Message {
                    id,
                    sender,
                    content,
                    receive_date,
                    file_paths,
                })
            },
        )
        .map_err(|e| format!("tbl_recv 데이터 조회 실패: {}", e))?;

    let mut messages = Vec::new();
    for m in iter {
        messages.push(m.map_err(|e| format!("tbl_recv 데이터 처리 실패: {}", e))?);
    }

    // Get total count for pagination (respecting filters)
    let mut count_sql = String::from("SELECT COUNT(*) FROM tbl_recv");
    if !conditions.is_empty() {
        count_sql.push_str(" WHERE ");
        count_sql.push_str(&conditions.join(" AND "));
    }
    
    // Re-use params but remove limit/offset which are at the end
    let count_params_len = params.len() - (if limit.is_some() { 1 } else { 0 }) - (if offset.is_some() { 1 } else { 0 });
    let count_params_refs: Vec<&dyn ToSql> = params.iter().take(count_params_len).map(|p| p.as_ref()).collect();

    let mut total_count_stmt = conn.prepare(&count_sql)
        .map_err(|e| format!("총 개수 조회 쿼리 준비 실패: {}", e))?;
    let total_count: i64 = total_count_stmt.query_row(count_params_refs.as_slice(), |row| row.get(0)).map_err(|e| format!("총 개수 조회 실패: {}", e))?;

    Ok(PaginatedMessages {
        messages,
        total_count,
    })
}

#[tauri::command]
fn get_all_messages_for_sync(db_path: String) -> Result<Vec<Message>, String> {
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 연결 실패: {}", e))?;
    
    // tbl_recv 존재 확인
    if !table_exists(&conn, "tbl_recv").unwrap_or(false) {
        return Err("tbl_recv 테이블을 찾을 수 없습니다".into());
    }

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut query_sql = "SELECT MessageKey as id, Sender, MessageText, MessageBody, ReceiveDate, FilePath FROM tbl_recv ORDER BY MessageKey ASC".to_string();

    // Add limit and offset for pagination
    // Note: The original function `get_all_messages_for_sync` did not have limit/offset parameters.
    // This part of the instruction seems to be for a different function or a future change.
    // For `get_all_messages_for_sync`, we assume no limit/offset unless explicitly added to its signature.
    // If limit/offset were intended for this function, its signature would need to be updated.
    // As the instruction only provides a snippet for `query_map` and related parameter preparation,
    // and `get_all_messages_for_sync` is meant to get *all* messages,
    // I will apply the parameter preparation logic but keep the query without limit/offset for this specific function,
    // assuming the instruction snippet was a general example of parameter handling.
    // If the intent was to add pagination to `get_all_messages_for_sync`, the function signature would need modification.
    // For now, I'll ensure `params` is correctly prepared even if empty, and `query_map` uses it.

    let mut stmt = conn
        .prepare(&query_sql)
        .map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    // Use query_map for efficient row iteration
    // rusqlite's query_map needs params as a slice of &dyn ToSql
    let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    
    let iter = stmt
        .query_map(params_refs.as_slice(), |row| -> Result<Message, rusqlite::Error> {
            let id: i64 = row.get(0)?;
            let sender: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            let text_ref = row.get_ref(2)?;
            let body_ref = row.get_ref(3)?;
            let receive_date: Option<String> = row.get(4)?;
            let file_path: Option<String> = row.get(5)?;

            // MessageText 처리
            let text_value = match text_ref {
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(b) => Some(decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패"))),
                _ => None,
            };

            // MessageBody 처리
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

            let file_paths = parse_file_paths(&file_path.unwrap_or_default());

            Ok(Message {
                id,
                sender,
                content,
                receive_date,
                file_paths,
            })
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
        Ok(subkey) => match subkey.get_value::<String, _>(key) {
            Ok(v) => Ok(Some(v)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("레지스트리 읽기 실패: {}", e)),
        },
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

/// FilePath 값을 파싱하여 파일명 목록을 추출
/// |로 split하고 5+3n번째 인덱스(5, 8, 11, ...)에서 파일명 추출
fn parse_file_paths(file_path: &str) -> Vec<String> {
    if file_path.is_empty() {
        return Vec::new();
    }
    
    let parts: Vec<&str> = file_path.split('|').collect();
    let mut file_names = Vec::new();
    
    // 5+3n번째 인덱스: 5, 8, 11, 14, ...
    let mut index = 4;
    while index < parts.len() {
        let file_name = parts[index].trim();
        if !file_name.is_empty() {
            file_names.push(file_name.to_string());
        }
        index += 3;
    }
    
    file_names
}

/// 메신저의 기본 다운로드 경로를 레지스트리에서 읽어옴
#[tauri::command]
fn get_download_path() -> Result<Option<String>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(r"Software\Jiransoft\CoolMsg50\Option\GetFile") {
        Ok(subkey) => match subkey.get_value::<String, _>("DownPath") {
            Ok(v) => Ok(Some(v)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("레지스트리 읽기 실패: {}", e)),
        },
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("레지스트리 키 열기 실패: {}", e)),
    }
}

/// 파일이 존재하는지 확인
#[tauri::command]
fn check_file_exists(file_path: String) -> Result<bool, String> {
    Ok(fs::metadata(&file_path).is_ok())
}

/// 파일을 시스템 기본 프로그램으로 열기
#[tauri::command]
fn open_file(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("지원되지 않는 운영체제입니다".into())
    }
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
    zr.read_to_end(&mut out)
        .map_err(|e| format!("zlib inflate 실패: {}", e))?;
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
        // 윈도우가 보이는 상태인지 확인
        if let Ok(is_visible) = w.is_visible() {
            if is_visible {
                #[cfg(target_os = "windows")]
                {
                    // Windows에서 포커스가 있는 상태에서 hide가 제대로 동작하지 않을 수 있음
                    // 윈도우 핸들을 가져와서 직접 숨기기
                    if let Ok(hwnd) = w.hwnd() {
                        unsafe {
                            // windows::Win32::Foundation::HWND를 winapi HWND로 변환
                            // hwnd.0은 *mut std::ffi::c_void 타입이므로 usize로 변환 후 다시 포인터로 변환
                            let hwnd_ptr: *mut std::ffi::c_void = hwnd.0;
                            let hwnd_addr = hwnd_ptr as usize;
                            let winapi_hwnd = hwnd_addr as *mut winapi::ctypes::c_void;
                            ShowWindow(winapi_hwnd as _, SW_HIDE);
                        }
                        return;
                    }
                }
                // Windows가 아니거나 hwnd를 가져올 수 없는 경우 일반 hide 사용
                let _ = w.hide();
            }
        } else {
            // is_visible() 실패 시에도 hide 시도
            let _ = w.hide();
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd) = w.hwnd() {
                unsafe {
                    let hwnd_ptr: *mut std::ffi::c_void = hwnd.0;
                    let hwnd_addr = hwnd_ptr as usize;
                    let winapi_hwnd = hwnd_addr as *mut winapi::ctypes::c_void;
                    ShowWindow(winapi_hwnd as _, SW_SHOW);
                    ShowWindow(winapi_hwnd as _, SW_RESTORE);
                    SetForegroundWindow(winapi_hwnd as _);
                }
            }
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn register_custom_scheme() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    use std::env;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = std::path::Path::new("Software").join("Classes").join("hypercool");
    let (key, _) = hkcu.create_subkey(&path).map_err(|e| e.to_string())?;

    key.set_value("", &"URL:HyperCool Protocol").map_err(|e| e.to_string())?;
    key.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;

    let shell = key.create_subkey("shell").map_err(|e| e.to_string())?.0;
    let open = shell.create_subkey("open").map_err(|e| e.to_string())?.0;
    let command = open.create_subkey("command").map_err(|e| e.to_string())?.0;

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_path_str = exe_path.to_str().ok_or("Failed to convert path to string")?;
    
    let command_str = format!("\"{}\" \"%1\"", exe_path_str);
    command.set_value("", &command_str).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn close_message_viewer(app: tauri::AppHandle, message_id: i64) -> Result<(), String> {
    let window_label = format!("message-viewer-{}", message_id);
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
async fn open_message_viewer(app: tauri::AppHandle, message_id: i64) -> Result<(), String> {
    // 이미 열려있는지 확인 (같은 메시지 ID로)
    let window_label = format!("message-viewer-{}", message_id);
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    
    // 메시지 ID만 전달 (데이터베이스에서 직접 로드)
    let url = if cfg!(dev) {
        tauri::WebviewUrl::External(
            std::str::FromStr::from_str(&format!("http://localhost:1420/message-viewer.html?id={}", message_id))
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        tauri::WebviewUrl::App(format!("message-viewer.html?id={}", message_id).into())
    };
    
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &window_label,
        url,
    )
    .title(&format!("메시지 #{}", message_id))
    .inner_size(500.0, 400.0)
    .min_inner_size(400.0, 300.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .build()
    .map_err(|e| format!("메시지 뷰어 윈도우 생성 실패: {}", e))?;
    
    apply_vibrancy_effect(&window);
    
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
async fn set_calendar_widget_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("calendar-widget") {
        // resizable 설정
        window
            .set_resizable(pinned)
            .map_err(|e| format!("윈도우 resizable 설정 실패: {}", e))?;
        
        // 레지스트리에 핀 상태 저장
        let _ = set_registry_value("CalendarWidgetPinned".to_string(), pinned.to_string());
        
        Ok(())
    } else {
        Err("달력 위젯 윈도우를 찾을 수 없습니다".into())
    }
}

#[tauri::command]
async fn get_calendar_widget_pinned(_app: tauri::AppHandle) -> Result<bool, String> {
    match get_registry_value("CalendarWidgetPinned".to_string()) {
        Ok(Some(value)) => {
            value.parse::<bool>().map_err(|e| format!("핀 상태 파싱 실패: {}", e))
        }
        Ok(None) => Ok(false), // 기본값은 false (고정되지 않음)
        Err(e) => Err(e)
    }
}

#[tauri::command]
async fn set_school_widget_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("school-widget") {
        // resizable 설정
        window
            .set_resizable(pinned)
            .map_err(|e| format!("윈도우 resizable 설정 실패: {}", e))?;
        
        // 레지스트리에 핀 상태 저장
        let _ = set_registry_value("SchoolWidgetPinned".to_string(), pinned.to_string());
        
        Ok(())
    } else {
        Err("학교 위젯 윈도우를 찾을 수 없습니다".into())
    }
}

#[tauri::command]
async fn get_school_widget_pinned(_app: tauri::AppHandle) -> Result<bool, String> {
    match get_registry_value("SchoolWidgetPinned".to_string()) {
        Ok(Some(value)) => {
            value.parse::<bool>().map_err(|e| format!("핀 상태 파싱 실패: {}", e))
        }
        Ok(None) => Ok(true), // 기본값은 true (resizable)
        Err(e) => Err(e)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_auto_start(enabled: bool) -> Result<(), String> {
    use std::env;
    use winreg::enums::*;
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = r"Software\Microsoft\Windows\CurrentVersion\Run";
    
    let (key, _) = hkcu
        .create_subkey(run_key)
        .map_err(|e| format!("레지스트리 키 생성 실패: {}", e))?;
    
    let app_name = "HyperCool";
    let exe_path = env::current_exe()
        .map_err(|e| format!("실행 파일 경로 가져오기 실패: {}", e))?
        .to_string_lossy()
        .to_string();
    
    if enabled {
        key.set_value(app_name, &exe_path)
            .map_err(|e| format!("자동 실행 설정 실패: {}", e))?;
    } else {
        let _ = key.delete_value(app_name);
    }
    
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_auto_start(_enabled: bool) -> Result<(), String> {
    Err("자동 실행 기능은 Windows에서만 지원됩니다.".to_string())
}

#[tauri::command]
async fn open_calendar_widget(app: tauri::AppHandle) -> Result<(), String> {
    // 이미 열려있는지 확인
    if let Some(window) = app.get_webview_window("calendar-widget") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(()); // 이미 열려있으면 포커스만 주기
    }
    
    let url = if cfg!(dev) {
        // 개발 모드에서는 외부 URL 사용
        // Tauri 2.0에서는 WebviewUrl::External이 자동으로 URL을 파싱합니다
        tauri::WebviewUrl::External(
            std::str::FromStr::from_str("http://localhost:1420/calendar-widget.html")
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        // 프로덕션에서는 앱 내부 파일 사용
        tauri::WebviewUrl::App("calendar-widget.html".into())
    };
    
    // 저장된 위치와 크기 불러오기
    let saved_bounds: Option<WindowBounds> = match get_registry_value("CalendarWidgetBounds".to_string()) {
        Ok(Some(json_str)) => {
            serde_json::from_str(&json_str).ok()
        }
        _ => None
    };
    
    // 저장된 핀 상태 확인
    let is_pinned = match get_registry_value("CalendarWidgetPinned".to_string()) {
        Ok(Some(value)) => value.parse::<bool>().unwrap_or(false),
        _ => false, // 기본값은 false (고정되지 않음)
    };
    
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "calendar-widget",
        url,
    )
    .title("달력 위젯")
    .min_inner_size(350.0, 450.0)
    .resizable(is_pinned) // 핀 상태에 따라 resizable 설정
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(true);
    
    // 기본 크기 설정 (저장된 값이 있으면 나중에 덮어씀)
    if saved_bounds.is_none() {
        builder = builder.inner_size(400.0, 500.0);
    }
    
    let window = builder
        .build()
        .map_err(|e| format!("달력 위젯 윈도우 생성 실패: {}", e))?;
    
    // 저장된 위치와 크기가 있으면 윈도우 생성 후 명시적으로 설정
    // borderless 윈도우에서는 builder의 position이 정확히 작동하지 않을 수 있으므로
    // 윈도우 생성 후 set_position과 set_size를 사용
    if let Some(bounds) = saved_bounds {
        // 윈도우가 완전히 초기화될 때까지 약간 대기
        std::thread::sleep(Duration::from_millis(100));
        
        // 위치 설정: outer_position으로 저장했으므로 Physical 좌표로 설정
        // Windows에서는 일반적으로 Physical 좌표를 사용
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: bounds.x as i32,
            y: bounds.y as i32,
        }));
        
        // 크기 설정: inner_size로 저장했으므로 Physical 크기로 설정
        // inner_size()는 PhysicalSize<u32>를 반환하므로 Physical로 저장/불러오기
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: bounds.width as u32,
            height: bounds.height as u32,
        }));
        
        // 위치와 크기 설정 후 다시 확인하여 정확히 적용되었는지 확인
        // (필요시 추가 조정)
    }
    
    // Apply window vibrancy (Windows: Acrylic; macOS: Vibrancy; fallback: Blur)
    apply_vibrancy_effect(&window);
    
    // Windows에서 윈도우를 데스크톱 뒤로 보내기
    #[cfg(target_os = "windows")]
    {
        let window_title = "달력 위젯";
        let title_wide: Vec<u16> = OsStr::new(window_title).encode_wide().chain(Some(0)).collect();
        
        // 윈도우가 완전히 생성될 때까지 약간 대기
        std::thread::sleep(Duration::from_millis(200));
        
        unsafe {
            let hwnd = FindWindowW(std::ptr::null_mut(), title_wide.as_ptr());
            if !hwnd.is_null() {
                // 윈도우를 Z-order의 맨 아래로 보내기 (데스크톱 뒤로)
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
    
    // 디바운싱을 위한 타이머
    let save_timer: std::sync::Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = std::sync::Arc::new(Mutex::new(None));
    
    // 윈도우 위치와 크기를 저장하는 헬퍼 함수
    let save_bounds = |window: &tauri::WebviewWindow<_>| {
        // outer_position과 inner_size를 사용
        // outer_position()은 PhysicalPosition<i32>를 직접 반환
        // inner_size()는 PhysicalSize<u32>를 직접 반환
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            // PhysicalPosition에서 Physical 좌표 추출
            let x = position.x as f64;
            let y = position.y as f64;
            // PhysicalSize에서 Physical 크기 추출 (u32 -> f64 변환)
            let width = size.width as f64;
            let height = size.height as f64;
            
            let bounds = WindowBounds { x, y, width, height };
            if let Ok(json) = serde_json::to_string(&bounds) {
                let _ = set_registry_value("CalendarWidgetBounds".to_string(), json);
            }
        }
    };
    
    // 윈도우 위치와 크기 저장을 위한 이벤트 리스너
    let window_clone = window.clone();
    let save_timer_clone = save_timer.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                // 디바운싱: 기존 타이머가 있으면 취소하고 새로 시작
                let mut timer_guard = save_timer_clone.lock().unwrap();
                let _ = timer_guard.take(); // 기존 타이머는 무시하고 새로 시작
                
                let window_for_save = window_clone.clone();
                let timer_clone = save_timer_clone.clone();
                let handle = std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    save_bounds(&window_for_save);
                    // 타이머 완료 후 정리
                    let _ = timer_clone.lock().unwrap().take();
                });
                *timer_guard = Some(handle);
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                // 윈도우가 닫힐 때 최종 위치 저장 (즉시)
                save_bounds(&window_clone);
            }
            tauri::WindowEvent::Focused(false) => {
                // 포커스를 잃었을 때 위치 저장
                // 새로운 아크릴 효과는 포커스가 없어도 유지되므로 재적용 불필요
                save_bounds(&window_clone);
            }
            _ => {}
        }
    });
    
    // 윈도우가 보여질 때도 위치 저장 (초기 위치 확인)
    let window_for_init = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1000)); // 윈도우가 완전히 로드된 후
        save_bounds(&window_for_init);
    });
    
    Ok(())
}

/// 현재 시간이 수업 시간인지 확인하는 함수
fn is_class_time() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let reg_base = REG_BASE;

    let class_times_json = match hkcu.open_subkey(reg_base) {
        Ok(subkey) => match subkey.get_value::<String, _>("ClassTimes") {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        },
        _ => None,
    };

    // 수업 시간이 설정되지 않았으면 false 반환 (항상 표시)
    let class_times: Vec<String> = match class_times_json {
        Some(json) => match serde_json::from_str::<Vec<String>>(&json) {
            Ok(times) if !times.is_empty() => times,
            _ => return false,
        },
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



mod timetable_parser;
mod school_data;

#[derive(serde::Serialize)]
struct AttendanceResponse {
    data: Vec<school_data::LatecomerData>,
    debug_html: String,
}

#[derive(serde::Serialize)]
struct PointsResponse {
    data: Vec<school_data::PointsData>,
    debug_html: String,
}

#[tauri::command]
async fn get_timetable_data() -> Result<timetable_parser::TimetableData, String> {
    tokio::task::spawn_blocking(|| {
        timetable_parser::parse_timetable()
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_meal_data(date: String, atpt_code: String, school_code: String) -> Result<school_data::MealData, String> {
    tokio::task::spawn_blocking(move || {
        school_data::fetch_meal_data(&date, &atpt_code, &school_code)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_attendance_data(grade: String, class: String) -> Result<AttendanceResponse, String> {
    tokio::task::spawn_blocking(move || {
        let (data, debug_html) = school_data::fetch_attendance_data(&grade, &class)?;
        Ok(AttendanceResponse { data, debug_html })
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_points_data(grade: String, class: String) -> Result<PointsResponse, String> {
    tokio::task::spawn_blocking(move || {
        let (data, debug_html) = school_data::fetch_points_data(&grade, &class)?;
        Ok(PointsResponse { data, debug_html })
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn open_school_widget(app: tauri::AppHandle) -> Result<(), String> {
    // 이미 열려있는지 확인
    if let Some(window) = app.get_webview_window("school-widget") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    
    let url = if cfg!(dev) {
        tauri::WebviewUrl::External(
            std::str::FromStr::from_str("http://localhost:1420/school-widget.html")
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        tauri::WebviewUrl::App("school-widget.html".into())
    };
    
    // 저장된 위치와 크기 불러오기
    let saved_bounds: Option<WindowBounds> = match get_registry_value("SchoolWidgetBounds".to_string()) {
        Ok(Some(json_str)) => {
            serde_json::from_str(&json_str).ok()
        }
        _ => None
    };
    
    // 저장된 핀 상태 확인
    let is_pinned = match get_registry_value("SchoolWidgetPinned".to_string()) {
        Ok(Some(value)) => value.parse::<bool>().unwrap_or(true), // 기본값은 true (resizable)
        _ => true, // 기본값은 true (resizable)
    };
    
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "school-widget",
        url,
    )
    .title("학교 위젯")
    .resizable(is_pinned) // 핀 상태에 따라 resizable 설정
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(true);
    
    // 기본 크기 설정 (저장된 값이 있으면 나중에 덮어씀)
    if saved_bounds.is_none() {
        builder = builder.inner_size(900.0, 700.0);
    }
    
    let window = builder
        .build()
        .map_err(|e| format!("학교 위젯 윈도우 생성 실패: {}", e))?;
    
    // 저장된 위치와 크기가 있으면 윈도우 생성 후 명시적으로 설정
    if let Some(bounds) = saved_bounds {
        std::thread::sleep(Duration::from_millis(100));
        
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: bounds.x as i32,
            y: bounds.y as i32,
        }));
        
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: bounds.width as u32,
            height: bounds.height as u32,
        }));
    }
    
    // Apply window vibrancy (Windows: Acrylic; macOS: Vibrancy; fallback: Blur)
    apply_vibrancy_effect(&window);
    
    // 디바운싱을 위한 타이머
    let save_timer: std::sync::Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = std::sync::Arc::new(Mutex::new(None));
    
    // 윈도우 위치와 크기를 저장하는 헬퍼 함수
    let save_bounds = |window: &tauri::WebviewWindow<_>| {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let x = position.x as f64;
            let y = position.y as f64;
            let width = size.width as f64;
            let height = size.height as f64;
            
            let bounds = WindowBounds { x, y, width, height };
            if let Ok(json) = serde_json::to_string(&bounds) {
                let _ = set_registry_value("SchoolWidgetBounds".to_string(), json);
            }
        }
    };
    
    // 윈도우 위치와 크기 저장을 위한 이벤트 리스너
    let window_clone = window.clone();
    let save_timer_clone = save_timer.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let mut timer_guard = save_timer_clone.lock().unwrap();
                let _ = timer_guard.take();
                
                let window_clone_inner = window_clone.clone();
                let handle = std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    save_bounds(&window_clone_inner);
                });
                *timer_guard = Some(handle);
            }
            _ => {}
        }
    });
    
    Ok(())
}

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
            show_main_window(app);
            
            // Windows: Deep link is passed as an argument to the second instance
            for arg in args {
                if arg.starts_with("hypercool://") {
                    let _ = app.emit("deep-link-url", arg);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            read_udb_messages,
            get_registry_value,
            set_registry_value,
            notify_hidden,
            hide_main_window,
            search_messages,
            get_message_by_id,
            open_calendar_widget,
            open_message_viewer,
            close_message_viewer,
            set_calendar_widget_pinned,
            get_calendar_widget_pinned,
            set_school_widget_pinned,
            get_school_widget_pinned,
            set_auto_start,
            get_timetable_data,
            get_meal_data,
            get_attendance_data,
            get_points_data,
            open_school_widget,
            get_download_path,
            check_file_exists,
            open_file,
            get_all_messages_for_sync
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                // Ensure custom scheme is registered on startup
                if let Err(e) = register_custom_scheme() {
                    eprintln!("Failed to register custom scheme: {}", e);
                }
            }

            // Apply window vibrancy (Windows: Acrylic; macOS: Vibrancy; fallback: Blur)
            if let Some(win) = app.get_webview_window("main") {
                apply_vibrancy_effect(&win);
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
                        show_main_window(app);
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
                            show_main_window(app);
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
                let hide_main = match get_registry_value("AutoStartHideMain".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if hide_main {
                    if let Some(window) = app_handle_for_auto_start.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                
                // 달력 위젯 자동 실행 확인
                let auto_start_calendar = match get_registry_value("AutoStartCalendar".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if auto_start_calendar {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = open_calendar_widget(app_handle_for_auto_start.clone()).await;
                }
                
                // 학교 위젯 자동 실행 확인
                let auto_start_school = match get_registry_value("AutoStartSchool".to_string()) {
                    Ok(Some(value)) => value == "true",
                    _ => false,
                };
                
                if auto_start_school {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = open_school_widget(app_handle_for_auto_start.clone()).await;
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
                            read_udb_messages_internal(path.clone(), Some(1), Some(0), None, None)
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
                                if let Ok(result) =
                                    read_udb_messages_internal(path.clone(), Some(1), Some(0), None, None)
                                {
                                    if let Some(current_id) = result.messages.first().map(|m| m.id)
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
