import os from "node:os";
import { promises as fs, existsSync, Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Engram } from "./types";
import { logWarning } from "./logging";
import { MANIFEST_FILENAME, parseEngram, generateToolName } from "./manifest";

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
 * Safely stat a path, returning null if it doesn't exist or fails.
 */
async function safeStat(path: string) {
  return fs.stat(path).catch(() => null);
}

/**
 * Safely get realpath, returning original path on failure.
 */
async function safeRealpath(path: string): Promise<string> {
  return fs.realpath(path).catch(() => path);
}

/**
 * Finds all engram.toml files within a base path.
 * Returns paths to manifest files.
 */
export async function findEngramFiles(basePath: string): Promise<string[]> {
  const engramFiles: string[] = [];
  const visited = new Set<string>();
  const queue = [basePath];

  while (queue.length > 0) {
    const current = queue.pop() as string;

    const stat = await safeStat(current);
    if (!stat) {
      if (current === basePath) {
        const err = new Error(`ENOENT: no such file or directory, '${current}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      continue;
    }

    if (!stat.isDirectory()) {
      if (current === basePath) {
        const err = new Error(`ENOENT: not a directory, '${current}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      continue;
    }

    const realCurrent = await fs.realpath(current);

    if (visited.has(realCurrent)) {
      continue;
    }
    visited.add(realCurrent);

    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      let stat: Dirent | Awaited<ReturnType<typeof fs.stat>>;

      if (entry.isSymbolicLink()) {
        const linkedStat = await safeStat(fullPath);
        if (!linkedStat) continue; // Skip broken symlinks
        stat = linkedStat;
      } else {
        stat = entry;
      }

      if (stat.isDirectory()) {
        queue.push(fullPath);
      } else if (stat.isFile() && entry.name === MANIFEST_FILENAME) {
        engramFiles.push(fullPath);
      }
    }
  }

  return engramFiles;
}

function normalizeBasePaths(basePaths: unknown): string[] {
  if (Array.isArray(basePaths)) {
    return basePaths.filter((p): p is string => typeof p === "string");
  }

  if (typeof basePaths === "string") {
    return [basePaths];
  }

  logWarning(
    "Invalid basePaths provided to discoverEngrams; expected string[] or string.",
  );
  return [];
}

/**
 * Establishes parent-child relationships between engrams based on directory hierarchy.
 * An engram is a child of another if its directory is a descendant of the parent's directory.
 * Only the closest ancestor is set as the parent.
 * Uses realpath to resolve symlinks for accurate ancestry detection.
 */
async function establishEngramHierarchy(engrams: Engram[]): Promise<void> {
  // Resolve real paths for all engrams to handle symlinks correctly
  const realPaths = new Map<Engram, string>();
  for (const engram of engrams) {
    realPaths.set(engram, await safeRealpath(engram.directory));
  }

  // Sort by resolved directory depth (shallowest first)
  const sortedByDepth = [...engrams].sort((a, b) => {
    const aPath = realPaths.get(a) || a.directory;
    const bPath = realPaths.get(b) || b.directory;
    return aPath.split(sep).length - bPath.split(sep).length;
  });

  // Map from resolved directory to engram for quick lookup
  const dirToEngram = new Map<string, Engram>();
  for (const engram of sortedByDepth) {
    const realPath = realPaths.get(engram) || engram.directory;
    dirToEngram.set(realPath, engram);
  }

  // For each engram, find its closest ancestor that is also an engram
  for (const engram of sortedByDepth) {
    const realPath = realPaths.get(engram) || engram.directory;
    let currentDir = dirname(realPath);

    while (currentDir && currentDir !== dirname(currentDir)) {
      const parentEngram = dirToEngram.get(currentDir);
      if (parentEngram) {
        // Found the closest parent
        engram.parentToolName = parentEngram.toolName;

        // Add this engram to parent's children
        if (!parentEngram.childToolNames) {
          parentEngram.childToolNames = [];
        }
        parentEngram.childToolNames.push(engram.toolName);
        break;
      }
      currentDir = dirname(currentDir);
    }
  }
}

export async function discoverEngrams(basePaths: unknown): Promise<Engram[]> {
  const paths = normalizeBasePaths(basePaths);
  if (paths.length === 0) {
    return [];
  }

  const engrams: Engram[] = [];
  let foundExistingDir = false;

  for (const basePath of paths) {
    try {
      const matches = await findEngramFiles(basePath);
      foundExistingDir = true;

      for (const match of matches) {
        const engram = await parseEngram(match, basePath);
        if (engram) {
          engrams.push(engram);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        continue;
      }
      logWarning(
        `Unexpected error while scanning engrams in ${basePath}:`,
        error,
      );
    }
  }

  if (!foundExistingDir) {
    logWarning(
      "No engrams directories found. Checked:\n" +
        paths.map((path) => `  - ${path}`).join("\n"),
    );
  }

  const toolNames = new Map<string, string>(); // toolName -> manifestPath
  const duplicates: { toolName: string; paths: string[] }[] = [];

  for (const engram of engrams) {
    const existing = toolNames.get(engram.toolName);
    if (existing) {
      // Find or create duplicate entry
      const dup = duplicates.find((d) => d.toolName === engram.toolName);
      if (dup) {
        dup.paths.push(engram.manifestPath);
      } else {
        duplicates.push({
          toolName: engram.toolName,
          paths: [existing, engram.manifestPath],
        });
      }
    }
    toolNames.set(engram.toolName, engram.manifestPath);
  }

  if (duplicates.length > 0) {
    const details = duplicates
      .map(
        (d) =>
          `  ${d.toolName}:\n${d.paths.map((p) => `    - ${p}`).join("\n")}`,
      )
      .join("\n");
    throw new Error(
      `Duplicate tool names detected. Each engram must have a unique path.\n${details}`,
    );
  }

  // Establish parent-child relationships based on directory hierarchy
  await establishEngramHierarchy(engrams);

  return engrams;
}

export function getDefaultEngramPaths(rootDir: string): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const globalEngramsPath = xdgConfigHome
    ? join(xdgConfigHome, "engrams")
    : join(os.homedir(), ".config", "engrams");

  return [globalEngramsPath, join(rootDir, ".engrams")];
}

/** Entry from refs/engrams/index */
interface IndexEntry {
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
  /** Configuration for wrapped external repositories */
  wrap?: {
    remote: string;
    ref?: string;
    /** Only present if lock=true in manifest */
    locked?: string;
    sparse?: string[];
  };
}

type EngramIndex = Record<string, IndexEntry>;

const INDEX_REF = "refs/engrams/index";

/**
 * Read the engram index from refs/engrams/index in a git repo
 */
export function readIndexRef(repoPath: string): EngramIndex | null {
  const content = git(["cat-file", "-p", INDEX_REF], repoPath);
  if (!content) return null;
  return JSON.parse(content) as EngramIndex;
}

/**
 * Check if a submodule directory has been initialized (has engram.toml)
 */
function isSubmoduleInitialized(engramPath: string): boolean {
  return existsSync(join(engramPath, MANIFEST_FILENAME));
}

/**
 * Create stub Engram objects for uninitialized engrams from the index.
 * These have lazy=true and minimal content explaining how to init.
 */
export async function getEngramsFromIndex(
  repoPath: string,
  engramsDir: string,
): Promise<Engram[]> {
  const index = readIndexRef(repoPath);
  if (!index) {
    return [];
  }

  const lazyEngrams: Engram[] = [];

  for (const [key, entry] of Object.entries(index)) {
    const engramPath = join(engramsDir, key);

    // Skip if already initialized
    if (isSubmoduleInitialized(engramPath)) {
      continue;
    }

    // Check if the directory exists (submodule registered but not cloned)
    if (!existsSync(engramPath)) {
      continue;
    }

    const toolName = generateToolName(engramPath, engramsDir);

    const lazyContent = `# ${entry.name}

${entry.description}

---

**This engram is not yet initialized.** To use it, run:

\`\`\`bash
engram lazy-init ${key}
\`\`\`

Or initialize via git:

\`\`\`bash
git submodule update --init ${engramPath}
\`\`\`
`;

    const engram: Engram = {
      name: entry.name,
      directory: engramPath,
      toolName,
      description: entry.description,
      content: lazyContent,
      manifestPath: join(engramPath, MANIFEST_FILENAME),
      lazy: true,
      url: entry.url,
    };

    // Convert disclosure triggers
    if (entry["disclosure-triggers"]) {
      const dt = entry["disclosure-triggers"];
      if (dt["any-msg"]?.length || dt["user-msg"]?.length || dt["agent-msg"]?.length) {
        engram.disclosureTriggers = {
          anyMsg: dt["any-msg"],
          userMsg: dt["user-msg"],
          agentMsg: dt["agent-msg"],
        };
      }
    }

    // Convert activation triggers
    if (entry["activation-triggers"]) {
      const at = entry["activation-triggers"];
      if (at["any-msg"]?.length || at["user-msg"]?.length || at["agent-msg"]?.length) {
        engram.activationTriggers = {
          anyMsg: at["any-msg"],
          userMsg: at["user-msg"],
          agentMsg: at["agent-msg"],
        };
      }
    }

    lazyEngrams.push(engram);
  }

  return lazyEngrams;
}

/**
 * Enhanced engram discovery that includes lazy engrams from the index.
 * Falls back to standard discovery if no index is found.
 */
export async function discoverEngramsWithLazy(
  basePaths: unknown,
  repoPath?: string,
): Promise<Engram[]> {
  // First, get normally initialized engrams
  const engrams = await discoverEngrams(basePaths);

  // If we have a repo path, try to get lazy engrams from the index
  if (repoPath) {
    const paths = normalizeBasePaths(basePaths);
    const localEngramsDir = paths.find((p) => p.includes(".engrams"));

    if (localEngramsDir) {
      const lazyEngrams = await getEngramsFromIndex(repoPath, localEngramsDir);

      // Only add lazy engrams that aren't already discovered
      const existingToolNames = new Set(engrams.map((e) => e.toolName));
      for (const lazyEngram of lazyEngrams) {
        if (!existingToolNames.has(lazyEngram.toolName)) {
          engrams.push(lazyEngram);
        }
      }
    }
  }

  return engrams;
}
