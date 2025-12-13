import { command, positional, option, multioption, flag, string, optional, array } from "cmd-ts";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot, parseRepoUrl, getEngramName } from "../utils";

/** Files that are engram-specific and should stay at root level */
const MANIFEST_FILES = new Set([
  "engram.toml",
  "README.md",
  ".gitignore",
  ".ignore",
  ".oneliner",
  ".oneliner.txt",
]);

/**
 * Check if cloned content has any files at root level (not just directories).
 * If so, we need to reorganize into content/ to avoid conflicts.
 */
function hasRootLevelFiles(dir: string): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip manifest files - they're ours
    if (MANIFEST_FILES.has(entry.name)) continue;
    // Skip .git directory
    if (entry.name === ".git") continue;
    // If it's a file (not directory), we have root-level files
    if (entry.isFile()) return true;
  }
  return false;
}

/**
 * Reorganize cloned content into content/ subdirectory.
 * Preserves manifest files at root level.
 */
export function reorganizeIntoContent(dir: string): boolean {
  if (!hasRootLevelFiles(dir)) {
    return false; // No reorganization needed
  }

  const contentDir = path.join(dir, "content");
  fs.mkdirSync(contentDir, { recursive: true });

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    // Skip manifest files and the content dir we just created
    if (MANIFEST_FILES.has(entry) || entry === "content") continue;
    // Skip .git directory
    if (entry === ".git") continue;

    const srcPath = path.join(dir, entry);
    const destPath = path.join(contentDir, entry);
    fs.renameSync(srcPath, destPath);
  }

  return true; // Reorganized
}

/**
 * Clone a repo with optional sparse-checkout and ref.
 * Uses blobless clone for efficiency.
 */
function cloneRepo(
  url: string,
  targetDir: string,
  options: { ref?: string; sparse?: string[] } = {},
): void {
  const { ref, sparse } = options;

  // Build clone command
  // Use --no-checkout if we need to configure sparse first, or checkout specific ref
  const needsDelayedCheckout = (sparse && sparse.length > 0) || ref;
  const depthFlag = ref ? "" : "--depth 1"; // Can't use depth with specific ref easily
  const checkoutFlag = needsDelayedCheckout ? "--no-checkout" : "";
  const branchFlag = ref && !ref.match(/^[0-9a-f]{40}$/i) ? `-b ${ref}` : ""; // Branch/tag, not commit hash

  execSync(
    `git clone --filter=blob:none ${depthFlag} ${checkoutFlag} ${branchFlag} ${url} ${targetDir}`.replace(/\s+/g, " ").trim(),
    { stdio: "inherit" },
  );

  // Configure sparse-checkout if patterns provided
  if (sparse && sparse.length > 0) {
    execSync(`git sparse-checkout init`, { cwd: targetDir, stdio: "pipe" });
    execSync(`git sparse-checkout set --no-cone ${sparse.map(p => `'${p}'`).join(" ")}`, {
      cwd: targetDir,
      stdio: "pipe",
      shell: "/bin/sh",
    });
  }

  // Checkout specific ref if needed
  if (needsDelayedCheckout) {
    const checkoutRef = ref || "HEAD";
    execSync(`git checkout ${checkoutRef}`, { cwd: targetDir, stdio: "inherit" });
  }
}

/**
 * Generate a README.md for the engram based on repo info and content paths.
 */
function generateReadme(
  name: string,
  description: string,
  repoUrl: string | null,
  contentPath: string | null,
): string {
  const lines = [`# ${name}`, "", description, ""];

  if (repoUrl) {
    lines.push(`Source: ${repoUrl}`, "");
  }

  if (contentPath) {
    lines.push(
      `## Documentation`,
      "",
      `This engram provides documentation from the \`${contentPath}/\` directory.`,
      "",
      `Use the file tree below to navigate and request specific files.`,
      "",
    );
  } else {
    lines.push(
      `## Contents`,
      "",
      `Use the file tree below to explore available documentation.`,
      "",
    );
  }

  return lines.join("\n");
}

interface WrapConfig {
  remote: string;
  ref?: string;
  sparse: string[];
}

/**
 * Generate an engram.toml manifest.
 */
