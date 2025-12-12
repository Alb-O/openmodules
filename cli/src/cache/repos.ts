import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { getCacheDir, formatBytes, getDirSize } from "./index";

/**
 * Convert a git URL to a cache path.
 * Uses a normalized URL structure: domain/owner/repo.git
 */
export function urlToCachePath(url: string): string {
  // Normalize URL to extract domain/owner/repo
  const match = url.match(/(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    // Fallback to hash-based path for unusual URLs
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    return path.join(getCacheDir(), "repos", "other", `${hash}.git`);
  }

  const [, domain, owner, repo] = match;
  return path.join(getCacheDir(), "repos", domain, owner, `${repo}.git`);
}

/**
 * Check if a repo is cached.
 */
export function isCached(url: string): boolean {
  const cachePath = urlToCachePath(url);
  return fs.existsSync(cachePath);
}

/**
 * Ensure a repo is in the cache, fetching if needed.
 * Returns the path to the cached bare repo.
 */
export function ensureCached(url: string, options?: { quiet?: boolean }): string {
  const cachePath = urlToCachePath(url);
  const quiet = options?.quiet ? { stdio: "pipe" as const } : { stdio: "inherit" as const };

  if (fs.existsSync(cachePath)) {
    // Update existing cache
    try {
      execSync(`git fetch --all --prune`, {
        cwd: cachePath,
        ...quiet,
      });
    } catch {
      // Fetch failed, but cache exists - continue anyway
    }
  } else {
    // Clone as bare repo into cache
    const parentDir = path.dirname(cachePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    execSync(`git clone --bare ${url} ${cachePath}`, quiet);
  }

  return cachePath;
}

/**
 * Clone from cache using --reference for object sharing.
 */
export function cloneFromCache(url: string, targetDir: string, options?: { quiet?: boolean }): void {
  const cachePath = ensureCached(url, options);
  const quiet = options?.quiet ? { stdio: "pipe" as const } : { stdio: "inherit" as const };

  execSync(`git clone --reference ${cachePath} ${url} ${targetDir}`, quiet);
}

/**
 * Add submodule using cache as reference.
 */
export function submoduleAddFromCache(
  url: string,
  relativePath: string,
  projectRoot: string,
  options?: { quiet?: boolean; force?: boolean }
): void {
  const cachePath = ensureCached(url, options);
  const quiet = options?.quiet ? { stdio: "pipe" as const } : { stdio: "inherit" as const };
  const forceFlag = options?.force ? "--force " : "";

  execSync(
    `git submodule add ${forceFlag}--reference ${cachePath} ${url} ${relativePath}`,
    {
      cwd: projectRoot,
      ...quiet,
    }
  );

  // Initialize the submodule
  try {
    execSync(`git submodule update --init ${relativePath}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // May fail if repo has unusual state, that's ok
  }
}

/**
 * List all cached repos.
 */
export function listCachedRepos(): Array<{ path: string; url: string; size: number }> {
  const reposDir = path.join(getCacheDir(), "repos");
  const results: Array<{ path: string; url: string; size: number }> = [];

  if (!fs.existsSync(reposDir)) {
    return results;
  }

  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".git")) {
          // This is a bare repo
          try {
            const url = execSync("git config --get remote.origin.url", {
              cwd: fullPath,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            const size = getDirSize(fullPath);
            results.push({ path: fullPath, url, size });
          } catch {
            // Not a valid git repo, skip
          }
        } else {
          walkDir(fullPath);
        }
      }
    }
  }

  walkDir(reposDir);
  return results;
}

/**
 * Remove a repo from cache.
 */
export function removeRepoFromCache(url: string): boolean {
  const cachePath = urlToCachePath(url);
  if (fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Clear all cached repos.
 */
export function clearRepoCache(): void {
  const reposDir = path.join(getCacheDir(), "repos");
  if (fs.existsSync(reposDir)) {
    fs.rmSync(reposDir, { recursive: true, force: true });
  }
}
