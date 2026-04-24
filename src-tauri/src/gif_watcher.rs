/// GIF 위젯 창 감시자 (다중 창 지원)
/// gif-btn-N ↔ gif-widget-N 쌍으로 묶어 관리.
/// SetWindowLongPtrW(GWLP_HWNDPARENT)로 owner 관계를 설정해 Windows가 z-order 자동 관리.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static GIF_WIDGET_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(enabled: bool) {
    GIF_WIDGET_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    GIF_WIDGET_ENABLED.load(Ordering::Relaxed)
}

/// gif-btn 풀 레이블 — gif-widget은 "gif-btn" → "gif-widget" 치환으로 도출
pub const POOL: &[&str] = &["gif-btn-0", "gif-btn-1", "gif-btn-2"];
/// class-btn 풀 레이블 — POOL[n]과 같은 슬롯 공유
pub const CLASS_POOL: &[&str] = &["class-btn-0", "class-btn-1", "class-btn-2"];

/// 추적 중인 target HWND(isize) → pool slot 인덱스
static TRACKED: OnceLock<Mutex<HashMap<isize, usize>>> = OnceLock::new();

fn get_tracked() -> std::sync::MutexGuard<'static, HashMap<isize, usize>> {
    TRACKED.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap()
}

/// pool slot → 현재 추적 중인 target HWND(isize)
static SLOT_HWND: OnceLock<Mutex<HashMap<usize, isize>>> = OnceLock::new();

fn get_slot_hwnd_map() -> std::sync::MutexGuard<'static, HashMap<usize, isize>> {
    SLOT_HWND.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap()
}

pub fn get_slot_hwnd(slot: usize) -> Option<isize> {
    get_slot_hwnd_map().get(&slot).copied()
}

