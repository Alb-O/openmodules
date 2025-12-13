// Re-export all public APIs from focused modules for backward compatibility
export type { Module, ContextTriggerMatcher, FileTreeOptions } from "./types";
export { logWarning, logError } from "./logging";
export { expandBraces, compileContextTrigger, buildContextTriggerMatchers } from "./triggers";
export { generateToolName, parseModule } from "./manifest";
export { findModuleFiles, discoverModules, getDefaultModulePaths } from "./discovery";
export { generateFileTree } from "./file-tree";
