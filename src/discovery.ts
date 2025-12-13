import os from "os";
import { promises as fs, Dirent } from "fs";
import { dirname, join, sep } from "path";
import type { Module } from "./types";
import { logWarning } from "./logging";
import { MANIFEST_FILENAME, parseModule } from "./manifest";

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

/**
 * Establishes parent-child relationships between modules based on directory hierarchy.
 * A module is a child of another if its directory is a descendant of the parent's directory.
 * Only the closest ancestor is set as the parent.
 * Uses realpath to resolve symlinks for accurate ancestry detection.
 */
async function establishModuleHierarchy(modules: Module[]): Promise<void> {
  // Resolve real paths for all modules to handle symlinks correctly
  const realPaths = new Map<Module, string>();
  for (const module of modules) {
    try {
      realPaths.set(module, await fs.realpath(module.directory));
    } catch {
      // If realpath fails, use original path
      realPaths.set(module, module.directory);
    }
  }

  // Sort by resolved directory depth (shallowest first)
  const sortedByDepth = [...modules].sort((a, b) => {
    const aPath = realPaths.get(a) || a.directory;
    const bPath = realPaths.get(b) || b.directory;
    return aPath.split(sep).length - bPath.split(sep).length;
  });

  // Map from resolved directory to module for quick lookup
  const dirToModule = new Map<string, Module>();
  for (const module of sortedByDepth) {
    const realPath = realPaths.get(module) || module.directory;
    dirToModule.set(realPath, module);
  }

  // For each module, find its closest ancestor that is also a module
  for (const module of sortedByDepth) {
    const realPath = realPaths.get(module) || module.directory;
    let currentDir = dirname(realPath);

    while (currentDir && currentDir !== dirname(currentDir)) {
      const parentModule = dirToModule.get(currentDir);
      if (parentModule) {
        // Found the closest parent
        module.parentToolName = parentModule.toolName;

        // Add this module to parent's children
        if (!parentModule.childToolNames) {
          parentModule.childToolNames = [];
        }
        parentModule.childToolNames.push(module.toolName);
        break;
      }
      currentDir = dirname(currentDir);
    }
  }
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

  const toolNames = new Map<string, string>(); // toolName -> manifestPath
  const duplicates: { toolName: string; paths: string[] }[] = [];

  for (const module of modules) {
    const existing = toolNames.get(module.toolName);
    if (existing) {
      // Find or create duplicate entry
      const dup = duplicates.find((d) => d.toolName === module.toolName);
      if (dup) {
        dup.paths.push(module.manifestPath);
      } else {
        duplicates.push({
          toolName: module.toolName,
          paths: [existing, module.manifestPath],
        });
      }
    }
    toolNames.set(module.toolName, module.manifestPath);
  }

  if (duplicates.length > 0) {
    const details = duplicates
      .map(
        (d) =>
          `  ${d.toolName}:\n${d.paths.map((p) => `    - ${p}`).join("\n")}`,
      )
      .join("\n");
    throw new Error(
      `Duplicate tool names detected. Each module must have a unique path.\n${details}`,
    );
  }

  // Establish parent-child relationships based on directory hierarchy
  await establishModuleHierarchy(modules);

  return modules;
}

export function getDefaultModulePaths(rootDir: string): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const globalModulesPath = xdgConfigHome
    ? join(xdgConfigHome, "openmodules")
    : join(os.homedir(), ".config", "openmodules");

  return [globalModulesPath, join(rootDir, ".openmodules")];
}
