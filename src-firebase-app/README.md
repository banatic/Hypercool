# HyperCool 웹

HyperCool Windows 앱이 Firestore 로 동기화한 일정·할 일·쿨메신저 메시지를 어디서나 볼 수 있는 읽기 전용 웹 컴패니언입니다.
배포 주소: https://hypercool-fe1fa.web.app

## 화면

- **오늘** — 오늘의 일정, 다가오는 7일, 최근 메시지
- **달력** — 월간 격자 + 선택한 날짜의 목록(아젠다). 좌우 방향키로 달 이동, `T` 로 오늘
- **메시지** — 목록·상세 2단(모바일은 목록 → 상세 전환), 불러온 메시지 안에서 검색, 끝까지 내리면 이전 메시지 자동 로드
- **iOS 위젯**(`/widget`) — Scriptable 위젯 설치·연결 안내

할 일은 별도 탭 없이 마감일 기준으로 달력과 오늘 화면에 함께 나타납니다.

## iOS 위젯 (Scriptable)

iOS 홈 화면 위젯은 네이티브 앱만 만들 수 있으므로, [Scriptable](https://scriptable.app) 스크립트로 제공합니다.

- 스크립트 원본: `public/hypercool-widget.js`. `npm run build` 가 `scripts/make-scriptable.mjs` 로 `public/HyperCool.scriptable`(가져오기 파일)을 만든다.
- 연결: 웹 `/widget` 의 "위젯 연결"이 `scriptable:///run/HyperCool?token=<Firebase refresh token>` 을 열고, 스크립트가 토큰을 iOS Keychain 에 저장한다. 이후 `securetoken.googleapis.com` 으로 ID 토큰을 갱신하고 Firestore REST `runQuery` 로 `events` 를 읽는다(쓰기 없음).
- 표시: 소형(오늘 3건) · 중형(오늘 4건) · 대형(오늘 + 다음 7일). 30분마다 갱신, 오프라인이면 마지막 데이터를 "마지막 동기화 기준"으로 표시. 탭하면 웹 `/today` 로.
- 연결 해제: Scriptable 에서 스크립트를 지우거나, 스크립트 안의 Keychain 키(`hypercool.*`)를 지운다.
- 테스트: `tests/widget-script.test.ts` 가 Scriptable 전역을 흉내 내어 스크립트를 실행한다.

## 데이터

- `users/{uid}/events` — 일정·할 일. `isDeleted == false` 만 실시간 구독 (`src/context/DataContext.tsx`)
- `users/{uid}/messages` — 최근 20건 실시간 구독, 그 이전은 `id` 내림차순으로 페이지 로드 (`src/hooks/useMessages.ts`)
- 메시지 본문(HTML)은 표시 전에 DOMPurify 로 정제합니다 (`src/utils/sanitize.ts`)

쓰기는 하지 않습니다. 데이터 변경은 Windows 앱에서만 합니다.

## 로그인과 데스크톱 연동

Google 팝업 로그인 후, Windows 브라우저에서는 `hypercool://auth/callback?token=…&type=google` 딥링크를 숨은 iframe 으로 열어 데스크톱 앱에도 로그인을 전달합니다. 팝업이 막힌 환경에서는 리다이렉트 로그인으로 전환합니다.

## 명령

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # vitest (jsdom)
npm run lint
npm run build        # tsc -b && vite build → dist/
firebase deploy --only hosting
```

`firebase.json` 은 `dist/` 를 배포하며, `index.html` 은 `no-cache`, 해시된 `assets/` 는 1년 캐시입니다.
자세한 배포 절차는 `FIREBASE_DEPLOY.md` 를 참고하세요.

## 디자인 토큰

`src/styles/variables.css` 한 곳에서 색·간격·반경을 관리합니다. 데스크톱 앱과 같은 트루 블루(`#3b82f6`) 액센트, 라이트 기본에 시스템 다크 모드를 따릅니다. 서체는 Pretendard Variable(jsDelivr) 입니다.
