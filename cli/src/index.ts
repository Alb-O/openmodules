#!/usr/bin/env node
import { run, subcommands } from "cmd-ts";
import { add } from "./commands/add";
import { list } from "./commands/list";
import { remove } from "./commands/remove";
import { cache } from "./commands/cache";
import { init } from "./commands/init";

const app = subcommands({
  name: "engram",
  description: "CLI tool for managing engrams",
  version: "0.1.0",
  cmds: {
    init,
    add,
    list,
    remove,
    cache,
  },
});

run(app, process.argv.slice(2));
