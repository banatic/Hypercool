#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

#[repr(C)]
pub struct ACCENT_POLICY {
    pub accent_state: u32,
    pub accent_flags: u32,
    pub gradient_color: u32,
    pub animation_id: u32,
}

#[repr(C)]
pub struct WINDOWCOMPOSITIONATTRIBDATA {
    pub attribute: u32,
    pub data: *mut ACCENT_POLICY,
    pub size_of_data: usize,
}

const WCA_ACCENT_POLICY: u32 = 19;
const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;

#[cfg(target_os = "windows")]
pub fn enable_acrylic(hwnd: HWND) {
    unsafe {
        let mut accent = ACCENT_POLICY {
            accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
            accent_flags: 0,
            gradient_color: 0x1818187D, // RGBA: (18, 18, 18, 125) - 약간 어두운 반투명 배경
            animation_id: 0,
        };

        let mut data = WINDOWCOMPOSITIONATTRIBDATA {
            attribute: WCA_ACCENT_POLICY,
            data: &mut accent as *mut ACCENT_POLICY,
            size_of_data: std::mem::size_of::<ACCENT_POLICY>(),
        };

        // user32.dll에서 SetWindowCompositionAttribute 함수 가져오기
        let user32 = windows::Win32::System::LibraryLoader::LoadLibraryW(
            windows::core::w!("user32.dll")
        );
        
        if let Ok(user32) = user32 {
            let proc = windows::Win32::System::LibraryLoader::GetProcAddress(
                user32,
                windows::core::s!("SetWindowCompositionAttribute")
            );
            
            if let Some(proc) = proc {
                type SetWindowCompositionAttributeFn = extern "system" fn(
                    HWND,
                    *mut WINDOWCOMPOSITIONATTRIBDATA,
                ) -> windows::Win32::Foundation::BOOL;
                
                let set_window_composition_attribute: SetWindowCompositionAttributeFn = 
                    std::mem::transmute(proc);
                
                let _ = set_window_composition_attribute(hwnd, &mut data);
            }
        }
    }
}

