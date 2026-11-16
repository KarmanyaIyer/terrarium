#!/usr/bin/env bash
# Build Terrarium.app (UI + backend + bundled Node and Python), ad-hoc sign it, and install it to ~/Applications.
#
#   scripts/package.sh              build and install
#   scripts/package.sh --no-install build only (src-tauri/target/release/bundle/macos/Terrarium.app)
#
# The app carries no build-machine paths. It keeps data and models in ~/Library/Application Support/Terrarium
# unless config.json there says otherwise; installing writes one pointing at this repo's data/, models/ and .venv.
#
# Bundle layout (paths mirror the repo, so the backend's repo-relative lookups keep working):
#   Contents/MacOS/terrarium                         Tauri shell
#   Contents/MacOS/node                              official Node binary (keeps the Node.js signature)
#   Contents/Resources/app/apps/backend/dist         compiled backend
#   Contents/Resources/app/apps/backend/scripts      omlx_serve.py
#   Contents/Resources/app/apps/backend/node_modules prod deps, hoisted (krun runner, libkrun, python.wasm)
#   Contents/Resources/app/python                    standalone CPython with oMLX (scripts/python-requirements.txt)
#   Contents/Resources/app/evals                     eval suites, cases, references
#   Contents/Resources/app/guest/files/.../terrarium guest helpers, pushed into envs whose image has older ones
set -euo pipefail

NODE_VERSION=24.22.2
NODE_SHA256=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a # node-v24.22.2-darwin-arm64.tar.gz, SHASUMS256.txt
PY_BUILD=cpython-3.13.16+20261009-aarch64-apple-darwin-install_only_stripped.tar.gz # python-build-standalone
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261009/${PY_BUILD/+/%2B}"
PY_SHA256=11785155d0f70e634178219c20925d8f20be00a3da4684fc4f5019dd15602ef7 # its SHA256SUMS
OMLX_WHEEL=omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl
OMLX_SHA256=d8f19f04ce23f7814a8b8c0264c84452e209f3d5a8e513fca9a74b176bb17982 # GitHub's asset digest, apps/backend/README.md

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/src-tauri/target/package"
APP="$ROOT/src-tauri/target/release/bundle/macos/Terrarium.app"
DEST="$HOME/Applications/Terrarium.app"
RUNNER_REL="Contents/Resources/app/apps/backend/node_modules/@earendil-works/gondolin-krun-runner-darwin-arm64/bin/gondolin-krun-runner"
INSTALL=1
[[ "${1:-}" == "--no-install" ]] && INSTALL=0

step() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 file
  if [[ ! -f "$3" ]]; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$3.part" "$1"
    mv "$3.part" "$3"
  fi
  echo "$2  $3" | shasum -a 256 -c -
}
cd "$ROOT"
mkdir -p "$WORK/cache"
command -v uv >/dev/null || { echo "missing uv (brew install uv)" >&2; exit 1; }

step "Node $NODE_VERSION"
NODE_TGZ="$WORK/cache/node-v$NODE_VERSION-darwin-arm64.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" "$NODE_SHA256" "$NODE_TGZ"
rm -rf "$WORK/node"
mkdir -p "$WORK/node"
tar -xzf "$NODE_TGZ" -C "$WORK/node" --strip-components 2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
"$WORK/node/node" --version

