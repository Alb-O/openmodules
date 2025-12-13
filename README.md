# openmodules

Discovers modules and exposes each as a tool named `openmodule_<name>`. The plugin scans two locations in priority order: `$XDG_CONFIG_HOME/openmodules` (or `~/.config/openmodules`) for global modules, and `<project>/.openmodules/` for project-local modules. Later paths override earlier ones when tool names collide.

When a module tool is invoked, the plugin injects the module content into the session. It also generates a flat listing of absolute file paths within the module directory, making scripts directly executable without path confusion.

## Design Philosophy

Each openmodule is a standalone git repository. This enables:

- Version control and history for each module
- Easy sharing via `git clone` or `git submodule add`
- Independent versioning and updates

**Naming convention**: We recommend prefixing repository names with `om.` for organizational and filtering purposes (e.g., `om.database-tools`, `om.deploy-scripts`).

## Installation

### As a project-local module

```bash
# Clone directly into your project's .openmodules directory
git clone https://github.com/user/om.my-module .openmodules/my-module

# Or add as a submodule for version tracking
git submodule add https://github.com/user/om.my-module .openmodules/my-module
```

### As a global module

```bash
# Clone into your global modules directory
git clone https://github.com/user/om.my-module ~/.config/openmodules/my-module
```

## Module Structure

Each module is a directory containing an `openmodule.toml` manifest:

```
my-module/
├── openmodule.toml         # Required - module manifest
├── README.md               # Default prompt file (injected into agent context)
├── .ignore                 # Optional - gitignore-style file filtering
└── scripts/
    ├── .oneliner.txt       # Directory description
    └── backup.sh           # Scripts, tools, references, etc.
```

### `openmodule.toml`

The module manifest:

```toml
name = "my-module"
version = "0.1.0"
description = "Short description for tool listing"

# Optional: custom prompt file path (relative to module root)
# Defaults to "README.md"
prompt = "docs/AGENT.md"

[author]
name = "Your Name"
url = "https://github.com/you"

# Optional: trigger configuration for progressive module discovery
[triggers]
user-msg = ["database backup", "backup script", "db dump"]
```

### Context Triggers

Modules can specify triggers that control when they become "visible" (shown in available tools list). Discovery is progressive: module tools stay hidden until a trigger matches; modules without triggers remain always visible.

The `[triggers]` section supports three arrays for fine-grained control:

- `user-msg` - triggers that only match user messages (most common)
- `agent-msg` - triggers that only match agent/AI messages and tool output
- `any-msg` - triggers that match any message regardless of source

```toml
[triggers]
# Common case: activate when user mentions these phrases
user-msg = ["docstring{s,}", "documentation"]

# Activate when AI mentions file types (e.g., in directory listings)
agent-msg = [".pdf", "pdf document"]

# Activate on any mention, regardless of source
any-msg = ["database backup"]
```

Trigger patterns use git-style globs (including brace expansion), so `docstring{s,}` matches both `docstring` and `docstrings`. Patterns without wildcards (`*`, `?`, or character classes) only match whole words separated by non-alphanumeric boundaries (spaces, `_`, `-`, punctuation). Add a wildcard when you need substring matching.

### Prompt File

By default, `README.md` at the module root is injected into the agent context when the module is invoked. Override this with the `prompt` field in the manifest:

```toml
prompt = "docs/instructions.md"      # Use a docs subdirectory
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
/home/user/.config/openmodules/my-module/scripts/  # Shell scripts for automation
/home/user/.config/openmodules/my-module/scripts/backup.sh  # Database backup utilities
/home/user/.config/openmodules/my-module/data/config.json
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

The `openmodule.toml`, `.ignore`, and `.oneliner` files are excluded from listings by default.

## Nested Modules

Modules can contain other modules by placing `openmodule.toml` files in subdirectories. The directory hierarchy defines the logical organization—no additional configuration is needed.

```
parent-module/
├── openmodule.toml           # Parent module
├── README.md
└── child-module/
    ├── openmodule.toml       # Nested child module
    └── README.md
```

### Visibility Rules

Nested modules follow a strict visibility constraint: **a child module is only visible when its parent module is visible**. This creates a natural progressive discovery flow:

1. Parent module becomes visible (via trigger match or always-visible)
2. Child modules can now become visible (via their own triggers or always-visible)
3. Grandchildren require both parent and grandparent to be visible, etc.

This prevents child modules from appearing in isolation without their parent context.

### Tool Naming

Nested modules get tool names that reflect their full path:

- `parent-module/openmodule.toml` → `openmodule_parent_module`
- `parent-module/child-module/openmodule.toml` → `openmodule_parent_module_child_module`
- `parent-module/child-module/grandchild/openmodule.toml` → `openmodule_parent_module_child_module_grandchild`

### Example: Layered Documentation

```
docs/
├── openmodule.toml           # triggers: ["documentation", "docs"]
├── README.md                 # General documentation guidelines
├── api/
│   ├── openmodule.toml       # triggers: ["api", "endpoint"]
│   └── README.md             # API documentation specifics
└── tutorials/
    ├── openmodule.toml       # triggers: ["tutorial", "guide"]
    └── README.md             # Tutorial writing guidelines
```

When a user mentions "documentation", the parent `docs` module becomes visible. If they then mention "api", the `docs/api` child module also becomes visible. The `tutorials` module remains hidden until its trigger matches.
