use rusqlite::{params, Connection, Result as SqliteResult};
use tauri::{AppHandle, Manager};
use serde::{Serialize, Deserialize};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::models::SearchResultItem;
use crate::utils::{decompress_brotli, decode_comp_zlib_utf16le, parse_file_paths};

static TAG_REGEX: OnceLock<regex::Regex> = OnceLock::new();
static SEARCH_DB: OnceLock<Mutex<Connection>> = OnceLock::new();

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

/// Get the shared connection to the search database
fn get_connection(_app: &AppHandle) -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    SEARCH_DB
        .get()
        .ok_or_else(|| "Search DB not initialized".to_string())?
        .lock()
        .map_err(|e| format!("DB 잠금 실패: {}", e))
}

/// 검색 DB 스키마 버전. v2: trigram FTS + content_text(HTML 제거 텍스트) 컬럼.
const SEARCH_DB_VERSION: i64 = 2;

/// Initialize the search database schema with FTS5
pub fn init_search_db(app: &AppHandle) -> Result<(), String> {
    let db_path = get_search_db_path(app)?;
    let conn = Connection::open(&db_path).map_err(|e| format!("검색 DB 연결 실패: {}", e))?;

    // Enable WAL mode for better concurrent access
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;

    // 구버전 스키마(unicode61 FTS, raw HTML 인덱싱)는 통째로 버린다.
    // 검색 DB는 UDB의 파생 캐시이므로 다음 sync_search_db에서 전체 재구축된다.
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if user_version < SEARCH_DB_VERSION {
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS messages_ai;
             DROP TRIGGER IF EXISTS messages_ad;
             DROP TRIGGER IF EXISTS messages_au;
             DROP TABLE IF EXISTS messages_fts;
             DROP TABLE IF EXISTS messages;
             DROP TABLE IF EXISTS sync_metadata;
             PRAGMA user_version = {};",
            SEARCH_DB_VERSION
        )).map_err(|e| format!("검색 DB 마이그레이션 실패: {}", e))?;
    }

    // Main messages table with metadata
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            sender TEXT NOT NULL,
            content TEXT NOT NULL,
            content_text TEXT NOT NULL DEFAULT '',
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
        // trigram: 한국어 부분 문자열(infix) 매칭 지원 (검색어 3글자 이상).
        // HTML이 제거된 content_text만 인덱싱한다. 3글자 미만은 LIKE 폴백 (search_messages_internal).
        conn.execute(
            "CREATE VIRTUAL TABLE messages_fts USING fts5(
                sender,
                content_text,
                content='messages',
                content_rowid='id',
                tokenize='trigram'
            )",
            [],
        ).map_err(|e| format!("FTS5 테이블 생성 실패: {}", e))?;

        // Create triggers to keep FTS index in sync with messages table
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, sender, content_text)
                VALUES (new.id, new.sender, new.content_text);
            END;

            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, sender, content_text)
                VALUES ('delete', old.id, old.sender, old.content_text);
            END;

            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, sender, content_text)
                VALUES ('delete', old.id, old.sender, old.content_text);
                INSERT INTO messages_fts(rowid, sender, content_text)
                VALUES (new.id, new.sender, new.content_text);
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

    // Store the connection in the global pool (ignore error if already initialized)
    let _ = SEARCH_DB.set(Mutex::new(conn));

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

