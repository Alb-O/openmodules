import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import os from "os";
import { join } from "path";
import {
    buildContextTriggerMatchers,
    discoverModules,
    generateFileTree,
    getDefaultModulePaths,
    logError,
} from "./helpers";

const ModulesPlugin: Plugin = async (input) => {
    try {
        const modules = await discoverModules(
            getDefaultModulePaths(input.directory),
        );

        if (modules.length === 0) {
            return {};
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

        const tools: Record<string, ReturnType<typeof tool>> = {};

        for (const module of modules) {
            if (!module.toolName) continue;

            // Include human-readable name in description for agent visibility
            const toolDescription = `${module.name}: ${module.description}`;

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

                    const fileTree = await generateFileTree(module.directory, {
                        includeMetadata: true,
                    });
                    const treeSection = fileTree
                        ? `\n\n## Available Resources:\n\`\`\`\n${fileTree}\n\`\`\``
                        : "";

                    const preamble = `# Module: ${module.name}\n\nBase directory: ${module.directory}\n\nModule README:\n\n---\n\n`;

                    await sendSilentPrompt(
                        `${preamble}${module.content}${treeSection}`,
                    );
                    return `Launching module: ${module.name}`;
                },
            });
        }

        const extractUserText = (
            parts: { type: string; text?: string; synthetic?: boolean }[] = [],
        ): string => {
            return parts
                .filter((part) => part.type === "text" && (part as any).synthetic !== true)
                .map((part) =>
                    "text" in part && typeof part.text === "string" ? part.text : "",
                )
                .join("\n");
        };

        const extractAgentText = (
            parts: { type: string; text?: string; synthetic?: boolean }[] = [],
        ): string => {
            return parts
                .filter((part) => part.type === "text" && (part as any).synthetic === true)
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
                const active = sessionTriggers.get(sessionID) ?? new Set(alwaysVisibleTools);

                for (const toolName of alwaysVisibleTools) {
                    active.add(toolName);
                }

                const userText = extractUserText(output.parts as any);
                const agentText = extractAgentText(output.parts as any);
                const allText = extractAllText(output.parts as any);

                for (const matcher of matchableTriggers) {
                    // Check any-msg triggers against all text
                    if (allText.trim() && matcher.anyMsgRegexes.some((regex) => regex.test(allText))) {
                        active.add(matcher.toolName);
                        continue;
                    }
                    // Check user-msg triggers against user text only
                    if (userText.trim() && matcher.userMsgRegexes.some((regex) => regex.test(userText))) {
                        active.add(matcher.toolName);
                        continue;
                    }
                    // Check agent-msg triggers against agent text only
                    if (agentText.trim() && matcher.agentMsgRegexes.some((regex) => regex.test(agentText))) {
                        active.add(matcher.toolName);
                    }
                }

                const message: any = output.message;
                const toolsConfig = { ...(message.tools ?? {}) };

                // Default to hidden for all OpenModule tools unless explicitly re-enabled below
                toolsConfig["openmodule_*"] = toolsConfig["openmodule_*"] ?? false;
                for (const toolName of Object.keys(tools)) {
                    toolsConfig[toolName] = false;
                }

                for (const toolName of active) {
                    toolsConfig[toolName] = true;
                }

                message.tools = toolsConfig;
                sessionTriggers.set(sessionID, active);
            },
        };

    } catch (error) {
        logError("Failed to initialize modules plugin:", error);
        return {};
    }
};

export default ModulesPlugin;
