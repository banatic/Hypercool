/// 쿨메신저 「메시지 관리함」 / 「개의 안읽은 메시지」 창 감시자 (다중 창 지원)
///
/// 풀: download-panel-0/1/2 — 각 슬롯이 메시지 관리함 하나에 부착.
/// 단일 webview에서 collapsed(칩, 140x32) ↔ expanded(패널, 320x460) 전환.
///
/// 스레드 구조 (gif_watcher 패턴 + Helper v2 폴링 결합):
///   • watcher 메인 루프 (400ms)        — 메시지 관리함 발견 → 슬롯 할당
///   • track_target hook 스레드          — WinEvent (LOCATIONCHANGE/DESTROY/HIDE/SHOW) + GetMessageW
///   • file polling 스레드 (100ms)       — 자식 컨트롤 enumerate → files-updated emit + 자동 저장
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ─── 토글 ────────────────────────────────────────────────────────────────

static DOWNLOAD_HELPER_ENABLED: AtomicBool = AtomicBool::new(true);
static AUTO_SAVE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(enabled: bool) {
    DOWNLOAD_HELPER_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    DOWNLOAD_HELPER_ENABLED.load(Ordering::Relaxed)
}

pub fn set_auto_save(enabled: bool) {
    AUTO_SAVE_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_auto_save() -> bool {
    AUTO_SAVE_ENABLED.load(Ordering::Relaxed)
}

// ─── 풀 ──────────────────────────────────────────────────────────────────

pub const POOL: &[&str] = &[
    "download-panel-0",
    "download-panel-1",
    "download-panel-2",
];

/// target HWND(isize) → pool slot 인덱스
static TRACKED: OnceLock<Mutex<HashMap<isize, usize>>> = OnceLock::new();

fn get_tracked() -> std::sync::MutexGuard<'static, HashMap<isize, usize>> {
    TRACKED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
}

/// slot → target HWND(isize)
static SLOT_HWND: OnceLock<Mutex<HashMap<usize, isize>>> = OnceLock::new();

fn get_slot_hwnd_map() -> std::sync::MutexGuard<'static, HashMap<usize, isize>> {
    SLOT_HWND
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
}

/// label → expanded(true=패널, false=칩)
static EXPANDED: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn get_expanded_map() -> std::sync::MutexGuard<'static, HashMap<String, bool>> {
    EXPANDED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
}

pub fn is_expanded(label: &str) -> bool {
    get_expanded_map().get(label).copied().unwrap_or(false)
}

pub fn set_expanded(label: &str, expanded: bool) {
    get_expanded_map().insert(label.to_string(), expanded);
}

/// label → 마지막 자동 클릭 시각 (디바운스용)
static LAST_AUTOSAVE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn get_last_autosave() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    LAST_AUTOSAVE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
}

// ─── 사이즈 상수 ─────────────────────────────────────────────────────────

// 칩: webview2 최소 사이즈 제약 회피용으로 윈도우 자체는 40x100,
// 시각적 손잡이는 CSS에서 우측 정렬 24x80, 나머지는 transparent + pointer-events:none.
pub const COLLAPSED_W: i32 = 40;
pub const COLLAPSED_H: i32 = 100;
pub const EXPANDED_W: i32 = 320;
// 패널 영역만의 최대 높이 (윈도우는 칩 100 + 갭 + 이 값)
const PANEL_H_MAX: i32 = 460;
const PANEL_H_MIN: i32 = 240;
// 칩과 패널 사이 간격 (윈도우 안에서 시각적 분리)
const PANEL_GAP: i32 = 4;

const AUTOSAVE_DEBOUNCE: Duration = Duration::from_millis(1000);
const FILE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(400);

// ─── 타이틀 키워드 ──────────────────────────────────────────────────────

const TITLE_KEYWORDS: &[&str] = &["메시지 관리함", "개의 안읽은 메시지"];
const SAVE_BUTTON_TEXT: &str = "모든파일 저장 (Ctrl+S)";

// ─── 페이로드 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

// ─── Hook context (thread-local) ─────────────────────────────────────────

