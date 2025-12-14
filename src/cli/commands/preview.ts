import { command, positional, string, flag } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { info, fail, raw } from "../../logging";
import { getModulePaths, findProjectRoot, shortenPath } from "../utils";
import { generateFileTree } from "../../tree/file-tree";
import {
  MANIFEST_FILENAME,
  DEFAULT_PROMPT_FILENAME,
  CONTENT_DIR,
  DEFAULT_MAX_FILES,
} from "../../constants";

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

function generateToolName(engramPath: string, baseDir: string): string {
  const relativePath = path.relative(baseDir, engramPath);
  const components = relativePath.split(path.sep).filter((part) => part !== ".");
  return `engram_${components.join("_").replace(/-/g, "_")}`;
}

async function parseEngram(
  manifestPath: string,
): Promise<Engram | null> {
  try {
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = TOML.parse(manifestRaw) as EngramToml;

    const engramDirectory = path.dirname(manifestPath);

    const promptRelativePath = parsed.prompt || DEFAULT_PROMPT_FILENAME;
    const promptPath = path.join(engramDirectory, promptRelativePath);

    let promptContent = "";
    try {
      promptContent = fs.readFileSync(promptPath, "utf-8");
    } catch {
      promptContent = "";
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
    fail(`Error parsing engram ${manifestPath}: ${error}`);
    return null;
  }
}

function findEngram(
  name: string,
  projectRoot: string | null,
): { path: string; manifestPath: string } | null {
  const paths = getModulePaths(projectRoot || undefined);

  if (paths.local) {
    const localPath = path.join(paths.local, name);
    const manifestPath = path.join(localPath, MANIFEST_FILENAME);
    if (fs.existsSync(manifestPath)) {
      return { path: localPath, manifestPath };
    }
  }

  const globalPath = path.join(paths.global, name);
  const manifestPath = path.join(globalPath, MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath)) {
    return { path: globalPath, manifestPath };
  }

  return null;
}

function searchForToolName(dir: string, baseDir: string, targetToolName: string): string | null {
  if (!fs.existsSync(dir)) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(dir, entry.name);
    const manifestPath = path.join(entryPath, MANIFEST_FILENAME);

    if (fs.existsSync(manifestPath)) {
      const toolName = generateToolName(entryPath, baseDir);
      if (toolName === targetToolName) {
        return entryPath;
      }
    }

    const nested = searchForToolName(entryPath, baseDir, targetToolName);
    if (nested) return nested;
  }

  return null;
}

function findEngramByToolName(
  toolName: string,
  projectRoot: string | null,
): { path: string; manifestPath: string } | null {
  const paths = getModulePaths(projectRoot || undefined);
  const searchPaths = [paths.local, paths.global].filter(Boolean) as string[];

  for (const baseDir of searchPaths) {
    if (!fs.existsSync(baseDir)) continue;

    const found = searchForToolName(baseDir, baseDir, toolName);
    if (found) {
      return { path: found, manifestPath: path.join(found, MANIFEST_FILENAME) };
    }
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
      description: "Name or tool name of the engram to preview",
    }),
    toolName: flag({
      long: "tool-name",
      short: "t",
      description: "Interpret the argument as a tool name instead of a path",
    }),
  },
  handler: async ({ name, toolName: useToolName }) => {
    const projectRoot = findProjectRoot();

    let found: { path: string; manifestPath: string } | null = null;

    if (useToolName || name.startsWith("engram_")) {
      const searchName = name.startsWith("engram_") ? name : `engram_${name}`;
      found = findEngramByToolName(searchName, projectRoot);
    } else {
      found = findEngram(name, projectRoot);
    }

    if (!found) {
      fail(`Engram not found: ${name}\nRun 'engram list' to see available engrams`);
      process.exit(1);
    }

    const engram = await parseEngram(found.manifestPath);

    if (!engram) {
      fail(`Failed to parse engram: ${name}`);
      process.exit(1);
    }

    const contentDir = path.join(found.path, CONTENT_DIR);
    const isWrapped = !!engram.wrap;
    const isInitialized = !isWrapped || fs.existsSync(contentDir);

    if (!isInitialized) {
      const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
      raw(preamble + engram.content + `\n\nRun 'engram lazy-init ${name}' to initialize this engram.`);
      return;
    }

    const fileTree = await generateFileTree(engram.directory, {
      includeMetadata: true,
      manifestOneliners: engram.oneliners,
      maxFiles: DEFAULT_MAX_FILES,
    });

    const treeSection = fileTree
      ? `\n\n## Available Resources:\n${fileTree}`
      : "";

    const preamble = `# Engram: ${engram.name}\n\nBase directory: ${shortenPath(engram.directory)}\n\nEngram README:\n\n---\n\n`;

    raw(preamble + engram.content + treeSection);
  },
});
