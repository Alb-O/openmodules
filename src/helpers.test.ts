import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { discoverSkills, findSkillFiles, generateFileTree, generateToolName, parseSkill, type Skill } from "./helpers";

function skillFileContents(name: string, description = "This is a sufficiently long description for testing.") {
  return `---
name: ${name}
description: ${description}
---
Body of the skill.`;
}

describe("skills helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-plugin-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("parses a valid SKILL.md and generates a tool name", async () => {
    const baseDir = path.join(tempDir, ".opencode", "skills");
    const skillDir = path.join(baseDir, "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillPath, skillFileContents("demo-skill"));

    const parsed = await parseSkill(skillPath, baseDir);

    expect(parsed?.name).toBe("demo-skill");
    expect(parsed?.directory).toBe(skillDir);
    expect(parsed?.toolName).toBe("skills_demo_skill");
    expect(parsed?.content).toContain("Body of the skill.");
  });

  it("returns null when frontmatter name does not match directory", async () => {
    const baseDir = path.join(tempDir, ".opencode", "skills");
    const skillDir = path.join(baseDir, "folder-name");
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillPath, skillFileContents("different-name"));

    const parsed = await parseSkill(skillPath, baseDir);

    expect(parsed).toBeNull();
  });

  it("follows symlinked skill directories", async () => {
    const baseDir = path.join(tempDir, ".opencode", "skills");
    const realSkillDir = path.join(tempDir, "real-skill");
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.writeFile(path.join(realSkillDir, "SKILL.md"), skillFileContents("linked-skill"));

    const linkPath = path.join(baseDir, "linked-skill");
    await fs.mkdir(baseDir, { recursive: true });
    await fs.symlink(realSkillDir, linkPath, "dir");

    const files = await findSkillFiles(baseDir);
    expect(files).toContain(path.join(linkPath, "SKILL.md"));
  });

  it("discovers skills across multiple base paths with later entries overriding earlier tool keys", async () => {
    const configDir = path.join(tempDir, "config");
    const projectDir = path.join(tempDir, "project");
    const sharedName = "shared-skill";

    const configSkill = path.join(configDir, sharedName, "SKILL.md");
    await fs.mkdir(path.dirname(configSkill), { recursive: true });
    await fs.writeFile(configSkill, skillFileContents(sharedName, "Config description is long enough."));

    const projectSkill = path.join(projectDir, sharedName, "SKILL.md");
    await fs.mkdir(path.dirname(projectSkill), { recursive: true });
    await fs.writeFile(projectSkill, skillFileContents(sharedName, "Project description is even longer for testing."));

    const skills = await discoverSkills([configDir, projectDir]);
    expect(skills.map((s) => s.toolName)).toEqual(["skills_shared_skill", "skills_shared_skill"]);

    const toolDescriptions = skills.reduce<Record<string, Skill>>((acc, skill) => {
      acc[skill.toolName] = skill;
      return acc;
    }, {});

    expect(toolDescriptions["skills_shared_skill"].directory).toBe(path.join(projectDir, sharedName));
  });

  it("generates tool names by flattening directories with underscores", () => {
    const baseDir = path.join(tempDir, ".opencode", "skills");
    const skillPath = path.join(baseDir, "docs", "api-guides", "SKILL.md");
    const toolName = generateToolName(skillPath, baseDir);

    expect(toolName).toBe("skills_docs_api_guides");
  });

  it("handles missing baseDir when generating tool names", () => {
    const baseDir = path.join(tempDir, ".opencode", "skills");
    const skillPath = path.join(baseDir, "solo", "SKILL.md");
    const toolName = generateToolName(skillPath);

    expect(toolName).toBe("skills_solo");
  });

  it("returns fallback tool name when skillPath is invalid", () => {
    const toolName = generateToolName(undefined as unknown as string);
    expect(toolName).toBe("skills_unknown");
  });

  describe("generateFileTree", () => {
    it("generates flat list of absolute paths", async () => {
      const skillDir = path.join(tempDir, "tree-test");
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "README.md"), "# Readme");
      await fs.writeFile(path.join(skillDir, "src", "main.ts"), "export {}");
      await fs.writeFile(path.join(skillDir, "src", "utils.ts"), "export {}");

      const tree = await generateFileTree(skillDir);

      expect(tree).toContain(path.join(skillDir, "README.md"));
      expect(tree).toContain(path.join(skillDir, "src", "main.ts"));
      expect(tree).toContain(path.join(skillDir, "src", "utils.ts"));
      // Should NOT have tree characters - it's a flat list now
      expect(tree).not.toMatch(/[├└│]/);
    });

    it("excludes node_modules by default", async () => {
      const skillDir = path.join(tempDir, "exclude-test");
      await fs.mkdir(path.join(skillDir, "node_modules", "some-pkg"), { recursive: true });
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "src", "index.ts"), "export {}");

      const tree = await generateFileTree(skillDir);

      expect(tree).not.toContain("node_modules");
      expect(tree).toContain(path.join(skillDir, "src", "index.ts"));
    });

    it("respects maxDepth option", async () => {
      const skillDir = path.join(tempDir, "depth-test");
      await fs.mkdir(path.join(skillDir, "a", "b", "c", "d"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "a", "b", "c", "d", "deep.ts"), "export {}");

      const tree = await generateFileTree(skillDir, { maxDepth: 2 });

      expect(tree).not.toContain("deep.ts");
    });

    it("returns empty string for non-existent directory", async () => {
      const tree = await generateFileTree(path.join(tempDir, "does-not-exist"));
      expect(tree).toBe("");
    });

    it("respects .ignore file with gitignore syntax", async () => {
      const skillDir = path.join(tempDir, "ignore-test");
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.mkdir(path.join(skillDir, "secrets"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "README.md"), "# Readme");
      await fs.writeFile(path.join(skillDir, "src", "index.ts"), "export {}");
      await fs.writeFile(path.join(skillDir, "secrets", "api-key.txt"), "secret");
      await fs.writeFile(path.join(skillDir, "debug.log"), "logs");
      // Create .ignore file
      await fs.writeFile(path.join(skillDir, ".ignore"), "secrets/\n*.log\n");

      const tree = await generateFileTree(skillDir);

      expect(tree).toContain(path.join(skillDir, "src", "index.ts"));
      expect(tree).toContain(path.join(skillDir, "README.md"));
      expect(tree).not.toContain("secrets");
      expect(tree).not.toContain("api-key.txt");
      expect(tree).not.toContain("debug.log");
    });

    it("supports negation patterns in .ignore file", async () => {
      const skillDir = path.join(tempDir, "ignore-negation-test");
      await fs.mkdir(path.join(skillDir, "logs"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "logs", "debug.log"), "debug");
      await fs.writeFile(path.join(skillDir, "logs", "important.log"), "important");
      // Ignore all logs except important.log
      await fs.writeFile(path.join(skillDir, ".ignore"), "logs/*.log\n!logs/important.log\n");

      const tree = await generateFileTree(skillDir);

      expect(tree).toContain("important.log");
      expect(tree).not.toContain("debug.log");
    });

    it("works without .ignore file", async () => {
      const skillDir = path.join(tempDir, "no-ignore-test");
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "src", "index.ts"), "export {}");

      const tree = await generateFileTree(skillDir);

      expect(tree).toContain(path.join(skillDir, "src", "index.ts"));
    });

    it("includes inline metadata comments when includeMetadata is true", async () => {
      const skillDir = path.join(tempDir, "metadata-test");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "backup.sh"),
        `#!/bin/bash
# skill-part: Database backup utilities

echo "Backing up..."
`
      );
      await fs.writeFile(
        path.join(skillDir, "process.py"),
        `#!/usr/bin/env python3
# skill-part: Data processing module

import sys
`
      );

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain(path.join(skillDir, "backup.sh"));
      expect(tree).toContain("# Database backup utilities");
      expect(tree).toContain(path.join(skillDir, "process.py"));
      expect(tree).toContain("# Data processing module");
    });

    it("does not include metadata when includeMetadata is false", async () => {
      const skillDir = path.join(tempDir, "no-metadata-test");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "script.sh"),
        `#!/bin/bash
# skill-part: My Script
echo "Hello"
`
      );

      const tree = await generateFileTree(skillDir, { includeMetadata: false });

      expect(tree).toContain(path.join(skillDir, "script.sh"));
      expect(tree).not.toContain("# My Script");
    });

    it("handles files without metadata gracefully", async () => {
      const skillDir = path.join(tempDir, "mixed-metadata-test");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "with-meta.sh"),
        `#!/bin/bash
# skill-part: Has Metadata
echo "hi"
`
      );
      await fs.writeFile(path.join(skillDir, "no-meta.txt"), "Just text");

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain(path.join(skillDir, "with-meta.sh"));
      expect(tree).toContain("# Has Metadata");
      expect(tree).toContain(path.join(skillDir, "no-meta.txt"));
    });

    it("includes directory description from .skill-part file", async () => {
      const skillDir = path.join(tempDir, "dir-skill-part-test");
      const subDir = path.join(skillDir, "utils");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".skill-part"), "Utility functions for data processing");
      await fs.writeFile(path.join(subDir, "helper.sh"), "#!/bin/bash\necho hi");

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain("utils/");
      expect(tree).toContain("# Utility functions for data processing");
    });

    it("includes directory description from .skill-part.txt file", async () => {
      const skillDir = path.join(tempDir, "dir-skill-part-txt-test");
      const subDir = path.join(skillDir, "scripts");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".skill-part.txt"), "Shell scripts for automation");
      await fs.writeFile(path.join(subDir, "run.sh"), "#!/bin/bash\necho run");

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain("scripts/");
      expect(tree).toContain("# Shell scripts for automation");
    });

    it("prefers .skill-part over .skill-part.txt", async () => {
      const skillDir = path.join(tempDir, "dir-skill-part-priority-test");
      const subDir = path.join(skillDir, "lib");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, ".skill-part"), "From .skill-part");
      await fs.writeFile(path.join(subDir, ".skill-part.txt"), "From .skill-part.txt");

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain("# From .skill-part");
      expect(tree).not.toContain("# From .skill-part.txt");
    });

    it("hides .skill-part files from output", async () => {
      const skillDir = path.join(tempDir, "hide-skill-part-test");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, ".skill-part"), "Description");
      await fs.writeFile(path.join(skillDir, ".skill-part.txt"), "Description txt");
      await fs.writeFile(path.join(skillDir, "script.sh"), "#!/bin/bash");

      const tree = await generateFileTree(skillDir, { includeMetadata: true });

      expect(tree).toContain("script.sh");
      expect(tree).not.toMatch(/\.skill-part/);
    });
  });
});
