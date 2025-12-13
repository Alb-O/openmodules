import { createConsola } from "consola/basic";
import pkg from "../package.json";

export const logger = createConsola().withTag(pkg.name);

export function logWarning(message: string, ...args: unknown[]) {
  logger.warn(message, ...args);
}

export function logError(message: string, ...args: unknown[]) {
  logger.error(message, ...args);
}

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
