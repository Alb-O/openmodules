// Re-export all public APIs from focused source files
export type {
  Engram,
  ContextTriggerMatcher,
  FileTreeOptions,
  TriggerConfig,
  CompiledTriggerRegexes,
} from "./core";
export { warn, error } from "./logging";
export {
  expandBraces,
  compileContextTrigger,
  buildContextTriggerMatchers,
  generateToolName,
  parseEngram,
  findEngramFiles,
  discoverEngrams,
  discoverEngramsWithLazy,
  getDefaultEngramPaths,
  readIndexRef,
  getEngramsFromIndex,
} from "./core";
export { generateFileTree } from "./tree";
