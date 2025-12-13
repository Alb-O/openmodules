/**
 * Agent smoke test for engrams plugin using a synthetic engram set.
 * Requires opencode CLI, free model opencode/big-pickle, and RUN_AGENT_SMOKE=true.
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm, access, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const OPENCODE_MODEL = "opencode/big-pickle";
const TEST_TIMEOUT = 120_000;

const runAgentSmoke = process.env.RUN_AGENT_SMOKE === "true";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

let hasOpencode = false;
try {
  const result = Bun.spawnSync(["which", "opencode"]);
  hasOpencode = result.success;
} catch {
  hasOpencode = false;
}

const shouldRun = runAgentSmoke && hasOpencode;

interface TestContext {
  testDir: string;
}

async function createEngram(
  root: string,
  slug: string,
  name: string,
  description: string,
  triggers: string[] | undefined,
  readme: string,
) {
  const engramDir = path.join(root, slug);
  await mkdir(engramDir, { recursive: true });

  const manifestLines = [
    `name = "${name}"`,
    `description = "${description}"`,
    'prompt = "README.md"',
  ];

  if (triggers && triggers.length > 0) {
    manifestLines.push("");
    manifestLines.push("[triggers]");
    manifestLines.push(
      `user-msg = [${triggers.map((t) => `"${t}"`).join(", ")}]`,
    );
  }

  manifestLines.push("");

  await Bun.write(
    path.join(engramDir, "engram.toml"),
    manifestLines.join("\n"),
  );
  await Bun.write(path.join(engramDir, "README.md"), readme);
}

async function setupTestDir(): Promise<TestContext> {
  const testDir = await mkdtemp(
    path.join(os.tmpdir(), "engrams-smoke-"),
  );
  const opencodeDir = path.join(testDir, ".opencode");
  const pluginDir = path.join(opencodeDir, "plugin");
  const repoRoot = path.resolve(import.meta.dir, "..", "..");
  const pluginBundle = path.join(repoRoot, "dist", "engrams.bundle.js");
  const pluginPath = path.join(pluginDir, "engrams.min.js");

  await mkdir(pluginDir, { recursive: true });

  // Ensure a fresh bundle exists
  if (!(await pathExists(pluginBundle))) {
    const buildResult = Bun.spawnSync(["bun", "run", "build"], { cwd: repoRoot });
    if (!buildResult.success) {
      throw new Error("Failed to build plugin bundle");
    }
  }

  // Copy the bundle into the temp .opencode plugin directory
  await copyFile(pluginBundle, pluginPath);

  // Minimal opencode config
  await mkdir(opencodeDir, { recursive: true });
  await Bun.write(
    path.join(opencodeDir, "opencode.json"),
    '{"$schema":"https://opencode.ai/config.json"}\n',
  );

  // Synthetic engram set
  const engramsRoot = path.join(testDir, ".engrams");
  await createEngram(
    engramsRoot,
    "always-on",
    "Always-on helper engram",
    "Helper engram that is always available without triggers.",
    undefined,
    "Always-on helper engram.",
  );
  await createEngram(
    engramsRoot,
    "doc-style",
    "Documentation style guidance engram",
    "Documentation style guide with docstring triggers for activation.",
    ["docstring{s,}", "documentation"],
    "Doc style guidance README.",
  );
  await createEngram(
    engramsRoot,
    "assets",
    "PDF document processing helper",
    "Helper for PDF document extraction and processing.",
    [".pdf", "pdf file", "pdf document"],
    "PDF processing helper README.",
  );

  if (!(await pathExists(pluginPath))) {
    throw new Error(`Plugin bundle missing at ${pluginPath}`);
  }

  return { testDir };
}

async function cleanup(ctx: TestContext) {
  await rm(ctx.testDir, { recursive: true, force: true });
}

async function runOpencode(
  cwd: string,
  prompt: string,
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

describe.skipIf(!shouldRun)("engrams agent smoke", () => {
  it(
    "hides triggered engrams until a trigger phrase appears",
    async () => {
      const ctx = await setupTestDir();

      try {
        const first = await runOpencode(
          ctx.testDir,
          "Reply only with the engram_ tools you can see right now.",
        );

        expect(first.exitCode, first.stderr || first.stdout).toBe(0);
        expect(first.stdout).toContain("engram_always_on");
        expect(first.stdout).not.toContain("engram_doc_style");
        expect(first.stdout).not.toContain("engram_assets");

        const second = await runOpencode(
          ctx.testDir,
          "I need documentation and docstrings. Reply only with the engram_ tools you can see.",
        );

        expect(second.exitCode, second.stderr || second.stdout).toBe(0);
        expect(second.stdout).toContain("engram_always_on");
        expect(second.stdout).toContain("engram_doc_style");
        expect(second.stdout).not.toContain("engram_assets");

        const third = await runOpencode(
          ctx.testDir,
          "I have some .pdf files to process. Reply only with the engram_ tools you can see.",
        );

        expect(third.exitCode, third.stderr || third.stdout).toBe(0);
        expect(third.stdout).toContain("engram_always_on");
        expect(third.stdout).toContain("engram_assets");
      } finally {
        await cleanup(ctx);
      }
    },
    TEST_TIMEOUT,
  );
});
