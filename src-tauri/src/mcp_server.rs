use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::{post, options},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::edufine_db;
use crate::edufine_watcher;

static XML_TAG_REGEX: OnceLock<regex::Regex> = OnceLock::new();
static INLINE_IMG_REGEX: OnceLock<regex::Regex> = OnceLock::new();

struct McpState {
    db_path: PathBuf,
    edufine_db_path: PathBuf,
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

        "tools/list" => {
            let mut tools = vec![
                json!({
                    "name": "search_messages",
                    "description": "쿨메신저 메시지 전문 검색 (full-text search messages by keyword). 특정 단어·문장이 포함된 메시지를 찾습니다.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "검색 키워드 (search keyword)" },
                            "limit": { "type": "number", "description": "최대 결과 수 (기본값: 20, 최대: 100)" }
                        },
                        "required": ["query"]
                    }
                }),
                json!({
                    "name": "get_messages",
                    "description": "쿨메신저 수신 메시지 목록 조회 및 DB 통계 (list/browse received messages, database stats). 날짜 범위·발신자·이미지 필터 지원. stats=true 이면 DB 통계(총 메시지 수, 마지막 동기화 시각) 반환. 파라미터 없이 호출하면 최근 메시지 반환.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "sender":      { "type": "string",  "description": "발신자 이름 필터 (sender name, 부분 일치)" },
                            "date_from":   { "type": "string",  "description": "시작 날짜 (YYYY-MM-DD)" },
                            "date_to":     { "type": "string",  "description": "종료 날짜 (YYYY-MM-DD)" },
                            "images_only": { "type": "boolean", "description": "true이면 이미지 첨부 메시지만 반환" },
                            "stats":       { "type": "boolean", "description": "true이면 DB 통계 반환 (database statistics)" },
                            "limit":       { "type": "number",  "description": "최대 결과 수 (기본값: 50, 최대: 200)" },
                            "offset":      { "type": "number",  "description": "건너뛸 메시지 수 (기본값: 0)" }
                        }
                    }
                }),
                json!({
                    "name": "get_message_by_id",
                    "description": "메시지 ID로 특정 메시지 전체 내용 조회 (get full message content by ID).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "number", "description": "메시지 ID (message ID)" }
                        },
                        "required": ["id"]
                    }
                }),
                json!({
                    "name": "list_attachments",
                    "description": "수신 첨부 파일 목록 조회 (list received file attachments). 파일명 검색·확장자 필터 지원 (pdf, hwpx, xlsx 등).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "파일명 검색어 (filename search, 부분 일치)" },
                            "ext":   { "type": "string", "description": "확장자 필터 (예: pdf, hwpx, xlsx)" },
                            "limit": { "type": "number", "description": "최대 결과 수 (기본값: 50, 최대: 200)" }
                        }
                    }
                }),
                json!({
                    "name": "read_attachment",
                    "description": "첨부 파일 텍스트 내용 추출 (read / extract text from attachment file). 지원 형식: hwp, hwpx, pdf, xlsx, xls, pptx, odt, csv, md, html.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "filename": { "type": "string", "description": "파일명 (list_attachments로 조회)" }
                        },
                        "required": ["filename"]
                    }
                }),
                json!({
                    "name": "view_image",
                    "description": "이미지를 Claude가 시각적으로 확인 (view image — file attachment or inline embedded image). filename 지정 시 첨부 이미지, message_id 지정 시 메시지 본문 인라인 이미지. BMP·TIFF 자동 PNG 변환, 대용량 자동 리사이즈.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "filename":   { "type": "string", "description": "첨부 이미지 파일명 (file 모드, get_messages images_only=true 로 조회)" },
                            "message_id": { "type": "number", "description": "메시지 ID (inline 모드)" },
                            "index":      { "type": "number", "description": "인라인 이미지 순서 (0부터, 기본값: 0, inline 모드만)" }
                        }
                    }
                })
            ];

            // 에듀파인 공문 MCP 활성화 시 툴 추가
            if edufine_watcher::is_enabled() {
                tools.push(json!({
                    "name": "search_edufine_docs",
                    "description": "에듀파인에서 열람한 공문서를 제목·본문으로 전문 검색합니다. 키워드를 입력하면 관련 공문 목록(id, 제목, 미리보기)을 반환합니다.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "검색 키워드 (제목 또는 본문)" },
                            "limit": { "type": "number", "description": "최대 결과 수 (기본값: 10, 최대: 50)" }
                        },
                        "required": ["query"]
                    }
                }));
                tools.push(json!({
                    "name": "get_edufine_doc",
                    "description": "에듀파인 공문 전체 내용을 가져옵니다. search_edufine_docs 또는 list_edufine_docs로 id를 먼저 조회하세요.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "number", "description": "공문 ID" }
                        },
                        "required": ["id"]
                    }
                }));
                tools.push(json!({
                    "name": "list_edufine_docs",
                    "description": "최근 저장된 에듀파인 공문 목록을 조회합니다. 날짜 내림차순 정렬.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "limit":  { "type": "number", "description": "최대 결과 수 (기본값: 20, 최대: 100)" },
                            "offset": { "type": "number", "description": "건너뛸 수 (기본값: 0)" }
                        }
                    }
                }));
            }

            ok_response(json!({ "tools": tools }), id)
        }

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

            match call_tool(&state.db_path, &state.edufine_db_path, &name, &args) {
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

// ─── 이미지 감지 ──────────────────────────────────────────────────────────────

/// 이미지로 판별되는 확장자 목록
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp",
    "heic", "heif", "tiff", "tif", "avif",
];

