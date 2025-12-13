import { describe, it, expect } from "bun:test";

import { buildContextTriggerMatchers, compileContextTrigger } from "./triggers";
import type { Engram } from "./types";

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
    it("builds matchers that keep triggerless engrams visible", () => {
      const engrams: Engram[] = [
        {
          name: "Docs",
          directory: "/tmp/docs",
          toolName: "engram_docs",
          description: "Docs",
          content: "docs",
          manifestPath: "/tmp/docs/engram.toml",
          disclosureTriggers: { userMsg: ["docstring{s,}"] },
        },
        {
          name: "AlwaysOn",
          directory: "/tmp/always",
          toolName: "engram_always",
          description: "Always on",
          content: "always",
          manifestPath: "/tmp/always/engram.toml",
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);
      const alwaysVisible = matchers
        .filter((matcher) => matcher.alwaysVisible)
        .map((matcher) => matcher.toolName);
      expect(alwaysVisible).toContain("engram_always");

      const text = "Need docstrings for this module";
      const triggered = matchers
        .filter((matcher) =>
          matcher.disclosure.userMsgRegexes.some((regex) => regex.test(text)),
        )
        .map((matcher) => matcher.toolName);

      expect(triggered).toContain("engram_docs");
    });

    it("builds matchers with separate regex arrays for disclosure triggers", () => {
      const engrams: Engram[] = [
        {
          name: "FileDetector",
          directory: "/tmp/file-detector",
          toolName: "engram_file_detector",
          description: "Detects file types from any message",
          content: "detector",
          manifestPath: "/tmp/file-detector/engram.toml",
          disclosureTriggers: { anyMsg: [".pdf", "pdf file"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "engram_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/engram.toml",
          disclosureTriggers: { userMsg: ["help me"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "engram_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/engram.toml",
          disclosureTriggers: { agentMsg: ["found error"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

      const fileDetector = matchers.find(
        (m) => m.toolName === "engram_file_detector",
      );
      const userOnly = matchers.find(
        (m) => m.toolName === "engram_user_only",
      );
      const agentOnly = matchers.find(
        (m) => m.toolName === "engram_agent_only",
      );

      expect(fileDetector?.disclosure.anyMsgRegexes.length).toBeGreaterThan(0);
      expect(fileDetector?.disclosure.userMsgRegexes.length).toBe(0);
      expect(fileDetector?.disclosure.agentMsgRegexes.length).toBe(0);

      expect(userOnly?.disclosure.anyMsgRegexes.length).toBe(0);
      expect(userOnly?.disclosure.userMsgRegexes.length).toBeGreaterThan(0);
      expect(userOnly?.disclosure.agentMsgRegexes.length).toBe(0);

      expect(agentOnly?.disclosure.anyMsgRegexes.length).toBe(0);
      expect(agentOnly?.disclosure.userMsgRegexes.length).toBe(0);
      expect(agentOnly?.disclosure.agentMsgRegexes.length).toBeGreaterThan(0);
    });

    it("disclosure trigger arrays control which text source is matched", () => {
      const engrams: Engram[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "engram_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/engram.toml",
          disclosureTriggers: { anyMsg: ["detected pattern"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "engram_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/engram.toml",
          disclosureTriggers: { userMsg: ["detected pattern"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "engram_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/engram.toml",
          disclosureTriggers: { agentMsg: ["detected pattern"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

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
        if (matcher.disclosure.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.disclosure.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.disclosure.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg should trigger (pattern is in allText)
      expect(triggered.has("engram_any_msg")).toBe(true);
      // user-only should NOT trigger (pattern is not in userText)
      expect(triggered.has("engram_user_only")).toBe(false);
      // agent-only should trigger (pattern is in agentText)
      expect(triggered.has("engram_agent_only")).toBe(true);
    });

    it("user-msg disclosure triggers match when pattern is in user text", () => {
      const engrams: Engram[] = [
        {
          name: "AnyMsg",
          directory: "/tmp/any-msg",
          toolName: "engram_any_msg",
          description: "Triggers on any message",
          content: "any msg",
          manifestPath: "/tmp/any-msg/engram.toml",
          disclosureTriggers: { anyMsg: ["user phrase"] },
        },
        {
          name: "UserOnly",
          directory: "/tmp/user-only",
          toolName: "engram_user_only",
          description: "Only triggers on user messages",
          content: "user only",
          manifestPath: "/tmp/user-only/engram.toml",
          disclosureTriggers: { userMsg: ["user phrase"] },
        },
        {
          name: "AgentOnly",
          directory: "/tmp/agent-only",
          toolName: "engram_agent_only",
          description: "Only triggers on agent messages",
          content: "agent only",
          manifestPath: "/tmp/agent-only/engram.toml",
          disclosureTriggers: { agentMsg: ["user phrase"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

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
        if (matcher.disclosure.anyMsgRegexes.some((regex) => regex.test(allText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.disclosure.userMsgRegexes.some((regex) => regex.test(userText))) {
          triggered.add(matcher.toolName);
          continue;
        }
        if (matcher.disclosure.agentMsgRegexes.some((regex) => regex.test(agentText))) {
          triggered.add(matcher.toolName);
        }
      }

      // any-msg and user-only should trigger
      expect(triggered.has("engram_any_msg")).toBe(true);
      expect(triggered.has("engram_user_only")).toBe(true);
      // agent-only should NOT trigger (pattern is not in agent text)
      expect(triggered.has("engram_agent_only")).toBe(false);
    });

    it("activation triggers are separate from disclosure triggers", () => {
      const engrams: Engram[] = [
        {
          name: "DisclosureOnly",
          directory: "/tmp/disclosure",
          toolName: "engram_disclosure",
          description: "Only has disclosure triggers",
          content: "disclosure only",
          manifestPath: "/tmp/disclosure/engram.toml",
          disclosureTriggers: { userMsg: ["show me"] },
        },
        {
          name: "ActivationOnly",
          directory: "/tmp/activation",
          toolName: "engram_activation",
          description: "Only has activation triggers",
          content: "activation only",
          manifestPath: "/tmp/activation/engram.toml",
          activationTriggers: { userMsg: ["activate now"] },
        },
        {
          name: "Both",
          directory: "/tmp/both",
          toolName: "engram_both",
          description: "Has both trigger types",
          content: "both",
          manifestPath: "/tmp/both/engram.toml",
          disclosureTriggers: { userMsg: ["reveal"] },
          activationTriggers: { userMsg: ["execute"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

      const disclosureOnly = matchers.find(
        (m) => m.toolName === "engram_disclosure",
      );
      const activationOnly = matchers.find(
        (m) => m.toolName === "engram_activation",
      );
      const both = matchers.find((m) => m.toolName === "engram_both");

      // Disclosure only - has disclosure, no activation
      expect(disclosureOnly?.disclosure.userMsgRegexes.length).toBeGreaterThan(0);
      expect(disclosureOnly?.activation.userMsgRegexes.length).toBe(0);
      expect(disclosureOnly?.alwaysVisible).toBe(false);

      // Activation only - no disclosure, has activation
      expect(activationOnly?.disclosure.userMsgRegexes.length).toBe(0);
      expect(activationOnly?.activation.userMsgRegexes.length).toBeGreaterThan(0);
      expect(activationOnly?.alwaysVisible).toBe(false);

      // Both - has both
      expect(both?.disclosure.userMsgRegexes.length).toBeGreaterThan(0);
      expect(both?.activation.userMsgRegexes.length).toBeGreaterThan(0);
      expect(both?.alwaysVisible).toBe(false);
    });

    it("empty trigger arrays do not trigger", () => {
      const engrams: Engram[] = [
        {
          name: "EmptyArrays",
          directory: "/tmp/empty",
          toolName: "engram_empty",
          description: "Has empty trigger arrays",
          content: "empty",
          manifestPath: "/tmp/empty/engram.toml",
          disclosureTriggers: { userMsg: [], anyMsg: [], agentMsg: [] },
        },
        {
          name: "NoTriggers",
          directory: "/tmp/none",
          toolName: "engram_none",
          description: "Has no triggers at all",
          content: "none",
          manifestPath: "/tmp/none/engram.toml",
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

      const emptyArrays = matchers.find((m) => m.toolName === "engram_empty");
      const noTriggers = matchers.find((m) => m.toolName === "engram_none");

      // Empty arrays should result in no regexes and be always visible
      expect(emptyArrays?.disclosure.anyMsgRegexes.length).toBe(0);
      expect(emptyArrays?.disclosure.userMsgRegexes.length).toBe(0);
      expect(emptyArrays?.disclosure.agentMsgRegexes.length).toBe(0);
      expect(emptyArrays?.disclosure.alwaysMatch).toBe(false);
      expect(emptyArrays?.alwaysVisible).toBe(true);

      // No triggers should also be always visible
      expect(noTriggers?.alwaysVisible).toBe(true);
    });

    it("star wildcard always triggers", () => {
      const engrams: Engram[] = [
        {
          name: "StarDisclosure",
          directory: "/tmp/star-disclosure",
          toolName: "engram_star_disclosure",
          description: "Star wildcard in disclosure",
          content: "star disclosure",
          manifestPath: "/tmp/star-disclosure/engram.toml",
          disclosureTriggers: { userMsg: ["*"] },
        },
        {
          name: "StarActivation",
          directory: "/tmp/star-activation",
          toolName: "engram_star_activation",
          description: "Star wildcard in activation",
          content: "star activation",
          manifestPath: "/tmp/star-activation/engram.toml",
          activationTriggers: { anyMsg: ["*"] },
        },
        {
          name: "StarMixed",
          directory: "/tmp/star-mixed",
          toolName: "engram_star_mixed",
          description: "Star with other patterns",
          content: "star mixed",
          manifestPath: "/tmp/star-mixed/engram.toml",
          disclosureTriggers: { userMsg: ["*", "other pattern"] },
        },
      ];

      const matchers = buildContextTriggerMatchers(engrams);

      const starDisclosure = matchers.find(
        (m) => m.toolName === "engram_star_disclosure",
      );
      const starActivation = matchers.find(
        (m) => m.toolName === "engram_star_activation",
      );
      const starMixed = matchers.find(
        (m) => m.toolName === "engram_star_mixed",
      );

      // Star disclosure should have alwaysMatch=true
      expect(starDisclosure?.disclosure.alwaysMatch).toBe(true);
      expect(starDisclosure?.alwaysVisible).toBe(false); // Has triggers, not always visible

      // Star activation should have alwaysMatch=true
      expect(starActivation?.activation.alwaysMatch).toBe(true);
      expect(starActivation?.alwaysVisible).toBe(false);

      // Star mixed should have alwaysMatch=true and also compile other patterns
      expect(starMixed?.disclosure.alwaysMatch).toBe(true);
      expect(starMixed?.disclosure.userMsgRegexes.length).toBeGreaterThan(0);
    });
  });
});
