use crate::models::{CacheState, Message, PaginatedMessages, SearchResultItem};
use crate::utils::{decompress_brotli, decode_comp_zlib_utf16le, parse_file_paths, table_exists, apply_vibrancy_effect};
use rusqlite::{Connection, ToSql, types::ValueRef};
use std::fs;
use tauri::{State, Manager, WebviewUrl};

/// UDB 파일에서 메시지를 읽어오는 내부 함수 (watchdog 등에서 직접 호출 가능)
pub fn read_udb_messages_internal(
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

/// UDB 파일에서 가장 최신 메시지 ID만 빠르게 조회하는 함수 (Watchdog용)
pub fn get_latest_message_id_internal(db_path: String) -> Result<Option<i64>, String> {
    if !fs::metadata(&db_path).is_ok() {
        return Err(format!("데이터베이스 파일을 찾을 수 없습니다: {}", db_path));
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("데이터베이스 연결 실패: {}", e))?;

    if !table_exists(&conn, "tbl_recv").unwrap_or(false) {
        return Ok(None);
    }

    let mut stmt = conn.prepare("SELECT MAX(MessageKey) FROM tbl_recv").map_err(|e| format!("MAX ID 쿼리 준비 실패: {}", e))?;
    let max_id: Option<i64> = stmt.query_row([], |row| row.get(0)).map_err(|e| format!("MAX ID 조회 실패: {}", e))?;

    Ok(max_id)
}

/// UDB 파일에서 메시지를 읽어오는 함수 (Tauri command)
#[tauri::command]
pub fn read_udb_messages(
    db_path: String,
    limit: Option<i64>,
    offset: Option<i64>,
    search_term: Option<String>,
    min_id: Option<i64>,
) -> Result<PaginatedMessages, String> {
    read_udb_messages_internal(db_path, limit, offset, search_term, min_id)
}

#[tauri::command]
pub fn search_messages(
    db_path: String,
    search_term: String,
    cache: State<'_, CacheState>,
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
        "SELECT MessageKey, Sender, substr(MessageText, 1, 100) FROM tbl_recv WHERE Sender LIKE ?1 OR MessageText LIKE ?1 ORDER BY ReceiveDate DESC, MessageKey DESC LIMIT 100"
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
pub fn get_message_by_id(db_path: String, id: i64) -> Result<Message, String> {
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 연결 실패: {}", e))?;
    conn.query_row(
        "SELECT MessageKey, Sender, MessageText, MessageBody, ReceiveDate, FilePath FROM tbl_recv WHERE MessageKey = ?1",
        [id],
        |row| {
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

fn read_from_recv_only(
    conn: &Connection,
    limit: Option<i64>,
    offset: Option<i64>,
    search_term: Option<String>,
    min_id: Option<i64>,
) -> Result<PaginatedMessages, String> {
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
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

                let text_ref = row.get_ref(2)?;
                let body_ref = row.get_ref(3)?;
                let receive_date: Option<String> = row.get(4)?;
                let file_path: Option<String> = row.get(5)?;

                let text_value = match text_ref {
                    ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                    ValueRef::Blob(b) => Some(
                        decompress_brotli(b).unwrap_or_else(|_| String::from("압축 해제 실패")),
                    ),
                    _ => None,
                };

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
pub fn get_all_messages_for_sync(db_path: String) -> Result<Vec<Message>, String> {
    let conn = Connection::open(&db_path).map_err(|e| format!("DB 연결 실패: {}", e))?;
    
    if !table_exists(&conn, "tbl_recv").unwrap_or(false) {
        return Err("tbl_recv 테이블을 찾을 수 없습니다".into());
    }

    let params: Vec<Box<dyn ToSql>> = Vec::new();
    let query_sql = "SELECT MessageKey as id, Sender, MessageText, MessageBody, ReceiveDate, FilePath FROM tbl_recv ORDER BY MessageKey ASC".to_string();

    let mut stmt = conn
        .prepare(&query_sql)
        .map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    
    let iter = stmt
        .query_map(params_refs.as_slice(), |row| -> Result<Message, rusqlite::Error> {
            let id: i64 = row.get(0)?;
            let sender: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
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

#[tauri::command]
pub async fn close_message_viewer(app: tauri::AppHandle, message_id: i64) -> Result<(), String> {
    let window_label = format!("message-viewer-{}", message_id);
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn open_message_viewer(app: tauri::AppHandle, message_id: i64) -> Result<(), String> {
    let window_label = format!("message-viewer-{}", message_id);
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    
    let url = if cfg!(dev) {
        WebviewUrl::External(
            std::str::FromStr::from_str(&format!("http://localhost:1420/message-viewer.html?id={}", message_id))
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        WebviewUrl::App(format!("message-viewer.html?id={}", message_id).into())
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
