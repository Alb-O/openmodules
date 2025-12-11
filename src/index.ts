import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "os";
import { join } from "path";
import { discoverSkills, logError } from "./helpers";

const SkillsPlugin: Plugin = async (input) => {
  try {
    const skills = await discoverSkills([
      join(process.env.XDG_CONFIG_HOME || os.homedir(), process.env.XDG_CONFIG_HOME ? "opencode/skills" : ".config/opencode/skills"),
      join(os.homedir(), ".opencode", "skills"),
      join(input.directory, ".opencode", "skills"),
    ]);

    if (skills.length === 0) {
      return {};
    }

    const tools: Record<string, ReturnType<typeof tool>> = {};

    for (const skill of skills) {
      if (!skill.toolName) continue;

      tools[skill.toolName] = tool({
        description: skill.description,
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

          await sendSilentPrompt(`The "${skill.name}" skill is loading\n${skill.name}`);
          await sendSilentPrompt(`Base directory for this skill: ${skill.directory}\n\n${skill.content}`);

          return `Launching skill: ${skill.name}`;
        },
      });
    }

    return { tool: tools };
  } catch (error) {
    logError("Failed to initialize skills plugin:", error);
    return {};
  }
};

export default SkillsPlugin;
