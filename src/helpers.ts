import * as TOML from "@iarna/toml";
import os from "os";
import { promises as fs, Dirent } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import pkg from "../package.json";
import { extractOneliner } from "./comment-parser";

export interface Module {
    name: string;
    directory: string;
    toolName: string;
    description: string;
    allowedTools?: string[];
    metadata?: Record<string, string>;
    license?: string;
    content: string;
    /** Path to the openmodule.toml manifest */
    manifestPath: string;
    /** Phrases/words that trigger module visibility when they appear in context */
    contextTriggers?: string[];
    /** Whether to also match triggers in AI messages (default: false, user messages only) */
    matchAiMessages?: boolean;
}

/** Compiled matcher derived from a module's context-triggers */
export interface ContextTriggerMatcher {
    toolName: string;
    regexes: RegExp[];
    alwaysVisible: boolean;
    /** Whether to also match triggers in AI messages (default: false) */
    matchAiMessages: boolean;
}

const WILDCARD_PATTERN = /[*?\[]/;

function escapeRegex(input: string): string {
    return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function expandBraces(pattern: string): string[] {
    const start = pattern.indexOf("{");
    if (start === -1) return [pattern];

    let depth = 0;
    let end = -1;
    for (let i = start + 1; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "{") depth++;
        if (char === "}") {
            if (depth === 0) {
                end = i;
                break;
            }
            depth--;
        }
    }

    if (end === -1) return [pattern];

    const before = pattern.slice(0, start);
    const after = pattern.slice(end + 1);
    const body = pattern.slice(start + 1, end);

    const options: string[] = [];
    let current = "";
    depth = 0;

    for (const char of body) {
        if (char === "," && depth === 0) {
            options.push(current);
            current = "";
            continue;
        }

        if (char === "{") depth++;
        if (char === "}") depth--;
        current += char;
    }
    options.push(current);

    return options.flatMap((option) => expandBraces(`${before}${option}${after}`));
}

function globFragmentToRegex(pattern: string): string {
    let regex = "";

    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];

        if (char === "*") {
            if (pattern[i + 1] === "*") {
                regex += ".*";
                i++;
            } else {
                regex += ".*";
            }
            continue;
        }

        if (char === "?") {
            regex += ".";
            continue;
        }

        if (char === "[") {
            let j = i + 1;
            let content = "";
            while (j < pattern.length && pattern[j] !== "]") {
                content += pattern[j];
                j++;
            }

            if (j < pattern.length) {
                regex += `[${content}]`;
                i = j;
                continue;
            }
        }

        if (/\s/.test(char)) {
            regex += "\\s+";
            continue;
        }

        regex += escapeRegex(char);
    }

    return regex;
}

function globToRegExp(pattern: string, enforceWordBoundary: boolean): RegExp {
    const source = globFragmentToRegex(pattern);
    const bounded = enforceWordBoundary
        ? `(?:^|[^A-Za-z0-9])(?:${source})(?:[^A-Za-z0-9]|$)`
        : source;

    return new RegExp(bounded, "is");
}

export function compileContextTrigger(pattern: string): RegExp[] {
    if (typeof pattern !== "string") return [];
    const trimmed = pattern.trim();
    if (!trimmed) return [];

    const hasWildcard = WILDCARD_PATTERN.test(trimmed);
    const expansions = expandBraces(trimmed);

    return expansions.map((expanded) => globToRegExp(expanded, !hasWildcard));
}

export function buildContextTriggerMatchers(modules: Module[]): ContextTriggerMatcher[] {
    return modules.map((module) => {
        const regexes = (module.contextTriggers ?? []).flatMap((trigger) =>
            compileContextTrigger(trigger),
        );

        return {
            toolName: module.toolName,
            regexes,
            alwaysVisible: !(module.contextTriggers && module.contextTriggers.length > 0),
            matchAiMessages: module.matchAiMessages ?? false,
        };
    });
}

/** Manifest filename at module root */
const MANIFEST_FILENAME = "openmodule.toml";
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
            /** Phrases/words that trigger module visibility when they appear in context */
            context: z.array(z.string()).optional(),
            /** Whether to also match triggers in AI messages (default: false, user messages only) */
            "match-ai-messages": z.boolean().optional(),
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

