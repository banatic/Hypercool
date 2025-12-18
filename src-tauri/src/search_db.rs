use rusqlite::{params, Connection, Result as SqliteResult};
use tauri::{AppHandle, Manager};
use serde::{Serialize, Deserialize};
use std::time::Instant;

use crate::models::SearchResultItem;
use crate::utils::{decompress_brotli, decode_comp_zlib_utf16le, parse_file_paths};

/// Sync statistics returned after synchronization
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncStats {
    pub new_messages: usize,
    pub updated_messages: usize,
    pub total_messages: usize,
    pub duration_ms: u64,
}

/// Search database statistics
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchDbStats {
    pub total_messages: i64,
    pub last_sync_time: i64,
    pub last_message_id: i64,
    pub db_size_bytes: u64,
}

/// Cached message structure (stored in search DB)
#[derive(Serialize, Clone, Debug)]
pub struct CachedMessage {
    pub id: i64,
    pub sender: String,
    pub content: String,
    pub content_preview: String,
    pub receive_date: Option<String>,
    pub file_paths: Vec<String>,
}

/// Get the path to the search database
fn get_search_db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }
    Ok(app_dir.join("hypercool_search.db"))
}

/// Get a connection to the search database
fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_path = get_search_db_path(app)?;
    Connection::open(db_path).map_err(|e| e.to_string())
}

/// Initialize the search database schema with FTS5
pub fn init_search_db(app: &AppHandle) -> Result<(), String> {
    let db_path = get_search_db_path(app)?;
    let conn = Connection::open(&db_path).map_err(|e| format!("검색 DB 연결 실패: {}", e))?;
    
    // Enable WAL mode for better concurrent access
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
    
    // Main messages table with metadata
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            sender TEXT NOT NULL,
            content TEXT NOT NULL,
            content_preview TEXT,
            receive_date TEXT,
            file_paths TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    ).map_err(|e| format!("messages 테이블 생성 실패: {}", e))?;
    
    // Check if FTS5 table exists - if not, create it
    let fts_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='messages_fts'",
        [],
        |row| row.get(0),
    ).unwrap_or(false);
    
    if !fts_exists {
        // FTS5 virtual table for full-text search
        // Using unicode61 tokenizer for better Korean support
        conn.execute(
            "CREATE VIRTUAL TABLE messages_fts USING fts5(
                sender,
                content,
                content='messages',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 0'
            )",
            [],
        ).map_err(|e| format!("FTS5 테이블 생성 실패: {}", e))?;
        
        // Create triggers to keep FTS index in sync with messages table
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, sender, content) 
                VALUES (new.id, new.sender, new.content);
            END;
            
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, sender, content) 
                VALUES ('delete', old.id, old.sender, old.content);
            END;
            
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, sender, content) 
                VALUES ('delete', old.id, old.sender, old.content);
                INSERT INTO messages_fts(rowid, sender, content) 
                VALUES (new.id, new.sender, new.content);
            END;"
        ).map_err(|e| format!("FTS 트리거 생성 실패: {}", e))?;
    }
    
    // Sync metadata table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_sync_time INTEGER NOT NULL,
            last_message_id INTEGER NOT NULL,
            total_messages INTEGER NOT NULL
        )",
        [],
    ).map_err(|e| format!("sync_metadata 테이블 생성 실패: {}", e))?;
    
    // Create indexes for common queries
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_receive_date ON messages(receive_date);
         CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);"
    ).map_err(|e| format!("인덱스 생성 실패: {}", e))?;
    
    Ok(())
}

/// Check if sync is needed (last sync was more than 5 minutes ago)
pub fn should_sync(app: &AppHandle) -> Result<bool, String> {
    let conn = get_connection(app)?;
    
    let last_sync: Option<i64> = conn.query_row(
        "SELECT last_sync_time FROM sync_metadata WHERE id = 1",
        [],
        |row| row.get(0),
    ).ok();
    
    match last_sync {
        Some(time) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            Ok(now - time > 300) // 5 minutes
        }
        None => Ok(true), // Never synced
    }
}

