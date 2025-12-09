use base64::Engine;
use flate2::read::ZlibDecoder;
use rusqlite::Connection;
use std::io::Read;
use tauri::{Runtime, Manager};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use winapi::um::winuser::FindWindowW;
#[cfg(target_os = "windows")]
use crate::window_blur;
#[cfg(target_os = "windows")]
use window_vibrancy::apply_acrylic;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
use window_vibrancy::apply_blur;
use chrono::{Local, NaiveTime};
use winreg::enums::*;
use winreg::RegKey;

const REG_BASE: &str = r"Software\\HyperCool";

/// Brotli로 압축된 데이터를 압축 해제
pub fn decompress_brotli(compressed_data: &[u8]) -> Result<String, std::io::Error> {
    use brotli::Decompressor;

    let mut decompressor = Decompressor::new(compressed_data, 4096);
    let mut decompressed = Vec::new();
    decompressor.read_to_end(&mut decompressed)?;

    Ok(String::from_utf8_lossy(&decompressed).to_string())
}

pub fn decode_comp_zlib_utf16le(b64: &str) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 디코딩 실패: {}", e))?;
    let mut zr = ZlibDecoder::new(&data[..]);
    let mut out: Vec<u8> = Vec::new();
    zr.read_to_end(&mut out)
        .map_err(|e| format!("zlib inflate 실패: {}", e))?;
    // UTF-16LE -> String
    if out.len() % 2 != 0 {
        return Err("UTF-16LE 길이가 홀수입니다".into());
    }
    let mut u16s = Vec::with_capacity(out.len() / 2);
    for chunk in out.chunks_exact(2) {
        u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    String::from_utf16(&u16s).map_err(|e| format!("UTF-16LE 변환 실패: {}", e))
}

/// FilePath 값을 파싱하여 파일명 목록을 추출
/// |로 split하고 5+3n번째 인덱스(5, 8, 11, ...)에서 파일명 추출
pub fn parse_file_paths(file_path: &str) -> Vec<String> {
    if file_path.is_empty() {
        return Vec::new();
    }
    
    let parts: Vec<&str> = file_path.split('|').collect();
    let mut file_names = Vec::new();
    
    // 5+3n번째 인덱스: 5, 8, 11, 14, ...
    let mut index = 4;
    while index < parts.len() {
        let file_name = parts[index].trim();
        if !file_name.is_empty() {
            file_names.push(file_name.to_string());
        }
        index += 3;
    }
    
    file_names
}

pub fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1")
        .map_err(|e| format!("table_exists 쿼리 준비 실패: {}", e))?;
    let exists = stmt.query_row([table], |_| Ok(())).is_ok();
    Ok(exists)
}

// 윈도우에 vibrancy 효과를 적용하는 헬퍼 함수
pub fn apply_vibrancy_effect<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        // 윈도우 타이틀로 핸들 찾기
        if let Ok(title) = window.title() {
            let title_wide: Vec<u16> = OsStr::new(&title).encode_wide().chain(Some(0)).collect();
            unsafe {
                let hwnd = FindWindowW(std::ptr::null_mut(), title_wide.as_ptr());
                if !hwnd.is_null() {
                    // winapi::HWND를 windows::Win32::Foundation::HWND로 변환
                    let hwnd_ptr = hwnd as *mut std::ffi::c_void;
                    let hwnd_windows = windows::Win32::Foundation::HWND(hwnd_ptr);
                    window_blur::enable_acrylic(hwnd_windows);
                    return;
                }
            }
        }
        // 폴백: 기존 방식 사용
        let _ = apply_acrylic(window, Some((18, 18, 18, 125)));
    }

    #[cfg(target_os = "macos")]
    {
        let _ = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None);
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = apply_blur(window, Some((18, 18, 18, 125)));
    }
}

/// HHMM 형식 문자열을 NaiveTime으로 변환하는 헬퍼 함수
fn parse_hhmm(hhmm: &str) -> Option<NaiveTime> {
    if hhmm.len() != 4 {
        return None;
    }

    let hour_str = &hhmm[0..2];
    let min_str = &hhmm[2..4];

    let hour: u32 = hour_str.parse().ok()?;
    let minute: u32 = min_str.parse().ok()?;

    if hour >= 24 || minute >= 60 {
        return None;
    }

    NaiveTime::from_hms_opt(hour, minute, 0)
}

/// 현재 시간이 수업 시간인지 확인하는 함수
pub fn is_class_time() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let reg_base = REG_BASE;

    let class_times_json = match hkcu.open_subkey(reg_base) {
        Ok(subkey) => match subkey.get_value::<String, _>("ClassTimes") {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        },
        _ => None,
    };

    // 수업 시간이 설정되지 않았으면 false 반환 (항상 표시)
    let class_times: Vec<String> = match class_times_json {
        Some(json) => match serde_json::from_str::<Vec<String>>(&json) {
            Ok(times) if !times.is_empty() => times,
            _ => return false,
        },
        None => return false,
    };

    let now = Local::now().time();

    // 각 수업 시간대를 체크
    for time_range in class_times {
        // HHMM-HHMM 형식 파싱 (예: "0830-0920")
        let parts: Vec<&str> = time_range.split('-').collect();
        if parts.len() != 2 {
            continue;
        }

        let start_str = parts[0].trim();
        let end_str = parts[1].trim();

        // HHMM 형식을 NaiveTime으로 변환
        let start_time = match parse_hhmm(start_str) {
            Some(t) => t,
            None => continue,
        };

        let end_time = match parse_hhmm(end_str) {
            Some(t) => t,
            None => continue,
        };

        // 현재 시간이 이 시간대 내에 있는지 확인
        let in_range = if start_time <= end_time {
            now >= start_time && now <= end_time
        } else {
            // 자정을 넘어가는 경우
            now >= start_time || now <= end_time
        };

        if in_range {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hhmm() {
        assert_eq!(parse_hhmm("0830"), Some(NaiveTime::from_hms_opt(8, 30, 0).unwrap()));
        assert_eq!(parse_hhmm("1200"), Some(NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
        assert_eq!(parse_hhmm("2359"), Some(NaiveTime::from_hms_opt(23, 59, 0).unwrap()));
        
        // Invalid cases
        assert_eq!(parse_hhmm("2400"), None);
        assert_eq!(parse_hhmm("1260"), None);
        assert_eq!(parse_hhmm("123"), None);
        assert_eq!(parse_hhmm("12345"), None);
        assert_eq!(parse_hhmm("abcd"), None);
    }

    #[test]
    fn test_parse_file_paths() {
        // Format: ...|...|...|...|filename|...|...|filename|...
        // Indices: 0, 1, 2, 3, 4(target), 5, 6, 7(target) -> Logic says 5+3n?
        // Let's check implementation:
        // let mut index = 4; // 0-indexed, so 5th element
        // while index < parts.len() { ... index += 3; }
        // So indices are 4, 7, 10...
        
        let input = "0|1|2|3|file1.txt|5|6|file2.txt";
        let paths = parse_file_paths(input);
        assert_eq!(paths, vec!["file1.txt", "file2.txt"]);

        let input_empty = "";
        let paths_empty = parse_file_paths(input_empty);
        assert!(paths_empty.is_empty());
    }
}
