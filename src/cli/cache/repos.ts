import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { getCacheDir, getDirSize } from "./index";

/**
 * Run a git command and return stdout, or null if it fails.
 */
function git(args: string[], cwd: string): string | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) return null;
  return result.stdout.toString().trim();
}

/**
 * Run a git command and return success/failure.
 */
function gitOk(args: string[], cwd: string): boolean {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.success;
}

/**
 * Run a git command, throwing on failure with error message.
 */
function gitExec(
  args: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): void {
  const { cwd, quiet = false } = options;
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  if (!result.success) {
    const errorMsg = result.stderr?.toString().trim() || "Unknown error";
    throw new Error(`git ${args[0]} failed:\n  ${errorMsg}`);
  }
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
    const hash = new Bun.CryptoHasher("sha256")
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
  const quiet = options?.quiet ?? false;

  if (fs.existsSync(cachePath)) {
    // Update existing cache
    const result = Bun.spawnSync(["git", "fetch", "--all", "--prune"], {
      cwd: cachePath,
      stdout: quiet ? "pipe" : "inherit",
      stderr: quiet ? "pipe" : "inherit",
    });
    if (!result.success) {
      // Fetch failed - warn but continue with stale cache
      const errorMsg = result.stderr?.toString().trim() || "Unknown error";
      console.warn(pc.yellow(`Warning: Failed to update cache for ${url}`));
      console.warn(pc.dim(`  ${errorMsg}`));
      console.warn(pc.dim("  Using potentially stale cached version"));
    }
  } else {
    // Clone as bare repo into cache
    const parentDir = path.dirname(cachePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const result = Bun.spawnSync(["git", "clone", "--bare", url, cachePath], {
      stdout: quiet ? "pipe" : "inherit",
      stderr: quiet ? "pipe" : "inherit",
    });
    if (!result.success) {
      const errorMsg = result.stderr?.toString().trim() || "Unknown error";
      throw new Error(`Failed to clone ${url} into cache:\n  ${errorMsg}`);
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
  gitExec(["clone", "--reference", cachePath, url, targetDir], {
    quiet: options?.quiet,
  });
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
  const args = ["submodule", "add"];
  if (options?.force) args.push("--force");
  args.push("--reference", cachePath, url, relativePath);

  gitExec(args, { cwd: projectRoot, quiet: options?.quiet });

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

export interface SparseCloneOptions {
  /** Git ref to checkout (branch, tag, or commit hash) */
  ref?: string;
  /** Sparse-checkout patterns (glob patterns) */
  sparse?: string[];
  /** Skip cache and clone directly */
  noCache?: boolean;
  /** Suppress output */
  quiet?: boolean;
}

/**
 * Clone a repo with optional sparse-checkout, using cache for efficiency.
 * Uses --reference to share objects with the cached bare repo.
 *
 * For sparse checkout scenarios, this still helps by:
 * 1. Caching repo metadata (refs, commits, trees) in the bare repo
 * 2. Using --reference to share any objects that are fetched
 * 3. Speeding up subsequent clones of the same repo
 */
export function cloneWithSparseCheckout(
  url: string,
  targetDir: string,
  options: SparseCloneOptions = {},
): void {
  const { ref, sparse, noCache = false, quiet = false } = options;

  // Build clone args
  const needsDelayedCheckout = (sparse && sparse.length > 0) || ref;
  const cloneArgs = ["clone", "--filter=blob:none"];

  if (needsDelayedCheckout) {
    cloneArgs.push("--no-checkout");
  }

  // Add branch flag if ref is not a commit hash
  if (ref && !ref.match(/^[0-9a-f]{40}$/i)) {
    cloneArgs.push("-b", ref);
  }

  if (noCache) {
    // Direct clone without cache
    if (!ref) {
      cloneArgs.push("--depth", "1");
    }
  } else {
    // Clone using cache as reference for object sharing
    const cachePath = ensureCached(url, { quiet });
    cloneArgs.push("--reference", cachePath);
  }

  cloneArgs.push(url, targetDir);
  gitExec(cloneArgs, { quiet });

  // Configure sparse-checkout if patterns provided
  if (sparse && sparse.length > 0) {
    gitExec(["sparse-checkout", "init"], { cwd: targetDir, quiet: true });

    // Use shell for glob pattern handling
    const sparseSetArgs = [
      "-c",
      `git sparse-checkout set --no-cone ${sparse.map((p) => `'${p}'`).join(" ")}`,
    ];
    const result = Bun.spawnSync(["sh", ...sparseSetArgs], {
      cwd: targetDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!result.success) {
      throw new Error(
        `Failed to set sparse-checkout patterns:\n  ${result.stderr.toString().trim()}`,
      );
    }
  }

  // Checkout specific ref if needed
  if (needsDelayedCheckout) {
    const checkoutRef = ref || "HEAD";
    // Suppress detached HEAD warning when checking out a specific commit
    gitExec(
      ["-c", "advice.detachedHead=false", "checkout", checkoutRef],
      { cwd: targetDir, quiet },
    );
  }
}
