import { command, flag } from "cmd-ts";
import { info, success, warn, fail, log } from "../../logging";
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
      fail("Not in a project directory");
      process.exit(1);
    }

    info("Building index from initialized engrams...");

    const index = buildIndexFromEngrams(projectRoot);
    const engramCount = Object.keys(index).length;

    if (engramCount === 0) {
      warn("No initialized engrams found in .engrams/");
      process.exit(0);
    }

    info(`Found ${engramCount} engram(s):`);
    for (const [name, entry] of Object.entries(index)) {
      const disclosureCount =
        (entry["disclosure-triggers"]?.["any-msg"]?.length || 0) +
        (entry["disclosure-triggers"]?.["user-msg"]?.length || 0) +
        (entry["disclosure-triggers"]?.["agent-msg"]?.length || 0);
      const activationCount =
        (entry["activation-triggers"]?.["any-msg"]?.length || 0) +
        (entry["activation-triggers"]?.["user-msg"]?.length || 0) +
        (entry["activation-triggers"]?.["agent-msg"]?.length || 0);
      const triggerInfo =
        disclosureCount + activationCount > 0
          ? ` [${disclosureCount} disclosure, ${activationCount} activation]`
          : "";
      info(`  ${name}: ${entry.name}${triggerInfo}`);
    }

    if (dryRun) {
      warn("[dry-run] Would write index:");
      log(JSON.stringify(index, null, 2));
      return;
    }

    const existingIndex = readIndex(projectRoot);
    const newJson = JSON.stringify(index, null, 2);
    const existingJson = existingIndex
      ? JSON.stringify(existingIndex, null, 2)
      : null;

    if (newJson === existingJson) {
      success("Index already up to date");
    } else {
      writeIndex(projectRoot, index);
      const verb = indexExists(projectRoot) ? "Updated" : "Created";
      success(`${verb} refs/engrams/index`);
    }

    if (push) {
      info("Pushing index to remote...");
      try {
        pushIndex(projectRoot);
        success("Pushed to origin");
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        fail(`Failed to push: ${message}`);
        process.exit(1);
      }
    }
  },
});