/// Get sync metadata
fn get_sync_metadata(conn: &Connection) -> Option<(i64, i64, i64)> {
    conn.query_row(
        "SELECT last_sync_time, last_message_id, total_messages FROM sync_metadata WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok()
}

/// Update sync metadata
fn update_sync_metadata(conn: &Connection, last_message_id: i64, total_messages: i64) -> SqliteResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    
    conn.execute(
        "INSERT OR REPLACE INTO sync_metadata (id, last_sync_time, last_message_id, total_messages) 
         VALUES (1, ?1, ?2, ?3)",
        params![now, last_message_id, total_messages],
    )?;
    Ok(())
}

/// Extract preview text (first 200 characters)
fn extract_preview(content: &str) -> String {
    // Remove HTML tags for preview
    let text = content
        .replace("<br>", " ")
        .replace("<br/>", " ")
        .replace("<br />", " ");
    
    // Simple HTML tag removal
    let mut result = String::new();
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    
    // Truncate to 200 chars
    if result.chars().count() > 200 {
        result.chars().take(200).collect::<String>() + "..."
    } else {
        result
    }
}

/// Sync messages from UDB to search database
#[tauri::command]
pub fn sync_search_db(app: AppHandle, udb_path: String) -> Result<SyncStats, String> {
    sync_from_udb(&app, udb_path)
}

/// Internal sync function
pub fn sync_from_udb(app: &AppHandle, udb_path: String) -> Result<SyncStats, String> {
    let start_time = Instant::now();
    
    if !std::fs::metadata(&udb_path).is_ok() {
        return Err(format!("UDB 파일을 찾을 수 없습니다: {}", udb_path));
    }
    
    let search_conn = get_connection(app)?;
    let udb_conn = Connection::open(&udb_path).map_err(|e| format!("UDB 연결 실패: {}", e))?;
    
    // Check if tbl_recv exists in UDB
    let table_exists: bool = udb_conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='tbl_recv'",
        [],
        |row| row.get(0),
    ).unwrap_or(false);
    
    if !table_exists {
        return Err("UDB에서 tbl_recv 테이블을 찾을 수 없습니다".into());
    }
    
    // Get last synced message ID
    let last_synced_id = get_sync_metadata(&search_conn)
        .map(|(_, id, _)| id)
        .unwrap_or(0);
    
    // Query new messages from UDB
    let mut stmt = udb_conn.prepare(
        "SELECT MessageKey, Sender, MessageText, MessageBody, ReceiveDate, FilePath 
         FROM tbl_recv 
         WHERE MessageKey > ?1 
         ORDER BY MessageKey ASC"
    ).map_err(|e| format!("UDB 쿼리 준비 실패: {}", e))?;
    
    let mut new_count = 0;
    let mut max_id = last_synced_id;
    
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    
    // Begin transaction for performance
    search_conn.execute("BEGIN TRANSACTION", []).map_err(|e| e.to_string())?;
    
    {
        let mut insert_stmt = search_conn.prepare(
            "INSERT OR REPLACE INTO messages (id, sender, content, content_preview, receive_date, file_paths, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).map_err(|e| format!("삽입 쿼리 준비 실패: {}", e))?;
        
        let rows = stmt.query_map([last_synced_id], |row| {
            let id: i64 = row.get(0)?;
            let sender: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            let receive_date: Option<String> = row.get(4)?;
            let file_path: Option<String> = row.get(5)?;
            
            // Process message text (handle compression)
            let text_ref = row.get_ref(2)?;
            let body_ref = row.get_ref(3)?;
            
            let text_value = match text_ref {
                rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).to_string()),
                rusqlite::types::ValueRef::Blob(b) => Some(decompress_brotli(b).unwrap_or_else(|_| String::from(""))),
                _ => None,
            };
            
            let mut prefer_body = false;
            let body_value = match body_ref {
                rusqlite::types::ValueRef::Text(t) => {
                    let s = String::from_utf8_lossy(t).to_string();
                    if let Some(rest) = s.strip_prefix("{COMP}") {
                        prefer_body = true;
                        decode_comp_zlib_utf16le(rest).unwrap_or_else(|_| String::from(""))
                    } else { 
                        s 
                    }
                }
                rusqlite::types::ValueRef::Blob(b) => {
                    prefer_body = true;
                    decompress_brotli(b).unwrap_or_else(|_| String::from(""))
                }
                _ => String::new(),
            };
            
            let content = if prefer_body {
                body_value
            } else if let Some(t) = text_value {
                if !t.is_empty() { t } else { body_value }
            } else { 
                body_value 
            };
            
            let file_paths = parse_file_paths(&file_path.unwrap_or_default());
            
            Ok((id, sender, content, receive_date, file_paths))
        }).map_err(|e| format!("UDB 쿼리 실행 실패: {}", e))?;
        
        for row_result in rows {
            match row_result {
                Ok((id, sender, content, receive_date, file_paths)) => {
                    let preview = extract_preview(&content);
                    let file_paths_json = serde_json::to_string(&file_paths).unwrap_or_default();
                    
                    insert_stmt.execute(params![
                        id,
                        sender,
                        content,
                        preview,
                        receive_date,
                        file_paths_json,
                        now_ts,
                        now_ts
                    ]).map_err(|e| format!("메시지 삽입 실패: {}", e))?;
                    
                    new_count += 1;
                    if id > max_id {
                        max_id = id;
                    }
                }
                Err(e) => {
                    eprintln!("메시지 처리 오류: {}", e);
                }
            }
        }
    }
    
    // Get total message count
    let total_messages: i64 = search_conn.query_row(
        "SELECT COUNT(*) FROM messages",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    
    // Update sync metadata
    update_sync_metadata(&search_conn, max_id, total_messages)
        .map_err(|e| format!("동기화 메타데이터 업데이트 실패: {}", e))?;
    
    // Commit transaction
    search_conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    
    let duration_ms = start_time.elapsed().as_millis() as u64;
    
    Ok(SyncStats {
        new_messages: new_count,
        updated_messages: 0,
        total_messages: total_messages as usize,
        duration_ms,
    })
}

