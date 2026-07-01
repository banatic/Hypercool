# Download Helper Import 명세서

`D:\Dev\CoolMessenger_download_helper` (이하 **Helper**)의 핵심 기능을
Hypercool에 흡수하기 위한 설계 문서. 코드를 옮기기 전, **무엇을 가져오고
무엇은 가져오지 않으며, 어떤 형태로 통합되는지** 를 먼저 합의한다.

본 문서의 결정은 사용자 확인을 거친 사항이며, 변경되면 본 문서를 먼저 갱신한 뒤 코드를 수정한다.

---

## 1. 배경 & 목적

쿨메신저(CoolMessenger)는 「메시지 관리함」 / 「N개의 안읽은 메시지」 창에서
첨부파일을 일일이 클릭해야 다운로드된다. Helper는 그 창을 감시하다가
첨부파일을 자동 다운로드하고, 측면 패널에서 다운로드된 파일을 한 번에 열어볼 수 있도록 해주는 유틸이다.

Helper는 이미 두 가지 구현이 있다:

| 구현 | 위치 | 특징 |
|---|---|---|
| Python (v1) | `main.py` | tkinter GUI, 폴링(50ms) 기반 |
| Rust/Tauri (v2.1) | `src-tauri/src/lib.rs`, `src-tauri/src/window_manager.rs` | WinEvent 후킹 + 100/500ms 폴링 혼합, React UI |

Hypercool의 기술 스택(Tauri 2.0 + React/Vite)과 일치하는 **Rust/Tauri v2.1** 코드를 기반으로 이식한다. Python 구현은 참고용으로만 본다.

---

## 2. 통합 범위

### 가져오는 기능

- 쿨메신저 「메시지 관리함」 / 「N개의 안읽은 메시지」 창 감지
- 자식 컨트롤을 enumerate 해서 파일명 + 사이즈를 추출 (`(123 KB)` 패턴)
- 「모든파일 저장 (Ctrl+S)」 버튼을 `BM_CLICK` 으로 자동 클릭하여 자동 다운로드
- 다운로드 경로를 레지스트리 `HKCU\Software\Jiransoft\CoolMsg50\Option\GetFile\DownPath` 에서 읽기
- 다운로드된 파일 목록을 패널에 표시하고, 더블클릭/우측 버튼으로 열기(`os.startfile` 상당)
- 대상 창의 이동/포커스/최소화/소멸을 WinEvent 후킹으로 즉시 반영

### 가져오지 않는 기능

| 기능 | 이유 |
|---|---|
| Helper 자체 GitHub 업데이터 (`updater.rs`, `UpdateModal`, `version.txt`) | Hypercool은 `tauri-plugin-updater` 로 단일 업데이트 경로를 이미 운영 중 |
| Light/Dark 테마 토글 | Hypercool 전역 디자인에 맞춤 (테마는 본체에서 결정) |
| 자체 드래그-이동 헤더 / `overrideredirect` 윈도우 | Hypercool은 메시지 관리함에 attach되는 오버레이로 동작하므로 사용자가 이동시킬 일이 없음 |
| Python 구현 일체 (`main.py`, `requirements.txt`, `setup-icons.py`) | Rust 구현으로 완전히 대체 |

---

## 3. UX 설계

> 사용자 요구사항: *"평소에도 너무 큰 범위를 차지해서 오버시 펼쳐지게끔, 디자인은 Hypercool에 맞추어 모던하게"*

### 3.1 상태 머신

