import * as fs from "fs";
import * as path from "path";
import { getCacheDir } from "./index";

/**
 * Get the plugin cache directory.
 */
export function getPluginCacheDir(): string {
  return path.join(getCacheDir(), "plugins");
}

/**
 * Get the path for a specific plugin version in cache.
 */
export function getPluginCachePath(version: string): string {
  return path.join(getPluginCacheDir(), `openmodules-${version}.min.js`);
}

/**
 * Get the bundled plugin content with version header.
 * This reads from the CLI's bundled copy of the plugin.
 */
export function getBundledPlugin(): { version: string; content: string } | null {
  // Try multiple possible locations for the bundle
  // When running from source: cli/src/cache/ -> need ../../../dist/
  // When running from built CLI: dist/ -> need ../dist/
  const possibleBundlePaths = [
    path.join(__dirname, "..", "..", "..", "dist", "openmodules.bundle.js"), // from cli/src/cache/
    path.join(__dirname, "..", "dist", "openmodules.bundle.js"), // from built cli dist/
  ];
  const possiblePackageJsonPaths = [
    path.join(__dirname, "..", "..", "..", "package.json"), // from cli/src/cache/
    path.join(__dirname, "..", "package.json"), // from built cli dist/
  ];

  for (let i = 0; i < possibleBundlePaths.length; i++) {
    try {
      const bundlePath = possibleBundlePaths[i];
      const packageJsonPath = possiblePackageJsonPaths[i];
      
      const content = fs.readFileSync(bundlePath, "utf-8");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const version = packageJson.version || "0.0.0";
      
      // Add version header to content
      const versionedContent = `// openmodules-plugin v${version}\n${content}`;
      return { version, content: versionedContent };
    } catch {
      continue;
    }
  }
  
  return null;
}

/**
 * Ensure plugin version is in cache, returns path to cached plugin.
 */
export function ensurePluginCached(version: string, content: string): string {
  const cachePath = getPluginCachePath(version);
  const cacheDir = getPluginCacheDir();

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  if (!fs.existsSync(cachePath)) {
    fs.writeFileSync(cachePath, content);
  }

  return cachePath;
}

/**
 * Get installed plugin version from a project or global location.
 * Returns null if not installed or symlink is broken.
 */
export function getInstalledPluginVersion(pluginPath: string): string | null {
  try {
    if (!fs.existsSync(pluginPath)) {
      return null;
    }

    // Check if it's a symlink pointing to our cache
    const stats = fs.lstatSync(pluginPath);
    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(pluginPath);
      const match = target.match(/openmodules-([^/]+)\.min\.js$/);
      if (match) {
        // Verify symlink target exists
        if (fs.existsSync(pluginPath)) {
          return match[1];
        }
        return null; // Broken symlink
      }
    }

    // Read version from file header
    const content = fs.readFileSync(pluginPath, "utf-8");
    const match = content.match(/^\/\/ openmodules-plugin v([^\n]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Install plugin to a directory via symlink to cache.
 */
export function installPlugin(
  targetDir: string,
  options?: { force?: boolean }
): { installed: boolean; version: string; path: string } | { error: string } {
  const bundled = getBundledPlugin();
  if (!bundled) {
    return { error: "Could not find bundled plugin. Is the CLI properly installed?" };
  }

  const pluginsDir = path.join(targetDir, ".opencode", "plugin");
  const pluginPath = path.join(pluginsDir, "openmodules.min.js");

  // Check existing installation
  const existingVersion = getInstalledPluginVersion(pluginPath);
  if (existingVersion === bundled.version && !options?.force) {
    return { installed: false, version: existingVersion, path: pluginPath };
  }

  // Ensure plugin is in cache
  const cachePath = ensurePluginCached(bundled.version, bundled.content);

  // Create plugins directory if needed
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Remove existing file/symlink if present
  try {
    const stats = fs.lstatSync(pluginPath);
    if (stats.isSymbolicLink() || stats.isFile()) {
      fs.unlinkSync(pluginPath);
    }
  } catch {
    // File doesn't exist, that's fine
  }

  // Create symlink to cached plugin
  fs.symlinkSync(cachePath, pluginPath);

  return { installed: true, version: bundled.version, path: pluginPath };
}
