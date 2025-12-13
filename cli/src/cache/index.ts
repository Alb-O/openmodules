import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Re-export from submodules
export {
  urlToCachePath,
  isCached,
  ensureCached,
  cloneFromCache,
  submoduleAddFromCache,
  listCachedRepos,
  removeRepoFromCache,
  clearRepoCache,
} from "./repos";

export { getBundledPluginPath, installPlugin } from "./plugins";

/**
 * Get the base cache directory.
 * Uses $XDG_CACHE_HOME/openmodules or ~/.cache/openmodules
 */
export function getCacheDir(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  return xdgCacheHome
    ? path.join(xdgCacheHome, "openmodules")
    : path.join(os.homedir(), ".cache", "openmodules");
}

/**
 * Format bytes as human readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Get directory size in bytes.
 */
export function getDirSize(dir: string): number {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

/**
 * Clear the entire cache (repos and plugins).
 */
export function clearAllCache(): void {
  const cacheDir = getCacheDir();
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}