#[cfg(target_os = "windows")]
struct HookState {
    app: AppHandle,
    target_hwnd: windows::Win32::Foundation::HWND,
    label: String,
}

#[cfg(target_os = "windows")]
thread_local! {
    static HOOK_STATE: RefCell<Option<HookState>> = RefCell::new(None);
}

// ─── Watcher 진입점 ──────────────────────────────────────────────────────

pub fn start_watcher(app: AppHandle) {
    loop {
        std::thread::sleep(DISCOVERY_INTERVAL);

        if !DOWNLOAD_HELPER_ENABLED.load(Ordering::Relaxed) {
            continue;
        }

        #[cfg(target_os = "windows")]
        {
            let targets = find_all_inbox_windows();

            for (hwnd, rect) in targets {
                let hwnd_val = hwnd.0 as isize;

                if get_tracked().contains_key(&hwnd_val) {
                    continue;
                }

                let slot = {
                    let used: HashSet<usize> = get_tracked().values().copied().collect();
                    (0..POOL.len()).find(|i| !used.contains(i))
                };
                let Some(slot) = slot else { continue; };

                get_tracked().insert(hwnd_val, slot);
                get_slot_hwnd_map().insert(slot, hwnd_val);
                let label = POOL[slot].to_string();
                let app_clone = app.clone();

                std::thread::spawn(move || {
                    let h = windows::Win32::Foundation::HWND(
                        hwnd_val as *mut core::ffi::c_void,
                    );
                    track_target(app_clone, h, rect, label);
                    get_tracked().remove(&hwnd_val);
                    get_slot_hwnd_map().remove(&slot);
                });
            }
        }
    }
}

// ─── DWM-aware rect (시각적 frame) ───────────────────────────────────────
//
// Win10/11의 GetWindowRect는 보이지 않는 DWM resize border (~7px) 를 포함하므로
// 사용자가 보는 frame과 다르다. DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)
// 가 시각적 frame을 반환한다 (Vista+). 실패 시 GetWindowRect 폴백.

#[cfg(target_os = "windows")]
fn get_effective_rect(hwnd: windows::Win32::Foundation::HWND) -> Option<WindowRect> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    unsafe {
        let mut r = RECT::default();
        // 1순위: DWM extended frame bounds (시각적 frame)
        let dwm_ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if dwm_ok && (r.right > r.left) && (r.bottom > r.top) {
            return Some(WindowRect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            });
        }
        // 폴백: GetWindowRect (DWM border 포함)
        let mut r2 = RECT::default();
        if GetWindowRect(hwnd, &mut r2).is_ok() {
            return Some(WindowRect {
                left: r2.left,
                top: r2.top,
                right: r2.right,
                bottom: r2.bottom,
            });
        }
        None
    }
}

// ─── 대상 창 enumerate ──────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn find_all_inbox_windows() -> Vec<(windows::Win32::Foundation::HWND, WindowRect)> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible,
    };

    struct Ctx {
        results: Vec<(HWND, WindowRect)>,
    }

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return BOOL(1);
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let written = GetWindowTextW(hwnd, &mut buf);
        if written == 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&buf[..written as usize]);
        if TITLE_KEYWORDS.iter().any(|kw| title.contains(kw)) {
            if let Some(wr) = get_effective_rect(hwnd) {
                ctx.results.push((hwnd, wr));
            }
        }
        BOOL(1)
    }

    let mut ctx = Ctx {
        results: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.results
}

