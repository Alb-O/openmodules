import * as fs from "fs";
import * as path from "path";

/**
 * Get the path to the bundled plugin.
 * Returns null if not found.
 */
export function getBundledPluginPath(): string | null {
  // Try multiple possible locations for the bundle
  // When running from source: cli/src/cache/ -> need ../../../dist/
  // When running from built CLI: dist/ -> need ../dist/
  // When installed via Nix: $out/bin/openmodule -> $out/share/openmodules/openmodules.min.js
  const execDir = path.dirname(process.execPath);

  const possiblePaths = [
    path.join(__dirname, "..", "..", "..", "dist", "openmodules.bundle.js"), // from cli/src/cache/
    path.join(__dirname, "..", "dist", "openmodules.bundle.js"), // from built cli dist/
    path.join(execDir, "..", "share", "openmodules", "openmodules.min.js"), // from Nix
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
  options?: { force?: boolean }
): { installed: boolean; path: string } | { error: string } {
  const bundledPath = getBundledPluginPath();
  if (!bundledPath) {
    return { error: "Could not find bundled plugin. Is the CLI properly installed?" };
  }

  const pluginsDir = path.join(targetDir, ".opencode", "plugin");
  const pluginPath = path.join(pluginsDir, "openmodules.min.js");

  // Check if already exists (unless force)
  const exists = fs.existsSync(pluginPath);
  if (exists && !options?.force) {
    return { installed: false, path: pluginPath };
  }

  // Create plugins directory if needed
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Remove existing file if forcing (may be read-only from Nix)
  if (exists) {
    fs.unlinkSync(pluginPath);
  }

  // Copy the plugin
  fs.copyFileSync(bundledPath, pluginPath);

  return { installed: true, path: pluginPath };
}
