# HyperCool

## 개발 환경 설정

### 필수 사항

- Node.js 18 이상
- Rust 1.70 이상
- Tauri CLI 2.0

### 설치

```bash
# 의존성 설치
npm install

# Tauri 개발 모드 실행
npm run tauri dev
```

### 빌드

```bash
# 프로덕션 빌드
npm run tauri build
```

## 사용 방법

1. 앱 실행 후 "UDB 파일 열기" 버튼 클릭
2. `.udb` 파일 선택
3. 메시지가  화면에 표시됨
4. 메시지 드래그:
   - **왼쪽으로**: 읽음 처리 (제거)
   - **오른쪽으로**: Keep 처리 + Deadline 등록 옵션


