import { command, positional, string, flag, option, optional } from "cmd-ts";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as TOML from "@iarna/toml";
import pc from "picocolors";
import { findProjectRoot, getModulePaths } from "../utils";
import {
  readIndex,
  fetchIndex,
  initSubmodule,
  isSubmoduleInitialized,
  configureAutoFetch,
} from "../index-ref";

interface WrapConfig {
  remote: string;
  ref?: string;
  sparse?: string[];
}

interface EngramToml {
  name: string;
  description?: string;
  wrap?: WrapConfig;
}

/**
 * Check if an engram directory has content (is initialized).
 * For wrapped engrams, checks if there's more than just engram.toml/README.md
 */
function isWrapInitialized(engramDir: string): boolean {
  if (!fs.existsSync(engramDir)) return false;
  
  const entries = fs.readdirSync(engramDir);
  // If there's a .git directory, it's been cloned
  if (entries.includes(".git")) return true;
  
  // Check if there are any content files beyond manifest
  const manifestFiles = ["engram.toml", "README.md", ".gitignore"];
  const contentFiles = entries.filter(e => !manifestFiles.includes(e));
  return contentFiles.length > 0;
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

/**
 * Clone a repo with optional sparse-checkout and ref.
 */
function cloneIntoExisting(
  url: string,
  targetDir: string,
  options: { ref?: string; sparse?: string[] } = {},
): void {
  const { ref, sparse } = options;
  
  // Clone into a temp dir, then move contents
  const tempDir = `${targetDir}.tmp`;
  
  const needsDelayedCheckout = (sparse && sparse.length > 0) || ref;
  const depthFlag = ref ? "" : "--depth 1";
  const checkoutFlag = needsDelayedCheckout ? "--no-checkout" : "";
  const branchFlag = ref && !ref.match(/^[0-9a-f]{40}$/i) ? `-b ${ref}` : "";

  execSync(
    `git clone --filter=blob:none ${depthFlag} ${checkoutFlag} ${branchFlag} ${url} ${tempDir}`.replace(/\s+/g, " ").trim(),
    { stdio: "inherit" },
  );

  // Configure sparse-checkout if patterns provided
  if (sparse && sparse.length > 0) {
    execSync(`git sparse-checkout init`, { cwd: tempDir, stdio: "pipe" });
    execSync(`git sparse-checkout set --no-cone ${sparse.map(p => `'${p}'`).join(" ")}`, {
      cwd: tempDir,
      stdio: "pipe",
      shell: "/bin/sh",
    });
  }

  // Checkout specific ref if needed
  if (needsDelayedCheckout) {
    const checkoutRef = ref || "HEAD";
    execSync(`git checkout ${checkoutRef}`, { cwd: tempDir, stdio: "inherit" });
  }

  // Move .git and content into existing directory (preserving engram.toml, README.md)
  const tempEntries = fs.readdirSync(tempDir);
  for (const entry of tempEntries) {
    const srcPath = path.join(tempDir, entry);
    const destPath = path.join(targetDir, entry);
    
    // Don't overwrite existing manifest files
    if ((entry === "engram.toml" || entry === "README.md") && fs.existsSync(destPath)) {
      continue;
    }
    
    fs.renameSync(srcPath, destPath);
  }
  
  fs.rmdirSync(tempDir);
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

      if (wrap.sparse && wrap.sparse.length > 0) {
        console.log(pc.dim(`Sparse patterns: ${wrap.sparse.join(", ")}`));
      }
      if (wrap.ref) {
        console.log(pc.dim(`Ref: ${wrap.ref}`));
      }

      cloneIntoExisting(wrap.remote, engramDir, {
        ref: wrap.ref,
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

      if (entry.triggers) {
        const parts: string[] = [];
        if (entry.triggers["user-msg"]?.length) {
          parts.push(`user: ${entry.triggers["user-msg"].join(", ")}`);
        }
        if (entry.triggers["agent-msg"]?.length) {
          parts.push(`agent: ${entry.triggers["agent-msg"].join(", ")}`);
        }
        if (entry.triggers["any-msg"]?.length) {
          parts.push(`any: ${entry.triggers["any-msg"].join(", ")}`);
        }
        if (parts.length) {
          console.log(pc.dim(`    triggers: ${parts.join(" | ")}`));
        }
      }
    }

    console.log(pc.dim(`\n● initialized  ○ not initialized`));
  },
});