function generateManifest(
  name: string,
  description: string,
  triggers: string[],
  wrap?: WrapConfig,
): string {
  const lines = [
    `name = "${name}"`,
    `version = "1.0.0"`,
    `description = "${description}"`,
  ];

  if (wrap) {
    lines.push("", "[wrap]");
    lines.push(`remote = "${wrap.remote}"`);
    if (wrap.ref) {
      lines.push(`ref = "${wrap.ref}"`);
    }
    if (wrap.sparse.length > 0) {
      const patternList = wrap.sparse.map(p => `"${p}"`).join(", ");
      lines.push(`sparse = [${patternList}]`);
    }
  }

  if (triggers.length > 0) {
    lines.push("", "[triggers]");
    const triggerList = triggers.map(t => `"${t}"`).join(", ");
    lines.push(`user-msg = [${triggerList}]`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Infer a reasonable name from a repo URL or path.
 */
function inferName(source: string): string {
  // Try parsing as URL first
  const parsed = parseRepoUrl(source);
  if (parsed) {
    return parsed.repo
      .replace(/^eg\./, "")
      .split("-")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Fall back to directory name
  const basename = path.basename(source);
  return basename
    .replace(/^eg\./, "")
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Infer content path from sparse patterns or directory structure.
 */
function inferContentPath(patterns: string[], targetDir: string): string | null {
  // If we have sparse patterns, extract the common prefix
  if (patterns.length > 0) {
    const firstPattern = patterns[0];
    const match = firstPattern.match(/^([^*]+)\//);
    if (match) {
      return match[1];
    }
  }

  // Look for common documentation directories
  const docDirs = ["docs", "doc", "documentation", "content"];
  for (const dir of docDirs) {
    if (fs.existsSync(path.join(targetDir, dir))) {
      return dir;
    }
  }

  return null;
}

export const wrap = command({
  name: "wrap",
  description: "Wrap an existing repository or directory as an engram with sparse-checkout support",
  args: {
    source: positional({
      type: string,
      displayName: "source",
      description: "Repository URL (owner/repo, full URL) or local path to wrap",
    }),
    name: option({
      type: optional(string),
      long: "name",
      short: "n",
      description: "Display name for the engram",
    }),
    engramName: option({
      type: optional(string),
      long: "as",
      short: "a",
      description: "Directory name in .engrams/ (defaults to repo name)",
    }),
    description: option({
      type: optional(string),
      long: "description",
      short: "d",
      description: "Description of the engram",
    }),
    ref: option({
      type: optional(string),
      long: "ref",
      short: "r",
      description: "Git ref to checkout (branch, tag, or commit)",
    }),
    sparse: multioption({
      type: array(string),
      long: "sparse",
      short: "s",
      description: "Sparse-checkout pattern (can be repeated, e.g. --sparse 'docs/**/*.md')",
    }),
    triggers: multioption({
      type: array(string),
      long: "trigger",
      short: "t",
      description: "Trigger keyword (can be repeated, e.g. --trigger bun --trigger bunx)",
    }),
    global: flag({
      long: "global",
      short: "g",
      description: "Install globally instead of in project",
    }),
    lazy: flag({
      long: "lazy",
      short: "l",
      description: "Create manifest only, clone content on first use (for version control)",
    }),
    force: flag({
      long: "force",
      short: "f",
      description: "Overwrite existing engram",
    }),
  },
  handler: async ({ source, name, engramName, description, ref, sparse, triggers, global: isGlobal, lazy, force }) => {
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    // Determine if source is a URL or local path
    const parsed = parseRepoUrl(source);
    const isRemote = parsed !== null;
    const isLocalPath = !isRemote && (source.startsWith("/") || source.startsWith("./") || source.startsWith("../"));

    if (!isRemote && !isLocalPath) {
      console.error(pc.red(`Error: Invalid source: ${source}`));
      console.error(pc.dim("Provide a repository (owner/repo, URL) or a local path (./path, /absolute/path)"));
      process.exit(1);
    }

    // Determine target directory
    const dirName = engramName || (parsed ? getEngramName(parsed.repo) : path.basename(source));
    const engramsDir = isGlobal ? paths.global : paths.local;

    if (!engramsDir) {
      console.error(pc.red("Error: Not in a project directory"));
      console.error(pc.dim("Use --global to install globally, or run from a git repository"));
      process.exit(1);
    }

    const targetDir = path.join(engramsDir, dirName);

    // Handle force cleanup
    if (force && fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(pc.yellow(`Removed existing engram at ${targetDir}`));
    }

    if (fs.existsSync(targetDir)) {
      console.error(pc.red(`Error: Engram already exists at ${targetDir}`));
      console.error(pc.dim("Use --force to overwrite"));
      process.exit(1);
    }

    // Ensure parent directory exists
    if (!fs.existsSync(engramsDir)) {
      fs.mkdirSync(engramsDir, { recursive: true });
    }

    // Handle remote repos
    if (isRemote) {
      if (lazy) {
        // Lazy mode: just create the directory for the manifest
        console.log(pc.blue(`Creating lazy engram for ${parsed!.owner}/${parsed!.repo}...`));
        fs.mkdirSync(targetDir, { recursive: true });
      } else {
        // Full mode: clone the repo
        console.log(pc.blue(`Cloning ${parsed!.owner}/${parsed!.repo}...`));

        if (sparse.length > 0) {
          console.log(pc.dim(`Sparse patterns: ${sparse.join(", ")}`));
        }
        if (ref) {
          console.log(pc.dim(`Ref: ${ref}`));
        }

        cloneRepo(parsed!.url, targetDir, { ref, sparse });

        // Check if we need to reorganize content to avoid conflicts
        if (reorganizeIntoContent(targetDir)) {
          console.log(pc.dim(`Reorganized content into content/ subdirectory`));
        }
      }
    } else {
      if (lazy) {
        console.error(pc.red("Error: --lazy flag is only valid for remote repositories"));
        process.exit(1);
      }
      // Handle local paths - create symlink
      const absoluteSource = path.resolve(source);
      if (!fs.existsSync(absoluteSource)) {
        console.error(pc.red(`Error: Source path does not exist: ${absoluteSource}`));
        process.exit(1);
      }

      console.log(pc.blue(`Linking ${absoluteSource}...`));
      const relativePath = path.relative(engramsDir, absoluteSource);
      fs.symlinkSync(relativePath, targetDir);
    }

    // Check if engram.toml already exists
    const manifestPath = path.join(targetDir, "engram.toml");
    const readmePath = path.join(targetDir, "README.md");
    const hasManifest = fs.existsSync(manifestPath);

    if (hasManifest) {
      console.log(pc.green(`✓ Wrapped existing engram: ${dirName}`));
      console.log(pc.dim(`  ${targetDir}`));
      return;
    }

    // Generate manifest and README
    const inferredName = name || inferName(source);
    const contentPath = inferContentPath(sparse, targetDir);
    const inferredDescription = description || 
      `Documentation from ${parsed ? `${parsed.owner}/${parsed.repo}` : path.basename(source)}` +
      (contentPath ? ` (${contentPath}/)` : "");

    // Infer triggers from name if not provided
    const inferredTriggers = triggers.length > 0 ? triggers : 
      inferredName.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    console.log(pc.dim(`Generating engram manifest...`));
    console.log(pc.dim(`  Name: ${inferredName}`));
    console.log(pc.dim(`  Description: ${inferredDescription}`));
    if (isRemote) {
      console.log(pc.dim(`  Remote: ${parsed!.url}`));
      if (ref) {
        console.log(pc.dim(`  Ref: ${ref}`));
      }
      if (sparse.length > 0) {
        console.log(pc.dim(`  Sparse: ${sparse.join(", ")}`));
      }
    }
    if (inferredTriggers.length > 0) {
      console.log(pc.dim(`  Triggers: ${inferredTriggers.join(", ")}`));
    }

    // Build wrap config for remote repos
    const wrapConfig: WrapConfig | undefined = isRemote
      ? { remote: parsed!.url, ref, sparse }
      : undefined;

    // Write manifest
    const manifest = generateManifest(inferredName, inferredDescription, inferredTriggers, wrapConfig);
    fs.writeFileSync(manifestPath, manifest);

    // Write README if it doesn't exist
    if (!fs.existsSync(readmePath)) {
      const readme = generateReadme(
        inferredName,
        inferredDescription,
        parsed?.url.replace(/\.git$/, "") || null,
        contentPath,
      );
      fs.writeFileSync(readmePath, readme);
    }

    // For lazy mode, create .gitignore to exclude cloned content
    if (lazy) {
      const gitignorePath = path.join(targetDir, ".gitignore");
      const gitignoreContent = [
        "# Ignore cloned content, keep manifest files",
        "*",
        "!.gitignore",
        "!.ignore",
        "!engram.toml",
        "!README.md",
        "!.oneliner",
        "!.oneliner.txt",
        "",
      ].join("\n");
      fs.writeFileSync(gitignorePath, gitignoreContent);
    }

    if (lazy) {
      console.log(pc.green(`✓ Created lazy engram: ${dirName}`));
      console.log(pc.dim(`  ${targetDir}`));
      console.log("");
      console.log(pc.dim("Run to initialize:"));
      console.log(pc.dim(`  engram lazy-init ${dirName}`));
    } else {
      console.log(pc.green(`✓ Created engram: ${dirName}`));
      console.log(pc.dim(`  ${targetDir}`));
      console.log("");
      console.log(pc.dim("You can customize the engram by editing:"));
      console.log(pc.dim(`  ${manifestPath}`));
      console.log(pc.dim(`  ${readmePath}`));
    }
  },
});
