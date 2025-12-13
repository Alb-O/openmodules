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

const app = subcommands({
  name: "engram",
  description: "CLI tool for managing engrams",
  version: "0.1.0",
  cmds: {
    init,
    add,
    wrap,
    list,
    remove,
    cache,
    sync,
    "lazy-init": lazyInit,
    "show-index": showIndex,
  },
});

run(app, process.argv.slice(2));
