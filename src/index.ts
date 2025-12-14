import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "node:os";
import { join } from "node:path";
import {
  buildContextTriggerMatchers,
  discoverEngramsWithLazy,
  generateFileTree,
  getDefaultEngramPaths,
  error,
  warn,
  type CompiledTriggerRegexes,
  type ContextTriggerMatcher,
  type Engram,
} from "./helpers";
import { DEFAULT_MAX_FILES } from "./constants";

/**
 * Shortens a path by replacing the home directory with ~
 */
function shortenPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

/** Check if compiled regexes have any patterns (or always/never match) */
function hasRegexes(regexes: CompiledTriggerRegexes): boolean {
  if (regexes.neverMatch) return true; // Explicit empty = has "never" trigger
  return (
    regexes.alwaysMatch ||
    regexes.anyMsgRegexes.length > 0 ||
    regexes.userMsgRegexes.length > 0 ||
    regexes.agentMsgRegexes.length > 0
  );
}

/** Check if text matches any of the compiled trigger regexes */
function matchesTriggers(
  regexes: CompiledTriggerRegexes,
  userText: string,
  agentText: string,
  allText: string,
): boolean {
  if (regexes.neverMatch) {
    return false;
  }
  if (regexes.alwaysMatch) {
    return true;
  }
  if (
    allText.trim() &&
    regexes.anyMsgRegexes.some((regex) => regex.test(allText))
  ) {
    return true;
  }
  if (
    userText.trim() &&
    regexes.userMsgRegexes.some((regex) => regex.test(userText))
  ) {
    return true;
  }
  if (
    agentText.trim() &&
    regexes.agentMsgRegexes.some((regex) => regex.test(agentText))
  ) {
    return true;
  }
  return false;
}