// ─── 트래킹 (slot당 1회) ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn track_target(
    app: AppHandle,
    hwnd: windows::Win32::Foundation::HWND,
    rect: WindowRect,
    label: String,
) {
    // 초기 상태: collapsed (칩)
    set_expanded(&label, false);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_size(tauri::PhysicalSize::new(
            COLLAPSED_W as u32,
            COLLAPSED_H as u32,
        ));
    }
    position_panel(&app, &label, &rect, false);
    set_panel_owner(&app, &label, hwnd);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
    }
    let _ = app.emit_to(label.as_str(), "download-panel://status", "connected");

    // 파일 폴링 스레드 spawn
    let stop_flag = std::sync::Arc::new(AtomicBool::new(false));
    let poll_app = app.clone();
    let poll_label = label.clone();
    let poll_hwnd = hwnd.0 as isize;
    let poll_stop = stop_flag.clone();
    let poll_thread = std::thread::spawn(move || {
        file_poll_loop(poll_app, poll_hwnd, poll_label, poll_stop);
    });

    // WinEvent hook 메시지 루프 (블로킹)
    track_with_hooks(&app, hwnd, &label);

    // 정리
    stop_flag.store(true, Ordering::Relaxed);
    let _ = poll_thread.join();

    let _ = app.emit_to(label.as_str(), "download-panel://status", "disconnected");
    let _ = app.emit_to(label.as_str(), "download-panel://files", Vec::<FileInfo>::new());
    clear_panel_owner(&app, &label);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
    }
    get_last_autosave().remove(&label);
    get_expanded_map().remove(&label);
}

// ─── 파일 폴링 루프 ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn file_poll_loop(
    app: AppHandle,
    hwnd_val: isize,
    label: String,
    stop: std::sync::Arc<AtomicBool>,
) {
    let mut last_files: Vec<String> = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(FILE_POLL_INTERVAL);

        if !DOWNLOAD_HELPER_ENABLED.load(Ordering::Relaxed) {
            continue;
        }

        let hwnd =
            windows::Win32::Foundation::HWND(hwnd_val as *mut core::ffi::c_void);

        let raw = find_file_entries(hwnd);
        if raw == last_files {
            continue;
        }
        last_files = raw.clone();

        let download_path = get_download_path();
        let mut any_new = false;
        let infos: Vec<FileInfo> = raw
            .iter()
            .map(|text| {
                let name = extract_filename(text);
                let path = format!("{}\\{}", download_path, name);
                let (exists, size, modified) = file_meta(&path);
                if !exists {
                    any_new = true;
                }
                FileInfo {
                    name,
                    path,
                    size,
                    modified,
                    exists,
                }
            })
            .collect();

        if any_new && AUTO_SAVE_ENABLED.load(Ordering::Relaxed) {
            // 디바운스: 같은 슬롯에서 1초 이내 중복 클릭 방지
            let now = Instant::now();
            let mut map = get_last_autosave();
            let can_click = map
                .get(&label)
                .map(|t| now.duration_since(*t) >= AUTOSAVE_DEBOUNCE)
                .unwrap_or(true);
            if can_click {
                map.insert(label.clone(), now);
                drop(map);
                let _ = click_save_button(hwnd);
            }
        }

        let _ = app.emit_to(label.as_str(), "download-panel://files", infos);
    }
}

// ─── 파일 메타 ──────────────────────────────────────────────────────────

fn file_meta(path: &str) -> (bool, Option<u64>, Option<String>) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let size = m.len();
            let modified = m.modified().ok().map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.format("%Y-%m-%d %H:%M").to_string()
            });
            (true, Some(size), modified)
        }
        Err(_) => (false, None, None),
    }
}

