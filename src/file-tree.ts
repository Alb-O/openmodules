import { promises as fs, Dirent } from "fs";
import { join, relative } from "path";
import ignore, { type Ignore } from "ignore";
import type { FileTreeOptions } from "./types";
import { logWarning } from "./logging";
import { extractOneliner } from "./comment-parser";

// Hide these files/directories by default. The manifest is already parsed, agent doesn't need to see it.
const DEFAULT_EXCLUDE_PATTERNS = [
  /^engram\.toml$/,
  /^\.ignore$/,
  /^\.oneliner(\.txt)?$/,
  /\.git/,
  /node_modules/,
  /dist/,
  /\.DS_Store/,
];

/**
 * Loads ignore patterns from a file (gitignore syntax).
 * Returns null if file doesn't exist.
 */
async function loadIgnoreFile(filePath: string): Promise<Ignore | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const content = await file.text();
  return ignore().add(content);
}

/**
 * Reads a .oneliner or .oneliner.txt file from a directory.
 * Returns the raw content as description, or null if not found.
 */
async function getDirOneliner(dirPath: string): Promise<string | null> {
  for (const filename of [".oneliner", ".oneliner.txt"]) {
    const file = Bun.file(join(dirPath, filename));
    if (!(await file.exists())) continue;

    const content = await file.text();
    const trimmed = content.trim();
    if (trimmed) {
      const truncated =
        trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
      return `# ${truncated}`;
    }
  }
  return null;
}

/**
 * Extracts a short inline description from file using oneliner marker.
 * Returns format: "# description" or null if no marker found.
 */
async function getFileInlineComment(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const content = await file.text();
  const oneliner = extractOneliner(content);

  if (oneliner) {
    const truncated =
      oneliner.length > 80 ? `${oneliner.slice(0, 77)}...` : oneliner;
    return `# ${truncated}`;
  }

  return null;
}

/**
 * Safely read a directory, returning empty array if it doesn't exist or isn't a directory.
 */
async function safeReaddir(path: string): Promise<Dirent[]> {
  const stat = await safeStat(path);
  if (!stat?.isDirectory()) return [];
  return fs.readdir(path, { withFileTypes: true });
}

/**
 * Safely stat a path, returning null if it doesn't exist.
 */
async function safeStat(path: string) {
  return fs.stat(path).catch(() => null);
}

/**
 * Generates a flat list of absolute file paths in a directory.
 * Supports .ignore file with gitignore syntax and oneliner descriptions.
 */
export async function generateFileTree(
  directory: string,
  options: FileTreeOptions = {},
): Promise<string> {
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

  const collectFiles = async (
    dir: string,
    depth: number,
  ): Promise<string[]> => {
    if (depth > maxDepth) return [];

    const entries = await safeReaddir(dir);
    if (entries.length === 0) return [];

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
        const stat = await safeStat(fullPath);
        if (!stat) continue; // Skip broken symlinks
        isDir = stat.isDirectory();
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
          // Default oneliner for README files since they're shown on activation
          const lowerName = entry.name.toLowerCase();
          if (
            lowerName === "readme.md" ||
            lowerName === "readme.txt" ||
            lowerName === "readme"
          ) {
            line = `${fullPath}  # module README (shown above)`;
          } else {
            const comment = await getFileInlineComment(fullPath);
            if (comment) {
              line = `${fullPath}  ${comment}`;
            }
          }
        }
        lines.push(line);
      }
    }

    return lines;
  };

  // Check if directory exists first
  const stat = await safeStat(directory);
  if (!stat?.isDirectory()) return "";

  const fileLines = await collectFiles(directory, 1);

  // Sort alphabetically for consistent output
  fileLines.sort((a, b) => a.localeCompare(b));

  return fileLines.join("\n");
}
