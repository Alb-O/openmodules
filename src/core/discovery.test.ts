import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { discoverEngrams, findEngramFiles } from "./discovery";
import { createEngram } from "../test-utils";

describe("discovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "engrams-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("findEngramFiles", () => {
    it("follows symlinked engram directories", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const realEngramDir = path.join(tempDir, "real-engram");
      await createEngram(realEngramDir, "linked-engram");

      const linkPath = path.join(baseDir, "linked-engram");
      await fs.mkdir(baseDir, { recursive: true });
      await fs.symlink(realEngramDir, linkPath, "dir");

      const files = await findEngramFiles(baseDir);
      expect(files).toContain(path.join(linkPath, "engram.toml"));
    });
  });

  describe("discoverEngrams", () => {
    it("throws error when duplicate tool names are detected across multiple base paths", async () => {
      const configDir = path.join(tempDir, "config");
      const projectDir = path.join(tempDir, "project");
      const sharedName = "shared-engram";

      await createEngram(
        path.join(configDir, sharedName),
        sharedName,
        "Config description is long enough.",
      );
      await createEngram(
        path.join(projectDir, sharedName),
        sharedName,
        "Project description is even longer for testing.",
      );

      await expect(discoverEngrams([configDir, projectDir])).rejects.toThrow(
        /Duplicate tool names detected/,
      );
    });
  });

  describe("nested engrams", () => {
    it("discovers nested engrams and establishes parent-child relationships", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const parentDir = path.join(baseDir, "parent-engram");
      const childDir = path.join(parentDir, "child-engram");

      await createEngram(parentDir, "Parent Engram");
      await createEngram(childDir, "Child Engram");

      const engrams = await discoverEngrams([baseDir]);

      expect(engrams.length).toBe(2);

      const parent = engrams.find((e) => e.name === "Parent Engram");
      const child = engrams.find((e) => e.name === "Child Engram");

      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // Parent has no parent
      expect(parent?.parentToolName).toBeUndefined();

      // Child has parent reference
      expect(child?.parentToolName).toBe(parent?.toolName);

      // Parent has child reference
      expect(parent?.childToolNames).toContain(child?.toolName);
    });

    it("handles deeply nested engrams correctly", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const level1 = path.join(baseDir, "level1");
      const level2 = path.join(level1, "level2");
      const level3 = path.join(level2, "level3");

      await createEngram(level1, "Level 1");
      await createEngram(level2, "Level 2");
      await createEngram(level3, "Level 3");

      const engrams = await discoverEngrams([baseDir]);

      expect(engrams.length).toBe(3);

      const l1 = engrams.find((e) => e.name === "Level 1");
      const l2 = engrams.find((e) => e.name === "Level 2");
      const l3 = engrams.find((e) => e.name === "Level 3");

      expect(l1?.parentToolName).toBeUndefined();
      expect(l2?.parentToolName).toBe(l1?.toolName);
      expect(l3?.parentToolName).toBe(l2?.toolName);

      expect(l1?.childToolNames).toContain(l2?.toolName);
      expect(l2?.childToolNames).toContain(l3?.toolName);
      expect(l3?.childToolNames).toBeUndefined();
    });

    it("does not set parent relationship for sibling engrams", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const sibling1 = path.join(baseDir, "sibling1");
      const sibling2 = path.join(baseDir, "sibling2");

      await createEngram(sibling1, "Sibling 1");
      await createEngram(sibling2, "Sibling 2");

      const engrams = await discoverEngrams([baseDir]);

      expect(engrams.length).toBe(2);

      const s1 = engrams.find((e) => e.name === "Sibling 1");
      const s2 = engrams.find((e) => e.name === "Sibling 2");

      // Neither should have a parent
      expect(s1?.parentToolName).toBeUndefined();
      expect(s2?.parentToolName).toBeUndefined();

      // Neither should have children
      expect(s1?.childToolNames).toBeUndefined();
      expect(s2?.childToolNames).toBeUndefined();
    });

    it("handles multiple children under one parent", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const parentDir = path.join(baseDir, "parent");
      const child1Dir = path.join(parentDir, "child1");
      const child2Dir = path.join(parentDir, "child2");

      await createEngram(parentDir, "Parent");
      await createEngram(child1Dir, "Child 1");
      await createEngram(child2Dir, "Child 2");

      const engrams = await discoverEngrams([baseDir]);

      expect(engrams.length).toBe(3);

      const parent = engrams.find((e) => e.name === "Parent");
      const c1 = engrams.find((e) => e.name === "Child 1");
      const c2 = engrams.find((e) => e.name === "Child 2");

      expect(parent?.childToolNames).toHaveLength(2);
      expect(parent?.childToolNames).toContain(c1?.toolName);
      expect(parent?.childToolNames).toContain(c2?.toolName);

      expect(c1?.parentToolName).toBe(parent?.toolName);
      expect(c2?.parentToolName).toBe(parent?.toolName);
    });

    it("sets only the closest ancestor as parent when intermediate directory has no manifest", async () => {
      const baseDir = path.join(tempDir, ".engrams");
      const parentDir = path.join(baseDir, "parent");
      // intermediate-dir has no engram.toml
      const intermediateDir = path.join(parentDir, "intermediate");
      const grandchildDir = path.join(intermediateDir, "grandchild");

      await createEngram(parentDir, "Parent");
      // No engram at intermediateDir - just create directory
      await fs.mkdir(intermediateDir, { recursive: true });
      await createEngram(grandchildDir, "Grandchild");

      const engrams = await discoverEngrams([baseDir]);

      expect(engrams.length).toBe(2);

      const parent = engrams.find((e) => e.name === "Parent");
      const grandchild = engrams.find((e) => e.name === "Grandchild");

      // Grandchild's parent should be the parent (skipping intermediate directory)
      expect(grandchild?.parentToolName).toBe(parent?.toolName);
      expect(parent?.childToolNames).toContain(grandchild?.toolName);
    });
  });
});
