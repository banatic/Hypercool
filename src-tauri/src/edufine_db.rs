use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EdufineDoc {
    pub id: i64,
    pub file_name: String,
    pub title: Option<String>,
    pub content: String,
    pub content_hash: String,
    pub detected_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EdufineDocPreview {
    pub id: i64,
    pub file_name: String,
    pub title: Option<String>,
    pub preview: String,
    pub detected_at: String,
}

pub fn init_db(db_path: &PathBuf) -> SqlResult<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS docs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name    TEXT NOT NULL,
            title        TEXT,
            content      TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            detected_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
            title,
            content,
            content=docs,
            content_rowid=id,
            tokenize='unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
            INSERT INTO docs_fts(rowid, title, content)
            VALUES (new.id, COALESCE(new.title, ''), new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
            INSERT INTO docs_fts(docs_fts, rowid, title, content)
            VALUES ('delete', old.id, COALESCE(old.title, ''), old.content);
            INSERT INTO docs_fts(rowid, title, content)
            VALUES (new.id, COALESCE(new.title, ''), new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
            INSERT INTO docs_fts(docs_fts, rowid, title, content)
            VALUES ('delete', old.id, COALESCE(old.title, ''), old.content);
        END;
        "#,
    )?;
    Ok(())
}

/// 중복 확인 후 삽입. 중복이면 None 반환.
pub fn insert_doc(
    db_path: &PathBuf,
    file_name: &str,
    title: Option<&str>,
    content: &str,
    content_hash: &str,
) -> SqlResult<Option<i64>> {
    let conn = Connection::open(db_path)?;
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM docs WHERE content_hash = ?1",
        params![content_hash],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO docs (file_name, title, content, content_hash) VALUES (?1, ?2, ?3, ?4)",
        params![file_name, title, content, content_hash],
    )?;
    Ok(Some(conn.last_insert_rowid()))
}

/// FTS5 전문 검색 — 제목 우선, 본문 포함
pub fn search_docs(
    db_path: &PathBuf,
    query: &str,
    limit: i64,
) -> SqlResult<Vec<EdufineDocPreview>> {
    let conn = Connection::open(db_path)?;
    let escaped = query
        .replace('"', "\"\"")
        .replace('*', "")
        .replace(':', " ");
    let fts_query = format!("\"{}\"*", escaped);

    let mut stmt = conn.prepare(
        r#"
        SELECT d.id, d.file_name, d.title, d.content, d.detected_at
        FROM docs_fts
        JOIN docs d ON docs_fts.rowid = d.id
        WHERE docs_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2
        "#,
    )?;

    let rows = stmt.query_map(params![fts_query, limit], |row| {
        let content: String = row.get(3)?;
        let preview: String = content.chars().take(300).collect();
        Ok(EdufineDocPreview {
            id: row.get(0)?,
            file_name: row.get(1)?,
            title: row.get(2)?,
            preview,
            detected_at: row.get(4)?,
        })
    })?;

    rows.collect()
}

/// ID로 공문 전체 조회
pub fn get_doc(db_path: &PathBuf, id: i64) -> SqlResult<Option<EdufineDoc>> {
    let conn = Connection::open(db_path)?;
    let result = conn.query_row(
        "SELECT id, file_name, title, content, content_hash, detected_at FROM docs WHERE id = ?1",
        params![id],
        |row| {
            Ok(EdufineDoc {
                id: row.get(0)?,
                file_name: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                content_hash: row.get(4)?,
                detected_at: row.get(5)?,
            })
        },
    );
    match result {
        Ok(doc) => Ok(Some(doc)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 최근 공문 목록 (미리보기)
pub fn list_docs(
    db_path: &PathBuf,
    limit: i64,
    offset: i64,
) -> SqlResult<Vec<EdufineDocPreview>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, file_name, title, content, detected_at FROM docs ORDER BY detected_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], |row| {
        let content: String = row.get(3)?;
        let preview: String = content.chars().take(300).collect();
        Ok(EdufineDocPreview {
            id: row.get(0)?,
            file_name: row.get(1)?,
            title: row.get(2)?,
            preview,
            detected_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

/// 통계: (총 공문 수, 마지막 감지 시각)
pub fn get_stats(db_path: &PathBuf) -> SqlResult<(i64, Option<String>)> {
    let conn = Connection::open(db_path)?;
    let total: i64 =
        conn.query_row("SELECT COUNT(*) FROM docs", [], |row| row.get(0))?;
    let last: Option<String> = conn
        .query_row(
            "SELECT detected_at FROM docs ORDER BY detected_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok((total, last))
}
