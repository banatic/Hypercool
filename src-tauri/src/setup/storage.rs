//! DB 초기화, 에듀파인 감시 복원, MCP 서버 시작, 브리핑 에이전트 복원.

use tauri::Manager;

use crate::commands::mcp as mcp_commands;
use crate::{agent, db, edufine_db, search_db};

pub(super) fn init(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(e) = db::init_db(app.app_handle()) {
        eprintln!("Failed to initialize DB: {}", e);
        return Err(e.into());
    }

    // 검색은 선택 기능이라 실패해도 계속 진행
    if let Err(e) = search_db::init_search_db(app.app_handle()) {
        eprintln!("Failed to initialize Search DB: {}", e);
    }

    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return Ok(());
    };
    let search_db_path = app_data_dir.join("hypercool_search.db");
    let edufine_db_path = app_data_dir.join("edufine_docs.db");

    if let Err(e) = edufine_db::init_db(&edufine_db_path) {
        eprintln!("[Edufine] DB 초기화 실패: {}", e);
    } else {
        // 저장된 공문 제목을 현재 규칙(본문 "제목" 칸 우선)으로 보정. 멱등, 변경분만 UPDATE.
        let title_db = edufine_db_path.clone();
        std::thread::spawn(move || {
            let n = crate::edufine_watcher::refresh_titles(&title_db);
            if n > 0 {
                eprintln!("[Edufine] 공문 제목 보정: {}건", n);
            }
        });
    }

    // 새 공문 저장 → 브리핑 에이전트 트리거("공문도 분석"이 켜져 있을 때만 실행).
    {
        let doc_app = app.app_handle().clone();
        crate::edufine_watcher::set_on_new_doc(move || agent::on_new_docs(&doc_app));
    }
    mcp_commands::restore_edufine_state(app.app_handle());
    crate::mcp_server::start(search_db_path, edufine_db_path, 3737);

    // 브리핑 에이전트 활성 상태 복원(기본 OFF, 옵트인)
    agent::restore_state(app.app_handle());

    // 기등록 AI 일정 content 를 최신 형식(원문 전체·이모지 마커 제거)으로 보정.
    // 멱등이라 매 시작 시 백그라운드로 안전하게 재실행 — 검색 DB 색인이 끝난 뒤에도
    // 자기치유(변경분만 UPDATE)된다.
    let mig_app = app.app_handle().clone();
    std::thread::spawn(move || {
        match agent::content::migrate_ai_schedules_content(mig_app) {
            Ok(n) if n > 0 => eprintln!("[agent] AI 일정 content 마이그레이션: {}건 갱신", n),
            Ok(_) => {}
            Err(e) => eprintln!("[agent] AI 일정 content 마이그레이션 실패: {}", e),
        }
    });

    Ok(())
}
