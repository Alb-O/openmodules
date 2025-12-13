import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModulePaths {
  global: string;
  local: string | null;
}

export function getModulePaths(projectRoot?: string): ModulePaths {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const globalPath = xdgConfigHome
    ? path.join(xdgConfigHome, "engrams")
    : path.join(os.homedir(), ".config", "engrams");

  return {
    global: globalPath,
    local: projectRoot ? path.join(projectRoot, ".engrams") : null,
  };
}

export function findProjectRoot(): string | null {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    // Check for common project indicators
    const gitDir = path.join(dir, ".git");
    const openmodulesDir = path.join(dir, ".engrams");
    if (existsSync(gitDir) || existsSync(openmodulesDir)) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// Domain aliases for shorthand syntax (like nix flakes)
const DOMAIN_ALIASES: Record<string, string> = {
  github: "github.com",
  gh: "github.com",
  gitlab: "gitlab.com",
  gl: "gitlab.com",
  codeberg: "codeberg.org",
  cb: "codeberg.org",
  sourcehut: "git.sr.ht",
  srht: "git.sr.ht",
};

export function parseRepoUrl(
  input: string,
): { owner: string; repo: string; url: string } | null {
  // Handle full URLs (https or git@)
  const urlMatch = input.match(
    /(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/.\s]+)/,
  );
  if (urlMatch) {
    const domain = urlMatch[1];
    const owner = urlMatch[2];
    const repo = urlMatch[3].replace(/\.git$/, "");
    return {
      owner,
      repo,
      url: `https://${domain}/${owner}/${repo}.git`,
    };
  }

  // Handle domain-prefixed shorthand: domain:owner/repo
  const domainMatch = input.match(/^([a-z]+):([^/]+)\/([^/]+)$/);
  if (domainMatch) {
    const alias = domainMatch[1];
    const owner = domainMatch[2];
    const repo = domainMatch[3];
    const domain = DOMAIN_ALIASES[alias];
    if (!domain) {
      return null; // Unknown domain alias
    }
    return {
      owner,
      repo,
      url: `https://${domain}/${owner}/${repo}.git`,
    };
  }

  // Handle simple shorthand: owner/repo (defaults to GitHub)
  const shortMatch = input.match(/^([^/:]+)\/([^/:]+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`,
    };
  }

  return null;
}

export function getSupportedDomains(): string[] {
  return Object.keys(DOMAIN_ALIASES);
}

export function getEngramName(repo: string): string {
  // Strip eg. prefix if present for cleaner engram names
  return repo.replace(/^eg\./, "");
}

/**
 * Shortens a path by replacing the home directory with ~
 */
export function shortenPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}
