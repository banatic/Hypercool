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

    let sql = "SELECT m.id, m.sender, substr(m.content, 1, 300), m.receive_date
               FROM messages_fts
               JOIN messages m ON m.id = messages_fts.rowid
               WHERE messages_fts MATCH ?1
               ORDER BY m.receive_date DESC
               LIMIT ?2";

    let mut stmt = conn.prepare(sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows: Vec<(i64, String, String, Option<String>)> = stmt
        .query_map(rusqlite::params![fts_query, limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("쿼리 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let text = if rows.is_empty() {
        format!("\"{}\" 검색 결과가 없습니다.", query)
    } else {
        let mut out = format!("\"{}\" 검색 결과 {}개:\n\n", query, rows.len());
        for (id, sender, preview, date) in &rows {
            out.push_str(&format!(
                "ID: {} | 발신: {} | 날짜: {}\n{}\n\n",
                id,
                sender,
                date.as_deref().unwrap_or("날짜 없음"),
                preview.trim()
            ));
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
        "SELECT id, sender, content_preview, receive_date
         FROM messages {}
         ORDER BY receive_date DESC, id DESC
         LIMIT {} OFFSET {}",
        where_clause, limit, offset
    );

    let mut stmt = conn.prepare(&query_sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows: Vec<(i64, String, String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get(3)?,
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
        for (id, sndr, preview, date) in &rows {
            out.push_str(&format!(
                "ID: {} | 발신: {} | 날짜: {}\n{}\n\n",
                id,
                sndr,
                date.as_deref().unwrap_or("날짜 없음"),
                preview.trim()
            ));
        }
        out
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn tool_get_message_by_id(db_path: &PathBuf, id: i64) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    let result = conn.query_row(
        "SELECT id, sender, content, receive_date FROM messages WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    );

    let text = match result {
        Ok((id, sender, content, date)) => format!(
            "메시지 ID: {}\n발신: {}\n날짜: {}\n\n{}",
            id,
            sender,
            date.as_deref().unwrap_or("날짜 없음"),
            content
        ),
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
