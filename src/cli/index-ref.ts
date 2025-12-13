/**
 * Manages the refs/engrams/index ref for lazy submodule loading.
 *
 * The index is a JSON blob stored at refs/engrams/index containing
 * metadata for all engrams, allowing trigger matching before submodules
 * are initialized.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import TOML from "@iarna/toml";

export interface EngramIndexEntry {
  name: string;
  description: string;
  version?: string;
  /** URL for submodule-based engrams */
  url?: string;
  /** Disclosure triggers - reveal name/description to agent */
  "disclosure-triggers"?: {
    "any-msg"?: string[];
    "user-msg"?: string[];
    "agent-msg"?: string[];
  };
  /** Activation triggers - full immediate activation */
  "activation-triggers"?: {
    "any-msg"?: string[];
    "user-msg"?: string[];
    "agent-msg"?: string[];
  };
  /** Configuration for wrapped external repositories (alternative to submodules) */
  wrap?: {
    /** Git remote URL */
    remote: string;
    /** Requested ref (branch, tag) - what user asked for */
    ref?: string;
    /** Locked commit SHA - only present if lock=true in manifest */
    locked?: string;
    /** Sparse-checkout patterns */
    sparse?: string[];
  };
}

export type EngramIndex = Record<string, EngramIndexEntry>;

const INDEX_REF = "refs/engrams/index";

/**
 * Run a git command and return stdout, or null if it fails.
 */
function git(args: string[], cwd: string, input?: string): string | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: input ? Buffer.from(input) : undefined,
  });
  if (!result.success) return null;
  return result.stdout.toString().trim();
}

/**
 * Run a git command and return success/failure.
 */
function gitOk(args: string[], cwd: string): boolean {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  return result.success;
}

/**
 * Run a git command, throwing on failure.
 */
function gitExec(args: string[], cwd: string, input?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: input ? Buffer.from(input) : undefined,
  });
  if (!result.success) {
    const stderr = result.stderr.toString();
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return result.stdout.toString().trim();
}

/**
 * Read the engram index from refs/engrams/index
 */
export function readIndex(repoPath: string): EngramIndex | null {
  const content = git(["cat-file", "-p", INDEX_REF], repoPath);
  if (!content) return null;
  return JSON.parse(content) as EngramIndex;
}

/**
 * Write the engram index to refs/engrams/index
 */
export function writeIndex(repoPath: string, index: EngramIndex): void {
  const json = JSON.stringify(index, null, 2);
  const blobSha = gitExec(["hash-object", "-w", "--stdin"], repoPath, json);
  gitExec(["update-ref", INDEX_REF, blobSha], repoPath);
}

/**
 * Check if the index ref exists
 */
export function indexExists(repoPath: string): boolean {
  return gitOk(["show-ref", "--verify", "--quiet", INDEX_REF], repoPath);
}

/**
 * Parse an engram.toml file into an index entry.
 * Note: wrap.locked is NOT set here - it must be resolved from git in buildIndexFromEngrams.
 */
export function parseEngramToml(tomlPath: string): EngramIndexEntry | null {
  if (!existsSync(tomlPath)) return null;

  const content = readFileSync(tomlPath, "utf-8");
  const parsed = TOML.parse(content) as Record<string, unknown>;

  const entry: EngramIndexEntry = {
    name: (parsed.name as string) || path.basename(path.dirname(tomlPath)),
    description: (parsed.description as string) || "",
  };

  if (parsed.version) {
    entry.version = parsed.version as string;
  }

  // Parse disclosure triggers
  if (
    parsed["disclosure-triggers"] &&
    typeof parsed["disclosure-triggers"] === "object"
  ) {
    const triggers = parsed["disclosure-triggers"] as Record<string, unknown>;
    entry["disclosure-triggers"] = {};
    if (Array.isArray(triggers["any-msg"])) {
      entry["disclosure-triggers"]["any-msg"] = triggers["any-msg"] as string[];
    }
    if (Array.isArray(triggers["user-msg"])) {
      entry["disclosure-triggers"]["user-msg"] = triggers[
        "user-msg"
      ] as string[];
    }
    if (Array.isArray(triggers["agent-msg"])) {
      entry["disclosure-triggers"]["agent-msg"] = triggers[
        "agent-msg"
      ] as string[];
    }
    // Remove if empty
    if (Object.keys(entry["disclosure-triggers"]).length === 0) {
      delete entry["disclosure-triggers"];
    }
  }

  // Parse activation triggers
  if (
    parsed["activation-triggers"] &&
    typeof parsed["activation-triggers"] === "object"
  ) {
    const triggers = parsed["activation-triggers"] as Record<string, unknown>;
    entry["activation-triggers"] = {};
    if (Array.isArray(triggers["any-msg"])) {
      entry["activation-triggers"]["any-msg"] = triggers["any-msg"] as string[];
    }
    if (Array.isArray(triggers["user-msg"])) {
      entry["activation-triggers"]["user-msg"] = triggers[
        "user-msg"
      ] as string[];
    }
    if (Array.isArray(triggers["agent-msg"])) {
      entry["activation-triggers"]["agent-msg"] = triggers[
        "agent-msg"
      ] as string[];
    }
    // Remove if empty
    if (Object.keys(entry["activation-triggers"]).length === 0) {
      delete entry["activation-triggers"];
    }
  }

  // Extract wrap config (locked SHA will be added by buildIndexFromEngrams if lock=true)
  if (parsed.wrap && typeof parsed.wrap === "object") {
    const wrap = parsed.wrap as Record<string, unknown>;
    if (typeof wrap.remote === "string") {
      entry.wrap = {
        remote: wrap.remote,
        locked: "", // Placeholder - resolved from git only if lock=true
      };
      if (typeof wrap.ref === "string") {
        entry.wrap.ref = wrap.ref;
      }
      if (Array.isArray(wrap.sparse)) {
        entry.wrap.sparse = wrap.sparse as string[];
      }
      // Track if locking is enabled
      if (wrap.lock === true) {
        (entry.wrap as Record<string, unknown>)._lock = true;
      }
    }
  }

  return entry;
}

