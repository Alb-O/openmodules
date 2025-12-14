import {
  command,
  subcommands,
  flag,
  positional,
  string,
} from "cmd-ts";
import * as readline from "node:readline";
import { info, success, warn, fail, log } from "../../logging";
import {
  getCacheDir,
  listCachedRepos,
  clearRepoCache,
  removeRepoFromCache,
  ensureCached,
  formatBytes,
} from "../cache";
import { parseRepoUrl } from "../utils";

const list = command({
  name: "list",
  description: "List cached repositories",
  args: {},
  handler: async () => {
    const cached = listCachedRepos();

    if (cached.length === 0) {
      info("No cached repositories");
      info(`Cache directory: ${getCacheDir()}`);
      return;
    }

    log("Cached repositories:\n");

    let totalSize = 0;
    for (const repo of cached) {
      totalSize += repo.size;
      log(`  ${repo.url}`);
      info(`    ${formatBytes(repo.size)}`);
    }

    log("");
    info(`Total: ${cached.length} repos, ${formatBytes(totalSize)}`);
    info(`Cache directory: ${getCacheDir()}`);
  },
});

const clear = command({
  name: "clear",
  description: "Clear all cached repositories",
  args: {
    force: flag({
      long: "force",
      short: "f",
      description: "Skip confirmation",
    }),
  },
  handler: async ({ force }) => {
    const cached = listCachedRepos();

    if (cached.length === 0) {
      info("Cache is already empty");
      return;
    }

    const totalSize = cached.reduce((sum, r) => sum + r.size, 0);

    if (!force) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `Clear ${cached.length} cached repos (${formatBytes(totalSize)})? [y/N] `,
          resolve,
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        info("Cancelled");
        return;
      }
    }

    clearRepoCache();
    success(`Cleared ${cached.length} repos (${formatBytes(totalSize)})`);
  },
});

const update = command({
  name: "update",
  description: "Update all cached repositories",
  args: {},
  handler: async () => {
    const cached = listCachedRepos();

    if (cached.length === 0) {
      info("No cached repositories to update");
      return;
    }

    info(`Updating ${cached.length} cached repositories...`);

    for (const repo of cached) {
      try {
        info(`  Fetching ${repo.url}...`);
        ensureCached(repo.url, { quiet: true });
      } catch (error) {
        warn(`  Failed to update ${repo.url}`);
      }
    }

    success(`Updated ${cached.length} repos`);
  },
});

const remove = command({
  name: "remove",
  description: "Remove a repository from cache",
  args: {
    repo: positional({
      type: string,
      displayName: "repo",
      description: "Repository URL or shorthand to remove from cache",
    }),
  },
  handler: async ({ repo }) => {
    const parsed = parseRepoUrl(repo);
    if (!parsed) {
      fail(`Invalid repository format: ${repo}`);
      process.exit(1);
    }

    if (removeRepoFromCache(parsed.url)) {
      success(`Removed ${parsed.url} from cache`);
    } else {
      warn(`Repository not in cache: ${parsed.url}`);
    }
  },
});

const path_cmd = command({
  name: "path",
  description: "Show cache directory path",
  args: {},
  handler: async () => {
    log(getCacheDir());
  },
});

export const cache = subcommands({
  name: "cache",
  description: "Manage the bare repository cache",
  cmds: {
    list,
    clear,
    update,
    remove,
    path: path_cmd,
  },
});
