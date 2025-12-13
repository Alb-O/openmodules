import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "node:os";
import { join } from "node:path";
import {
  buildContextTriggerMatchers,
  discoverEngramsWithLazy,
  generateFileTree,
  getDefaultEngramPaths,
  logError,
  logWarning,
  type CompiledTriggerRegexes,
  type ContextTriggerMatcher,
  type Engram,
} from "./helpers";

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

/** Check if compiled regexes have any patterns (or always match) */
function hasRegexes(regexes: CompiledTriggerRegexes): boolean {
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
  // If alwaysMatch is set (bare "*" wildcard), always trigger
  if (regexes.alwaysMatch) {
    return true;
  }
  // Check any-msg triggers against all text
  if (
    allText.trim() &&
    regexes.anyMsgRegexes.some((regex) => regex.test(allText))
  ) {
    return true;
  }
  // Check user-msg triggers against user text only
  if (
    userText.trim() &&
    regexes.userMsgRegexes.some((regex) => regex.test(userText))
  ) {
    return true;
  }
  // Check agent-msg triggers against agent text only
  if (
    agentText.trim() &&
    regexes.agentMsgRegexes.some((regex) => regex.test(agentText))
  ) {
    return true;
  }
  return false;
}

const EngramsPlugin: Plugin = async (input) => {
  try {
    const engrams = await discoverEngramsWithLazy(
      getDefaultEngramPaths(input.directory),
      input.directory, // Pass root dir for index reading
    );

    if (engrams.length === 0) {
      return {};
    }

    // Build lookup map from toolName to engram
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
    // Matchers that have either disclosure or activation triggers
    const matchableTriggers = triggerMatchers.filter(
      (matcher) =>
        hasRegexes(matcher.disclosure) || hasRegexes(matcher.activation),
    );
    // Track disclosed tools per session (tool visible, agent can call)
    const sessionDisclosed = new Map<string, Set<string>>();
    // Track activated tools per session (already auto-executed)
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
        // Unknown tool name - reject and warn once
        if (!warnedUnknownTools.has(toolName)) {
          warnedUnknownTools.add(toolName);
          logWarning(`Unknown tool name in disclosed set: ${toolName}`);
        }
        return false;
      }

      if (!engram.parentToolName) {
        // Root engram - no parent constraint
        return true;
      }

      // Check if parent is disclosed and its chain is disclosed
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
      // For lazy engrams, skip file tree (directory is empty) and use stored content
      if (engram.lazy) {
        const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
        return `${preamble}${engram.content}`;
      }

      const fileTree = await generateFileTree(engram.directory, {
        includeMetadata: true,
        manifestOneliners: engram.oneliners,
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

      // Include human-readable name in description for agent visibility
      // Mark lazy (uninitialized) engrams so the agent knows they need init
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

        // Collect engrams that need immediate activation
        const toActivate: string[] = [];

        for (const matcher of matchableTriggers) {
          // Check disclosure triggers - makes tool visible to agent
          if (
            hasRegexes(matcher.disclosure) &&
            matchesTriggers(matcher.disclosure, userText, agentText, allText)
          ) {
            disclosed.add(matcher.toolName);
          }

          // Check activation triggers - immediately execute (if not already activated)
          if (
            hasRegexes(matcher.activation) &&
            !activated.has(matcher.toolName) &&
            matchesTriggers(matcher.activation, userText, agentText, allText)
          ) {
            // Also disclose so it shows in tools list
            disclosed.add(matcher.toolName);
            toActivate.push(matcher.toolName);
          }
        }

        // Perform immediate activations
        for (const toolName of toActivate) {
          const engram = engramByToolName.get(toolName);
          if (!engram) continue;

          // Check parent chain is disclosed before activating
          if (!isParentChainDisclosed(toolName, disclosed)) continue;

          // Inject engram content
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

        // Default to hidden for all Engram tools unless explicitly re-enabled below
        toolsConfig["engram_*"] = toolsConfig["engram_*"] ?? false;
        for (const toolName of Object.keys(tools)) {
          toolsConfig[toolName] = false;
        }

        // Only enable tools that are disclosed AND have their parent chain disclosed
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
  } catch (error) {
    logError("Failed to initialize engrams plugin:", error);
    // Rethrow to surface the error to the plugin host
    // This ensures misconfigurations are visible rather than silently ignored
    throw error;
  }
};

export default EngramsPlugin;
