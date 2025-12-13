import { describe, it, expect } from "bun:test";
import { extractOneliner } from "./comment-parser";

describe("extractOneliner", () => {
  it("extracts from shell comment", () => {
    const content = `#!/bin/bash
# oneliner: Database backup utilities

echo "backing up"
`;
    expect(extractOneliner(content)).toBe("Database backup utilities");
  });

  it("extracts from JS/TS comment", () => {
    const content = `// oneliner: API helper functions
export function fetch() {}
`;
    expect(extractOneliner(content)).toBe("API helper functions");
  });

  it("extracts from Python comment", () => {
    const content = `#!/usr/bin/env python3
# oneliner: Data processing module

import sys
`;
    expect(extractOneliner(content)).toBe("Data processing module");
  });

  it("extracts from Python docstring", () => {
    const content = `""" oneliner: Core utilities """

def main():
    pass
`;
    expect(extractOneliner(content)).toBe("Core utilities");
  });

  it("extracts from HTML comment", () => {
    const content = `<!-- oneliner: Documentation templates -->

# Welcome
`;
    expect(extractOneliner(content)).toBe("Documentation templates");
  });

  it("extracts from Lua comment", () => {
    const content = `-- oneliner: Game engine helpers

local engine = {}
`;
    expect(extractOneliner(content)).toBe("Game engine helpers");
  });

  it("extracts from block comment", () => {
    const content = `/*
 * oneliner: Style utilities
 */

.class {}
`;
    expect(extractOneliner(content)).toBe("Style utilities");
  });

  it("is case-insensitive for marker", () => {
    const content = `# ONELINER: Uppercase marker
`;
    expect(extractOneliner(content)).toBe("Uppercase marker");
  });

  it("returns null when no marker found", () => {
    const content = `#!/bin/bash
# Just a regular script
echo "hello"
`;
    expect(extractOneliner(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractOneliner("")).toBeNull();
  });

  it("only scans first 10 lines", () => {
    const lines = Array(15).fill("# some comment");
    lines[12] = "# oneliner: Too deep";
    const content = lines.join("\n");

    expect(extractOneliner(content)).toBeNull();
  });

  it("finds marker within first 10 lines", () => {
    const lines = Array(8).fill("# some comment");
    lines[7] = "# oneliner: Within range";
    const content = lines.join("\n");

    expect(extractOneliner(content)).toBe("Within range");
  });

  it("cleans trailing block comment syntax", () => {
    const content = `/* oneliner: With block end */
`;
    expect(extractOneliner(content)).toBe("With block end");
  });

  it("cleans trailing Lua block syntax", () => {
    const content = `--[[ oneliner: Lua block ]]
`;
    expect(extractOneliner(content)).toBe("Lua block");
  });

  it("returns null if marker has no content after it", () => {
    const content = `# oneliner:
`;
    expect(extractOneliner(content)).toBeNull();
  });

  it("cleans surrounding quotes", () => {
    expect(extractOneliner(`# oneliner: "Quoted description"`)).toBe(
      "Quoted description",
    );
    expect(extractOneliner(`# oneliner: 'Single quoted'`)).toBe(
      "Single quoted",
    );
  });
});
