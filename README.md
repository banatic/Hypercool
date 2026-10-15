# HyperCool

쿨메신저에서 받은 메시지를 정리하고, 일정과 할 일을 관리하기 위한 Windows 앱입니다.

HyperCool은 쿨메신저의 로컬 `.udb` 파일을 읽습니다. 받은 메시지를 확인하거나 검색하고, 필요한 항목에 마감일을 붙여 할 일로 관리할 수 있습니다. 달력과 학교 정보는 별도 위젯으로 띄울 수 있습니다.

## 설치

[Releases](https://github.com/banatic/Hypercool/releases)에서 최신 `.msi` 파일을 내려받아 설치합니다.

- 지원 환경: Windows 10/11 64-bit
- 쿨메신저가 설치된 PC에서 사용합니다.
- 앱을 처음 열면 쿨메신저 메시지 파일(`.udb`)을 선택해야 합니다.

## 처음 설정하기

1. HyperCool을 실행합니다.
2. **설정 → UDB 파일 열기**를 선택합니다.
3. 쿨메신저의 `.udb` 파일을 고릅니다.

파일 위치는 설치 환경에 따라 다릅니다. 일반적으로 아래 경로 아래에서 찾을 수 있습니다.

```text
C:\Users\사용자명\AppData\Local\CoolMessenger\Memo\
```

이후에는 앱이 지정한 파일을 기준으로 메시지를 불러옵니다.

## 할 수 있는 일

### 메시지 정리와 검색

- 받은 메시지를 완료와 할 일로 구분
- 메시지에 마감일을 지정하고 기한순으로 확인
- 발신자, 날짜, 이미지 포함 여부 등으로 메시지 필터링
- 로컬 검색 데이터베이스를 이용한 본문 검색

![메시지 정리와 할 일 화면](https://github.com/user-attachments/assets/c268132f-58a5-44b3-a5ed-5eeb61bb670a)

### 위젯

- 일정과 할 일을 보여 주는 달력 위젯
- 급식, 시간표, 출결·상벌점, 할 일, 바로가기를 모은 학교 위젯
- 위젯을 항상 위에 표시하거나 시작 시 자동으로 열도록 설정 가능

| 달력 위젯 | 학교 위젯 |
| --- | --- |
| ![달력 위젯](https://github.com/user-attachments/assets/6a34092b-3710-41e9-b2bb-516501913199) | ![학교 위젯](https://github.com/user-attachments/assets/1c280c8b-ac50-4513-a9d0-b73f6426afe1) |

### 쿨메신저 보조 기능

- 메시지 관리함의 첨부파일 다운로드를 돕는 패널
- 쿨메신저 작성창에서 쓰는 GIF 검색 도구

### 동기화와 웹 보기

Google 계정으로 로그인하면 일정, 할 일, 메시지 데이터를 Firebase에 동기화해 웹 컴패니언에서 볼 수 있습니다. 동기화를 쓰지 않아도 메시지 정리와 위젯은 로컬에서 사용할 수 있습니다.

### AI 연동

앱을 실행한 상태에서 MCP 서버를 통해 Claude Desktop 같은 클라이언트가 메시지와 첨부파일을 검색하도록 연결할 수 있습니다. 설정 화면의 **AI 연동**에서 연결 상태와 안내를 확인할 수 있습니다.

에듀파인 공문 수집을 켠 경우에는 수집된 공문도 함께 검색 대상에 포함됩니다. 이 기능은 외부 AI에 데이터를 제공하는 기능이므로, 연결할 클라이언트와 질문 내용을 확인한 뒤 사용하세요.

![AI 연동 화면](https://github.com/user-attachments/assets/d337f2c8-3ffd-4edb-a91b-e16a9e8bac6c)

## 개발

필요한 도구는 Node.js 18 이상과 Rust입니다. Tauri CLI는 프로젝트 의존성으로 설치됩니다.

```powershell
npm install
npm run tauri dev
```

테스트와 빌드는 다음 명령으로 실행합니다.

```powershell
npm test
npm run build
npm run tauri build
```

`npm run build`는 프런트엔드 결과물을 만들고, `npm run tauri build`는 Windows 설치 파일을 생성합니다.

## 구성

```text
src/                 React 기반 데스크톱 UI
src-tauri/           Rust/Tauri 백엔드와 Windows 연동
src-firebase-app/    동기화 데이터를 보는 웹 컴패니언
scripts/             릴리즈와 점검 스크립트
docs/                개발 문서
```

릴리즈 절차는 [docs/release_method.md](docs/release_method.md), 폴더와 데이터 흐름은 [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)에 정리되어 있습니다.

## 기술

React, TypeScript, Vite, Rust, Tauri, SQLite, Firebase를 사용합니다.
