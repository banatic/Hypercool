#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
#[cfg(target_os = "windows")]
use std::ffi::OsString;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStringExt;

#[cfg(target_os = "windows")]
pub fn get_wallpaper_path() -> Option<String> {
    let mut buffer = [0u16; 260];
    unsafe {
        let result = SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buffer.len() as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        
        if result.is_ok() {
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            return Some(String::from_utf16_lossy(&buffer[..len]));
        }
    }
    None
}
