import * as TOML from "@iarna/toml";
import { promises as fs } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { z } from "zod";
import type { Engram } from "./types";
import { logWarning, logError } from "./logging";

/** Manifest filename at engram root */
export const MANIFEST_FILENAME = "engram.toml";
/** Default prompt file relative to engram root */
const DEFAULT_PROMPT_PATH = "README.md";

const EngramManifestSchema = z.object({
  name: z.string().min(1, "Name cannot be empty"),
  description: z
    .string()
    .min(20, "Description must be at least 20 characters for discoverability"),
  version: z.string().optional(),
  license: z.string().optional(),
  /** Relative path to prompt file from engram root. Defaults to README.md */
  prompt: z.string().optional(),
  /** Trigger configuration for progressive engram discovery */
  triggers: z
    .object({
      /** Triggers that match any message (user or agent) */
      "any-msg": z.array(z.string()).optional(),
      /** Triggers that only match user messages */
      "user-msg": z.array(z.string()).optional(),
      /** Triggers that only match agent messages */
      "agent-msg": z.array(z.string()).optional(),
    })
    .optional(),
  /** Configuration for wrapped external repositories */
  wrap: z
    .object({
      /** Git remote URL (any format git understands: https, ssh, file, etc.) */
      remote: z.string(),
      /** Git ref to checkout (branch, tag, or commit hash) */
      ref: z.string().optional(),
      /** Sparse-checkout patterns (glob patterns for files to include) */
      sparse: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Manual oneliners for files/directories.
   * Keys are relative paths from engram root (use trailing / for directories).
   * These take precedence over file-based oneliners (comments, .oneliner files).
   * Useful for wrapped repos where you can't modify the content.
   */
  oneliners: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  author: z
    .object({
      name: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

type EngramManifest = z.infer<typeof EngramManifestSchema>;

function logManifestErrors(
  manifestPath: string,
  error: z.ZodError<EngramManifest>,
) {
  logError(`Invalid manifest in ${manifestPath}:`);
  for (const issue of error.issues) {
    logError(` - ${issue.path.join(".")}: ${issue.message}`);
  }
}

export function generateToolName(engramPath: string, baseDir?: string): string {
  if (typeof engramPath !== "string" || engramPath.length === 0) {
    logWarning(
      "Received invalid engram path while generating tool name; defaulting to engram_unknown.",
    );
    return "engram_unknown";
  }

  const safeBase =
    typeof baseDir === "string" && baseDir.length > 0
      ? baseDir
      : dirname(engramPath);
  const relativePath = relative(safeBase, engramPath);
  const dirPath = dirname(relativePath);

  if (dirPath === "." || dirPath === "") {
    const folder = basename(dirname(engramPath));
    return `engram_${folder.replace(/-/g, "_")}`;
  }

  const components = dirPath.split(sep).filter((part) => part !== ".");
  return `engram_${components.join("_").replace(/-/g, "_")}`;
}

/**
 * Parses an engram from its manifest file.
 * @param manifestPath - Path to the engram.toml file
 * @param baseDir - Base directory for generating tool names
 */
export async function parseEngram(
  manifestPath: string,
  baseDir: string,
): Promise<Engram | null> {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    logWarning("Skipping engram with invalid path:", manifestPath);
    return null;
  }

  const engramDirectory = dirname(manifestPath);

  try {
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifestData = TOML.parse(manifestRaw);
    const parsed = EngramManifestSchema.safeParse(manifestData);

    if (!parsed.success) {
      logManifestErrors(manifestPath, parsed.error);
      return null;
    }

    // Read prompt file (configurable via manifest, defaults to README.md at engram root)
    const promptRelativePath = parsed.data.prompt || DEFAULT_PROMPT_PATH;
    const promptPath = join(engramDirectory, promptRelativePath);

    let promptContent = "";
    try {
      promptContent = await fs.readFile(promptPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      logWarning(`Missing prompt file: ${promptPath}`);
    }

    const triggers = parsed.data.triggers;
    const hasTriggers =
      (triggers?.["any-msg"]?.length ?? 0) > 0 ||
      (triggers?.["user-msg"]?.length ?? 0) > 0 ||
      (triggers?.["agent-msg"]?.length ?? 0) > 0;

    return {
      name: parsed.data.name,
      directory: engramDirectory,
      toolName: generateToolName(manifestPath, baseDir),
      description: parsed.data.description,
      allowedTools: parsed.data["allowed-tools"],
      triggers: hasTriggers
        ? {
            anyMsg: triggers?.["any-msg"],
            userMsg: triggers?.["user-msg"],
            agentMsg: triggers?.["agent-msg"],
          }
        : undefined,
      wrap: parsed.data.wrap,
      oneliners: parsed.data.oneliners,
      metadata: parsed.data.metadata,
      license: parsed.data.license,
      content: promptContent.trim(),
      manifestPath,
    };
  } catch (error) {
    logError(`Error parsing engram ${manifestPath}:`, error);
    return null;
  }
}
