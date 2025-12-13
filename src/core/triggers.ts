import type {
  Engram,
  ContextTriggerMatcher,
  TriggerConfig,
  CompiledTriggerRegexes,
} from "./types";

const WILDCARD_PATTERN = /[*?\[]/;

function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];

  let depth = 0;
  let end = -1;
  for (let i = start + 1; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "{") depth++;
    if (char === "}") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    }
  }

  if (end === -1) return [pattern];

  const before = pattern.slice(0, start);
  const after = pattern.slice(end + 1);
  const body = pattern.slice(start + 1, end);

  const options: string[] = [];
  let current = "";
  depth = 0;

  for (const char of body) {
    if (char === "," && depth === 0) {
      options.push(current);
      current = "";
      continue;
    }

    if (char === "{") depth++;
    if (char === "}") depth--;
    current += char;
  }
  options.push(current);

  return options.flatMap((option) =>
    expandBraces(`${before}${option}${after}`),
  );
}

function globFragmentToRegex(pattern: string): string {
  let regex = "";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++;
      } else {
        regex += ".*";
      }
      continue;
    }

    if (char === "?") {
      regex += ".";
      continue;
    }

    if (char === "[") {
      let j = i + 1;
      let content = "";
      while (j < pattern.length && pattern[j] !== "]") {
        content += pattern[j];
        j++;
      }

      if (j < pattern.length) {
        regex += `[${content}]`;
        i = j;
        continue;
      }
    }

    if (/\s/.test(char)) {
      regex += "\\s+";
      continue;
    }

    regex += escapeRegex(char);
  }

  return regex;
}

function globToRegExp(pattern: string, enforceWordBoundary: boolean): RegExp {
  const source = globFragmentToRegex(pattern);
  const bounded = enforceWordBoundary
    ? `(?:^|[^A-Za-z0-9])(?:${source})(?:[^A-Za-z0-9]|$)`
    : source;

  return new RegExp(bounded, "is");
}

export function compileContextTrigger(pattern: string): RegExp[] {
  if (typeof pattern !== "string") return [];
  const trimmed = pattern.trim();
  if (!trimmed) return [];

  // Bare "*" is handled specially as always-match in compileTriggerConfig
  // Don't compile it to regex here
  if (trimmed === "*") return [];

  const hasWildcard = WILDCARD_PATTERN.test(trimmed);
  const expansions = expandBraces(trimmed);

  return expansions.map((expanded) => globToRegExp(expanded, !hasWildcard));
}

/** Check if a trigger array contains a bare star wildcard */
function containsStarWildcard(triggers?: string[]): boolean {
  if (!triggers) return false;
  return triggers.some((t) => t.trim() === "*");
}

/** Compile a TriggerConfig into CompiledTriggerRegexes */
function compileTriggerConfig(config?: TriggerConfig): CompiledTriggerRegexes {
  // Check for bare "*" in any array - means always match
  const alwaysMatch =
    containsStarWildcard(config?.anyMsg) ||
    containsStarWildcard(config?.userMsg) ||
    containsStarWildcard(config?.agentMsg);

  return {
    anyMsgRegexes: (config?.anyMsg ?? []).flatMap((t) =>
      compileContextTrigger(t),
    ),
    userMsgRegexes: (config?.userMsg ?? []).flatMap((t) =>
      compileContextTrigger(t),
    ),
    agentMsgRegexes: (config?.agentMsg ?? []).flatMap((t) =>
      compileContextTrigger(t),
    ),
    alwaysMatch,
  };
}

/** Check if a CompiledTriggerRegexes has any patterns (or always matches) */
function hasRegexes(regexes: CompiledTriggerRegexes): boolean {
  return (
    regexes.alwaysMatch ||
    regexes.anyMsgRegexes.length > 0 ||
    regexes.userMsgRegexes.length > 0 ||
    regexes.agentMsgRegexes.length > 0
  );
}

export function buildContextTriggerMatchers(
  engrams: Engram[],
): ContextTriggerMatcher[] {
  return engrams.map((engram) => {
    const disclosure = compileTriggerConfig(engram.disclosureTriggers);
    const activation = compileTriggerConfig(engram.activationTriggers);

    const hasTriggers = hasRegexes(disclosure) || hasRegexes(activation);

    return {
      toolName: engram.toolName,
      disclosure,
      activation,
      alwaysVisible: !hasTriggers,
    };
  });
}
