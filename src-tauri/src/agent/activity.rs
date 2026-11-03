//! 활동 피드 기록(briefing_activity.json).

use super::*;

// ─── 활동 기록 ────────────────────────────────────────────────────────────────

pub(super) const ACTIVITY_FILE: &str = "briefing_activity.json";
pub(super) const ACTIVITY_MAX: usize = 100;
pub(super) static ACTIVITY_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn activity_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(ACTIVITY_FILE))
}

/// 오래된 순으로 저장된 활동 기록.
pub(super) fn read_activity(app: &AppHandle) -> Vec<ActivityEntry> {
    activity_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub(super) fn push_activity(app: &AppHandle, new_entries: Vec<ActivityEntry>) {
    if new_entries.is_empty() {
        return;
    }
    let Some(path) = activity_path(app) else { return };
    let _guard = ACTIVITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_activity(app);
    entries.extend(new_entries);
    if entries.len() > ACTIVITY_MAX {
        let cut = entries.len() - ACTIVITY_MAX;
        entries.drain(..cut);
    }
    if let Ok(text) = serde_json::to_string(&entries) {
        let _ = std::fs::write(path, text);
    }
}

pub(super) fn activity_entry(source: &str, title: String, regs: &[&RegItem], error: Option<String>) -> ActivityEntry {
    ActivityEntry {
        at: chrono::Local::now().to_rfc3339(),
        source: source.to_string(),
        title,
        registered: regs
            .iter()
            .filter(|r| r.status == RegStatus::New)
            .map(|r| ActivityItem { title: r.title.clone(), date: r.date.clone() })
            .collect(),
        skipped_dedup: regs.iter().filter(|r| r.status == RegStatus::Duplicate).count() as i64,
        skipped_invalid: regs
            .iter()
            .filter(|r| matches!(r.status, RegStatus::Invalid | RegStatus::Past))
            .count() as i64,
        error,
    }
}
