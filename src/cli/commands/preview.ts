import { command, positional, string } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { info, fail, log } from "../../logging";
import { getModulePaths, findProjectRoot, shortenPath } from "../utils";
import { generateFileTree } from "../../tree/file-tree";

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
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = TOML.parse(manifestRaw) as EngramToml;

    const engramDirectory = path.dirname(manifestPath);

    const promptRelativePath = parsed.prompt || "README.md";
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
      fail(`Engram not found: ${name}`);
      info("Run 'engram list' to see available engrams");
      process.exit(1);
    }

    const engram = await parseEngram(found.manifestPath);

    if (!engram) {
      fail(`Failed to parse engram: ${name}`);
      process.exit(1);
    }

    const contentDir = path.join(found.path, "content");
    const isWrapped = !!engram.wrap;
    const isInitialized = !isWrapped || fs.existsSync(contentDir);

    if (!isInitialized) {
      const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
      log(preamble + engram.content);
      info(`\n--- End of preview ---\nRun 'engram lazy-init ${name}' to initialize this engram.`);
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

    log(preamble + engram.content + treeSection);
    info("\n--- End of preview ---");
  },
});
