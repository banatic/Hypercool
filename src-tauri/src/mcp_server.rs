use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

struct McpState {
    db_path: PathBuf,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    method: String,
    params: Option<Value>,
    id: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    id: Option<Value>,
}

fn ok_response(result: Value, id: Option<Value>) -> JsonRpcResponse {
    JsonRpcResponse { jsonrpc: "2.0".into(), result: Some(result), error: None, id }
}

fn err_response(code: i32, message: &str, id: Option<Value>) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".into(),
        result: None,
        error: Some(json!({ "code": code, "message": message })),
        id,
    }
}

async fn handle_mcp(
    State(state): State<Arc<McpState>>,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    // Notifications (no id) — just ACK
    if req.id.is_none() && req.method.starts_with("notifications/") {
        return axum::http::StatusCode::ACCEPTED.into_response();
    }

    let id = req.id.clone();

    let response = match req.method.as_str() {
        "initialize" => ok_response(
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "hypercool-mcp", "version": "1.0.0" }
            }),
            id,
        ),

        "tools/list" => ok_response(
            json!({
                "tools": [
                    {
                        "name": "search_messages",
                        "description": "쿨메신저 수신 메시지에서 텍스트를 검색합니다.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": { "type": "string", "description": "검색어" },
                                "limit": { "type": "number", "description": "최대 결과 수 (기본값: 20, 최대: 100)" }
                            },
                            "required": ["query"]
                        }
                    },
                    {
                        "name": "get_messages",
                        "description": "쿨메신저 수신 메시지를 조회합니다. 발신자·날짜 범위 필터를 선택적으로 조합할 수 있습니다. 필터 없이 호출하면 최근 메시지를 반환합니다.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "sender":    { "type": "string", "description": "발신자 이름 필터 (부분 일치, 생략 가능)" },
                                "date_from": { "type": "string", "description": "시작 날짜 (YYYY-MM-DD, 생략 가능)" },
                                "date_to":   { "type": "string", "description": "종료 날짜 (YYYY-MM-DD, 생략 가능)" },
                                "limit":     { "type": "number", "description": "최대 결과 수 (기본값: 50, 최대: 200)" },
                                "offset":    { "type": "number", "description": "건너뛸 메시지 수 (기본값: 0)" }
                            }
                        }
                    },
                    {
                        "name": "get_message_by_id",
                        "description": "특정 ID의 쿨메신저 메시지 전체 내용을 가져옵니다.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "number", "description": "메시지 ID" }
                            },
                            "required": ["id"]
                        }
                    },
                    {
                        "name": "get_db_stats",
                        "description": "쿨메신저 메시지 DB 통계를 가져옵니다. (총 메시지 수, 마지막 동기화 시간 등)",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "list_attachments",
                        "description": "쿨메신저 수신 파일 목록을 조회합니다. 파일명 검색과 확장자 필터를 지원합니다.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": { "type": "string", "description": "파일명 검색어 (부분 일치, 생략 가능)" },
                                "ext":   { "type": "string", "description": "확장자 필터 (예: pdf, hwpx, xlsx — 생략 가능)" },
                                "limit": { "type": "number", "description": "최대 결과 수 (기본값: 50, 최대: 200)" }
                            }
                        }
                    },
                    {
                        "name": "read_attachment",
                        "description": "쿨메신저 수신 파일의 텍스트 내용을 읽습니다. 지원 형식: hwp, hwpx, pdf, xlsx, xls, xlsm, xlsb, odt, pptx, md, html, csv",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "filename": { "type": "string", "description": "읽을 파일명 (list_attachments로 조회한 파일명)" }
                            },
                            "required": ["filename"]
                        }
                    }
                ]
            }),
            id,
        ),

        "tools/call" => {
            let params = match req.params {
                Some(p) => p,
                None => return Json(err_response(-32602, "params required", id)).into_response(),
            };
            let name = match params["name"].as_str() {
                Some(n) => n.to_string(),
                None => return Json(err_response(-32602, "name required", id)).into_response(),
            };
            let args = params["arguments"].clone();

            match call_tool(&state.db_path, &name, &args) {
                Ok(result) => ok_response(result, id),
                Err(e) => err_response(-32603, &e, id),
            }
        }

        "ping" => ok_response(json!({}), id),

        _ => err_response(-32601, "Method not found", id),
    };

    Json(response).into_response()
}

/// HTML 태그를 제거하고 순수 텍스트를 반환합니다.
fn strip_html(html: &str) -> String {
    use scraper::Html;

    // <br> 계열을 먼저 개행으로 치환 (scraper는 이를 공백으로 처리)
    let preprocessed = html
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");

    let document = Html::parse_document(&preprocessed);
    let raw: String = document.root_element().text().collect::<Vec<_>>().join("");

    // 연속 공백 정리 및 빈 줄 압축
    let lines: Vec<&str> = raw
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

/// 텍스트를 max_chars 글자 수 기준으로 자릅니다.
fn truncate_text(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        truncated + "..."
    } else {
        truncated
    }
}

