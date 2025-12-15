# Engrams

The next evolution of skills. Engrams is an OpenCode plugin and a CLI tool for turning mini repositories of docs, scripts, and references into lazy-loaded agent tools.

The plugin exposes on-demand tools to the agent, and invoking it injects the engram's README prompt plus a list of contained file paths.

Engrams are discovered from two locations in priority order: `$XDG_CONFIG_HOME/engrams` (or `~/.config/engrams`) for global engrams, and `<project>/.engrams/` for project-local engrams; later paths override earlier ones when tool names collide.

Use the `engram` CLI to create, wrap, and manage engrams (including lazy mode via `engram wrap --lazy` and `engram lazy-init`).

## Design Philosophy

An engram is a directory containing an `engram.toml` manifest.

In practice, we recommend keeping each engram in its own git repository (a submodule inside your own project repo) so it can be versioned and shared as a modular bundle of useful agent goodies.

**Naming convention**: We recommend prefixing repository names with `eg.` for organizational and filtering purposes (e.g., `eg.database-tools`, `eg.deploy-scripts`).

## Installation

### As a project-local engram

```bash
# Clone directly into your project's .engrams directory
git clone https://github.com/user/eg.my-engram .engrams/my-engram

# Or add as a submodule for version tracking
git submodule add https://github.com/user/eg.my-engram .engrams/my-engram
```

### As a global engram

```bash
# Clone into your global engrams directory
git clone https://github.com/user/eg.my-engram ~/.config/engrams/my-engram
```

## Engram Structure

Each engram is a directory containing an `engram.toml` manifest:

```
my-engram/
├── engram.toml         # Required - engram manifest
├── README.md           # Default prompt file (injected into agent context)
├── .ignore             # Optional - gitignore-style file filtering
└── scripts/
    ├── .oneliner.txt   # Directory description
    └── backup.sh       # Scripts, tools, references, etc.
```

### `engram.toml`

The engram manifest:

```toml
name = "my-engram"
version = "0.1.0"
description = "Short description for tool listing"

# Optional: custom prompt file path (relative to engram root)
# Defaults to "README.md"
prompt = "docs/prompt.md"

[author]
name = "Your Name"
url = "https://github.com/you"

# Optional: trigger configuration for progressive engram discovery
[triggers]
user-msg = ["database backup", "backup script", "db dump"]
```

### Context Triggers

Engrams can specify triggers that control when they become "visible" (shown in available tools list). Discovery is progressive: engram tools stay hidden until a trigger matches; engrams without triggers remain always visible.

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

By default, `README.md` at the engram root is injected into the agent context when the engram is invoked. Override this with the `prompt` field in the manifest:

```toml
prompt = "docs/prompt.md"    # Use a docs subdirectory
```

## File Descriptions

Files can declare a short description by including `oneliner:` anywhere in the first 10 lines. The marker works inside any comment syntax:

```bash
#!/bin/bash
# oneliner: Database backup utilities
```

```python
# oneliner: Data processing engram
```

```html
<!-- oneliner: Documentation templates -->
```

Directories use a `.oneliner` or `.oneliner.txt` file containing raw description text. These files are hidden from the output listing.

The resulting file list appears in the agent context as:

```
~/.config/engrams/my-engram/scripts/  # Shell scripts for automation
~/.config/engrams/my-engram/scripts/backup.sh  # Database backup utilities
~/.config/engrams/my-engram/data/config.json
```

## Filtering Files

Place a `.ignore` file in the engram root to exclude paths from the listing. Standard gitignore syntax applies, including wildcards and negation patterns.

```
# .ignore
*.log
secrets/
node_modules/
!important.log
```

The `engram.toml`, `.ignore`, and `.oneliner` files are excluded from listings by default.

## Nested Engrams

Engrams can contain other engrams by placing `engram.toml` files in subdirectories. The directory hierarchy defines the logical organization—no additional configuration is needed.

```
parent/
├── engram.toml           # Parent engram
├── README.md
└── child/
    ├── engram.toml       # Nested child engram
    └── README.md
```

### Visibility Rules

Nested engrams follow a strict visibility constraint: **a child engram is only visible when its parent engram is visible**. This creates a natural progressive discovery flow:

1. Parent engram becomes visible (via trigger match or always-visible)
1. Child engrams can now become visible (via their own triggers or always-visible)
1. Grandchildren require both parent and grandparent to be visible, etc.

This prevents child engrams from appearing in isolation without their parent context.

### Tool Naming

Nested engrams get tool names that reflect their full path:

- `parent/engram.toml` → `engram_parent`
- `parent/child/engram.toml` → `engram_parent_child`
- `parent/child/grandchild/engram.toml` → `engram_parent_child_grandchild`

### Example: Layered Documentation

```
docs/
├── engram.toml           # triggers: ["documentation", "docs"]
├── README.md             # General documentation guidelines
├── api/
│   ├── engram.toml       # triggers: ["api", "endpoint"]
│   └── README.md         # API documentation specifics
└── tutorials/
    ├── engram.toml       # triggers: ["tutorial", "guide"]
    └── README.md         # Tutorial writing guidelines
```

When a user mentions "documentation", the parent `docs` engram becomes visible. If they then mention "api", the `docs/api` child engram also becomes visible. The `tutorials` engram remains hidden until its trigger matches.

## Wrapping External Repositories

The `engram wrap` command creates engrams from external repositories with sparse-checkout support. This is useful for pulling in documentation or reference material from third-party projects.

### Basic Usage

```bash
# Wrap a repo with sparse-checkout (only docs)
engram wrap oven-sh/bun --name "Bun Docs" --sparse 'docs/**/*.md'

# Wrap with multiple patterns
engram wrap cli/cli --sparse 'docs/**/*.md' --sparse '*.md' --as gh-cli

# Wrap a specific ref (branch, tag, or commit)
engram wrap owner/repo --ref v1.0.0 --sparse 'docs/**'
```

### Lazy Mode

For version control, use `--lazy` to create just the manifest without cloning. The content is fetched on first use:

```bash
# Create manifest only (no clone)
engram wrap oven-sh/bun --name "Bun Docs" --sparse 'docs/**/*.md' --lazy

# Later, initialize the content
engram lazy-init bun
```

Lazy engrams commit only the manifest files to git. The cloned content is gitignored and fetched on demand.

### Structure

Wrapped engrams use a `content/` subdirectory for cloned content, keeping manifest files separate:

```
.engrams/bun/
├── engram.toml     # Tracked by your project's git
├── README.md       # Tracked by your project's git
├── .gitignore      # Ignores content/ (lazy mode only)
└── content/        # The cloned repo lives here
    ├── .git/
    └── docs/
```

### Wrap Configuration

The manifest includes a `[wrap]` section for lazy initialization:

```toml
name = "Bun Docs"
version = "1.0.0"
description = "Documentation from oven-sh/bun"

[wrap]
remote = "https://github.com/oven-sh/bun.git"
ref = "main"
sparse = ["docs/**/*.md"]

[triggers]
user-msg = ["bun", "bunx"]
```
