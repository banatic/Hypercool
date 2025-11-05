# HyperCool

쿨 메신저의 메시지들을 마감일에 따라 분류하고 데드라인을 관리할 수 있는 프로그램입니다.

## 개발 환경 설정

### 필수 사항

- Node.js 18 이상
- Rust 1.70 이상
- Tauri CLI 2.0

### 설치

```powershell
# 의존성 설치
npm install

# 개발 모드 실행
npm run tauri dev
```

### 빌드

```powershell
# 빌드
npm run tauri build
```

## 사용 방법

1. 빌드 후 `src-tauri\target\release\bundle\nsis\HyperCool_0.1.0_x64-setup.exe` 통해 설치

2. 프로그램 실행 후 설정 페이지에서 "UDB 파일 열기" 버튼 클릭

3. `.udb` 파일 선택 (기본 경로는 "C:\Users\사용자명\AppData\Local\CoolMessenger\Memo\ ")
