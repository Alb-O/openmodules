/**
 * Agent smoke test for openmodules plugin using a synthetic module set.
 * Requires opencode CLI, free model opencode/big-pickle, and RUN_AGENT_SMOKE=true.
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "bun";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const OPENCODE_MODEL = "opencode/big-pickle";
const TEST_TIMEOUT = 120_000;
const execAsync = promisify(exec);

const runAgentSmoke = process.env.RUN_AGENT_SMOKE === "true";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let hasOpencode = false;
try {
  await execAsync("which opencode");
  hasOpencode = true;
} catch {
  hasOpencode = false;
}

const shouldRun = runAgentSmoke && hasOpencode;

interface TestContext {
  testDir: string;
}

async function createModule(
  root: string,
  slug: string,
  name: string,
  description: string,
  triggers: string[] | undefined,
  readme: string
) {
  const moduleDir = path.join(root, slug);
  await fs.mkdir(moduleDir, { recursive: true });

  const manifestLines = [
    `name = "${name}"`,
    `description = "${description}"`,
    "prompt = \"README.md\"",
  ];

  if (triggers && triggers.length > 0) {
    manifestLines.push("");
    manifestLines.push("[triggers]");
    manifestLines.push(
      `user-msg = [${triggers.map((t) => `"${t}"`).join(", ")}]`
    );
  }

  manifestLines.push("");

  await fs.writeFile(path.join(moduleDir, "openmodule.toml"), manifestLines.join("\n"));
  await fs.writeFile(path.join(moduleDir, "README.md"), readme);
}

async function setupTestDir(): Promise<TestContext> {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "openmodules-smoke-"));
  const opencodeDir = path.join(testDir, ".opencode");
  const pluginDir = path.join(opencodeDir, "plugin");
  const repoRoot = path.resolve(import.meta.dir, "..", "..");
  const pluginBundle = path.join(repoRoot, "dist", "openmodules.bundle.js");
  const pluginPath = path.join(pluginDir, "openmodules.min.js");

  await fs.mkdir(pluginDir, { recursive: true });

  // Ensure a fresh bundle exists
  if (!(await pathExists(pluginBundle))) {
    await execAsync("bun run build", { cwd: repoRoot });
  }

  // Copy the bundle into the temp .opencode plugin directory
  await fs.copyFile(pluginBundle, pluginPath);

  // Minimal opencode config
  await fs.mkdir(opencodeDir, { recursive: true });
  await fs.writeFile(
    path.join(opencodeDir, "opencode.json"),
    '{"$schema":"https://opencode.ai/config.json"}\n'
  );

  // Synthetic module set
  const modulesRoot = path.join(testDir, ".openmodules");
  await createModule(
    modulesRoot,
    "always-on",
    "Always-on helper module",
    "Helper module that is always available without triggers.",
    undefined,
    "Always-on helper module."
  );
  await createModule(
    modulesRoot,
    "doc-style",
    "Documentation style guidance module",
    "Documentation style guide with docstring triggers for activation.",
    ["docstring{s,}", "documentation"],
    "Doc style guidance README."
  );
  await createModule(
    modulesRoot,
    "assets",
    "PDF document processing helper",
    "Helper for PDF document extraction and processing.",
    [".pdf", "pdf file", "pdf document"],
    "PDF processing helper README."
  );

  if (!(await pathExists(pluginPath))) {
    throw new Error(`Plugin bundle missing at ${pluginPath}`);
  }

  return { testDir };
}

async function cleanup(ctx: TestContext) {
  await fs.rm(ctx.testDir, { recursive: true, force: true });
}

async function runOpencode(
  cwd: string,
  prompt: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["opencode", "run", "--model", OPENCODE_MODEL, prompt],
    cwd,
    env: {
      ...process.env,
      OPENCODE_PERMISSION: JSON.stringify({ "*": "allow" }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe.skipIf(!shouldRun)("openmodules agent smoke", () => {
  it(
    "hides triggered modules until a trigger phrase appears",
    async () => {
      const ctx = await setupTestDir();

      try {
        const first = await runOpencode(
          ctx.testDir,
          "Reply only with the openmodule_ tools you can see right now."
        );

        expect(first.exitCode, first.stderr || first.stdout).toBe(0);
        expect(first.stdout).toContain("openmodule_always_on");
        expect(first.stdout).not.toContain("openmodule_doc_style");
        expect(first.stdout).not.toContain("openmodule_assets");

        const second = await runOpencode(
          ctx.testDir,
          "I need documentation and docstrings. Reply only with the openmodule_ tools you can see."
        );

        expect(second.exitCode, second.stderr || second.stdout).toBe(0);
        expect(second.stdout).toContain("openmodule_always_on");
        expect(second.stdout).toContain("openmodule_doc_style");
        expect(second.stdout).not.toContain("openmodule_assets");

        const third = await runOpencode(
          ctx.testDir,
          "I have some .pdf files to process. Reply only with the openmodule_ tools you can see."
        );

        expect(third.exitCode, third.stderr || third.stdout).toBe(0);
        expect(third.stdout).toContain("openmodule_always_on");
        expect(third.stdout).toContain("openmodule_assets");
      } finally {
        await cleanup(ctx);
      }
    },
    TEST_TIMEOUT
  );
});
