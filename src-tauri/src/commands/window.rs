use crate::models::WindowBounds;
use crate::utils::apply_vibrancy_effect;
use crate::commands::system::{get_registry_value, set_registry_value};
use std::sync::{Mutex, OnceLock, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use winapi::um::winuser::{FindWindowW, ShowWindow, SetForegroundWindow, SW_RESTORE, SW_HIDE, SW_SHOW, SetWindowPos, HWND_BOTTOM, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};
#[cfg(target_os = "windows")]
use crate::dummy_window::DUMMY_OWNER_HWND;

// 최근 숨김 시각 (워처 자동 표시 억제용)
pub static LAST_HIDE_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

#[tauri::command]
pub fn notify_hidden() {
    let cell = LAST_HIDE_AT.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = cell.lock() {
        *slot = Some(Instant::now());
    }
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // 윈도우가 보이는 상태인지 확인
        if let Ok(is_visible) = w.is_visible() {
            if is_visible {
                #[cfg(target_os = "windows")]
                {
                    // Windows에서 포커스가 있는 상태에서 hide가 제대로 동작하지 않을 수 있음
                    // 윈도우 핸들을 가져와서 직접 숨기기
                    if let Ok(hwnd) = w.hwnd() {
                        unsafe {
                            // windows::Win32::Foundation::HWND를 winapi HWND로 변환
                            // hwnd.0은 *mut std::ffi::c_void 타입이므로 usize로 변환 후 다시 포인터로 변환
                            let hwnd_ptr: *mut std::ffi::c_void = hwnd.0;
                            let hwnd_addr = hwnd_ptr as usize;
                            let winapi_hwnd = hwnd_addr as *mut winapi::ctypes::c_void;
                            ShowWindow(winapi_hwnd as _, SW_HIDE);
                        }
                        return;
                    }
                }
                // Windows가 아니거나 hwnd를 가져올 수 없는 경우 일반 hide 사용
                let _ = w.hide();
            }
        } else {
            // is_visible() 실패 시에도 hide 시도
            let _ = w.hide();
        }
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd) = w.hwnd() {
                unsafe {
                    let hwnd_ptr: *mut std::ffi::c_void = hwnd.0;
                    let hwnd_addr = hwnd_ptr as usize;
                    let winapi_hwnd = hwnd_addr as *mut winapi::ctypes::c_void;
                    ShowWindow(winapi_hwnd as _, SW_SHOW);
                    ShowWindow(winapi_hwnd as _, SW_RESTORE);
                    SetForegroundWindow(winapi_hwnd as _);
                }
            }
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub async fn set_calendar_widget_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("calendar-widget") {
        // resizable 설정
        window
            .set_resizable(pinned)
            .map_err(|e| format!("윈도우 resizable 설정 실패: {}", e))?;
        
        // 레지스트리에 핀 상태 저장
        let _ = set_registry_value("CalendarWidgetPinned".to_string(), pinned.to_string());
        
        Ok(())
    } else {
        Err("달력 위젯 윈도우를 찾을 수 없습니다".into())
    }
}

#[tauri::command]
pub async fn get_calendar_widget_pinned(_app: AppHandle) -> Result<bool, String> {
    match get_registry_value("CalendarWidgetPinned".to_string()) {
        Ok(Some(value)) => {
            value.parse::<bool>().map_err(|e| format!("핀 상태 파싱 실패: {}", e))
        }
        Ok(None) => Ok(false), // 기본값은 false (고정되지 않음)
        Err(e) => Err(e)
    }
}

#[tauri::command]
pub async fn set_school_widget_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("school-widget") {
        // resizable 설정
        window
            .set_resizable(pinned)
            .map_err(|e| format!("윈도우 resizable 설정 실패: {}", e))?;
        
        // 레지스트리에 핀 상태 저장
        let _ = set_registry_value("SchoolWidgetPinned".to_string(), pinned.to_string());
        
        Ok(())
    } else {
        Err("학교 위젯 윈도우를 찾을 수 없습니다".into())
    }
}

#[tauri::command]
pub async fn get_school_widget_pinned(_app: AppHandle) -> Result<bool, String> {
    match get_registry_value("SchoolWidgetPinned".to_string()) {
        Ok(Some(value)) => {
            value.parse::<bool>().map_err(|e| format!("핀 상태 파싱 실패: {}", e))
        }
        Ok(None) => Ok(true), // 기본값은 true (resizable)
        Err(e) => Err(e)
    }
}