```
┌─────────────────────────────────────────────────────────┐
│ 메시지 관리함 창이 없음 → 패널 숨김                       │
└─────────────────────────────────────────────────────────┘
                      │ 창 발견
                      ▼
┌─────────────────────────────────────────────────────────┐
│ [COLLAPSED] 칩 모드                                       │
│ ┌──────────────┐                                          │
│ │ 📎 3개 첨부   │  ← 메시지 관리함 우상단에 부착          │
│ └──────────────┘     크기: 140 × 32                       │
│                      자동 다운로드 진행 중에도 표시됨       │
└─────────────────────────────────────────────────────────┘
        │ 마우스 hover (200ms 지연)
        │ ▼  ▲ mouseleave (300ms 지연)
┌─────────────────────────────────────────────────────────┐
│ [EXPANDED] 패널 모드                                      │
│ ┌────────────────────────────────────┐                   │
│ │ 📎 파일 관리         3   ⟳   ⌃    │ ← 헤더              │
│ ├────────────────────────────────────┤                   │
│ │ [PDF] report.pdf                   │                   │
│ │       1.2 MB · 2026-05-20 10:32   │                   │
│ │ [JPG] photo_2026.jpg               │                   │
│ │       400 KB · 2026-05-20 10:32   │                   │
│ │ [HWP] 가정통신문.hwp     ⏳다운로드중│                   │
│ ├────────────────────────────────────┤                   │
│ │ ● 연결됨  ·  3개 파일               │ ← 푸터              │
│ └────────────────────────────────────┘                   │
│   크기: 320 × 460                                         │
└─────────────────────────────────────────────────────────┘
```

- **칩 모드**가 기본 상태. 메시지 관리함을 가리지 않을 정도로 작다.
- **호버 → 패널 모드**: 사용자가 칩에 마우스를 올리면 패널이 부드럽게 (`transition: 200ms ease-out`) 펼쳐진다. 패널 영역을 벗어나면 300ms 지연 후 칩으로 돌아간다.
- 패널 안의 인터랙션(스크롤, 더블클릭) 중에는 자동 축소가 일어나지 않도록 `pointer:over` 상태를 유지한다.

### 3.2 부착 위치 규칙 (`calculate_attach_position`)

기존 Helper의 폴백 로직을 그대로 가져온다:

1. 메시지 관리함 우측 + 5px (기본)
2. 우측이 모니터를 벗어나면 좌측 - 5px
3. 좌측도 안되면 위 - 5px
4. 그래도 안되면 아래 + 5px

세로 정렬: 메시지 관리함의 `top` 과 동일. 단, **칩 모드일 때는 메시지 관리함의 `right + 5, top + 8`** 정도로 우상단에 살짝 떠 있는 형태로 배치한다 (Helper의 `top` 정렬은 패널 길이 기준이라 칩에는 그대로 적용하면 어색함).

### 3.3 디자인 토큰

Hypercool의 기존 위젯(`SchoolWidget.css`, `calendar-widget.tsx`)과 톤을 맞춘다:

- 배경: `rgba(255, 255, 255, 0.95)` + Acrylic vibrancy (Hypercool의 `apply_vibrancy_effect`)
- 모서리: `border-radius: 12px`
- 그림자: `box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12)`
- 폰트: Pretendard / Malgun Gothic (Hypercool 본체와 동일)
- 확장자 배지 컬러는 Helper의 `getExtStyle` 그대로 차용 (HWP/HWPX 색상 포함, 이미 Korean-file friendly함)

---

## 4. 아키텍처

### 4.1 백엔드 (Rust)

#### 신규 모듈

| 파일 | 책임 |
|---|---|
| `src-tauri/src/download_watcher.rs` | 메시지 관리함 감시, 풀 슬롯 관리, WinEvent 후킹, 자동 다운로드 트리거. **`gif_watcher.rs` 패턴 그대로 따라간다.** |
| `src-tauri/src/coolmsg_window.rs` *(또는 `download_watcher.rs` 내부에)* | Helper의 `window_manager.rs` 에 대응하는 Win32 헬퍼: `find_inbox_windows`, `find_file_entries`, `click_save_button`, `calculate_attach_position`, `get_download_path` |

#### 풀 구조

`gif_watcher::POOL` 과 동일한 모양으로:

```rust
pub const POOL: &[&str] = &[
    "download-panel-0",
    "download-panel-1",
    "download-panel-2",
];
```

