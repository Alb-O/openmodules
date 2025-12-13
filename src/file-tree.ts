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
        const truncated =
          trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
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
      const truncated =
        oneliner.length > 80 ? `${oneliner.slice(0, 77)}...` : oneliner;
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
