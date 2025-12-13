import { command, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import * as TOML from "@iarna/toml";
import { getModulePaths, findProjectRoot, shortenPath } from "../utils";
import { readIndex, isSubmoduleInitialized } from "../index-ref";

interface EngramInfo {
  name: string;
  displayName: string;
  description: string;
  path: string;
  scope: "global" | "local";
  hasToml: boolean;
  parseError?: string;
  disclosureTriggers?: {
    anyMsg?: string[];
    userMsg?: string[];
    agentMsg?: string[];
  };
  activationTriggers?: {
    anyMsg?: string[];
    userMsg?: string[];
    agentMsg?: string[];
  };
  children: EngramInfo[];
  depth: number;
  /** Whether this engram is initialized (has content). For submodules, false means not cloned */
  initialized: boolean;
  /** Whether this is from the index (lazy) rather than filesystem scan */
  fromIndex?: boolean;
  /** Whether this is a wrapped engram (has [wrap] config) */
  isWrapped?: boolean;
}

interface EngramToml {
  name?: string;
  description?: string;
  "disclosure-triggers"?: {
    "any-msg"?: string[];
    "user-msg"?: string[];
    "agent-msg"?: string[];
  };
  "activation-triggers"?: {
    "any-msg"?: string[];
    "user-msg"?: string[];
    "agent-msg"?: string[];
  };
  wrap?: {
    remote?: string;
    ref?: string;
    sparse?: string[];
  };
}

/**
 * Get status indicator for an engram.
 * ● = initialized, ◐ = lazy (wrapped but not cloned), ○ = not initialized
 */
function getStatusDot(eg: { initialized: boolean; isWrapped?: boolean }): string {
  if (eg.initialized) return pc.green("●");
  if (eg.isWrapped) return pc.yellow("◐");
  return pc.dim("○");
}

function parseEngramToml(tomlPath: string): {
  name?: string;
  description?: string;
  disclosureTriggers?: { anyMsg?: string[]; userMsg?: string[]; agentMsg?: string[] };
  activationTriggers?: { anyMsg?: string[]; userMsg?: string[]; agentMsg?: string[] };
  hasWrap?: boolean;
  error?: string;
} {
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(content) as EngramToml;
    
    // Convert hyphenated TOML keys to camelCase
    const rawDisclosure = parsed["disclosure-triggers"];
    const disclosureTriggers = rawDisclosure
      ? {
          anyMsg: rawDisclosure["any-msg"],
          userMsg: rawDisclosure["user-msg"],
          agentMsg: rawDisclosure["agent-msg"],
        }
      : undefined;
      
    const rawActivation = parsed["activation-triggers"];
    const activationTriggers = rawActivation
      ? {
          anyMsg: rawActivation["any-msg"],
          userMsg: rawActivation["user-msg"],
          agentMsg: rawActivation["agent-msg"],
        }
      : undefined;
      
    return {
      name: parsed.name,
      description: parsed.description,
      disclosureTriggers,
      activationTriggers,
      hasWrap: !!parsed.wrap?.remote,
    };
  } catch (err) {
    return {
      error: (err as Error)?.message || "Unknown parse error",
    };
  }
}

/**
 * Check if a wrapped engram has been initialized.
 * Returns true if content/ directory exists (where cloned repos live).
 */
function isWrappedEngramInitialized(engramPath: string): boolean {
  const contentDir = path.join(engramPath, "content");
  return fs.existsSync(contentDir);
}

