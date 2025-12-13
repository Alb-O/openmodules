import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateToolName, parseModule } from "./manifest";
import { createModule } from "./test-utils";

describe("manifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "modules-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("parseModule", () => {
    it("parses a valid module with engram.toml and generates a tool name", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const moduleDir = path.join(baseDir, "demo-module");
      const manifestPath = await createModule(moduleDir, "demo-module");

      const parsed = await parseModule(manifestPath, baseDir);

      expect(parsed?.name).toBe("demo-module");
      expect(parsed?.directory).toBe(moduleDir);
      expect(parsed?.toolName).toBe("engram_demo_module");
      expect(parsed?.content).toContain("Body of the module.");
    });
  });

  describe("generateToolName", () => {
    it("generates tool names by flattening directories with underscores", () => {
      const baseDir = path.join(tempDir, ".engrams");
      const manifestPath = path.join(
        baseDir,
        "docs",
        "api-guides",
        "engram.toml",
      );
      const toolName = generateToolName(manifestPath, baseDir);

      expect(toolName).toBe("engram_docs_api_guides");
    });

    it("handles missing baseDir when generating tool names", () => {
      const baseDir = path.join(tempDir, ".engrams");
      const manifestPath = path.join(baseDir, "solo", "engram.toml");
      const toolName = generateToolName(manifestPath);

      expect(toolName).toBe("engram_solo");
    });

    it("returns fallback tool name when modulePath is invalid", () => {
      const toolName = generateToolName(undefined as unknown as string);
      expect(toolName).toBe("engram_unknown");
    });

    it("generates correct tool names for nested modules", () => {
      const baseDir = path.join(tempDir, ".engrams");

      const parentPath = path.join(baseDir, "parent-mod", "engram.toml");
      const childPath = path.join(
        baseDir,
        "parent-mod",
        "child-mod",
        "engram.toml",
      );
      const grandchildPath = path.join(
        baseDir,
        "parent-mod",
        "child-mod",
        "grandchild-mod",
        "engram.toml",
      );

      expect(generateToolName(parentPath, baseDir)).toBe(
        "engram_parent_mod",
      );
      expect(generateToolName(childPath, baseDir)).toBe(
        "engram_parent_mod_child_mod",
      );
      expect(generateToolName(grandchildPath, baseDir)).toBe(
        "engram_parent_mod_child_mod_grandchild_mod",
      );
    });
  });
});
