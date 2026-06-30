<div align="center">

# HyperCool

**쿨메신저(CoolMessenger)를 위한 스마트 메시지·일정 관리 데스크탑 앱**
_A smart desktop companion for the Korean school messenger "쿨메신저" (CoolMessenger)._

![HyperCool Screenshot](https://github.com/user-attachments/assets/c268132f-58a5-44b3-a5ed-5eeb61bb670a)

[![Release](https://img.shields.io/github/v/release/banatic/Hypercool)](https://github.com/banatic/Hypercool/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/banatic/Hypercool/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202.0-24C8D8)](https://tauri.app)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20TypeScript-61DAFB)](https://react.dev)
[![Backend](https://img.shields.io/badge/backend-Rust-CE412B)](https://www.rust-lang.org)

</div>

---

## 소개

**HyperCool**(하이퍼쿨)은 학교 메신저 **쿨메신저(CoolMessenger, 지란지교 CoolMsg)** 를 보조하는 **Windows 데스크탑 앱**입니다. 쿨메신저가 로컬에 저장하는 `.udb` 메시지 데이터베이스를 직접 읽어, **받은 메시지를 자동으로 분류**하고 **할 일(todo)·마감일(deadline)** 을 추려서 한눈에 보여줍니다. 여기에 **바탕화면 달력 위젯**, **급식·시간표 학교 위젯**, **첨부파일 자동 다운로드**, **GIF 피커**, **Firebase 기반 기기 간 동기화**, 그리고 **AI(MCP) 연동**까지 더해, 교사·교직원이 매일 쓰는 쿨메신저 업무 흐름을 한 단계 끌어올립니다.

> **이런 분께 유용합니다** — 쿨메신저를 매일 쓰는 **교사·선생님·교직원**, 쏟아지는 공지/안내 메시지에서 **해야 할 일과 마감만 빠르게 골라내고 싶은 분**, 급식·시간표를 **바탕화면에서 바로 확인**하고 싶은 분, 그리고 쿨메신저 메시지를 **Claude 같은 AI로 검색·요약**하고 싶은 분.

**English summary** — HyperCool is a Windows desktop app that augments **CoolMessenger** (쿨메신저), a messenger widely used in Korean schools. It reads the local `.udb` SQLite message store, classifies incoming messages, extracts todos and deadlines, embeds desktop widgets (calendar, school meal/timetable, GIF picker), auto-downloads attachments from CoolMessenger's inbox, syncs schedules across devices via Firebase, and runs a built-in **MCP (Model Context Protocol) server** so AI clients such as Claude Desktop can search your messages and attachments over HTTP. Built with **Tauri 2.0** (Rust) + **React/Vite** (TypeScript).

---

## 목차

- [주요 기능](#주요-기능)
- [화면 미리보기](#화면-미리보기)
- [설치](#설치)
- [시작하기](#시작하기)
- [기능 상세](#기능-상세)
  - [메시지 분류 & 할 일](#메시지-분류--할-일)
  - [전체 메시지 보기 & 검색](#전체-메시지-보기--검색)
  - [달력 위젯](#달력-위젯)
  - [학교 위젯 (급식·시간표)](#학교-위젯-급식시간표)
  - [첨부파일 다운로드 헬퍼](#첨부파일-다운로드-헬퍼)
  - [GIF 피커](#gif-피커)
  - [기기 간 동기화 (웹 컴패니언)](#기기-간-동기화-웹-컴패니언)
  - [AI 연동 (MCP)](#ai-연동-mcp)
- [개발 환경](#개발-환경)
- [프로젝트 구조](#프로젝트-구조)
- [기술 스택](#기술-스택)
- [자주 묻는 질문 (FAQ)](#자주-묻는-질문-faq)

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 📥 **메시지 분류** | 받은 메시지를 **완료 / 해야 할 일** 로 구분하고 마감일(deadline)을 관리 |
| ✅ **할 일 모아보기** | 기한이 있는 메시지만 모아 마감 임박 순으로 한눈에 확인 |
| 🔎 **전체 메시지 & 검색** | 오프라인에서도 빠른 전체 메시지 조회 + **FTS5 전문 검색(full-text search)** |
| 🗓️ **달력 위젯** | 일정을 **바탕화면 위젯**으로 상시 표시 (핀 고정·자동 실행 지원) |
| 🏫 **학교 위젯** | **급식 · 시간표 · 출결 · 상/벌점 · 주식 · 할 일 · 바로가기** 탭을 바탕화면에서 |
| 📎 **첨부파일 자동 다운로드** | 쿨메신저 「메시지 관리함」 첨부파일을 자동 저장하고 측면 패널에서 바로 열기 |
| 🎞️ **GIF 피커** | 쿨메신저 작성창 옆에서 **Tenor GIF** 를 검색해 바로 붙여넣기 |
| ☁️ **기기 간 동기화** | 일정·할 일을 **Firebase Firestore** 로 동기화, 웹/모바일 브라우저에서 열람 |
| 🤖 **AI 연동 (MCP)** | **MCP 서버 내장(포트 3737)** — Claude 등 AI가 메시지·첨부·이미지를 직접 검색 |
| ⏫ **자동 업데이트** | 새 버전 출시 시 자동 감지·설치 (`tauri-plugin-updater`) |

---

## 화면 미리보기

| 메인 — 메시지 분류 / 할 일 | 달력 위젯 |
|---|---|
| ![Main](https://github.com/user-attachments/assets/c268132f-58a5-44b3-a5ed-5eeb61bb670a) | ![Calendar widget](https://github.com/user-attachments/assets/6a34092b-3710-41e9-b2bb-516501913199) |

| 학교 위젯 — 급식 / 시간표 | AI 연동 (MCP) |
|---|---|
| ![School widget](https://github.com/user-attachments/assets/1c280c8b-ac50-4513-a9d0-b73f6426afe1) | ![MCP](https://github.com/user-attachments/assets/d337f2c8-3ffd-4edb-a91b-e16a9e8bac6c) |

---

## 설치

[**Releases 페이지**](https://github.com/banatic/Hypercool/releases)에서 최신 `.msi` 설치 파일을 내려받아 실행하세요.

- 지원 OS: **Windows 10 / 11** (64-bit)
- 설치 후 첫 실행 시 쿨메신저 `.udb` 파일 경로만 지정하면 바로 사용할 수 있습니다.
- 이후 새 버전은 앱이 **자동으로 감지·설치**합니다.

---

## 시작하기

1. HyperCool 설치 후 프로그램 실행
2. **설정 페이지 → UDB 파일 열기** 클릭
3. 쿨메신저의 `.udb` 파일 선택

> 기본 경로: `C:\Users\사용자명\AppData\Local\CoolMessenger\Memo\`

선택이 끝나면 메시지가 로드되고, 분류·할 일·검색·위젯을 바로 사용할 수 있습니다.

---

## 기능 상세

### 메시지 분류 & 할 일

받은 쿨메신저 메시지를 **완료 / 해야 할 일**로 나누어 관리합니다. 각 항목에 **마감일(deadline)** 을 지정하면 할 일 화면에서 마감 임박 순으로 정렬됩니다. 처리한 메시지는 완료로 넘겨 받은함을 깔끔하게 유지할 수 있습니다.

### 전체 메시지 보기 & 검색

쿨메신저가 켜져 있지 않아도, 로컬 `.udb` 를 읽어 **모든 수신 메시지를 오프라인으로 빠르게 조회**합니다. 별도의 **FTS5 전문 검색 인덱스**를 두어 키워드 검색이 즉각적입니다. 발신자·날짜 범위·이미지 포함 여부로도 필터링할 수 있습니다.

### 달력 위젯

일정을 **바탕화면에 고정되는 위젯**으로 상시 표시합니다. 핀(pin) 모드로 항상 위에 띄우거나, 부팅 시 자동 실행되도록 설정할 수 있습니다. 등록한 일정은 [기기 간 동기화](#기기-간-동기화-웹-컴패니언)로 다른 기기에서도 볼 수 있습니다.

### 학교 위젯 (급식·시간표)

급식·시간표를 비롯한 학교 정보를 탭 구조의 바탕화면 위젯으로 확인합니다.

- **급식** — 오늘/이번 주 급식 식단
- **시간표** — 현재 교시 자동 하이라이트 (AppIn `.dat` 시간표 파싱 지원)
- **출결 · 상/벌점** — 학교 시스템에서 스크랩한 정보
- **주식** — 간단한 시세 위젯
- **할 일 · 바로가기** — 위젯에서 바로 접근하는 todo / 단축 링크

### 첨부파일 다운로드 헬퍼

쿨메신저 「**메시지 관리함**」 / 「N개의 안읽은 메시지」 창을 감지해, 첨부파일을 **자동으로 다운로드**하고 측면 패널에서 한 번에 열어볼 수 있게 해 줍니다.

- 평소에는 작은 **칩(chip)** 으로 떠 있다가, 마우스를 올리면 **파일 목록 패널**로 부드럽게 펼쳐집니다.
- 「모든파일 저장 (Ctrl+S)」을 자동 클릭해 첨부를 받아 줍니다(자동 저장 토글 가능).
- 다운로드 경로는 쿨메신저 설정(`HKCU\Software\Jiransoft\CoolMsg50\Option\GetFile\DownPath`)을 그대로 따릅니다.
- 설정에서 **기능 ON/OFF**, **자동 저장 ON/OFF** 를 각각 제어할 수 있습니다.

### GIF 피커

쿨메신저 메시지 작성창 옆에 GIF 버튼을 띄워, **Tenor** 에서 GIF 를 검색해 클립보드로 바로 붙여넣을 수 있습니다.

### 기기 간 동기화 (웹 컴패니언)

일정·할 일은 **Firebase Firestore** 에 동기화되어, 데스크탑 외에 **웹/모바일 브라우저**에서도 열람할 수 있습니다. 로그인은 **Google 계정(OAuth)** 을 사용하며, 동기화는 `updatedAt` 기준 last-write-wins 정책을 따릅니다. (데스크탑이 쓰기 주체, 웹 컴패니언은 읽기 전용)

### AI 연동 (MCP)

HyperCool 이 실행 중이면 **Claude 등 AI 클라이언트가 쿨메신저 메시지·첨부·이미지를 직접 검색**할 수 있습니다. 내장 **MCP(Model Context Protocol) 서버**가 `127.0.0.1:3737` 에서 JSON-RPC(`POST /mcp`)로 동작합니다.

**사용 가능한 도구(tools):**

| 도구 | 설명 |
|------|------|
| `search_messages` | 키워드로 메시지 전문 검색 |
| `get_messages` | 메시지 목록 조회 (발신자·날짜·이미지 필터, `stats=true` 시 DB 통계) |
| `get_message_by_id` | 특정 메시지 전체 내용 |
| `list_attachments` | 수신 첨부 파일 목록 (파일명·확장자 필터) |
| `read_attachment` | 첨부 파일 텍스트 추출 (hwp/hwpx/pdf/xlsx/pptx/csv 등) |
| `view_image` | 첨부 또는 본문 인라인 이미지를 AI가 시각적으로 확인 |

> **에듀파인 연동(선택):** 설정에서 활성화하면 「에듀파인」 공문 검색용 도구(`search_edufine_docs`, `get_edufine_doc`, `list_edufine_docs`)가 추가됩니다.

**Claude Desktop 설정** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hypercool": {
      "url": "http://localhost:3737/mcp"
    }
  }
}
```

> ⚠️ MCP 서버는 **HyperCool 앱이 실행 중일 때만** 동작합니다.

---

## 개발 환경

**필수 도구**

| 도구 | 버전 |
|------|------|
| Node.js | 18 이상 |
| Rust | 1.70 이상 |
| Tauri CLI | 2.0 |

**설치 및 실행**

```powershell
# 의존성 설치 (Rust 의존성은 Tauri가 자동으로 가져옵니다)
npm install

# 개발 모드 — Vite(포트 1420) + Tauri 셸 동시 실행
npm run tauri dev

# 프로덕션 빌드 — src-tauri/target/release/bundle/msi/ 에 MSI 생성
npm run tauri build

# 프론트엔드 단위 테스트 (Vitest)
npm test
```

**릴리즈**는 `scripts/release_method.py` 로 자동화되어 있습니다. 버전 범프, 빌드, `latest.json` 갱신, GitHub 릴리즈 생성까지 한 번에 수행합니다. 자세한 내용은 [`docs/release_method.md`](docs/release_method.md)를 참고하세요.

```bash
python scripts/release_method.py 0.5.20 --notes "..."
```

---

## 프로젝트 구조

```
Hypercool/
├─ src/              # React/TypeScript 프론트엔드 (메인 앱 + 위젯들)
│  ├─ components/    # 메인 앱 페이지 (분류/할일/히스토리/설정/MCP/도움말)
│  ├─ school-widget/ # 학교 위젯 탭 (급식/시간표/출결/상벌점/주식/할일/바로가기)
│  ├─ download-panel/# 첨부파일 다운로드 헬퍼 패널
│  ├─ hooks/         # 도메인별 상태 훅 (useSettings, useMessages, …)
│  ├─ sync/          # Firestore 양방향 동기화
│  └─ services/      # 일정 CRUD 등 서비스 계층
├─ src-tauri/        # Rust 백엔드 (Tauri 2.0)
│  └─ src/           # UDB 읽기, MCP 서버, 위젯 창 관리, 워처 스레드 등
├─ src-firebase-app/ # 웹 컴패니언 (읽기 전용 Firebase 호스팅 앱)
├─ scripts/          # 릴리즈 자동화 및 진단용 Python 스크립트
└─ docs/             # 설계·구조 문서
```

여러 개의 Tauri 웹뷰 창(메인 앱 + 달력/학교/GIF/다운로드 위젯)이 하나의 프로세스에서 동작합니다. 자세한 아키텍처는 [`CLAUDE.md`](CLAUDE.md) 와 [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) 를 참고하세요.

---

## 기술 스택

- **Frontend** — React + TypeScript + Vite
- **Backend** — Rust + Tauri 2.0
- **Database** — SQLite (rusqlite) + **FTS5 전문 검색**
- **Sync** — Firebase Firestore + Google OAuth
- **AI 연동** — MCP 서버 (Axum / JSON-RPC, 포트 3737)
- **자동 업데이트** — `tauri-plugin-updater`

---

## 자주 묻는 질문 (FAQ)

**Q. AI(Claude)에서 메시지를 검색하려면?**
A. HyperCool 을 실행한 뒤 [AI 연동 (MCP)](#ai-연동-mcp) 의 설정을 Claude Desktop 에 추가하면, Claude 가 메시지·첨부·이미지를 바로 검색할 수 있습니다.

**Q. 자동 업데이트는 어떻게 동작하나요?**
A. 일정 주기로 새 버전을 자동으로 감지·설치합니다. 특정 버전은 건너뛰기로 설정할 수 있습니다.

---

<div align="center">
<sub>HyperCool · 쿨메신저(CoolMessenger) 보조 데스크탑 앱 · Made with Rust + React + Tauri</sub><br/>
<sub><b>keywords</b>: 쿨메신저 · CoolMessenger · 학교 메신저 · 교사 업무 · 메시지 관리 · 할 일 · 일정 · 급식 · 시간표 · 바탕화면 위젯 · MCP · Claude · Tauri · Rust · React</sub>
</div>
