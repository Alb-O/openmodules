import { command, flag } from "cmd-ts";
import pc from "picocolors";
import { findProjectRoot } from "../utils";
import {
  buildIndexFromEngrams,
  writeIndex,
  readIndex,
  pushIndex,
  indexExists,
} from "../index-ref";

export const sync = command({
  name: "sync",
  description:
    "Sync the engram index from initialized engrams (for lazy loading)",
  args: {
    push: flag({
      long: "push",
      short: "p",
      description: "Push the index to remote after syncing",
    }),
    dryRun: flag({
      long: "dry-run",
      short: "n",
      description: "Show what would be synced without writing",
    }),
  },
  handler: async ({ push, dryRun }) => {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      console.error(pc.red("Error: Not in a project directory"));
      process.exit(1);
    }

    console.log(pc.blue("Building index from initialized engrams..."));

    const index = buildIndexFromEngrams(projectRoot);
    const engramCount = Object.keys(index).length;

    if (engramCount === 0) {
      console.log(pc.yellow("No initialized engrams found in .engrams/"));
      process.exit(0);
    }

    console.log(pc.dim(`Found ${engramCount} engram(s):`));
    for (const [name, entry] of Object.entries(index)) {
      const triggerCount =
        (entry.triggers?.["any-msg"]?.length || 0) +
        (entry.triggers?.["user-msg"]?.length || 0) +
        (entry.triggers?.["agent-msg"]?.length || 0);
      const triggerInfo =
        triggerCount > 0 ? pc.dim(` [${triggerCount} triggers]`) : "";
      console.log(`  ${pc.cyan(name)}: ${entry.name}${triggerInfo}`);
    }

    if (dryRun) {
      console.log(pc.yellow("\n[dry-run] Would write index:"));
      console.log(JSON.stringify(index, null, 2));
      return;
    }

    // Check if index changed
    const existingIndex = readIndex(projectRoot);
    const newJson = JSON.stringify(index, null, 2);
    const existingJson = existingIndex
      ? JSON.stringify(existingIndex, null, 2)
      : null;

    if (newJson === existingJson) {
      console.log(pc.green("\n✓ Index already up to date"));
    } else {
      writeIndex(projectRoot, index);
      const verb = indexExists(projectRoot) ? "Updated" : "Created";
      console.log(pc.green(`\n✓ ${verb} refs/engrams/index`));
    }

    if (push) {
      console.log(pc.blue("\nPushing index to remote..."));
      try {
        pushIndex(projectRoot);
        console.log(pc.green("✓ Pushed to origin"));
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(pc.red(`Failed to push: ${message}`));
        process.exit(1);
      }
    }
  },
});
