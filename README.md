# HyperCool

쿨메신저의 메시지들을 마감일에 따라 분류하고 데드라인을 관리할 수 있는 프로그램입니다.

![Image](https://github.com/user-attachments/assets/c268132f-58a5-44b3-a5ed-5eeb61bb670a)

## 기능

- 메시지 분류 (완료된 일 / 해야할 일) 및 Deadline 설정

- 해야할 일 모아보기

- 전체 메시지 보기 (오프라인 가능)

- 자동 업데이트 가능

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

1. 빌드 혹은 릴리즈 페이지에서 컴파일된 msi로 설치

2. 프로그램 실행 후 설정 페이지에서 "UDB 파일 열기" 버튼 클릭

3. `.udb` 파일 선택 (기본 경로는 "C:\Users\사용자명\AppData\Local\CoolMessenger\Memo\ ")


