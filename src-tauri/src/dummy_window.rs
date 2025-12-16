#[cfg(target_os = "windows")]
use windows::{
    core::*,
    Win32::Foundation::*,
    Win32::UI::WindowsAndMessaging::*,
};

#[cfg(target_os = "windows")]
pub struct SafeHwnd(pub HWND);

#[cfg(target_os = "windows")]
unsafe impl Send for SafeHwnd {}
#[cfg(target_os = "windows")]
unsafe impl Sync for SafeHwnd {}

#[cfg(target_os = "windows")]
pub static DUMMY_OWNER_HWND: std::sync::OnceLock<SafeHwnd> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let p_workerw = lparam.0 as *mut HWND;

    // Check if this window contains SHELLDLL_DefView
    let shell_dll = FindWindowExW(hwnd, HWND(0 as _), w!("SHELLDLL_DefView"), PCWSTR::null());
    
    if let Ok(shell_dll_hwnd) = shell_dll {
        if shell_dll_hwnd.0 != 0 as _ {
            // Found the WorkerW with SHELLDLL_DefView
            // The WorkerW we want is the next sibling
            let workerw = FindWindowExW(HWND(0 as _), hwnd, w!("WorkerW"), PCWSTR::null());
            if let Ok(workerw_hwnd) = workerw {
                if workerw_hwnd.0 != 0 as _ {
                    *p_workerw = workerw_hwnd;
                }
            }
            return FALSE; // Stop enumeration
        }
    }
    TRUE
}

#[cfg(target_os = "windows")]
fn get_workerw() -> HWND {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).unwrap_or(HWND(0 as _));
        let mut result: usize = 0;
        
        // Spawn WorkerW
        if progman.0 != 0 as _ {
            SendMessageTimeoutW(
                progman, 
                0x052C, 
                WPARAM(0), 
                LPARAM(0), 
                SMTO_NORMAL, 
                1000, 
                Some(&mut result)
            );
        }

        let mut workerw = HWND(0 as _);
        EnumWindows(Some(enum_window_proc), LPARAM(&mut workerw as *mut _ as _));
        
        // Fallback to Progman if WorkerW not found
        if workerw.0 == 0 as _ {
            eprintln!("WorkerW not found, falling back to Progman");
            progman
        } else {
            eprintln!("Found WorkerW: {:?}", workerw);
            workerw
        }
    }
}

#[cfg(target_os = "windows")]
pub fn init() {
    let hwnd = get_workerw();
    let _ = DUMMY_OWNER_HWND.set(SafeHwnd(hwnd));
}

#[cfg(not(target_os = "windows"))]
pub fn init() {}