각 슬롯은 단일 webview window 하나로 칩 ↔ 패널 모드를 전환한다 (별도 칩 창 + 패널 창으로 분리하지 않음. CSS+크기 변경으로 처리 → owner-chain이 단순해짐).

크기 전환은 Tauri 측에서 `set_size(PhysicalSize::new(140, 32))` ↔ `(320, 460)` 으로 호출하고, 동시에 `calculate_attach_position`을 다시 돌려 위치를 갱신한다.

#### 후킹 이벤트

`gif_watcher::track_with_hooks` 와 동일한 패턴:

- `EVENT_OBJECT_LOCATIONCHANGE` (target PID) → 위치 따라가기
- `EVENT_OBJECT_DESTROY`, `EVENT_OBJECT_HIDE` (target PID) → 패널 숨김 + 슬롯 해제
- `EVENT_SYSTEM_MINIMIZESTART/END` (system-wide) → 최소화 시 숨김
- `EVENT_SYSTEM_FOREGROUND` (system-wide) → `set_always_on_top` 토글

#### 폴링 (파일 목록 갱신)

Helper와 동일하게 100ms 간격으로 자식 컨트롤 enumerate. 마지막 결과와 다르면 emit + (자동 다운로드 ON 시) `click_save_button`.

#### Tauri Commands (신규)

| 명령 | 시그니처 | 비고 |
|---|---|---|
| `download_helper_open_file` | `(path: String) -> Result<(), String>` | `cmd /c start "" "<path>"` 로 OS 기본 앱 열기. Helper의 `open_file` 그대로 |
| `download_helper_set_enabled` | `(enabled: bool) -> ()` | `AtomicBool` 토글. 레지스트리에도 저장 |
| `download_helper_set_auto_save` | `(enabled: bool) -> ()` | 마찬가지 |
| `download_helper_set_panel_mode` | `(label: String, expanded: bool) -> ()` | 호버 인 / 아웃 시 프론트에서 호출 → Rust가 창 크기 + 위치 재계산 |

모두 `main.rs::generate_handler![...]` 에 등록.

#### Cargo.toml 의존성

추가 불필요. Hypercool은 이미 `windows`, `regex`, `chrono`, `dirs(?)`, `winreg`, `serde`, `serde_json` 을 보유. (단, Helper는 `dirs` 를 쓰는데 Hypercool은 없음 → 다운로드 경로 폴백을 `winreg` 기반 `Shell Folders` 조회로 대체하거나 `dirs` 를 신규 추가)

### 4.2 프론트엔드 (React/TS)

#### 신규 엔트리포인트

| 파일 | 용도 |
|---|---|
| `download-panel.html` | 프로젝트 루트, Tauri `WebviewUrl` 의 대상 |
| `src/download-panel.tsx` | 진입점 (`createRoot(...).render(<DownloadPanel />)`) |
| `src/download-panel/DownloadPanel.tsx` | 메인 컴포넌트 (칩/패널 모드 + 호버 전환) |
| `src/download-panel/FileItem.tsx` | 파일 1줄 (Helper의 `FileItem` 컴포넌트 이식) |
| `src/download-panel/extStyle.ts` | 확장자 → 배지 색 매핑 (Helper의 `getExtStyle` 함수 이식) |
| `src/download-panel/types.ts` | `FileInfo`, `PanelStatus` |
| `src/download-panel/DownloadPanel.css` | Hypercool 톤에 맞춘 스타일 |

#### vite.config.ts

`rollupOptions.input` 에 추가:

```ts
'download-panel': './download-panel.html',
```

#### Tauri 이벤트

Rust → React:

| 이벤트 | payload | 의미 |
|---|---|---|
| `download-panel://files` (per-window emit) | `FileInfo[]` | 슬롯별 파일 목록 갱신 |
| `download-panel://status` (per-window emit) | `"searching" \| "connected" \| "disconnected"` | 칩/푸터 점 색상 |

