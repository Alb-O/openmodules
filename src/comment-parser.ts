/**
 * Simple parser that looks for "skill-part:" in the first few lines of a file.
 * Works with any file type - just scans for the marker string.
 */

const MAX_LINES_TO_SCAN = 10;
const SKILL_PART_MARKER = "skill-part:";

/**
 * Extract the skill-part description from the top of a file.
 * Looks for "skill-part:" anywhere in the first few lines and extracts the rest of that line.
 * 
 * @example
 * // skill-part: Database backup utilities
 * # skill-part: Helper functions for API calls
 * <!-- skill-part: Documentation templates -->
 * """ skill-part: Data processing module """
 */
export function extractSkillPart(content: string): string | null {
  const lines = content.split("\n").slice(0, MAX_LINES_TO_SCAN);

  for (const line of lines) {
    const markerIndex = line.toLowerCase().indexOf(SKILL_PART_MARKER);
    if (markerIndex !== -1) {
      // Extract everything after "skill-part:"
      const afterMarker = line.slice(markerIndex + SKILL_PART_MARKER.length).trim();
      
      // Clean up common trailing comment syntax
      const cleaned = afterMarker
        .replace(/\s*-->$/, "")      // HTML comment end
        .replace(/\s*\*\/$/, "")     // Block comment end
        .replace(/\s*"""$/, "")      // Python docstring end
        .replace(/\s*'''$/, "")      // Python docstring end
        .replace(/\s*]]$/, "")       // Lua block comment end
        .replace(/^["']|["']$/g, "") // Surrounding quotes
        .trim();

      return cleaned || null;
    }
  }

  return null;
}
