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
            // ABGR(0xAABBGGRR) 순서. 0x18181818 = R24 G24 B24 A24 → 중립 회색 틴트.
            // (이전 0x1818187D 는 알파값이 R 채널로 들어가 은은한 붉은끼가 있었음)
            gradient_color: 0x18181818,
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

/// Windows 11: DWM 으로 창(아크릴 블러 포함)의 모서리를 둥글게 클리핑한다.
/// 투명 창 전체에 입혀진 아크릴이 CSS 둥근 모서리 밖으로 사각형으로 삐져나오는
/// 잔상을 없앤다. Win10 등 미지원 환경에서는 조용히 무시된다.
#[cfg(target_os = "windows")]
pub fn enable_rounded_corners(hwnd: HWND) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };
    let preference = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const DWM_WINDOW_CORNER_PREFERENCE as *const core::ffi::c_void,
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
    }
}