const EngramsPlugin: Plugin = async (input) => {
  let engrams: Engram[];

  try {
    engrams = await discoverEngramsWithLazy(
      getDefaultEngramPaths(input.directory),
      input.directory,
    );
  } catch (err) {
    error("Failed to discover engrams, plugin will be disabled:", err);
    return {};
  }

  if (engrams.length === 0) {
    return {};
  }

  const engramByToolName = new Map<string, Engram>();
  for (const engram of engrams) {
    engramByToolName.set(engram.toolName, engram);
  }

    const triggerMatchers = buildContextTriggerMatchers(engrams);
    const alwaysVisibleTools = new Set(
      triggerMatchers
        .filter((matcher) => matcher.alwaysVisible)
        .map((matcher) => matcher.toolName),
    );
    const matchableTriggers = triggerMatchers.filter(
      (matcher) =>
        hasRegexes(matcher.disclosure) || hasRegexes(matcher.activation),
    );
    const sessionDisclosed = new Map<string, Set<string>>();
    const sessionActivated = new Map<string, Set<string>>();
    const warnedUnknownTools = new Set<string>();

    /**
     * Checks if an engram's parent chain is fully visible.
     * An engram is only visible if all its ancestors are also in the disclosed set.
     * Returns false for unknown tool names to prevent activation of undeclared tools.
     */
    const isParentChainDisclosed = (
      toolName: string,
      disclosed: Set<string>,
    ): boolean => {
      const engram = engramByToolName.get(toolName);
      if (!engram) {
        if (!warnedUnknownTools.has(toolName)) {
          warnedUnknownTools.add(toolName);
          warn(`Unknown tool name in disclosed set: ${toolName}`);
        }
        return false;
      }

      if (!engram.parentToolName) {
        return true;
      }

      if (!disclosed.has(engram.parentToolName)) {
        return false;
      }

      return isParentChainDisclosed(engram.parentToolName, disclosed);
    };

    /**
     * Execute an engram's content injection (used for activation triggers).
     * Returns the content that should be injected.
     */
    const getEngramContent = async (engram: Engram): Promise<string> => {
      if (engram.lazy) {
        const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
        return `${preamble}${engram.content}`;
      }

      const fileTree = await generateFileTree(engram.directory, {
        includeMetadata: true,
        manifestOneliners: engram.oneliners,
        maxFiles: DEFAULT_MAX_FILES,
      });
      const treeSection = fileTree
        ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
        : "";

      const preamble = `# Engram: ${engram.name}\n\nBase directory: ${shortenPath(engram.directory)}\n\nEngram README:\n\n---\n\n`;
      return `${preamble}${engram.content}${treeSection}`;
    };

    const tools: Record<string, ReturnType<typeof tool>> = {};

    for (const engram of engrams) {
      if (!engram.toolName) continue;

      const toolDescription = engram.lazy
        ? `[NOT INITIALIZED] ${engram.name}: ${engram.description}`
        : `${engram.name}: ${engram.description}`;

      tools[engram.toolName] = tool({
        description: toolDescription,
        args: {},
        async execute(_, toolCtx) {
          const sendSilentPrompt = async (text: string) => {
            if (!input.client?.session?.prompt) return;

            await input.client.session.prompt({
              path: { id: toolCtx.sessionID },
              body: {
                agent: toolCtx.agent,
                noReply: true,
                parts: [{ type: "text", text }],
              },
            });
          };

          const content = await getEngramContent(engram);
          await sendSilentPrompt(content);

          if (engram.lazy) {
            return `Engram "${engram.name}" is not initialized. Run \`engram lazy-init ${engram.name}\` to initialize it.`;
          }
          return `Launching engram: ${engram.name}`;
        },
      });
    }

    const extractUserText = (
      parts: { type: string; text?: string; synthetic?: boolean }[] = [],
    ): string => {
      return parts
        .filter((part) => part.type === "text" && part.synthetic !== true)
        .map((part) =>
          "text" in part && typeof part.text === "string" ? part.text : "",
        )
        .join("\n");
    };

    const extractAgentText = (
      parts: { type: string; text?: string; synthetic?: boolean }[] = [],
    ): string => {
      return parts
        .filter((part) => part.type === "text" && part.synthetic === true)
        .map((part) =>
          "text" in part && typeof part.text === "string" ? part.text : "",
        )
        .join("\n");
    };

    const extractAllText = (
      parts: { type: string; text?: string }[] = [],
    ): string => {
      return parts
        .filter((part) => part.type === "text")
        .map((part) =>
          "text" in part && typeof part.text === "string" ? part.text : "",
        )
        .join("\n");
    };

    type MessagePart = { type: string; text?: string; synthetic?: boolean };

    return {
      tool: tools,
      async "chat.message"(hookInput, output) {
        const sessionID = hookInput.sessionID;
        const disclosed =
          sessionDisclosed.get(sessionID) ?? new Set(alwaysVisibleTools);
        const activated = sessionActivated.get(sessionID) ?? new Set<string>();

        for (const toolName of alwaysVisibleTools) {
          disclosed.add(toolName);
        }

        const parts = (output.parts ?? []) as MessagePart[];
        const userText = extractUserText(parts);
        const agentText = extractAgentText(parts);
        const allText = extractAllText(parts);

        const toActivate: string[] = [];

        for (const matcher of matchableTriggers) {
          if (
            hasRegexes(matcher.disclosure) &&
            matchesTriggers(matcher.disclosure, userText, agentText, allText)
          ) {
            disclosed.add(matcher.toolName);
          }

          if (
            hasRegexes(matcher.activation) &&
            !activated.has(matcher.toolName) &&
            matchesTriggers(matcher.activation, userText, agentText, allText)
          ) {
            disclosed.add(matcher.toolName);
            toActivate.push(matcher.toolName);
          }
        }

        for (const toolName of toActivate) {
          const engram = engramByToolName.get(toolName);
          if (!engram) continue;

          if (!isParentChainDisclosed(toolName, disclosed)) continue;

          const content = await getEngramContent(engram);

          if (input.client?.session?.prompt) {
            await input.client.session.prompt({
              path: { id: sessionID },
              body: {
                agent: hookInput.agent,
                noReply: true,
                parts: [{ type: "text", text: content }],
              },
            });
          }

          activated.add(toolName);
        }

        const message = output.message as { tools?: Record<string, boolean> };
        const toolsConfig: Record<string, boolean> = {
          ...(message.tools ?? {}),
        };

        toolsConfig["engram_*"] ??= false;
        for (const toolName of Object.keys(tools)) {
          toolsConfig[toolName] = false;
        }

        for (const toolName of disclosed) {
          if (isParentChainDisclosed(toolName, disclosed)) {
            toolsConfig[toolName] = true;
          }
        }

        (output.message as { tools?: Record<string, boolean> }).tools =
          toolsConfig;
        sessionDisclosed.set(sessionID, disclosed);
        sessionActivated.set(sessionID, activated);
      },
    };
};

export default EngramsPlugin;
