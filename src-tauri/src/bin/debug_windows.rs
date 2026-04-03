
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use winapi::um::winuser::*;
use windows::Win32::Foundation::{HWND, LPARAM, BOOL};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetClassNameW};

fn get_window_text(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len as usize])
}

fn get_window_class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len as usize])
}

unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
    let class = get_window_class(hwnd);
    let text = get_window_text(hwnd);
    
    // Check if it's our widget
    if text.contains("위젯") || text.contains("Widget") {
        let parent = unsafe { winapi::um::winuser::GetParent(hwnd.0 as _) };
        let parent_hwnd = if !parent.is_null() { Some(HWND(parent as _)) } else { None };
        
        if let Some(p) = parent_hwnd {
            println!("Widget found: '{}' ({:?}), Parent: {:?} (Class: {})", text, hwnd, p, get_window_class(p));
        } else {
            println!("Widget found: '{}' ({:?}), No Parent (Top-level)", text, hwnd);
        }
    }
    
    if class == "WorkerW" || class == "Progman" {
        println!("System Window: {} ({:?})", class, hwnd);
        let mut child = FindWindowExW(hwnd.0 as _, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
        while !child.is_null() {
            let ch = HWND(child as _);
            let ch_class = get_window_class(ch);
            let ch_text = get_window_text(ch);
            println!("  -> Child: {} '{}' ({:?})", ch_class, ch_text, ch);
            child = FindWindowExW(hwnd.0 as _, child as _, std::ptr::null_mut(), std::ptr::null_mut());
        }
    }
    BOOL(1)
}

fn main() {
    println!("--- Window Hierarchy Diagnostic ---");
    unsafe { EnumWindows(Some(enum_proc), LPARAM(0)) };
}
