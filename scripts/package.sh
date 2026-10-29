#!/usr/bin/env bash
# Build Terrarium.app (UI + backend + bundled Node), ad-hoc sign it, and install it to ~/Applications.
#
#   scripts/package.sh              build and install
#   scripts/package.sh --no-install build only (src-tauri/target/release/bundle/macos/Terrarium.app)
#
# Bundle layout (paths mirror the repo, so the backend's repo-relative lookups keep working):
#   Contents/MacOS/terrarium                         Tauri shell
#   Contents/MacOS/node                              official Node binary (keeps the Node.js signature)
#   Contents/Resources/app/apps/backend/dist         compiled backend
#   Contents/Resources/app/apps/backend/scripts      omlx_serve.py
#   Contents/Resources/app/apps/backend/node_modules prod deps, hoisted (krun runner, libkrun, python.wasm)
#   Contents/Resources/app/evals                     eval suites, cases, references
#   Contents/Resources/app/guest/files/.../terrarium guest helpers, pushed into envs whose image has older ones
set -euo pipefail

NODE_VERSION=24.22.2
NODE_SHA256=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a # node-v24.22.2-darwin-arm64.tar.gz, SHASUMS256.txt

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/src-tauri/target/package"
APP="$ROOT/src-tauri/target/release/bundle/macos/Terrarium.app"
DEST="$HOME/Applications/Terrarium.app"
RUNNER_REL="Contents/Resources/app/apps/backend/node_modules/@earendil-works/gondolin-krun-runner-darwin-arm64/bin/gondolin-krun-runner"
INSTALL=1
[[ "${1:-}" == "--no-install" ]] && INSTALL=0

step() { printf '\n== %s\n' "$*"; }
cd "$ROOT"
mkdir -p "$WORK/cache"

step "Node $NODE_VERSION"
NODE_TGZ="$WORK/cache/node-v$NODE_VERSION-darwin-arm64.tar.gz"
if [[ ! -f "$NODE_TGZ" ]]; then
  curl -fsSL --proto '=https' --tlsv1.2 -o "$NODE_TGZ.part" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  mv "$NODE_TGZ.part" "$NODE_TGZ"
fi
echo "$NODE_SHA256  $NODE_TGZ" | shasum -a 256 -c -
rm -rf "$WORK/node"
mkdir -p "$WORK/node"
tar -xzf "$NODE_TGZ" -C "$WORK/node" --strip-components 2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
"$WORK/node/node" --version

step "UI build"
pnpm --filter @terrarium/ui build

step "Backend build"
pnpm --filter @terrarium/backend build

step "Backend prod deps"
rm -rf "$WORK/deploy" "$WORK/stage"
pnpm --filter @terrarium/backend deploy --prod --config.node-linker=hoisted "$WORK/deploy" >/dev/null
STAGE="$WORK/stage/app"
mkdir -p "$STAGE/apps/backend" "$STAGE/evals" "$STAGE/guest/files/usr/local/libexec"
cp "$WORK/deploy/package.json" "$STAGE/apps/backend/"
rsync -a "$ROOT/apps/backend/dist" "$ROOT/apps/backend/scripts" "$STAGE/apps/backend/"
rsync -a --exclude .pnpm --exclude .bin --exclude .modules.yaml "$WORK/deploy/node_modules" "$STAGE/apps/backend/"
rsync -a "$ROOT/evals/suites" "$ROOT/evals/cases" "$ROOT/evals/reference" "$ROOT/evals/datasets.json" "$STAGE/evals/"
rsync -a --exclude __pycache__ "$ROOT/guest/files/usr/local/libexec/terrarium" "$STAGE/guest/files/usr/local/libexec/"
[[ -f "$STAGE/guest/files/usr/local/libexec/terrarium/setup" ]] || { echo "missing in stage: guest helpers" >&2; exit 1; }
for f in node_modules/just-bash/vendor/cpython-emscripten/python.wasm "${RUNNER_REL#Contents/Resources/app/apps/backend/}" \
  node_modules/@earendil-works/gondolin-krun-runner-darwin-arm64/lib/libkrun.1.dylib; do
  [[ -f "$STAGE/apps/backend/$f" ]] || { echo "missing in stage: $f" >&2; exit 1; }
done
if grep -rqE "from ['\"]@terrarium/shared['\"]" "$STAGE/apps/backend/dist"; then
  echo "dist imports @terrarium/shared at runtime (it ships .ts only)" >&2
  exit 1
fi

step "Tauri build"
pnpm tauri build --bundles app --config '{"build":{"beforeBuildCommand":""}}' 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading) ' || true
[[ -x "$APP/Contents/MacOS/terrarium" ]] || { echo "tauri build failed" >&2; exit 1; }

step "Assemble bundle"
ditto "$WORK/node/node" "$APP/Contents/MacOS/node"
rm -rf "$APP/Contents/Resources/app"
ditto "$STAGE" "$APP/Contents/Resources/app"

step "Sign"
# The krun runner needs com.apple.security.hypervisor. Copying keeps its signature; re-sign only if lost.
if ! codesign -d --entitlements - "$APP/$RUNNER_REL" 2>/dev/null | grep -q com.apple.security.hypervisor; then
  echo "re-signing krun runner with the hypervisor entitlement"
  codesign --force --sign - --entitlements "$ROOT/src-tauri/runner.entitlements" "$APP/$RUNNER_REL"
fi
# Outer seal only (no --deep): node keeps the Node.js Developer ID signature, the runner keeps its own.
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
codesign -d --entitlements - "$APP/$RUNNER_REL" 2>/dev/null | grep -q com.apple.security.hypervisor
codesign --verify "$APP/Contents/MacOS/node"
echo "signature ok; runner has com.apple.security.hypervisor"
du -sh "$APP"

if [[ $INSTALL == 1 ]]; then
  step "Install to $DEST"
  if pgrep -f "$DEST/Contents/MacOS/terrarium" >/dev/null; then
    echo "Terrarium is running; quit it first (Cmd+Q) and re-run" >&2
    exit 1
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "installed $DEST"
fi