/// 파일 첫 12바이트(magic bytes)로 MIME 타입을 판별합니다.
/// 확장자와 무관하게 실제 파일 포맷을 식별합니다.
fn detect_image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        // JPEG: FF D8 FF
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        // GIF87a / GIF89a
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        // BMP: BM
        [b'B', b'M', ..] => Some("image/bmp"),
        // WEBP: RIFF????WEBP  (12바이트 필요)
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        // TIFF little-endian: II*\0
        [b'I', b'I', 0x2A, 0x00, ..] => Some("image/tiff"),
        // TIFF big-endian: MM\0*
        [b'M', b'M', 0x00, 0x2A, ..] => Some("image/tiff"),
        // ISO Base Media File Format: ????ftyp{brand}  (HEIC, AVIF 등)
        _ if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" => {
            match &bytes[8..12] {
                b"heic" | b"heis" | b"hevx" | b"heim" | b"heix"
                | b"hevm" | b"hevs" | b"mif1" | b"msf1" => Some("image/heic"),
                b"avif" | b"avis" => Some("image/avif"),
                _ => None,
            }
        }
        _ => None,
    }
}

/// 확장자만으로 이미지 여부를 빠르게 판별합니다 (파일 미접근, O(1)).
fn is_image_by_ext(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(&format!(".{}", ext)))
}

/// 확장자 문자열로 MIME 타입을 반환합니다.
fn mime_from_ext(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png"          => Some("image/png"),
        "gif"          => Some("image/gif"),
        "bmp"          => Some("image/bmp"),
        "webp"         => Some("image/webp"),
        "heic" | "heif"=> Some("image/heic"),
        "tiff" | "tif" => Some("image/tiff"),
        "avif"         => Some("image/avif"),
        _ => None,
    }
}

