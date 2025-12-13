import { describe, it, expect } from "bun:test";

import { buildContextTriggerMatchers, compileContextTrigger } from "./triggers";
import type { Module } from "./types";

describe("triggers", () => {
  const matches = (regexes: RegExp[], text: string) =>
    regexes.some((regex) => regex.test(text));

  describe("compileContextTrigger", () => {
    it("supports brace expansion and word boundaries", () => {
      const regexes = compileContextTrigger("docstring{s,}");

      expect(matches(regexes, "Please add a docstring for this function")).toBe(
        true,
      );
      expect(matches(regexes, "Multiple docstrings_are needed")).toBe(true);
      expect(matches(regexes, "docstringing everything")).toBe(false);
    });

    it("treats wildcards as substring matches", () => {
      const regexes = compileContextTrigger("docstring*");

      expect(matches(regexes, "docstringing everything")).toBe(true);
    });
  });

  describe("buildContextTriggerMatchers", () => {
    it("builds matchers that keep triggerless modules visible", () => {
      const modules: Module[] = [
        {
          name: "Docs",
          directory: "/tmp/docs",
          toolName: "openmodule_docs",
          description: "Docs",
          content: "docs",
          manifestPath: "/tmp/docs/openmodule.toml",
          triggers: { userMsg: ["docstring{s,}"] },
        },
        {
          name: "AlwaysOn",
          directory: "/tmp/always",
          toolName: "openmodule_always",
          description: "Always on",
          content: "always",
          manifestPath: "/tmp/always/openmodule.toml",
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);
      const alwaysVisible = matchers
        .filter((matcher) => matcher.alwaysVisible)
        .map((matcher) => matcher.toolName);
      expect(alwaysVisible).toContain("openmodule_always");

      const text = "Need docstrings for this module";
      const triggered = matchers
        .filter((matcher) =>
          matcher.userMsgRegexes.some((regex) => regex.test(text)),
        )
        .map((matcher) => matcher.toolName);

      expect(triggered).toContain("openmodule_docs");
    });

    it("builds matchers with separate regex arrays for each trigger type", () => {
      const modules: Module[] = [
        {
          name: "FileDetector",
          directory: "/tmp/file-detector",
          toolName: "openmodule_file_detector",
          description: "Detects file types from any message",
          content: "detector",
          manifestPath: "/tmp/file-detector/openmodule.toml",
          triggers: { anyMsg: [".pdf", "pdf file"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["help me"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["found error"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      const fileDetector = matchers.find(
        (m) => m.toolName === "openmodule_file_detector",
      );
      const userOnly = matchers.find(
        (m) => m.toolName === "openmodule_user_only",
      );
      const agentOnly = matchers.find(
        (m) => m.toolName === "openmodule_agent_only",
      );

      expect(fileDetector?.anyMsgRegexes.length).toBeGreaterThan(0);
      expect(fileDetector?.userMsgRegexes.length).toBe(0);
      expect(fileDetector?.agentMsgRegexes.length).toBe(0);

      expect(userOnly?.anyMsgRegexes.length).toBe(0);
      expect(userOnly?.userMsgRegexes.length).toBeGreaterThan(0);
      expect(userOnly?.agentMsgRegexes.length).toBe(0);

      expect(agentOnly?.anyMsgRegexes.length).toBe(0);
      expect(agentOnly?.userMsgRegexes.length).toBe(0);
      expect(agentOnly?.agentMsgRegexes.length).toBeGreaterThan(0);
    });

    it("trigger arrays control which text source is matched", () => {
      const modules: Module[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "openmodule_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/openmodule.toml",
          triggers: { anyMsg: ["detected pattern"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["detected pattern"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["detected pattern"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      // Simulate message parts: user text is non-synthetic, agent text is synthetic
      const parts = [
        { type: "text", text: "What files do you see?", synthetic: false }, // user
        {
          type: "text",
          text: "I found a detected pattern in the output",
          synthetic: true,
        }, // agent
      ];

      // Extract text like the hook does
      const userText = parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const agentText = parts
        .filter((p) => p.type === "text" && p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const allText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Check which matchers would trigger based on their trigger type
      const triggered = new Set<string>();
      for (const matcher of matchers) {
        if (matcher.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg should trigger (pattern is in allText)
      expect(triggered.has("openmodule_any_msg")).toBe(true);
      // user-only should NOT trigger (pattern is not in userText)
      expect(triggered.has("openmodule_user_only")).toBe(false);
      // agent-only should trigger (pattern is in agentText)
      expect(triggered.has("openmodule_agent_only")).toBe(true);
    });

    it("user-msg triggers match when pattern is in user text", () => {
      const modules: Module[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "openmodule_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/openmodule.toml",
          triggers: { anyMsg: ["user phrase"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "openmodule_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/openmodule.toml",
          triggers: { userMsg: ["user phrase"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "openmodule_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/openmodule.toml",
          triggers: { agentMsg: ["user phrase"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(modules);

      const parts = [
        {
          type: "text",
          text: "Please handle this user phrase for me",
          synthetic: false,
        },
      ];

      const userText = parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const agentText = parts
        .filter((p) => p.type === "text" && p.synthetic)
        .map((p) => p.text)
        .join("\n");

      const allText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const triggered = new Set<string>();
      for (const matcher of matchers) {
        if (matcher.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg and user-only should trigger
      expect(triggered.has("openmodule_any_msg")).toBe(true);
      expect(triggered.has("openmodule_user_only")).toBe(true);
      // agent-only should NOT trigger (pattern is not in agent text)
      expect(triggered.has("openmodule_agent_only")).toBe(false);
    });
  });
});
