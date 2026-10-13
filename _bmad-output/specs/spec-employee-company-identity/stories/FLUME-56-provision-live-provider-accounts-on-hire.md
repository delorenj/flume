# FLUME-56: [Company identity 1.8] Provision live provider accounts on hire

**Status:** implemented (this branch) · **Board:** Backlog → In Progress on claim
**Epic:** [employee-company-identity](../..)/epics.md · **Depends on:** 1.1 (FLUME-47), 1.2 (FLUME-48), 1.3 ingress slice (agents-facade KV projection)

## Story

As the operator,
I want one command to provision an enrolled employee's live company accounts,
So that hiring never requires a hand-run Cloudflare/1Password runbook.

## Scope/owner

Flume provisioning coordinator (`flume identity provision`), the provisioning
contract (`contracts/identity-provisioning.schema.json`), and the agents-facade
worker's KV allowlist projection. **Requirements:** FR2, FR3, FR4, FR10;
NFR1/3/4/5. GitHub App creation (manifest flow via ego-browser), Plane
membership, GPG and revocation (FLUME-53) are explicitly out of scope.

## Acceptance Criteria

1. **Given** an enrolled active employee and a valid provisioning config,
   **When** provisioning is previewed, **Then** each capability reports
   create/adopt/no-op/conflict from live provider reads only, **And** no
   provider write, vault write, definition write or receipt occurs.
2. **Given** the same employee, **When** apply runs twice, **Then** the first
   run creates the Access service token, vaults the secret, binds
   `(issuer, client_id)` on the employee's own definition, creates the literal
   routing rule and writes the KV allowlist key, **And** the second run is a
   no-op end to end.
3. **Given** a foreign routing rule for the same address or a service token
   with a colliding name, **When** provisioning is attempted, **Then** it is a
   conflict blocker and nothing is clobbered; a vault failure after token
   creation deletes the orphan at the provider and receipts `deleted-orphan`.
4. **Given** any run, **When** receipts, definitions, stdout and config are
   scanned, **Then** they carry IDs and `op://` references only — never a
   secret value; an unenrolled, suspended or retired employee is refused
   before any provider call.

## Evidence

`node scripts/run-tests.mjs identity-provision` — six cases against a fake
Cloudflare API and a stateful fake `op`: preview purity, apply + idempotency,
foreign rule/token conflicts, orphan cleanup, enrollment gate, secret scan.

## Notes

- The mailbox allowlist moved from a wrangler var (redeploy per hire) to the
  worker's KV namespace `MAILBOX_ALLOWLIST` (`allowlist/<address>` keys), so
  hiring is a data-plane write. The worker fails closed: a missing key rejects
  at SMTP time, a KV error retries the delivery.
- Vault items are matched case-insensitively by handle (the hand-created
  "Grolf" item predates the convention) and field references use field IDs,
  not labels.
