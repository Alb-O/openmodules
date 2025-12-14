import { command, positional, string, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { info, fail, raw, colors } from "../../logging";
import { getModulePaths, findProjectRoot } from "../utils";
import { MANIFEST_FILENAME } from "../../constants";

interface EngramChainNode {
  name: string;
  displayName: string;
  toolName: string;
  path: string;
  depth: number;
  hasTriggers: boolean;
  disclosureCount: number;
  activationCount: number;
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
}

function generateToolName(engramPath: string, baseDir: string): string {
  const relativePath = path.relative(baseDir, engramPath);
  const components = relativePath.split(path.sep).filter((part) => part !== ".");
  return `engram_${components.join("_").replace(/-/g, "_")}`;
}

function parseEngramToml(tomlPath: string): {
  name?: string;
  disclosureCount: number;
  activationCount: number;
} {
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(content) as EngramToml;

    const rawDisclosure = parsed["disclosure-triggers"];
    const disclosureCount =
      (rawDisclosure?.["any-msg"]?.length || 0) +
      (rawDisclosure?.["user-msg"]?.length || 0) +
      (rawDisclosure?.["agent-msg"]?.length || 0);

    const rawActivation = parsed["activation-triggers"];
    const activationCount =
      (rawActivation?.["any-msg"]?.length || 0) +
      (rawActivation?.["user-msg"]?.length || 0) +
      (rawActivation?.["agent-msg"]?.length || 0);

    return {
      name: parsed.name,
      disclosureCount,
      activationCount,
    };
  } catch {
    return { disclosureCount: 0, activationCount: 0 };
  }
}

function findEngramByName(
  name: string,
  projectRoot: string | null,
): { path: string; baseDir: string } | null {
  const paths = getModulePaths(projectRoot || undefined);

  if (paths.local) {
    const localPath = path.join(paths.local, name);
    const manifestPath = path.join(localPath, MANIFEST_FILENAME);
    if (fs.existsSync(manifestPath)) {
      return { path: localPath, baseDir: paths.local };
    }
  }

  const globalPath = path.join(paths.global, name);
  const manifestPath = path.join(globalPath, MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath)) {
    return { path: globalPath, baseDir: paths.global };
  }

  return null;
}

function findEngramByToolName(
  toolName: string,
  projectRoot: string | null,
): { path: string; baseDir: string } | null {
  const paths = getModulePaths(projectRoot || undefined);
  const searchPaths = [paths.local, paths.global].filter(Boolean) as string[];

  for (const baseDir of searchPaths) {
    if (!fs.existsSync(baseDir)) continue;

    const found = searchForToolName(baseDir, baseDir, toolName);
    if (found) return { path: found, baseDir };
  }

  return null;
}

function searchForToolName(dir: string, baseDir: string, targetToolName: string): string | null {
  if (!fs.existsSync(dir)) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(dir, entry.name);
    const manifestPath = path.join(entryPath, MANIFEST_FILENAME);

    if (fs.existsSync(manifestPath)) {
      const toolName = generateToolName(entryPath, baseDir);
      if (toolName === targetToolName) {
        return entryPath;
      }
    }

    const nested = searchForToolName(entryPath, baseDir, targetToolName);
    if (nested) return nested;
  }

  return null;
}

function buildChain(
  engramPath: string,
  baseDir: string,
): EngramChainNode[] {
  const chain: EngramChainNode[] = [];
  let current = engramPath;
  const normalizedBase = path.resolve(baseDir);

  while (current !== normalizedBase && current !== path.dirname(current)) {
    const manifestPath = path.join(current, MANIFEST_FILENAME);
    if (fs.existsSync(manifestPath)) {
      const tomlData = parseEngramToml(manifestPath);
      const toolName = generateToolName(current, baseDir);
      const name = path.basename(current);

      chain.unshift({
        name,
        displayName: tomlData.name || name,
        toolName,
        path: current,
        depth: chain.length,
        hasTriggers: tomlData.disclosureCount > 0 || tomlData.activationCount > 0,
        disclosureCount: tomlData.disclosureCount,
        activationCount: tomlData.activationCount,
      });
    }
    current = path.dirname(current);
  }

  for (let i = 0; i < chain.length; i++) {
    chain[i].depth = i;
  }

  return chain;
}

export const chain = command({
  name: "chain",
  description: "Show the disclosure chain for a nested engram",
  args: {
    name: positional({
      type: string,
      displayName: "name",
      description: "Name or tool name of the engram (e.g., 'foo/bar' or 'engram_foo_bar')",
    }),
    toolName: flag({
      long: "tool-name",
      short: "t",
      description: "Interpret the argument as a tool name instead of a path",
    }),
  },
  handler: async ({ name, toolName: useToolName }) => {
    const projectRoot = findProjectRoot();

    let found: { path: string; baseDir: string } | null = null;

    if (useToolName || name.startsWith("engram_")) {
      const searchName = name.startsWith("engram_") ? name : `engram_${name}`;
      found = findEngramByToolName(searchName, projectRoot);
    } else {
      found = findEngramByName(name, projectRoot);
    }

    if (!found) {
      fail(`Engram not found: ${name}\nRun 'engram list' to see available engrams`);
      process.exit(1);
    }

    const chainNodes = buildChain(found.path, found.baseDir);

    if (chainNodes.length === 0) {
      fail(`Could not build chain for: ${name}`);
      process.exit(1);
    }

    const target = chainNodes[chainNodes.length - 1];
    raw(
      colors.bold(`Disclosure chain for: ${target.displayName}`) + "\n" +
      colors.dim(`Tool name: ${target.toolName}`) + "\n"
    );

    if (chainNodes.length === 1) {
      raw(colors.green("✓") + " Root-level engram (no ancestors)");
      const node = chainNodes[0];
      if (!node.hasTriggers) {
        raw(colors.green("✓") + " Permanently visible (no triggers)");
      } else {
        raw(colors.yellow("⧖") + ` Requires disclosure (${node.disclosureCount}D/${node.activationCount}A triggers)`);
      }
      return;
    }

    raw(colors.dim("Ancestors must be disclosed before children become visible:\n"));

    const chainLines = chainNodes.map((node, i) => {
      const isLast = i === chainNodes.length - 1;
      const prefix = i === 0 ? "" : "  ".repeat(i);
      const connector = i === 0 ? "" : "└─ ";

      let statusIcon: string;
      let statusText: string;

      if (!node.hasTriggers) {
        statusIcon = colors.green("●");
        statusText = colors.green("permanent");
      } else {
        statusIcon = colors.yellow("○");
        statusText = colors.yellow(`${node.disclosureCount}D/${node.activationCount}A`);
      }

      const nameDisplay = isLast
        ? colors.bold(node.displayName)
        : node.displayName;

      return `${prefix}${connector}${statusIcon} ${nameDisplay} ${colors.dim(`(${node.toolName})`)} ${statusText}`;
    });
    raw(chainLines.join("\n") + "\n");

    const requiresTriggers = chainNodes.filter((n) => n.hasTriggers);
    if (requiresTriggers.length === 0) {
      raw(
        colors.green("✓") + " All ancestors are permanently visible\n" +
        colors.green("✓") + " This engram will be available immediately"
      );
    } else {
      const triggerLines = requiresTriggers.map((node) => colors.dim(`   - ${node.toolName}`));
      raw(
        colors.yellow("⧖") + ` ${requiresTriggers.length} engram(s) require trigger-based disclosure:\n` +
        triggerLines.join("\n")
      );
    }
  },
});
