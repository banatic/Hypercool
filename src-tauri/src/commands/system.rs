use std::fs;
use tauri::command;
use winreg::enums::*;
use winreg::RegKey;

// 레지스트리 경로 상수
const REG_BASE: &str = r"Software\\HyperCool";

#[command]
pub fn get_registry_value(key: String) -> Result<Option<String>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(REG_BASE) {
        Ok(subkey) => match subkey.get_value::<String, _>(key) {
            Ok(v) => Ok(Some(v)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("레지스트리 읽기 실패: {}", e)),
        },
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("레지스트리 키 열기 실패: {}", e)),
    }
}

#[command]
pub fn set_registry_value(key: String, value: String) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (subkey, _) = hkcu
        .create_subkey(REG_BASE)
        .map_err(|e| format!("레지스트리 키 생성 실패: {}", e))?;
    subkey
        .set_value(key, &value)
        .map_err(|e| format!("레지스트리 쓰기 실패: {}", e))
}

/// 메신저의 기본 다운로드 경로를 레지스트리에서 읽어옴
#[command]
pub fn get_download_path() -> Result<Option<String>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(r"Software\Jiransoft\CoolMsg50\Option\GetFile") {
        Ok(subkey) => match subkey.get_value::<String, _>("DownPath") {
            Ok(v) => Ok(Some(v)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("레지스트리 읽기 실패: {}", e)),
        },
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("레지스트리 키 열기 실패: {}", e)),
    }
}

/// 파일이 존재하는지 확인
#[command]
pub fn check_file_exists(file_path: String) -> Result<bool, String> {
    Ok(fs::metadata(&file_path).is_ok())
}

/// 파일을 시스템 기본 프로그램으로 열기
#[command]
pub fn open_file(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("파일 열기 실패: {}", e))?;
        Ok(())
    }
    
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("지원되지 않는 운영체제입니다".into())
    }
}

#[cfg(target_os = "windows")]
#[command]
pub fn set_auto_start(enabled: bool) -> Result<(), String> {
    use std::env;
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = r"Software\Microsoft\Windows\CurrentVersion\Run";
    
    let (key, _) = hkcu
        .create_subkey(run_key)
        .map_err(|e| format!("레지스트리 키 생성 실패: {}", e))?;
    
    let app_name = "HyperCool";
    let exe_path = env::current_exe()
        .map_err(|e| format!("실행 파일 경로 가져오기 실패: {}", e))?
        .to_string_lossy()
        .to_string();
    
    if enabled {
        key.set_value(app_name, &exe_path)
            .map_err(|e| format!("자동 실행 설정 실패: {}", e))?;
    } else {
        let _ = key.delete_value(app_name);
    }
    
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[command]
pub fn set_auto_start(_enabled: bool) -> Result<(), String> {
    Err("자동 실행 기능은 Windows에서만 지원됩니다.".to_string())
}

#[cfg(target_os = "windows")]
pub fn register_custom_scheme() -> Result<(), String> {
    use std::env;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = std::path::Path::new("Software").join("Classes").join("hypercool");
    let (key, _) = hkcu.create_subkey(&path).map_err(|e| e.to_string())?;

    key.set_value("", &"URL:HyperCool Protocol").map_err(|e| e.to_string())?;
    key.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;

    let shell = key.create_subkey("shell").map_err(|e| e.to_string())?.0;
    let open = shell.create_subkey("open").map_err(|e| e.to_string())?.0;
    let command = open.create_subkey("command").map_err(|e| e.to_string())?.0;

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_path_str = exe_path.to_str().ok_or("Failed to convert path to string")?;
    
    let command_str = format!("\"{}\" \"%1\"", exe_path_str);
    command.set_value("", &command_str).map_err(|e| e.to_string())?;

    Ok(())
}
