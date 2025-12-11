import matter from "gray-matter";
import os from "os";
import { promises as fs, Dirent } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import pkg from "../package.json";
import { extractSkillPart } from "./comment-parser";

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
  ignoreFile?: string;
  includeMetadata?: boolean;
}

// Hide these files/directories by default. The agent doesn't need to see SKILL.md, it should already be in context.
const DEFAULT_EXCLUDE_PATTERNS = [/SKILL\.md/, /^\.ignore$/, /^\.skill-part(\.txt)?$/, /\.git/, /node_modules/, /dist/, /\.DS_Store/];

interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * Loads ignore patterns from a file (gitignore syntax).
 * Returns null if file doesn't exist.
 */
async function loadIgnoreFile(filePath: string): Promise<Ignore | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return ignore().add(content);
  } catch {
    return null;
  }
}

/**
 * Reads a .skill-part or .skill-part.txt file from a directory.
 * Returns the raw content as description, or null if not found.
 */
async function getDirSkillPart(dirPath: string): Promise<string | null> {
  for (const filename of [".skill-part", ".skill-part.txt"]) {
    try {
      const content = await fs.readFile(join(dirPath, filename), "utf-8");
      const trimmed = content.trim();
      if (trimmed) {
        const truncated = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
        return `# ${truncated}`;
      }
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Extracts a short inline description from file using skill-part marker.
 * Returns format: "# description" or null if no marker found.
 */
async function getFileInlineComment(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const skillPart = extractSkillPart(content);

    if (skillPart) {
      // Truncate if too long
      const truncated = skillPart.length > 80 ? `${skillPart.slice(0, 77)}...` : skillPart;
      return `# ${truncated}`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generates a flat list of absolute file paths in a directory.
 * Supports .ignore file with gitignore syntax and skill-part descriptions.
 */
export async function generateFileTree(directory: string, options: FileTreeOptions = {}): Promise<string> {
  const {
    maxDepth = 4,
    exclude = DEFAULT_EXCLUDE_PATTERNS,
    ignoreFile = ".ignore",
    includeMetadata = false,
  } = options;

  // Load .ignore file from root directory
  const ig = await loadIgnoreFile(join(directory, ignoreFile));

  const shouldExclude = (name: string): boolean => {
    return exclude.some((pattern) => pattern.test(name));
  };

  const collectFiles = async (dir: string, depth: number): Promise<string[]> => {
    if (depth > maxDepth) return [];

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const lines: string[] = [];

    // Get directory description if it has one
    if (includeMetadata && dir !== directory) {
      const dirComment = await getDirSkillPart(dir);
      if (dirComment) {
        lines.push(`${dir}/  ${dirComment}`);
      }
    }

    for (const entry of entries) {
      if (shouldExclude(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();

      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(fullPath);
          isDir = stat.isDirectory();
        } catch {
          continue; // Skip broken symlinks
        }
      }

      // Check against .ignore patterns using relative path from root
      if (ig) {
        const relativePath = relative(directory, fullPath);
        const pathToCheck = isDir ? `${relativePath}/` : relativePath;
        if (ig.ignores(pathToCheck)) continue;
      }

      if (isDir) {
        // Recurse into directory
        const subFiles = await collectFiles(fullPath, depth + 1);
        lines.push(...subFiles);
      } else {
        // Add file with optional metadata
        let line = fullPath;
        if (includeMetadata) {
          const comment = await getFileInlineComment(fullPath);
          if (comment) {
            line = `${fullPath}  ${comment}`;
          }
        }
        lines.push(line);
      }
    }

    return lines;
  };

  try {
    // Check if directory exists first
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) return "";

    const fileLines = await collectFiles(directory, 1);
    
    // Sort alphabetically for consistent output
    fileLines.sort((a, b) => a.localeCompare(b));
    
    return fileLines.join("\n");
  } catch (error) {
    logWarning(`Failed to generate file list for ${directory}:`, error);
    return "";
  }
}
