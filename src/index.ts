import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "os";
import { join } from "path";
import {
  buildContextTriggerMatchers,
  discoverEngramsWithLazy,
  generateFileTree,
  getDefaultEngramPaths,
  logError,
  logWarning,
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
    const matchableTriggers = triggerMatchers.filter(
      (matcher) =>
        matcher.anyMsgRegexes.length > 0 ||
        matcher.userMsgRegexes.length > 0 ||
        matcher.agentMsgRegexes.length > 0,
    );
    const sessionTriggers = new Map<string, Set<string>>();
    const warnedUnknownTools = new Set<string>();

    /**
     * Checks if an engram's parent chain is fully visible.
     * An engram is only visible if all its ancestors are also in the active set.
     * Returns false for unknown tool names to prevent activation of undeclared tools.
     */
    const isParentChainActive = (
      toolName: string,
      active: Set<string>,
    ): boolean => {
      const engram = engramByToolName.get(toolName);
      if (!engram) {
        // Unknown tool name - reject and warn once
        if (!warnedUnknownTools.has(toolName)) {
          warnedUnknownTools.add(toolName);
          logWarning(`Unknown tool name in active set: ${toolName}`);
        }
        return false;
      }

      if (!engram.parentToolName) {
        // Root engram - no parent constraint
        return true;
      }

      // Check if parent is active and its chain is active
      if (!active.has(engram.parentToolName)) {
        return false;
      }

      return isParentChainActive(engram.parentToolName, active);
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

          // For lazy engrams, skip file tree (directory is empty) and use stored content
          if (engram.lazy) {
            const preamble = `# Engram: ${engram.name} [NOT INITIALIZED]\n\nThis engram's submodule has not been cloned yet.\n\n---\n\n`;
            await sendSilentPrompt(`${preamble}${engram.content}`);
            return `Engram "${engram.name}" is not initialized. Run \`engram lazy-init ${engram.name}\` to initialize it.`;
          }

          const fileTree = await generateFileTree(engram.directory, {
            includeMetadata: true,
          });
          const treeSection = fileTree
            ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
            : "";

          const preamble = `# Engram: ${engram.name}\n\nBase directory: ${shortenPath(engram.directory)}\n\nEngram README:\n\n---\n\n`;

          await sendSilentPrompt(`${preamble}${engram.content}${treeSection}`);
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
        const active =
          sessionTriggers.get(sessionID) ?? new Set(alwaysVisibleTools);

        for (const toolName of alwaysVisibleTools) {
          active.add(toolName);
        }

        const parts = (output.parts ?? []) as MessagePart[];
        const userText = extractUserText(parts);
        const agentText = extractAgentText(parts);
        const allText = extractAllText(parts);

        for (const matcher of matchableTriggers) {
          // Check any-msg triggers against all text
          if (
            allText.trim() &&
            matcher.anyMsgRegexes.some((regex) => regex.test(allText))
          ) {
            active.add(matcher.toolName);
            continue;
          }
          // Check user-msg triggers against user text only
          if (
            userText.trim() &&
            matcher.userMsgRegexes.some((regex) => regex.test(userText))
          ) {
            active.add(matcher.toolName);
            continue;
          }
          // Check agent-msg triggers against agent text only
          if (
            agentText.trim() &&
            matcher.agentMsgRegexes.some((regex) => regex.test(agentText))
          ) {
            active.add(matcher.toolName);
          }
        }

        const message = output.message as { tools?: Record<string, boolean> };
        const toolsConfig: Record<string, boolean> = { ...(message.tools ?? {}) };

        // Default to hidden for all Engram tools unless explicitly re-enabled below
        toolsConfig["engram_*"] = toolsConfig["engram_*"] ?? false;
        for (const toolName of Object.keys(tools)) {
          toolsConfig[toolName] = false;
        }

        // Only enable tools that are active AND have their parent chain active
        for (const toolName of active) {
          if (isParentChainActive(toolName, active)) {
            toolsConfig[toolName] = true;
          }
        }

        (output.message as { tools?: Record<string, boolean> }).tools = toolsConfig;
        sessionTriggers.set(sessionID, active);
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
