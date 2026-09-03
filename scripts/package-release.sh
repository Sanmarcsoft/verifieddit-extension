#!/usr/bin/env bash
# Package the production Chrome extension as a CWS-uploadable zip.
#
# Output:  releases/release_v1.0.0.zip
#
# What goes IN:  dist/chrome/* (the rollup build output — manifest, JS, HTML,
#                CSS, icons, WASM, JSON). Source is bundled INTO dist/chrome at
#                build time; the .ts files are NOT copied — they are compiled.
# What stays OUT: .git, node_modules, src/, test/, scripts/, *.md (including
#                WEBSTORE_LISTING.md), *.map, *.lock, eslint/postcss/tailwind
#                configs, infra/, public/ (already copied into dist by rollup),
#                anything outside dist/chrome.
#
# Usage:
#   bash scripts/package-release.sh                # default version from package.json
#   VERSION=1.0.1 bash scripts/package-release.sh  # override
#
# Per workspace rule, bun is the package manager; this script invokes
# `bun run build` rather than `npm run build`. Falls back to python3
# zipfile if /usr/bin/zip is unavailable on the build host.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Determine version from package.json (or VERSION env override).
# Use Python for the JSON parse — portable across GNU/BSD sed quirks (mac sed
# does not honor \s, which broke an earlier shell-only attempt).
if [ -z "${VERSION:-}" ]; then
  VERSION="$(python3 -c 'import json,sys; print(json.load(open("package.json"))["version"])')"
fi
ZIP_NAME="release_v${VERSION}.zip"
OUT_DIR="${ROOT}/releases"
OUT_ZIP="${OUT_DIR}/${ZIP_NAME}"

echo "[package] Repo:    ${ROOT}"
echo "[package] Version: ${VERSION}"
echo "[package] Target:  ${OUT_ZIP}"
echo ""

# Step 1: build (rollup -> dist/chrome). Idempotent.
echo "[package] Step 1/4 — build (bun run clean && bun run build)"
bun run clean
bun run build

# Step 2: hard sanity — refuse to ship if forbidden artifacts are anywhere in dist/.
echo ""
echo "[package] Step 2/4 — pre-zip safety check (refuse to package if forbidden files present)"
# .map files, source .ts, .gitignore, node_modules, .git, raw .md (WEBSTORE_LISTING.md, README.md, etc.)
forbidden=$(/usr/bin/find dist/chrome \( \
    -name '*.map' \
    -o -name '*.ts' \
    -o -name '*.tsx' \
    -o -name '.git' \
    -o -name 'node_modules' \
    -o -name '*.md' \
    -o -name '.gitignore' \
    -o -name '.env*' \
  \) -print 2>/dev/null | head -5 || true)
if [ -n "$forbidden" ]; then
  echo "  ERROR: forbidden artifacts found in dist/chrome:"
  echo "$forbidden"
  echo "  Refusing to package. Fix the build pipeline."
  exit 2
fi
echo "  OK: dist/chrome contains only shipping artifacts."

# Step 3: pack the zip. Prefer /usr/bin/zip; fall back to python3 zipfile if missing.
echo ""
echo "[package] Step 3/4 — pack the zip"
mkdir -p "${OUT_DIR}"
rm -f "${OUT_ZIP}"

if command -v zip >/dev/null 2>&1; then
  (cd dist/chrome && /usr/bin/zip -r -q "${OUT_ZIP}" . -x '*.map' -x '*.ts')
  echo "  OK: packed via zip"
else
  echo "  zip(1) unavailable, falling back to python3 zipfile"
  python3 - "${OUT_ZIP}" <<'PYEOF'
import os, sys, zipfile
out = sys.argv[1]
src = 'dist/chrome'
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            if f.endswith('.map') or f.endswith('.ts') or f.endswith('.tsx'):
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
            n += 1
print(f'  OK: packed via python3 ({n} files)')
PYEOF
fi

# Step 4: verification — print file count, size, SHA-256, manifest summary.
echo ""
echo "[package] Step 4/4 — verify"
python3 - "${OUT_ZIP}" <<'PYEOF'
import sys, zipfile, hashlib, json
out = sys.argv[1]
size = __import__('os').path.getsize(out)
with open(out, 'rb') as f: sha = hashlib.sha256(f.read()).hexdigest()
with zipfile.ZipFile(out) as z:
    names = sorted(z.namelist())
    m = json.loads(z.read('manifest.json'))
print(f'  artifact:   {out}')
print(f'  size:       {size:,} bytes  ({size/1024/1024:.2f} MB)')
print(f'  files:      {len(names)}')
print(f'  sha256:     {sha}')
print(f'')
print(f'  manifest.json:')
print(f'    name:                   {m["name"]}')
print(f'    version:                {m["version"]}')
print(f'    minimum_chrome_version: {m.get("minimum_chrome_version", "(not set)")}')
print(f'    permissions ({len(m["permissions"])}):       {m["permissions"]}')
print(f'    host_permissions:       {m["host_permissions"]}')
print(f'    web_accessible_resources: {m["web_accessible_resources"][0]["resources"]}')
print(f'')
print(f'  forbidden patterns inside zip: ', end='')
bad = [n for n in names if n.endswith('.map') or n.endswith('.ts') or n.endswith('.md') or n == '.git' or n.startswith('node_modules/') or n == 'WEBSTORE_LISTING.md']
print(f'{len(bad)}  (expect 0)' + (f' — {bad}' if bad else ''))
PYEOF

echo ""
echo "[package] DONE."
