//! 앱 시작 시 `tauri::Builder::setup` 에서 실행되는 초기화 단계.

mod auto_start;
mod overlays;
mod storage;
mod tray;
mod udb_watcher;

pub fn run(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = crate::commands::system::register_custom_scheme() {
            eprintln!("Failed to register custom scheme: {}", e);
        }
    }

    storage::init(app)?;
    overlays::build(app);
    tray::build(app)?;
    auto_start::spawn(app);
    udb_watcher::spawn(app);
    Ok(())
}
