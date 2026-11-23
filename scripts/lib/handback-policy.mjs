/** Shared extraction only: the instruction bytes are authored in roles/_base.md. */
import { boundedSection, canonicalSection } from "./bounded-policy.mjs";

export const START = "<!-- flume:handback-policy:start -->";
export const END = "<!-- flume:handback-policy:end -->";

/** @param {string} text */
export function policySection(text) {
  return boundedSection(text, START, END, "handback-policy");
}

/** @param {string} flumeRoot */
export function canonicalPolicy(flumeRoot) {
  return canonicalSection(flumeRoot, START, END, "handback-policy", "handback");
}
