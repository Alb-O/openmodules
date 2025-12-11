import { describe, it, expect } from "bun:test";
import { extractSkillPart } from "./comment-parser";

describe("extractSkillPart", () => {
  it("extracts from shell comment", () => {
    const content = `#!/bin/bash
# skill-part: Database backup utilities

echo "backing up"
`;
    expect(extractSkillPart(content)).toBe("Database backup utilities");
  });

  it("extracts from JS/TS comment", () => {
    const content = `// skill-part: API helper functions
export function fetch() {}
`;
    expect(extractSkillPart(content)).toBe("API helper functions");
  });

  it("extracts from Python comment", () => {
    const content = `#!/usr/bin/env python3
# skill-part: Data processing module

import sys
`;
    expect(extractSkillPart(content)).toBe("Data processing module");
  });

  it("extracts from Python docstring", () => {
    const content = `""" skill-part: Core utilities """

def main():
    pass
`;
    expect(extractSkillPart(content)).toBe("Core utilities");
  });

  it("extracts from HTML comment", () => {
    const content = `<!-- skill-part: Documentation templates -->

# Welcome
`;
    expect(extractSkillPart(content)).toBe("Documentation templates");
  });

  it("extracts from Lua comment", () => {
    const content = `-- skill-part: Game engine helpers

local engine = {}
`;
    expect(extractSkillPart(content)).toBe("Game engine helpers");
  });

  it("extracts from block comment", () => {
    const content = `/*
 * skill-part: Style utilities
 */

.class {}
`;
    expect(extractSkillPart(content)).toBe("Style utilities");
  });

  it("is case-insensitive for marker", () => {
    const content = `# SKILL-PART: Uppercase marker
`;
    expect(extractSkillPart(content)).toBe("Uppercase marker");
  });

  it("returns null when no marker found", () => {
    const content = `#!/bin/bash
# Just a regular script
echo "hello"
`;
    expect(extractSkillPart(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractSkillPart("")).toBeNull();
  });

  it("only scans first 10 lines", () => {
    const lines = Array(15).fill("# some comment");
    lines[12] = "# skill-part: Too deep";
    const content = lines.join("\n");

    expect(extractSkillPart(content)).toBeNull();
  });

  it("finds marker within first 10 lines", () => {
    const lines = Array(8).fill("# some comment");
    lines[7] = "# skill-part: Within range";
    const content = lines.join("\n");

    expect(extractSkillPart(content)).toBe("Within range");
  });

  it("cleans trailing block comment syntax", () => {
    const content = `/* skill-part: With block end */
`;
    expect(extractSkillPart(content)).toBe("With block end");
  });

  it("cleans trailing Lua block syntax", () => {
    const content = `--[[ skill-part: Lua block ]]
`;
    expect(extractSkillPart(content)).toBe("Lua block");
  });

  it("returns null if marker has no content after it", () => {
    const content = `# skill-part:
`;
    expect(extractSkillPart(content)).toBeNull();
  });

  it("cleans surrounding quotes", () => {
    expect(extractSkillPart(`# skill-part: "Quoted description"`)).toBe("Quoted description");
    expect(extractSkillPart(`# skill-part: 'Single quoted'`)).toBe("Single quoted");
  });
});
