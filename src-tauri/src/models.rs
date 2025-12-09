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
}
