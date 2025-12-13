import pkg from "../package.json";

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`[${pkg.name}] ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]) {
  console.error(`[${pkg.name}] ${message}`, ...args);
}