#[tauri::command]
pub async fn open_calendar_widget(app: AppHandle) -> Result<(), String> {
    // 이미 열려있는지 확인
    if let Some(window) = app.get_webview_window("calendar-widget") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(()); // 이미 열려있으면 포커스만 주기
    }
    
    let url = if cfg!(dev) {
        WebviewUrl::External(
            std::str::FromStr::from_str("http://localhost:1420/calendar-widget.html")
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        WebviewUrl::App("calendar-widget.html".into())
    };
    
    // 저장된 위치와 크기 불러오기
    let saved_bounds: Option<WindowBounds> = match get_registry_value("CalendarWidgetBounds".to_string()) {
        Ok(Some(json_str)) => {
            serde_json::from_str(&json_str).ok()
        }
        _ => None
    };
    
    // 저장된 핀 상태 확인
    let is_pinned = match get_registry_value("CalendarWidgetPinned".to_string()) {
        Ok(Some(value)) => value.parse::<bool>().unwrap_or(false),
        _ => false, // 기본값은 false (고정되지 않음)
    };
    
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "calendar-widget",
        url,
    )
    .title("달력 위젯")
    .min_inner_size(350.0, 450.0)
    .resizable(is_pinned) // 핀 상태에 따라 resizable 설정
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(true);
    
    // 기본 크기 설정 (저장된 값이 있으면 나중에 덮어씀)
    if saved_bounds.is_none() {
        builder = builder.inner_size(400.0, 500.0);
    }
    
    let window = builder
        .build()
        .map_err(|e| format!("달력 위젯 윈도우 생성 실패: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        if let Some(dummy_hwnd) = DUMMY_OWNER_HWND.get() {
            if let Ok(hwnd) = window.hwnd() {
                unsafe {
                    let widget_hwnd = windows::Win32::Foundation::HWND(hwnd.0 as _);
                    let prev = SetWindowLongPtrW(widget_hwnd, GWLP_HWNDPARENT, dummy_hwnd.0.0 as _);
                    eprintln!("Calendar Widget Owner Set: Widget {:?} -> Owner {:?} (Prev: {:?})", widget_hwnd, dummy_hwnd.0.0, prev);
                }
            }
        }
    }
    
    // 저장된 위치와 크기가 있으면 윈도우 생성 후 명시적으로 설정
    if let Some(bounds) = saved_bounds {
        std::thread::sleep(Duration::from_millis(100));
        
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: bounds.x as i32,
            y: bounds.y as i32,
        }));
        
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: bounds.width as u32,
            height: bounds.height as u32,
        }));
    }
    
    apply_vibrancy_effect(&window);
    
    #[cfg(target_os = "windows")]
    {
        let window_title = "달력 위젯";
        let title_wide: Vec<u16> = OsStr::new(window_title).encode_wide().chain(Some(0)).collect();
        
        tokio::time::sleep(Duration::from_millis(500)).await;
        
        unsafe {
            let hwnd = FindWindowW(std::ptr::null_mut(), title_wide.as_ptr());
            if !hwnd.is_null() {
                eprintln!("Found Calendar Widget HWND: {:?}", hwnd);
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                eprintln!("SetWindowPos(HWND_BOTTOM) called for Calendar Widget");
            } else {
                eprintln!("Failed to find Calendar Widget window for SetWindowPos");
            }
        }
    }
    
    // 디바운싱을 위한 타이머
    let save_timer: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    
    // 윈도우 위치와 크기를 저장하는 헬퍼 함수
    let save_bounds = |window: &WebviewWindow<_>| {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let x = position.x as f64;
            let y = position.y as f64;
            let width = size.width as f64;
            let height = size.height as f64;
            
            let bounds = WindowBounds { x, y, width, height };
            if let Ok(json) = serde_json::to_string(&bounds) {
                let _ = set_registry_value("CalendarWidgetBounds".to_string(), json);
            }
        }
    };
    
    // 윈도우 위치와 크기 저장을 위한 이벤트 리스너
    let window_clone = window.clone();
    let save_timer_clone = save_timer.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let mut timer_guard = save_timer_clone.lock().unwrap();
                let _ = timer_guard.take();
                
                let window_for_save = window_clone.clone();
                let timer_clone = save_timer_clone.clone();
                let handle = std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    save_bounds(&window_for_save);
                    let _ = timer_clone.lock().unwrap().take();
                });
                *timer_guard = Some(handle);
            }
            _ => {}
        }
    });
    
    Ok(())
}

