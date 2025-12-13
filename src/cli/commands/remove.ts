import { command, positional, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot } from "../utils";

export const remove = command({
  name: "remove",
  description: "Remove an installed engram",
  args: {
    name: positional({
      type: { from: async (s) => s },
      displayName: "name",
      description: "Name of the engram to remove",
    }),
    global: flag({
      long: "global",
      short: "g",
      description: "Remove from global engrams",
    }),
    force: flag({
      long: "force",
      short: "f",
      description: "Skip confirmation",
    }),
  },
  handler: async ({ name, global: isGlobal, force }) => {
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    let targetDir: string;
    let isSubmodule = false;

    if (isGlobal) {
      targetDir = path.join(paths.global, name);
    } else {
      if (!projectRoot || !paths.local) {
        console.error(pc.red("Error: Not in a project directory"));
        console.error(pc.dim("Use --global to remove a global engram"));
        process.exit(1);
      }
      targetDir = path.join(paths.local, name);

      // Check if it's a submodule using git config (more reliable than string search)
      try {
        const relativePath = path.relative(projectRoot, targetDir);
        // git config --file .gitmodules --get-regexp returns entries for submodule paths
        const configResult = Bun.spawnSync(
          ["git", "config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
          { cwd: projectRoot },
        );
        if (configResult.success) {
          const output = configResult.stdout.toString();
          // Check if relativePath appears as a value in the output
          const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(`\\s${escapedPath}$`, "m");
          isSubmodule = regex.test(output);
        } else {
          isSubmodule = false;
        }
      } catch {
        // Command failed - not a submodule or no .gitmodules
        isSubmodule = false;
      }
    }

    if (!fs.existsSync(targetDir)) {
      console.error(pc.red(`Error: Engram not found: ${name}`));
      console.error(pc.dim(`Looked in: ${targetDir}`));
      process.exit(1);
    }

    if (!force) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(
          pc.yellow(
            `Remove ${name}${isSubmodule ? " (submodule)" : ""}? [y/N] `,
          ),
          resolve,
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        console.log(pc.dim("Cancelled"));
        return;
      }
    }

    try {
      if (isSubmodule && projectRoot) {
        const relativePath = path.relative(projectRoot, targetDir);
        const deinitResult = Bun.spawnSync(
          ["git", "submodule", "deinit", "-f", relativePath],
          { cwd: projectRoot, stdout: "inherit", stderr: "inherit" },
        );
        if (!deinitResult.success) {
          throw new Error(`git submodule deinit failed`);
        }
        const rmResult = Bun.spawnSync(
          ["git", "rm", "-f", relativePath],
          { cwd: projectRoot, stdout: "inherit", stderr: "inherit" },
        );
        if (!rmResult.success) {
          throw new Error(`git rm failed`);
        }
        // Clean up .git/modules
        const gitModulesPath = path.join(
          projectRoot,
          ".git",
          "modules",
          relativePath,
        );
        if (fs.existsSync(gitModulesPath)) {
          fs.rmSync(gitModulesPath, { recursive: true, force: true });
        }
        console.log(pc.green(`✓ Removed submodule: ${name}`));
      } else {
        fs.rmSync(targetDir, { recursive: true, force: true });
        console.log(pc.green(`✓ Removed: ${name}`));
      }
    } catch (error) {
      const err = error as { message?: string; stderr?: Buffer };
      const errorMessage =
        err?.message || err?.stderr?.toString() || String(error);
      console.error(pc.red("Failed to remove engram:"));
      console.error(pc.dim(errorMessage));
      process.exit(1);
    }
  },
});
