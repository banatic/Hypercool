# Firebase 배포 가이드

이 문서는 HyperCool 프로젝트를 Firebase Hosting에 배포하는 방법을 설명합니다.

## 사전 요구사항

1. **Node.js 설치** (v16 이상 권장)
   - [Node.js 다운로드](https://nodejs.org/)

2. **Firebase CLI 설치**
   ```bash
   npm install -g firebase-tools
   ```

3. **Firebase 계정 및 프로젝트**
   - [Firebase Console](https://console.firebase.google.com/)에서 프로젝트 생성
   - 프로젝트 ID 확인 (현재: `hypercool-fe1fa`)

## 배포 단계

### 1. Firebase CLI 로그인

```bash
firebase login
```

브라우저가 열리면 Firebase 계정으로 로그인합니다.

### 2. Firebase 프로젝트 초기화

프로젝트 루트 디렉토리에서 실행:

```bash
firebase init hosting
```

다음과 같이 설정합니다:

- **What do you want to use as your public directory?** 
  - `dist` (Vite 빌드 출력 디렉토리)

- **Configure as a single-page app (rewrite all urls to /index.html)?**
  - `Yes` (React Router를 사용하므로 필요)

- **Set up automatic builds and deploys with GitHub?**
  - `No` (원하는 경우 나중에 설정 가능)

- **File dist/index.html already exists. Overwrite?**
  - `No` (기존 파일 유지)

### 3. Firebase 설정 파일 확인

초기화 후 다음 파일들이 생성됩니다:

- `firebase.json` - Firebase Hosting 설정
- `.firebaserc` - Firebase 프로젝트 정보

`firebase.json` 파일이 다음과 같이 설정되어 있는지 확인:

```json
{
  "hosting": {
    "public": "dist",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

### 4. 프로젝트 빌드

배포 전에 프로젝트를 빌드합니다:

```bash
npm run build
```

빌드가 성공하면 `dist` 폴더에 배포 가능한 파일들이 생성됩니다.

### 5. Firebase에 배포

빌드가 완료되면 다음 명령어로 배포합니다:

```bash
firebase deploy --only hosting
```

또는 모든 Firebase 서비스를 배포하려면:

```bash
firebase deploy
```

### 6. 배포 확인

배포가 완료되면 터미널에 배포된 URL이 표시됩니다:
```
✔  Deploy complete!

Project Console: https://console.firebase.google.com/project/hypercool-fe1fa/overview
Hosting URL: https://hypercool-fe1fa.web.app
```

브라우저에서 해당 URL로 접속하여 사이트가 정상적으로 작동하는지 확인합니다.

## 추가 설정

### 환경 변수 설정

프로덕션 환경에서 다른 Firebase 설정을 사용하려면:

1. `.env.production` 파일 생성:
   ```
   VITE_FIREBASE_API_KEY=your-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-auth-domain
   VITE_FIREBASE_PROJECT_ID=your-project-id
   ```

2. `src/firebase.ts`에서 환경 변수 사용:
   ```typescript
   const firebaseConfig = {
     apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
     authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
     projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
     // ...
   };
   ```

### 커스텀 도메인 설정

1. Firebase Console에서 **Hosting** > **사용자 지정 도메인 추가** 클릭
2. 도메인을 입력하고 인증 절차를 완료
3. DNS 설정을 도메인 제공업체에서 업데이트

### CI/CD 자동 배포 (GitHub Actions)

`.github/workflows/firebase-deploy.yml` 파일 생성:

```yaml
name: Deploy to Firebase Hosting

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Deploy to Firebase
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: '${{ secrets.GITHUB_TOKEN }}'
          firebaseServiceAccount: '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}'
          channelId: live
          projectId: hypercool-fe1fa
```

## 문제 해결

### 빌드 오류

- TypeScript 오류가 발생하면 `tsconfig.json` 설정 확인
- 의존성 문제가 있으면 `node_modules` 삭제 후 `npm install` 재실행

### 배포 오류

- Firebase CLI가 최신 버전인지 확인: `firebase --version`
- Firebase 프로젝트에 올바른 권한이 있는지 확인
- `firebase.json` 파일의 설정이 올바른지 확인

### 라우팅 문제

- SPA 설정이 올바른지 확인 (`rewrites` 설정)
- `dist/index.html` 파일이 존재하는지 확인

## 유용한 명령어

```bash
# Firebase 프로젝트 목록 확인
firebase projects:list

# 현재 프로젝트 확인
firebase use

# 다른 프로젝트로 전환
firebase use <project-id>

# 배포 전 미리보기
firebase hosting:channel:deploy preview

# 배포 기록 확인
firebase hosting:clone <site-id> <channel-id>
```

## 참고 자료

- [Firebase Hosting 문서](https://firebase.google.com/docs/hosting)
- [Vite 빌드 가이드](https://vitejs.dev/guide/build.html)
- [Firebase CLI 참조](https://firebase.google.com/docs/cli)

