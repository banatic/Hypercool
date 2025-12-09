from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


@dataclass
class ReleaseConfig:
    version: str
    notes: str
    pub_date: Optional[str] = None
    skip_build: bool = False
    msi_path: Optional[Path] = None
    bundle_dir: Path = Path("src-tauri/target/release/bundle/msi")
    latest_path: Path = Path("latest.json")
    repo_download_url: Optional[str] = None
    skip_github_release: bool = False
    skip_git_push: bool = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Automate the steps listed in release_method.md"
    )
    parser.add_argument(
        "version",
        help="Semver string to apply to package.json, Cargo.toml, tauri.conf.json, and latest.json",
    )
    parser.add_argument(
        "--notes",
        help="Release notes to embed into latest.json (use --notes-file for multi-line text)",
    )
    parser.add_argument(
        "--notes-file",
        type=Path,
        help="Path to a text file that will be read into latest.json's notes field",
    )
    parser.add_argument(
        "--pub-date",
        help="RFC3339 timestamp for latest.json (defaults to the current UTC time)",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip `npm run tauri build` (only when the MSI artifact already exists)",
    )
    parser.add_argument(
        "--msi-path",
        type=Path,
        help="Explicit path to the built MSI (otherwise searched under src-tauri/target/release/bundle/msi)",
    )
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=Path("src-tauri/target/release/bundle/msi"),
        help="Directory that contains the generated MSI files (defaults to src-tauri/target/release/bundle/msi)",
    )
    parser.add_argument(
        "--latest-path",
        type=Path,
        default=Path("latest.json"),
        help="Location of the latest.json file to update (defaults to repository root)",
    )
    parser.add_argument(
        "--repo-download-url",
        help=(
            "Override the base download URL (defaults to preserving the prefix from latest.json). "
            "Example: https://github.com/banatic/Hypercool/releases/download"
        ),
    )
    parser.add_argument(
        "--skip-github-release",
        action="store_true",
        help="Skip GitHub release creation (tag + upload)",
    )
    parser.add_argument(
        "--skip-git-push",
        action="store_true",
        help="Skip git add/commit/push for latest.json",
    )
    return parser.parse_args()


def config_from_args(args: argparse.Namespace) -> ReleaseConfig:
    notes = read_notes(args.notes, args.notes_file)
    return ReleaseConfig(
        version=args.version,
        notes=notes,
        pub_date=args.pub_date,
        skip_build=args.skip_build,
        msi_path=args.msi_path,
        bundle_dir=args.bundle_dir,
        latest_path=args.latest_path,
        repo_download_url=args.repo_download_url,
        skip_github_release=args.skip_github_release,
        skip_git_push=args.skip_git_push,
    )


def ensure_semver(value: str) -> str:
    if not SEMVER_RE.match(value):
        raise SystemExit(f"[error] Invalid version '{value}'. Expected SemVer such as 0.1.5")
    return value


def read_notes(arg_value: Optional[str], path: Optional[Path]) -> str:
    if arg_value and path:
        raise SystemExit("[error] Use either --notes or --notes-file, not both.")
    if path:
        if not path.exists():
            raise SystemExit(f"[error] Notes file not found: {path}")
        return path.read_text(encoding="utf-8").strip()
    if arg_value:
        return arg_value.strip()
    raise SystemExit("[error] Provide release notes via --notes or --notes-file.")


def normalize_rfc3339(value: Optional[str]) -> str:
    if value:
        candidate = value.strip()
        try:
            parsed = dt.datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError as exc:
            raise SystemExit(f"[error] Invalid --pub-date '{value}': {exc}") from exc
        normalized = parsed.astimezone(dt.timezone.utc)
    else:
        normalized = dt.datetime.now(dt.timezone.utc)
    iso = normalized.isoformat(timespec="milliseconds")
    if iso.endswith("+00:00"):
        iso = iso[:-6] + "Z"
    return iso


def update_package_json(path: Path, new_version: str) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    old_version = data.get("version")
    data["version"] = new_version
    write_json(path, data, indent=4)
    return old_version


def update_tauri_conf(path: Path, new_version: str) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    old_version = data.get("version")
    data["version"] = new_version
    write_json(path, data, indent=2)
    return old_version


def write_json(path: Path, data: dict, indent: int) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=indent)
    path.write_text(text + "\n", encoding="utf-8")


def update_cargo_toml(path: Path, new_version: str) -> str:
    content = path.read_text(encoding="utf-8")
    pattern = re.compile(r'^(version\s*=\s*)"([^"]+)"', re.MULTILINE)
    match = pattern.search(content)
    if not match:
        raise SystemExit("[error] Could not locate the package version entry inside Cargo.toml")
    old_version = match.group(2)
    new_content = pattern.sub(rf'\1"{new_version}"', content, count=1)
    path.write_text(new_content, encoding="utf-8")
    return old_version


def run_build(root: Path) -> None:
    npm_exec = shutil.which("npm") or shutil.which("npm.cmd") or shutil.which("npm.exe")
    if not npm_exec:
        raise SystemExit("[error] Could not find `npm` executable. Ensure Node.js/npm is installed and on PATH.")

    print("[info] Running `npm run tauri build` ...")
    subprocess.run(
        [npm_exec, "run", "tauri", "build"],
        cwd=root,
        check=True,
    )