export function logWarning(message: string, ...args: unknown[]) {
    console.warn(`[${pkg.name}] ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]) {
    console.error(`[${pkg.name}] ${message}`, ...args);
}

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
    const moduleFolderName = basename(moduleDirectory);

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

        return {
            name: parsed.data.name,
            directory: moduleDirectory,
            toolName: generateToolName(manifestPath, baseDir),
            description: parsed.data.description,
            allowedTools: parsed.data["allowed-tools"],
            contextTriggers: parsed.data.triggers?.context,
            matchAiMessages: parsed.data.triggers?.["match-ai-messages"],
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

/**
 * Finds all openmodule.toml files within a base path.
 * Returns paths to manifest files.
 */
export async function findModuleFiles(basePath: string): Promise<string[]> {
    const moduleFiles: string[] = [];
    const visited = new Set<string>();
    const queue = [basePath];

    while (queue.length > 0) {
        const current = queue.pop() as string;
        let realCurrent: string;

        try {
            realCurrent = await fs.realpath(current);
        } catch (error: any) {
            if (current === basePath && error?.code === "ENOENT") {
                throw error;
            }
            continue;
        }

        if (visited.has(realCurrent)) {
            continue;
        }
        visited.add(realCurrent);

        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch (error: any) {
            if (current === basePath && error?.code === "ENOENT") {
                throw error;
            }
            logWarning(`Unexpected error reading ${current}:`, error);
            continue;
        }

        for (const entry of entries) {
            const fullPath = join(current, entry.name);

            let stat: Dirent | Awaited<ReturnType<typeof fs.stat>>;

            if (entry.isSymbolicLink()) {
                try {
                    // fs.stat follows symlinks; broken links are skipped
                    stat = await fs.stat(fullPath);
                } catch {
                    continue;
                }
            } else {
                stat = entry;
            }

            if (stat.isDirectory()) {
                queue.push(fullPath);
            } else if (stat.isFile() && entry.name === MANIFEST_FILENAME) {
                moduleFiles.push(fullPath);
            }
        }
    }

    return moduleFiles;
}

function normalizeBasePaths(basePaths: unknown): string[] {
    if (Array.isArray(basePaths)) {
        return basePaths.filter((p): p is string => typeof p === "string");
    }

    if (typeof basePaths === "string") {
        return [basePaths];
    }

    logWarning(
        "Invalid basePaths provided to discoverModules; expected string[] or string.",
    );
    return [];
}

export async function discoverModules(basePaths: unknown): Promise<Module[]> {
    const paths = normalizeBasePaths(basePaths);
    if (paths.length === 0) {
        return [];
    }

    const modules: Module[] = [];
    let foundExistingDir = false;

    for (const basePath of paths) {
        try {
            const matches = await findModuleFiles(basePath);
            foundExistingDir = true;

            for (const match of matches) {
                const module = await parseModule(match, basePath);
                if (module) {
                    modules.push(module);
                }
            }
        } catch (error: any) {
            if (error?.code === "ENOENT") {
                continue;
            }
            logWarning(
                `Unexpected error while scanning modules in ${basePath}:`,
                error,
            );
        }
    }

    if (!foundExistingDir) {
        logWarning(
            "No modules directories found. Checked:\n" +
                paths.map((path) => `  - ${path}`).join("\n"),
        );
    }

    const toolNames = new Set<string>();
    const duplicates: string[] = [];

    for (const module of modules) {
        if (toolNames.has(module.toolName)) {
            duplicates.push(module.toolName);
        }
        toolNames.add(module.toolName);
    }

    if (duplicates.length > 0) {
        logWarning(`Duplicate tool names detected: ${duplicates.join(", ")}`);
    }

    return modules;
}

export function getDefaultModulePaths(rootDir: string): string[] {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const globalModulesPath = xdgConfigHome
        ? join(xdgConfigHome, "openmodules")
        : join(os.homedir(), ".config", "openmodules");

    return [globalModulesPath, join(rootDir, ".openmodules")];
}

export interface FileTreeOptions {
    maxDepth?: number;
    exclude?: RegExp[];
    dirsFirst?: boolean;
    ignoreFile?: string;
    includeMetadata?: boolean;
}

// Hide these files/directories by default. The manifest is already parsed, agent doesn't need to see it.
const DEFAULT_EXCLUDE_PATTERNS = [
    /^openmodule\.toml$/,
    /^\.ignore$/,
    /^\.oneliner(\.txt)?$/,
    /\.git/,
    /node_modules/,
    /dist/,
    /\.DS_Store/,
];

interface TreeEntry {
    name: string;
    path: string;
    isDirectory: boolean;
}

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
                    trimmed.length > 80
                        ? `${trimmed.slice(0, 77)}...`
                        : trimmed;
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
