import { command, flag } from "cmd-ts";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import * as TOML from "@iarna/toml";
import { getModulePaths, findProjectRoot } from "../utils";

/**
 * Shortens a path by replacing the home directory with ~
 */
function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

interface ModuleInfo {
  name: string;
  displayName: string;
  description: string;
  path: string;
  scope: "global" | "local";
  hasToml: boolean;
  parseError?: string;
  triggers?: {
    anyMsg?: string[];
    userMsg?: string[];
    agentMsg?: string[];
  };
  children: ModuleInfo[];
  depth: number;
}

function parseModuleToml(tomlPath: string): {
  name?: string;
  description?: string;
  triggers?: { anyMsg?: string[]; userMsg?: string[]; agentMsg?: string[] };
  error?: string;
} {
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(content) as any;
    // Convert hyphenated TOML keys to camelCase
    const rawTriggers = parsed.triggers;
    const triggers = rawTriggers
      ? {
          anyMsg: rawTriggers["any-msg"],
          userMsg: rawTriggers["user-msg"],
          agentMsg: rawTriggers["agent-msg"],
        }
      : undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      triggers,
    };
  } catch (err: any) {
    return {
      error: err?.message || "Unknown parse error",
    };
  }
}

function scanModulesRecursive(
  dir: string,
  scope: "global" | "local",
  depth = 0,
): ModuleInfo[] {
  const modules: ModuleInfo[] = [];

  if (!fs.existsSync(dir)) {
    return modules;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const modulePath = path.join(dir, entry.name);
      const tomlPath = path.join(modulePath, "openmodule.toml");
      const hasToml = fs.existsSync(tomlPath);

      const tomlData = hasToml ? parseModuleToml(tomlPath) : null;

      // Recursively scan for nested modules
      const children = scanModulesRecursive(modulePath, scope, depth + 1);

      // Only include as a module if it has openmodule.toml
      // But still traverse for nested modules
      if (hasToml) {
        modules.push({
          name: entry.name,
          displayName: tomlData?.name || entry.name,
          description: tomlData?.description || "",
          path: modulePath,
          scope,
          hasToml,
          parseError: tomlData?.error,
          triggers: tomlData?.triggers,
          children,
          depth,
        });
      } else if (children.length > 0) {
        // Directory has no toml but contains nested modules - include children at this level
        modules.push(...children);
      }
    }
  }

  return modules;
}

function getTriggerSummary(triggers?: ModuleInfo["triggers"]): string {
  const anyCount = triggers?.anyMsg?.length || 0;
  const userCount = triggers?.userMsg?.length || 0;
  const agentCount = triggers?.agentMsg?.length || 0;
  const total = anyCount + userCount + agentCount;

  // No triggers defined = always visible
  if (total === 0) return pc.green("always visible");

  const parts: string[] = [];

  if (anyCount > 0) parts.push(`${anyCount} any`);
  if (userCount > 0) parts.push(`${userCount} user`);
  if (agentCount > 0) parts.push(`${agentCount} agent`);

  return pc.dim(`${total} trigger${total === 1 ? "" : "s"}`);
}

function printModuleTree(
  modules: ModuleInfo[],
  prefix = "",
  isLast = true,
): void {
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    const isLastItem = i === modules.length - 1;
    const connector = isLastItem ? "└─" : "├─";
    const childPrefix = isLastItem ? "  " : "│ ";

    // Module name and display name
    const nameDisplay =
      mod.displayName !== mod.name
        ? `${pc.bold(mod.name)} ${pc.dim(`(${mod.displayName})`)}`
        : pc.bold(mod.name);

    // Description (truncated if needed)
    const maxDescLen = 50;
    const desc = mod.description
      ? mod.description.length > maxDescLen
        ? mod.description.slice(0, maxDescLen - 3) + "..."
        : mod.description
      : "";
    const descDisplay = desc ? pc.dim(` - ${desc}`) : "";

    // Trigger summary
    const triggerDisplay = getTriggerSummary(mod.triggers);
    const triggerPart = triggerDisplay ? ` [${triggerDisplay}]` : "";

    // Warnings
    let warning = "";
    if (!mod.hasToml) {
      warning = pc.yellow(" (missing openmodule.toml)");
    } else if (mod.parseError) {
      warning = pc.red(` (parse error: ${mod.parseError})`);
    }

    console.log(
      `${prefix}${connector} ${nameDisplay}${descDisplay}${triggerPart}${warning}`,
    );

    // Print children with updated prefix
    if (mod.children.length > 0) {
      printModuleTree(mod.children, prefix + childPrefix, isLastItem);
    }
  }
}

function countModules(modules: ModuleInfo[]): number {
  return modules.reduce((sum, m) => sum + 1 + countModules(m.children), 0);
}

export const list = command({
  name: "list",
  description: "List installed openmodules",
  args: {
    global: flag({
      long: "global",
      short: "g",
      description: "Show only global modules",
    }),
    local: flag({
      long: "local",
      short: "l",
      description: "Show only local modules",
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

    let globalModules: ModuleInfo[] = [];
    let localModules: ModuleInfo[] = [];

    if (!localOnly) {
      globalModules = scanModulesRecursive(paths.global, "global");
    }

    if (!globalOnly && paths.local) {
      localModules = scanModulesRecursive(paths.local, "local");
    }

    const totalGlobal = countModules(globalModules);
    const totalLocal = countModules(localModules);

    if (totalGlobal === 0 && totalLocal === 0) {
      console.log(pc.dim("No modules installed"));
      if (!projectRoot && !globalOnly) {
        console.log(
          pc.dim("(Not in a project directory - showing global modules only)"),
        );
      }
      return;
    }

    // Flatten helper for --flat flag
    const flatten = (modules: ModuleInfo[]): ModuleInfo[] => {
      return modules.flatMap((m) => [
        { ...m, children: [] },
        ...flatten(m.children),
      ]);
    };

    let printedSection = false;

    if (globalModules.length > 0 && !localOnly) {
      console.log(
        pc.bold("🌐 Global modules") +
          pc.dim(` (${shortenPath(paths.global)})`) +
          pc.dim(` — ${totalGlobal} module${totalGlobal === 1 ? "" : "s"}`),
      );
      if (flat) {
        const flatList = flatten(globalModules);
        for (const mod of flatList) {
          const indent = "  ".repeat(mod.depth);
          console.log(`${indent}${mod.name}`);
        }
      } else {
        printModuleTree(globalModules);
      }
      printedSection = true;
    }

    if (localModules.length > 0 && !globalOnly) {
      if (printedSection) console.log("");
      console.log(
        pc.bold("📁 Local modules") +
          pc.dim(` (${shortenPath(paths.local!)})`) +
          pc.dim(` — ${totalLocal} module${totalLocal === 1 ? "" : "s"}`),
      );
      if (flat) {
        const flatList = flatten(localModules);
        for (const mod of flatList) {
          const indent = "  ".repeat(mod.depth);
          console.log(`${indent}${mod.name}`);
        }
      } else {
        printModuleTree(localModules);
      }
    }
  },
});