function scanEngramsRecursive(
  dir: string,
  scope: "global" | "local",
  depth = 0,
): EngramInfo[] {
  const engrams: EngramInfo[] = [];

  if (!fs.existsSync(dir)) {
    return engrams;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden entries
    if (entry.name.startsWith(".")) continue;

    // Check if entry is a directory (or symlink to directory)
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const targetPath = path.join(dir, entry.name);
      try {
        isDir = fs.statSync(targetPath).isDirectory();
      } catch {
        continue; // Skip broken symlinks
      }
    }

    if (isDir) {
      const engramPath = path.join(dir, entry.name);
      const tomlPath = path.join(engramPath, "engram.toml");
      const hasToml = fs.existsSync(tomlPath);

      const tomlData = hasToml ? parseEngramToml(tomlPath) : null;

      // Recursively scan for nested engrams
      const children = scanEngramsRecursive(engramPath, scope, depth + 1);

      // Only include as an engram if it has engram.toml
      // But still traverse for nested engrams
      if (hasToml) {
        // For wrapped engrams, check if content exists beyond manifest files
        const isWrapped = tomlData?.hasWrap ?? false;
        const initialized = isWrapped
          ? isWrappedEngramInitialized(engramPath)
          : true;

        engrams.push({
          name: entry.name,
          displayName: tomlData?.name || entry.name,
          description: tomlData?.description || "",
          path: engramPath,
          scope,
          hasToml,
          parseError: tomlData?.error,
          disclosureTriggers: tomlData?.disclosureTriggers,
          activationTriggers: tomlData?.activationTriggers,
          children,
          depth,
          initialized,
          isWrapped,
        });
      } else if (children.length > 0) {
        // Directory has no toml but contains nested engrams - include children at this level
        engrams.push(...children);
      }
    }
  }

  return engrams;
}

function getTriggerSummary(
  disclosure?: EngramInfo["disclosureTriggers"],
  activation?: EngramInfo["activationTriggers"],
): string {
  const disclosureCount = 
    (disclosure?.anyMsg?.length || 0) +
    (disclosure?.userMsg?.length || 0) +
    (disclosure?.agentMsg?.length || 0);
  const activationCount = 
    (activation?.anyMsg?.length || 0) +
    (activation?.userMsg?.length || 0) +
    (activation?.agentMsg?.length || 0);
  const total = disclosureCount + activationCount;

  // No triggers defined = always visible
  if (total === 0) return pc.green("always visible");

  const parts: string[] = [];
  if (disclosureCount > 0) parts.push(`${disclosureCount} disclosure`);
  if (activationCount > 0) parts.push(`${activationCount} activation`);

  return pc.dim(parts.join(", "));
}

function printEngramTree(
  engrams: EngramInfo[],
  prefix = "",
  isLast = true,
): void {
  for (let i = 0; i < engrams.length; i++) {
    const eg = engrams[i];
    const isLastItem = i === engrams.length - 1;
    const connector = isLastItem ? "└─" : "├─";
    const childPrefix = isLastItem ? "  " : "│ ";

    // Initialization status indicator
    // ● = initialized, ◐ = lazy (wrapped but not cloned), ○ = not initialized
    const statusDot = getStatusDot(eg);

    // Engram name and display name
    const nameDisplay =
      eg.displayName !== eg.name
        ? `${pc.bold(eg.name)} ${pc.dim(`(${eg.displayName})`)}`
        : pc.bold(eg.name);

    // Description (truncated if needed)
    const maxDescLen = 50;
    let desc = "";
    if (eg.description) {
      desc = eg.description.length > maxDescLen
        ? eg.description.slice(0, maxDescLen - 3) + "..."
        : eg.description;
    }
    const descDisplay = desc ? pc.dim(` - ${desc}`) : "";

    // Trigger summary
    const triggerDisplay = getTriggerSummary(eg.disclosureTriggers, eg.activationTriggers);
    const triggerPart = triggerDisplay ? ` [${triggerDisplay}]` : "";

    // Warnings
    let warning = "";
    if (!eg.hasToml && !eg.fromIndex) {
      warning = pc.yellow(" (missing engram.toml)");
    } else if (eg.parseError) {
      warning = pc.red(` (parse error: ${eg.parseError})`);
    }

    console.log(
      `${prefix}${connector} ${statusDot} ${nameDisplay}${descDisplay}${triggerPart}${warning}`,
    );

    // Print children with updated prefix
    if (eg.children.length > 0) {
      printEngramTree(eg.children, prefix + childPrefix, isLastItem);
    }
  }
}

function countEngrams(engrams: EngramInfo[]): number {
  return engrams.reduce((sum, e) => sum + 1 + countEngrams(e.children), 0);
}

/**
 * Get uninitialized engrams from the index that weren't found in filesystem scan
 */