fn call_tool(db_path: &PathBuf, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "search_messages" => {
            let query = args["query"].as_str().ok_or("query required")?;
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 100);
            tool_search_messages(db_path, query, limit)
        }
        "get_messages" => {
            let sender    = args["sender"].as_str();
            let date_from = args["date_from"].as_str();
            let date_to   = args["date_to"].as_str();
            let limit  = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
            let offset = args["offset"].as_i64().unwrap_or(0).max(0);
            tool_get_messages(db_path, sender, date_from, date_to, limit, offset)
        }
        "get_message_by_id" => {
            let id = args["id"].as_i64().ok_or("id required")?;
            tool_get_message_by_id(db_path, id)
        }
        "get_db_stats" => tool_get_db_stats(db_path),
        "list_attachments" => {
            let query = args["query"].as_str();
            let ext   = args["ext"].as_str();
            let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
            tool_list_attachments(query, ext, limit)
        }
        "read_attachment" => {
            let filename = args["filename"].as_str().ok_or("filename required")?;
            tool_read_attachment(filename)
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

fn open_db(db_path: &PathBuf) -> Result<Connection, String> {
    if !db_path.exists() {
        return Err("Hypercool 앱을 먼저 실행하고 메시지를 동기화하세요.".into());
    }
    Connection::open(db_path).map_err(|e| format!("DB 연결 실패: {}", e))
}

fn tool_search_messages(db_path: &PathBuf, query: &str, limit: i64) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    let escaped = query.replace('"', "\"\"").replace('*', "").replace(':', " ");
    let fts_query = format!("\"{}\"*", escaped);

    let sql = "SELECT m.id, m.sender, m.content, m.receive_date, m.file_paths
               FROM messages_fts
               JOIN messages m ON m.id = messages_fts.rowid
               WHERE messages_fts MATCH ?1
               ORDER BY m.receive_date DESC
               LIMIT ?2";

    let mut stmt = conn.prepare(sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows: Vec<(i64, String, String, Option<String>, Vec<String>)> = stmt
        .query_map(rusqlite::params![fts_query, limit], |row| {
            let fp_json: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let file_paths: Vec<String> = serde_json::from_str(&fp_json).unwrap_or_default();
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, file_paths))
        })
        .map_err(|e| format!("쿼리 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let text = if rows.is_empty() {
        format!("\"{}\" 검색 결과가 없습니다.", query)
    } else {
        let mut out = format!("\"{}\" 검색 결과 {}개:\n\n", query, rows.len());
        for (id, sender, content, date, file_paths) in &rows {
            let preview = truncate_text(&strip_html(content), 300);
            out.push_str(&format!(
                "ID: {} | 발신: {} | 날짜: {}\n{}",
                id,
                sender,
                date.as_deref().unwrap_or("날짜 없음"),
                preview
            ));
            if !file_paths.is_empty() {
                out.push_str(&format!("\n첨부: {}", file_paths.join(", ")));
            }
            out.push_str("\n\n");
        }
        out
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn tool_get_messages(
    db_path: &PathBuf,
    sender: Option<&str>,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    // 동적 WHERE 절 구성
    let mut conditions: Vec<String> = Vec::new();
    let mut params_desc: Vec<String> = Vec::new();

    if let Some(s) = sender {
        conditions.push(format!("sender LIKE '%{}%'", s.replace('\'', "''")));
        params_desc.push(format!("발신: \"{}\"", s));
    }
    if let Some(from) = date_from {
        conditions.push(format!("receive_date >= '{} 00:00:00'", from.replace('\'', "''")));
        params_desc.push(format!("{}부터", from));
    }
    if let Some(to) = date_to {
        conditions.push(format!("receive_date <= '{} 23:59:59'", to.replace('\'', "''")));
        params_desc.push(format!("{}까지", to));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let count_sql = format!("SELECT COUNT(*) FROM messages {}", where_clause);
    let total: i64 = conn
        .query_row(&count_sql, [], |row| row.get(0))
        .unwrap_or(0);

    let query_sql = format!(
        "SELECT id, sender, content_preview, receive_date, file_paths
         FROM messages {}
         ORDER BY receive_date DESC, id DESC
         LIMIT {} OFFSET {}",
        where_clause, limit, offset
    );

    let mut stmt = conn.prepare(&query_sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows: Vec<(i64, String, String, Option<String>, Vec<String>)> = stmt
        .query_map([], |row| {
            let fp_json: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let file_paths: Vec<String> = serde_json::from_str(&fp_json).unwrap_or_default();
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get(3)?,
                file_paths,
            ))
        })
        .map_err(|e| format!("쿼리 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let header = if params_desc.is_empty() {
        format!("메시지 (전체 {}개 중 {}~{}):\n\n", total, offset + 1, offset + rows.len() as i64)
    } else {
        format!(
            "메시지 [{}] (전체 {}개 중 {}~{}):\n\n",
            params_desc.join(", "),
            total,
            offset + 1,
            offset + rows.len() as i64
        )
    };

    let text = if rows.is_empty() {
        if params_desc.is_empty() {
            "메시지가 없습니다.".to_string()
        } else {
            format!("[{}] 조건에 맞는 메시지가 없습니다.", params_desc.join(", "))
        }
    } else {
        let mut out = header;
        for (id, sndr, preview, date, file_paths) in &rows {
            out.push_str(&format!(
                "ID: {} | 발신: {} | 날짜: {}\n{}",
                id,
                sndr,
                date.as_deref().unwrap_or("날짜 없음"),
                preview.trim()
            ));
            if !file_paths.is_empty() {
                out.push_str(&format!("\n첨부: {}", file_paths.join(", ")));
            }
            out.push_str("\n\n");
        }
        out
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn tool_get_message_by_id(db_path: &PathBuf, id: i64) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    let result = conn.query_row(
        "SELECT id, sender, content, receive_date, file_paths FROM messages WHERE id = ?1",
        [id],
        |row| {
            let fp_json: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let file_paths: Vec<String> = serde_json::from_str(&fp_json).unwrap_or_default();
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                file_paths,
            ))
        },
    );

    let text = match result {
        Ok((id, sender, content, date, file_paths)) => {
            let mut out = format!(
                "메시지 ID: {}\n발신: {}\n날짜: {}",
                id,
                sender,
                date.as_deref().unwrap_or("날짜 없음"),
            );
            if !file_paths.is_empty() {
                out.push_str(&format!("\n첨부: {}", file_paths.join(", ")));
            }
            out.push_str(&format!("\n\n{}", strip_html(&content)));
            out
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            format!("ID {}인 메시지를 찾을 수 없습니다.", id)
        }
        Err(e) => return Err(format!("메시지 조회 실패: {}", e)),
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn tool_get_db_stats(db_path: &PathBuf) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap_or(0);

    let (last_sync, last_id): (i64, i64) = conn
        .query_row(
            "SELECT last_sync_time, last_message_id FROM sync_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, 0));

    let db_size_kb = std::fs::metadata(db_path).map(|m| m.len() / 1024).unwrap_or(0);

    let sync_time = if last_sync > 0 {
        let dt = std::time::UNIX_EPOCH + std::time::Duration::from_secs(last_sync as u64);
        chrono::DateTime::<chrono::Local>::from(dt)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    } else {
        "동기화 없음".to_string()
    };

    let text = format!(
        "쿨메신저 DB 통계\n총 메시지: {}개\n마지막 메시지 ID: {}\n마지막 동기화: {}\nDB 크기: {} KB",
        total, last_id, sync_time, db_size_kb
    );

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

// ─── 첨부 파일 관련 ────────────────────────────────────────────────────────────

/// 쿨메신저 수신 파일 저장 경로를 레지스트리에서 읽어옴
fn get_attachments_dir() -> Option<PathBuf> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let subkey = hkcu
        .open_subkey(r"Software\Jiransoft\CoolMsg50\Option\GetFile")
        .ok()?;
    let path: String = subkey.get_value("DownPath").ok()?;
    Some(PathBuf::from(path))
}

fn tool_list_attachments(query: Option<&str>, ext: Option<&str>, limit: i64) -> Result<Value, String> {
    let dir = get_attachments_dir()
        .ok_or_else(|| "쿨메신저 수신 파일 경로를 찾을 수 없습니다. 쿨메신저가 설치·실행됐는지 확인하세요.".to_string())?;

    if !dir.exists() {
        return Err(format!("수신 파일 디렉토리가 없습니다: {}", dir.display()));
    }

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("디렉토리 읽기 실패: {}", e))?;

    // (수정 시각, 파일명) 쌍으로 수집한 뒤 최신순 정렬
    let mut files: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }

            // 확장자 필터
            if let Some(ext_filter) = ext {
                let file_ext = std::path::Path::new(&name)
                    .extension()
                    .and_then(|x| x.to_str())
                    .unwrap_or("");
                if !file_ext.eq_ignore_ascii_case(ext_filter) {
                    return None;
                }
            }

            // 파일명 검색
            if let Some(q) = query {
                if !name.to_lowercase().contains(&q.to_lowercase()) {
                    return None;
                }
            }

            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, name))
        })
        .collect();

    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(limit as usize);

    let text = if files.is_empty() {
        "조건에 맞는 파일이 없습니다.".to_string()
    } else {
        let mut out = format!("수신 파일 {}개 (최신순):\n\n", files.len());
        for (_, name) in &files {
            out.push_str(name);
            out.push('\n');
        }
        out
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn tool_read_attachment(filename: &str) -> Result<Value, String> {
    let dir = get_attachments_dir()
        .ok_or_else(|| "쿨메신저 수신 파일 경로를 찾을 수 없습니다.".to_string())?;
    let path = dir.join(filename);

    if !path.exists() {
        return Err(format!("파일을 찾을 수 없습니다: {}", filename));
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content = match ext.as_str() {
        "hwp" | "hwpx" => read_hwp_file(&path)?,
        "pdf"          => read_pdf_file(&path)?,
        "xlsx" | "xls" | "xlsm" | "xlsb" => read_excel_file(&path)?,
        "odt"          => read_odt_file(&path)?,
        "pptx"         => read_pptx_file(&path)?,
        "md" | "txt" | "csv" => {
            std::fs::read_to_string(&path).map_err(|e| format!("파일 읽기 실패: {}", e))?
        }
        "html" | "htm" => {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("파일 읽기 실패: {}", e))?;
            strip_html(&raw)
        }
        _ => return Err(format!("지원하지 않는 파일 형식입니다: .{}", ext)),
    };

    let truncated = truncate_text(&content, 15000);
    let text = format!("파일: {}\n\n{}", filename, truncated);
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn read_hwp_file(path: &PathBuf) -> Result<String, String> {
    use unhwp::{parse_file, render::render_markdown, RenderOptions};
    let document = parse_file(path).map_err(|e| format!("HWP 파싱 실패: {}", e))?;
    let options = RenderOptions::default();
    render_markdown(&document, &options).map_err(|e| format!("HWP 렌더링 실패: {}", e))
}

fn read_pdf_file(path: &PathBuf) -> Result<String, String> {
    let doc = lopdf::Document::load(path).map_err(|e| format!("PDF 로드 실패: {}", e))?;
    let mut page_numbers: Vec<u32> = doc.get_pages().keys().cloned().collect();
    page_numbers.sort_unstable();
    doc.extract_text(&page_numbers).map_err(|e| format!("PDF 텍스트 추출 실패: {}", e))
}

fn read_excel_file(path: &PathBuf) -> Result<String, String> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut wb = open_workbook_auto(path).map_err(|e| format!("Excel 로드 실패: {}", e))?;
    let sheet_names = wb.sheet_names().to_owned();
    let mut out = String::new();

    for name in sheet_names {
        out.push_str(&format!("## {}\n", name));
        if let Ok(range) = wb.worksheet_range(&name) {
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Int(i) => i.to_string(),
                        Data::Float(f) => f.to_string(),
                        Data::Bool(b) => b.to_string(),
                        other => format!("{:?}", other),
                    })
                    .collect();
                if cells.iter().all(|c| c.is_empty()) {
                    continue;
                }
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
        }
        out.push('\n');
    }

    Ok(out)
}