// ─── WinEvent hook ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn track_with_hooks(
    app: &AppHandle,
    target_hwnd: windows::Win32::Foundation::HWND,
    label: &str,
) {
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, GetWindowThreadProcessId, IsWindow, PostQuitMessage,
        TranslateMessage, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE,
        MSG, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };

    HOOK_STATE.with(|s| {
        *s.borrow_mut() = Some(HookState {
            app: app.clone(),
            target_hwnd,
            label: label.to_string(),
        });
    });

    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(target_hwnd, Some(&mut pid));

        let hook_pos = SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE,
            EVENT_OBJECT_LOCATIONCHANGE,
            None,
            Some(win_event_proc),
            pid,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        // DESTROY(0x8001) ~ HIDE(0x8003): SHOW(0x8002) 포함
        let hook_lifecycle = SetWinEventHook(
            EVENT_OBJECT_DESTROY,
            EVENT_OBJECT_HIDE,
            None,
            Some(win_event_proc),
            pid,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );

        if !IsWindow(target_hwnd).as_bool() {
            PostQuitMessage(0);
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if !hook_pos.is_invalid() {
            let _ = UnhookWinEvent(hook_pos);
        }
        if !hook_lifecycle.is_invalid() {
            let _ = UnhookWinEvent(hook_lifecycle);
        }
    }

    HOOK_STATE.with(|s| {
        *s.borrow_mut() = None;
    });
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn win_event_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    id_child: i32,
    _id_thread: u32,
    _time: u32,
) {
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, PostQuitMessage, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
        EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_SHOW,
    };

    if !DOWNLOAD_HELPER_ENABLED.load(Ordering::Relaxed) {
        PostQuitMessage(0);
        return;
    }

    HOOK_STATE.with(|s| {
        let borrowed = s.borrow();
        let Some(ref state) = *borrowed else { return };

        if hwnd != state.target_hwnd || id_object != 0 {
            return;
        }

        let expanded = is_expanded(&state.label);

        match event {
            EVENT_OBJECT_LOCATIONCHANGE if id_child == 0 => {
                if IsIconic(hwnd).as_bool() {
                    return;
                }
                if let Some(wr) = get_effective_rect(hwnd) {
                    position_panel(&state.app, &state.label, &wr, expanded);
                }
            }
            EVENT_OBJECT_DESTROY => {
                PostQuitMessage(0);
            }
            EVENT_OBJECT_HIDE => {
                if let Some(w) = state.app.get_webview_window(&state.label) {
                    let _ = w.hide();
                }
            }
            EVENT_OBJECT_SHOW => {
                if let Some(wr) = get_effective_rect(hwnd) {
                    position_panel(&state.app, &state.label, &wr, expanded);
                    if let Some(w) = state.app.get_webview_window(&state.label) {
                        let _ = w.show();
                    }
                }
            }
            _ => {}
        }
    });
}