def resolve_msi_path(
    root: Path,
    desired_version: str,
    explicit: Optional[Path],
    bundle_dir: Path,
) -> Path:
    if explicit:
        candidate = explicit if explicit.is_absolute() else (root / explicit)
        if not candidate.exists():
            raise SystemExit(f"[error] Provided MSI path does not exist: {candidate}")
        return candidate

    search_dir = bundle_dir if bundle_dir.is_absolute() else (root / bundle_dir)
    if not search_dir.exists():
        raise SystemExit(f"[error] Bundle directory not found: {search_dir}")

    matches = sorted(search_dir.glob(f"*{desired_version}*.msi"))
    if not matches:
        raise SystemExit(
            f"[error] Could not find an MSI that contains '{desired_version}' inside {search_dir}"
        )
    if len(matches) > 1:
        print("[warn] Multiple MSI files matched; using the first one.")
    return matches[0]


def read_signature(msi_path: Path) -> str:
    sig_path = msi_path.parent / f"{msi_path.name}.sig"
    if not sig_path.exists():
        raise SystemExit(f"[error] Missing signature file: {sig_path}")
    return sig_path.read_text(encoding="utf-8").strip()


def update_latest_json(
    path: Path,
    version: str,
    notes: str,
    pub_date: str,
    signature: str,
    artifact_name: str,
    repo_download_url: Optional[str],
) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    previous_version = data.get("version")
    data["version"] = version
    data["notes"] = notes
    data["pub_date"] = pub_date

    platforms = data.setdefault("platforms", {})
    win = platforms.setdefault("windows-x86_64", {})
    win["signature"] = signature
    win["url"] = build_download_url(
        current_url=win.get("url", ""),
        previous_version=previous_version,
        version=version,
        artifact_name=artifact_name,
        repo_download_url=repo_download_url,
    )

    write_json(path, data, indent=4)


def build_download_url(
    current_url: str,
    previous_version: Optional[str],
    version: str,
    artifact_name: str,
    repo_download_url: Optional[str],
) -> str:
    # GitHub release 태그 형식에 맞춰 v를 붙임
    tag_version = f"v{version}"
    
    # repo_download_url이 명시적으로 제공되면 사용
    if repo_download_url:
        base = repo_download_url.rstrip("/")
        return f"{base}/{tag_version}/{artifact_name}"

    # current_url에서 GitHub releases URL 패턴 추출
    # 예: https://github.com/banatic/Hypercool/releases/download/v0.2.2/HyperCool_0.2.2_x64_en-US.msi
    if current_url and "github.com" in current_url and "/releases/download/" in current_url:
        # GitHub releases URL 패턴에서 base URL 추출
        # https://github.com/banatic/Hypercool/releases/download 까지 추출
        parts = current_url.split("/releases/download/")
        if len(parts) == 2:
            base_url = parts[0] + "/releases/download"
            # 새 버전과 artifact_name으로 완전히 새 URL 구성
            return f"{base_url}/{tag_version}/{artifact_name}"
    
    # 기본값: GitHub releases URL 구성 (banatic/Hypercool 기준)
    return f"https://github.com/banatic/Hypercool/releases/download/{tag_version}/{artifact_name}"


