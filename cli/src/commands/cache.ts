import { command, subcommands, flag, positional, string, optional } from "cmd-ts";
import pc from "picocolors";
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
      console.log(pc.dim("No cached repositories"));
      console.log(pc.dim(`Cache directory: ${getCacheDir()}`));
      return;
    }

    console.log(pc.bold("Cached repositories:\n"));

    let totalSize = 0;
    for (const repo of cached) {
      totalSize += repo.size;
      console.log(`  ${pc.cyan(repo.url)}`);
      console.log(`    ${pc.dim(formatBytes(repo.size))}`);
    }

    console.log("");
    console.log(pc.dim(`Total: ${cached.length} repos, ${formatBytes(totalSize)}`));
    console.log(pc.dim(`Cache directory: ${getCacheDir()}`));
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
      console.log(pc.dim("Cache is already empty"));
      return;
    }

    const totalSize = cached.reduce((sum, r) => sum + r.size, 0);

    if (!force) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(
          pc.yellow(`Clear ${cached.length} cached repos (${formatBytes(totalSize)})? [y/N] `),
          resolve
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        console.log(pc.dim("Cancelled"));
        return;
      }
    }

    clearRepoCache();
    console.log(pc.green(`✓ Cleared ${cached.length} repos (${formatBytes(totalSize)})`));
  },
});

const update = command({
  name: "update",
  description: "Update all cached repositories",
  args: {},
  handler: async () => {
    const cached = listCachedRepos();

    if (cached.length === 0) {
      console.log(pc.dim("No cached repositories to update"));
      return;
    }

    console.log(pc.blue(`Updating ${cached.length} cached repositories...`));

    for (const repo of cached) {
      try {
        console.log(pc.dim(`  Fetching ${repo.url}...`));
        ensureCached(repo.url, { quiet: true });
      } catch (error) {
        console.log(pc.yellow(`  Failed to update ${repo.url}`));
      }
    }

    console.log(pc.green(`✓ Updated ${cached.length} repos`));
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
      console.error(pc.red(`Error: Invalid repository format: ${repo}`));
      process.exit(1);
    }

    if (removeRepoFromCache(parsed.url)) {
      console.log(pc.green(`✓ Removed ${parsed.url} from cache`));
    } else {
      console.log(pc.yellow(`Repository not in cache: ${parsed.url}`));
    }
  },
});

const path_cmd = command({
  name: "path",
  description: "Show cache directory path",
  args: {},
  handler: async () => {
    console.log(getCacheDir());
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