// ─── owner-chain ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn set_panel_owner(
    app: &AppHandle,
    label: &str,
    owner: windows::Win32::Foundation::HWND,
) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, WINDOW_LONG_PTR_INDEX};
    if let Some(win) = app.get_webview_window(label) {
        if let Ok(raw) = win.hwnd() {
            let h = windows::Win32::Foundation::HWND(raw.0);
            unsafe {
                SetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(-8), owner.0 as isize);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn clear_panel_owner(app: &AppHandle, label: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, WINDOW_LONG_PTR_INDEX};
    if let Some(win) = app.get_webview_window(label) {
        if let Ok(raw) = win.hwnd() {
            let h = windows::Win32::Foundation::HWND(raw.0);
            unsafe {
                SetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(-8), 0isize);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn set_panel_owner(_app: &AppHandle, _label: &str, _owner: ()) {}

#[cfg(not(target_os = "windows"))]
fn clear_panel_owner(_app: &AppHandle, _label: &str) {}

// ─── 위치 계산 + 적용 ────────────────────────────────────────────────────

/// 패널 영역만의 높이를 메시지 관리함 height에 맞춰 동적으로 결정.
/// 메시지 관리함이 작으면 더 작게, 크면 PANEL_H_MAX로 clamping.
pub fn dynamic_panel_height(rect: &WindowRect) -> i32 {
    let inbox_h = (rect.bottom - rect.top).max(0);
    inbox_h.clamp(PANEL_H_MIN, PANEL_H_MAX)
}

/// 메시지 관리함에 부착될 위치 + 사이즈 계산.
///
/// 핵심 설계:
///   • side 결정 (우측 vs 좌측 mirror) 은 **항상 EXPANDED_W 기준** 으로 판단.
///     → collapsed → expanded 전환 시 side가 바뀌지 않아 마우스가 항상 윈도우 안에 머무름 (깜빡임 차단).
///   • 우측 모드: 윈도우 좌측 좌표가 일관 (rect.right + 4). expand 시 우측으로 확장.
///   • 좌측 mirror 모드: 윈도우 *우측* 좌표가 일관 (rect.left - 4). expand 시 좌측으로 확장.
///     → 두 모드 모두 칩이 위치한 좌표 영역이 expand 후에도 윈도우 내부에 머무름.
///   • collapsed/expanded 모두 top 정렬 (rect.bottom - COLLAPSED_H). 패널이 칩 아래로 자라남.
///   • 모니터 하단 침범 시: 윈도우를 위쪽으로 밀어 올림 (드물게 발생).
///
/// 반환: (x, y, w, h, mirror) — 전부 physical px. mirror=true면 좌측 폴백.
pub fn calculate_window_geometry(rect: &WindowRect, expanded: bool) -> (i32, i32, i32, i32, bool) {
    let monitors = get_monitors();
    let target_cx = rect.right;
    let target_cy = (rect.top + rect.bottom) / 2;
    let mon = monitors
        .iter()
        .find(|m| {
            m.left <= target_cx && target_cx <= m.right && m.top <= target_cy && target_cy <= m.bottom
        })
        .cloned()
        .or_else(|| monitors.first().cloned())
        .unwrap_or(MonitorInfo {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
            is_primary: true,
        });

    let panel_h = dynamic_panel_height(rect);
    let (w, h) = if expanded {
        (EXPANDED_W, COLLAPSED_H + PANEL_GAP + panel_h)
    } else {
        (COLLAPSED_W, COLLAPSED_H)
    };

    // ── side 결정: 항상 EXPANDED_W 기준 (깜빡임 방지) ──
    // expanded 윈도우 우측 (rect.right + 4 + EXPANDED_W) 이 모니터 우측에 들어가면 우측 모드.
    // 안 들어가면 mirror (좌측) 모드. 좌측도 안 들어가면 어쩔 수 없이 우측 강제 (메시지 관리함 위에 겹침).
    let fits_right = rect.right + 4 + EXPANDED_W <= mon.right;
    let fits_left = rect.left - 4 - EXPANDED_W >= mon.left;
    let mirror = !fits_right && fits_left;

    // ── x 좌표 계산 (mirror 여부에 따라) ──
    let x = if mirror {
        // mirror 모드: 윈도우 우측을 메시지 관리함 좌측 4px 외부에 고정.
        // → 윈도우 좌측 = (rect.left - 4) - w. collapsed/expanded 모두 우측이 동일 → mouse hover 유지.
        rect.left - 4 - w
    } else {
        // 우측 모드 (기본): 윈도우 좌측 = rect.right + 4. collapsed/expanded 모두 좌측이 동일.
        rect.right + 4
    };

    // ── y 좌표 (top 정렬 + 모니터 하단 침범 시 위로 밀기) ──
    let mut y = rect.bottom - COLLAPSED_H;
    if expanded {
        let overflow = (y + h) - mon.bottom;
        if overflow > 0 {
            y = (rect.bottom - h).max(mon.top);
        }
    }

    (x, y, w, h, mirror)
}

pub fn position_panel(app: &AppHandle, label: &str, rect: &WindowRect, expanded: bool) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };

    let (x, y, w, h, mirror) = calculate_window_geometry(rect, expanded);

    // 패널 영역 (CSS에서 사용할 수 있도록 emit)
    let panel_h = dynamic_panel_height(rect);
    let _ = app.emit_to(
        label,
        "download-panel://geometry",
        serde_json::json!({
            "chip_h": COLLAPSED_H,
            "gap": PANEL_GAP,
            "panel_h": panel_h,
            "expanded": expanded,
            "mirror": mirror,
        }),
    );

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        if let Ok(raw) = win.hwnd() {
            let hwnd = HWND(raw.0);
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    HWND(std::ptr::null_mut()),
                    x,
                    y,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// 슬롯 label로 현재 부착된 hwnd의 rect를 다시 조회해 위치 갱신.
/// 칩 ↔ 패널 토글 명령에서 호출.
pub fn reposition_by_label(app: &AppHandle, label: &str, expanded: bool) {
    let Some(slot) = POOL.iter().position(|&s| s == label) else {
        return;
    };
    let Some(hwnd_val) = get_slot_hwnd_map().get(&slot).copied() else {
        return;
    };
    set_expanded(label, expanded);
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        let hwnd = HWND(hwnd_val as *mut core::ffi::c_void);
        if let Some(wr) = get_effective_rect(hwnd) {
            position_panel(app, label, &wr, expanded);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hwnd_val;
    }
}

// ─── 모니터 정보 ────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct MonitorInfo {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub is_primary: bool,
}

#[cfg(target_os = "windows")]
pub fn get_monitors() -> Vec<MonitorInfo> {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };

    struct Ctx {
        monitors: Vec<MonitorInfo>,
    }
    unsafe extern "system" fn cb(
        hmon: HMONITOR,
        _hdc: HDC,
        _r: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFO as *mut _).as_bool() {
            ctx.monitors.push(MonitorInfo {
                left: mi.rcWork.left,
                top: mi.rcWork.top,
                right: mi.rcWork.right,
                bottom: mi.rcWork.bottom,
                is_primary: (mi.dwFlags & 1) != 0,
            });
        }
        BOOL(1)
    }
    let mut ctx = Ctx {
        monitors: Vec::new(),
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(cb),
            LPARAM(&mut ctx as *mut Ctx as isize),
        );
    }
    ctx.monitors.sort_by(|a, b| b.is_primary.cmp(&a.is_primary));
    ctx.monitors
}