step "Python with oMLX"
fetch "$PY_URL" "$PY_SHA256" "$WORK/cache/$PY_BUILD"
fetch "https://github.com/jundot/omlx/releases/download/v0.7.2/$OMLX_WHEEL" "$OMLX_SHA256" "$WORK/cache/$OMLX_WHEEL"
PYDIR="$WORK/python"
rm -rf "$PYDIR"
tar -xzf "$WORK/cache/$PY_BUILD" -C "$WORK"
# --no-deps: exactly the pinned set, nothing resolved at build time; pip check confirms it is complete.
uv pip install -q --python "$PYDIR/bin/python3" --no-deps -r scripts/python-requirements.txt "$WORK/cache/$OMLX_WHEEL"
uv pip check --python "$PYDIR/bin/python3"
# Vendored mlx-lm models go in now (inference/vendor.ts would otherwise write into the signed bundle).
for f in apps/backend/scripts/vendor/mlx_lm_models/*.py; do
  dest="$PYDIR/lib/python3.13/site-packages/mlx_lm/models/$(basename "$f")"
  if [[ ! -f "$dest" ]] || head -1 "$dest" | grep -q '^# Vendored by Terrarium'; then cp "$f" "$dest"; fi
done
# The backend needs only bin/python and bin/omlx; the console scripts carry this machine's path in their shebang.
find "$PYDIR/bin" -mindepth 1 ! -name 'python*' -delete
rm -f "$PYDIR"/bin/python*-config "$PYDIR"/lib/python3.13/site-packages/*.dist-info/direct_url.json
cat > "$PYDIR/bin/omlx" <<'SH'
#!/bin/sh
exec "$(dirname "$0")/python3" -I -c 'import sys; from omlx.cli import main; sys.argv[0] = "omlx"; sys.exit(main())' "$@"
SH
chmod 755 "$PYDIR/bin/omlx"
"$PYDIR/bin/python3" -I -c 'import omlx, mlx_lm, mlx_vlm, mlx.core; print("omlx", omlx.__version__)'

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
rsync -a --exclude __pycache__ "$ROOT/apps/backend/dist" "$ROOT/apps/backend/scripts" "$STAGE/apps/backend/"
rsync -a --exclude .pnpm --exclude .bin --exclude .modules.yaml --exclude .pnpm-workspace-state-v1.json \
  "$WORK/deploy/node_modules" "$STAGE/apps/backend/"
# Workspace deps are build-time only (checked below) and their file: specs carry this machine's path.
"$WORK/node/node" -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));for(const k of Object.keys(p.dependencies??{}))if(k.startsWith("@terrarium/"))delete p.dependencies[k];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$STAGE/apps/backend/package.json"
rsync -a "$ROOT/evals/suites" "$ROOT/evals/cases" "$ROOT/evals/reference" "$ROOT/evals/datasets.json" "$STAGE/evals/"
rsync -a --exclude __pycache__ "$ROOT/guest/files/usr/local/libexec/terrarium" "$STAGE/guest/files/usr/local/libexec/"
# A fresh install builds its VM image from these; build.sh runs from inside the bundle and writes only to the data dir.
rsync -a "$ROOT/guest/build.sh" "$ROOT/guest/terrarium-guest.json" "$ROOT/guest/rootfs-init-extra.sh" "$STAGE/guest/"
for f in guest/files/usr/local/libexec/terrarium/setup guest/build.sh guest/terrarium-guest.json guest/rootfs-init-extra.sh apps/backend/node_modules/@earendil-works/gondolin/dist/bin/gondolin.js; do
  [[ -f "$STAGE/$f" ]] || { echo "missing in stage: $f" >&2; exit 1; }
done
for f in node_modules/just-bash/vendor/cpython-emscripten/python.wasm "${RUNNER_REL#Contents/Resources/app/apps/backend/}" \
  node_modules/@earendil-works/gondolin-krun-runner-darwin-arm64/lib/libkrun.1.dylib; do
  [[ -f "$STAGE/apps/backend/$f" ]] || { echo "missing in stage: $f" >&2; exit 1; }
done
if grep -rqE "from ['\"]@terrarium/shared['\"]" "$STAGE/apps/backend/dist"; then
  echo "dist imports @terrarium/shared at runtime (it ships .ts only)" >&2
  exit 1
fi
ditto "$PYDIR" "$STAGE/python"
# Bytecode now, checked by hash never by mtime, so Python never writes into the bundle. -s keeps paths out.
find "$STAGE" -name __pycache__ -type d -prune -exec rm -rf {} +
"$PYDIR/bin/python3" -I -m compileall -q -j 0 --invalidation-mode unchecked-hash -s "$STAGE" -p /Terrarium \
  "$STAGE/python/lib" "$STAGE/apps/backend/scripts" | { grep -v '^Listing' || true; }

step "Tauri build"
# Source paths in panic messages: map this machine's home and the repo away. -S: no debug map (object file paths).
export RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$ROOT=/terrarium -C link-arg=-Wl,-S ${RUSTFLAGS:-}"
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

step "Check for build-machine details"
if grep -rlaF -e "$HOME" -e "$ROOT" "$APP" | grep . ; then
  echo "the bundle names this machine's paths (above)" >&2
  exit 1
fi
echo "no $HOME paths in the bundle"

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
  # This checkout's data/, models/ and .venv, unless a config already says where they are.
  CONFIG="$HOME/Library/Application Support/Terrarium/config.json"
  if [[ ! -f "$CONFIG" ]]; then
    mkdir -p "$(dirname "$CONFIG")"
    "$WORK/node/node" -e 'const [f,r]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({dataDir:r+"/data",modelsDir:r+"/models",venvDir:r+"/.venv"},null,2)+"\n")' "$CONFIG" "$ROOT"
    echo "wrote $CONFIG"
  fi
  # The window's saved state (localStorage) from before the bundle identifier changed.
  OLD_WEBKIT="$HOME/Library/WebKit/dev.karvi.terrarium" NEW_WEBKIT="$HOME/Library/WebKit/io.github.karmanyaiyer.terrarium"
  if [[ -d "$OLD_WEBKIT" && ! -e "$NEW_WEBKIT" ]]; then ditto "$OLD_WEBKIT" "$NEW_WEBKIT"; fi
fi
