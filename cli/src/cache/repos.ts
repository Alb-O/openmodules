import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync, spawnSync } from "child_process";
import pc from "picocolors";
import { getCacheDir, getDirSize } from "./index";

/**
 * Run a git command and return stdout, or null if it fails.
 */
function git(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return (result.stdout as string).trim();
}

/**
 * Run a git command and return success/failure.
 */
function gitOk(args: string[], cwd: string): boolean {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0;
}

/**
 * Convert a git URL to a cache path.
 * Uses a normalized URL structure: domain/owner/repo.git
 */
export function urlToCachePath(url: string): string {
  // Normalize URL to extract domain/owner/repo
  const match = url.match(
    /(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (!match) {
    // Fallback to hash-based path for unusual URLs
    const hash = crypto
      .createHash("sha256")
      .update(url)
      .digest("hex")
      .slice(0, 16);
    console.warn(
      pc.yellow(
        `Warning: Non-standard URL format, using hash-based cache path for: ${url}`,
      ),
    );
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
 * Throws if fetch/clone fails with actionable error message.
 */
export function ensureCached(
  url: string,
  options?: { quiet?: boolean },
): string {
  const cachePath = urlToCachePath(url);
  const quiet = options?.quiet
    ? { stdio: "pipe" as const }
    : { stdio: "inherit" as const };

  if (fs.existsSync(cachePath)) {
    // Update existing cache
    try {
      execSync(`git fetch --all --prune`, {
        cwd: cachePath,
        ...quiet,
      });
    } catch (error) {
      // Fetch failed - warn but continue with stale cache
      const err = error as { stderr?: Buffer; message?: string };
      const errorMsg =
        err?.stderr?.toString() || err?.message || "Unknown error";
      console.warn(pc.yellow(`Warning: Failed to update cache for ${url}`));
      console.warn(pc.dim(`  ${errorMsg.trim()}`));
      console.warn(pc.dim("  Using potentially stale cached version"));
    }
  } else {
    // Clone as bare repo into cache
    const parentDir = path.dirname(cachePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    try {
      execSync(`git clone --bare ${url} ${cachePath}`, quiet);
    } catch (error) {
      const err = error as { stderr?: Buffer; message?: string };
      const errorMsg =
        err?.stderr?.toString() || err?.message || "Unknown error";
      throw new Error(
        `Failed to clone ${url} into cache:\n  ${errorMsg.trim()}`,
      );
    }
  }

  return cachePath;
}

/**
 * Clone from cache using --reference for object sharing.
 */
export function cloneFromCache(
  url: string,
  targetDir: string,
  options?: { quiet?: boolean },
): void {
  const cachePath = ensureCached(url, options);
  const quiet = options?.quiet
    ? { stdio: "pipe" as const }
    : { stdio: "inherit" as const };

  execSync(`git clone --reference ${cachePath} ${url} ${targetDir}`, quiet);
}

/**
 * Add submodule using cache as reference.
 */
export function submoduleAddFromCache(
  url: string,
  relativePath: string,
  projectRoot: string,
  options?: { quiet?: boolean; force?: boolean },
): void {
  const cachePath = ensureCached(url, options);
  const quiet = options?.quiet
    ? { stdio: "pipe" as const }
    : { stdio: "inherit" as const };
  const forceFlag = options?.force ? "--force " : "";

  execSync(
    `git submodule add ${forceFlag}--reference ${cachePath} ${url} ${relativePath}`,
    {
      cwd: projectRoot,
      ...quiet,
    },
  );

  // Initialize the submodule - may fail if repo has unusual state, that's ok
  gitOk(["submodule", "update", "--init", relativePath], projectRoot);
}

/**
 * List all cached repos.
 */
export function listCachedRepos(): Array<{
  path: string;
  url: string;
  size: number;
}> {
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
          // This is a bare repo - get URL or skip if not valid
          const url = git(["config", "--get", "remote.origin.url"], fullPath);
          if (url) {
            const size = getDirSize(fullPath);
            results.push({ path: fullPath, url, size });
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
