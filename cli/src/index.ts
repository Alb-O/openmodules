#!/usr/bin/env node
import { run, subcommands } from "cmd-ts";
import { add } from "./commands/add";
import { list } from "./commands/list";
import { remove } from "./commands/remove";
import { cache } from "./commands/cache";

const app = subcommands({
  name: "openmodule",
  description: "CLI tool for managing openmodules",
  version: "0.1.0",
  cmds: {
    add,
    list,
    remove,
    cache,
  },
});

run(app, process.argv.slice(2));
