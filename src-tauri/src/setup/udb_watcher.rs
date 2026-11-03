//! 쿨메신저 UDB 감시: `<udb>-wal` 변화로 새 메시지를 감지해 검색 DB 동기화,
//! 브리핑 에이전트 트리거, 메인 창 자동 표시를 한다.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::messages::get_latest_message_id_internal;
use crate::commands::system;
use crate::commands::window::LAST_HIDE_AT;
use crate::utils::is_class_time;
use crate::{agent, search_db};

pub(super) fn spawn(app: &mut tauri::App) {
    let Ok(Some(path)) = system::get_registry_value("UdbPath".to_string()) else {
        return;
    };
    let app_handle = app.app_handle().clone();
    std::thread::spawn(move || watch(app_handle, path));
}

fn watch(app_handle: AppHandle, path: String) {
    let udb_path = PathBuf::from(&path);
    let mut wal_path_os = udb_path.as_os_str().to_owned();
    wal_path_os.push("-wal");
    let wal_path = PathBuf::from(wal_path_os);

    let (tx, rx) = mpsc::channel();
    let mut watcher = recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })
    .ok();

    if let Some(w) = watcher.as_mut() {
        // udb-wal 파일의 생성/삭제/변경을 안정적으로 감지하기 위해 부모 디렉토리를 감시합니다.
        if let Some(parent) = udb_path.parent() {
            let _ = w.watch(parent, RecursiveMode::NonRecursive);
        }
    }

    let mut last_seen_id = get_latest_message_id_internal(path.clone()).ok().flatten();
    let mut baseline_initialized = last_seen_id.is_some();
    while let Ok(event) = rx.recv() {
        if !is_wal_event(&event, &wal_path) {
            continue;
        }

        // Create/Modify 이벤트라도 wal 파일이 실제로 있을 때만 처리 (오프라인 상태 방지)
        let should_process = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) && wal_path.exists();
        if !should_process {
            continue;
        }

        let mut has_new_message = false;
        if let Ok(Some(current_id)) = get_latest_message_id_internal(path.clone()) {
            has_new_message = match last_seen_id {
                Some(prev) => current_id > prev,
                None => !baseline_initialized,
            };
            last_seen_id = Some(current_id);
            baseline_initialized = true;
        }

        // 메시지가 실제로 변경되었을 때만 이벤트 발생
        if has_new_message {
            on_new_message(&app_handle, &path);
        }
    }
}

/// 이벤트 경로가 udb-wal 파일인지. 정규화된 경로로 비교하고, 실패하면 원본 경로로 비교.
fn is_wal_event(event: &notify::Event, wal_path: &Path) -> bool {
    let wal_canonical = wal_path.canonicalize().ok();
    event.paths.iter().any(|p| {
        if let (Ok(canonical), Some(wal_canonical)) = (p.canonicalize(), wal_canonical.as_ref()) {
            return canonical == *wal_canonical;
        }
        p == wal_path
    })
}

fn on_new_message(app_handle: &AppHandle, path: &str) {
    let _ = app_handle.emit("udb-changed", ());

    // Sync search DB in background
    let app_for_sync = app_handle.clone();
    let path_for_sync = path.to_string();
    std::thread::spawn(move || match search_db::sync_from_udb(&app_for_sync, path_for_sync) {
        // sync 로 search DB 가 채워진 뒤에야 MCP 서버가 신규 메시지를
        // 볼 수 있으므로, 이 시점에 브리핑 에이전트를 debounce 트리거한다.
        Ok(_) => agent::on_new_messages(&app_for_sync),
        Err(e) => eprintln!("Search DB sync failed: {}", e),
    });

    // 최근 숨김 직후에는 자동 표시 억제 (2초)
    let suppress_hide = LAST_HIDE_AT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .map(|t| t.elapsed() < Duration::from_secs(2))
        .unwrap_or(false);

    if !suppress_hide && !is_class_time() {
        if let Some(wv) = app_handle.get_webview_window("main") {
            let _ = wv.show();
            let _ = wv.set_focus();
        }
    }
}
