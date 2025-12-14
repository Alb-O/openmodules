import { command, positional, flag, option, string, optional } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { info, success, warn, fail } from "../../logging";
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
import { ENGRAMS_DIR, MANIFEST_FILENAME } from "../../constants";

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
      fail(`Invalid repository format: ${repo}`);
      info(`Formats: owner/repo, domain:owner/repo, or full URL`);
      info(`Supported domains: ${getSupportedDomains().join(", ")}`);
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
      fail("Not in a project directory");
      info("Use --global to install globally, or run from a git repository");
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
  if (force && !isGlobal && projectRoot) {
    const relativePath = path.relative(projectRoot, targetDir);
    Bun.spawnSync(["git", "submodule", "deinit", "-f", relativePath], {
      cwd: projectRoot,
    });
    Bun.spawnSync(["git", "rm", "-f", relativePath], {
      cwd: projectRoot,
    });
    const dotGitPath = path.join(projectRoot, ".git");
    const gitDir = resolveGitDir(projectRoot, dotGitPath);
    const gitModulesPath = path.join(gitDir, "modules", relativePath);
    if (fs.existsSync(gitModulesPath)) {
      fs.rmSync(gitModulesPath, { recursive: true, force: true });
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    warn(`Cleaned up existing engram state for ${engramName}`);
  }

  if (fs.existsSync(targetDir)) {
    fail(`Engram already exists at ${targetDir}`);
    info("Use --force to overwrite");
    process.exit(1);
  }

  const parentDir = path.dirname(targetDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  info(`Adding ${parsed.owner}/${parsed.repo} as ${engramName}...`);

  const cached = isCached(parsed.url);
  if (cached) {
    info("Using cached repository...");
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
    fail("Failed to add engram");
    info(errorMessage);
    if (err.status) {
      info(`Exit code: ${err.status}`);
    }
    process.exit(1);
  }
}

function resolveGitDir(projectRoot: string, dotGitPath: string): string {
  if (!fs.existsSync(dotGitPath) || !fs.statSync(dotGitPath).isFile()) {
    return dotGitPath;
  }
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
  success(`Added as submodule: ${targetDir}`);
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
  success(`Cloned to: ${targetDir}`);
}

/**
 * Update the engram index after adding a new engram
 */
function updateIndexAfterAdd(
  projectRoot: string,
  engramName: string,
  url: string,
): void {
  const tomlPath = path.join(projectRoot, ENGRAMS_DIR, engramName, MANIFEST_FILENAME);

  if (!fs.existsSync(tomlPath)) {
    info(`No ${MANIFEST_FILENAME} found, skipping index update`);
    return;
  }

  const entry = parseEngramToml(tomlPath);
  if (!entry) {
    info(`Could not parse ${MANIFEST_FILENAME}, skipping index update`);
    return;
  }

  entry.url = url;

  const index = readIndex(projectRoot) || {};
  index[engramName] = entry;

  writeIndex(projectRoot, index);
  info("Updated refs/engrams/index");
}
