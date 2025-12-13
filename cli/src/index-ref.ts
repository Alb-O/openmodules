/**
 * Manages the refs/engrams/index ref for lazy submodule loading.
 *
 * The index is a JSON blob stored at refs/engrams/index containing
 * metadata for all engrams, allowing trigger matching before submodules
 * are initialized.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";

export interface EngramIndexEntry {
  name: string;
  description: string;
  version?: string;
  url?: string;
  triggers?: {
    "any-msg"?: string[];
    "user-msg"?: string[];
    "agent-msg"?: string[];
  };
}

export type EngramIndex = Record<string, EngramIndexEntry>;

const INDEX_REF = "refs/engrams/index";

/**
 * Read the engram index from refs/engrams/index
 */
export function readIndex(repoPath: string): EngramIndex | null {
  try {
    const content = execSync(`git cat-file -p ${INDEX_REF}`, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write the engram index to refs/engrams/index
 */
export function writeIndex(repoPath: string, index: EngramIndex): void {
  const json = JSON.stringify(index, null, 2);

  // Create blob
  const blobSha = execSync(`git hash-object -w --stdin`, {
    cwd: repoPath,
    input: json,
    encoding: "utf-8",
  }).trim();

  // Update ref
  execSync(`git update-ref ${INDEX_REF} ${blobSha}`, {
    cwd: repoPath,
    stdio: "pipe",
  });
}

/**
 * Check if the index ref exists
 */
export function indexExists(repoPath: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet ${INDEX_REF}`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse an engram.toml file into an index entry
 */
export function parseEngramToml(tomlPath: string): EngramIndexEntry | null {
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(content) as Record<string, unknown>;

    const entry: EngramIndexEntry = {
      name: (parsed.name as string) || path.basename(path.dirname(tomlPath)),
      description: (parsed.description as string) || "",
    };

    if (parsed.version) {
      entry.version = parsed.version as string;
    }

    if (parsed.triggers && typeof parsed.triggers === "object") {
      const triggers = parsed.triggers as Record<string, unknown>;
      entry.triggers = {};
      if (Array.isArray(triggers["any-msg"])) {
        entry.triggers["any-msg"] = triggers["any-msg"] as string[];
      }
      if (Array.isArray(triggers["user-msg"])) {
        entry.triggers["user-msg"] = triggers["user-msg"] as string[];
      }
      if (Array.isArray(triggers["agent-msg"])) {
        entry.triggers["agent-msg"] = triggers["agent-msg"] as string[];
      }
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * Get the URL for a submodule from .gitmodules
 */
export function getSubmoduleUrl(
  repoPath: string,
  submodulePath: string,
): string | null {
  try {
    const url = execSync(
      `git config --file .gitmodules --get submodule.${submodulePath}.url`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return url || null;
  } catch {
    return null;
  }
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
  return fs.existsSync(tomlPath);
}

/**
 * Initialize a specific submodule
 */
export function initSubmodule(
  repoPath: string,
  submodulePath: string,
): boolean {
  try {
    execSync(`git submodule update --init ${submodulePath}`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build index from all initialized engrams in .engrams/
 */
export function buildIndexFromEngrams(repoPath: string): EngramIndex {
  const index: EngramIndex = {};
  const engramsDir = path.join(repoPath, ".engrams");

  if (!fs.existsSync(engramsDir)) {
    return index;
  }

  const entries = fs.readdirSync(engramsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const engramPath = path.join(engramsDir, entry.name);
    const tomlPath = path.join(engramPath, "engram.toml");

    if (!fs.existsSync(tomlPath)) continue;

    const parsed = parseEngramToml(tomlPath);
    if (parsed) {
      // Add URL from .gitmodules if available
      const submodulePath = `.engrams/${entry.name}`;
      const url = getSubmoduleUrl(repoPath, submodulePath);
      if (url) {
        parsed.url = url;
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
  execSync(`git push ${remote} +${INDEX_REF}:${INDEX_REF}`, {
    cwd: repoPath,
    stdio: "inherit",
  });
}

/**
 * Fetch the index ref from remote
 */
export function fetchIndex(repoPath: string, remote: string = "origin"): void {
  execSync(`git fetch ${remote} ${INDEX_REF}:${INDEX_REF}`, {
    cwd: repoPath,
    stdio: "pipe",
  });
}

/**
 * Configure remote to auto-fetch engrams refs
 */
export function configureAutoFetch(
  repoPath: string,
  remote: string = "origin",
): void {
  try {
    // Check if already configured
    const existing = execSync(
      `git config --get-all remote.${remote}.fetch`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (existing.includes("refs/engrams/*")) {
      return; // Already configured
    }
  } catch {
    // No existing fetch config or command failed, continue
  }

  execSync(
    `git config --add remote.${remote}.fetch '+refs/engrams/*:refs/engrams/*'`,
    {
      cwd: repoPath,
      stdio: "pipe",
    },
  );
}
