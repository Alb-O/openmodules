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
    it("parses a valid module with openmodule.toml and generates a tool name", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const moduleDir = path.join(baseDir, "demo-module");
      const manifestPath = await createModule(moduleDir, "demo-module");

      const parsed = await parseModule(manifestPath, baseDir);

      expect(parsed?.name).toBe("demo-module");
      expect(parsed?.directory).toBe(moduleDir);
      expect(parsed?.toolName).toBe("openmodule_demo_module");
      expect(parsed?.content).toContain("Body of the module.");
    });
  });

  describe("generateToolName", () => {
    it("generates tool names by flattening directories with underscores", () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const manifestPath = path.join(
        baseDir,
        "docs",
        "api-guides",
        "openmodule.toml",
      );
      const toolName = generateToolName(manifestPath, baseDir);

      expect(toolName).toBe("openmodule_docs_api_guides");
    });

    it("handles missing baseDir when generating tool names", () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const manifestPath = path.join(baseDir, "solo", "openmodule.toml");
      const toolName = generateToolName(manifestPath);

      expect(toolName).toBe("openmodule_solo");
    });

    it("returns fallback tool name when modulePath is invalid", () => {
      const toolName = generateToolName(undefined as unknown as string);
      expect(toolName).toBe("openmodule_unknown");
    });

    it("generates correct tool names for nested modules", () => {
      const baseDir = path.join(tempDir, ".openmodules");

      const parentPath = path.join(baseDir, "parent-mod", "openmodule.toml");
      const childPath = path.join(
        baseDir,
        "parent-mod",
        "child-mod",
        "openmodule.toml",
      );
      const grandchildPath = path.join(
        baseDir,
        "parent-mod",
        "child-mod",
        "grandchild-mod",
        "openmodule.toml",
      );

      expect(generateToolName(parentPath, baseDir)).toBe(
        "openmodule_parent_mod",
      );
      expect(generateToolName(childPath, baseDir)).toBe(
        "openmodule_parent_mod_child_mod",
      );
      expect(generateToolName(grandchildPath, baseDir)).toBe(
        "openmodule_parent_mod_child_mod_grandchild_mod",
      );
    });
  });
});
