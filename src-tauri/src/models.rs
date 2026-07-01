use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use lru::LruCache;

#[derive(Serialize, Clone)]
pub struct Message {
    pub id: i64,
    pub sender: String,
    pub content: String,
    pub receive_date: Option<String>,
    pub file_paths: Vec<String>,
}

#[derive(Serialize)]
pub struct PaginatedMessages {
    pub messages: Vec<Message>,
    pub total_count: i64,
}

#[derive(Serialize, Clone)]
pub struct SearchResultItem {
    pub id: i64,
    pub sender: String,
    pub snippet: String,
    pub receive_date: Option<String>,
}

pub struct CacheState {
    pub search_cache: Mutex<LruCache<String, Vec<SearchResultItem>>>,
}

#[derive(Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// true = logical(DIP) 단위로 저장됨. 구버전 데이터는 physical 단위이며 `#[serde(default)]`로 false 로 역직렬화됨.
    /// (DPI 변경/모니터 전환 시 크기가 흔들리는 것을 막기 위해 logical 단위로 저장/복원)
    #[serde(default)]
    pub logical: bool,
}
