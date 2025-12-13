import type { Module, ContextTriggerMatcher } from "./types";

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

  const hasWildcard = WILDCARD_PATTERN.test(trimmed);
  const expansions = expandBraces(trimmed);

  return expansions.map((expanded) => globToRegExp(expanded, !hasWildcard));
}

export function buildContextTriggerMatchers(
  modules: Module[],
): ContextTriggerMatcher[] {
  return modules.map((module) => {
    const anyMsgRegexes = (module.triggers?.anyMsg ?? []).flatMap((trigger) =>
      compileContextTrigger(trigger),
    );
    const userMsgRegexes = (module.triggers?.userMsg ?? []).flatMap((trigger) =>
      compileContextTrigger(trigger),
    );
    const agentMsgRegexes = (module.triggers?.agentMsg ?? []).flatMap(
      (trigger) => compileContextTrigger(trigger),
    );

    const hasTriggers =
      anyMsgRegexes.length > 0 ||
      userMsgRegexes.length > 0 ||
      agentMsgRegexes.length > 0;

    return {
      toolName: module.toolName,
      anyMsgRegexes,
      userMsgRegexes,
      agentMsgRegexes,
      alwaysVisible: !hasTriggers,
    };
  });
}
