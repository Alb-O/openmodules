import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "os";
import { join } from "path";
import {
  buildContextTriggerMatchers,
  discoverModulesWithLazy,
  generateFileTree,
  getDefaultModulePaths,
  logError,
  logWarning,
  type Module,
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

const ModulesPlugin: Plugin = async (input) => {
  try {
    const modules = await discoverModulesWithLazy(
      getDefaultModulePaths(input.directory),
      input.directory, // Pass root dir for index reading
    );

    if (modules.length === 0) {
      return {};
    }

    // Build lookup map from toolName to module
    const moduleByToolName = new Map<string, Module>();
    for (const module of modules) {
      moduleByToolName.set(module.toolName, module);
    }

    const triggerMatchers = buildContextTriggerMatchers(modules);
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
     * Checks if a module's parent chain is fully visible.
     * A module is only visible if all its ancestors are also in the active set.
     * Returns false for unknown tool names to prevent activation of undeclared tools.
     */
    const isParentChainActive = (
      toolName: string,
      active: Set<string>,
    ): boolean => {
      const module = moduleByToolName.get(toolName);
      if (!module) {
        // Unknown tool name - reject and warn once
        if (!warnedUnknownTools.has(toolName)) {
          warnedUnknownTools.add(toolName);
          logWarning(`Unknown tool name in active set: ${toolName}`);
        }
        return false;
      }

      if (!module.parentToolName) {
        // Root module - no parent constraint
        return true;
      }

      // Check if parent is active and its chain is active
      if (!active.has(module.parentToolName)) {
        return false;
      }

      return isParentChainActive(module.parentToolName, active);
    };

    const tools: Record<string, ReturnType<typeof tool>> = {};

    for (const module of modules) {
      if (!module.toolName) continue;

      // Include human-readable name in description for agent visibility
      // Mark lazy (uninitialized) modules so the agent knows they need init
      const toolDescription = module.lazy
        ? `[NOT INITIALIZED] ${module.name}: ${module.description}`
        : `${module.name}: ${module.description}`;

      tools[module.toolName] = tool({
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

          // For lazy modules, skip file tree (directory is empty) and use stored content
          if (module.lazy) {
            const preamble = `# Module: ${module.name} [NOT INITIALIZED]\n\nThis module's submodule has not been cloned yet.\n\n---\n\n`;
            await sendSilentPrompt(`${preamble}${module.content}`);
            return `Module "${module.name}" is not initialized. Run \`engram lazy-init ${module.name}\` to initialize it.`;
          }

          const fileTree = await generateFileTree(module.directory, {
            includeMetadata: true,
          });
          const treeSection = fileTree
            ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
            : "";

          const preamble = `# Module: ${module.name}\n\nBase directory: ${shortenPath(module.directory)}\n\nModule README:\n\n---\n\n`;

          await sendSilentPrompt(`${preamble}${module.content}${treeSection}`);
          return `Launching module: ${module.name}`;
        },
      });
    }

    const extractUserText = (
      parts: { type: string; text?: string; synthetic?: boolean }[] = [],
    ): string => {
      return parts
        .filter(
          (part) => part.type === "text" && (part as any).synthetic !== true,
        )
        .map((part) =>
          "text" in part && typeof part.text === "string" ? part.text : "",
        )
        .join("\n");
    };

    const extractAgentText = (
      parts: { type: string; text?: string; synthetic?: boolean }[] = [],
    ): string => {
      return parts
        .filter(
          (part) => part.type === "text" && (part as any).synthetic === true,
        )
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

    return {
      tool: tools,
      async "chat.message"(hookInput, output) {
        const sessionID = hookInput.sessionID;
        const active =
          sessionTriggers.get(sessionID) ?? new Set(alwaysVisibleTools);

        for (const toolName of alwaysVisibleTools) {
          active.add(toolName);
        }

        const userText = extractUserText(output.parts as any);
        const agentText = extractAgentText(output.parts as any);
        const allText = extractAllText(output.parts as any);

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

        const message: any = output.message;
        const toolsConfig = { ...(message.tools ?? {}) };

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

        message.tools = toolsConfig;
        sessionTriggers.set(sessionID, active);
      },
    };
  } catch (error) {
    logError("Failed to initialize modules plugin:", error);
    // Rethrow to surface the error to the plugin host
    // This ensures misconfigurations are visible rather than silently ignored
    throw error;
  }
};

export default ModulesPlugin;
