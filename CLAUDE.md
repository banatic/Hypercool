# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

HyperCool is a Windows desktop app that augments the school messenger "쿨메신저" (CoolMessenger). It reads the user's local `.udb` SQLite file, classifies messages, surfaces todos/deadlines, embeds desktop widgets (calendar, school timetable/meal, GIF picker), and exposes an MCP server so external AI clients (Claude Desktop, etc.) can query messages over HTTP. Built with **Tauri 2.0** (Rust backend) + **React/Vite** (TypeScript frontend), with **Firebase Firestore** for cross-device sync.

UI strings, comments, commit messages, and release notes are predominantly Korean — match that language when editing user-visible content.

## Common Commands

All commands assume the repo root as the working directory.

```bash
# Install dependencies (Node + Rust deps fetched lazily by tauri)
npm install

# Dev mode — launches Vite (port 1420) and the Tauri shell together
npm run tauri dev

# Production build — produces MSI under src-tauri/target/release/bundle/msi/
npm run tauri build

# Frontend-only build (compiles TS, runs vite build, copies message-viewer.html into dist/)
npm run build

# Run the Vitest suite (jsdom environment; setupFiles=src/setupTests.ts)
npm test

# Run a single test file
npx vitest run src/utils/dateUtils.test.ts

# Run a single test by name pattern
npx vitest run -t "computes deadline"
```

### Releasing

Releases are driven by `scripts/release_method.py`, **not** by manual edits. It bumps the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`; runs `npm run tauri build`; rewrites `latest.json` (RFC3339 `pub_date`, signature, download URL); creates the GitHub release via `gh`; and pushes the `latest.json` commit. Skip flags: `--skip-build`, `--skip-github-release`, `--skip-git-push`. See `docs/release_method.md`.

```bash
python scripts/release_method.py 0.5.15 --notes "..."
```

The `latest.json` URL embedded in `tauri.conf.json` (`plugins.updater.endpoints`) is what tauri-plugin-updater polls on startup, so keeping `latest.json` on `main` matches the auto-update channel. The signing key is `src-tauri/hypercool.key`; the public key is hard-coded into `tauri.conf.json`.

## Architecture

### Multi-window Tauri shell

The app runs **many** webview windows from a single Tauri process, each backed by its own HTML entry point declared in `vite.config.ts` (`rollupOptions.input`):

- `index.html` → main app (`src/App.tsx`)
- `calendar-widget.html` → desktop calendar widget (`src/calendar-widget.tsx`)
- `school-widget.html` → school info widget with tabbed UI (`src/school-widget.tsx`)
- `gif-widget.html` / `gif-btn.html` → GIF picker overlay (one pair per CoolMessenger compose window)
- `class-btn.html` → class status indicator overlay
- `download-panel.html` → 메시지 관리함 첨부파일 헬퍼 (one per "메시지 관리함" / "개의 안읽은 메시지" window; single webview with chip 140×32 ↔ panel 320×460 hover-toggle)
- `message-viewer.html` → standalone read-only message viewer (copied verbatim into `dist/` by the `copy-html` script)

Window management lives in `src-tauri/src/commands/window.rs` and `src-tauri/src/main.rs`. The GIF, class-btn, and download-panel overlays use **pools** of pre-built windows (`gif_watcher::POOL`, `gif_watcher::CLASS_POOL`, `download_watcher::POOL`) attached to detected CoolMessenger windows by their respective watcher threads.

When adding a new window: register the HTML entry in `vite.config.ts`, build the window in `main.rs::setup`, and ensure dev/prod URL handling matches the existing `make_url` helper (dev points to `http://localhost:1420/...`, prod uses `tauri::WebviewUrl::App`).

### Backend (`src-tauri/src/`)

Crate is named `hypercool`. Key modules — all re-exported from `lib.rs` for both `main.rs` and the binary in `bin/debug_windows.rs`:

