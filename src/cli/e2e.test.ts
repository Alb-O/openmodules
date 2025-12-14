/**
 * End-to-end integration tests for engrams CLI.
 *
 * These tests simulate realistic workflows involving:
 * - Git repository operations (init, submodules, refs)
 * - Lazy engram configuration (wrap config without content)
 * - Index synchronization (refs/engrams/index)
 * - Trigger configuration and discovery
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readIndex,
  writeIndex,
  indexExists,
  buildIndexFromEngrams,
  parseEngramToml,
  isSubmoduleInitialized,
  getSubmoduleUrl,
} from "./index-ref";
import {
  MANIFEST_FILENAME,
  DEFAULT_PROMPT_FILENAME,
  ENGRAMS_DIR,
  CONTENT_DIR,
} from "../constants";

/**
 * Execute a git command in the given directory.
 */
function git(args: string[], cwd: string): { success: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], { cwd });
  return {
    success: result.success,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/**
 * Execute a git command, throwing on failure.
 */
function gitExec(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Create a minimal git repository with an initial commit.
 */
async function createGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  gitExec(["init"], dir);
  gitExec(["config", "user.email", "test@test.com"], dir);
  gitExec(["config", "user.name", "Test User"], dir);
  await fs.writeFile(path.join(dir, ".gitkeep"), "");
  gitExec(["add", ".gitkeep"], dir);
  gitExec(["commit", "-m", "Initial commit"], dir);
}

/**
 * Create a source repository that can be used as a remote for testing.
 * Returns the path to the bare repo.
 */
async function createSourceRepo(dir: string, files: Record<string, string>): Promise<string> {
  const workDir = path.join(dir, "work");
  const bareDir = path.join(dir, "bare.git");

  await createGitRepo(workDir);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(workDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  gitExec(["add", "-A"], workDir);
  gitExec(["commit", "-m", "Add content"], workDir);
  gitExec(["clone", "--bare", workDir, bareDir], dir);

  return bareDir;
}

/**
 * Create an engram manifest file content.
 */
function createManifest(opts: {
  name: string;
  description?: string;
  version?: string;
  disclosureTriggers?: string[];
  activationTriggers?: string[];
  wrap?: { remote: string; ref?: string; sparse?: string[]; lock?: boolean };
}): string {
  const lines = [
    `name = "${opts.name}"`,
    `version = "${opts.version || "1.0.0"}"`,
    `description = "${opts.description || "Test engram description."}"`,
  ];

  if (opts.wrap) {
    lines.push("", "[wrap]");
    lines.push(`remote = "${opts.wrap.remote}"`);
    if (opts.wrap.ref) {
      lines.push(`ref = "${opts.wrap.ref}"`);
    }
    if (opts.wrap.sparse && opts.wrap.sparse.length > 0) {
      const patterns = opts.wrap.sparse.map((p) => `"${p}"`).join(", ");
      lines.push(`sparse = [${patterns}]`);
    }
    if (opts.wrap.lock) {
      lines.push(`lock = true`);
    }
  }

  if (opts.disclosureTriggers && opts.disclosureTriggers.length > 0) {
    lines.push("", "[disclosure-triggers]");
    const triggers = opts.disclosureTriggers.map((t) => `"${t}"`).join(", ");
    lines.push(`user-msg = [${triggers}]`);
  }

  if (opts.activationTriggers && opts.activationTriggers.length > 0) {
    lines.push("", "[activation-triggers]");
    const triggers = opts.activationTriggers.map((t) => `"${t}"`).join(", ");
    lines.push(`any-msg = [${triggers}]`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Create an engram directory with manifest and README.
 */
async function createEngram(
  engramDir: string,
  opts: Parameters<typeof createManifest>[0],
  readme?: string,
): Promise<void> {
  await fs.mkdir(engramDir, { recursive: true });
  await fs.writeFile(path.join(engramDir, MANIFEST_FILENAME), createManifest(opts));
  await fs.writeFile(
    path.join(engramDir, DEFAULT_PROMPT_FILENAME),
    readme || `# ${opts.name}\n\nTest engram content.`,
  );
}

describe("e2e: Git ref-based index", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-e2e-"));
    projectDir = path.join(tempDir, "project");
    await createGitRepo(projectDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates and reads index at refs/engrams/index", async () => {
    const testIndex = {
      "test-engram": {
        name: "Test Engram",
        description: "A test engram for e2e testing",
        version: "1.0.0",
      },
    };

    expect(indexExists(projectDir)).toBe(false);
    writeIndex(projectDir, testIndex);
    expect(indexExists(projectDir)).toBe(true);

    const retrieved = readIndex(projectDir);
    expect(retrieved).toEqual(testIndex);
  });

  it("stores complex index with triggers and wrap config", async () => {
    const complexIndex = {
      "api-docs": {
        name: "API Documentation",
        description: "REST API reference",
        "disclosure-triggers": {
          "user-msg": ["api", "endpoint", "REST"],
          "agent-msg": ["fetch", "request"],
        },
        "activation-triggers": {
          "any-msg": ["api-docs"],
        },
      },
      "wrapped-lib": {
        name: "Wrapped Library",
        description: "External library documentation",
        wrap: {
          remote: "https://github.com/example/lib.git",
          ref: "main",
          sparse: ["docs/**/*.md"],
        },
      },
    };

    writeIndex(projectDir, complexIndex);
    const retrieved = readIndex(projectDir);

    expect(retrieved).toEqual(complexIndex);
    expect(retrieved?.["api-docs"]["disclosure-triggers"]?.["user-msg"]).toContain("api");
    expect(retrieved?.["wrapped-lib"].wrap?.remote).toBe("https://github.com/example/lib.git");
  });

  it("builds index from .engrams directory", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "engram-a"), {
      name: "Engram A",
      description: "First test engram",
      disclosureTriggers: ["alpha", "first"],
    });

    await createEngram(path.join(engramsDir, "engram-b"), {
      name: "Engram B",
      description: "Second test engram",
      activationTriggers: ["beta", "second"],
    });

    const builtIndex = buildIndexFromEngrams(projectDir);

    expect(Object.keys(builtIndex)).toHaveLength(2);
    expect(builtIndex["engram-a"]).toBeDefined();
    expect(builtIndex["engram-b"]).toBeDefined();
    expect(builtIndex["engram-a"].name).toBe("Engram A");
    expect(builtIndex["engram-b"].name).toBe("Engram B");
    expect(builtIndex["engram-a"]["disclosure-triggers"]?.["user-msg"]).toContain("alpha");
    expect(builtIndex["engram-b"]["activation-triggers"]?.["any-msg"]).toContain("beta");
  });

  it("parses engram.toml with wrap configuration", async () => {
    const engramDir = path.join(tempDir, "wrapped-engram");
    await fs.mkdir(engramDir, { recursive: true });

    const manifest = createManifest({
      name: "Wrapped Docs",
      description: "Documentation from external repo",
      wrap: {
        remote: "https://github.com/owner/repo.git",
        ref: "v2.0.0",
        sparse: ["docs/**", "examples/**"],
        lock: true,
      },
      disclosureTriggers: ["docs", "documentation"],
    });

    await fs.writeFile(path.join(engramDir, MANIFEST_FILENAME), manifest);

    const entry = parseEngramToml(path.join(engramDir, MANIFEST_FILENAME));

    expect(entry).not.toBeNull();
    expect(entry?.name).toBe("Wrapped Docs");
    expect(entry?.wrap?.remote).toBe("https://github.com/owner/repo.git");
    expect(entry?.wrap?.ref).toBe("v2.0.0");
    expect(entry?.wrap?.sparse).toEqual(["docs/**", "examples/**"]);
    expect(entry?.["disclosure-triggers"]?.["user-msg"]).toContain("docs");
  });
});

