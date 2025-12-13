import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { discoverModules, findModuleFiles } from "./discovery";
import { createModule } from "./test-utils";

describe("discovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "modules-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("findModuleFiles", () => {
    it("follows symlinked module directories", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const realModuleDir = path.join(tempDir, "real-module");
      await createModule(realModuleDir, "linked-module");

      const linkPath = path.join(baseDir, "linked-module");
      await fs.mkdir(baseDir, { recursive: true });
      await fs.symlink(realModuleDir, linkPath, "dir");

      const files = await findModuleFiles(baseDir);
      expect(files).toContain(path.join(linkPath, "openmodule.toml"));
    });
  });

  describe("discoverModules", () => {
    it("throws error when duplicate tool names are detected across multiple base paths", async () => {
      const configDir = path.join(tempDir, "config");
      const projectDir = path.join(tempDir, "project");
      const sharedName = "shared-module";

      await createModule(path.join(configDir, sharedName), sharedName, "Config description is long enough.");
      await createModule(path.join(projectDir, sharedName), sharedName, "Project description is even longer for testing.");

      await expect(discoverModules([configDir, projectDir])).rejects.toThrow(
        /Duplicate tool names detected/
      );
    });
  });

  describe("nested modules", () => {
    it("discovers nested modules and establishes parent-child relationships", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const parentDir = path.join(baseDir, "parent-module");
      const childDir = path.join(parentDir, "child-module");

      await createModule(parentDir, "Parent Module");
      await createModule(childDir, "Child Module");

      const modules = await discoverModules([baseDir]);

      expect(modules.length).toBe(2);

      const parent = modules.find((m) => m.name === "Parent Module");
      const child = modules.find((m) => m.name === "Child Module");

      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // Parent has no parent
      expect(parent?.parentToolName).toBeUndefined();

      // Child has parent reference
      expect(child?.parentToolName).toBe(parent?.toolName);

      // Parent has child reference
      expect(parent?.childToolNames).toContain(child?.toolName);
    });

    it("handles deeply nested modules correctly", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const level1 = path.join(baseDir, "level1");
      const level2 = path.join(level1, "level2");
      const level3 = path.join(level2, "level3");

      await createModule(level1, "Level 1");
      await createModule(level2, "Level 2");
      await createModule(level3, "Level 3");

      const modules = await discoverModules([baseDir]);

      expect(modules.length).toBe(3);

      const l1 = modules.find((m) => m.name === "Level 1");
      const l2 = modules.find((m) => m.name === "Level 2");
      const l3 = modules.find((m) => m.name === "Level 3");

      expect(l1?.parentToolName).toBeUndefined();
      expect(l2?.parentToolName).toBe(l1?.toolName);
      expect(l3?.parentToolName).toBe(l2?.toolName);

      expect(l1?.childToolNames).toContain(l2?.toolName);
      expect(l2?.childToolNames).toContain(l3?.toolName);
      expect(l3?.childToolNames).toBeUndefined();
    });

    it("does not set parent relationship for sibling modules", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const sibling1 = path.join(baseDir, "sibling1");
      const sibling2 = path.join(baseDir, "sibling2");

      await createModule(sibling1, "Sibling 1");
      await createModule(sibling2, "Sibling 2");

      const modules = await discoverModules([baseDir]);

      expect(modules.length).toBe(2);

      const s1 = modules.find((m) => m.name === "Sibling 1");
      const s2 = modules.find((m) => m.name === "Sibling 2");

      // Neither should have a parent
      expect(s1?.parentToolName).toBeUndefined();
      expect(s2?.parentToolName).toBeUndefined();

      // Neither should have children
      expect(s1?.childToolNames).toBeUndefined();
      expect(s2?.childToolNames).toBeUndefined();
    });

    it("handles multiple children under one parent", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const parentDir = path.join(baseDir, "parent");
      const child1Dir = path.join(parentDir, "child1");
      const child2Dir = path.join(parentDir, "child2");

      await createModule(parentDir, "Parent");
      await createModule(child1Dir, "Child 1");
      await createModule(child2Dir, "Child 2");

      const modules = await discoverModules([baseDir]);

      expect(modules.length).toBe(3);

      const parent = modules.find((m) => m.name === "Parent");
      const c1 = modules.find((m) => m.name === "Child 1");
      const c2 = modules.find((m) => m.name === "Child 2");

      expect(parent?.childToolNames).toHaveLength(2);
      expect(parent?.childToolNames).toContain(c1?.toolName);
      expect(parent?.childToolNames).toContain(c2?.toolName);

      expect(c1?.parentToolName).toBe(parent?.toolName);
      expect(c2?.parentToolName).toBe(parent?.toolName);
    });

    it("sets only the closest ancestor as parent when intermediate directory has no manifest", async () => {
      const baseDir = path.join(tempDir, ".openmodules");
      const parentDir = path.join(baseDir, "parent");
      // intermediate-dir has no openmodule.toml
      const intermediateDir = path.join(parentDir, "intermediate");
      const grandchildDir = path.join(intermediateDir, "grandchild");

      await createModule(parentDir, "Parent");
      // No module at intermediateDir - just create directory
      await fs.mkdir(intermediateDir, { recursive: true });
      await createModule(grandchildDir, "Grandchild");

      const modules = await discoverModules([baseDir]);

      expect(modules.length).toBe(2);

      const parent = modules.find((m) => m.name === "Parent");
      const grandchild = modules.find((m) => m.name === "Grandchild");

      // Grandchild's parent should be the parent (skipping intermediate directory)
      expect(grandchild?.parentToolName).toBe(parent?.toolName);
      expect(parent?.childToolNames).toContain(grandchild?.toolName);
    });
  });
});
