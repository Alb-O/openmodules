/**
 * Simple parser that looks for "oneliner:" in the first few lines of a file.
 * Works with any file type - just scans for the marker string.
 */

const MAX_LINES_TO_SCAN = 10;
const ONELINER_MARKER = "oneliner:";

/**
 * Extract the oneliner description from the top of a file.
 * Looks for "oneliner:" anywhere in the first few lines and extracts the rest of that line.
 *
 * @example
 * // oneliner: Database backup utilities
 * # oneliner: Helper functions for API calls
 * <!-- oneliner: Documentation templates -->
 * """ oneliner: Data processing module """
 */
export function extractOneliner(content: string): string | null {
  const lines = content.split("\n").slice(0, MAX_LINES_TO_SCAN);

  for (const line of lines) {
    const markerIndex = line.toLowerCase().indexOf(ONELINER_MARKER);
    if (markerIndex !== -1) {
      // Extract everything after "oneliner:"
      const afterMarker = line
        .slice(markerIndex + ONELINER_MARKER.length)
        .trim();

      // Clean up common trailing comment syntax
      const cleaned = afterMarker
        .replace(/\s*-->$/, "") // HTML comment end
        .replace(/\s*\*\/$/, "") // Block comment end
        .replace(/\s*"""$/, "") // Python docstring end
        .replace(/\s*'''$/, "") // Python docstring end
        .replace(/\s*]]$/, "") // Lua block comment end
        .replace(/^["']|["']$/g, "") // Surrounding quotes
        .trim();

      return cleaned || null;
    }
  }

  return null;
}
