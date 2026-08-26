#!/usr/bin/env bash
# Usage: scripts/version-bump.sh <major.minor.patch>
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version="${1:?Usage: scripts/version-bump.sh <major.minor.patch>}"

npm run version:set -- "$version"
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to ${version}"
git push
