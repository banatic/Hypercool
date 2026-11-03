// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hypercool::agent;
use hypercool::commands::{class_btn, download, gif, messages, mcp as mcp_commands, system, window};
use hypercool::db;
use hypercool::models::CacheState;
use hypercool::school_data;
use hypercool::search_db;
use hypercool::timetable_parser;
use hypercool::appin_parser;

use std::num::NonZeroUsize;
use std::sync::Mutex;
use lru::LruCache;
use tauri::Emitter;

fn main() {
    hypercool::dummy_window::init();

    let cache_size = NonZeroUsize::new(50).unwrap();
    let cache_state = CacheState {
        search_cache: Mutex::new(LruCache::new(cache_size)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(cache_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            window::show_main_window(app);
            
            // Windows: Deep link is passed as an argument to the second instance
            for arg in args {
                if arg.starts_with("hypercool://") {
                    let _ = app.emit("deep-link-url", arg);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            messages::read_udb_messages,
            messages::search_messages,
            messages::get_message_by_id,
            messages::get_all_messages_for_sync,
            messages::open_message_viewer,
            messages::close_message_viewer,
            
            system::get_registry_value,
            system::set_registry_value,
            system::get_download_path,
            system::list_coolmessenger_udbs,
            system::check_file_exists,
            system::open_file,
            system::set_auto_start,
            system::setup_claude_mcp,
            system::check_node_installed,
            
            window::notify_hidden,
            window::hide_main_window,
            window::open_calendar_widget,
            window::set_calendar_widget_pinned,
            window::get_calendar_widget_pinned,
            window::open_school_widget,
            window::set_school_widget_pinned,
            window::get_school_widget_pinned,
            window::send_window_to_bottom,
            window::toggle_search_modal,
            window::hide_search_modal,
            window::get_search_hotkey,
            window::set_search_hotkey,
            
            db::get_schedules,
            db::create_schedule,
            db::update_schedule,
            db::delete_schedule,
            db::migrate_registry_to_db_command,
            db::detect_desktopcal,
            db::import_desktopcal_db,
            db::export_desktopcal_db,
            db::sync_to_desktopcal,
            
            search_db::sync_search_db,
            search_db::search_messages_fts,
            search_db::get_cached_message,
            search_db::get_search_db_stats,
            search_db::read_cached_messages,
            search_db::get_cached_message_count,
            search_db::is_cache_ready,

            mcp_commands::get_mcp_status,
            mcp_commands::toggle_edufine_mcp,
            mcp_commands::get_edufine_stats,
            mcp_commands::list_edufine_docs_recent,
            mcp_commands::open_edufine_watch_dir,

            agent::run_briefing_agent_now,
            agent::run_briefing_agent_debug,
            agent::get_briefing_agent_status,
            agent::get_briefing_agent_models,
            agent::set_briefing_agent_enabled,
            agent::set_briefing_agent_config,
            agent::set_briefing_docs_enabled,
            agent::get_briefing_activity,
            agent::backfill::list_backfill_docs,
            agent::backfill::preview_backfill,
            agent::backfill::apply_backfill,
            agent::content::migrate_ai_schedules_content,
            agent::content::get_coolmessenger_status,

            timetable_parser::get_timetable_data,
            appin_parser::get_appin_timetable_data,
            school_data::get_meal_data,
            school_data::get_attendance_data,
            school_data::get_points_data,
            school_data::get_stock_quotes,

            gif::cmd_search_tenor,
            gif::cmd_copy_html,
            gif::toggle_gif_panel,
            class_btn::get_class_status,
            class_btn::resize_class_btn,

            download::download_panel_set_expanded,
            download::download_panel_recheck_file,
            download::download_helper_set_enabled,
            download::download_helper_set_auto_save,
            download::download_helper_get_settings,
        ])
        .setup(|app| hypercool::setup::run(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
