## Code Style

- Prefer early returns over `else`; prefer null returns over `try`/`catch`; prefer `const` over `let`; avoid `any`
- Prefer single-word variable names
- Prefer Bun APIs (`Bun.file()`, `Bun.spawnSync()`, etc.)
- Avoid trivial comments restating code

## Architecture

Tools surface to agents in two phases. Disclosure reveals the tool name and description so the agent can decide whether to invoke it. Activation injects content directly via `client.session.prompt({ noReply: true })` without agent action. Triggers in `engram.toml` control when each phase fires based on message content matching.

The plugin hooks into `chat.message` and maintains per-session state (`sessionDisclosed`, `sessionActivated` Maps keyed by session ID). Each message triggers re-evaluation of all matchers against extracted user/agent text. Tool visibility is controlled by mutating `output.message.tools` with a boolean map where `engram_*` defaults false and individual tools are enabled based on disclosed state.

Parent-child relationships are derived from directory nesting. `establishEngramHierarchy()` in `discovery.ts` walks ancestor paths to find the closest parent engram. A child tool only becomes visible if its entire parent chain is disclosed, preventing deep engrams from appearing before their context is established.

Engrams can exist as uncloned git submodule stubs. Index metadata lives in `refs/engrams/index` as a JSON blob stored via `git hash-object -w --stdin` and `git update-ref`. Discovery reads it with `git cat-file -p refs/engrams/index`. This allows trigger matching and tool registration before submodules are cloned. `engram lazy-init` materializes a stub on demand.

Triggers compile from a custom glob-to-regex system in `src/core/triggers.ts`. `expandBraces()` recursively expands `{a,b}` into alternations. `globFragmentToRegex()` converts `*`, `?`, `[abc]` to regex equivalents. Non-wildcard patterns get word boundary enforcement via `(?:^|[^A-Za-z0-9])` anchors. Bare `*` sets `alwaysMatch: true` and skips regex compilation entirely.

`engram wrap` clones external repos into a `content/` subdirectory with optional git sparse-checkout (`--sparse 'docs/**/*.md'`). The `--lock` flag records the exact commit SHA in the index for reproducibility. Wrapped repos are gitignored so only the manifest travels with the project.

File tree generation (`src/tree/file-tree.ts`) uses the `ignore` npm package to parse `.ignore` files with gitignore syntax. When `maxFiles` truncates output, entries with oneliners are prioritized over bare paths. Oneliner sources (priority order): manifest `oneliners` table, inline `# oneliner:` marker in first 10 lines, `.oneliner` file in directory.

## Key Patterns

Tool names are generated from directory paths relative to the engrams base: `engram_foo_bar` for `.engrams/foo/bar/`. The `generateToolName()` function in `manifest.ts` normalizes hyphens to underscores.

Git operations use `Bun.spawnSync()` with three wrappers in `src/cli/index-ref.ts`: `git()` returns stdout or null on failure, `gitOk()` returns boolean success, `gitExec()` throws with command context on failure. Use the appropriate wrapper based on whether failure is expected.

The CLI uses `cmd-ts` for type-safe argument parsing. Multi-value options use `multioption({ type: array(string) })`. Commands live in `src/cli/commands/` and are assembled in `src/cli/index.ts`.

## Build Outputs

`bun run build` produces 3 artifacts: `dist/index.js` (plugin entry), `dist/engrams.bundle.js` (minified bundle with `zod` and `@opencode-ai/plugin` external), `dist/engram` (compiled CLI binary via `--compile`).

## Lint

AST-grep rules live in `lint/rules/*.yml`, tests in `lint/tests/*-test.yml`. Run `ast-grep scan` to lint, `ast-grep test -c sgconfig.yml -U` to run tests with snapshot updates. Suppress inline with `// ast-grep-ignore: rule-id`.

## Error Philosophy

Safe operations return `null` on failure rather than throwing. `safeStat()`, `safeRealpath()`, `safeReaddir()` patterns appear throughout. Partial failures are tolerated so remaining engrams continue working.
