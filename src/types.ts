export interface Module {
  name: string;
  directory: string;
  toolName: string;
  description: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  license?: string;
  content: string;
  /** Path to the openmodule.toml manifest */
  manifestPath: string;
  /** Trigger configuration for progressive module discovery */
  triggers?: {
    /** Triggers that match any message (user or agent) */
    anyMsg?: string[];
    /** Triggers that only match user messages */
    userMsg?: string[];
    /** Triggers that only match agent messages */
    agentMsg?: string[];
  };
  /** Tool name of the parent module (if this is a nested module) */
  parentToolName?: string;
  /** Tool names of direct child modules */
  childToolNames?: string[];
}

/** Compiled matcher derived from a module's triggers */
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
}
