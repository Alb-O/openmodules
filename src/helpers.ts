import matter from "gray-matter";
import os from "os";
import { promises as fs, Dirent } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import pkg from "../package.json";
import { extractOneliner } from "./comment-parser";

export interface Module {
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

const MODULE_FILENAME = "MODULE.md";

const ModuleFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens")
    .min(1, "Name cannot be empty"),
  description: z.string().min(20, "Description must be at least 20 characters for discoverability"),
  license: z.string().optional(),
  "allowed-tools": z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

type ModuleFrontmatter = z.infer<typeof ModuleFrontmatterSchema>;

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`[${pkg.name}] ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]) {
  console.error(`[${pkg.name}] ${message}`, ...args);
}

export function generateToolName(modulePath: string, baseDir?: string): string {
  if (typeof modulePath !== "string" || modulePath.length === 0) {
    logWarning("Received invalid module path while generating tool name; defaulting to modules_unknown.");
    return "modules_unknown";
  }

  const safeBase = typeof baseDir === "string" && baseDir.length > 0 ? baseDir : dirname(modulePath);
  const relativePath = relative(safeBase, modulePath);
  const dirPath = dirname(relativePath);

  if (dirPath === "." || dirPath === "") {
    const folder = basename(dirname(modulePath));
    return `modules_${folder.replace(/-/g, "_")}`;
  }

  const components = dirPath.split(sep).filter((part) => part !== ".");
  return `modules_${components.join("_").replace(/-/g, "_")}`;
}

function logFrontmatterErrors(modulePath: string, error: z.ZodError<ModuleFrontmatter>) {
  logError(`Invalid frontmatter in ${modulePath}:`);
  for (const issue of error.issues) {
    logError(` - ${issue.path.join(".")}: ${issue.message}`);
  }
}

export async function parseModule(modulePath: string, baseDir: string): Promise<Module | null> {
  if (typeof modulePath !== "string" || modulePath.length === 0) {
    logWarning("Skipping module with invalid path:", modulePath);
    return null;
  }

  try {
    const raw = await fs.readFile(modulePath, "utf8");
    const { data, content } = matter(raw);
    const parsed = ModuleFrontmatterSchema.safeParse(data);

    if (!parsed.success) {
      logFrontmatterErrors(modulePath, parsed.error);
      return null;
    }

    const moduleDirectory = dirname(modulePath);
    const moduleFolderName = basename(moduleDirectory);

    if (parsed.data.name !== moduleFolderName) {
      logError(
        `Name mismatch in ${modulePath}: frontmatter name "${parsed.data.name}" does not match directory "${moduleFolderName}".`,
      );
      return null;
    }

    return {
      name: parsed.data.name,
      directory: moduleDirectory,
      toolName: generateToolName(modulePath, baseDir),
      description: parsed.data.description,
      allowedTools: parsed.data["allowed-tools"],
      metadata: parsed.data.metadata,
      license: parsed.data.license,
      content: content.trim(),
      path: modulePath,
    };
  } catch (error) {
    logError(`Error parsing module ${modulePath}:`, error);
    return null;
  }
}

export async function findModuleFiles(basePath: string): Promise<string[]> {
  const moduleFiles: string[] = [];
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
      } else if (stat.isFile() && entry.name === MODULE_FILENAME) {
        moduleFiles.push(fullPath);
      }
    }
  }

  return moduleFiles;
}

function normalizeBasePaths(basePaths: unknown): string[] {
  if (Array.isArray(basePaths)) {
    return basePaths.filter((p): p is string => typeof p === "string");
  }

  if (typeof basePaths === "string") {
    return [basePaths];
  }

  logWarning("Invalid basePaths provided to discoverModules; expected string[] or string.");
  return [];
}

export async function discoverModules(basePaths: unknown): Promise<Module[]> {
  const paths = normalizeBasePaths(basePaths);
  if (paths.length === 0) {
    return [];
  }

  const modules: Module[] = [];
  let foundExistingDir = false;

  for (const basePath of paths) {
    try {
      const matches = await findModuleFiles(basePath);
      foundExistingDir = true;

      for (const match of matches) {
        const module = await parseModule(match, basePath);
        if (module) {
          modules.push(module);
        }
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        continue;
      }
      logWarning(`Unexpected error while scanning modules in ${basePath}:`, error);
    }
  }

  if (!foundExistingDir) {
    logWarning(
      "No modules directories found. Checked:\n" +
        paths.map((path) => `  - ${path}`).join("\n"),
    );
  }

  const toolNames = new Set<string>();
  const duplicates: string[] = [];

  for (const module of modules) {
    if (toolNames.has(module.toolName)) {
      duplicates.push(module.toolName);
    }
    toolNames.add(module.toolName);
  }

  if (duplicates.length > 0) {
    logWarning(`Duplicate tool names detected: ${duplicates.join(", ")}`);
  }

  return modules;
}

export function getDefaultModulePaths(rootDir: string): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configModulesPath = xdgConfigHome
    ? join(xdgConfigHome, "opencode", "modules")
    : join(os.homedir(), ".config", "opencode", "modules");

  return [
    configModulesPath,
    join(os.homedir(), ".opencode", "modules"),
    join(rootDir, ".opencode", "modules"),
  ];
}

export interface FileTreeOptions {
  maxDepth?: number;
  exclude?: RegExp[];
  dirsFirst?: boolean;
  ignoreFile?: string;
  includeMetadata?: boolean;
}

// Hide these files/directories by default. The agent doesn't need to see MODULE.md, it should already be in context.
const DEFAULT_EXCLUDE_PATTERNS = [/MODULE\.md/, /^\.ignore$/, /^\.oneliner(\.txt)?$/, /\.git/, /node_modules/, /dist/, /\.DS_Store/];

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
 * Reads a .oneliner or .oneliner.txt file from a directory.
 * Returns the raw content as description, or null if not found.
 */
async function getDirOneliner(dirPath: string): Promise<string | null> {
  for (const filename of [".oneliner", ".oneliner.txt"]) {
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
 * Extracts a short inline description from file using oneliner marker.
 * Returns format: "# description" or null if no marker found.
 */
async function getFileInlineComment(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const oneliner = extractOneliner(content);

    if (oneliner) {
      // Truncate if too long
      const truncated = oneliner.length > 80 ? `${oneliner.slice(0, 77)}...` : oneliner;
      return `# ${truncated}`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generates a flat list of absolute file paths in a directory.
 * Supports .ignore file with gitignore syntax and oneliner descriptions.
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
      const dirComment = await getDirOneliner(dir);
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
