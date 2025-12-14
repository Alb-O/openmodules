import * as fs from "node:fs";
import * as path from "node:path";
import { warn, info } from "../../logging";
import { getCacheDir, getDirSize } from "./index";

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds for network operations
const MAX_RETRIES = 2;

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

interface GitNetworkResult {
  success: boolean;
  stderr?: string;
  timedOut?: boolean;
}

/**
 * Run a git network command with timeout and retry support.
 * Returns result object instead of throwing to allow graceful handling.
 */
async function gitNetwork(
  args: string[],
  options: {
    cwd?: string;
    quiet?: boolean;
    timeoutMs?: number;
    retries?: number;
  } = {},
): Promise<GitNetworkResult> {
  const {
    cwd,
    quiet = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = MAX_RETRIES,
  } = options;

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      info(`  Retry ${attempt}/${retries}...`);
    }

    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: quiet ? "pipe" : "inherit",
      stderr: "pipe",
    });

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const exitPromise = proc.exited.then(() => "done" as const);
    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result === "timeout") {
      proc.kill();
      lastError = `Operation timed out after ${timeoutMs / 1000}s`;
      continue;
    }

    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return { success: true };
    }

    lastError = await new Response(proc.stderr).text();
    lastError = lastError.trim() || "Unknown error";
  }

  return { success: false, stderr: lastError, timedOut: lastError?.includes("timed out") };
}

/**
 * Convert a git URL to a cache path.
 * Uses a normalized URL structure: domain/owner/repo.git
 */
export function urlToCachePath(url: string): string {
  const match = url.match(
    /(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (!match) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(url)
      .digest("hex")
      .slice(0, 16);
    warn(`Non-standard URL format, using hash-based cache path for: ${url}`);
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
 * Throws if clone fails; fetch failures use stale cache with warning.
 */
export async function ensureCached(
  url: string,
  options?: { quiet?: boolean },
): Promise<string> {
  const cachePath = urlToCachePath(url);
  const quiet = options?.quiet ?? false;

  if (fs.existsSync(cachePath)) {
    const result = await gitNetwork(["fetch", "--all", "--prune"], {
      cwd: cachePath,
      quiet,
    });
    if (!result.success) {
      warn(`Failed to update cache for ${url}`);
      if (result.stderr) {
        info(`  ${result.stderr}`);
      }
      if (result.timedOut) {
        info("  Network operation timed out");
      }
      info("  Using potentially stale cached version");
    }
  } else {
    const parentDir = path.dirname(cachePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const result = await gitNetwork(["clone", "--bare", url, cachePath], {
      quiet,
    });
    if (!result.success) {
      const errorMsg = result.stderr || "Unknown error";
      if (result.timedOut) {
        throw new Error(
          `Failed to clone ${url} into cache: operation timed out\n` +
            `  Check your network connection and try again`,
        );
      }
      throw new Error(`Failed to clone ${url} into cache:\n  ${errorMsg}`);
    }
  }

  return cachePath;
}

/**
 * Clone from cache using --reference for object sharing.
 */
export async function cloneFromCache(
  url: string,
  targetDir: string,
  options?: { quiet?: boolean },
): Promise<void> {
  const cachePath = await ensureCached(url, options);
  gitExec(["clone", "--reference", cachePath, url, targetDir], {
    quiet: options?.quiet,
  });
}

/**
 * Add submodule using cache as reference.
 */
export async function submoduleAddFromCache(
  url: string,
  relativePath: string,
  projectRoot: string,
  options?: { quiet?: boolean; force?: boolean },
): Promise<void> {
  const cachePath = await ensureCached(url, options);
  const args = ["submodule", "add"];
  if (options?.force) args.push("--force");
  args.push("--reference", cachePath, url, relativePath);

  gitExec(args, { cwd: projectRoot, quiet: options?.quiet });
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
export async function cloneWithSparseCheckout(
  url: string,
  targetDir: string,
  options: SparseCloneOptions = {},
): Promise<void> {
  const { ref, sparse, noCache = false, quiet = false } = options;

  const needsDelayedCheckout = (sparse && sparse.length > 0) || ref;
  const cloneArgs = ["clone", "--filter=blob:none"];

  if (needsDelayedCheckout) {
    cloneArgs.push("--no-checkout");
  }

  if (ref && !ref.match(/^[0-9a-f]{40}$/i)) {
    cloneArgs.push("-b", ref);
  }

  if (noCache) {
    if (!ref) {
      cloneArgs.push("--depth", "1");
    }
  } else {
    const cachePath = await ensureCached(url, { quiet });
    cloneArgs.push("--reference", cachePath);
  }

  cloneArgs.push(url, targetDir);
  gitExec(cloneArgs, { quiet });

  if (sparse && sparse.length > 0) {
    gitExec(["sparse-checkout", "init"], { cwd: targetDir, quiet: true });
    gitExec(["sparse-checkout", "set", "--no-cone", ...sparse], {
      cwd: targetDir,
      quiet: true,
    });
  }

  if (needsDelayedCheckout) {
    const checkoutRef = ref || "HEAD";
    gitExec(
      ["-c", "advice.detachedHead=false", "checkout", checkoutRef],
      { cwd: targetDir, quiet },
    );
  }
}