#[cfg(not(target_os = "windows"))]
pub fn get_monitors() -> Vec<MonitorInfo> {
    vec![MonitorInfo {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
        is_primary: true,
    }]
}

// ─── 파일 entry enumerate ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn hwnd_text(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_GETTEXT, WM_GETTEXTLENGTH};
    unsafe {
        let len = SendMessageW(hwnd, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0));
        if len.0 <= 0 {
            return String::new();
        }
        let cap = len.0 as usize + 1;
        let mut buf: Vec<u16> = vec![0u16; cap];
        SendMessageW(
            hwnd,
            WM_GETTEXT,
            WPARAM(cap),
            LPARAM(buf.as_mut_ptr() as isize),
        );
        String::from_utf16_lossy(&buf[..len.0 as usize])
    }
}

fn size_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\(\d+(?:\.\d+)?\s?(?:KB|MB|GB)\)$").unwrap())
}

#[cfg(target_os = "windows")]
pub fn find_file_entries(hwnd: windows::Win32::Foundation::HWND) -> Vec<String> {
    use windows::Win32::Foundation::{BOOL, HWND as HWNDT, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, IsWindowVisible};

    struct Ctx {
        results: Vec<String>,
    }
    unsafe extern "system" fn cb(h: HWNDT, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(h).as_bool() {
            let ctx = &mut *(lparam.0 as *mut Ctx);
            let text = hwnd_text(h);
            if size_re().is_match(&text) {
                ctx.results.push(text);
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx {
        results: Vec::new(),
    };
    unsafe {
        let _ = EnumChildWindows(hwnd, Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.results
}

pub fn extract_filename(text: &str) -> String {
    if let Some(m) = size_re().find(text) {
        text[..m.start()].trim().to_string()
    } else {
        text.trim().to_string()
    }
}

// ─── 저장 버튼 자동 클릭 ─────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn click_save_button(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::Foundation::{BOOL, HWND as HWNDT, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, SendMessageW, BM_CLICK,
    };

    struct Ctx {
        found: Option<HWNDT>,
    }
    unsafe extern "system" fn cb(h: HWNDT, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if ctx.found.is_some() {
            return BOOL(0);
        }
        let text = hwnd_text(h);
        if text.trim() == SAVE_BUTTON_TEXT {
            ctx.found = Some(h);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut ctx = Ctx { found: None };
    unsafe {
        let _ = EnumChildWindows(hwnd, Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
        if let Some(btn) = ctx.found {
            SendMessageW(btn, BM_CLICK, WPARAM(0), LPARAM(0));
            return true;
        }
    }
    false
}

// ─── 다운로드 경로 (CoolMessenger 레지스트리) ────────────────────────────

pub fn get_download_path() -> String {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(subkey) = hkcu.open_subkey(r"Software\Jiransoft\CoolMsg50\Option\GetFile") {
        if let Ok(v) = subkey.get_value::<String, _>("DownPath") {
            return v;
        }
    }
    // Fallback: %USERPROFILE%\Downloads
    if let Ok(home) = std::env::var("USERPROFILE") {
        return format!("{}\\Downloads", home);
    }
    ".".to_string()
}
