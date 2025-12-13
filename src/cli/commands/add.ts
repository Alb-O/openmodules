import { command, positional, flag, option, string, optional } from "cmd-ts";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import {
  getModulePaths,
  findProjectRoot,
  parseRepoUrl,
  getEngramName,
  getSupportedDomains,
} from "../utils";
import { submoduleAddFromCache, cloneFromCache, isCached } from "../cache";
import {
  readIndex,
  writeIndex,
  parseEngramToml,
} from "../index-ref";

export const add = command({
  name: "add",
  description: "Add an engram from a git repository",
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
      description: "Custom name for the engram (defaults to repo name)",
    }),
    global: flag({
      long: "global",
      short: "g",
      description: "Install globally instead of in project",
    }),
    clone: flag({
      long: "clone",
      short: "c",
      description:
        "Clone instead of adding as submodule (default in git repos is submodule)",
    }),
    force: flag({
      long: "force",
      short: "f",
      description: "Force add, removing existing engram if present",
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
      console.error(
        pc.dim("Formats: owner/repo, domain:owner/repo, or full URL"),
      );
      console.error(
        pc.dim(`Supported domains: ${getSupportedDomains().join(", ")}`),
      );
      process.exit(1);
    }

    const engramName = name || getEngramName(parsed.repo);
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    if (isGlobal) {
      const targetDir = path.join(paths.global, engramName);
      return handleAdd({ parsed, engramName, projectRoot, targetDir, isGlobal, clone, force, noCache });
    }

    if (!projectRoot) {
      console.error(pc.red("Error: Not in a project directory"));
      console.error(
        pc.dim(
          "Use --global to install globally, or run from a git repository",
        ),
      );
      process.exit(1);
    }

    const targetDir = path.join(paths.local!, engramName);
    return handleAdd({ parsed, engramName, projectRoot, targetDir, isGlobal, clone, force, noCache });
  },
});

interface AddParams {
  parsed: ReturnType<typeof parseRepoUrl> & {};
  engramName: string;
  projectRoot: string | null;
  targetDir: string;
  isGlobal: boolean;
  clone: boolean;
  force: boolean;
  noCache: boolean;
}

async function handleAdd({ parsed, engramName, projectRoot, targetDir, isGlobal, clone, force, noCache }: AddParams) {
  // Force clean any existing submodule state (handles broken/partial submodules)
  if (force && !isGlobal && projectRoot) {
    const relativePath = path.relative(projectRoot, targetDir);
    // Deinit submodule - may not be initialized, that's ok
    Bun.spawnSync(["git", "submodule", "deinit", "-f", relativePath], {
      cwd: projectRoot,
    });
    // Remove from index - may not be in index, that's ok
    Bun.spawnSync(["git", "rm", "-f", relativePath], {
      cwd: projectRoot,
    });
    // Find the actual git dir (handles nested submodules)
    const dotGitPath = path.join(projectRoot, ".git");
    const gitDir = resolveGitDir(projectRoot, dotGitPath);
    // Clean up modules directory
    const gitModulesPath = path.join(gitDir, "modules", relativePath);
    if (fs.existsSync(gitModulesPath)) {
      fs.rmSync(gitModulesPath, { recursive: true, force: true });
    }
    // Remove directory if exists
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    console.log(
      pc.yellow(`Cleaned up existing engram state for ${engramName}`),
    );
  }

  if (fs.existsSync(targetDir)) {
    console.error(pc.red(`Error: Engram already exists at ${targetDir}`));
    console.error(pc.dim("Use --force to overwrite"));
    process.exit(1);
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(targetDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  console.log(
    pc.blue(`Adding ${parsed.owner}/${parsed.repo} as ${engramName}...`),
  );

  const cached = isCached(parsed.url);
  if (cached) {
    console.log(pc.dim("Using cached repository..."));
  }

  try {
    if (!clone && !isGlobal) {
      addAsSubmodule(parsed, projectRoot!, targetDir, force, noCache, engramName);
    } else {
      cloneDirect(parsed.url, targetDir, noCache);
    }
  } catch (error) {
    const err = error as Error & { stderr?: Buffer; status?: number };
    const errorMessage = err.message || err.stderr?.toString() || String(error);
    console.error(pc.red("Failed to add engram:"));
    console.error(pc.dim(errorMessage));
    if (err.status) {
      console.error(pc.dim(`Exit code: ${err.status}`));
    }
    process.exit(1);
  }
}

function resolveGitDir(projectRoot: string, dotGitPath: string): string {
  if (!fs.existsSync(dotGitPath) || !fs.statSync(dotGitPath).isFile()) {
    return dotGitPath;
  }
  // This repo is itself a submodule - .git is a file pointing to the real location
  const gitFileContent = fs.readFileSync(dotGitPath, "utf-8").trim();
  const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
  if (match) {
    return path.resolve(projectRoot, match[1]);
  }
  return dotGitPath;
}

function addAsSubmodule(
  parsed: NonNullable<ReturnType<typeof parseRepoUrl>>,
  projectRoot: string,
  targetDir: string,
  force: boolean,
  noCache: boolean,
  engramName: string,
) {
  const relativePath = path.relative(projectRoot, targetDir);
  if (noCache) {
    const args = ["git", "submodule", "add"];
    if (force) args.push("--force");
    args.push(parsed.url, relativePath);
    const result = Bun.spawnSync(args, { cwd: projectRoot, stdout: "inherit", stderr: "inherit" });
    if (!result.success) {
      throw new Error("git submodule add failed");
    }
  } else {
    submoduleAddFromCache(parsed.url, relativePath, projectRoot, { force });
  }
  console.log(pc.green(`✓ Added as submodule: ${targetDir}`));
  updateIndexAfterAdd(projectRoot, engramName, parsed.url);
}

function cloneDirect(url: string, targetDir: string, noCache: boolean) {
  if (noCache) {
    const result = Bun.spawnSync(["git", "clone", url, targetDir], { stdout: "inherit", stderr: "inherit" });
    if (!result.success) {
      throw new Error("git clone failed");
    }
  } else {
    cloneFromCache(url, targetDir);
  }
  console.log(pc.green(`✓ Cloned to: ${targetDir}`));
}

/**
 * Update the engram index after adding a new engram
 */
function updateIndexAfterAdd(
  projectRoot: string,
  engramName: string,
  url: string,
): void {
  const tomlPath = path.join(projectRoot, ".engrams", engramName, "engram.toml");

  if (!fs.existsSync(tomlPath)) {
    console.log(pc.dim("  No engram.toml found, skipping index update"));
    return;
  }

  const entry = parseEngramToml(tomlPath);
  if (!entry) {
    console.log(pc.dim("  Could not parse engram.toml, skipping index update"));
    return;
  }

  entry.url = url;

  // Read existing index or create new one
  const index = readIndex(projectRoot) || {};
  index[engramName] = entry;

  writeIndex(projectRoot, index);
  console.log(pc.dim("  Updated refs/engrams/index"));
}
