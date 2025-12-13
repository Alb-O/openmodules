import { command, positional, option, multioption, flag, string, optional, array } from "cmd-ts";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { getModulePaths, findProjectRoot, parseRepoUrl, getEngramName } from "../utils";
import { cloneWithSparseCheckout } from "../cache";

/** Subdirectory where cloned repo content lives */
export const CONTENT_DIR = "content";

/** Files that are engram-specific manifest files */
export const MANIFEST_FILES = new Set([
  "engram.toml",
  "README.md",
  ".gitignore",
  ".ignore",
  ".oneliner",
  ".oneliner.txt",
]);

/**
 * Generate a README.md for the engram based on repo info and content paths.
 */
function generateReadme(
  name: string,
  description: string,
  repoUrl: string | null,
  contentPath: string,
): string {
  const lines = [`# ${name}`, "", description, ""];

  if (repoUrl) {
    lines.push(`Source: ${repoUrl}`, "");
  }

  lines.push(
    `## Documentation`,
    "",
    `This engram provides documentation from the \`${contentPath}/\` directory.`,
    "",
    `Use the file tree below to navigate and request specific files.`,
    "",
  );

  return lines.join("\n");
}

interface WrapConfig {
  remote: string;
  ref?: string;
  sparse: string[];
  lock?: boolean;
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
    if (wrap.lock) {
      lines.push(`lock = true`);
    }
  }

  if (triggers.length > 0) {
    lines.push("", "[disclosure-triggers]");
    const triggerList = triggers.map(t => `"${t}"`).join(", ");
    lines.push(`user-msg = [${triggerList}]`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Infer a reasonable name from a repo URL or path.
 */
function inferName(source: string): string {
  const parsed = parseRepoUrl(source);
  if (parsed) {
    return parsed.repo
      .replace(/^eg\./, "")
      .split("-")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  const basename = path.basename(source);
  return basename
    .replace(/^eg\./, "")
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Infer content path from sparse patterns or directory structure.
 * Now always prefixed with content/ since that's where cloned repos live.
 */
function inferContentPath(patterns: string[], targetDir: string): string {
  const contentDir = path.join(targetDir, CONTENT_DIR);
  
  if (patterns.length > 0) {
    const firstPattern = patterns[0];
    const match = firstPattern.match(/^([^*]+)\//);
    if (match) {
      return `${CONTENT_DIR}/${match[1]}`;
    }
  }

  if (fs.existsSync(contentDir)) {
    const docDirs = ["docs", "doc", "documentation"];
    for (const dir of docDirs) {
      if (fs.existsSync(path.join(contentDir, dir))) {
        return `${CONTENT_DIR}/${dir}`;
      }
    }
  }

  return CONTENT_DIR;
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
    noCache: flag({
      long: "no-cache",
      description: "Skip repo cache and clone directly from remote",
    }),
    lock: flag({
      long: "lock",
      description: "Lock to exact commit for reproducibility (captured in index on sync)",
    }),
  },
  handler: async ({ source, name, engramName, description, ref, sparse, triggers, global: isGlobal, lazy, force, noCache, lock }) => {
    const projectRoot = findProjectRoot();
    const paths = getModulePaths(projectRoot || undefined);

    const parsed = parseRepoUrl(source);
    const isRemote = parsed !== null;
    const isLocalPath = !isRemote && (source.startsWith("/") || source.startsWith("./") || source.startsWith("../"));

    if (!isRemote && !isLocalPath) {
      console.error(pc.red(`Error: Invalid source: ${source}`));
      console.error(pc.dim("Provide a repository (owner/repo, URL) or a local path (./path, /absolute/path)"));
      process.exit(1);
    }

    const dirName = engramName || (parsed ? getEngramName(parsed.repo) : path.basename(source));
    const engramsDir = isGlobal ? paths.global : paths.local;

    if (!engramsDir) {
      console.error(pc.red("Error: Not in a project directory"));
      console.error(pc.dim("Use --global to install globally, or run from a git repository"));
      process.exit(1);
    }

    const targetDir = path.join(engramsDir, dirName);

    if (force && fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(pc.yellow(`Removed existing engram at ${targetDir}`));
    }

    if (fs.existsSync(targetDir)) {
      console.error(pc.red(`Error: Engram already exists at ${targetDir}`));
      console.error(pc.dim("Use --force to overwrite"));
      process.exit(1);
    }

    if (!fs.existsSync(engramsDir)) {
      fs.mkdirSync(engramsDir, { recursive: true });
    }

    if (isRemote) {
      if (lazy) {
        // Lazy mode: just create the directory for the manifest
        console.log(pc.blue(`Creating lazy engram for ${parsed!.owner}/${parsed!.repo}...`));
        fs.mkdirSync(targetDir, { recursive: true });
      } else {
        // Full mode: create engram directory and clone into content/
        console.log(pc.blue(`Cloning ${parsed!.owner}/${parsed!.repo}...`));

        if (sparse.length > 0) {
          console.log(pc.dim(`Sparse patterns: ${sparse.join(", ")}`));
        }
        if (ref) {
          console.log(pc.dim(`Ref: ${ref}`));
        }

        // Create engram directory and clone into content/ subdirectory
        fs.mkdirSync(targetDir, { recursive: true });
        const contentDir = path.join(targetDir, CONTENT_DIR);
        cloneWithSparseCheckout(parsed!.url, contentDir, { ref, sparse, noCache });
      }
    } else {
      if (lazy) {
        console.error(pc.red("Error: --lazy flag is only valid for remote repositories"));
        process.exit(1);
      }
      const absoluteSource = path.resolve(source);
      if (!fs.existsSync(absoluteSource)) {
        console.error(pc.red(`Error: Source path does not exist: ${absoluteSource}`));
        process.exit(1);
      }

      console.log(pc.blue(`Linking ${absoluteSource}...`));
      const relativePath = path.relative(engramsDir, absoluteSource);
      fs.symlinkSync(relativePath, targetDir);
    }

    const manifestPath = path.join(targetDir, "engram.toml");
    const readmePath = path.join(targetDir, "README.md");
    const hasManifest = fs.existsSync(manifestPath);

    if (hasManifest) {
      console.log(pc.green(`✓ Wrapped existing engram: ${dirName}`));
      console.log(pc.dim(`  ${targetDir}`));
      return;
    }

    const inferredName = name || inferName(source);
    const contentPath = inferContentPath(sparse, targetDir);
    const inferredDescription = description || 
      `Documentation from ${parsed ? `${parsed.owner}/${parsed.repo}` : path.basename(source)}` +
      (contentPath ? ` (${contentPath}/)` : "");

    // Infer triggers from name if none provided
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

    const wrapConfig: WrapConfig | undefined = isRemote
      ? { remote: parsed!.url, ref, sparse, lock: lock || undefined }
      : undefined;

    const manifest = generateManifest(inferredName, inferredDescription, inferredTriggers, wrapConfig);
    fs.writeFileSync(manifestPath, manifest);

    if (!fs.existsSync(readmePath)) {
      const readme = generateReadme(
        inferredName,
        inferredDescription,
        parsed?.url.replace(/\.git$/, "") || null,
        contentPath,
      );
      fs.writeFileSync(readmePath, readme);
    }

    const gitignorePath = path.join(targetDir, ".gitignore");
    const gitignoreComment = lazy
      ? "# Cloned repo content (run 'engram lazy-init' to populate)"
      : "# Cloned repo content";
    const gitignoreContent = [gitignoreComment, `/${CONTENT_DIR}/`, ""].join(
      "\n",
    );
    fs.writeFileSync(gitignorePath, gitignoreContent);

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
