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

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`[${pkg.name}] ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]) {
  console.error(`[${pkg.name}] ${message}`, ...args);
}

export function generateToolName(skillPath: string, baseDir?: string): string {
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

export async function parseSkill(skillPath: string, baseDir: string): Promise<Skill | null> {
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

export async function findSkillFiles(basePath: string): Promise<string[]> {
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

export async function discoverSkills(basePaths: unknown): Promise<Skill[]> {
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

export function getDefaultSkillPaths(rootDir: string): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configSkillsPath = xdgConfigHome
    ? join(xdgConfigHome, "opencode", "skills")
    : join(os.homedir(), ".config", "opencode", "skills");

  return [
    configSkillsPath,
    join(os.homedir(), ".opencode", "skills"),
    join(rootDir, ".opencode", "skills"),
  ];
}

export interface FileTreeOptions {
  maxDepth?: number;
  exclude?: RegExp[];
  dirsFirst?: boolean;
}

const DEFAULT_EXCLUDE_PATTERNS = [/node_modules/, /\.git/, /dist/, /\.DS_Store/];

interface TreeEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Generates an ASCII file tree representation of a directory.
 * Pure async implementation using fs.promises.
 */
export async function generateFileTree(directory: string, options: FileTreeOptions = {}): Promise<string> {
  const { maxDepth = 4, exclude = DEFAULT_EXCLUDE_PATTERNS, dirsFirst = true } = options;

  const shouldExclude = (name: string): boolean => {
    return exclude.some((pattern) => pattern.test(name));
  };

  const buildTree = async (dir: string, prefix: string, depth: number): Promise<string[]> => {
    if (depth > maxDepth) return [];

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Filter and map to TreeEntry
    const items: TreeEntry[] = [];
    for (const entry of entries) {
      if (shouldExclude(entry.name)) continue;

      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(join(dir, entry.name));
          isDir = stat.isDirectory();
        } catch {
          continue; // Skip broken symlinks
        }
      }

      items.push({ name: entry.name, isDirectory: isDir });
    }

    // Sort: directories first (if enabled), then alphabetically
    items.sort((a, b) => {
      if (dirsFirst) {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
      }
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const displayName = item.isDirectory ? `${item.name}/` : item.name;

      lines.push(`${prefix}${connector}${displayName}`);

      if (item.isDirectory) {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        const subLines = await buildTree(join(dir, item.name), newPrefix, depth + 1);
        lines.push(...subLines);
      }
    }

    return lines;
  };

  try {
    // Check if directory exists first
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) return "";

    const rootName = basename(directory);
    const treeLines = await buildTree(directory, "", 1);
    return [`${rootName}/`, ...treeLines].join("\n");
  } catch (error) {
    logWarning(`Failed to generate file tree for ${directory}:`, error);
    return "";
  }
}
