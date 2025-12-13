import { command, positional, string, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import pc from "picocolors";
import { findProjectRoot, getModulePaths } from "../utils";
import {
  readIndex,
  fetchIndex,
  initSubmodule,
  isSubmoduleInitialized,
} from "../index-ref";
import { CONTENT_DIR } from "./wrap";
import { cloneWithSparseCheckout } from "../cache";

interface WrapConfig {
  remote: string;
  ref?: string;
  sparse?: string[];
}

interface EngramToml {
  name?: string;
  description?: string;
  wrap?: WrapConfig;
}

/**
 * Check if an engram directory has content (is initialized).
 * For wrapped engrams, checks if content/ directory exists.
 */
function isWrapInitialized(engramDir: string): boolean {
  if (!fs.existsSync(engramDir)) return false;
  
  const contentDir = path.join(engramDir, CONTENT_DIR);
  return fs.existsSync(contentDir);
}

/**
 * Read and parse engram.toml from a directory.
 */
function readEngramToml(engramDir: string): EngramToml | null {
  const tomlPath = path.join(engramDir, "engram.toml");
  if (!fs.existsSync(tomlPath)) return null;
  
  const content = fs.readFileSync(tomlPath, "utf-8");
  return TOML.parse(content) as EngramToml;
}

export const lazyInit = command({
  name: "lazy-init",
  description: "Initialize a lazy engram (wrapped or submodule) on-demand",
  args: {
    name: positional({
      type: string,
      displayName: "name",
      description: "Name of the engram to initialize",
    }),
    fetch: flag({
      long: "fetch",
      short: "f",
      description: "Fetch index from remote first (for submodules)",
    }),
    all: flag({
      long: "all",
      short: "a",
      description: "Initialize all uninitialized engrams",
    }),
  },
  handler: async ({ name, fetch: shouldFetch, all }) => {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      console.error(pc.red("Error: Not in a project directory"));
      process.exit(1);
    }

    const paths = getModulePaths(projectRoot);
    const engramsDir = paths.local;
    if (!engramsDir) {
      console.error(pc.red("Error: No .engrams directory found"));
      process.exit(1);
    }

    // First, check if the engram exists as a wrapped engram with [wrap] config
    const engramDir = path.join(engramsDir, name);
    const engramToml = readEngramToml(engramDir);

    if (engramToml?.wrap) {
      // This is a wrapped engram - use the wrap config to clone
      if (isWrapInitialized(engramDir)) {
        console.log(pc.yellow(`Engram '${name}' is already initialized`));
        process.exit(0);
      }

      console.log(pc.blue(`Initializing wrapped engram: ${name}...`));
      const wrap = engramToml.wrap;

      // Check index for locked commit (for reproducibility)
      const index = readIndex(projectRoot);
      const indexEntry = index?.[name];
      const lockedRef = indexEntry?.wrap?.locked;

      if (wrap.sparse && wrap.sparse.length > 0) {
        console.log(pc.dim(`Sparse patterns: ${wrap.sparse.join(", ")}`));
      }
      if (lockedRef) {
        console.log(pc.dim(`Locked: ${lockedRef.slice(0, 12)}`));
      } else if (wrap.ref) {
        console.log(pc.dim(`Ref: ${wrap.ref}`));
      }

      const contentDir = path.join(engramDir, CONTENT_DIR);
      cloneWithSparseCheckout(wrap.remote, contentDir, {
        // Use locked commit from index if available, otherwise fall back to ref from manifest
        ref: lockedRef || wrap.ref,
        sparse: wrap.sparse,
      });

      console.log(pc.green(`✓ Initialized: ${engramToml.name}`));
      if (engramToml.description) {
        console.log(pc.dim(`  ${engramToml.description}`));
      }
      return;
    }

    // Fall back to submodule-based lazy init via index
    if (shouldFetch) {
      console.log(pc.dim("Fetching index from remote..."));
      try {
        fetchIndex(projectRoot);
      } catch {
        console.log(pc.yellow("Could not fetch index (may not exist on remote)"));
      }
    }

    const index = readIndex(projectRoot);
    if (!index) {
      // Check if the engram directory exists but has no wrap config
      if (fs.existsSync(engramDir)) {
        console.error(pc.red(`Error: Engram '${name}' has no [wrap] config and no index entry`));
        console.error(pc.dim("Add a [wrap] section to engram.toml or sync the index"));
      } else {
        console.error(pc.red(`Error: Engram '${name}' not found`));
      }
      process.exit(1);
    }

    if (all) {
      // Initialize all uninitialized engrams
      let initialized = 0;
      let skipped = 0;

      for (const engramName of Object.keys(index)) {
        const submodulePath = `.engrams/${engramName}`;

        if (isSubmoduleInitialized(projectRoot, submodulePath)) {
          skipped++;
          continue;
        }

        console.log(pc.blue(`Initializing ${engramName}...`));
        if (initSubmodule(projectRoot, submodulePath)) {
          console.log(pc.green(`  ✓ ${engramName}`));
          initialized++;
        } else {
          console.error(pc.red(`  ✗ Failed to initialize ${engramName}`));
        }
      }

      console.log(
        pc.green(`\n✓ Initialized ${initialized} engram(s), ${skipped} already initialized`),
      );
      return;
    }

    // Initialize specific engram from index (submodule)
    if (!index[name]) {
      console.error(pc.red(`Error: Engram '${name}' not found in index`));
      console.error(pc.dim("Available engrams:"));
      for (const key of Object.keys(index)) {
        console.error(pc.dim(`  - ${key}`));
      }
      process.exit(1);
    }

    const submodulePath = `.engrams/${name}`;

    if (isSubmoduleInitialized(projectRoot, submodulePath)) {
      console.log(pc.yellow(`Engram '${name}' is already initialized`));
      process.exit(0);
    }

    console.log(pc.blue(`Initializing ${name}...`));

    if (initSubmodule(projectRoot, submodulePath)) {
      const entry = index[name];
      console.log(pc.green(`✓ Initialized: ${entry.name}`));
      if (entry.description) {
        console.log(pc.dim(`  ${entry.description}`));
      }
    } else {
      console.error(pc.red(`Failed to initialize ${name}`));
      process.exit(1);
    }
  },
});

