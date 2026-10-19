use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::edufine_db;

static EDUFINE_ENABLED: AtomicBool = AtomicBool::new(false);

static WATCHER_HANDLE: OnceLock<Arc<Mutex<Option<WatcherStopHandle>>>> = OnceLock::new();

/// 새 공문이 저장될 때 호출할 콜백(브리핑 에이전트 트리거). main.rs setup 에서 등록.
static ON_NEW_DOC: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

pub fn set_on_new_doc(f: impl Fn() + Send + Sync + 'static) {
    let _ = ON_NEW_DOC.set(Box::new(f));
}

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
    let title = doc_title(&content, &file_name);

    match edufine_db::insert_doc(db_path, &file_name, Some(&title), &content, &hash) {
        Ok(Some(id)) => {
            eprintln!("[Edufine] 공문 저장: {} (id={})", file_name, id);
            if let Some(cb) = ON_NEW_DOC.get() {
                cb();
            }
        }
        Ok(None) => eprintln!("[Edufine] 중복 건너뜀: {}", file_name),
        Err(e) => eprintln!("[Edufine] DB 저장 실패: {}", e),
    }
}

// ── HWPX 파싱 ─────────────────────────────────────────────────────────────────

fn parse_hwpx(path: &PathBuf) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;

    // section XML 전체 파싱 우선. Preview/PrvText.txt 는 앞부분만 담겨 본문 뒤쪽의
    // 제출 기한 등을 놓칠 수 있어 폴백으로만 쓴다.
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
        if let Ok(mut entry) = zip.by_name("Preview/PrvText.txt") {
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_ok() {
                let text = String::from_utf8_lossy(&bytes).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
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
    // 문단 끝(HWPX hp:p, ODT text:p/text:h)은 줄바꿈으로 살려 문단 구조를 유지한다.
    let para_re = regex::Regex::new(r"</(hp:p|text:p|text:h)>").unwrap();
    let xml = para_re.replace_all(xml, "
");
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    let text = re.replace_all(&xml, " ");
    let text = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 공문 표시 제목. 순서: ① 본문의 "제목" 칸 → ② 의미 있는 파일명(임시 해시 이름 제외)
/// → ③ 본문 첫 의미 있는 줄 → ④ 파일명 그대로.
pub fn doc_title(content: &str, file_name: &str) -> String {
    if let Some(t) = title_from_subject_field(content) {
        return t;
    }
    // 결재 정보 표지(등록번호·결재일자만 있고 제목 칸이 없음) → 등록번호로 이름 붙임.
    static REG_NO: OnceLock<regex::Regex> = OnceLock::new();
    let reg_no = REG_NO.get_or_init(|| regex::Regex::new(r"등록번호\s+(\S+-\d+)").unwrap());
    if let Some(c) = reg_no.captures(content) {
        return format!("결재문서 {}", &c[1]);
    }
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .trim();
    if is_meaningful_name(stem) {
        return stem.to_string();
    }
    for line in content.lines() {
        let t = clean_title(line.trim_matches(|c: char| c.is_whitespace() || "<>[]()〈〉《》「」『』".contains(c)));
        let n = t.chars().count();
        if (4..=80).contains(&n) && t.chars().any(|c| c.is_alphanumeric()) {
            return t;
        }
    }
    stem.to_string()
}

/// 본문에서 "제목" 칸의 값을 찾는다. 두 저장 형식을 모두 지원한다.
/// - 문단 줄바꿈 형식: "제목" 다음 줄(또는 같은 줄 "제목 …", "제목: …")
/// - 한 줄 형식(구버전 ODT 파싱): "…(경유)   제목      <제목>      1. 관련…" — 칸은 공백 3개 이상으로 구분
fn title_from_subject_field(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    for (i, line) in lines.iter().enumerate() {
        let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        if compact == "제목" || compact == "제목:" {
            if let Some(next) = lines.get(i + 1) {
                let t = clean_title(next);
                if !t.is_empty() {
                    return Some(t);
                }
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("제목") else { continue };
        // "제목의" 같은 본문 단어가 아니라 칸 이름일 때만(뒤가 공백·콜론).
        if !rest.starts_with(|c: char| c.is_whitespace() || c == ':') {
            continue;
        }
        let value = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
        // 한 줄 형식이면 다음 칸(공백 3개 이상) 전까지만.
        let value = match value.find("   ") {
            Some(end) => &value[..end],
            None => value,
        };
        let t = clean_title(value);
        if !t.is_empty() {
            return Some(t);
        }
    }
    // 한 줄 형식에서 "제목"이 줄 중간에 있는 경우.
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?:^|\s{2,})제목\s{2,}(\S.*?)(?:\s{3,}|$)").unwrap());
    re.captures(content)
        .map(|c| clean_title(&c[1]))
        .filter(|t| !t.is_empty())
}

/// 공백을 하나로 접고 너무 긴 값은 자른다.
fn clean_title(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t: String = collapsed.chars().take(120).collect();
    if collapsed.chars().count() > 120 {
        t.push('…');
    }
    t
}

/// 에듀파인 임시 파일명(32자리 16진수 해시 등)이 아닌 사람이 붙인 이름인지.
fn is_meaningful_name(stem: &str) -> bool {
    let n = stem.chars().count();
    if n < 2 {
        return false;
    }
    let hexish = stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_');
    let digits = stem.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_');
    !(hexish && n >= 16) && !digits
}

/// 저장된 공문의 제목을 현재 규칙으로 다시 계산한다(시작 시 1회, 변경분만 UPDATE). 반환: 갱신 수.
pub fn refresh_titles(db_path: &PathBuf) -> usize {
    let docs = match edufine_db::list_docs_after(db_path, 0, i64::MAX) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[Edufine] 제목 갱신 조회 실패: {}", e);
            return 0;
        }
    };
    let mut updated = 0;
    for d in docs {
        let title = doc_title(&d.content, &d.file_name);
        if d.title.as_deref() != Some(title.as_str())
            && edufine_db::update_title(db_path, d.id, &title).is_ok()
        {
            updated += 1;
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_single_line_odt() {
        let c = "같이 배우고, 함께 키우는 부산                        부산광역시교육청                             수신      수신자 참조           (경유)                제목      (재안내) 2026년 하반기 학교 및 유치원 홈페이지 점검 변경 안내               1. 근거      가. 조례";
        assert_eq!(doc_title(c, "EDF699282860FB66CD3F499C6BFBB770.odt"), "(재안내) 2026년 하반기 학교 및 유치원 홈페이지 점검 변경 안내");
    }

    #[test]
    fn title_from_next_line() {
        let c = "같이 배우고, 함께 키우는 부산\n명호고등학교\n수신\n내부결재\n제목\n2026학년도 9.1.자 인사이동에 따른 정보보안담당관 변경 지정\n1. 관련";
        assert_eq!(doc_title(c, "89B4BE947D60528FBFF8AEA92B827E33.odt"), "2026학년도 9.1.자 인사이동에 따른 정보보안담당관 변경 지정");
        assert_eq!(doc_title("수신 내부결재\n제목: 규정 제출\n본문", "x.hwpx"), "규정 제출");
    }

    #[test]
    fn title_fallbacks() {
        // 붙임: 제목 칸 없음 → 사람이 붙인 파일명.
        let c = "<><>\n<2026년 디지털 미디어 리터러시 가족 캠프 운영 안내>\n부산광역시교육청";
        assert_eq!(doc_title(c, "(붙임1) 2026년 디지털 미디어 리터러시 가족 캠프 운영 안내.hwpx"), "(붙임1) 2026년 디지털 미디어 리터러시 가족 캠프 운영 안내");
        // 해시 파일명 → 본문 첫 의미 있는 줄(기호만 있는 줄은 건너뜀).
        assert_eq!(doc_title(c, "828979C7D50042EDD1342A1B659BA270.hwpx"), "2026년 디지털 미디어 리터러시 가족 캠프 운영 안내");
        // 본문의 "제목의" 같은 단어는 칸으로 보지 않는다.
        assert_eq!(doc_title("제목의 길이는 짧게\n본문", "ABCDEF0123456789ABCDEF0123456789.odt"), "제목의 길이는 짧게");
        // 아무것도 없으면 파일명.
        assert_eq!(doc_title("", "ABCDEF0123456789ABCDEF0123456789.odt"), "ABCDEF0123456789ABCDEF0123456789");
    }

    /// 실제 공문 DB 사본으로 제목 추출 확인:
    /// EDUFINE_DB=<사본 경로> cargo test --lib live_doc_titles -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_doc_titles() {
        let path = PathBuf::from(std::env::var("EDUFINE_DB").expect("EDUFINE_DB"));
        let docs = edufine_db::list_docs_after(&path, 0, i64::MAX).unwrap();
        let (mut field, mut name, mut line, mut raw) = (0, 0, 0, 0);
        for d in &docs {
            let t = doc_title(&d.content, &d.file_name);
            let stem = std::path::Path::new(&d.file_name).file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let kind = if title_from_subject_field(&d.content).is_some() {
                field += 1;
                "제목칸"
            } else if t == stem {
                if is_meaningful_name(&t) { name += 1; "파일명" } else { raw += 1; "해시" }
            } else {
                line += 1;
                "첫줄"
            };
            println!("#{} [{}] {}", d.id, kind, t);
        }
        println!("총 {} · 제목칸 {} · 파일명 {} · 첫줄 {} · 해시 {}", docs.len(), field, name, line, raw);
    }
}
