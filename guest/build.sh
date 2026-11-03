#!/bin/sh
# Build the Terrarium guest image (Gondolin 0.14, Alpine). `gondolin build` imports every build into its
# image store, which is $TERRARIUM_DATA/images, so the image ends up in images/objects/<buildId>/ and the
# id is recorded in images/current. Existing image dirs are never modified: env disks are qcow2
# overlays backed by their image's rootfs.ext4.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
data=${TERRARIUM_DATA:-$repo/data}
# The CLI itself, not the .bin shim: the packaged app ships no .bin, and the backend puts its own node first on PATH.
cli="$repo/apps/backend/node_modules/@earendil-works/gondolin/dist/bin/gondolin.js"
[ -f "$cli" ] || { echo "missing $cli (run pnpm install)" >&2; exit 1; }
command -v node > /dev/null || { echo "missing node" >&2; exit 1; }
gondolin() { node "$cli" "$@"; }
for tool in lz4 cpio qemu-img; do
  command -v "$tool" > /dev/null || { echo "missing $tool (brew install lz4 e2fsprogs qemu)" >&2; exit 1; }
done
[ -x /opt/homebrew/opt/e2fsprogs/sbin/mke2fs ] || command -v mke2fs > /dev/null ||
  { echo "missing mke2fs (brew install lz4 e2fsprogs qemu)" >&2; exit 1; }

# No restrictive umask here: package extraction honours it and guest files would become root-only.
# The parent dirs are 0700 instead.
mkdir -p "$data/images" "$data/gondolin/cache" "$data/gondolin/sessions"
chmod 0700 "$data/images" "$data/gondolin" "$data/gondolin/cache" "$data/gondolin/sessions"
# Keep every Gondolin cache (Alpine packages, sandbox helpers, krunfw) out of ~/.cache.
export XDG_CACHE_HOME="$data/gondolin/cache"
export GONDOLIN_IMAGE_STORE="$data/images"
export GONDOLIN_SESSIONS_DIR="$data/gondolin/sessions"

# A failed or timed-out build leaves its output behind; the app runs one build at a time.
rm -rf "$data/images"/.build-*
out="$data/images/.build-$$"
start=$(date +%s)
gondolin build --config "$here/terrarium-guest.json" --output "$out"
gondolin build --verify "$out"
id=$(sed -n 's/^  "buildId": "\([0-9a-f-]*\)",*$/\1/p' "$out/manifest.json")
[ -n "$id" ] || { echo "no buildId in $out/manifest.json" >&2; exit 1; }
dest="$data/images/objects/$id"
[ -f "$dest/manifest.json" ] || { echo "build was not imported into $dest" >&2; exit 1; }
gondolin build --verify "$dest"
rm -r "$out"
printf '%s\n' "$id" > "$data/images/current"
echo "built $id in $(( $(date +%s) - start ))s: $dest"
du -sh "$dest/rootfs.ext4" "$dest"
