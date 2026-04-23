use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::edufine_db;

static EDUFINE_ENABLED: AtomicBool = AtomicBool::new(false);

static WATCHER_HANDLE: OnceLock<Arc<Mutex<Option<WatcherStopHandle>>>> = OnceLock::new();

struct WatcherStopHandle {
    stop_tx: std::sync::mpsc::Sender<()>,
}

pub fn get_watch_dir() -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("handytmp");
    dir
}

pub fn is_enabled() -> bool {
    EDUFINE_ENABLED.load(Ordering::Relaxed)
}

pub fn is_running() -> bool {
    WATCHER_HANDLE
        .get()
        .and_then(|s| s.lock().ok())
        .map(|g| g.is_some())
        .unwrap_or(false)
}

pub fn start(db_path: PathBuf) {
    EDUFINE_ENABLED.store(true, Ordering::Relaxed);

    let watch_dir = get_watch_dir();
    if !watch_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&watch_dir) {
            eprintln!("[Edufine] 감시 폴더 생성 실패: {}", e);
        }
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let db_path_clone = db_path.clone();
    let watch_dir_clone = watch_dir.clone();

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            match recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[Edufine] 감시 초기화 실패: {}", e);
                    return;
                }
            };

        if let Err(e) = watcher.watch(&watch_dir_clone, RecursiveMode::NonRecursive) {
            eprintln!("[Edufine] 감시 시작 실패: {}", e);
            return;
        }

        eprintln!("[Edufine] 파일 감시 시작: {:?}", watch_dir_clone);

        loop {
            if stop_rx.try_recv().is_ok() {
                eprintln!("[Edufine] 파일 감시 중지");
                break;
            }

            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(event) => {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for path in &event.paths {
                        let ext = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        if ext == "hwpx" || ext == "odt" {
                            let path_clone = path.clone();
                            let db_clone = db_path_clone.clone();
                            std::thread::spawn(move || {
                                process_file(&path_clone, &db_clone);
                            });
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }

        // watcher is dropped here, stopping the underlying FS watcher
    });

    let handle_slot = WATCHER_HANDLE.get_or_init(|| Arc::new(Mutex::new(None)));
    if let Ok(mut guard) = handle_slot.lock() {
        *guard = Some(WatcherStopHandle { stop_tx });
    }
}

pub fn stop() {
    EDUFINE_ENABLED.store(false, Ordering::Relaxed);
    if let Some(slot) = WATCHER_HANDLE.get() {
        if let Ok(mut guard) = slot.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.stop_tx.send(());
            }
        }
    }
}

// ── 파일 처리 ─────────────────────────────────────────────────────────────────

fn process_file(path: &PathBuf, db_path: &PathBuf) {
    // 파일이 완전히 쓰여질 때까지 대기 (최대 3초)
    let mut prev_size = 0u64;
    for _ in 0..15 {
        match std::fs::metadata(path) {
            Ok(m) if m.len() > 0 && m.len() == prev_size => break,
            Ok(m) => prev_size = m.len(),
            Err(_) => return,
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content = match ext.as_str() {
        "hwpx" => parse_hwpx(path),
        "odt" => parse_odt(path),
        _ => return,
    };

    let content = match content {
        Some(c) if !c.trim().is_empty() => c,
        _ => {
            eprintln!("[Edufine] 내용 없음: {:?}", path);
            return;
        }
    };

    // 결재 전 공문(작성 중) 필터: "시행 XXX-@N" 패턴이 있으면 건너뜀
    static DRAFT_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let draft_re = DRAFT_RE.get_or_init(|| {
        regex::Regex::new(r"시행\s+\S+-@N").unwrap()
    });
    if draft_re.is_match(&content) {
        eprintln!("[Edufine] 결재 전 공문 건너뜀: {}", file_name);
        return;
    }

    let hash = format!("{:x}", md5::compute(content.trim().as_bytes()));
    let title = extract_title(&content, &file_name);

    match edufine_db::insert_doc(db_path, &file_name, Some(&title), &content, &hash) {
        Ok(Some(id)) => eprintln!("[Edufine] 공문 저장: {} (id={})", file_name, id),
        Ok(None) => eprintln!("[Edufine] 중복 건너뜀: {}", file_name),
        Err(e) => eprintln!("[Edufine] DB 저장 실패: {}", e),
    }
}

// ── HWPX 파싱 ─────────────────────────────────────────────────────────────────

fn parse_hwpx(path: &PathBuf) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;

    // Preview/PrvText.txt 우선 (빠른 경로)
    if let Ok(mut entry) = zip.by_name("Preview/PrvText.txt") {
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_ok() {
            let text = String::from_utf8_lossy(&bytes).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    // 없으면 section XML 파싱
    let names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();
    let mut sections: Vec<String> = names
        .iter()
        .filter(|n| n.starts_with("Contents/section") && n.ends_with(".xml"))
        .cloned()
        .collect();
    sections.sort();

    let mut parts = Vec::new();
    for sec in &sections {
        if let Ok(mut entry) = zip.by_name(sec) {
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_ok() {
                if let Ok(xml) = std::str::from_utf8(&bytes) {
                    let text = strip_xml_tags(xml);
                    if !text.is_empty() {
                        parts.push(text);
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

// ── ODT 파싱 ──────────────────────────────────────────────────────────────────

fn parse_odt(path: &PathBuf) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut entry = zip.by_name("content.xml").ok()?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).ok()?;
    let xml = String::from_utf8_lossy(&bytes);
    let text = strip_xml_tags(&xml);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

fn strip_xml_tags(xml: &str) -> String {
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    let text = re.replace_all(xml, " ");
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_title(content: &str, file_name: &str) -> String {
    // 4~80자 사이의 첫 번째 의미있는 줄을 제목으로 사용
    for line in content.lines() {
        let t = line.trim();
        if t.len() >= 4 && t.len() <= 80 {
            return t.to_string();
        }
    }
    // 파일명에서 확장자 제거
    std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_string()
}