export const showIndex = command({
  name: "show-index",
  description: "Show the engram index (metadata for lazy loading)",
  args: {
    fetch: flag({
      long: "fetch",
      short: "f",
      description: "Fetch index from remote first",
    }),
    json: flag({
      long: "json",
      description: "Output as JSON",
    }),
  },
  handler: async ({ fetch: shouldFetch, json }) => {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      console.error(pc.red("Error: Not in a project directory"));
      process.exit(1);
    }

    if (shouldFetch) {
      console.log(pc.dim("Fetching index from remote..."));
      try {
        fetchIndex(projectRoot);
      } catch {
        console.log(pc.yellow("Could not fetch index"));
      }
    }

    const index = readIndex(projectRoot);
    if (!index) {
      console.error(pc.red("No engram index found"));
      console.error(pc.dim("Run 'engram sync' to create the index"));
      process.exit(1);
    }

    if (json) {
      console.log(JSON.stringify(index, null, 2));
      return;
    }

    console.log(pc.bold("Engram Index") + pc.dim(" (refs/engrams/index)\n"));

    for (const [name, entry] of Object.entries(index)) {
      const submodulePath = `.engrams/${name}`;
      const initialized = isSubmoduleInitialized(projectRoot, submodulePath);
      const status = initialized
        ? pc.green("●")
        : pc.dim("○");

      console.log(`${status} ${pc.cyan(name)}: ${entry.name}`);
      if (entry.description) {
        console.log(pc.dim(`    ${entry.description}`));
      }

      // Show disclosure triggers
      if (entry["disclosure-triggers"]) {
        const triggers = entry["disclosure-triggers"];
        const parts: string[] = [];
        if (triggers["user-msg"]?.length) {
          parts.push(`user: ${triggers["user-msg"].join(", ")}`);
        }
        if (triggers["agent-msg"]?.length) {
          parts.push(`agent: ${triggers["agent-msg"].join(", ")}`);
        }
        if (triggers["any-msg"]?.length) {
          parts.push(`any: ${triggers["any-msg"].join(", ")}`);
        }
        if (parts.length) {
          console.log(pc.dim(`    disclosure: ${parts.join(" | ")}`));
        }
      }

      // Show activation triggers
      if (entry["activation-triggers"]) {
        const triggers = entry["activation-triggers"];
        const parts: string[] = [];
        if (triggers["user-msg"]?.length) {
          parts.push(`user: ${triggers["user-msg"].join(", ")}`);
        }
        if (triggers["agent-msg"]?.length) {
          parts.push(`agent: ${triggers["agent-msg"].join(", ")}`);
        }
        if (triggers["any-msg"]?.length) {
          parts.push(`any: ${triggers["any-msg"].join(", ")}`);
        }
        if (parts.length) {
          console.log(pc.dim(`    activation: ${parts.join(" | ")}`));
        }
      }
    }

    console.log(pc.dim(`\n● initialized  ○ not initialized`));
  },
});