function getUninitializedFromIndex(
  projectRoot: string,
  existingNames: Set<string>,
): EngramInfo[] {
  const index = readIndex(projectRoot);
  if (!index) return [];

  const uninitialized: EngramInfo[] = [];

  for (const [name, entry] of Object.entries(index)) {
    if (existingNames.has(name)) continue;

    // Check if directory exists but is empty (submodule registered but not cloned)
    const submodulePath = `.engrams/${name}`;
    if (!isSubmoduleInitialized(projectRoot, submodulePath)) {
      // Convert trigger format
      const disclosureTriggers = entry["disclosure-triggers"]
        ? {
            anyMsg: entry["disclosure-triggers"]["any-msg"],
            userMsg: entry["disclosure-triggers"]["user-msg"],
            agentMsg: entry["disclosure-triggers"]["agent-msg"],
          }
        : undefined;
      const activationTriggers = entry["activation-triggers"]
        ? {
            anyMsg: entry["activation-triggers"]["any-msg"],
            userMsg: entry["activation-triggers"]["user-msg"],
            agentMsg: entry["activation-triggers"]["agent-msg"],
          }
        : undefined;

      uninitialized.push({
        name,
        displayName: entry.name || name,
        description: entry.description || "",
        path: path.join(projectRoot, submodulePath),
        scope: "local",
        hasToml: false,
        disclosureTriggers,
        activationTriggers,
        children: [],
        depth: 0,
        initialized: false,
        fromIndex: true,
      });
    }
  }

  return uninitialized;
}

export const list = command({
  name: "list",
  description: "List installed engrams",
  args: {
    global: flag({
      long: "global",
      short: "g",
      description: "Show only global engrams",
    }),
    local: flag({
      long: "local",
      short: "l",
      description: "Show only local engrams",
    }),
    flat: flag({
      long: "flat",
      short: "f",
      description: "Show flat list without hierarchy",
    }),
  },
  handler: async ({ global: globalOnly, local: localOnly, flat }) => {
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    let globalEngrams: EngramInfo[] = [];
    let localEngrams: EngramInfo[] = [];

    if (!localOnly) {
      globalEngrams = scanEngramsRecursive(paths.global, "global");
    }

    if (!globalOnly && paths.local) {
      localEngrams = scanEngramsRecursive(paths.local, "local");

      // Add uninitialized engrams from the index
      if (projectRoot) {
        const existingNames = new Set(localEngrams.map((e) => e.name));
        const uninitialized = getUninitializedFromIndex(projectRoot, existingNames);
        localEngrams.push(...uninitialized);
      }
    }

    const totalGlobal = countEngrams(globalEngrams);
    const totalLocal = countEngrams(localEngrams);

    if (totalGlobal === 0 && totalLocal === 0) {
      console.log(pc.dim("No engrams installed"));
      if (!projectRoot && !globalOnly) {
        console.log(
          pc.dim("(Not in a project directory - showing global engrams only)"),
        );
      }
      return;
    }

    // Flatten helper for --flat flag
    const flatten = (engrams: EngramInfo[]): EngramInfo[] => {
      return engrams.flatMap((e) => [
        { ...e, children: [] },
        ...flatten(e.children),
      ]);
    };

    let printedSection = false;

    if (globalEngrams.length > 0 && !localOnly) {
      console.log(
        pc.bold("🌐 Global engrams") +
          pc.dim(` (${shortenPath(paths.global)})`) +
          pc.dim(` — ${totalGlobal} engram${totalGlobal === 1 ? "" : "s"}`),
      );
      if (flat) {
        const flatList = flatten(globalEngrams);
        for (const eg of flatList) {
          const statusDot = getStatusDot(eg);
          const indent = "  ".repeat(eg.depth);
          console.log(`${indent}${statusDot} ${eg.name}`);
        }
      } else {
        printEngramTree(globalEngrams);
      }
      printedSection = true;
    }

    if (localEngrams.length > 0 && !globalOnly) {
      if (printedSection) console.log("");
      console.log(
        pc.bold("📁 Local engrams") +
          pc.dim(` (${shortenPath(paths.local!)})`) +
          pc.dim(` — ${totalLocal} engram${totalLocal === 1 ? "" : "s"}`),
      );
      if (flat) {
        const flatList = flatten(localEngrams);
        for (const eg of flatList) {
          const statusDot = getStatusDot(eg);
          const indent = "  ".repeat(eg.depth);
          console.log(`${indent}${statusDot} ${eg.name}`);
        }
      } else {
        printEngramTree(localEngrams);
      }
    }

    // Legend
    console.log(pc.dim(`\n● initialized  ◐ lazy  ○ not initialized`));
  },
});
