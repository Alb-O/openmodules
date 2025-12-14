import { command, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { info, raw, colors } from "../../logging";
import { getModulePaths, findProjectRoot, shortenPath } from "../utils";
import { readIndex, isSubmoduleInitialized } from "../index-ref";
import { MANIFEST_FILENAME, CONTENT_DIR, ENGRAMS_DIR } from "../../constants";

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
    explicit?: boolean;
  };
  activationTriggers?: {
    anyMsg?: string[];
    userMsg?: string[];
    agentMsg?: string[];
    explicit?: boolean;
  };
  children: EngramInfo[];
  depth: number;
  initialized: boolean;
  fromIndex?: boolean;
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

function getStatusDot(eg: { initialized: boolean; isWrapped?: boolean }): string {
  if (eg.initialized) return colors.green("●");
  if (eg.isWrapped) return colors.yellow("◐");
  return colors.dim("○");
}

function parseEngramToml(tomlPath: string): {
  name?: string;
  description?: string;
  disclosureTriggers?: { anyMsg?: string[]; userMsg?: string[]; agentMsg?: string[]; explicit?: boolean };
  activationTriggers?: { anyMsg?: string[]; userMsg?: string[]; agentMsg?: string[]; explicit?: boolean };
  hasWrap?: boolean;
  error?: string;
} {
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(content) as EngramToml;
    
    const disclosureDeclared = "disclosure-triggers" in parsed;
    const rawDisclosure = parsed["disclosure-triggers"];
    const disclosureTriggers = disclosureDeclared
      ? {
          anyMsg: rawDisclosure?.["any-msg"],
          userMsg: rawDisclosure?.["user-msg"],
          agentMsg: rawDisclosure?.["agent-msg"],
          explicit: true,
        }
      : undefined;
      
    const activationDeclared = "activation-triggers" in parsed;
    const rawActivation = parsed["activation-triggers"];
    const activationTriggers = activationDeclared
      ? {
          anyMsg: rawActivation?.["any-msg"],
          userMsg: rawActivation?.["user-msg"],
          agentMsg: rawActivation?.["agent-msg"],
          explicit: true,
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

function isWrappedEngramInitialized(engramPath: string): boolean {
  const contentDir = path.join(engramPath, CONTENT_DIR);
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
    if (entry.name.startsWith(".")) continue;

    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const targetPath = path.join(dir, entry.name);
      try {
        isDir = fs.statSync(targetPath).isDirectory();
      } catch {
        continue;
      }
    }

    if (isDir) {
      const engramPath = path.join(dir, entry.name);
      const tomlPath = path.join(engramPath, MANIFEST_FILENAME);
      const hasToml = fs.existsSync(tomlPath);

      const tomlData = hasToml ? parseEngramToml(tomlPath) : null;

      const children = scanEngramsRecursive(engramPath, scope, depth + 1);

      if (hasToml) {
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

  const disclosureExplicit = disclosure?.explicit === true;
  const activationExplicit = activation?.explicit === true;

  // No triggers declared at all → permanently visible
  if (!disclosureExplicit && !activationExplicit) {
    return colors.dim("P");
  }

  // Triggers declared but all empty → manual activation only
  if (disclosureCount === 0 && activationCount === 0) {
    return colors.dim("M");
  }

  const parts: string[] = [];
  if (disclosureCount > 0) parts.push(`${disclosureCount}D`);
  if (activationCount > 0) parts.push(`${activationCount}A`);

  return colors.dim(parts.join("/"));
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function buildEngramTreeLines(
  engrams: EngramInfo[],
  prefix = "",
  isLast = true,
  lineWidth = 90,
  triggerCol = 80,
): string[] {
  const outputLines: string[] = [];
  for (let i = 0; i < engrams.length; i++) {
    const eg = engrams[i];
    const isLastItem = i === engrams.length - 1;
    const connector = isLastItem ? "└─" : "├─";
    const childPrefix = isLastItem ? "  " : "│ ";

    const statusDot = getStatusDot(eg);

    // Show displayName, with slug in dim only if meaningfully different
    const slugLower = eg.name.toLowerCase().replace(/[-_]/g, "");
    const displayLower = eg.displayName.toLowerCase().replace(/\s+/g, "");
    const showSlug = slugLower !== displayLower;
    const nameDisplay = showSlug
      ? `${colors.bold(eg.displayName)} ${colors.dim(`[${eg.name}]`)}`
      : colors.bold(eg.displayName);

    const triggerDisplay = getTriggerSummary(eg.disclosureTriggers, eg.activationTriggers);

    let warning = "";
    if (!eg.hasToml && !eg.fromIndex) {
      warning = colors.yellow(" (missing engram.toml)");
    } else if (eg.parseError) {
      warning = colors.red(` (parse error: ${eg.parseError})`);
    }

    // Build left side: prefix + connector + dot + name + description
    const leftPrefix = `${prefix}${connector} ${statusDot} ${nameDisplay}`;
    const leftPrefixLen = stripAnsi(leftPrefix).length;

    // Calculate space for description (leave room for padding + trigger)
    const availableForDesc = Math.max(0, triggerCol - leftPrefixLen - 4); // 4 = " — " + padding

    let descDisplay = "";
    if (eg.description && availableForDesc > 10) {
      const desc =
        eg.description.length > availableForDesc
          ? eg.description.slice(0, availableForDesc - 1) + "…"
          : eg.description;
      descDisplay = ` ${colors.dim("·")} ${colors.dim(desc)}`;
    }

    const leftSide = `${leftPrefix}${descDisplay}${warning}`;
    const leftSideLen = stripAnsi(leftSide).length;

    // Pad to align trigger column, add separator before trigger
    const padding = Math.max(1, triggerCol - leftSideLen);
    const line = `${leftSide}${" ".repeat(padding)}${colors.dim(" · ")}${triggerDisplay}`;

    outputLines.push(line);

    if (eg.children.length > 0) {
      outputLines.push(...buildEngramTreeLines(eg.children, prefix + childPrefix, isLastItem, lineWidth, triggerCol));
    }
  }
  return outputLines;
}

function printEngramTree(
  engrams: EngramInfo[],
  prefix = "",
  isLast = true,
  lineWidth = 90,
  triggerCol = 80,
): void {
  const lines = buildEngramTreeLines(engrams, prefix, isLast, lineWidth, triggerCol);
  raw(lines.join("\n"));
}

function countEngrams(engrams: EngramInfo[]): number {
  return engrams.reduce((sum, e) => sum + 1 + countEngrams(e.children), 0);
}

function isPermanentlyVisible(eg: EngramInfo): boolean {
  const disclosureExplicit = eg.disclosureTriggers?.explicit === true;
  const activationExplicit = eg.activationTriggers?.explicit === true;
  
  // If any trigger section is explicitly declared, it's not permanently visible
  if (disclosureExplicit || activationExplicit) {
    return false;
  }
  
  return true;
}

function isManualOnly(eg: EngramInfo): boolean {
  const disclosureExplicit = eg.disclosureTriggers?.explicit === true;
  const activationExplicit = eg.activationTriggers?.explicit === true;
  
  if (!disclosureExplicit && !activationExplicit) {
    return false;
  }
  
  const disclosureCount = 
    (eg.disclosureTriggers?.anyMsg?.length || 0) +
    (eg.disclosureTriggers?.userMsg?.length || 0) +
    (eg.disclosureTriggers?.agentMsg?.length || 0);
  const activationCount = 
    (eg.activationTriggers?.anyMsg?.length || 0) +
    (eg.activationTriggers?.userMsg?.length || 0) +
    (eg.activationTriggers?.agentMsg?.length || 0);
  
  return disclosureCount === 0 && activationCount === 0;
}

function hasTriggers(eg: EngramInfo): boolean {
  return !isPermanentlyVisible(eg) && !isManualOnly(eg);
}

function filterByTriggerStatus(engrams: EngramInfo[], wantTriggers: boolean): EngramInfo[] {
  const result: EngramInfo[] = [];
  for (const eg of engrams) {
    const filteredChildren = filterByTriggerStatus(eg.children, wantTriggers);
    const matches = wantTriggers ? hasTriggers(eg) : isPermanentlyVisible(eg);
    if (matches) {
      result.push({ ...eg, children: filteredChildren });
    } else if (filteredChildren.length > 0) {
      result.push(...filteredChildren);
    }
  }
  return result;
}

function getUninitializedFromIndex(
  projectRoot: string,
  existingNames: Set<string>,
): EngramInfo[] {
  const index = readIndex(projectRoot);
  if (!index) return [];

  const uninitialized: EngramInfo[] = [];

  for (const [name, entry] of Object.entries(index)) {
    if (existingNames.has(name)) continue;

    const submodulePath = `${ENGRAMS_DIR}/${name}`;
    if (!isSubmoduleInitialized(projectRoot, submodulePath)) {
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
    disclosed: flag({
      long: "disclosed",
      short: "d",
      description: "Show only engrams that require trigger-based disclosure",
    }),
    permanent: flag({
      long: "permanent",
      short: "p",
      description: "Show only permanently visible engrams (no triggers)",
    }),
  },
  handler: async ({ global: globalOnly, local: localOnly, flat, disclosed, permanent }) => {
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    let globalEngrams: EngramInfo[] = [];
    let localEngrams: EngramInfo[] = [];

    if (!localOnly) {
      globalEngrams = scanEngramsRecursive(paths.global, "global");
    }

    if (!globalOnly && paths.local) {
      localEngrams = scanEngramsRecursive(paths.local, "local");

      if (projectRoot) {
        const existingNames = new Set(localEngrams.map((e) => e.name));
        const uninitialized = getUninitializedFromIndex(projectRoot, existingNames);
        localEngrams.push(...uninitialized);
      }
    }

    if (disclosed) {
      globalEngrams = filterByTriggerStatus(globalEngrams, true);
      localEngrams = filterByTriggerStatus(localEngrams, true);
    } else if (permanent) {
      globalEngrams = filterByTriggerStatus(globalEngrams, false);
      localEngrams = filterByTriggerStatus(localEngrams, false);
    }

    const totalGlobal = countEngrams(globalEngrams);
    const totalLocal = countEngrams(localEngrams);

    if (totalGlobal === 0 && totalLocal === 0) {
      if (disclosed) {
        info("No trigger-based engrams found\nAll engrams are permanently visible");
      } else if (permanent) {
        info("No permanently visible engrams found\nAll engrams require trigger-based disclosure");
      } else {
        info("No engrams installed");
        if (!projectRoot && !globalOnly) {
          info("(Not in a project directory - showing global engrams only)");
        }
      }
      return;
    }

    const flatten = (engrams: EngramInfo[]): EngramInfo[] => {
      return engrams.flatMap((e) => [
        { ...e, children: [] },
        ...flatten(e.children),
      ]);
    };

    let printedSection = false;

    if (globalEngrams.length > 0 && !localOnly) {
      raw(
        colors.bold("Global engrams") + "\n" +
        "│ " +
          colors.dim(`${totalGlobal} engram${totalGlobal === 1 ? "" : "s"}`) +
          colors.dim(` — ${shortenPath(paths.global)}`),
      );
      if (flat) {
        const flatList = flatten(globalEngrams);
        const flatLines = flatList.map(eg => {
          const statusDot = getStatusDot(eg);
          const indent = "  ".repeat(eg.depth);
          return `${indent}${statusDot} ${eg.name}`;
        });
        raw(flatLines.join("\n"));
      } else {
        printEngramTree(globalEngrams);
      }
      printedSection = true;
    }

    if (localEngrams.length > 0 && !globalOnly) {
      if (printedSection) raw("");
      raw(
        colors.bold("Local engrams") + "\n" +
        "│ " +
          colors.dim(`${totalLocal} engram${totalLocal === 1 ? "" : "s"}`) +
          colors.dim(` — ${shortenPath(paths.local!)}`),
      );
      if (flat) {
        const flatList = flatten(localEngrams);
        const flatLines = flatList.map(eg => {
          const statusDot = getStatusDot(eg);
          const indent = "  ".repeat(eg.depth);
          return `${indent}${statusDot} ${eg.name}`;
        });
        raw(flatLines.join("\n"));
      } else {
        printEngramTree(localEngrams);
      }
    }
    
    // Footer/legend
    raw(
      colors.dim("─".repeat(90) + "\n") +
      colors.dim("● ready  ◐ lazy  ○ not initialized") + "\n" +
      colors.dim("P = permanently visible  M = manual only  XD/XA = disclosure/activation triggers")
    );
  },
});
