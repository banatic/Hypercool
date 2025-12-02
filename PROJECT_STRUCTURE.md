# Project Structure

This document outlines the structure and roles of the main directories in the HyperCool project.

## Directory Overview

### `src-tauri` (Backend)
- **Role**: The Rust backend for the desktop application.
- **Key Responsibilities**:
    - **System Integration**: File system access, registry manipulation, window management.
    - **Database**: Reading and querying the local UDB (SQLite) database.
    - **Deep Link**: Handling `hypercool://` protocol links.
    - **Commands**: Exposing Rust functions to the frontend via Tauri commands (e.g., `read_udb_messages`, `get_all_messages_for_sync`).

### `src` (Frontend)
- **Role**: The React frontend for the desktop application (Tauri).
- **Key Responsibilities**:
    - **UI/UX**: Main interface for the desktop user.
    - **Message Management**: Displaying, searching, and classifying messages.
    - **Sync**: Synchronizing local data (messages, todos, schedules) to Firebase Firestore via `SyncService`.
    - **Local State**: Managing local settings and cached data.

### `src-firebase-app` (Web App)
- **Role**: The web-based companion application hosted on Firebase.
- **Key Responsibilities**:
    - **Remote Access**: allowing users to view their data from any browser.
    - **Dashboard**: Overview of recent activity.
    - **Features**:
        - **Messages**: Read-only view of synced messages.
        - **Calendar**: View schedules and todos.
        - **Todos**: List of tasks.
    - **Authentication**: Google OAuth login (same as desktop).

## Key Workflows

### Data Synchronization
1.  **Source**: `src` (Desktop) reads data from local UDB and registry.
2.  **Upload**: `SyncService` in `src` pushes data to Firestore (`users/{uid}/{collection}`).
3.  **View**: `src-firebase-app` subscribes to Firestore collections to display data in real-time.

### Deep Linking
- **Scheme**: `hypercool://`
- **Flow**: Clicking a link opens the installed Desktop app (MSI) or Dev app (if registered).
- **Handling**: `src-tauri/src/main.rs` listens for the scheme and passes data to the frontend.
