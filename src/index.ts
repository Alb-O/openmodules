import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import matter from "gray-matter";
import os from "os";
import { promises as fs, Dirent } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { z } from "zod";
import pkg from "../package.json";

export interface Skill {
  name: string;
  directory: string;
  toolName: string;
  description: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  license?: string;
  content: string;
  path: string;
}

const SKILL_FILENAME = "SKILL.md";

const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens")
    .min(1, "Name cannot be empty"),
  description: z.string().min(20, "Description must be at least 20 characters for discoverability"),
  license: z.string().optional(),
  "allowed-tools": z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

function logWarning(message: string, ...args: unknown[]) {
  console.warn(`[${pkg.name}] ${message}`, ...args);
}

function logError(message: string, ...args: unknown[]) {
  console.error(`[${pkg.name}] ${message}`, ...args);
}

function generateToolName(skillPath: string, baseDir?: string): string {
  if (typeof skillPath !== "string" || skillPath.length === 0) {
    logWarning("Received invalid skill path while generating tool name; defaulting to skills_unknown.");
    return "skills_unknown";
  }

  const safeBase = typeof baseDir === "string" && baseDir.length > 0 ? baseDir : dirname(skillPath);
  const relativePath = relative(safeBase, skillPath);
  const dirPath = dirname(relativePath);

  if (dirPath === "." || dirPath === "") {
    const folder = basename(dirname(skillPath));
    return `skills_${folder.replace(/-/g, "_")}`;
  }

  const components = dirPath.split(sep).filter((part) => part !== ".");
  return `skills_${components.join("_").replace(/-/g, "_")}`;
}

function logFrontmatterErrors(skillPath: string, error: z.ZodError<SkillFrontmatter>) {
  logError(`Invalid frontmatter in ${skillPath}:`);
  for (const issue of error.issues) {
    logError(` - ${issue.path.join(".")}: ${issue.message}`);
  }
}

async function parseSkill(skillPath: string, baseDir: string): Promise<Skill | null> {
  if (typeof skillPath !== "string" || skillPath.length === 0) {
    logWarning("Skipping skill with invalid path:", skillPath);
    return null;
  }

  try {
    const raw = await fs.readFile(skillPath, "utf8");
    const { data, content } = matter(raw);
    const parsed = SkillFrontmatterSchema.safeParse(data);

    if (!parsed.success) {
      logFrontmatterErrors(skillPath, parsed.error);
      return null;
    }

    const skillDirectory = dirname(skillPath);
    const skillFolderName = basename(skillDirectory);

    if (parsed.data.name !== skillFolderName) {
      logError(
        `Name mismatch in ${skillPath}: frontmatter name "${parsed.data.name}" does not match directory "${skillFolderName}".`,
      );
      return null;
    }

    return {
      name: parsed.data.name,
      directory: skillDirectory,
      toolName: generateToolName(skillPath, baseDir),
      description: parsed.data.description,
      allowedTools: parsed.data["allowed-tools"],
      metadata: parsed.data.metadata,
      license: parsed.data.license,
      content: content.trim(),
      path: skillPath,
    };
  } catch (error) {
    logError(`Error parsing skill ${skillPath}:`, error);
    return null;
  }
}

async function findSkillFiles(basePath: string): Promise<string[]> {
  const skillFiles: string[] = [];
  const visited = new Set<string>();
  const queue = [basePath];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    let realCurrent: string;

    try {
      realCurrent = await fs.realpath(current);
    } catch (error: any) {
      if (current === basePath && error?.code === "ENOENT") {
        throw error;
      }
      continue;
    }

    if (visited.has(realCurrent)) {
      continue;
    }
    visited.add(realCurrent);

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error: any) {
      if (current === basePath && error?.code === "ENOENT") {
        throw error;
      }
      logWarning(`Unexpected error reading ${current}:`, error);
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      let stat: Dirent | Awaited<ReturnType<typeof fs.stat>>;

      if (entry.isSymbolicLink()) {
        try {
          // fs.stat follows symlinks; broken links are skipped
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }
      } else {
        stat = entry;
      }

      if (stat.isDirectory()) {
        queue.push(fullPath);
      } else if (stat.isFile() && entry.name === SKILL_FILENAME) {
        skillFiles.push(fullPath);
      }
    }
  }

  return skillFiles;
}

function normalizeBasePaths(basePaths: unknown): string[] {
  if (Array.isArray(basePaths)) {
    return basePaths.filter((p): p is string => typeof p === "string");
  }

  if (typeof basePaths === "string") {
    return [basePaths];
  }

  logWarning("Invalid basePaths provided to discoverSkills; expected string[] or string.");
  return [];
}

async function discoverSkills(basePaths: unknown): Promise<Skill[]> {
  const paths = normalizeBasePaths(basePaths);
  if (paths.length === 0) {
    return [];
  }

  const skills: Skill[] = [];
  let foundExistingDir = false;

  for (const basePath of paths) {
    try {
      const matches = await findSkillFiles(basePath);
      foundExistingDir = true;

      for (const match of matches) {
        const skill = await parseSkill(match, basePath);
        if (skill) {
          skills.push(skill);
        }
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        continue;
      }
      logWarning(`Unexpected error while scanning skills in ${basePath}:`, error);
    }
  }

  if (!foundExistingDir) {
    logWarning(
      "No skills directories found. Checked:\n" +
        paths.map((path) => `  - ${path}`).join("\n"),
    );
  }

  const toolNames = new Set<string>();
  const duplicates: string[] = [];

  for (const skill of skills) {
    if (toolNames.has(skill.toolName)) {
      duplicates.push(skill.toolName);
    }
    toolNames.add(skill.toolName);
  }

  if (duplicates.length > 0) {
    logWarning(`Duplicate tool names detected: ${duplicates.join(", ")}`);
  }

  return skills;
}

export const SkillsPlugin: Plugin = async (input) => {
  try {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configSkillsPath = xdgConfigHome
      ? join(xdgConfigHome, "opencode", "skills")
      : join(os.homedir(), ".config", "opencode", "skills");

    const skills = await discoverSkills([
      configSkillsPath,
      join(os.homedir(), ".opencode", "skills"),
      join(input.directory, ".opencode", "skills"),
    ]);

    if (skills.length === 0) {
      return {};
    }

    const tools: Record<string, ReturnType<typeof tool>> = {};

    for (const skill of skills) {
      if (!skill.toolName) continue;

      tools[skill.toolName] = tool({
        description: skill.description,
        args: {},
        async execute(_, toolCtx) {
          const sendSilentPrompt = async (text: string) => {
            if (!input.client?.session?.prompt) return;

            await input.client.session.prompt({
              path: { id: toolCtx.sessionID },
              body: {
                agent: toolCtx.agent,
                noReply: true,
                parts: [{ type: "text", text }],
              },
            });
          };

          await sendSilentPrompt(`The "${skill.name}" skill is loading\n${skill.name}`);
          await sendSilentPrompt(`Base directory for this skill: ${skill.directory}\n\n${skill.content}`);

          return `Launching skill: ${skill.name}`;
        },
      });
    }

    return { tool: tools };
  } catch (error) {
    logError("Failed to initialize skills plugin:", error);
    return {};
  }
};

export {
  discoverSkills,
  findSkillFiles,
  generateToolName,
  parseSkill,
};

export default SkillsPlugin;
