import { command, positional, string, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import pc from "picocolors";
import { info, success, warn, fail, log } from "../../logging";
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
      fail("Not in a project directory");
      process.exit(1);
    }

    const paths = getModulePaths(projectRoot);
    const engramsDir = paths.local;
    if (!engramsDir) {
      fail("No .engrams directory found");
      process.exit(1);
    }

    const engramDir = path.join(engramsDir, name);
    const engramToml = readEngramToml(engramDir);

    if (engramToml?.wrap) {
      if (isWrapInitialized(engramDir)) {
        warn(`Engram '${name}' is already initialized`);
        process.exit(0);
      }

      info(`Initializing wrapped engram: ${name}...`);
      const wrap = engramToml.wrap;

      const index = readIndex(projectRoot);
      const indexEntry = index?.[name];
      const lockedRef = indexEntry?.wrap?.locked;

      if (wrap.sparse && wrap.sparse.length > 0) {
        info(`Sparse patterns: ${wrap.sparse.join(", ")}`);
      }
      if (lockedRef) {
        info(`Locked: ${lockedRef.slice(0, 12)}`);
      } else if (wrap.ref) {
        info(`Ref: ${wrap.ref}`);
      }

      const contentDir = path.join(engramDir, CONTENT_DIR);
      cloneWithSparseCheckout(wrap.remote, contentDir, {
        ref: lockedRef || wrap.ref,
        sparse: wrap.sparse,
      });

      success(`Initialized: ${engramToml.name}`);
      if (engramToml.description) {
        info(`  ${engramToml.description}`);
      }
      return;
    }

    if (shouldFetch) {
      info("Fetching index from remote...");
      try {
        fetchIndex(projectRoot);
      } catch {
        warn("Could not fetch index (may not exist on remote)");
      }
    }

    const index = readIndex(projectRoot);
    if (!index) {
      if (fs.existsSync(engramDir)) {
        fail(`Engram '${name}' has no [wrap] config and no index entry`);
        info("Add a [wrap] section to engram.toml or sync the index");
      } else {
        fail(`Engram '${name}' not found`);
      }
      process.exit(1);
    }

    if (all) {
      let initialized = 0;
      let skipped = 0;

      for (const engramName of Object.keys(index)) {
        const submodulePath = `.engrams/${engramName}`;

        if (isSubmoduleInitialized(projectRoot, submodulePath)) {
          skipped++;
          continue;
        }

        info(`Initializing ${engramName}...`);
        if (initSubmodule(projectRoot, submodulePath)) {
          success(`  ${engramName}`);
          initialized++;
        } else {
          fail(`  Failed to initialize ${engramName}`);
        }
      }

      success(`Initialized ${initialized} engram(s), ${skipped} already initialized`);
      return;
    }

    if (!index[name]) {
      fail(`Engram '${name}' not found in index`);
      info("Available engrams:");
      for (const key of Object.keys(index)) {
        info(`  - ${key}`);
      }
      process.exit(1);
    }

    const submodulePath = `.engrams/${name}`;

    if (isSubmoduleInitialized(projectRoot, submodulePath)) {
      warn(`Engram '${name}' is already initialized`);
      process.exit(0);
    }

    info(`Initializing ${name}...`);

    if (initSubmodule(projectRoot, submodulePath)) {
      const entry = index[name];
      success(`Initialized: ${entry.name}`);
      if (entry.description) {
        info(`  ${entry.description}`);
      }
    } else {
      fail(`Failed to initialize ${name}`);
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
      fail("Not in a project directory");
      process.exit(1);
    }

    if (shouldFetch) {
      info("Fetching index from remote...");
      try {
        fetchIndex(projectRoot);
      } catch {
        warn("Could not fetch index");
      }
    }

    const index = readIndex(projectRoot);
    if (!index) {
      fail("No engram index found");
      info("Run 'engram sync' to create the index");
      process.exit(1);
    }

    if (json) {
      log(JSON.stringify(index, null, 2));
      return;
    }

    log(pc.bold("Engram Index") + pc.dim(" (refs/engrams/index)\n"));

    for (const [name, entry] of Object.entries(index)) {
      const submodulePath = `.engrams/${name}`;
      const initialized = isSubmoduleInitialized(projectRoot, submodulePath);
      const status = initialized
        ? pc.green("●")
        : pc.dim("○");

      log(`${status} ${pc.cyan(name)}: ${entry.name}`);
      if (entry.description) {
        info(`    ${entry.description}`);
      }

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
          info(`    disclosure: ${parts.join(" | ")}`);
        }
      }

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
          info(`    activation: ${parts.join(" | ")}`);
        }
      }
    }

    info(`\n● initialized  ○ not initialized`);
  },
});
