# ast-grep Lint Rule Recommendations

Project-specific recommendations for additional ast-grep rules in the engrams codebase.

## Current Rules (7)

| Rule                      | Severity | Purpose                                                |
| ------------------------- | -------- | ------------------------------------------------------ |
| `prefer-bun-spawn`        | warning  | Use `Bun.spawnSync` over `child_process` (60% faster)  |
| `prefer-bun-file`         | warning  | Use `Bun.file().text()` over `fs.readFile` (2x faster) |
| `prefer-bun-write`        | warning  | Use `Bun.write()` over `fs.writeFile` (2x faster)      |
| `prefer-bun-hash`         | warning  | Use `Bun.CryptoHasher` over `crypto.createHash`        |
| `no-swallowed-error`      | error    | Catch blocks must handle errors explicitly             |
| `no-await-in-promise-all` | error    | Don't `await` inside `Promise.all` array               |
| `no-any-type`             | warning  | Use `unknown` instead of `any`                         |

______________________________________________________________________

## Recommended New Rules

### High Priority

#### 1. `no-unhandled-spawn-error`

**Severity:** error\
**Rationale:** The codebase uses `Bun.spawnSync` extensively (20+ usages). While most check `result.success`, some paths may not handle stderr properly.

```typescript
// Bad - ignores failure
const result = Bun.spawnSync(['git', 'status'], { cwd });
const output = result.stdout.toString();

// Good - checks success
const result = Bun.spawnSync(['git', 'status'], { cwd });
if (!result.success) {
  throw new Error(`git failed: ${result.stderr?.toString()}`);
}
```

**Pattern:** Match `Bun.spawnSync` calls where `result.success` is not checked.

______________________________________________________________________

#### 2. `prefer-bun-glob`

**Severity:** warning\
**Rationale:** Bun has a native `Bun.Glob` class that's faster than npm glob packages. Currently not used in the codebase but would be useful for file discovery.

```typescript
// Bad
import { glob } from 'glob';
const files = await glob('**/*.ts');

// Good
const glob = new Bun.Glob('**/*.ts');
for await (const file of glob.scan('.')) { }
```

**Pattern:** Match imports from `glob`, `fast-glob`, `globby`.

______________________________________________________________________

#### 3. `no-console-in-library`

**Severity:** warning\
**Rationale:** The `src/index.ts` (library code) should use the logging module, not `console.*` directly. CLI code (`src/cli/`) is exempt since it's user-facing.

```typescript
// Bad (in src/index.ts, src/manifest.ts, etc.)
console.log('debug info');

// Good - use logging module
import { log } from './logging';
log.debug('debug info');
```

**Pattern:** Match `console.log|warn|error` in files under `src/` but not `src/cli/`.

______________________________________________________________________

### Medium Priority

#### 4. `prefer-for-of`

**Severity:** warning\
**Rationale:** Found 2 C-style `for` loops in the codebase. Modern `for-of` is cleaner when index isn't needed for mutation.

```typescript
// Bad (when index not needed)
for (let i = 0; i < arr.length; i++) {
  console.log(arr[i]);
}

// Good
for (const item of arr) {
  console.log(item);
}
```

**Note:** Only flag when the index variable is used solely for array access, not modification.

______________________________________________________________________

#### 5. `no-process-exit-in-library`

**Severity:** error\
**Rationale:** Found 35+ `process.exit()` calls, all in CLI code (correct). This rule would prevent accidental `process.exit()` in library code.

```typescript
// Bad (in src/index.ts, src/manifest.ts)
if (error) process.exit(1);

// Good - throw instead
if (error) throw new Error('...');
```

**Pattern:** Match `process.exit` in files under `src/` but not `src/cli/`.

______________________________________________________________________

#### 6. `prefer-error-cause`

**Severity:** warning\
**Rationale:** When rethrowing errors, use the `cause` option to preserve the stack trace.

```typescript
// Bad - loses original stack
try { ... } catch (e) {
  throw new Error('Failed to process');
}

// Good - preserves cause
try { ... } catch (e) {
  throw new Error('Failed to process', { cause: e });
}
```

______________________________________________________________________

### Low Priority (Future Consideration)

#### 7. `prefer-node-protocol`

**Severity:** warning\
**Rationale:** Most imports already use `node:` protocol (13 usages). Enforce consistency.

```typescript
// Bad
import path from 'path';
import { readFile } from 'fs/promises';

// Good
import path from 'node:path';
import { readFile } from 'node:fs/promises';
```

______________________________________________________________________

#### 8. `no-nested-ternary`

**Severity:** warning\
**Rationale:** Nested ternaries are hard to read.

```typescript
// Bad
const x = a ? b : c ? d : e;

// Good
let x;
if (a) x = b;
else if (c) x = d;
else x = e;
```

______________________________________________________________________

## Rules NOT Recommended

These rules were considered but are not suitable for this project:

| Rule                        | Reason                                                   |
| --------------------------- | -------------------------------------------------------- |
| `prefer-bun-sleep`          | No `setTimeout` Promise patterns found in codebase       |
| `prefer-bun-which`          | No `which` package usage found                           |
| `prefer-bun-shell`          | `Bun.spawnSync` is appropriate for the git commands used |
| `prefer-bun-password`       | No password hashing in this project                      |
| `prefer-bun-stringWidth`    | No terminal string width calculations                    |
| `prefer-bun-escapeHTML`     | No HTML escaping needed                                  |
| `no-throw-literal`          | All throws already use `new Error()` (good!)             |
| `prefer-optional-chain`     | Already using optional chaining throughout               |
| `prefer-nullish-coalescing` | Already using `??` operator throughout                   |
| `prefer-includes`           | No `indexOf !== -1` patterns found                       |
| `prefer-find`               | No `.filter()[0]` patterns found                         |

______________________________________________________________________

## Implementation Notes

### Rule Complexity

| Rule                         | Complexity | Notes                       |
| ---------------------------- | ---------- | --------------------------- |
| `prefer-bun-glob`            | Easy       | Simple import detection     |
| `no-console-in-library`      | Medium     | Need file path filtering    |
| `prefer-for-of`              | Hard       | Need to analyze index usage |
| `no-unhandled-spawn-error`   | Hard       | Control flow analysis       |
| `no-process-exit-in-library` | Medium     | File path filtering         |
| `prefer-error-cause`         | Medium     | Detect rethrow patterns     |
| `prefer-node-protocol`       | Easy       | Simple import detection     |
| `no-nested-ternary`          | Easy       | Syntax pattern              |

### Suggested Implementation Order

1. `prefer-bun-glob` - Easy win, promotes Bun APIs
1. `prefer-node-protocol` - Easy, enforces consistency
1. `no-console-in-library` - Medium, improves library quality
1. `no-process-exit-in-library` - Medium, prevents bugs
1. `prefer-error-cause` - Medium, improves debugging
1. `no-nested-ternary` - Easy, improves readability

______________________________________________________________________

## Testing

All rules should have corresponding test files in `lint/tests/`. Run tests with:

```bash
nix develop -c ast-grep test --skip-snapshot-tests
```
