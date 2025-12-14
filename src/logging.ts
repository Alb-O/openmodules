import { consola, createConsola } from "consola";
import pc from "picocolors";
import pkg from "../package.json";

export const colors = {
  bold: pc.bold,
  dim: pc.dim,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  cyan: pc.cyan,
} as const;

export const logger = createConsola();

export function info(message: string, ...args: unknown[]) {
  logger.info(message, ...args);
}

export function success(message: string, ...args: unknown[]) {
  logger.success(message, ...args);
}

export function warn(message: string, ...args: unknown[]) {
  logger.warn(message, ...args);
}

export function error(message: string, ...args: unknown[]) {
  logger.error(message, ...args);
}

export function debug(message: string, ...args: unknown[]) {
  logger.debug(message, ...args);
}

export function log(message: string, ...args: unknown[]) {
  logger.log(message, ...args);
}

/** Output raw content without tags (for preview, JSON, piping) */
export function raw(message: string) {
  console.log(message);
}

export function box(message: string, ...args: unknown[]) {
  logger.box(message, ...args);
}

export function start(message: string, ...args: unknown[]) {
  logger.start(message, ...args);
}

export function ready(message: string, ...args: unknown[]) {
  logger.ready(message, ...args);
}

export function fail(message: string, ...args: unknown[]) {
  logger.fail(message, ...args);
}
