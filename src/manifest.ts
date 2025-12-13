import * as TOML from "@iarna/toml";
import { promises as fs } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { z } from "zod";
import type { Module } from "./types";
import { logWarning, logError } from "./logging";

/** Manifest filename at module root */
export const MANIFEST_FILENAME = "openmodule.toml";
/** Default prompt file relative to module root */
const DEFAULT_PROMPT_PATH = "README.md";

const ModuleManifestSchema = z.object({
    name: z.string().min(1, "Name cannot be empty"),
    description: z
        .string()
        .min(
            20,
            "Description must be at least 20 characters for discoverability",
        ),
    version: z.string().optional(),
    license: z.string().optional(),
    /** Relative path to prompt file from module root. Defaults to README.md */
    prompt: z.string().optional(),
    /** Trigger configuration for progressive module discovery */
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
    "allowed-tools": z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    author: z
        .object({
            name: z.string().optional(),
            url: z.string().optional(),
        })
        .optional(),
});

type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

function logManifestErrors(
    manifestPath: string,
    error: z.ZodError<ModuleManifest>,
) {
    logError(`Invalid manifest in ${manifestPath}:`);
    for (const issue of error.issues) {
        logError(` - ${issue.path.join(".")}: ${issue.message}`);
    }
}

export function generateToolName(modulePath: string, baseDir?: string): string {
    if (typeof modulePath !== "string" || modulePath.length === 0) {
        logWarning(
            "Received invalid module path while generating tool name; defaulting to openmodule_unknown.",
        );
        return "openmodule_unknown";
    }

    const safeBase =
        typeof baseDir === "string" && baseDir.length > 0
            ? baseDir
            : dirname(modulePath);
    const relativePath = relative(safeBase, modulePath);
    const dirPath = dirname(relativePath);

    if (dirPath === "." || dirPath === "") {
        const folder = basename(dirname(modulePath));
        return `openmodule_${folder.replace(/-/g, "_")}`;
    }

    const components = dirPath.split(sep).filter((part) => part !== ".");
    return `openmodule_${components.join("_").replace(/-/g, "_")}`;
}

/**
 * Parses a module from its manifest file.
 * @param manifestPath - Path to the openmodule.toml file
 * @param baseDir - Base directory for generating tool names
 */
export async function parseModule(
    manifestPath: string,
    baseDir: string,
): Promise<Module | null> {
    if (typeof manifestPath !== "string" || manifestPath.length === 0) {
        logWarning("Skipping module with invalid path:", manifestPath);
        return null;
    }

    const moduleDirectory = dirname(manifestPath);

    try {
        const manifestRaw = await fs.readFile(manifestPath, "utf8");
        const manifestData = TOML.parse(manifestRaw);
        const parsed = ModuleManifestSchema.safeParse(manifestData);

        if (!parsed.success) {
            logManifestErrors(manifestPath, parsed.error);
            return null;
        }

        // Read prompt file (configurable via manifest, defaults to README.md at module root)
        const promptRelativePath = parsed.data.prompt || DEFAULT_PROMPT_PATH;
        const promptPath = join(moduleDirectory, promptRelativePath);

        let promptContent = "";
        try {
            promptContent = await fs.readFile(promptPath, "utf8");
        } catch (error: any) {
            if (error?.code === "ENOENT") {
                logWarning(`Missing prompt file: ${promptPath}`);
            } else {
                throw error;
            }
        }

        const triggers = parsed.data.triggers;
        const hasTriggers =
            (triggers?.["any-msg"]?.length ?? 0) > 0 ||
            (triggers?.["user-msg"]?.length ?? 0) > 0 ||
            (triggers?.["agent-msg"]?.length ?? 0) > 0;

        return {
            name: parsed.data.name,
            directory: moduleDirectory,
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
            metadata: parsed.data.metadata,
            license: parsed.data.license,
            content: promptContent.trim(),
            manifestPath,
        };
    } catch (error) {
        logError(`Error parsing module ${manifestPath}:`, error);
        return null;
    }
}
