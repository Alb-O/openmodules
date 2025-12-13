import { command, positional, string } from "cmd-ts";
import { promises as fsPromises, Dirent } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import * as TOML from "@iarna/toml";
import ignore, { type Ignore } from "ignore";
import { getModulePaths, findProjectRoot } from "../utils";

// ============================================================================
// File tree generation (adapted from src/file-tree.ts for CLI use)
// ============================================================================

interface FileTreeOptions {
  maxDepth?: number;
  exclude?: RegExp[];
  ignoreFile?: string;
  includeMetadata?: boolean;
  manifestOneliners?: Record<string, string>;
}

const DEFAULT_EXCLUDE_PATTERNS = [
  /^engram\.toml$/,
  /^\.ignore$/,
  /^\.oneliner(\.txt)?$/,
  /\.git/,
  /node_modules/,
  /dist/,
  /\.DS_Store/,
];

const MAX_LINES_TO_SCAN = 10;
const ONELINER_MARKER = "oneliner:";

function extractOneliner(content: string): string | null {
  const lines = content.split("\n").slice(0, MAX_LINES_TO_SCAN);

  for (const line of lines) {
    const markerIndex = line.toLowerCase().indexOf(ONELINER_MARKER);
    if (markerIndex !== -1) {
      const afterMarker = line
        .slice(markerIndex + ONELINER_MARKER.length)
        .trim();

      const cleaned = afterMarker
        .replace(/\s*-->$/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/\s*"""$/, "")
        .replace(/\s*'''$/, "")
        .replace(/\s*]]$/, "")
        .replace(/^["']|["']$/g, "")
        .trim();

      return cleaned || null;
    }
  }

  return null;
}

async function loadIgnoreFile(filePath: string): Promise<Ignore | null> {
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    return ignore().add(content);
  } catch {
    return null;
  }
}

async function getDirOneliner(dirPath: string): Promise<string | null> {
  for (const filename of [".oneliner", ".oneliner.txt"]) {
    try {
      const content = await fsPromises.readFile(
        path.join(dirPath, filename),
        "utf-8",
      );
      const trimmed = content.trim();
      if (trimmed) {
        const truncated =
          trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
        return `# ${truncated}`;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function getFileInlineComment(filePath: string): Promise<string | null> {
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const oneliner = extractOneliner(content);

    if (oneliner) {
      const truncated =
        oneliner.length > 80 ? `${oneliner.slice(0, 77)}...` : oneliner;
      return `# ${truncated}`;
    }
  } catch {
    return null;
  }

  return null;
}

async function safeReaddir(p: string): Promise<Dirent[]> {
  try {
    const stat = await fsPromises.stat(p);
    if (!stat.isDirectory()) return [];
    return fsPromises.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(p: string) {
  return fsPromises.stat(p).catch(() => null);
}

async function generateFileTree(
  directory: string,
  options: FileTreeOptions = {},
): Promise<string> {
  const {
    maxDepth = 4,
    exclude = DEFAULT_EXCLUDE_PATTERNS,
    ignoreFile = ".ignore",
    includeMetadata = false,
    manifestOneliners = {},
  } = options;

  const ig = await loadIgnoreFile(path.join(directory, ignoreFile));

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

    if (includeMetadata && dir !== directory) {
      const relPath = path.relative(directory, dir);
      const manifestKey = `${relPath}/`;
      const manifestOneliner = manifestOneliners[manifestKey];
      if (manifestOneliner) {
        const truncated =
          manifestOneliner.length > 80
            ? `${manifestOneliner.slice(0, 77)}...`
            : manifestOneliner;
        lines.push(`${dir}/  # ${truncated}`);
      } else {
        const dirComment = await getDirOneliner(dir);
        if (dirComment) {
          lines.push(`${dir}/  ${dirComment}`);
        }
      }
    }

    for (const entry of entries) {
      if (shouldExclude(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();

      if (entry.isSymbolicLink()) {
        const stat = await safeStat(fullPath);
        if (!stat) continue;
        isDir = stat.isDirectory();
      }

      if (ig) {
        const relativePath = path.relative(directory, fullPath);
        const pathToCheck = isDir ? `${relativePath}/` : relativePath;
        if (ig.ignores(pathToCheck)) continue;
      }

      if (isDir) {
        const subFiles = await collectFiles(fullPath, depth + 1);
        lines.push(...subFiles);
      } else {
        let line = fullPath;
        if (includeMetadata) {
          const relPath = path.relative(directory, fullPath);
          const manifestOneliner = manifestOneliners[relPath];

          if (manifestOneliner) {
            const truncated =
              manifestOneliner.length > 80
                ? `${manifestOneliner.slice(0, 77)}...`
                : manifestOneliner;
            line = `${fullPath}  # ${truncated}`;
          } else {
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
        }
        lines.push(line);
      }
    }

    return lines;
  };

  const stat = await safeStat(directory);
  if (!stat?.isDirectory()) return "";

  const fileLines = await collectFiles(directory, 1);
  fileLines.sort((a, b) => a.localeCompare(b));

  return fileLines.join("\n");
}

// ============================================================================
// Manifest parsing (adapted from src/manifest.ts for CLI use)
// ============================================================================

interface Engram {
  name: string;
  directory: string;
  description: string;
  content: string;
  wrap?: {
    remote: string;
    ref?: string;
    sparse?: string[];
  };
  oneliners?: Record<string, string>;
}

interface EngramToml {
  name?: string;
  description?: string;
  prompt?: string;
  wrap?: {
    remote?: string;
    ref?: string;
    sparse?: string[];
  };
  oneliners?: Record<string, string>;
}

async function parseEngram(
  manifestPath: string,
): Promise<Engram | null> {
  try {
    const manifestRaw = await fsPromises.readFile(manifestPath, "utf-8");
    const parsed = TOML.parse(manifestRaw) as EngramToml;

    const engramDirectory = path.dirname(manifestPath);

    const promptRelativePath = parsed.prompt || "README.md";
    const promptPath = path.join(engramDirectory, promptRelativePath);

    let promptContent = "";
    try {
      promptContent = await fsPromises.readFile(promptPath, "utf-8");
    } catch {
      // Missing prompt file is OK
    }

    return {
      name: parsed.name || path.basename(engramDirectory),
      directory: engramDirectory,
      description: parsed.description || "",
      content: promptContent.trim(),
      wrap: parsed.wrap?.remote
        ? {
            remote: parsed.wrap.remote,
            ref: parsed.wrap.ref,
            sparse: parsed.wrap.sparse,
          }
        : undefined,
      oneliners: parsed.oneliners,
    };
  } catch (error) {
    console.error(`Error parsing engram ${manifestPath}:`, error);
    return null;
  }
}

// ============================================================================
// Preview command
// ============================================================================

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function findEngram(
  name: string,
  projectRoot: string | null,
): { path: string; manifestPath: string } | null {
  const paths = getModulePaths(projectRoot || undefined);

  if (paths.local) {
    const localPath = path.join(paths.local, name);
    const manifestPath = path.join(localPath, "engram.toml");
    if (fs.existsSync(manifestPath)) {
      return { path: localPath, manifestPath };
    }
  }

  const globalPath = path.join(paths.global, name);
  const manifestPath = path.join(globalPath, "engram.toml");
  if (fs.existsSync(manifestPath)) {
    return { path: globalPath, manifestPath };
  }

  return null;
}

export const preview = command({
  name: "preview",
  description: "Preview what the agent sees when an engram is activated",
  args: {
    name: positional({
      type: string,
      displayName: "name",
      description: "Name of the engram to preview",
    }),
  },
  handler: async ({ name }) => {
    const projectRoot = findProjectRoot();
    const found = findEngram(name, projectRoot);

    if (!found) {
      console.error(pc.red(`Engram not found: ${name}`));
      console.error(pc.dim("Run 'engram list' to see available engrams"));
      process.exit(1);
    }

    const engram = await parseEngram(found.manifestPath);

    if (!engram) {
      console.error(pc.red(`Failed to parse engram: ${name}`));
      process.exit(1);
    }

    const contentDir = path.join(found.path, "content");
    const isWrapped = !!engram.wrap;
    const isInitialized = !isWrapped || fs.existsSync(contentDir);

    if (!isInitialized) {
      const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
      console.log(preamble + engram.content);
      console.log(
        pc.dim(
          `\n--- End of preview ---\nRun 'engram lazy-init ${name}' to initialize this engram.`,
        ),
      );
      return;
    }

    const fileTree = await generateFileTree(engram.directory, {
      includeMetadata: true,
      manifestOneliners: engram.oneliners,
    });

    const treeSection = fileTree
      ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
      : "";

    const preamble = `# Engram: ${engram.name}\n\nBase directory: ${shortenPath(engram.directory)}\n\nEngram README:\n\n---\n\n`;

    console.log(preamble + engram.content + treeSection);
    console.log(pc.dim("\n--- End of preview ---"));
  },
});
