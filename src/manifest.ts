import * as TOML from "@iarna/toml";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import type { Engram, TriggerConfig } from "./types";
import { logWarning, logError } from "./logging";

/** Manifest filename at engram root */
export const MANIFEST_FILENAME = "engram.toml";
/** Default prompt file relative to engram root */
const DEFAULT_PROMPT_PATH = "README.md";

/** Schema for trigger configuration (shared between disclosure and activation) */
const TriggerConfigSchema = z.object({
  /** Triggers that match any message (user or agent) */
  "any-msg": z.array(z.string()).optional(),
  /** Triggers that only match user messages */
  "user-msg": z.array(z.string()).optional(),
  /** Triggers that only match agent messages */
  "agent-msg": z.array(z.string()).optional(),
});

const EngramManifestSchema = z.object({
  name: z.string().min(1, "Name cannot be empty"),
  description: z
    .string()
    .min(20, "Description must be at least 20 characters for discoverability"),
  version: z.string().optional(),
  license: z.string().optional(),
  /** Relative path to prompt file from engram root. Defaults to README.md */
  prompt: z.string().optional(),
  /**
   * Disclosure triggers reveal the engram's name and description to the agent.
   * The agent can then decide whether to activate it.
   */
  "disclosure-triggers": TriggerConfigSchema.optional(),
  /**
   * Activation triggers immediately perform a full activation of the engram.
   * The engram content is injected without requiring agent action.
   */
  "activation-triggers": TriggerConfigSchema.optional(),
  /** Configuration for wrapped external repositories */
  wrap: z
    .object({
      /** Git remote URL (any format git understands: https, ssh, file, etc.) */
      remote: z.string(),
      /** Git ref to checkout (branch, tag, or commit hash) */
      ref: z.string().optional(),
      /** Sparse-checkout patterns (glob patterns for files to include) */
      sparse: z.array(z.string()).optional(),
      /** Lock to exact commit for reproducibility (captured in index on sync) */
      lock: z.boolean().optional(),
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

/** Convert TOML trigger config to internal TriggerConfig format */
function parseTriggerConfig(
  config: z.infer<typeof TriggerConfigSchema> | undefined,
): TriggerConfig | undefined {
  if (!config) return undefined;

  const hasAny = (config["any-msg"]?.length ?? 0) > 0;
  const hasUser = (config["user-msg"]?.length ?? 0) > 0;
  const hasAgent = (config["agent-msg"]?.length ?? 0) > 0;

  if (!hasAny && !hasUser && !hasAgent) return undefined;

  return {
    anyMsg: config["any-msg"],
    userMsg: config["user-msg"],
    agentMsg: config["agent-msg"],
  };
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
    const manifestFile = Bun.file(manifestPath);
    if (!(await manifestFile.exists())) {
      logWarning("Manifest file not found:", manifestPath);
      return null;
    }
    const manifestRaw = await manifestFile.text();
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
    const promptFile = Bun.file(promptPath);
    if (await promptFile.exists()) {
      promptContent = await promptFile.text();
    } else {
      logWarning(`Missing prompt file: ${promptPath}`);
    }

    const disclosureTriggers = parseTriggerConfig(
      parsed.data["disclosure-triggers"],
    );
    const activationTriggers = parseTriggerConfig(
      parsed.data["activation-triggers"],
    );

    return {
      name: parsed.data.name,
      directory: engramDirectory,
      toolName: generateToolName(manifestPath, baseDir),
      description: parsed.data.description,
      allowedTools: parsed.data["allowed-tools"],
      disclosureTriggers,
      activationTriggers,
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