- `main.rs` — Tauri builder, command registration, tray, deep-link handling, single-instance plugin, multi-window setup.
- `commands/` — Tauri command handlers organized by surface area: `messages.rs` (UDB reading), `mcp.rs` (MCP toggle/state), `system.rs` (registry, file ops, custom scheme registration, auto-start), `window.rs` (calendar/school widget pinning, hide/show, send-to-bottom).
- `db.rs` — SQLite (`hypercool.db`) for schedules/todos. **Settings/preferences live in the Windows registry** under `Software\HyperCool` (see `commands/system.rs::{get,set}_registry_value` and `REG_BASE`), not in this DB. There is a one-time registry→DB migration (`migrate_registry_to_db_command`).
- `search_db.rs` — separate FTS5 SQLite (`hypercool_search.db`) for full-text message search; populated by `sync_search_db` from the UDB.
- `mcp_server.rs` — Axum HTTP server bound to `127.0.0.1:3737`, started during `setup`. Speaks JSON-RPC at `POST /mcp`. Tools: `search_messages`, `get_recent_messages`, `get_message_by_id`, `get_db_stats` (and edufine variants when enabled). State paths are `hypercool_search.db` and `edufine_docs.db` under `app_data_dir`.
- `edufine_db.rs` / `edufine_watcher.rs` — optional document watcher for the "에듀파인" school-finance system; toggled via `mcp_commands::toggle_edufine_mcp`.
- `school_data.rs` — meal/attendance/points scrapers and a stock-quote endpoint for the school widget.
- `timetable_parser.rs` — parser for the school's timetable export.
- `appin_parser.rs` — XOR-decrypt + EUC-KR parser for the `.dat` files of the "AppIn" timetable system (XOR key `7n1bmu`). Validate changes against `scripts/verify_appin_parser.py` and the fixture `src-appin/amc42_complete.json`.
- `gif_watcher.rs` / `gif_clipboard.rs` / `tenor.rs` — Tenor search backend and the Win32-glue that detects compose windows, positions the GIF panel, and pastes HTML to the clipboard.
- `download_watcher.rs` — 메시지 관리함 감시자. `gif_watcher` 패턴(WinEvent hook + 풀 슬롯) 위에 100ms 파일 폴링 스레드를 얹어 첨부파일 enumerate, "모든파일 저장 (Ctrl+S)" 버튼을 `BM_CLICK` 으로 자동 클릭. 다운로드 경로는 `HKCU\Software\Jiransoft\CoolMsg50\Option\GetFile\DownPath` 에서 읽음. 토글 2개: `DownloadHelperEnabled`, `DownloadHelperAutoSave` (HyperCool 레지스트리). 자동 클릭은 같은 슬롯에 대해 1초 디바운스.
- `utils.rs` — `is_class_time`, vibrancy/acrylic helpers; `dummy_window.rs` and `window_blur.rs` provide platform-specific window tricks.

The hard-coded period table lives in **two** places that must stay in sync: `src-tauri/src/main.rs::get_current_period` and `src/school-widget/types.ts::PERIOD_TIMES`. Lunch is index 4 and maps to `None`/no slot; periods 5–7 shift down by one to skip lunch when indexing into the timetable matrix.

### Frontend (`src/`)

`App.tsx` orchestrates the main window using a hooks-per-domain pattern — each `src/hooks/use*.ts` owns one slice of state (settings, schedules, messages, sync, deep links, update checks, global events). Settings are persisted to the Windows registry through Tauri commands, so changes flow `useSettings` → `set_registry_value` → restored on next launch.

- `src/components/` — main app pages (`ClassifierPage`, `HistoryPage`, `TodosPage`, `SettingsPage`, `McpPage`, `HelpPage`) and modals.
- `src/school-widget/tabs/` — independent tabs for the school widget (`MealTab`, `TimetableTab`, `AttendanceTab`, `PointsTab`, `StockTab`, `TodoTab`, `ShortcutTab`, `SettingsTab`).
- `src/sync/SyncService.ts` — bidirectional Firestore sync for schedule items keyed `users/{uid}/events`. Uses last-write-wins on `updatedAt`. The desktop is the only writer; `src-firebase-app/` is the read-only web companion.
- `src/services/ScheduleService.ts` — schedule CRUD that delegates to the Rust `db.rs` commands.
- `src/auth/AuthService.ts` + `src/firebase.ts` — Google OAuth via Firebase. Firebase config is read from `VITE_FIREBASE_*` env vars (see `.env`).

### Cross-cutting concerns

- **Deep links:** scheme `hypercool://`, registered on Windows via `register_custom_scheme()`. The `tauri-plugin-single-instance` handler forwards URLs to the running instance by emitting `deep-link-url`; the frontend listens via `useDeepLink`.
- **Auto-update:** `tauri-plugin-updater` polls the `latest.json` endpoint above; install mode is `passive`. Skipping a version is stored in registry (`SkippedUpdateVersion`).
- **Tray + auto-start:** built in `main.rs::setup`; auto-start is registry-driven (`AutoStartHideMain`, `AutoStartCalendar`).
- **Vibrancy:** `utils::apply_vibrancy_effect` (acrylic on Windows). Several windows are `transparent: true, decorations: false` — be careful when adding new chrome.

### Python helper scripts (`scripts/`)

These are auxiliary tools, not part of the build:
- `release_method.py` — release automation (above).
- `verify_appin_parser.py` — golden-file test for `appin_parser.rs` against the AppIn `.dat` fixtures.
- `check_class_event_split.py`, `check_grade_event_split.py`, `find_event_labels.py`, `inspect_udb.py`, `diagnose_calendar.py`, `deduplicate_events.py` — one-off diagnostic scripts for parsing/data investigations.
- `test_all.ps1` — convenience runner.

## Conventions

- **Tauri command registration:** every new command must be added to the `tauri::generate_handler![...]` block in `main.rs` *and* re-exported from its module — missing the handler list is the most common cause of "command not found" at runtime.
- **Registry vs. SQLite vs. Firestore:** UI prefs → registry. Schedules/todos → local SQLite (`db.rs`) and synced to Firestore. Messages → read directly from the user's UDB and mirrored into the FTS search DB. Don't mix layers.
- **MCP changes:** the JSON-RPC contract in `mcp_server.rs` is consumed by external clients (Claude Desktop config snippet in `README.md`). Tool names and shapes are part of the public surface.
- **Period times** are hard-coded in two places (Rust + TS); update both together.
- **Korean text** in UI/release notes is the norm; only switch to English when editing internal-only code or comments.