fn read_odt_file(path: &PathBuf) -> Result<String, String> {
    use std::io::Read;
    use zip::ZipArchive;

    let file = std::fs::File::open(path).map_err(|e| format!("파일 열기 실패: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("ZIP 열기 실패: {}", e))?;
    let mut entry = archive
        .by_name("content.xml")
        .map_err(|_| "content.xml을 찾을 수 없습니다".to_string())?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml).map_err(|e| format!("읽기 실패: {}", e))?;
    Ok(extract_xml_text(&xml))
}

fn read_pptx_file(path: &PathBuf) -> Result<String, String> {
    use std::io::Read;
    use zip::ZipArchive;

    let file = std::fs::File::open(path).map_err(|e| format!("파일 열기 실패: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("ZIP 열기 실패: {}", e))?;

    let mut slide_names: Vec<String> = archive
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .map(|s| s.to_string())
        .collect();
    slide_names.sort();

    let mut out = String::new();
    for name in slide_names {
        if let Ok(mut entry) = archive.by_name(&name) {
            let mut xml = String::new();
            let _ = entry.read_to_string(&mut xml);
            let text = extract_xml_text(&xml);
            if !text.is_empty() {
                out.push_str(&text);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// XML 태그를 제거하고 텍스트만 추출
fn extract_xml_text(xml: &str) -> String {
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    let text = re.replace_all(xml, "");
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

pub fn start(db_path: PathBuf, port: u16) {
    let state = Arc::new(McpState { db_path });
    let router = Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let addr = format!("127.0.0.1:{}", port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => {
                eprintln!("[MCP] 서버 시작: http://{}/mcp", addr);
                l
            }
            Err(e) => {
                eprintln!("[MCP] 서버 시작 실패 (포트 {}): {}", port, e);
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[MCP] 서버 오류: {}", e);
        }
    });
}