/**
 * Get the URL for a submodule from .gitmodules
 */
export function getSubmoduleUrl(
  repoPath: string,
  submodulePath: string,
): string | null {
  const url = git(
    ["config", "--file", ".gitmodules", "--get", `submodule.${submodulePath}.url`],
    repoPath,
  );
  return url || null;
}

/**
 * Check if a submodule is initialized (has content)
 */
export function isSubmoduleInitialized(
  repoPath: string,
  submodulePath: string,
): boolean {
  const fullPath = path.join(repoPath, submodulePath);
  const tomlPath = path.join(fullPath, "engram.toml");
  return existsSync(tomlPath);
}

/**
 * Initialize a specific submodule
 */
export function initSubmodule(
  repoPath: string,
  submodulePath: string,
): boolean {
  return gitOk(["submodule", "update", "--init", submodulePath], repoPath);
}

/**
 * Build index from all initialized engrams in .engrams/
 */
export function buildIndexFromEngrams(repoPath: string): EngramIndex {
  const index: EngramIndex = {};
  const engramsDir = path.join(repoPath, ".engrams");

  if (!existsSync(engramsDir)) {
    return index;
  }

  const entries = readdirSync(engramsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const engramPath = path.join(engramsDir, entry.name);
    const tomlPath = path.join(engramPath, "engram.toml");

    if (!existsSync(tomlPath)) continue;

    const parsed = parseEngramToml(tomlPath);
    if (parsed) {
      // For wrapped engrams with lock=true, resolve the locked commit from content/
      if (parsed.wrap) {
        const wrapAny = parsed.wrap as Record<string, unknown>;
        const shouldLock = wrapAny._lock === true;
        delete wrapAny._lock; // Don't include internal flag in index

        if (shouldLock) {
          const contentDir = path.join(engramPath, "content");
          const lockedSha = git(["rev-parse", "HEAD"], contentDir);
          if (lockedSha) {
            parsed.wrap.locked = lockedSha;
          } else {
            // Content not initialized yet, can't lock
            delete parsed.wrap.locked;
          }
        } else {
          // No locking - don't include locked field
          delete parsed.wrap.locked;
        }
        
        // Clean up empty locked string
        if (parsed.wrap.locked === "") {
          delete (parsed.wrap as Record<string, unknown>).locked;
        }
      } else {
        // Add URL from .gitmodules if available (for submodule-based engrams)
        const submodulePath = `.engrams/${entry.name}`;
        const url = getSubmoduleUrl(repoPath, submodulePath);
        if (url) {
          parsed.url = url;
        }
      }
      index[entry.name] = parsed;
    }
  }

  return index;
}

/**
 * Push the index ref to remote
 * Uses force push since the ref points to a blob, not a commit
 */
export function pushIndex(repoPath: string, remote: string = "origin"): void {
  const result = Bun.spawnSync(["git", "push", remote, `+${INDEX_REF}:${INDEX_REF}`], {
    cwd: repoPath,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) {
    throw new Error("Failed to push index ref");
  }
}

/**
 * Fetch the index ref from remote.
 * Returns true on success, false on failure.
 */
export function fetchIndex(repoPath: string, remote: string = "origin"): boolean {
  return gitOk(["fetch", remote, `${INDEX_REF}:${INDEX_REF}`], repoPath);
}

/**
 * Configure remote to auto-fetch engrams refs.
 * Returns true on success, false on failure.
 */
export function configureAutoFetch(
  repoPath: string,
  remote: string = "origin",
): boolean {
  // Check if already configured
  const existing = git(["config", "--get-all", `remote.${remote}.fetch`], repoPath);
  if (existing?.includes("refs/engrams/*")) {
    return true; // Already configured
  }

  return gitOk(
    ["config", "--add", `remote.${remote}.fetch`, "+refs/engrams/*:refs/engrams/*"],
    repoPath,
  );
}
