import { command, positional, flag, option, string, optional } from "cmd-ts";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot, parseRepoUrl, getModuleName, getSupportedDomains } from "../utils";
import { submoduleAddFromCache, cloneFromCache, isCached } from "../cache";

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
    force: flag({
      long: "force",
      short: "f",
      description: "Force add, removing existing module if present",
    }),
    noCache: flag({
      long: "no-cache",
      description: "Skip the bare repo cache, clone directly from remote",
    }),
  },
  handler: async ({ repo, name, global: isGlobal, clone, force, noCache }) => {
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

    // Force clean any existing submodule state (handles broken/partial submodules)
    if (force && !isGlobal && projectRoot) {
      const relativePath = path.relative(projectRoot, targetDir);
      try {
        // Deinit if registered (ignore errors)
        execSync(`git submodule deinit -f ${relativePath}`, {
          cwd: projectRoot,
          stdio: "pipe",
        });
      } catch {
        // Ignore - may not be initialized
      }
      try {
        // Remove from index (ignore errors)
        execSync(`git rm -f ${relativePath}`, {
          cwd: projectRoot,
          stdio: "pipe",
        });
      } catch {
        // Ignore - may not be in index
      }
      // Find the actual git dir (handles nested submodules)
      let gitDir: string;
      const dotGitPath = path.join(projectRoot, ".git");
      if (fs.existsSync(dotGitPath) && fs.statSync(dotGitPath).isFile()) {
        // This repo is itself a submodule - .git is a file pointing to the real location
        const gitFileContent = fs.readFileSync(dotGitPath, "utf-8").trim();
        const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
        if (match) {
          gitDir = path.resolve(projectRoot, match[1]);
        } else {
          gitDir = dotGitPath;
        }
      } else {
        gitDir = dotGitPath;
      }
      // Clean up modules directory
      const gitModulesPath = path.join(gitDir, "modules", relativePath);
      if (fs.existsSync(gitModulesPath)) {
        fs.rmSync(gitModulesPath, { recursive: true, force: true });
      }
      // Remove directory if exists
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      console.log(pc.yellow(`Cleaned up existing module state for ${moduleName}`));
    } else if (fs.existsSync(targetDir)) {
      // Check if already exists (non-force mode)
      console.error(pc.red(`Error: Module already exists at ${targetDir}`));
      console.error(pc.dim("Use --force to overwrite"));
      process.exit(1);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(targetDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    console.log(pc.blue(`Adding ${parsed.owner}/${parsed.repo} as ${moduleName}...`));

    const cached = isCached(parsed.url);
    if (cached) {
      console.log(pc.dim("Using cached repository..."));
    }

    try {
      if (!clone && !isGlobal) {
        // Add as submodule (default for local installs in git repos)
        const relativePath = path.relative(projectRoot!, targetDir);
        if (noCache) {
          const forceFlag = force ? "--force " : "";
          execSync(`git submodule add ${forceFlag}${parsed.url} ${relativePath}`, {
            cwd: projectRoot!,
            stdio: "inherit",
          });
        } else {
          submoduleAddFromCache(parsed.url, relativePath, projectRoot!, { force });
        }
        console.log(pc.green(`✓ Added as submodule: ${targetDir}`));
      } else {
        // Clone directly (for global or when --clone is specified)
        if (noCache) {
          execSync(`git clone ${parsed.url} ${targetDir}`, {
            stdio: "inherit",
          });
        } else {
          cloneFromCache(parsed.url, targetDir);
        }
        console.log(pc.green(`✓ Cloned to: ${targetDir}`));
      }
    } catch (error) {
      console.error(pc.red("Failed to add module"));
      process.exit(1);
    }
  },
});
