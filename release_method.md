## 1. 버전 교체

package.json
src-tauri/cargo.toml
src-tauri/tauri.conf.json

## 2. build

```bash
npm run tauri build
```

## 3. github release

TODO : CI/CD Pipeline

Tag 지정해서 `src-tauri\target\release\bundle\msi\` 안에 .msi 업로드

## 4. latest.json 수정

pub_date는 RFC 3339 만족하게끔

remote에 push