pub fn compute_panel_position(btn_x: i32, btn_y: i32) -> (i32, i32) {
    const PANEL_W: i32 = 420;
    const PANEL_H: i32 = 580;
    const BTN_W: i32 = 70;
    let x = (btn_x + BTN_W / 2 - PANEL_W / 2).max(0);
    let y = (btn_y - PANEL_H).max(0);
    (x, y)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WindowRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[cfg(target_os = "windows")]
struct HookState {
    app: AppHandle,
    target_hwnd: windows::Win32::Foundation::HWND,
    btn_label: String,
    class_btn_label: String,
}

#[cfg(target_os = "windows")]
thread_local! {
    static HOOK_STATE: RefCell<Option<HookState>> = RefCell::new(None);
}

pub fn start_watcher(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(400));

        if !GIF_WIDGET_ENABLED.load(Ordering::Relaxed) {
            continue;
        }

        #[cfg(target_os = "windows")]
        {
            let targets = find_all_target_windows();

            for (hwnd, rect) in targets {
                let hwnd_val = hwnd.0 as isize;

                if get_tracked().contains_key(&hwnd_val) {
                    continue;
                }

                let slot = {
                    let used: HashSet<usize> = get_tracked().values().copied().collect();
                    (0..POOL.len()).find(|&i| !used.contains(&i))
                };
                let Some(slot) = slot else { continue; };

                get_tracked().insert(hwnd_val, slot);
                get_slot_hwnd_map().insert(slot, hwnd_val);
                let btn_label = POOL[slot].to_string();
                let app_clone = app.clone();

                std::thread::spawn(move || {
                    let h = windows::Win32::Foundation::HWND(
                        hwnd_val as *mut core::ffi::c_void,
                    );
                    track_target(app_clone, h, rect, btn_label);
                    get_tracked().remove(&hwnd_val);
                    get_slot_hwnd_map().remove(&slot);
                });
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn track_target(
    app: AppHandle,
    hwnd: windows::Win32::Foundation::HWND,
    rect: WindowRect,
    btn_label: String,
) {
    let widget_label = btn_label.replace("gif-btn", "gif-widget");
    let class_btn_label = btn_label.replace("gif-btn", "class-btn");

    if let Some(win) = app.get_webview_window(&btn_label) {
        let _ = win.show();
    }
    if let Some(win) = app.get_webview_window(&class_btn_label) {
        let _ = win.show();
    }
    position_gif_btn(&app, &btn_label, &rect);
    position_class_btn(&app, &class_btn_label, &rect);
    set_gif_btn_owner(&app, &btn_label, hwnd);
    set_gif_btn_owner(&app, &class_btn_label, hwnd);

    track_with_hooks(&app, hwnd, &btn_label, &class_btn_label);

    // 창 소멸 후 정리
    clear_gif_btn_owner(&app, &btn_label);
    clear_gif_btn_owner(&app, &class_btn_label);
    if let Some(w) = app.get_webview_window(&btn_label) {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window(&class_btn_label) {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window(&widget_label) {
        let was_visible = w.is_visible().unwrap_or(false);
        let _ = w.hide();
        if was_visible {
            let _ = app.emit("gif-panel-closed", &btn_label);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_gif_btn_owner(app: &AppHandle, btn_label: &str, owner: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, WINDOW_LONG_PTR_INDEX};
    if let Some(win) = app.get_webview_window(btn_label) {
        if let Ok(raw) = win.hwnd() {
            let h = windows::Win32::Foundation::HWND(raw.0);
            unsafe { SetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(-8), owner.0 as isize); }
        }
    }
}

#[cfg(target_os = "windows")]
fn clear_gif_btn_owner(app: &AppHandle, btn_label: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, WINDOW_LONG_PTR_INDEX};
    if let Some(win) = app.get_webview_window(btn_label) {
        if let Ok(raw) = win.hwnd() {
            let h = windows::Win32::Foundation::HWND(raw.0);
            unsafe { SetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(-8), 0isize); }
        }
    }
}

/// gif-widget-N의 owner를 gif-btn-N으로 설정 (창 생성 시 1회)
#[cfg(target_os = "windows")]
pub fn set_panel_owner(panel: &tauri::WebviewWindow, btn: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, WINDOW_LONG_PTR_INDEX};
    if let (Ok(btn_raw), Ok(panel_raw)) = (btn.hwnd(), panel.hwnd()) {
        unsafe {
            SetWindowLongPtrW(
                windows::Win32::Foundation::HWND(panel_raw.0),
                WINDOW_LONG_PTR_INDEX(-8),
                btn_raw.0 as isize,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_panel_owner(_panel: &tauri::WebviewWindow, _btn: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn find_all_target_windows() -> Vec<(windows::Win32::Foundation::HWND, WindowRect)> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindowVisible,
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
        if len <= 0 { return BOOL(1); }
        let mut buf = vec![0u16; (len + 1) as usize];
        let written = GetWindowTextW(hwnd, &mut buf);
        if written == 0 { return BOOL(1); }
        let title = String::from_utf16_lossy(&buf[..written as usize]);
        if title.contains("메시지 전송") {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                ctx.results.push((hwnd, WindowRect {
                    left: rect.left, top: rect.top,
                    right: rect.right, bottom: rect.bottom,
                }));
            }
        }
        BOOL(1)
    }

    let mut ctx = Ctx { results: Vec::new() };
    unsafe { let _ = EnumWindows(Some(callback), LPARAM(&mut ctx as *mut Ctx as isize)); }
    ctx.results
}

#[cfg(target_os = "windows")]
fn track_with_hooks(
    app: &AppHandle,
    target_hwnd: windows::Win32::Foundation::HWND,
    btn_label: &str,
    class_btn_label: &str,
) {
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, GetWindowThreadProcessId, IsWindow, PostQuitMessage,
        TranslateMessage, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE,
        WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, MSG,
    };

    HOOK_STATE.with(|s| {
        *s.borrow_mut() = Some(HookState {
            app: app.clone(),
            target_hwnd,
            btn_label: btn_label.to_string(),
            class_btn_label: class_btn_label.to_string(),
        });
    });

    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(target_hwnd, Some(&mut pid));

        let hook_pos = SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,
            None, Some(win_event_proc), pid, 0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        // DESTROY(0x8001) ~ HIDE(0x8003): SHOW(0x8002) 포함
        let hook_lifecycle = SetWinEventHook(
            EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
            None, Some(win_event_proc), pid, 0,
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

        if !hook_pos.is_invalid() { let _ = UnhookWinEvent(hook_pos); }
        if !hook_lifecycle.is_invalid() { let _ = UnhookWinEvent(hook_lifecycle); }
    }

    HOOK_STATE.with(|s| { *s.borrow_mut() = None; });
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
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_SHOW,
        GetWindowRect, IsIconic, PostQuitMessage,
    };

    if !GIF_WIDGET_ENABLED.load(Ordering::Relaxed) {
        PostQuitMessage(0);
        return;
    }

    HOOK_STATE.with(|s| {
        let borrowed = s.borrow();
        let Some(ref state) = *borrowed else { return };

        if hwnd != state.target_hwnd || id_object != 0 { return; }

        let widget_label = state.btn_label.replace("gif-btn", "gif-widget");

        match event {
            EVENT_OBJECT_LOCATIONCHANGE if id_child == 0 => {
                if IsIconic(hwnd).as_bool() { return; }
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let wr = WindowRect {
                        left: rect.left, top: rect.top,
                        right: rect.right, bottom: rect.bottom,
                    };
                    position_gif_btn(&state.app, &state.btn_label, &wr);
                    position_class_btn(&state.app, &state.class_btn_label, &wr);

                    // 페어 gif-widget도 열려있으면 함께 이동
                    if let Some(panel) = state.app.get_webview_window(&widget_label) {
                        if panel.is_visible().unwrap_or(false) {
                            let (px, py) = compute_panel_position(
                                wr.left + 280, wr.bottom - 50,
                            );
                            let _ = panel.set_position(tauri::PhysicalPosition::new(px, py));
                        }
                    }
                }
            }
            EVENT_OBJECT_DESTROY => {
                PostQuitMessage(0);
            }
            EVENT_OBJECT_HIDE => {
                // 대상 창 숨김 — btn + class-btn + widget 숨기고, widget이 열려있었으면 closed 이벤트
                if let Some(w) = state.app.get_webview_window(&state.btn_label) {
                    let _ = w.hide();
                }
                if let Some(w) = state.app.get_webview_window(&state.class_btn_label) {
                    let _ = w.hide();
                }
                if let Some(w) = state.app.get_webview_window(&widget_label) {
                    let was_visible = w.is_visible().unwrap_or(false);
                    let _ = w.hide();
                    if was_visible {
                        let _ = state.app.emit("gif-panel-closed", &state.btn_label);
                    }
                }
            }
            EVENT_OBJECT_SHOW => {
                // 대상 창 재표시 — btn + class-btn 다시 표시 (widget은 사용자가 직접 열어야 함)
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let wr = WindowRect {
                        left: rect.left, top: rect.top,
                        right: rect.right, bottom: rect.bottom,
                    };
                    position_gif_btn(&state.app, &state.btn_label, &wr);
                    position_class_btn(&state.app, &state.class_btn_label, &wr);
                    if let Some(w) = state.app.get_webview_window(&state.btn_label) {
                        let _ = w.show();
                    }
                    if let Some(w) = state.app.get_webview_window(&state.class_btn_label) {
                        let _ = w.show();
                    }
                }
            }
            _ => {}
        }
    });
}

/// z-order는 owner 관계로 관리되므로 SWP_NOZORDER로 위치만 갱신
fn position_gif_btn(app: &AppHandle, btn_label: &str, rect: &WindowRect) {
    let Some(win) = app.get_webview_window(btn_label) else { return; };

    let btn_x = rect.left + 280;
    let btn_y = rect.bottom - 51;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        };
        if let Ok(raw) = win.hwnd() {
            let gif_hwnd = HWND(raw.0);
            unsafe {
                let _ = SetWindowPos(
                    gif_hwnd, HWND(std::ptr::null_mut()), btn_x, btn_y, 0, 0,
                    SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = win.set_position(tauri::PhysicalPosition::new(btn_x, btn_y));
}

/// class-btn-N을 gif-btn-N 오른쪽에 4px 간격으로 배치
fn position_class_btn(app: &AppHandle, class_btn_label: &str, rect: &WindowRect) {
    let Some(win) = app.get_webview_window(class_btn_label) else { return; };

    const GIF_BTN_WIN_W: i32 = 70;
    const GAP: i32 = 4;
    let x = rect.left + 280 + GIF_BTN_WIN_W + GAP;
    let y = rect.bottom - 51;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        };
        if let Ok(raw) = win.hwnd() {
            let hwnd = HWND(raw.0);
            unsafe {
                let _ = SetWindowPos(
                    hwnd, HWND(std::ptr::null_mut()), x, y, 0, 0,
                    SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// "이름(이름)" 또는 "이름(ID)(이름)" 형식인지 검증.
/// 첫 번째 "(" 앞 이름(2~5글자)과 마지막 "()" 안 내용이 같아야 통과.
fn is_recipient_name(text: &str) -> bool {
    let text = text.trim();
    let Some(first_open) = text.find('(') else { return false; };
    let before = text[..first_open].trim();
    let count = before.chars().count();
    if count < 2 || count > 5 { return false; }
    let Some(last_open) = text.rfind('(') else { return false; };
    let Some(last_close) = text.rfind(')') else { return false; };
    if last_close <= last_open { return false; }
    text[last_open + 1..last_close].trim() == before
}

/// 대상 창(target HWND)에서 수신자 목록 추출.
/// ① 빈 타이틀 #32770 자식 컨테이너를 화면 Y좌표 오름차순 정렬(위 = 수신자 필드)
/// ② 각 컨테이너의 직접 자식(GW_CHILD/GW_HWNDNEXT)만 탐색 — 재귀하지 않음
/// ③ "이름(이름)" 엄격 패턴 검증 후 첫 번째 매칭 컨테이너 반환
#[cfg(target_os = "windows")]
pub fn extract_recipients(target_hwnd_val: isize) -> Vec<String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetWindow, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GW_CHILD, GW_HWNDNEXT,
    };

    let target_hwnd = HWND(target_hwnd_val as *mut core::ffi::c_void);

    // Step 1: 빈 타이틀 #32770 하위 창 수집 + 화면 Y 좌표
    struct ContainerCtx { containers: Vec<(HWND, i32)> }
    unsafe extern "system" fn find_containers(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut ContainerCtx);
        let mut cls = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut cls);
        if n > 0 {
            let class = String::from_utf16_lossy(&cls[..n as usize]);
            if class == "#32770" && GetWindowTextLengthW(hwnd) == 0 {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    ctx.containers.push((hwnd, rect.top));
                }
            }
        }
        BOOL(1)
    }
    let mut cctx = ContainerCtx { containers: Vec::new() };
    unsafe {
        let _ = EnumChildWindows(target_hwnd, Some(find_containers),
            LPARAM(&mut cctx as *mut _ as isize));
    }

    // Y 오름차순 = 화면 위쪽부터 (수신자 필드는 대화상자 상단에 위치)
    cctx.containers.sort_by_key(|&(_, y)| y);

    // Step 2: 각 컨테이너의 직접 자식만 순회, 수신자 패턴 검증
    for (container, _) in &cctx.containers {
        let mut recipients: Vec<String> = Vec::new();
        unsafe {
            let mut child = match GetWindow(*container, GW_CHILD) {
                Ok(h) => h,
                Err(_) => continue,
            };
            while !child.0.is_null() {
                let mut cls = [0u16; 128];
                let cn = GetClassNameW(child, &mut cls);
                if cn > 0 {
                    let class = String::from_utf16_lossy(&cls[..cn as usize]);
                    if class.starts_with("Afx:") {
                        let tlen = GetWindowTextLengthW(child);
                        if tlen > 0 {
                            let mut tbuf = vec![0u16; (tlen + 1) as usize];
                            let written = GetWindowTextW(child, &mut tbuf);
                            if written > 0 {
                                let text = String::from_utf16_lossy(&tbuf[..written as usize])
                                    .to_string();
                                if is_recipient_name(&text) {
                                    recipients.push(text);
                                }
                            }
                        }
                    }
                }
                child = match GetWindow(child, GW_HWNDNEXT) {
                    Ok(h) => h,
                    Err(_) => break,
                };
            }
        }
        if !recipients.is_empty() {
            return recipients;
        }
    }
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
pub fn extract_recipients(_target_hwnd_val: isize) -> Vec<String> {
    Vec::new()
}