describe("e2e: Lazy wrapped engram configuration", () => {
  let tempDir: string;
  let projectDir: string;
  let sourceRepoPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-e2e-wrap-"));
    projectDir = path.join(tempDir, "project");

    await createGitRepo(projectDir);

    sourceRepoPath = await createSourceRepo(path.join(tempDir, "source"), {
      "README.md": "# Test Library\n\nThis is a test library.",
      "docs/guide.md": "# User Guide\n\nHow to use the library.",
      "docs/api.md": "# API Reference\n\nAPI documentation.",
      "src/index.ts": 'export const version = "1.0.0";',
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates lazy wrapped engram with manifest only (no content dir)", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);
    const engramDir = path.join(engramsDir, "test-lib");

    await createEngram(engramDir, {
      name: "Test Library Docs",
      description: "Documentation for test library",
      wrap: {
        remote: sourceRepoPath,
        sparse: ["docs/**"],
      },
      disclosureTriggers: ["test-lib", "library"],
    });

    expect(existsSync(path.join(engramDir, MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(path.join(engramDir, DEFAULT_PROMPT_FILENAME))).toBe(true);
    // Content dir should NOT exist until lazy-init is called
    expect(existsSync(path.join(engramDir, CONTENT_DIR))).toBe(false);
  });

  it("builds index with wrap configuration for lazy engrams", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "lazy-engram"), {
      name: "Lazy Engram",
      description: "Uninitialized wrapped engram",
      wrap: {
        remote: sourceRepoPath,
        ref: "main",
        sparse: ["docs/**"],
      },
      disclosureTriggers: ["lazy"],
    });

    const builtIndex = buildIndexFromEngrams(projectDir);

    expect(builtIndex["lazy-engram"]).toBeDefined();
    expect(builtIndex["lazy-engram"].wrap).toBeDefined();
    expect(builtIndex["lazy-engram"].wrap?.remote).toBe(sourceRepoPath);
    expect(builtIndex["lazy-engram"].wrap?.ref).toBe("main");
    expect(builtIndex["lazy-engram"].wrap?.sparse).toEqual(["docs/**"]);
  });

  it("index allows trigger matching before content is initialized", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "api-docs"), {
      name: "API Documentation",
      description: "REST API docs for the service",
      wrap: {
        remote: sourceRepoPath,
        sparse: ["docs/api/**"],
      },
      disclosureTriggers: ["api", "REST", "endpoint"],
      activationTriggers: ["api-docs"],
    });

    const builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    const index = readIndex(projectDir)!;

    // Verify triggers are available in index for matching
    expect(index["api-docs"]["disclosure-triggers"]?.["user-msg"]).toEqual([
      "api",
      "REST",
      "endpoint",
    ]);
    expect(index["api-docs"]["activation-triggers"]?.["any-msg"]).toEqual(["api-docs"]);

    // Content still not initialized
    expect(existsSync(path.join(engramsDir, "api-docs", CONTENT_DIR))).toBe(false);
  });
});

