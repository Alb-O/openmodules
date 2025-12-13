/** Common trigger configuration with message type arrays */
export interface TriggerConfig {
  /** Triggers that match any message (user or agent) */
  anyMsg?: string[];
  /** Triggers that only match user messages */
  userMsg?: string[];
  /** Triggers that only match agent messages */
  agentMsg?: string[];
}

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
  /**
   * Disclosure triggers reveal the engram's name and description to the agent.
   * The agent can then decide whether to activate it.
   */
  disclosureTriggers?: TriggerConfig;
  /**
   * Activation triggers immediately perform a full activation of the engram.
   * The engram content is injected without requiring agent action.
   */
  activationTriggers?: TriggerConfig;
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
    /** Lock to exact commit for reproducibility */
    lock?: boolean;
  };
  /**
   * Manual oneliners for files/directories (relative paths from engram root).
   * These take precedence over file-based oneliners (comments, .oneliner files).
   */
  oneliners?: Record<string, string>;
}

/** Compiled regexes for a single trigger type */
export interface CompiledTriggerRegexes {
  /** Regexes that match any message */
  anyMsgRegexes: RegExp[];
  /** Regexes that only match user messages */
  userMsgRegexes: RegExp[];
  /** Regexes that only match agent messages */
  agentMsgRegexes: RegExp[];
  /** True if any trigger array contains a bare "*" (always matches) */
  alwaysMatch: boolean;
}

/** Compiled matcher derived from an engram's triggers */
export interface ContextTriggerMatcher {
  toolName: string;
  /** Disclosure triggers - reveal name/description to agent */
  disclosure: CompiledTriggerRegexes;
  /** Activation triggers - full immediate activation */
  activation: CompiledTriggerRegexes;
  /** True if engram has no triggers and should always be visible */
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