`per-window emit` 은 `Window::emit_to(label, event, payload)` 또는 각 슬롯이 자기 label을 알고 필터링.

### 4.3 main.rs 셋업

`setup` 블록의 gif-btn 풀 생성 다음에:

```rust
for &label in download_watcher::POOL {
    let _ = tauri::WebviewWindowBuilder::new(app, label, make_url("download-panel.html"))
        .title("파일 관리")
        .inner_size(140.0, 32.0)        // 칩 모드 기본
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .visible(false)
        .build();
}

let dl_app = app.app_handle().clone();
std::thread::spawn(move || download_watcher::start_watcher(dl_app));
```

### 4.4 설정 저장

Hypercool 컨벤션: UI 토글은 레지스트리.

레지스트리 키: `HKCU\Software\HyperCool`

| Value | 기본값 | 의미 |
|---|---|---|
| `DownloadHelperEnabled` | `1` | 기능 자체 ON/OFF |
| `DownloadHelperAutoSave` | `1` | 자동 「모든파일 저장」 클릭 ON/OFF |

SettingsTab (또는 SettingsPage)에 2개 토글 추가. `useSettings` 훅에 항목 추가하여 `set_registry_value` / `get_registry_value` 로 동기화.

---

## 5. 자동 다운로드 안전장치

> 자동 ON이 기본이지만, 의도치 않은 부작용을 방지하기 위한 가드.

1. **중복 클릭 디바운스**: 마지막 `click_save_button` 후 1초간 같은 hwnd에 대한 추가 클릭 차단 (Helper에 없는 안전장치, 자동 클릭이 여러 번 발사되는 케이스 예방).
2. **신규 파일이 있을 때만**: `any_new = files.any(|f| !f.exists)` 인 경우에만 클릭. 이미 다 받아진 상태에서는 클릭 안 함.
3. **AutoSave OFF 시**: 파일 목록은 여전히 보여주되, 사용자가 직접 「모든파일 저장」을 누를 때까지 자동 클릭 안 함.
4. **메시지 관리함이 foreground 가 아닐 때도 클릭은 동작함** (현 Helper 동작 유지). 사용자 입력을 가로채는 게 아닌 메시지 송신이라 백그라운드 클릭이 안전.

---

## 6. 단계별 이행 계획

### Phase 1 — 백엔드 기반

- [ ] `src-tauri/src/download_watcher.rs` 신규 (`gif_watcher.rs` 골격 복제 → 메시지 관리함용으로 수정)
- [ ] Helper의 `window_manager.rs` 함수들 이식 (find/extract/click/getDownPath/calculate_attach_position)
- [ ] `lib.rs` 에 모듈 등록
- [ ] `main.rs`: 풀 윈도우 생성 + watcher 스레드 spawn + commands 등록
- [ ] 로컬 빌드 확인 (`npm run tauri dev`) — 메시지 관리함을 띄웠을 때 빈 패널이 우측에 부착되는지

### Phase 2 — 프론트엔드

- [ ] `download-panel.html` 추가, `vite.config.ts` 에 엔트리 등록
- [ ] `DownloadPanel` 컴포넌트 (칩/패널 토글 + 호버)
- [ ] `FileItem` + 확장자 배지 (Helper에서 이식)
- [ ] Rust 측 이벤트 listen (`files-updated`, `status`)
- [ ] 디자인 검토 (Hypercool 본체와 동일한 vibrancy/모서리/그림자)

### Phase 3 — 설정 & 마무리

- [ ] SettingsTab 에 토글 2개 추가
- [ ] `useSettings` 훅에 필드 추가, 레지스트리 동기화
- [ ] 자동 다운로드 안전장치 (디바운스 등)
- [ ] CLAUDE.md 의 "Multi-window Tauri shell" 절 갱신 (`download-panel.html` 추가)
- [ ] `verify_appin_parser.py` 처럼 회귀 fixture가 필요한지 검토 — 메시지 관리함은 외부 의존이라 자동 테스트가 어렵다 → 수동 QA 시나리오 문서화로 대체

