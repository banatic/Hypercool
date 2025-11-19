# 1. 수동

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

# 2. Python Script (완전 자동화)

## 사전 요구사항

1. **GitHub CLI 설치 및 인증**
   ```bash
   # GitHub CLI 설치: https://cli.github.com/
   gh auth login
   ```

2. **Git 설정**
   - Git이 설치되어 있고 PATH에 있어야 합니다.
   - 원격 저장소가 설정되어 있어야 합니다.

## 사용 방법

### 방법 1: 스크립트 내부 CONFIG 수정 후 실행

`scripts/release_method.py` 파일의 `CONFIG` 섹션을 수정하고 실행:

```python
CONFIG = ReleaseConfig(
    version="0.2.0",
    notes="릴리스 노트",
    pub_date=None,  # None이면 현재 UTC 시간 사용
    skip_build=False,
    skip_github_release=False,  # GitHub release 자동 생성
    skip_git_push=False,  # git push 자동 실행
)
```

```bash
python scripts/release_method.py
```

### 방법 2: CLI 인자 사용

```bash
python scripts/release_method.py 0.2.0 \
  --notes "릴리스 노트" \
  --notes-file release_notes.txt  # 또는 파일에서 읽기
```

## 자동화 기능

스크립트는 다음 작업을 자동으로 수행합니다:

1. ✅ **버전 업데이트**: `package.json`, `Cargo.toml`, `tauri.conf.json` 버전 교체
2. ✅ **빌드**: `npm run tauri build` 실행 (--skip-build로 건너뛰기 가능)
3. ✅ **latest.json 업데이트**: 서명 및 다운로드 URL 자동 설정
4. ✅ **GitHub Release 생성**: 
   - 태그 자동 생성 (`v{version}`)
   - MSI 파일 자동 업로드
   - 서명 파일(.sig) 자동 업로드 (존재하는 경우)
5. ✅ **Git 작업**:
   - `git add latest.json`
   - `git commit -m "Update latest.json for version {version}"`
   - `git push`

## 옵션

- `--skip-build`: 빌드 단계 건너뛰기 (이미 빌드된 경우)
- `--skip-github-release`: GitHub release 생성 건너뛰기
- `--skip-git-push`: git push 건너뛰기
- `--msi-path`: MSI 파일 경로 직접 지정
- `--notes-file`: 릴리스 노트를 파일에서 읽기
- `--pub-date`: RFC 3339 형식의 발행 날짜 지정

## 예시

```bash
# 완전 자동화 (빌드 + GitHub release + git push)
python scripts/release_method.py 0.2.0 --notes "새로운 기능 추가"

# 빌드만 건너뛰기
python scripts/release_method.py 0.2.0 --notes "버그 수정" --skip-build

# GitHub release만 건너뛰기
python scripts/release_method.py 0.2.0 --notes "내부 테스트" --skip-github-release
```