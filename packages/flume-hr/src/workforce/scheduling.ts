import type { NamedAgentContract } from "./types";
import { canonicalPolicy, START, END } from "../../../../scripts/lib/scheduling-policy.mjs";
import {
  canonicalPolicy as canonicalHandbackPolicy, START as HANDBACK_START, END as HANDBACK_END,
} from "../../../../scripts/lib/handback-policy.mjs";

/** The narrow scheduling refresh retains its scheduling-only request contract. */
export function specialistSchedulingRequest(definition: NamedAgentContract, flumeRoot: string): NamedAgentContract {
  const charter = JSON.stringify(definition.charter);
  if (charter.includes(START) || charter.includes(END)) {
    throw new Error("Specialist charter must not author generated scheduling-policy markers");
  }
  if (charter.includes(HANDBACK_START) || charter.includes(HANDBACK_END)) {
    throw new Error("Specialist charter must not author generated handback-policy markers");
  }
  return { ...definition, charter: { ...definition.charter,
    purpose: `${definition.charter.purpose}\n\n${canonicalPolicy(flumeRoot)}` } };
}

/** Full hire/onboard projects shared instructions without changing the owning definition. */
export function specialistPolicyRequest(definition: NamedAgentContract, flumeRoot: string): NamedAgentContract {
  const request = specialistSchedulingRequest(definition, flumeRoot);
  return { ...request, charter: { ...request.charter,
    purpose: `${request.charter.purpose}\n\n${canonicalHandbackPolicy(flumeRoot)}` } };
}