#[derive(Debug)]
enum ImageConfidence {
    /// magic bytes로 확인된 이미지
    Verified(&'static str),
    /// 파일 없음 — 확장자로만 추정
    ExtOnly(&'static str),
    /// 이미지 아님 (magic bytes가 이미지 서명과 불일치)
    NotImage,
}

/// 파일 경로에 대해 이미지 여부를 판별합니다.
///
/// 1. 파일이 존재하면 첫 12바이트를 읽어 magic bytes 검사 (신뢰도 높음)
/// 2. magic bytes 미매칭 → 이미지 아님으로 최종 판단 (확장자가 jpg여도 비이미지 판정)
/// 3. 파일이 없으면 확장자로 폴백하되 ExtOnly로 표시
/// data URI의 MIME 타입 문자열을 정규화하여 &'static str로 반환합니다.
fn normalize_image_mime(declared: &str) -> Option<&'static str> {
    match declared.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/png"                => Some("image/png"),
        "image/gif"                => Some("image/gif"),
        "image/bmp"  | "image/x-bmp" => Some("image/bmp"),
        "image/webp"               => Some("image/webp"),
        "image/heic" | "image/heif"=> Some("image/heic"),
        "image/tiff" | "image/x-tiff" => Some("image/tiff"),
        "image/avif"               => Some("image/avif"),
        _ => None,
    }
}

/// HTML 콘텐츠에서 인라인 base64 이미지를 추출합니다.
/// 반환값: (순서 인덱스, 검증된 MIME 타입, 정제된 base64 문자열)
fn extract_inline_images(html: &str) -> Vec<(usize, &'static str, String)> {
    use base64::Engine;

    let re = INLINE_IMG_REGEX.get_or_init(|| {
        // data:image/...;base64, 뒤의 base64 데이터 캡처
        // base64 문자 + 줄바꿈/공백(일부 인코더가 76자마다 래핑)까지 허용
        regex::Regex::new(r"data:(image/[^;]{1,30});base64,([A-Za-z0-9+/\r\n\s=]{10,})").unwrap()
    });

    let mut result = Vec::new();

    for (idx, cap) in re.captures_iter(html).enumerate() {
        let declared_mime = &cap[1];
        // 공백/줄바꿈 제거 (래핑된 base64 처리)
        let b64_clean: String = cap[2].chars().filter(|c| !c.is_ascii_whitespace()).collect();

        // magic bytes 검증: base64 앞부분 16자(= 12바이트)만 디코딩하여 시그니처 확인
        let prefix: String = b64_clean.chars().take(16).collect();
        let verified_mime = base64::engine::general_purpose::STANDARD
            .decode(&prefix)
            .ok()
            .and_then(|bytes| detect_image_mime_from_bytes(&bytes));

        let mime = match verified_mime {
            Some(m) => m,                              // magic bytes 우선
            None    => match normalize_image_mime(declared_mime) {
                Some(m) => m,                          // 선언된 MIME 폴백
                None    => continue,                   // 알 수 없는 타입 → 건너뜀
            },
        };

        result.push((idx, mime, b64_clean));
    }

    result
}

fn classify_image(path: &std::path::Path) -> ImageConfidence {
    use std::io::Read;

    if path.exists() {
        let mut buf = [0u8; 12];
        let read = std::fs::File::open(path)
            .and_then(|mut f| f.read(&mut buf))
            .unwrap_or(0);

        return match detect_image_mime_from_bytes(&buf[..read]) {
            Some(mime) => ImageConfidence::Verified(mime),
            // 파일이 존재하는데 이미지 시그니처 없음 → 이미지 아님
            None => ImageConfidence::NotImage,
        };
    }

    // 파일 없음 — 확장자 폴백
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match mime_from_ext(ext) {
        Some(mime) => ImageConfidence::ExtOnly(mime),
        None => ImageConfidence::NotImage,
    }
}

