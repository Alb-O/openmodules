# openskills

Discovers `SKILL.md` files following Anthropic's Agent Skills spec and exposes each as a tool named `skills_<path>`. The plugin scans three locations in priority order: `$XDG_CONFIG_HOME/opencode/skills` (or `~/.config/opencode/skills`), `~/.opencode/skills/`, and `<project>/.opencode/skills/`. Later paths override earlier ones when tool names collide.

When a skill tool is invoked, the plugin injects the skill content into the session via `noReply` prompts. It also generates a flat listing of absolute file paths within the skill directory, making scripts directly executable without path confusion.

## Installation

```bash
bun add openskills
```

## File Descriptions

Files can declare a short description by including `skill-part:` anywhere in the first 10 lines. The marker works inside any comment syntax:

```bash
#!/bin/bash
# skill-part: Database backup utilities
```

```python
# skill-part: Data processing module
```

```html
<!-- skill-part: Documentation templates -->
```

Directories use a `.skill-part` or `.skill-part.txt` file containing raw description text. These files are hidden from the output listing.

The resulting file list appears in the agent context as:

```
/home/user/.opencode/skills/my-skill/scripts/  # Shell scripts for automation
/home/user/.opencode/skills/my-skill/scripts/backup.sh  # Database backup utilities
/home/user/.opencode/skills/my-skill/utils/process.py  # Data processing module
```

## Filtering Files

Place a `.ignore` file in the skill root to exclude paths from the listing. Standard gitignore syntax applies, including wildcards and negation patterns.

```
# .ignore
*.log
secrets/
node_modules/
!important.log
```

`SKILL.md`, `.ignore`, and `.skill-part` files are excluded by default.