def get_git_remote_url(root: Path) -> Optional[str]:
    """Get the GitHub repository URL from git remote."""
    git_exec = shutil.which("git") or shutil.which("git.exe")
    if not git_exec:
        return None
    
    try:
        result = subprocess.run(
            [git_exec, "remote", "get-url", "origin"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        )
        url = result.stdout.strip()
        # Convert SSH URL to HTTPS if needed
        if url.startswith("git@github.com:"):
            url = url.replace("git@github.com:", "https://github.com/").replace(".git", "")
        elif url.endswith(".git"):
            url = url[:-4]
        return url
    except subprocess.CalledProcessError:
        return None


def check_gh_cli() -> bool:
    """Check if GitHub CLI is installed and authenticated."""
    gh_exec = shutil.which("gh") or shutil.which("gh.exe")
    if not gh_exec:
        return False
    
    try:
        # Check if authenticated
        subprocess.run(
            [gh_exec, "auth", "status"],
            capture_output=True,
            check=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def create_github_release(
    root: Path,
    version: str,
    notes: str,
    msi_path: Path,
    sig_path: Optional[Path] = None,
) -> None:
    """Create a GitHub release with tag and upload MSI file."""
    gh_exec = shutil.which("gh") or shutil.which("gh.exe")
    if not gh_exec:
        raise SystemExit("[error] GitHub CLI (gh) not found. Install it from https://cli.github.com/")
    
    if not check_gh_cli():
        raise SystemExit("[error] GitHub CLI not authenticated. Run `gh auth login` first.")
    
    tag = f"v{version}"
    title = f"Release {tag}"
    
    print(f"[info] Creating GitHub release {tag}...")
    
    # Prepare files to upload
    files_to_upload = [str(msi_path)]
    if sig_path and sig_path.exists():
        files_to_upload.append(str(sig_path))
    
    # Create release with files
    cmd = [
        gh_exec,
        "release",
        "create",
        tag,
        "--title", title,
        "--notes", notes,
    ] + files_to_upload
    
    try:
        subprocess.run(cmd, cwd=root, check=True)
        print(f"[info] GitHub release {tag} created successfully.")
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[error] Failed to create GitHub release: {exc}")


def git_add_commit_push(root: Path, version: str, latest_path: Path) -> None:
    """Add latest.json, commit, and push to git."""
    git_exec = shutil.which("git") or shutil.which("git.exe")
    if not git_exec:
        raise SystemExit("[error] Git not found. Ensure Git is installed and on PATH.")
    
    # Check if there are changes
    try:
        status_result = subprocess.run(
            [git_exec, "status", "--porcelain", str(latest_path)],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        )
        if not status_result.stdout.strip():
            print("[info] No changes to latest.json, skipping git operations.")
            return
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[error] Failed to check git status: {exc}")
    
    print("[info] Staging latest.json...")
    try:
        subprocess.run(
            [git_exec, "add", str(latest_path)],
            cwd=root,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[error] Failed to git add latest.json: {exc}")
    
    print("[info] Committing changes...")
    commit_message = f"Update latest.json for version {version}"
    try:
        subprocess.run(
            [git_exec, "commit", "-m", commit_message],
            cwd=root,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[error] Failed to git commit: {exc}")
    
    print("[info] Pushing to remote...")
    try:
        subprocess.run(
            [git_exec, "push"],
            cwd=root,
            check=True,
        )
        print("[info] Successfully pushed latest.json to remote.")
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[error] Failed to git push: {exc}")


def run_release(config: ReleaseConfig) -> int:
    root = Path(__file__).resolve().parents[1]
    version = ensure_semver(config.version)
    notes = config.notes.strip()
    if not notes:
        raise SystemExit("[error] Release notes (config.notes) must not be empty.")
    pub_date = normalize_rfc3339(config.pub_date)

    package_path = root / "package.json"
    cargo_path = root / "src-tauri" / "Cargo.toml"
    tauri_conf_path = root / "src-tauri" / "tauri.conf.json"
    latest_path = (
        config.latest_path
        if config.latest_path.is_absolute()
        else root / config.latest_path
    )

    print("[info] Updating package.json, Cargo.toml, and tauri.conf.json ...")
    old_package_version = update_package_json(package_path, version)
    old_cargo_version = update_cargo_toml(cargo_path, version)
    old_tauri_version = update_tauri_conf(tauri_conf_path, version)
    print(
        f"[info] Versions bumped from "
        f"{old_package_version}/{old_cargo_version}/{old_tauri_version} to {version}"
    )

    if not config.skip_build:
        run_build(root)
    else:
        print("[info] Skipping build step as requested.")

    msi_path = resolve_msi_path(root, version, config.msi_path, config.bundle_dir)
    signature = read_signature(msi_path)
    update_latest_json(
        latest_path,
        version=version,
        notes=notes,
        pub_date=pub_date,
        signature=signature,
        artifact_name=msi_path.name,
        repo_download_url=config.repo_download_url,
    )

    # Create GitHub release with tag and upload MSI
    if not config.skip_github_release:
        sig_path = msi_path.parent / f"{msi_path.name}.sig"
        create_github_release(
            root=root,
            version=version,
            notes=notes,
            msi_path=msi_path,
            sig_path=sig_path if sig_path.exists() else None,
        )
    else:
        print("[info] Skipping GitHub release creation as requested.")

    # Git add, commit, and push latest.json
    if not config.skip_git_push:
        git_add_commit_push(root=root, version=version, latest_path=latest_path)
    else:
        print("[info] Skipping git push as requested.")

    print("\nAll done ✅")
    print(f"- MSI: {msi_path}")
    if not config.skip_github_release:
        print(f"- GitHub release v{version} created with MSI uploaded.")
    if not config.skip_git_push:
        print(f"- latest.json committed and pushed to remote.")
    else:
        print(f"- latest.json updated (not pushed).")
    return 0


def main() -> int:
    args = parse_args()
    config = config_from_args(args)
    return run_release(config)


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        raise SystemExit("[error] Python 3.10 or newer is required.")

    # CLI 사용 예시:
    #   python scripts/release_method.py 0.1.5 --notes "릴리스 노트" --pub-date 2025-11-15T09:00:00Z
    USE_CLI = False

    if USE_CLI:
        raise SystemExit(main())

    CONFIG = ReleaseConfig(
        version="0.4.3",
        notes="버그수정 : 학교위젯 버그 수정",
        pub_date=None,  # None 이면 현재 UTC 시간이 사용됩니다.
        skip_build=False,
        msi_path=None,
        bundle_dir=Path("src-tauri/target/release/bundle/msi"),
        latest_path=Path("latest.json"),
        repo_download_url=None,
        skip_github_release=False,  # GitHub release 자동 생성
        skip_git_push=False,  # git push 자동 실행
    )

    raise SystemExit(run_release(CONFIG))