/// Search messages using FTS5
#[tauri::command]
pub fn search_messages_fts(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResultItem>, String> {
    search_fts_internal(&app, query, limit.unwrap_or(100))
}

/// Strip HTML tags from text, including truncated tags at start/end
fn strip_html_tags(input: &str) -> String {
    use regex::Regex;
    
    // Skip JSON-like content (shouldn't be displayed as snippet)
    let trimmed = input.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') || 
       trimmed.contains("\":") || trimmed.contains("\":[") ||
       trimmed.contains("\"cp\":") || trimmed.contains("\"ru\":") {
        return String::new();
    }
    
    // Remove complete HTML tags
    let tag_regex = Regex::new(r"<[^>]*>").unwrap();
    let mut result = tag_regex.replace_all(input, "").to_string();
    
    // Remove truncated tag at the END: "<div style=..."
    if let Some(last_open) = result.rfind('<') {
        if result[last_open..].find('>').is_none() {
            result = result[..last_open].to_string();
        }
    }
    
    // Remove truncated tag at the START: '...rgb(0,0,0);">'
    if let Some(first_close) = result.find('>') {
        if result[..first_close].find('<').is_none() {
            result = result[first_close + 1..].to_string();
        }
    }
    
    // Decode common HTML entities
    result
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .trim()
        .to_string()
}

/// Internal FTS search function
pub fn search_fts_internal(
    app: &AppHandle,
    query: String,
    limit: usize,
) -> Result<Vec<SearchResultItem>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    
    let conn = get_connection(app)?;
    
    // Escape special FTS5 characters and prepare query
    let escaped_query = query
        .replace("\"", "\"\"")
        .replace("*", "")
        .replace(":", " ");
    
    // Use MATCH for FTS5 search, but show beginning of message (not matched portion)
    let mut stmt = conn.prepare(
        "SELECT m.id, m.sender, 
                substr(m.content, 1, 150) AS snippet,
                m.receive_date
         FROM messages_fts 
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?1
         ORDER BY m.receive_date DESC
         LIMIT ?2"
    ).map_err(|e| format!("검색 쿼리 준비 실패: {}", e))?;
    
    // Try prefix search first (e.g., "학교*" for "학교")
    let fts_query = format!("\"{}\"*", escaped_query);
    
    let results: Vec<SearchResultItem> = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            let raw_snippet: String = row.get(2)?;
            Ok(SearchResultItem {
                id: row.get(0)?,
                sender: row.get(1)?,
                snippet: strip_html_tags(&raw_snippet),
                receive_date: row.get(3)?,
            })
        })
        .map_err(|e| format!("검색 실행 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    
    // If no results with prefix search, try contains search
    if results.is_empty() {
        let fallback_query = format!("\"{}\"", escaped_query);
        let results: Vec<SearchResultItem> = stmt
            .query_map(params![fallback_query, limit as i64], |row| {
                let raw_snippet: String = row.get(2)?;
                Ok(SearchResultItem {
                    id: row.get(0)?,
                    sender: row.get(1)?,
                    snippet: strip_html_tags(&raw_snippet),
                    receive_date: row.get(3)?,
                })
            })
            .map_err(|e| format!("폴백 검색 실행 실패: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        
        return Ok(results);
    }
    
    Ok(results)
}

/// Get a cached message by ID
#[tauri::command]
pub fn get_cached_message(app: AppHandle, message_id: i64) -> Result<Option<CachedMessage>, String> {
    let conn = get_connection(&app)?;
    
    let result = conn.query_row(
        "SELECT id, sender, content, content_preview, receive_date, file_paths 
         FROM messages WHERE id = ?1",
        [message_id],
        |row| {
            let file_paths_json: String = row.get(5)?;
            let file_paths: Vec<String> = serde_json::from_str(&file_paths_json).unwrap_or_default();
            
            Ok(CachedMessage {
                id: row.get(0)?,
                sender: row.get(1)?,
                content: row.get(2)?,
                content_preview: row.get(3)?,
                receive_date: row.get(4)?,
                file_paths,
            })
        },
    );
    
    match result {
        Ok(msg) => Ok(Some(msg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("메시지 조회 실패: {}", e)),
    }
}

/// Get search database statistics
#[tauri::command]
pub fn get_search_db_stats(app: AppHandle) -> Result<SearchDbStats, String> {
    let db_path = get_search_db_path(&app)?;
    let conn = get_connection(&app)?;
    
    let (last_sync_time, last_message_id, total_messages) = get_sync_metadata(&conn)
        .unwrap_or((0, 0, 0));
    
    let db_size_bytes = std::fs::metadata(&db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    Ok(SearchDbStats {
        total_messages,
        last_sync_time,
        last_message_id,
        db_size_bytes,
    })
}

/// Paginated message result structure
#[derive(Serialize, Clone, Debug)]
pub struct PaginatedCachedMessages {
    pub messages: Vec<CachedMessage>,
    pub total_count: i64,
}

/// Read messages from cache DB with pagination (fast - no decompression needed)
#[tauri::command]
pub fn read_cached_messages(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<PaginatedCachedMessages, String> {
    let conn = get_connection(&app)?;
    
    let limit_val = limit.unwrap_or(100);
    let offset_val = offset.unwrap_or(0);
    
    // Get total count
    let total_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    
    // Get paginated messages (ordered by receive_date DESC, then id DESC)
    let mut stmt = conn.prepare(
        "SELECT id, sender, content, content_preview, receive_date, file_paths 
         FROM messages 
         ORDER BY receive_date DESC, id DESC 
         LIMIT ?1 OFFSET ?2"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;
    
    let messages: Vec<CachedMessage> = stmt
        .query_map(params![limit_val, offset_val], |row| {
            let file_paths_json: String = row.get(5)?;
            let file_paths: Vec<String> = serde_json::from_str(&file_paths_json).unwrap_or_default();
            
            Ok(CachedMessage {
                id: row.get(0)?,
                sender: row.get(1)?,
                content: row.get(2)?,
                content_preview: row.get(3)?,
                receive_date: row.get(4)?,
                file_paths,
            })
        })
        .map_err(|e| format!("쿼리 실행 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    
    Ok(PaginatedCachedMessages {
        messages,
        total_count,
    })
}

/// Get total message count from cache DB
#[tauri::command]
pub fn get_cached_message_count(app: AppHandle) -> Result<i64, String> {
    let conn = get_connection(&app)?;
    
    conn.query_row(
        "SELECT COUNT(*) FROM messages",
        [],
        |row| row.get(0),
    ).map_err(|e| format!("메시지 수 조회 실패: {}", e))
}

/// Check if cache DB has messages (for determining if sync is needed)
#[tauri::command]
pub fn is_cache_ready(app: AppHandle) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    
    Ok(count > 0)
}


#[cfg(test)]
mod tests {
    use super::*;
    
    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        
        conn.execute_batch("PRAGMA journal_mode=WAL;").ok();
        
        conn.execute(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                sender TEXT NOT NULL,
                content TEXT NOT NULL,
                content_preview TEXT,
                receive_date TEXT,
                file_paths TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        ).unwrap();
        
        conn.execute(
            "CREATE VIRTUAL TABLE messages_fts USING fts5(
                sender,
                content,
                content='messages',
                content_rowid='id',
                tokenize='unicode61'
            )",
            [],
        ).unwrap();
        
        conn.execute(
            "CREATE TABLE sync_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_sync_time INTEGER NOT NULL,
                last_message_id INTEGER NOT NULL,
                total_messages INTEGER NOT NULL
            )",
            [],
        ).unwrap();
        
        conn
    }
    
    #[test]
    fn test_extract_preview() {
        let html = "<p>Hello <b>World</b></p><br>This is a test message.";
        let preview = extract_preview(html);
        assert!(preview.contains("Hello"));
        assert!(preview.contains("World"));
        assert!(!preview.contains("<p>"));
        assert!(!preview.contains("<b>"));
    }
    
    #[test]
    fn test_fts5_search() {
        let conn = setup_test_db();
        
        // Insert test data
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        
        conn.execute(
            "INSERT INTO messages (id, sender, content, content_preview, receive_date, file_paths, created_at, updated_at)
             VALUES (1, '홍길동', '안녕하세요 학교 공지입니다', '안녕하세요 학교 공지입니다', '2024-01-01', '[]', ?1, ?1)",
            [now],
        ).unwrap();
        
        conn.execute(
            "INSERT INTO messages (id, sender, content, content_preview, receive_date, file_paths, created_at, updated_at)
             VALUES (2, '김철수', '오늘 수업 시간표가 변경되었습니다', '오늘 수업 시간표가 변경되었습니다', '2024-01-02', '[]', ?1, ?1)",
            [now],
        ).unwrap();
        
        // Manually insert into FTS table (in real code, triggers do this)
        conn.execute(
            "INSERT INTO messages_fts(rowid, sender, content) VALUES (1, '홍길동', '안녕하세요 학교 공지입니다')",
            [],
        ).unwrap();
        
        conn.execute(
            "INSERT INTO messages_fts(rowid, sender, content) VALUES (2, '김철수', '오늘 수업 시간표가 변경되었습니다')",
            [],
        ).unwrap();
        
        // Search for "학교"
        let mut stmt = conn.prepare(
            "SELECT m.id, m.sender, snippet(messages_fts, 1, '', '', '...', 50)
             FROM messages_fts 
             JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH '\"학교\"*'"
        ).unwrap();
        
        let results: Vec<(i64, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 1);
        assert_eq!(results[0].1, "홍길동");
    }
}
