# openmodules

Discovers `MODULE.md` files following Anthropic's Agent Modules spec and exposes each as a tool named `modules_<path>`. The plugin scans three locations in priority order: `$XDG_CONFIG_HOME/opencode/modules` (or `~/.config/opencode/modules`), `~/.opencode/modules/`, and `<project>/.opencode/modules/`. Later paths override earlier ones when tool names collide.

When a module tool is invoked, the plugin injects the module content into the session via `noReply` prompts. It also generates a flat listing of absolute file paths within the module directory, making scripts directly executable without path confusion.

## Installation

```bash
bun add openmodules
```

## File Descriptions

Files can declare a short description by including `oneliner:` anywhere in the first 10 lines. The marker works inside any comment syntax:

```bash
#!/bin/bash
# oneliner: Database backup utilities
```

```python
# oneliner: Data processing module
```

```html
<!-- oneliner: Documentation templates -->
```

Directories use a `.oneliner` or `.oneliner.txt` file containing raw description text. These files are hidden from the output listing.

The resulting file list appears in the agent context as:

```
/home/user/.opencode/modules/my-module/scripts/  # Shell scripts for automation
/home/user/.opencode/modules/my-module/scripts/backup.sh  # Database backup utilities
/home/user/.opencode/modules/my-module/utils/process.py  # Data processing module
```

## Filtering Files

Place a `.ignore` file in the module root to exclude paths from the listing. Standard gitignore syntax applies, including wildcards and negation patterns.

```
# .ignore
*.log
secrets/
node_modules/
!important.log
```

`MODULE.md`, `.ignore`, and `.oneliner` files are excluded by default.
