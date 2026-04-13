<div align="center">

# HyperCool

**쿨메신저 메시지를 스마트하게 관리하는 데스크탑 앱**

![HyperCool Screenshot](https://github.com/user-attachments/assets/c268132f-58a5-44b3-a5ed-5eeb61bb670a)

[![Release](https://img.shields.io/github/v/release/banatic/Hypercool)](https://github.com/banatic/Hypercool/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/banatic/Hypercool/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202.0-24C8D8)](https://tauri.app)

</div>

---

## 주요 기능

- **메시지 분류** — 완료 / 해야 할 일로 구분하고 Deadline 관리
- **할 일 모아보기** — 기한이 있는 메시지만 모아서 한눈에 확인
- **전체 메시지 보기** — 오프라인에서도 빠른 전체 메시지 조회 및 검색
- **달력 위젯** — 일정을 바탕화면 위젯으로 상시 표시
- **학교 위젯** — 급식 / 시간표를 바탕화면 위젯으로 상시 표시
- **자동 업데이트** — 새 버전 출시 시 자동 감지 및 설치
- **MCP 서버 내장** — Claude 등 AI에서 메시지를 직접 검색 (포트 3737)

---

## 설치

[Releases](https://github.com/banatic/Hypercool/releases) 페이지에서 최신 `.msi` 설치 파일을 다운로드하세요.

---

## 시작하기

1. 설치 후 프로그램 실행
2. 설정 페이지에서 **UDB 파일 열기** 클릭
3. `.udb` 파일 선택

> 기본 경로: `C:\Users\사용자명\AppData\Local\CoolMessenger\Memo\`

---

## 달력 위젯

바탕화면에 고정되는 일정 위젯입니다. 핀 모드로 항상 표시하거나 자동 실행 설정이 가능합니다.

![달력 위젯](https://github.com/user-attachments/assets/6a34092b-3710-41e9-b2bb-516501913199)

---

## 학교 위젯

급식 정보와 시간표를 바탕화면 위젯으로 확인합니다.

![학교 위젯](https://github.com/user-attachments/assets/1c280c8b-ac50-4513-a9d0-b73f6426afe1)

---

## AI 연동 (MCP)

HyperCool이 실행 중이면 Claude 등 AI에서 쿨메신저 메시지를 직접 검색할 수 있습니다.

![MCP](https://github.com/user-attachments/assets/d337f2c8-3ffd-4edb-a91b-e16a9e8bac6c)

**사용 가능한 도구:**
- `search_messages` — 키워드로 메시지 검색
- `get_recent_messages` — 최근 메시지 목록
- `get_message_by_id` — 특정 메시지 전체 내용
- `get_db_stats` — 총 메시지 수, 동기화 시간 등

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

> HyperCool 앱이 실행 중일 때만 MCP 서버가 동작합니다.

---

## 개발 환경

**필수 사항**

| 도구 | 버전 |
|------|------|
| Node.js | 18 이상 |
| Rust | 1.70 이상 |
| Tauri CLI | 2.0 |

**설치 및 실행**

```powershell
# 의존성 설치
npm install

# 개발 모드 실행
npm run tauri dev

# 프로덕션 빌드
npm run tauri build
```

---

## 기술 스택

- **Frontend** — React + TypeScript + Vite
- **Backend** — Rust + Tauri 2.0
- **DB** — SQLite (rusqlite, FTS5 전문 검색)
- **업데이트** — tauri-plugin-updater

---

<div align="center">
<sub>Made with Rust + React</sub>
</div>
