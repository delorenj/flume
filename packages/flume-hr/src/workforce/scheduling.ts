import type { NamedAgentContract } from "./types";
import { canonicalPolicy, START, END } from "../../../../scripts/lib/scheduling-policy.mjs";

/** The adapter receives shared policy, while the employee's owning definition stays unchanged. */
export function specialistSchedulingRequest(definition: NamedAgentContract, flumeRoot: string): NamedAgentContract {
  const charter = JSON.stringify(definition.charter);
  if (charter.includes(START) || charter.includes(END)) {
    throw new Error("Specialist charter must not author generated scheduling-policy markers");
  }
  return { ...definition, charter: { ...definition.charter,
    purpose: `${definition.charter.purpose}\n\n${canonicalPolicy(flumeRoot)}` } };
}
