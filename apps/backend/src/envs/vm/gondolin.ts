// Gondolin loading and app-owned state dirs. Gondolin reads GONDOLIN_SESSIONS_DIR when its module is
// first evaluated, so the env vars are set here and the SDK is only ever loaded through `gondolin()`.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type GondolinModule = typeof import("@earendil-works/gondolin");

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

export function dataDir(): string {
  return path.resolve(process.env.TERRARIUM_DATA ?? path.join(repoRoot, "data"));
}

export const imagesDir = (): string => path.join(dataDir(), "images");
const sessionsDir = (): string => path.join(dataDir(), "gondolin", "sessions");

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

let loading: Promise<GondolinModule> | null = null;

export function gondolin(): Promise<GondolinModule> {
  if (!loading) {
    ensurePrivateDir(path.join(dataDir(), "gondolin"));
    ensurePrivateDir(sessionsDir());
    ensurePrivateDir(imagesDir());
    process.env.GONDOLIN_SESSIONS_DIR = sessionsDir();
    process.env.GONDOLIN_IMAGE_STORE = imagesDir();
    loading = import("@earendil-works/gondolin");
  }
  return loading;
}

const require = createRequire(import.meta.url);

export const GONDOLIN_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(require.resolve("@earendil-works/gondolin")), "../../package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

export interface ImageInfo {
  id: string; // manifest buildId
  dir: string;
  rootfsBytes: number;
  alpineVersion?: string;
  builtAt?: string;
  hasKrun: boolean;
}

/** Image recorded in data/images/current (written by guest/build.sh), or a specific build id. */
export function resolveImage(id?: string): ImageInfo | null {
  let buildId = id;
  if (!buildId) {
    try {
      buildId = fs.readFileSync(path.join(imagesDir(), "current"), "utf8").trim();
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-f-]{36}$/.test(buildId)) return null;
  const dir = path.join(imagesDir(), "objects", buildId);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (manifest.buildId !== buildId) return null;
    const rootfs = path.join(dir, manifest.assets?.rootfs ?? "rootfs.ext4");
    return {
      id: buildId,
      dir,
      rootfsBytes: fs.statSync(rootfs).size,
      alpineVersion: manifest.config?.alpine?.version,
      builtAt: manifest.buildTime,
      hasKrun: Boolean(manifest.assets?.krunKernel),
    };
  } catch {
    return null;
  }
}

export function rootfsPath(image: ImageInfo): string {
  return path.join(image.dir, "rootfs.ext4");
}

const QEMU_CANDIDATES = ["/opt/homebrew/bin/qemu-system-aarch64", "/usr/local/bin/qemu-system-aarch64"];
const QEMU_IMG_CANDIDATES = ["/opt/homebrew/bin/qemu-img", "/usr/local/bin/qemu-img"];

export const qemuPath = (): string | null => QEMU_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
export const qemuImgPath = (): string | null => QEMU_IMG_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;

export function krunRunnerPresent(): boolean {
  try {
    require.resolve("@earendil-works/gondolin-krun-runner-darwin-arm64/package.json", {
      paths: [path.dirname(require.resolve("@earendil-works/gondolin"))],
    });
    return true;
  } catch {
    return false;
  }
}