describe("e2e: Submodule-based engrams", () => {
  let tempDir: string;
  let projectDir: string;
  let engramRepoPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-e2e-submod-"));
    projectDir = path.join(tempDir, "project");

    await createGitRepo(projectDir);

    engramRepoPath = await createSourceRepo(path.join(tempDir, "engram-source"), {
      [MANIFEST_FILENAME]: createManifest({
        name: "Submodule Engram",
        description: "Engram added as submodule",
        disclosureTriggers: ["submod", "external"],
      }),
      [DEFAULT_PROMPT_FILENAME]: "# Submodule Engram\n\nContent from submodule.",
      "docs/usage.md": "# Usage\n\nHow to use this engram.",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("adds engram as git submodule", async () => {
    const submodulePath = `${ENGRAMS_DIR}/external-engram`;

    const result = git(["submodule", "add", engramRepoPath, submodulePath], projectDir);
    expect(result.success).toBe(true);

    expect(existsSync(path.join(projectDir, submodulePath, MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(path.join(projectDir, ".gitmodules"))).toBe(true);

    const gitmodules = readFileSync(path.join(projectDir, ".gitmodules"), "utf-8");
    expect(gitmodules).toContain(submodulePath);
    expect(gitmodules).toContain(engramRepoPath);
  });

  it("detects initialized vs uninitialized submodules", async () => {
    const submodulePath = `${ENGRAMS_DIR}/check-engram`;

    expect(isSubmoduleInitialized(projectDir, submodulePath)).toBe(false);

    git(["submodule", "add", engramRepoPath, submodulePath], projectDir);

    expect(isSubmoduleInitialized(projectDir, submodulePath)).toBe(true);
  });

  it("builds index with submodule URL", async () => {
    const submodulePath = `${ENGRAMS_DIR}/indexed-engram`;

    git(["submodule", "add", engramRepoPath, submodulePath], projectDir);
    gitExec(["add", "-A"], projectDir);
    gitExec(["commit", "-m", "Add engram submodule"], projectDir);

    const builtIndex = buildIndexFromEngrams(projectDir);

    expect(builtIndex["indexed-engram"]).toBeDefined();
    expect(builtIndex["indexed-engram"].name).toBe("Submodule Engram");
    expect(builtIndex["indexed-engram"].url).toBe(engramRepoPath);
    expect(builtIndex["indexed-engram"]["disclosure-triggers"]?.["user-msg"]).toContain("submod");
  });

  it("getSubmoduleUrl returns correct URL from .gitmodules", async () => {
    const submodulePath = `${ENGRAMS_DIR}/url-test`;

    git(["submodule", "add", engramRepoPath, submodulePath], projectDir);

    const url = getSubmoduleUrl(projectDir, submodulePath);
    expect(url).toBe(engramRepoPath);
  });
});

describe("e2e: Index synchronization workflow", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-e2e-sync-"));
    projectDir = path.join(tempDir, "project");
    await createGitRepo(projectDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("syncs multiple engrams to index with different trigger types", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "docs-engram"), {
      name: "Documentation",
      description: "Project documentation",
      disclosureTriggers: ["docs", "help", "guide"],
    });

    await createEngram(path.join(engramsDir, "api-engram"), {
      name: "API Reference",
      description: "API documentation and examples",
      activationTriggers: ["api", "endpoint"],
    });

    await createEngram(path.join(engramsDir, "tools-engram"), {
      name: "Developer Tools",
      description: "CLI and development tools",
      disclosureTriggers: ["cli", "tools"],
      activationTriggers: ["dev-tools"],
    });

    const builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    const retrieved = readIndex(projectDir);

    expect(Object.keys(retrieved!)).toHaveLength(3);

    expect(retrieved!["docs-engram"]["disclosure-triggers"]?.["user-msg"]).toEqual([
      "docs",
      "help",
      "guide",
    ]);

    expect(retrieved!["api-engram"]["activation-triggers"]?.["any-msg"]).toEqual([
      "api",
      "endpoint",
    ]);

    expect(retrieved!["tools-engram"]["disclosure-triggers"]?.["user-msg"]).toEqual([
      "cli",
      "tools",
    ]);
    expect(retrieved!["tools-engram"]["activation-triggers"]?.["any-msg"]).toEqual(["dev-tools"]);
  });

  it("updates index when engrams are added or removed", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "first-engram"), {
      name: "First",
      description: "First engram",
    });

    let builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    expect(Object.keys(readIndex(projectDir)!)).toHaveLength(1);

    await createEngram(path.join(engramsDir, "second-engram"), {
      name: "Second",
      description: "Second engram",
    });

    builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    expect(Object.keys(readIndex(projectDir)!)).toHaveLength(2);

    await fs.rm(path.join(engramsDir, "first-engram"), { recursive: true });

    builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    const finalIndex = readIndex(projectDir)!;
    expect(Object.keys(finalIndex)).toHaveLength(1);
    expect(finalIndex["second-engram"]).toBeDefined();
    expect(finalIndex["first-engram"]).toBeUndefined();
  });

  it("preserves index across git operations", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "persistent-engram"), {
      name: "Persistent",
      description: "Should survive git operations",
      disclosureTriggers: ["persist"],
    });

    const builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    gitExec(["add", "-A"], projectDir);
    gitExec(["commit", "-m", "Add engram"], projectDir);

    const currentBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], projectDir);

    const branchName = "test-branch";
    gitExec(["checkout", "-b", branchName], projectDir);
    gitExec(["checkout", currentBranch], projectDir);

    const indexAfterBranch = readIndex(projectDir);
    expect(indexAfterBranch!["persistent-engram"]).toBeDefined();
    expect(indexAfterBranch!["persistent-engram"]["disclosure-triggers"]?.["user-msg"]).toContain(
      "persist",
    );
  });
});

