#!/usr/bin/env node
import { run, subcommands } from "cmd-ts";
import { add } from "./commands/add";
import { list } from "./commands/list";
import { remove } from "./commands/remove";
import { cache } from "./commands/cache";
import { init } from "./commands/init";
import { sync } from "./commands/sync";
import { lazyInit, showIndex } from "./commands/lazy";
import { wrap } from "./commands/wrap";
import { preview } from "./commands/preview";
import { chain } from "./commands/chain";
import { error } from "../logging";

// cmd-ts calls process.exit(1) for --help, override to exit 0
const isHelp = process.argv.includes("--help") || process.argv.includes("-h");
if (isHelp) {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    originalExit(0);
  }) as typeof process.exit;
}

const app = subcommands({
  name: "engram",
  description: "CLI tool for managing engrams",
  version: "0.1.0",
  cmds: {
    init,
    add,
    wrap,
    list,
    preview,
    chain,
    remove,
    cache,
    sync,
    "lazy-init": lazyInit,
    "show-index": showIndex,
  },
});

run(app, process.argv.slice(2)).catch((e) => {
  error(e);
  process.exit(1);
});
