import { command, positional, flag } from "cmd-ts";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot } from "../utils";

export const remove = command({
  name: "remove",
  description: "Remove an installed openmodule",
  args: {
    name: positional({
      type: { from: async (s) => s },
      displayName: "name",
      description: "Name of the module to remove",
    }),
    global: flag({
      long: "global",
      short: "g",
      description: "Remove from global modules",
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
        console.error(pc.dim("Use --global to remove a global module"));
        process.exit(1);
      }
      targetDir = path.join(paths.local, name);

      // Check if it's a submodule using git config (more reliable than string search)
      try {
        const relativePath = path.relative(projectRoot, targetDir);
        // git config --file .gitmodules --get-regexp returns entries for submodule paths
        const result = execSync(
          `git config --file .gitmodules --get-regexp "submodule\\..*\\.path" | grep -E "\\s${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$"`,
          { cwd: projectRoot, stdio: "pipe", encoding: "utf-8" },
        );
        isSubmodule = result.trim().length > 0;
      } catch {
        // Command failed - not a submodule or no .gitmodules
        isSubmodule = false;
      }
    }

    if (!fs.existsSync(targetDir)) {
      console.error(pc.red(`Error: Module not found: ${name}`));
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
        execSync(`git submodule deinit -f ${relativePath}`, {
          cwd: projectRoot,
          stdio: "inherit",
        });
        execSync(`git rm -f ${relativePath}`, {
          cwd: projectRoot,
          stdio: "inherit",
        });
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
    } catch (error: any) {
      const errorMessage =
        error?.message || error?.stderr?.toString() || String(error);
      console.error(pc.red("Failed to remove module:"));
      console.error(pc.dim(errorMessage));
      process.exit(1);
    }
  },
});
