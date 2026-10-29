/** Shared extraction only: the instruction bytes are authored in roles/_base.md. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const START = "<!-- flume:scheduling-policy:start -->";
export const END = "<!-- flume:scheduling-policy:end -->";

/** @param {string} text */
export function policySection(text) {
  if (text.split(START).length !== 2 || text.split(END).length !== 2) {
    throw new Error("expected exactly one scheduling-policy start/end pair");
  }
  const start = text.indexOf(START), end = text.indexOf(END);
  if (end < start) throw new Error("scheduling-policy markers are reversed");
  return text.slice(start, end + END.length);
}

/** @param {string} flumeRoot */
export function canonicalPolicy(flumeRoot) {
  return policySection(readFileSync(join(flumeRoot, "roles/_base.md"), "utf8"));
}
