import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "os";
import { join } from "path";
import { discoverModules, generateFileTree, logError, getDefaultModulePaths } from "./helpers";

const ModulesPlugin: Plugin = async (input) => {
  try {
    const modules = await discoverModules(getDefaultModulePaths(input.directory));

    if (modules.length === 0) {
      return {};
    }

    const tools: Record<string, ReturnType<typeof tool>> = {};

    for (const module of modules) {
      if (!module.toolName) continue;

      tools[module.toolName] = tool({
        description: module.description,
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

          const fileTree = await generateFileTree(module.directory, { includeMetadata: true });
          const treeSection = fileTree
            ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
            : "";

          await sendSilentPrompt(`Base directory for this module: ${module.directory}\n\n${module.content}${treeSection}`);
          return `Launching module: ${module.name}`;
        },
      });
    }

    return { tool: tools };
  } catch (error) {
    logError("Failed to initialize modules plugin:", error);
    return {};
  }
};

export default ModulesPlugin;
