#[cfg(target_os = "windows")]
pub fn copy_html_to_clipboard(html: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::ffi::c_void;
    use windows::Win32::{
        Foundation::HANDLE,
        System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW,
            SetClipboardData,
        },
        System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    };

    let template = format!(
        "Version:0.9\r\nStartHTML:<<<<<<<<1\r\nEndHTML:<<<<<<<<2\r\nStartFragment:<<<<<<<<3\r\nEndFragment:<<<<<<<<4\r\n<html><body>\r\n<!--StartFragment-->{html}<!--EndFragment-->\r\n</body></html>\r\n"
    );

    let start_html = template.find("<html>").unwrap_or(0);
    let end_html = template.len();
    let start_frag =
        template.find("<!--StartFragment-->").unwrap_or(0) + "<!--StartFragment-->".len();
    let end_frag = template.find("<!--EndFragment-->").unwrap_or(0);

    let cf_html = template
        .replace("<<<<<<<<1", &format!("{:08}", start_html))
        .replace("<<<<<<<<2", &format!("{:08}", end_html))
        .replace("<<<<<<<<3", &format!("{:08}", start_frag))
        .replace("<<<<<<<<4", &format!("{:08}", end_frag));

    let cf_html_bytes = cf_html.as_bytes();

    unsafe {
        OpenClipboard(None)?;
        EmptyClipboard()?;

        let format_name_wide: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let cf_html_format =
            RegisterClipboardFormatW(windows::core::PCWSTR(format_name_wide.as_ptr()));

        if cf_html_format != 0 {
            let h_html = GlobalAlloc(GMEM_MOVEABLE, cf_html_bytes.len() + 1)?;
            let ptr = GlobalLock(h_html) as *mut u8;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(cf_html_bytes.as_ptr(), ptr, cf_html_bytes.len());
                *ptr.add(cf_html_bytes.len()) = 0;
                let _ = GlobalUnlock(h_html);
            }
            let _ = SetClipboardData(cf_html_format, HANDLE(h_html.0));
        }

        let text_wide: Vec<u16> = html.encode_utf16().chain(std::iter::once(0u16)).collect();
        let text_bytes = text_wide.len() * 2;
        let h_text = GlobalAlloc(GMEM_MOVEABLE, text_bytes)?;
        let ptr = GlobalLock(h_text) as *mut c_void;
        if !ptr.is_null() {
            std::ptr::copy_nonoverlapping(
                text_wide.as_ptr() as *const u8,
                ptr as *mut u8,
                text_bytes,
            );
            let _ = GlobalUnlock(h_text);
        }
        let _ = SetClipboardData(13u32, HANDLE(h_text.0));

        CloseClipboard()?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn copy_html_to_clipboard(html: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("[non-Windows] clipboard: {}", html);
    Ok(())
}
