import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Get the path to the bundled plugin.
 * Returns null if not found.
 */
export function getBundledPluginPath(): string | null {
  // Try multiple possible locations for the bundle
  // Installed binary: prefer packaged share path to avoid stale local dist
  // Source checkout: allow local dist overrides when running via ts-node/node
  const execDir = path.dirname(process.execPath);
  const cwd = process.cwd();

  const possiblePaths = [
    path.join(execDir, "..", "share", "engrams", "engrams.min.js"), // from Nix/installed binary
    path.join(__dirname, "..", "..", "dist", "engrams.bundle.js"), // from built cli in src/cli/cache/
    path.join(__dirname, "..", "..", "..", "dist", "engrams.bundle.js"), // fallback
    path.join(cwd, "dist", "engrams.bundle.js"), // local build in checkout
    path.join(cwd, "engrams.bundle.js"), // fallback if build was output alongside CWD
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Install plugin by copying to target directory.
 */
export function installPlugin(
  targetDir: string,
  options?: { force?: boolean },
): { installed: boolean; path: string } | { error: string } {
  const bundledPath = getBundledPluginPath();
  if (!bundledPath) {
    return {
      error: "Could not find bundled plugin. Is the CLI properly installed?",
    };
  }

  const bundledContent = fs.readFileSync(bundledPath);
  const pluginsDir = path.join(targetDir, ".opencode", "plugin");
  const pluginPath = path.join(pluginsDir, "engrams.min.js");

  // Reinstall when the bundled plugin differs, or when --force is used
  const exists = fs.existsSync(pluginPath);
  if (exists && !options?.force) {
    const existingContent = fs.readFileSync(pluginPath);
    if (existingContent.equals(bundledContent)) {
      return { installed: false, path: pluginPath };
    }
  }

  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Remove existing file before copy (may be read-only from Nix)
  if (exists) {
    fs.unlinkSync(pluginPath);
  }

  fs.copyFileSync(bundledPath, pluginPath);

  return { installed: true, path: pluginPath };
}