/// HTML 본문을 검색/미리보기용 순수 텍스트로 변환 (태그 제거 + 엔티티 디코드 + 공백 정규화)
pub fn html_to_text(input: &str) -> String {
    let tag_regex = TAG_REGEX.get_or_init(|| regex::Regex::new(r"<[^>]*>").unwrap());
    // 태그를 공백으로 치환해 "<b>중요</b>공지" 같은 경우 단어가 붙지 않도록 한다
    let no_tags = tag_regex.replace_all(input, " ");
    let decoded = no_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract preview text (first 200 characters of plain text)
fn extract_preview(content_text: &str) -> String {
    if content_text.chars().count() > 200 {
        content_text.chars().take(200).collect::<String>() + "..."
    } else {
        content_text.to_string()
    }
}

/// Sync messages from UDB to search database
/// (대량 디코드/삽입이 메인 스레드를 막지 않도록 blocking 풀에서 실행)
#[tauri::command]
pub async fn sync_search_db(app: AppHandle, udb_path: String) -> Result<SyncStats, String> {
    tauri::async_runtime::spawn_blocking(move || sync_from_udb(&app, udb_path))
        .await
        .map_err(|e| format!("동기화 작업 실패: {}", e))?
}

/// Internal sync function
pub fn sync_from_udb(app: &AppHandle, udb_path: String) -> Result<SyncStats, String> {
    let start_time = Instant::now();
    
    if !std::fs::metadata(&udb_path).is_ok() {
        return Err(format!("UDB 파일을 찾을 수 없습니다: {}", udb_path));
    }
    
    // Use a dedicated write connection — keeps the shared read connection unlocked during bulk inserts
    let search_conn = Connection::open(get_search_db_path(app)?)
        .map_err(|e| format!("Search DB 쓰기 연결 실패: {}", e))?;
    search_conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
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
            "INSERT OR REPLACE INTO messages (id, sender, content, content_text, content_preview, receive_date, file_paths, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
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
                    let content_text = html_to_text(&content);
                    let preview = extract_preview(&content_text);
                    let file_paths_json = serde_json::to_string(&file_paths).unwrap_or_default();

                    insert_stmt.execute(params![
                        id,
                        sender,
                        content,
                        content_text,
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

    // 새 메시지가 들어왔으면 기존 검색 결과 캐시는 더 이상 유효하지 않다
    if new_count > 0 {
        if let Some(cache) = app.try_state::<crate::models::CacheState>() {
            if let Ok(mut search_cache) = cache.search_cache.lock() {
                search_cache.clear();
            }
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;
    
    Ok(SyncStats {
        new_messages: new_count,
        updated_messages: 0,
        total_messages: total_messages as usize,
        duration_ms,
    })
}

/// Search messages using FTS5/LIKE hybrid
#[tauri::command]
pub async fn search_messages_fts(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResultItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_messages_internal(&app, query, limit.unwrap_or(100))
    })
    .await
    .map_err(|e| format!("검색 작업 실패: {}", e))?
}

/// 검색어 실행 계획: 모든 단어가 3글자 이상이면 trigram FTS, 아니면 LIKE 폴백
pub struct SearchPlan {
    /// trigram MATCH 쿼리 (예: `"단어1" AND "단어2"`). None이면 LIKE만 사용.
    pub fts_query: Option<String>,
    /// 공백으로 분리된 개별 검색어
    pub terms: Vec<String>,
}

pub fn plan_search_query(raw: &str) -> Option<SearchPlan> {
    let terms: Vec<String> = raw.split_whitespace().map(|s| s.to_string()).collect();
    if terms.is_empty() {
        return None;
    }
    // trigram 토크나이저는 3글자 미만 검색어를 토큰화하지 못한다
    let fts_query = if terms.iter().all(|t| t.chars().count() >= 3) {
        Some(
            terms
                .iter()
                .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND "),
        )
    } else {
        None
    };
    Some(SearchPlan { fts_query, terms })
}

/// LIKE 패턴 이스케이프 (%, _, \ → ESCAPE '\' 기준)
pub fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{}%", escaped)
}

/// 매칭 위치 주변 텍스트를 잘라 스니펫 생성 (LIKE 경로용)
fn make_snippet(text: &str, terms: &[String]) -> String {
    const CONTEXT_BEFORE: usize = 20;
    const SNIPPET_LEN: usize = 150;

    let total = text.chars().count();
    let mut start_char = 0usize;
    let mut best_byte = usize::MAX;
    for t in terms {
        if let Some(p) = text.find(t.as_str()) {
            if p < best_byte {
                best_byte = p;
            }
        }
    }
    if best_byte != usize::MAX {
        let match_char = text[..best_byte].chars().count();
        start_char = match_char.saturating_sub(CONTEXT_BEFORE);
    }

    let mut out = String::new();
    if start_char > 0 {
        out.push('…');
    }
    out.extend(text.chars().skip(start_char).take(SNIPPET_LEN));
    if start_char + SNIPPET_LEN < total {
        out.push('…');
    }
    out
}

/// Internal hybrid search: trigram FTS 우선, 결과가 없거나 짧은 검색어면 content_text LIKE
pub fn search_messages_internal(
    app: &AppHandle,
    query: String,
    limit: usize,
) -> Result<Vec<SearchResultItem>, String> {
    let plan = match plan_search_query(&query) {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };

    let conn = get_connection(app)?;

    if let Some(fts_query) = &plan.fts_query {
        // snippet(): 매칭된 부분 주변 텍스트를 보여준다 (컬럼 1 = content_text)
        let mut stmt = conn.prepare(
            "SELECT m.id, m.sender,
                    snippet(messages_fts, 1, '', '', '…', 64) AS snip,
                    m.receive_date
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH ?1
             ORDER BY m.receive_date DESC, m.id DESC
             LIMIT ?2"
        ).map_err(|e| format!("검색 쿼리 준비 실패: {}", e))?;

        let results: Vec<SearchResultItem> = stmt
            .query_map(params![fts_query, limit as i64], |row| {
                Ok(SearchResultItem {
                    id: row.get(0)?,
                    sender: row.get(1)?,
                    snippet: row.get(2)?,
                    receive_date: row.get(3)?,
                })
            })
            .map_err(|e| format!("검색 실행 실패: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        if !results.is_empty() {
            return Ok(results);
        }
        // 0건이면 LIKE로 한 번 더 (특수문자 등으로 토큰화가 깨지는 경우 대비)
    }

    // LIKE 경로: HTML이 제거된 content_text 대상이라 압축/태그 문제 없음
    let mut conditions: Vec<&str> = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for term in &plan.terms {
        conditions.push("(m.content_text LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\')");
        let pattern = like_pattern(term);
        bind.push(Box::new(pattern.clone()));
        bind.push(Box::new(pattern));
    }
    bind.push(Box::new(limit as i64));

    let sql = format!(
        "SELECT m.id, m.sender, m.content_text, m.receive_date
         FROM messages m
         WHERE {}
         ORDER BY m.receive_date DESC, m.id DESC
         LIMIT ?",
        conditions.join(" AND ")
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("LIKE 검색 쿼리 준비 실패: {}", e))?;

    let terms = plan.terms.clone();
    let results: Vec<SearchResultItem> = stmt
        .query_map(
            rusqlite::params_from_iter(bind.iter().map(|p| p.as_ref())),
            |row| {
                let content_text: String = row.get(2)?;
                Ok(SearchResultItem {
                    id: row.get(0)?,
                    sender: row.get(1)?,
                    snippet: make_snippet(&content_text, &terms),
                    receive_date: row.get(3)?,
                })
            },
        )
        .map_err(|e| format!("LIKE 검색 실행 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

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
pub async fn read_cached_messages(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<PaginatedCachedMessages, String> {
    tauri::async_runtime::spawn_blocking(move || read_cached_messages_blocking(&app, limit, offset))
        .await
        .map_err(|e| format!("메시지 로드 작업 실패: {}", e))?
}

fn read_cached_messages_blocking(
    app: &AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<PaginatedCachedMessages, String> {
    let conn = get_connection(app)?;
    
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

        conn.execute(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                sender TEXT NOT NULL,
                content TEXT NOT NULL,
                content_text TEXT NOT NULL DEFAULT '',
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
                content_text,
                content='messages',
                content_rowid='id',
                tokenize='trigram'
            )",
            [],
        ).unwrap();

        conn
    }

    fn insert_test_message(conn: &Connection, id: i64, sender: &str, text: &str, date: &str) {
        conn.execute(
            "INSERT INTO messages (id, sender, content, content_text, content_preview, receive_date, file_paths, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3, ?3, ?4, '[]', 0, 0)",
            params![id, sender, text, date],
        ).unwrap();
        conn.execute(
            "INSERT INTO messages_fts(rowid, sender, content_text) VALUES (?1, ?2, ?3)",
            params![id, sender, text],
        ).unwrap();
    }

    #[test]
    fn test_html_to_text() {
        let html = "<p>Hello&nbsp;<b>World</b></p><br>이것은 <span style=\"color:red\">테스트</span>입니다.";
        let text = html_to_text(html);
        assert_eq!(text, "Hello World 이것은 테스트 입니다.");
    }

    #[test]
    fn test_plan_search_query() {
        // 2글자 한국어 검색어 → trigram 불가, LIKE 폴백
        let plan = plan_search_query("급식").unwrap();
        assert!(plan.fts_query.is_none());
        assert_eq!(plan.terms, vec!["급식"]);

        // 3글자 이상 다중 단어 → AND로 묶인 trigram 쿼리
        let plan = plan_search_query("시간표 변경되었").unwrap();
        assert_eq!(plan.fts_query.as_deref(), Some("\"시간표\" AND \"변경되었\""));

        // 빈 검색어
        assert!(plan_search_query("   ").is_none());
    }

    #[test]
    fn test_make_snippet() {
        let long_text = "가".repeat(100) + "검색어" + &"나".repeat(200);
        let snippet = make_snippet(&long_text, &[String::from("검색어")]);
        assert!(snippet.contains("검색어"));
        assert!(snippet.starts_with('…'));
        assert!(snippet.ends_with('…'));
    }

    #[test]
    fn test_trigram_infix_search() {
        let conn = setup_test_db();
        insert_test_message(&conn, 1, "홍길동", "안녕하세요 우리초등학교 공지입니다", "2024-01-01");
        insert_test_message(&conn, 2, "김철수", "오늘 수업시간표가 변경되었습니다", "2024-01-02");

        // 띄어쓰기 없이 붙은 단어 내부(infix)도 매칭되어야 한다 — unicode61에서는 불가능했던 케이스
        let mut stmt = conn.prepare(
            "SELECT m.id FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH '\"초등학교\"'"
        ).unwrap();
        let ids: Vec<i64> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(ids, vec![1]);

        let mut stmt = conn.prepare(
            "SELECT m.id FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH '\"시간표\"'"
        ).unwrap();
        let ids: Vec<i64> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn test_like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
    }
}
