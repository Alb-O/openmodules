import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { discoverModules, findModuleFiles, generateFileTree, generateToolName, parseModule, type Module } from "./helpers";

function moduleManifest(name: string, description = "This is a sufficiently long description for testing.") {
  return `name = "${name}"
version = "0.1.0"
description = "${description}"
`;
}

function modulePrompt(content = "Body of the module.") {
  return content;
}

/**
 * Creates a module with openmodule.toml at the root
 */
async function createModule(
  moduleDir: string,
  name: string,
  description = "This is a sufficiently long description for testing.",
  promptContent = "Body of the module."
) {
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(path.join(moduleDir, "openmodule.toml"), moduleManifest(name, description));
  await fs.writeFile(path.join(moduleDir, "README.md"), modulePrompt(promptContent));
  return path.join(moduleDir, "openmodule.toml");
}

describe("modules helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "modules-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("parses a valid module with openmodule.toml and generates a tool name", async () => {
    const baseDir = path.join(tempDir, ".openmodules");
    const moduleDir = path.join(baseDir, "demo-module");
    const manifestPath = await createModule(moduleDir, "demo-module");

    const parsed = await parseModule(manifestPath, baseDir);

    expect(parsed?.name).toBe("demo-module");
    expect(parsed?.directory).toBe(moduleDir);
    expect(parsed?.toolName).toBe("modules_demo_module");
    expect(parsed?.content).toContain("Body of the module.");
  });

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

  it("discovers modules across multiple base paths with later entries overriding earlier tool keys", async () => {
    const configDir = path.join(tempDir, "config");
    const projectDir = path.join(tempDir, "project");
    const sharedName = "shared-module";

    await createModule(path.join(configDir, sharedName), sharedName, "Config description is long enough.");
    await createModule(path.join(projectDir, sharedName), sharedName, "Project description is even longer for testing.");

    const modules = await discoverModules([configDir, projectDir]);
    expect(modules.map((s) => s.toolName)).toEqual(["modules_shared_module", "modules_shared_module"]);

    const toolDescriptions = modules.reduce<Record<string, Module>>((acc, module) => {
      acc[module.toolName] = module;
      return acc;
    }, {});

    expect(toolDescriptions["modules_shared_module"].directory).toBe(path.join(projectDir, sharedName));
  });

  it("generates tool names by flattening directories with underscores", () => {
    const baseDir = path.join(tempDir, ".openmodules");
    const manifestPath = path.join(baseDir, "docs", "api-guides", "openmodule.toml");
    const toolName = generateToolName(manifestPath, baseDir);

    expect(toolName).toBe("modules_docs_api_guides");
  });

  it("handles missing baseDir when generating tool names", () => {
    const baseDir = path.join(tempDir, ".openmodules");
    const manifestPath = path.join(baseDir, "solo", "openmodule.toml");
    const toolName = generateToolName(manifestPath);

    expect(toolName).toBe("modules_solo");
  });

  it("returns fallback tool name when modulePath is invalid", () => {
    const toolName = generateToolName(undefined as unknown as string);
    expect(toolName).toBe("modules_unknown");
  });

  describe("generateFileTree", () => {
    it("generates flat list of absolute paths", async () => {
      const moduleDir = path.join(tempDir, "tree-test");
      await fs.mkdir(path.join(moduleDir, "src"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "README.md"), "# Readme");
      await fs.writeFile(path.join(moduleDir, "src", "main.ts"), "export {}");
      await fs.writeFile(path.join(moduleDir, "src", "utils.ts"), "export {}");

      const tree = await generateFileTree(moduleDir);

      expect(tree).toContain(path.join(moduleDir, "README.md"));
      expect(tree).toContain(path.join(moduleDir, "src", "main.ts"));
      expect(tree).toContain(path.join(moduleDir, "src", "utils.ts"));
      // Should NOT have tree characters - it's a flat list now
      expect(tree).not.toMatch(/[├└│]/);
    });

    it("excludes node_modules by default", async () => {
      const moduleDir = path.join(tempDir, "exclude-test");
      await fs.mkdir(path.join(moduleDir, "node_modules", "some-pkg"), { recursive: true });
      await fs.mkdir(path.join(moduleDir, "src"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "src", "index.ts"), "export {}");

      const tree = await generateFileTree(moduleDir);

      expect(tree).not.toContain("node_modules");
      expect(tree).toContain(path.join(moduleDir, "src", "index.ts"));
    });

    it("respects maxDepth option", async () => {
      const moduleDir = path.join(tempDir, "depth-test");
      await fs.mkdir(path.join(moduleDir, "a", "b", "c", "d"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "a", "b", "c", "d", "deep.ts"), "export {}");

      const tree = await generateFileTree(moduleDir, { maxDepth: 2 });

      expect(tree).not.toContain("deep.ts");
    });

    it("returns empty string for non-existent directory", async () => {
      const tree = await generateFileTree(path.join(tempDir, "does-not-exist"));
      expect(tree).toBe("");
    });

    it("respects .ignore file with gitignore syntax", async () => {
      const moduleDir = path.join(tempDir, "ignore-test");
      await fs.mkdir(path.join(moduleDir, "src"), { recursive: true });
      await fs.mkdir(path.join(moduleDir, "secrets"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "README.md"), "# Readme");
      await fs.writeFile(path.join(moduleDir, "src", "index.ts"), "export {}");
      await fs.writeFile(path.join(moduleDir, "secrets", "api-key.txt"), "secret");
      await fs.writeFile(path.join(moduleDir, "debug.log"), "logs");
      // Create .ignore file
      await fs.writeFile(path.join(moduleDir, ".ignore"), "secrets/\n*.log\n");

      const tree = await generateFileTree(moduleDir);

      expect(tree).toContain(path.join(moduleDir, "src", "index.ts"));
      expect(tree).toContain(path.join(moduleDir, "README.md"));
      expect(tree).not.toContain("secrets");
      expect(tree).not.toContain("api-key.txt");
      expect(tree).not.toContain("debug.log");
    });

    it("supports negation patterns in .ignore file", async () => {
      const moduleDir = path.join(tempDir, "ignore-negation-test");
      await fs.mkdir(path.join(moduleDir, "logs"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "logs", "debug.log"), "debug");
      await fs.writeFile(path.join(moduleDir, "logs", "important.log"), "important");
      // Ignore all logs except important.log
      await fs.writeFile(path.join(moduleDir, ".ignore"), "logs/*.log\n!logs/important.log\n");

      const tree = await generateFileTree(moduleDir);

      expect(tree).toContain("important.log");
      expect(tree).not.toContain("debug.log");
    });

    it("works without .ignore file", async () => {
      const moduleDir = path.join(tempDir, "no-ignore-test");
      await fs.mkdir(path.join(moduleDir, "src"), { recursive: true });
      await fs.writeFile(path.join(moduleDir, "src", "index.ts"), "export {}");

      const tree = await generateFileTree(moduleDir);

      expect(tree).toContain(path.join(moduleDir, "src", "index.ts"));
    });

    it("includes inline metadata comments when includeMetadata is true", async () => {
      const moduleDir = path.join(tempDir, "metadata-test");
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(
        path.join(moduleDir, "backup.sh"),
        `#!/bin/bash
# oneliner: Database backup utilities

echo "Backing up..."
`
      );
      await fs.writeFile(
        path.join(moduleDir, "process.py"),
        `#!/usr/bin/env python3
# oneliner: Data processing module

import sys
`
      );

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain(path.join(moduleDir, "backup.sh"));
      expect(tree).toContain("# Database backup utilities");
      expect(tree).toContain(path.join(moduleDir, "process.py"));
      expect(tree).toContain("# Data processing module");
    });

    it("does not include metadata when includeMetadata is false", async () => {
      const moduleDir = path.join(tempDir, "no-metadata-test");
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(
        path.join(moduleDir, "script.sh"),
        `#!/bin/bash
# oneliner: My Script
echo "Hello"
`
      );

      const tree = await generateFileTree(moduleDir, { includeMetadata: false });

      expect(tree).toContain(path.join(moduleDir, "script.sh"));
      expect(tree).not.toContain("# My Script");
    });

    it("handles files without metadata gracefully", async () => {
      const moduleDir = path.join(tempDir, "mixed-metadata-test");
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(
        path.join(moduleDir, "with-meta.sh"),
        `#!/bin/bash
# oneliner: Has Metadata
echo "hi"
`
      );
      await fs.writeFile(path.join(moduleDir, "no-meta.txt"), "Just text");

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain(path.join(moduleDir, "with-meta.sh"));
      expect(tree).toContain("# Has Metadata");
      expect(tree).toContain(path.join(moduleDir, "no-meta.txt"));
    });

    it("includes directory description from .oneliner file", async () => {
      const moduleDir = path.join(tempDir, "dir-oneliner-test");
      const subDir = path.join(moduleDir, "utils");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".oneliner"), "Utility functions for data processing");
      await fs.writeFile(path.join(subDir, "helper.sh"), "#!/bin/bash\necho hi");

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain("utils/");
      expect(tree).toContain("# Utility functions for data processing");
    });

    it("includes directory description from .oneliner.txt file", async () => {
      const moduleDir = path.join(tempDir, "dir-oneliner-txt-test");
      const subDir = path.join(moduleDir, "scripts");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".oneliner.txt"), "Shell scripts for automation");
      await fs.writeFile(path.join(subDir, "run.sh"), "#!/bin/bash\necho run");

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain("scripts/");
      expect(tree).toContain("# Shell scripts for automation");
    });

    it("prefers .oneliner over .oneliner.txt", async () => {
      const moduleDir = path.join(tempDir, "dir-oneliner-priority-test");
      const subDir = path.join(moduleDir, "lib");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".oneliner"), "From .oneliner");
      await fs.writeFile(path.join(subDir, ".oneliner.txt"), "From .oneliner.txt");

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain("# From .oneliner");
      expect(tree).not.toContain("# From .oneliner.txt");
    });

    it("hides .oneliner files from output", async () => {
      const moduleDir = path.join(tempDir, "hide-oneliner-test");
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(path.join(moduleDir, ".oneliner"), "Description");
      await fs.writeFile(path.join(moduleDir, ".oneliner.txt"), "Description txt");
      await fs.writeFile(path.join(moduleDir, "script.sh"), "#!/bin/bash");

      const tree = await generateFileTree(moduleDir, { includeMetadata: true });

      expect(tree).toContain("script.sh");
      expect(tree).not.toMatch(/\.oneliner/);
    });
  });
});