describe("e2e: Mixed engram types workflow", () => {
  let tempDir: string;
  let projectDir: string;
  let libRepoPath: string;
  let frameworkRepoPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-e2e-mixed-"));
    projectDir = path.join(tempDir, "my-project");

    await createGitRepo(projectDir);

    libRepoPath = await createSourceRepo(path.join(tempDir, "awesome-lib"), {
      "README.md": "# Awesome Library\n\nA fantastic library.",
      "docs/getting-started.md": "# Getting Started",
      "docs/api/core.md": "# Core API",
    });

    frameworkRepoPath = await createSourceRepo(path.join(tempDir, "cool-framework"), {
      [MANIFEST_FILENAME]: createManifest({
        name: "Cool Framework",
        description: "A cool web framework",
        disclosureTriggers: ["framework", "cool", "web"],
        activationTriggers: ["cool-framework"],
      }),
      [DEFAULT_PROMPT_FILENAME]: "# Cool Framework\n\nBuild web apps quickly.",
      "docs/routing.md": "# Routing",
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("handles project with local, wrapped, and submodule engrams", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);
    await fs.mkdir(engramsDir, { recursive: true });

    // 1. Local engram (just files, no wrap or submodule)
    await createEngram(path.join(engramsDir, "project-docs"), {
      name: "Project Documentation",
      description: "Internal project docs",
      disclosureTriggers: ["project", "internal"],
    });
    await fs.writeFile(
      path.join(engramsDir, "project-docs", "CONTRIBUTING.md"),
      "# Contributing Guide",
    );

    // 2. Wrapped engram (lazy, no content yet)
    await createEngram(path.join(engramsDir, "awesome-lib"), {
      name: "Awesome Library Docs",
      description: "Documentation for awesome library",
      wrap: {
        remote: libRepoPath,
        sparse: ["docs/**"],
      },
      disclosureTriggers: ["awesome", "library"],
    });

    // 3. Submodule engram
    const frameworkSubmodPath = `${ENGRAMS_DIR}/cool-framework`;
    const submodResult = git(
      ["submodule", "add", frameworkRepoPath, frameworkSubmodPath],
      projectDir,
    );
    expect(submodResult.success).toBe(true);

    gitExec(["add", "-A"], projectDir);
    gitExec(["commit", "-m", "Set up engrams"], projectDir);

    // Build and verify index
    const builtIndex = buildIndexFromEngrams(projectDir);
    writeIndex(projectDir, builtIndex);

    const index = readIndex(projectDir)!;
    expect(Object.keys(index)).toHaveLength(3);

    // Local engram
    expect(index["project-docs"].name).toBe("Project Documentation");
    expect(index["project-docs"]["disclosure-triggers"]?.["user-msg"]).toContain("internal");
    expect(index["project-docs"].wrap).toBeUndefined();
    expect(index["project-docs"].url).toBeUndefined();

    // Wrapped engram
    expect(index["awesome-lib"].wrap?.remote).toBe(libRepoPath);
    expect(index["awesome-lib"]["disclosure-triggers"]?.["user-msg"]).toContain("awesome");

    // Submodule engram
    expect(index["cool-framework"].url).toBe(frameworkRepoPath);
    expect(index["cool-framework"]["disclosure-triggers"]?.["user-msg"]).toContain("framework");
    expect(index["cool-framework"]["activation-triggers"]?.["any-msg"]).toContain("cool-framework");

    // Verify state
    expect(isSubmoduleInitialized(projectDir, frameworkSubmodPath)).toBe(true);
    expect(existsSync(path.join(engramsDir, "awesome-lib", CONTENT_DIR))).toBe(false);
    expect(existsSync(path.join(engramsDir, "project-docs", "CONTRIBUTING.md"))).toBe(true);
  });

  it("index provides all metadata needed for lazy loading decisions", async () => {
    const engramsDir = path.join(projectDir, ENGRAMS_DIR);

    await createEngram(path.join(engramsDir, "full-docs"), {
      name: "Full Documentation",
      description: "Complete documentation set",
      wrap: {
        remote: libRepoPath,
        ref: "main",
        sparse: ["docs/**", "examples/**"],
      },
      disclosureTriggers: ["docs", "help"],
      activationTriggers: ["full-docs"],
    });

    await createEngram(path.join(engramsDir, "minimal"), {
      name: "Minimal Engram",
      description: "Just the basics",
    });

    const builtIndex = buildIndexFromEngrams(projectDir);

    // Full docs has complete config
    const fullDocs = builtIndex["full-docs"];
    expect(fullDocs.wrap?.remote).toBe(libRepoPath);
    expect(fullDocs.wrap?.ref).toBe("main");
    expect(fullDocs.wrap?.sparse).toEqual(["docs/**", "examples/**"]);
    expect(fullDocs["disclosure-triggers"]?.["user-msg"]).toEqual(["docs", "help"]);
    expect(fullDocs["activation-triggers"]?.["any-msg"]).toEqual(["full-docs"]);

    // Minimal has just name/description
    const minimal = builtIndex["minimal"];
    expect(minimal.name).toBe("Minimal Engram");
    expect(minimal.wrap).toBeUndefined();
    expect(minimal["disclosure-triggers"]).toBeUndefined();
    expect(minimal["activation-triggers"]).toBeUndefined();
  });
});
