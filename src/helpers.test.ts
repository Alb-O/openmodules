import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildContextTriggerMatchers,
  compileContextTrigger,
  discoverModules,
  findModuleFiles,
  generateFileTree,
  generateToolName,
  parseModule,
  type Module,
} from "./helpers";

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
    expect(parsed?.toolName).toBe("openmodule_demo_module");
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
    expect(modules.map((s) => s.toolName)).toEqual(["openmodule_shared_module", "openmodule_shared_module"]);

    const toolDescriptions = modules.reduce<Record<string, Module>>((acc, module) => {
      acc[module.toolName] = module;
      return acc;
    }, {});

    expect(toolDescriptions["openmodule_shared_module"].directory).toBe(path.join(projectDir, sharedName));
  });

  it("generates tool names by flattening directories with underscores", () => {
    const baseDir = path.join(tempDir, ".openmodules");
    const manifestPath = path.join(baseDir, "docs", "api-guides", "openmodule.toml");
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

  describe("context triggers", () => {
    const matches = (regexes: RegExp[], text: string) => regexes.some((regex) => regex.test(text));

    it("supports brace expansion and word boundaries", () => {
      const regexes = compileContextTrigger("docstring{s,}");

      expect(matches(regexes, "Please add a docstring for this function")).toBe(true);
      expect(matches(regexes, "Multiple docstrings_are needed")).toBe(true);
      expect(matches(regexes, "docstringing everything")).toBe(false);
    });

    it("treats wildcards as substring matches", () => {
      const regexes = compileContextTrigger("docstring*");

      expect(matches(regexes, "docstringing everything")).toBe(true);
    });

    it("builds matchers that keep triggerless modules visible", () => {
      const modules: Module[] = [
        {
          name: "Docs",
          directory: "/tmp/docs",
          toolName: "openmodule_docs",
          description: "Docs",
          content: "docs",
          manifestPath: "/tmp/docs/openmodule.toml",
          triggers: { userMsg: ["docstring{s,}"] },
        },
        {
          name: "AlwaysOn",
          directory: "/tmp/always",
          toolName: "openmodule_always",
          description: "Always on",
          content: "always",
          manifestPath: "/tmp/always/openmodule.toml",
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);
      const alwaysVisible = matchers
        .filter((matcher) => matcher.alwaysVisible)
        .map((matcher) => matcher.toolName);
      expect(alwaysVisible).toContain("openmodule_always");

      const text = "Need docstrings for this module";
      const triggered = matchers
        .filter((matcher) => matcher.userMsgRegexes.some((regex) => regex.test(text)))
        .map((matcher) => matcher.toolName);

      expect(triggered).toContain("openmodule_docs");
    });

    it("builds matchers with separate regex arrays for each trigger type", () => {
      const modules: Module[] = [
        {
          name: "FileDetector",
          directory: "/tmp/file-detector",
          toolName: "openmodule_file_detector",
          description: "Detects file types from any message",
          content: "detector",
          manifestPath: "/tmp/file-detector/openmodule.toml",
          triggers: { anyMsg: [".pdf", "pdf file"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["help me"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["found error"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      const fileDetector = matchers.find((m) => m.toolName === "openmodule_file_detector");
      const userOnly = matchers.find((m) => m.toolName === "openmodule_user_only");
      const agentOnly = matchers.find((m) => m.toolName === "openmodule_agent_only");

      expect(fileDetector?.anyMsgRegexes.length).toBeGreaterThan(0);
      expect(fileDetector?.userMsgRegexes.length).toBe(0);
      expect(fileDetector?.agentMsgRegexes.length).toBe(0);

      expect(userOnly?.anyMsgRegexes.length).toBe(0);
      expect(userOnly?.userMsgRegexes.length).toBeGreaterThan(0);
      expect(userOnly?.agentMsgRegexes.length).toBe(0);

      expect(agentOnly?.anyMsgRegexes.length).toBe(0);
      expect(agentOnly?.userMsgRegexes.length).toBe(0);
      expect(agentOnly?.agentMsgRegexes.length).toBeGreaterThan(0);
    });

    it("trigger arrays control which text source is matched", () => {
      const modules: Module[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "openmodule_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/openmodule.toml",
          triggers: { anyMsg: ["detected pattern"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["detected pattern"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["detected pattern"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      // Simulate message parts: user text is non-synthetic, agent text is synthetic
      const parts = [
        { type: "text", text: "What files do you see?", synthetic: false }, // user
        { type: "text", text: "I found a detected pattern in the output", synthetic: true }, // agent
      ];

      // Extract text like the hook does
      const userText = parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const agentText = parts
        .filter((p) => p.type === "text" && p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const allText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Check which matchers would trigger based on their trigger type
      const triggered = new Set<string>();
      for (const matcher of matchers) {
        if (matcher.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg should trigger (pattern is in allText)
      expect(triggered.has("openmodule_any_msg")).toBe(true);
      // user-only should NOT trigger (pattern is not in userText)
      expect(triggered.has("openmodule_user_only")).toBe(false);
      // agent-only should trigger (pattern is in agentText)
      expect(triggered.has("openmodule_agent_only")).toBe(true);
    });

    it("user-msg triggers match when pattern is in user text", () => {
      const modules: Module[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "openmodule_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/openmodule.toml",
          triggers: { anyMsg: ["user phrase"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["user phrase"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["user phrase"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      const parts = [
        { type: "text", text: "Please handle this user phrase for me", synthetic: false },
      ];

      const userText = parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const agentText = parts
        .filter((p) => p.type === "text" && p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const allText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const triggered = new Set<string>();
      for (const matcher of matchers) {
        if (matcher.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg and user-only should trigger
      expect(triggered.has("openmodule_any_msg")).toBe(true);
      expect(triggered.has("openmodule_user_only")).toBe(true);
      // agent-only should NOT trigger (pattern is not in agent text)
      expect(triggered.has("openmodule_agent_only")).toBe(false);
    });
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