---

## 7. 수동 QA 체크리스트

빌드 후 실제 쿨메신저 환경에서 확인:

- [ ] 메시지 관리함을 열면 우상단에 「📎 N개 첨부」 칩이 뜨는가
- [ ] 칩에 호버하면 패널로 확장되는가 (200ms 이내, 부드러운 전환)
- [ ] 호버 해제 후 패널을 벗어나면 300ms 후 칩으로 축소되는가
- [ ] 메시지 관리함을 드래그 이동하면 칩/패널이 즉시 따라오는가 (지연 < 16ms 체감)
- [ ] 메시지 관리함을 최소화하면 칩이 사라지는가, 복원하면 다시 뜨는가
- [ ] 새 첨부가 발견되면 자동으로 「모든파일 저장」이 클릭되는가
- [ ] 다운로드 완료 후 파일을 더블클릭하면 OS 기본 앱이 열리는가
- [ ] 메시지 관리함 2개 동시 열기 → 칩 2개가 각각 부착되는가 (풀)
- [ ] SettingsTab 에서 자동 다운로드 OFF → 클릭이 더 이상 발생하지 않는가
- [ ] SettingsTab 에서 기능 자체 OFF → 모든 칩/패널 숨김, 메시지 관리함을 새로 열어도 표시 안 됨
- [ ] 다른 모니터로 메시지 관리함 이동 → 칩/패널이 같은 모니터로 따라가는가
- [ ] 메시지 관리함을 닫으면 칩/패널이 깔끔히 사라지고 슬롯이 회수되는가 (4번째 창 열어 풀이 재활용되는지)

---

## 8. 알려진 트레이드오프 / 미해결 질문

1. **풀 크기 3개로 충분한가?** 4개 이상의 메시지 관리함을 동시에 띄우는 사용자가 있다면 4번째는 패널 없이 동작. gif_widget도 동일한 제약이라 일관성은 있음. → 일단 3으로 가고, 피드백 받으면 증설.
2. **단일 webview에서 칩↔패널 전환 vs 별도 창 2개?** 단일 윈도우 + 크기 변경으로 가는 게 owner-chain/포커스/포지셔닝이 단순. 단, 크기 전환 시 잠깐의 깜빡임이 있을 수 있음 → 검증 필요. 깜빡임이 심하면 gif_widget처럼 chip 창 + panel 창 분리로 전환.
3. **`dirs` crate 추가 vs `Shell Folders` 레지스트리?** Helper는 `dirs` 사용. Hypercool에 추가하면 +50KB 정도. 다운로드 경로 폴백은 거의 안 쓰이는 코드 경로라 `Shell Folders` 키를 직접 읽는 게 깔끔. → 결정 보류, 구현 시 정함.
4. **에러 가시화**: 현재 Helper는 에러를 콘솔에만 찍음. Hypercool은 트레이 알림이나 토스트가 있나? → SettingsTab 옆에 작은 상태 텍스트 정도면 충분할 것으로 봄.
5. **MCP 서버에 다운로드 도구 노출?** 외부 AI가 「오늘 받은 첨부 목록 보여줘」 같은 쿼리를 할 수 있도록 `list_downloads` MCP tool 추가 여지가 있음. 이번 이행에는 포함하지 않고, 후속 이슈로.

---

## 9. 변경 영향 범위 요약

| 영역 | 신규 | 수정 |
|---|---|---|
| Rust 모듈 | `download_watcher.rs` | `lib.rs`, `main.rs` |
| Frontend 엔트리 | `download-panel.html`, `src/download-panel/*` | `vite.config.ts` |
| 설정 | — | `SettingsTab.tsx`, `useSettings.ts` |
| 빌드/릴리즈 | — | (영향 없음 — `release_method.py` 그대로 동작) |
| 문서 | 본 문서 | `CLAUDE.md`(Multi-window 절), `README.md`(기능 소개 한 줄) |
