import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateToolName, parseEngram } from "./manifest";
import { createEngram } from "../test-utils";

describe("manifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("parseEngram", () => {
    it("parses a valid engram with engram.toml and generates a tool name", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const engramDir = path.join(baseDir, "demo-engram");
      const manifestPath = await createEngram(engramDir, "demo-engram");

      const parsed = await parseEngram(manifestPath, baseDir);

      expect(parsed?.name).toBe("demo-engram");
      expect(parsed?.directory).toBe(engramDir);
      expect(parsed?.toolName).toBe("engram_demo_engram");
      expect(parsed?.content).toContain("Body of the engram.");
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

    it("returns fallback tool name when engramPath is invalid", () => {
      const toolName = generateToolName(undefined as unknown as string);
      expect(toolName).toBe("engram_unknown");
    });

    it("generates correct tool names for nested engrams", () => {
      const baseDir = path.join(tempDir, ".engrams");

      const parentPath = path.join(baseDir, "parent-eg", "engram.toml");
      const childPath = path.join(
        baseDir,
        "parent-eg",
        "child-eg",
        "engram.toml",
      );
      const grandchildPath = path.join(
        baseDir,
        "parent-eg",
        "child-eg",
        "grandchild-eg",
        "engram.toml",
      );

      expect(generateToolName(parentPath, baseDir)).toBe(
        "engram_parent_eg",
      );
      expect(generateToolName(childPath, baseDir)).toBe(
        "engram_parent_eg_child_eg",
      );
      expect(generateToolName(grandchildPath, baseDir)).toBe(
        "engram_parent_eg_child_eg_grandchild_eg",
      );
    });
  });
});
