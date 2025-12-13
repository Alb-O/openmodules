import { command, positional, string, flag, option, optional } from "cmd-ts";
import pc from "picocolors";
import { findProjectRoot } from "../utils";
import {
  readIndex,
  fetchIndex,
  initSubmodule,
  isSubmoduleInitialized,
  configureAutoFetch,
} from "../index-ref";

export const lazyInit = command({
  name: "lazy-init",
  description: "Initialize a specific engram submodule on-demand",
  args: {
    name: positional({
      type: string,
      displayName: "name",
      description: "Name of the engram to initialize",
    }),
    fetch: flag({
      long: "fetch",
      short: "f",
      description: "Fetch index from remote first",
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

    // Optionally fetch index first
    if (shouldFetch) {
      console.log(pc.dim("Fetching index from remote..."));
      try {
        fetchIndex(projectRoot);
      } catch {
        console.log(pc.yellow("Could not fetch index (may not exist on remote)"));
      }
    }

    // Read the index
    const index = readIndex(projectRoot);
    if (!index) {
      console.error(pc.red("Error: No engram index found"));
      console.error(pc.dim("Run 'engram sync' to create the index, or use --fetch"));
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

    // Initialize specific engram
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