fn call_tool(db_path: &PathBuf, edufine_db_path: &PathBuf, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "search_messages" => {
            let query = args["query"].as_str().ok_or("query required")?;
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 100);
            tool_search_messages(db_path, query, limit)
        }
        "get_messages" => {
            let stats = args["stats"].as_bool().unwrap_or(false);
            if stats {
                tool_get_db_stats(db_path)
            } else {
                let sender      = args["sender"].as_str();
                let date_from   = args["date_from"].as_str();
                let date_to     = args["date_to"].as_str();
                let limit       = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
                let offset      = args["offset"].as_i64().unwrap_or(0).max(0);
                let images_only = args["images_only"].as_bool().unwrap_or(false);
                if images_only {
                    tool_get_messages_with_images(db_path, limit, offset)
                } else {
                    tool_get_messages(db_path, sender, date_from, date_to, limit, offset)
                }
            }
        }
        "get_message_by_id" => {
            let id = args["id"].as_i64().ok_or("id required")?;
            tool_get_message_by_id(db_path, id)
        }
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
        "view_image" => {
            if let Some(filename) = args["filename"].as_str() {
                tool_read_image(filename)
            } else {
                let message_id = args["message_id"].as_i64().ok_or("filename 또는 message_id 필요")?;
                let index = args["index"].as_u64().unwrap_or(0) as usize;
                tool_read_inline_image(db_path, message_id, index)
            }
        }
        // ── 에듀파인 공문 툴 ─────────────────────────────────────────────────────
        "search_edufine_docs" => {
            let query = args["query"].as_str().ok_or("query required")?;
            let limit = args["limit"].as_i64().unwrap_or(10).clamp(1, 50);
            let docs = edufine_db::search_docs(edufine_db_path, query, limit)
                .map_err(|e| e.to_string())?;
            let items: Vec<Value> = docs
                .iter()
                .map(|d| {
                    json!({
                        "id": d.id,
                        "title": d.title,
                        "file_name": d.file_name,
                        "preview": d.preview,
                        "detected_at": d.detected_at
                    })
                })
                .collect();
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": serde_json::to_string_pretty(&items).unwrap_or_default()
                }]
            }))
        }

        "get_edufine_doc" => {
            let id = args["id"].as_i64().ok_or("id required")?;
            match edufine_db::get_doc(edufine_db_path, id).map_err(|e| e.to_string())? {
                Some(doc) => {
                    let text = format!(
                        "제목: {}\n파일명: {}\n감지일시: {}\n\n{}",
                        doc.title.as_deref().unwrap_or("(제목 없음)"),
                        doc.file_name,
                        doc.detected_at,
                        doc.content
                    );
                    let truncated = truncate_text(&text, 15000);
                    Ok(json!({
                        "content": [{ "type": "text", "text": truncated }]
                    }))
                }
                None => Err(format!("공문을 찾을 수 없습니다 (id={})", id)),
            }
        }

        "list_edufine_docs" => {
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 100);
            let offset = args["offset"].as_i64().unwrap_or(0).max(0);
            let docs = edufine_db::list_docs(edufine_db_path, limit, offset)
                .map_err(|e| e.to_string())?;
            let items: Vec<Value> = docs
                .iter()
                .map(|d| {
                    json!({
                        "id": d.id,
                        "title": d.title,
                        "file_name": d.file_name,
                        "preview": d.preview,
                        "detected_at": d.detected_at
                    })
                })
                .collect();
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": serde_json::to_string_pretty(&items).unwrap_or_default()
                }]
            }))
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

    // 앱 본체 검색과 동일한 하이브리드 전략: 3글자 이상이면 trigram FTS, 아니면 content_text LIKE
    let plan = match crate::search_db::plan_search_query(query) {
        Some(p) => p,
        None => {
            return Ok(json!({ "content": [{ "type": "text", "text": "검색어가 비어 있습니다." }] }));
        }
    };

    type SearchRow = (i64, String, String, Option<String>, Vec<String>);
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SearchRow> {
        let fp_json: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
        let file_paths: Vec<String> = serde_json::from_str(&fp_json).unwrap_or_default();
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, file_paths))
    };

    let mut rows: Vec<SearchRow> = Vec::new();

    if let Some(fts_query) = &plan.fts_query {
        let sql = "SELECT m.id, m.sender, m.content, m.receive_date, m.file_paths
                   FROM messages_fts
                   JOIN messages m ON m.id = messages_fts.rowid
                   WHERE messages_fts MATCH ?1
                   ORDER BY m.receive_date DESC
                   LIMIT ?2";
        let mut stmt = conn.prepare(sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;
        rows = stmt
            .query_map(rusqlite::params![fts_query, limit], |row| map_row(row))
            .map_err(|e| format!("쿼리 실패: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
    }

    if rows.is_empty() {
        let conditions: Vec<&str> = plan
            .terms
            .iter()
            .map(|_| "(m.content_text LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\')")
            .collect();
        let sql = format!(
            "SELECT m.id, m.sender, m.content, m.receive_date, m.file_paths
             FROM messages m
             WHERE {}
             ORDER BY m.receive_date DESC
             LIMIT ?",
            conditions.join(" AND ")
        );
        let mut bind: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for term in &plan.terms {
            let pattern = crate::search_db::like_pattern(term);
            bind.push(Box::new(pattern.clone()));
            bind.push(Box::new(pattern));
        }
        bind.push(Box::new(limit));

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;
        rows = stmt
            .query_map(
                rusqlite::params_from_iter(bind.iter().map(|p| p.as_ref())),
                |row| map_row(row),
            )
            .map_err(|e| format!("쿼리 실패: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
    }

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
        conditions.push(format!("substr(replace(receive_date, '/', '-'), 1, 10) >= '{}'", from.replace('\'', "''")));
        params_desc.push(format!("{}부터", from));
    }
    if let Some(to) = date_to {
        conditions.push(format!("substr(replace(receive_date, '/', '-'), 1, 10) <= '{}'", to.replace('\'', "''")));
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

// ─── 이미지 도구 ──────────────────────────────────────────────────────────────

fn tool_get_messages_with_images(
    db_path: &PathBuf,
    limit: i64,
    offset: i64,
) -> Result<Value, String> {
    let conn = open_db(db_path)?;
    let dir = get_attachments_dir();

    // 첨부 파일 이미지 OR 인라인 base64 이미지가 있을 수 있는 메시지를 모두 가져옴
    // content LIKE '%data:image/%' 로 인라인 이미지 후보를 빠르게 필터링
    let sql = "SELECT id, sender, content, content_preview, receive_date, file_paths
               FROM messages
               WHERE (file_paths IS NOT NULL AND file_paths != '[]' AND file_paths != '')
                  OR content LIKE '%data:image/%'
               ORDER BY receive_date DESC, id DESC
               LIMIT ?1 OFFSET ?2";

    let mut stmt = conn.prepare(sql).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    struct Row {
        id: i64,
        sender: String,
        content: String,
        preview: String,
        date: Option<String>,
        file_paths: Vec<String>,
    }

    let rows: Vec<Row> = stmt
        .query_map(rusqlite::params![limit, offset], |row| {
            let fp_json: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
            let file_paths: Vec<String> = serde_json::from_str(&fp_json).unwrap_or_default();
            Ok(Row {
                id:         row.get(0)?,
                sender:     row.get(1)?,
                content:    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                preview:    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                date:       row.get(4)?,
                file_paths,
            })
        })
        .map_err(|e| format!("쿼리 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut out = String::new();
    let mut image_msg_count = 0usize;

    for row in &rows {
        let mut has_image = false;
        let mut lines = String::new();

        // ── 1. 첨부 파일 이미지 ──────────────────────────────────────
        for fname in row.file_paths.iter().filter(|f| is_image_by_ext(f)) {
            let confidence = match &dir {
                Some(d) => classify_image(&d.join(fname)),
                None => {
                    let ext = std::path::Path::new(fname.as_str())
                        .extension().and_then(|e| e.to_str()).unwrap_or("");
                    match mime_from_ext(ext) {
                        Some(m) => ImageConfidence::ExtOnly(m),
                        None    => ImageConfidence::NotImage,
                    }
                }
            };
            match confidence {
                ImageConfidence::Verified(mime) => {
                    lines.push_str(&format!("  [첨부이미지] {} | {} | magic bytes 확인됨\n", fname, mime));
                    has_image = true;
                }
                ImageConfidence::ExtOnly(mime) => {
                    lines.push_str(&format!("  [첨부이미지] {} | {} | 확장자 추정 (파일 없음)\n", fname, mime));
                    has_image = true;
                }
                ImageConfidence::NotImage => {}
            }
        }

        // ── 2. HTML 인라인 base64 이미지 ────────────────────────────
        let inline_images = extract_inline_images(&row.content);
        for (idx, mime, _) in &inline_images {
            lines.push_str(&format!(
                "  [인라인이미지 #{}] {} | magic bytes 확인됨 | view_image로 읽기 가능\n",
                idx, mime
            ));
            has_image = true;
        }

        if !has_image {
            continue;
        }

        image_msg_count += 1;
        out.push_str(&format!(
            "ID: {} | 발신: {} | 날짜: {}\n{}\n",
            row.id,
            row.sender,
            row.date.as_deref().unwrap_or("날짜 없음"),
            row.preview.trim(),
        ));
        out.push_str(&lines);
        out.push('\n');
    }

    let text = if out.is_empty() {
        "이미지 첨부 메시지가 없습니다.".to_string()
    } else {
        format!("이미지 첨부 메시지 {}건:\n\n{}", image_msg_count, out)
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

/// Claude가 네이티브로 지원하는 이미지 MIME 타입
const CLAUDE_NATIVE_MIME: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

/// Claude API 실제 이미지 한도 (raw bytes 기준; base64 인코딩 후 ~5.3MB로 API 5MB 한도 이하)
const MAX_CLAUDE_BYTES: usize = 4 * 1024 * 1024; // 4 MB

/// Claude가 잘 처리하는 최대 이미지 변의 길이 (px)
const MAX_IMAGE_DIM: u32 = 2048;

/// 이미지를 Claude 전송 가능 형태로 변환합니다.
///
/// 1. 네이티브 지원 포맷(JPEG/PNG/GIF/WebP) + 4MB 이하 → 그대로 반환
/// 2. 비지원 포맷(BMP/TIFF) 또는 크기 초과 → 디코딩 후:
///    a. 2048px 초과 시 비율 유지하며 축소
///    b. PNG로 인코딩 → 4MB 이하면 반환
///    c. PNG도 크면 JPEG(손실 압축)로 폴백 → 4MB 이하면 반환
///    d. 그래도 크면 오류
fn prepare_image_for_claude(data: &[u8], detected_mime: &'static str) -> Result<(Vec<u8>, &'static str), String> {
    // 네이티브 포맷 + 적정 크기 → 그대로 사용
    if CLAUDE_NATIVE_MIME.contains(&detected_mime) && data.len() <= MAX_CLAUDE_BYTES {
        return Ok((data.to_vec(), detected_mime));
    }

    // 비지원 포맷 or 크기 초과 → 디코딩 후 처리
    let img = image::load_from_memory(data)
        .map_err(|e| format!("이미지 디코딩 실패 ({}): {}", detected_mime, e))?;

    // 해상도 축소
    let img = if img.width() > MAX_IMAGE_DIM || img.height() > MAX_IMAGE_DIM {
        img.resize(MAX_IMAGE_DIM, MAX_IMAGE_DIM, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // PNG 시도
    let mut out: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 인코딩 실패: {}", e))?;
    if out.len() <= MAX_CLAUDE_BYTES {
        return Ok((out, "image/png"));
    }

    // PNG도 크면 JPEG 폴백 (손실 압축)
    out.clear();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG 인코딩 실패: {}", e))?;
    if out.len() <= MAX_CLAUDE_BYTES {
        return Ok((out, "image/jpeg"));
    }

    Err(format!(
        "이미지를 {:.0}MB 이하로 압축할 수 없습니다 (변환 후 {:.1}MB). 원본: {:.1}MB",
        MAX_CLAUDE_BYTES as f64 / (1024.0 * 1024.0),
        out.len() as f64 / (1024.0 * 1024.0),
        data.len() as f64 / (1024.0 * 1024.0),
    ))
}

fn tool_read_image(filename: &str) -> Result<Value, String> {
    use base64::Engine;

    let dir = get_attachments_dir()
        .ok_or_else(|| "쿨메신저 수신 파일 경로를 찾을 수 없습니다.".to_string())?;
    let path = dir.join(filename);

    if !path.exists() {
        return Err(format!("파일을 찾을 수 없습니다: {}", filename));
    }

    // magic bytes로 이미지 여부 + MIME 타입 판별
    let detected_mime = match classify_image(&path) {
        ImageConfidence::Verified(m) => m,
        ImageConfidence::ExtOnly(m)  => m,
        ImageConfidence::NotImage => {
            return Err(format!(
                "이미지 파일이 아닙니다: {} (magic bytes 검사 실패)",
                filename
            ));
        }
    };

    let raw = std::fs::read(&path)
        .map_err(|e| format!("파일 읽기 실패: {}", e))?;

    // HEIC/AVIF 등 image 크레이트 미지원 포맷은 사전 차단
    if matches!(detected_mime, "image/heic" | "image/avif") {
        return Err(format!(
            "{} 형식은 자동 변환이 불가합니다 ({}). JPG 또는 PNG로 변환 후 다시 시도하세요.",
            detected_mime, filename
        ));
    }

    let (data, mime) = prepare_image_for_claude(&raw, detected_mime)?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);

    if detected_mime != mime {
        eprintln!("[MCP] read_image: {} → {} ({:.1}MB)", filename, mime, data.len() as f64 / (1024.0 * 1024.0));
    }

    Ok(json!({
        "content": [{
            "type": "image",
            "data": encoded,
            "mimeType": mime
        }]
    }))
}

fn tool_read_inline_image(db_path: &PathBuf, message_id: i64, index: usize) -> Result<Value, String> {
    let conn = open_db(db_path)?;

    let content: String = conn
        .query_row(
            "SELECT content FROM messages WHERE id = ?1",
            [message_id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("ID {}인 메시지를 찾을 수 없습니다.", message_id),
            other => format!("메시지 조회 실패: {}", other),
        })?;

    let images = extract_inline_images(&content);

    let (_, detected_mime, b64_data) = images
        .into_iter()
        .find(|(i, _, _)| *i == index)
        .ok_or_else(|| format!(
            "메시지 {}에서 인라인 이미지 #{} 를 찾을 수 없습니다. get_messages_with_images로 인덱스를 확인하세요.",
            message_id, index
        ))?;

    // HEIC/AVIF 등 미지원 포맷 사전 차단
    if matches!(detected_mime, "image/heic" | "image/avif") {
        return Err(format!(
            "{} 형식은 자동 변환이 불가합니다. JPG 또는 PNG로 변환 후 다시 시도하세요.",
            detected_mime
        ));
    }

    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&b64_data)
        .map_err(|e| format!("base64 디코딩 실패: {}", e))?;

    let (final_data, mime) = prepare_image_for_claude(&raw, detected_mime)?;
    let final_b64 = base64::engine::general_purpose::STANDARD.encode(&final_data);

    Ok(json!({
        "content": [{
            "type": "image",
            "data": final_b64,
            "mimeType": mime
        }]
    }))
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
    let re = XML_TAG_REGEX.get_or_init(|| regex::Regex::new(r"<[^>]+>").unwrap());
    let text = re.replace_all(xml, "");
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

pub fn start(db_path: PathBuf, edufine_db_path: PathBuf, port: u16) {
    let state = Arc::new(McpState { db_path, edufine_db_path });
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let router = Router::new()
        .route("/mcp", post(handle_mcp))
        .route("/mcp", options(|| async { axum::http::StatusCode::NO_CONTENT }))
        .layer(cors)
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
