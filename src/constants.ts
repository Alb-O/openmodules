/** Manifest filename at engram root */
export const MANIFEST_FILENAME = "engram.toml";

/** Default prompt file relative to engram root */
export const DEFAULT_PROMPT_FILENAME = "README.md";

/** Local engrams directory name (relative to project root) */
export const ENGRAMS_DIR = ".engrams";

/** Git ref for the engram index (lazy loading metadata) */
export const INDEX_REF = "refs/engrams/index";

/** Directory name for wrapped repository content */
export const CONTENT_DIR = "content";

/** Oneliner filename without extension */
export const ONELINER_FILENAME = ".oneliner";

/** Oneliner filename with .txt extension */
export const ONELINER_TXT_FILENAME = ".oneliner.txt";

/** Regex to match oneliner files (.oneliner or .oneliner.txt) */
export const ONELINER_PATTERN = /^\.oneliner(\.txt)?$/;

/** Ordered list of oneliner filenames to check (first match wins) */
export const ONELINER_FILENAMES = [ONELINER_FILENAME, ONELINER_TXT_FILENAME] as const;