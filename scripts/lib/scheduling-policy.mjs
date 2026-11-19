/** Shared extraction only: the instruction bytes are authored in roles/_base.md. */
import { join } from "node:path";
import { readAuditText } from "./read-audit-text.mjs";

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
  const policy = policySection(readAuditText(join(flumeRoot, "roles/_base.md")));
  if (!policy.slice(START.length, -END.length).trim()) throw new Error("Canonical scheduling policy is empty");
  return policy;
}
