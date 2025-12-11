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
    it("generates ASCII tree for a directory", async () => {
      const skillDir = path.join(tempDir, "tree-test");
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill");
      await fs.writeFile(path.join(skillDir, "src", "main.ts"), "export {}");
      await fs.writeFile(path.join(skillDir, "src", "utils.ts"), "export {}");

      const tree = await generateFileTree(skillDir);

      expect(tree).toContain("src/");
      expect(tree).toContain("SKILL.md");
      expect(tree).toContain("main.ts");
      expect(tree).toContain("utils.ts");
      // Check for tree characters (├, └, │)
      expect(tree).toMatch(/[├└│]/);
    });

    it("excludes node_modules by default", async () => {
      const skillDir = path.join(tempDir, "exclude-test");
      await fs.mkdir(path.join(skillDir, "node_modules", "some-pkg"), { recursive: true });
      await fs.mkdir(path.join(skillDir, "src"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "src", "index.ts"), "export {}");

      const tree = await generateFileTree(skillDir);

      expect(tree).not.toContain("node_modules");
      expect(tree).toContain("src/");
    });

    it("respects maxDepth option", async () => {
      const skillDir = path.join(tempDir, "depth-test");
      await fs.mkdir(path.join(skillDir, "a", "b", "c", "d"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "a", "b", "c", "d", "deep.ts"), "export {}");

      const tree = await generateFileTree(skillDir, { maxDepth: 2 });

      expect(tree).toContain("a/");
      expect(tree).toContain("b/");
      expect(tree).not.toContain("deep.ts");
    });

    it("returns empty string for non-existent directory", async () => {
      const tree = await generateFileTree(path.join(tempDir, "does-not-exist"));
      expect(tree).toBe("");
    });
  });
});
