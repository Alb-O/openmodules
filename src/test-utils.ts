import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Generates a minimal engram.toml manifest content.
 */
export function moduleManifest(
  name: string,
  description = "This is a sufficiently long description for testing.",
) {
  return `name = "${name}"
version = "0.1.0"
description = "${description}"
`;
}

/**
 * Generates module prompt content.
 */
export function modulePrompt(content = "Body of the module.") {
  return content;
}

/**
 * Creates a module with engram.toml at the given directory.
 * Returns the path to the manifest file.
 */
export async function createModule(
  moduleDir: string,
  name: string,
  description = "This is a sufficiently long description for testing.",
  promptContent = "Body of the module.",
): Promise<string> {
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(
    path.join(moduleDir, "engram.toml"),
    moduleManifest(name, description),
  );
  await fs.writeFile(
    path.join(moduleDir, "README.md"),
    modulePrompt(promptContent),
  );
  return path.join(moduleDir, "engram.toml");
}
