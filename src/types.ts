export interface Engram {
  name: string;
  directory: string;
  toolName: string;
  description: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  license?: string;
  content: string;
  /** Path to the engram.toml manifest */
  manifestPath: string;
  /** Trigger configuration for progressive engram discovery */
  triggers?: {
    /** Triggers that match any message (user or agent) */
    anyMsg?: string[];
    /** Triggers that only match user messages */
    userMsg?: string[];
    /** Triggers that only match agent messages */
    agentMsg?: string[];
  };
  /** Tool name of the parent engram (if this is a nested engram) */
  parentToolName?: string;
  /** Tool names of direct child engrams */
  childToolNames?: string[];
  /** True if this engram is from the index but not yet initialized (submodule not cloned) */
  lazy?: boolean;
  /** URL to clone/init the engram from (for lazy engrams) */
  url?: string;
  /** Configuration for wrapped external repositories */
  wrap?: {
    /** Git remote URL */
    remote: string;
    /** Git ref (branch, tag, commit) */
    ref?: string;
    /** Sparse-checkout patterns */
    sparse?: string[];
  };
  /**
   * Manual oneliners for files/directories (relative paths from engram root).
   * These take precedence over file-based oneliners (comments, .oneliner files).
   */
  oneliners?: Record<string, string>;
}

/** Compiled matcher derived from an engram's triggers */
export interface ContextTriggerMatcher {
  toolName: string;
  /** Regexes that match any message */
  anyMsgRegexes: RegExp[];
  /** Regexes that only match user messages */
  userMsgRegexes: RegExp[];
  /** Regexes that only match agent messages */
  agentMsgRegexes: RegExp[];
  alwaysVisible: boolean;
}

export interface FileTreeOptions {
  maxDepth?: number;
  exclude?: RegExp[];
  dirsFirst?: boolean;
  ignoreFile?: string;
  includeMetadata?: boolean;
  /**
   * Manual oneliners from manifest (relative paths from engram root).
   * These take precedence over file-based oneliners.
   */
  manifestOneliners?: Record<string, string>;
}
