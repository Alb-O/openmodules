// Re-export all public APIs from focused source files
export type {
  Engram,
  ContextTriggerMatcher,
  FileTreeOptions,
  TriggerConfig,
  CompiledTriggerRegexes,
} from "./core/types";
export { logWarning, logError } from "./logging";
export {
  expandBraces,
  compileContextTrigger,
  buildContextTriggerMatchers,
} from "./core/triggers";
export { generateToolName, parseEngram } from "./core/manifest";
export {
  findEngramFiles,
  discoverEngrams,
  discoverEngramsWithLazy,
  getDefaultEngramPaths,
  readIndexRef,
  getEngramsFromIndex,
} from "./core/discovery";
export { generateFileTree } from "./tree/file-tree";
