/** Shared bounded-section extraction: every policy's instruction bytes are authored once in roles/_base.md. */
import { join } from "node:path";
import { readAuditText } from "./read-audit-text.mjs";

/**
 * One marker-bounded section, markers included. Absent, duplicate and reversed markers are refused.
 * @param {string} text @param {string} start @param {string} end @param {string} label e.g. "scheduling-policy"
 */
export function boundedSection(text, start, end, label) {
  if (text.split(start).length !== 2 || text.split(end).length !== 2) {
    throw new Error(`expected exactly one ${label} start/end pair`);
  }
  const from = text.indexOf(start), to = text.indexOf(end);
  if (to < from + start.length) throw new Error(`${label} markers are reversed`);
  return text.slice(from, to + end.length);
}

/**
 * The canonical section from roles/_base.md, read through the bounded audit reader; an empty body is refused.
 * @param {string} flumeRoot @param {string} start @param {string} end @param {string} label @param {string} name e.g. "scheduling"
 */
export function canonicalSection(flumeRoot, start, end, label, name) {
  const section = boundedSection(readAuditText(join(flumeRoot, "roles/_base.md")), start, end, label);
  if (!section.slice(start.length, -end.length).trim()) throw new Error(`Canonical ${name} policy is empty`);
  return section;
}