#[tauri::command]
pub async fn open_school_widget(app: AppHandle) -> Result<(), String> {
    // 이미 열려있는지 확인
    if let Some(window) = app.get_webview_window("school-widget") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    
    let url = if cfg!(dev) {
        WebviewUrl::External(
            std::str::FromStr::from_str("http://localhost:1420/school-widget.html")
                .map_err(|e| format!("URL 파싱 실패: {}", e))?
        )
    } else {
        WebviewUrl::App("school-widget.html".into())
    };
    
    // 저장된 위치와 크기 불러오기
    let saved_bounds: Option<WindowBounds> = match get_registry_value("SchoolWidgetBounds".to_string()) {
        Ok(Some(json_str)) => {
            serde_json::from_str(&json_str).ok()
        }
        _ => None
    };
    
    // 저장된 핀 상태 확인
    let is_pinned = match get_registry_value("SchoolWidgetPinned".to_string()) {
        Ok(Some(value)) => value.parse::<bool>().unwrap_or(true), // 기본값은 true (resizable)
        _ => true, // 기본값은 true (resizable)
    };
    
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "school-widget",
        url,
    )
    .title("학교 위젯")
    .resizable(is_pinned) // 핀 상태에 따라 resizable 설정
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(true);
    
    // 기본 크기 설정 (저장된 값이 있으면 나중에 덮어씀)
    if saved_bounds.is_none() {
        builder = builder.inner_size(900.0, 700.0);
    }
    
    let window = builder
        .build()
        .map_err(|e| format!("학교 위젯 윈도우 생성 실패: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        if let Some(dummy_hwnd) = DUMMY_OWNER_HWND.get() {
            if let Ok(hwnd) = window.hwnd() {
                unsafe {
                    let widget_hwnd = windows::Win32::Foundation::HWND(hwnd.0 as _);
                    let prev = SetWindowLongPtrW(widget_hwnd, GWLP_HWNDPARENT, dummy_hwnd.0.0 as _);
                    eprintln!("School Widget Owner Set: Widget {:?} -> Owner {:?} (Prev: {:?})", widget_hwnd, dummy_hwnd.0.0, prev);
                }
            }
        }
    }
    
    // 저장된 위치와 크기가 있으면 윈도우 생성 후 명시적으로 설정
    if let Some(bounds) = saved_bounds {
        std::thread::sleep(Duration::from_millis(100));
        
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: bounds.x as i32,
            y: bounds.y as i32,
        }));
        
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: bounds.width as u32,
            height: bounds.height as u32,
        }));
    }
    
    apply_vibrancy_effect(&window);
    
    #[cfg(target_os = "windows")]
    {
        let window_title = "학교 위젯";
        let title_wide: Vec<u16> = OsStr::new(window_title).encode_wide().chain(Some(0)).collect();
        
        tokio::time::sleep(Duration::from_millis(500)).await;
        
        unsafe {
            let hwnd = FindWindowW(std::ptr::null_mut(), title_wide.as_ptr());
            if !hwnd.is_null() {
                eprintln!("Found School Widget HWND: {:?}", hwnd);
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                eprintln!("SetWindowPos(HWND_BOTTOM) called for School Widget");
            } else {
                eprintln!("Failed to find School Widget window for SetWindowPos");
            }
        }
    }
    
    // 디바운싱을 위한 타이머
    let save_timer: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    
    // 윈도우 위치와 크기를 저장하는 헬퍼 함수
    let save_bounds = |window: &WebviewWindow<_>| {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let x = position.x as f64;
            let y = position.y as f64;
            let width = size.width as f64;
            let height = size.height as f64;
            
            let bounds = WindowBounds { x, y, width, height };
            if let Ok(json) = serde_json::to_string(&bounds) {
                let _ = set_registry_value("SchoolWidgetBounds".to_string(), json);
            }
        }
    };
    
    // 윈도우 위치와 크기 저장을 위한 이벤트 리스너
    let window_clone = window.clone();
    let save_timer_clone = save_timer.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let mut timer_guard = save_timer_clone.lock().unwrap();
                let _ = timer_guard.take();
                
                let window_clone_inner = window_clone.clone();
                let handle = std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    save_bounds(&window_clone_inner);
                });
                *timer_guard = Some(handle);
            }
            _ => {}
        }
    });
    
    Ok(())
}
