import type {
  Engram,
  ContextTriggerMatcher,
  TriggerConfig,
  CompiledTriggerRegexes,
} from "./types";
import { warn } from "../logging";

const WILDCARD_PATTERN = /[*?\[]/;

function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

const MAX_BRACE_EXPANSIONS = 100;

export function expandBraces(pattern: string): string[] {
  return expandBracesLimited(pattern, MAX_BRACE_EXPANSIONS);
}

function expandBracesLimited(pattern: string, remaining: number): string[] {
  if (remaining <= 0) return [pattern];

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

  const results: string[] = [];
  for (const option of options) {
    if (results.length >= remaining) break;
    const expanded = expandBracesLimited(`${before}${option}${after}`, remaining - results.length);
    results.push(...expanded.slice(0, remaining - results.length));
  }
  return results;
}

function globFragmentToRegex(pattern: string): string | null {
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
      warn(`Malformed trigger pattern: unclosed '[' in "${pattern}"`);
      return null;
    }

    regex += escapeRegex(char);
  }

  return regex;
}

function globToRegExp(pattern: string, enforceWordBoundary: boolean): RegExp | null {
  const source = globFragmentToRegex(pattern);
  if (source === null) return null;

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

  const regexes: RegExp[] = [];
  for (const expanded of expansions) {
    const regex = globToRegExp(expanded, !hasWildcard);
    if (regex !== null) regexes.push(regex);
  }
  return regexes;
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

  // Check if section was explicitly declared but has no patterns (never match)
  const hasPatterns =
    (config?.anyMsg?.length ?? 0) > 0 ||
    (config?.userMsg?.length ?? 0) > 0 ||
    (config?.agentMsg?.length ?? 0) > 0;
  const neverMatch = config?.explicit === true && !hasPatterns;

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
    neverMatch,
  };
}

/** Check if a CompiledTriggerRegexes has any patterns (or always matches) */
function hasRegexes(regexes: CompiledTriggerRegexes): boolean {
  if (regexes.neverMatch) return true; // Explicit empty = has "never" trigger
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
