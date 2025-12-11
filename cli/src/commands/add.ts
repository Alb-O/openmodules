import { command, positional, flag, option, string, optional } from "cmd-ts";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot, parseRepoUrl, getModuleName, getSupportedDomains } from "../utils";

export const add = command({
  name: "add",
  description: "Add an openmodule from a git repository",
  args: {
    repo: positional({
      type: string,
      displayName: "repo",
      description: "Repository (owner/repo, domain:owner/repo, or full URL)",
    }),
    name: option({
      type: optional(string),
      long: "name",
      short: "n",
      description: "Custom name for the module (defaults to repo name)",
    }),
    global: flag({
      long: "global",
      short: "g",
      description: "Install globally instead of in project",
    }),
    clone: flag({
      long: "clone",
      short: "c",
      description: "Clone instead of adding as submodule (default in git repos is submodule)",
    }),
  },
  handler: async ({ repo, name, global: isGlobal, clone }) => {
    const parsed = parseRepoUrl(repo);
    if (!parsed) {
      console.error(pc.red(`Error: Invalid repository format: ${repo}`));
      console.error(pc.dim("Formats: owner/repo, domain:owner/repo, or full URL"));
      console.error(pc.dim(`Supported domains: ${getSupportedDomains().join(", ")}`));
      process.exit(1);
    }

    const moduleName = name || getModuleName(parsed.repo);
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    let targetDir: string;
    if (isGlobal) {
      targetDir = path.join(paths.global, moduleName);
    } else {
      if (!projectRoot) {
        console.error(pc.red("Error: Not in a project directory"));
        console.error(pc.dim("Use --global to install globally, or run from a git repository"));
        process.exit(1);
      }
      targetDir = path.join(paths.local!, moduleName);
    }

    // Check if already exists
    if (fs.existsSync(targetDir)) {
      console.error(pc.red(`Error: Module already exists at ${targetDir}`));
      process.exit(1);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(targetDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    console.log(pc.blue(`Adding ${parsed.owner}/${parsed.repo} as ${moduleName}...`));

    try {
      if (!clone && !isGlobal) {
        // Add as submodule (default for local installs in git repos)
        execSync(`git submodule add ${parsed.url} ${path.relative(projectRoot!, targetDir)}`, {
          cwd: projectRoot!,
          stdio: "inherit",
        });
        console.log(pc.green(`✓ Added as submodule: ${targetDir}`));
      } else {
        // Clone directly (for global or when --clone is specified)
        execSync(`git clone ${parsed.url} ${targetDir}`, {
          stdio: "inherit",
        });
        console.log(pc.green(`✓ Cloned to: ${targetDir}`));
      }
    } catch (error) {
      console.error(pc.red("Failed to add module"));
      process.exit(1);
    }
  },
});
