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
    if repo_download_url:
        base = repo_download_url.rstrip("/")
        return f"{base}/{version}/{artifact_name}"

    if current_url and previous_version:
        if previous_version in current_url:
            return current_url.replace(previous_version, version)
    return current_url or artifact_name


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

    print("\nAll done ✅")
    print(f"- MSI: {msi_path}")
    print("- Upload the MSI (and .sig if needed) when creating the GitHub release.")
    print(f"- latest.json updated with signature and download URL for version {version}.")
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
        version="0.1.5",
        notes="테스트 릴리즈",
        pub_date=None,  # None 이면 현재 UTC 시간이 사용됩니다.
        skip_build=False,
        msi_path=None,
        bundle_dir=Path("src-tauri/target/release/bundle/msi"),
        latest_path=Path("latest.json"),
        repo_download_url=None,
    )

    raise SystemExit(run_release(CONFIG))
