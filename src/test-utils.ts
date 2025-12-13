import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Generates a minimal engram.toml manifest content.
 */
export function engramManifest(
  name: string,
  description = "This is a sufficiently long description for testing.",
) {
  return `name = "${name}"
version = "0.1.0"
description = "${description}"
`;
}

/**
 * Generates engram prompt content.
 */
export function engramPrompt(content = "Body of the engram.") {
  return content;
}

/**
 * Creates an engram with engram.toml at the given directory.
 * Returns the path to the manifest file.
 */
export async function createEngram(
  engramDir: string,
  name: string,
  description = "This is a sufficiently long description for testing.",
  promptContent = "Body of the engram.",
): Promise<string> {
  await mkdir(engramDir, { recursive: true });
  await Bun.write(
    path.join(engramDir, "engram.toml"),
    engramManifest(name, description),
  );
  await Bun.write(
    path.join(engramDir, "README.md"),
    engramPrompt(promptContent),
  );
  return path.join(engramDir, "engram.toml");
}
