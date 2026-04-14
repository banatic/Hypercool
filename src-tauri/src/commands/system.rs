use std::fs;
use tauri::command;
use winreg::enums::*;
use winreg::RegKey;

#[derive(serde::Serialize)]
pub struct ClaudeConfigResult {
    pub path: String,
    pub already_configured: bool,
}

/// Claude 데스크탑 설정 파일을 자동으로 찾아 MCP 설정을 주입합니다.
#[command]
pub fn setup_claude_mcp() -> Result<ClaudeConfigResult, String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA 환경변수를 찾을 수 없습니다.".to_string())?;

    let packages_dir = std::path::PathBuf::from(&local_app_data).join("Packages");
    if !packages_dir.exists() {
        return Err("Packages 폴더를 찾을 수 없습니다. Claude 앱이 설치되어 있는지 확인하세요.".into());
    }

    // Claude_* 폴더 탐색
    let claude_dir = fs::read_dir(&packages_dir)
        .map_err(|e| format!("Packages 폴더 읽기 실패: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.is_dir() && p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("Claude_"))
                .unwrap_or(false)
        })
        .ok_or("Claude 앱 폴더를 찾을 수 없습니다. Claude Desktop이 설치되어 있는지 확인하세요.")?;

    let config_dir = claude_dir.join("LocalCache").join("Roaming").join("Claude");
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("설정 폴더 생성 실패: {}", e))?;

    let config_path = config_dir.join("claude_desktop_config.json");

    // 기존 파일 읽기 (없으면 빈 객체)
    let mut config: serde_json::Value = if config_path.exists() {
        let text = fs::read_to_string(&config_path)
            .map_err(|e| format!("설정 파일 읽기 실패: {}", e))?;
        serde_json::from_str(&text)
            .unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // 이미 동일한 설정이 있는지 확인
    let already_configured = config
        .get("mcpServers")
        .and_then(|s| s.get("hypercool"))
        .and_then(|h| h.get("command"))
        .and_then(|c| c.as_str())
        .map(|c| c == "npx")
        .unwrap_or(false);

    // mcpServers.hypercool 주입 (기존 내용 보존)
    let mcp_entry = serde_json::json!({
        "command": "npx",
        "args": ["-y", "mcp-remote", "http://localhost:3737/mcp"]
    });

    config
        .as_object_mut()
        .ok_or("설정 파일 형식이 올바르지 않습니다.")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("mcpServers 형식이 올바르지 않습니다.")?
        .insert("hypercool".to_string(), mcp_entry);

    // 저장
    let text = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("JSON 직렬화 실패: {}", e))?;
    fs::write(&config_path, text)
        .map_err(|e| format!("설정 파일 저장 실패: {}", e))?;

    Ok(ClaudeConfigResult {
        path: config_path.to_string_lossy().to_string(),
        already_configured,
    })
}

/// Node.js / npx 설치 여부 확인
#[command]
pub fn check_node_installed() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

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
