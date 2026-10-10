# Parent spot checks — 2026-10-10

## Direct primary checks

- Fetched https://developers.cloudflare.com/email-service/platform/pricing/ (last updated 2026-06-09): Email Routing on Workers Free/Paid; arbitrary sending requires Workers Paid; 3,000/month included then $0.35/1,000; verified destinations free; Email Workers billed under Workers pricing. Confirms the Cloudflare digest's load-bearing price claims. Same publisher, not independent corroboration.
- Fetched https://developers.cloudflare.com/workers/platform/pricing/ (last updated 2026-10-02): minimum $5/account/month for Workers Paid; free 100,000 requests/day and 10ms CPU/invocation; Standard includes 10 million requests/month and 30 million CPU-ms, with request/CPU overages. Closes the subagent's official-Workers-pricing gap. It does NOT prove the user's account has that plan or enough unused allowance.
- Fetched https://developers.cloudflare.com/email-service/configuration/subdomains/ (last updated 2026-09-25): subdomain routing supported in the same zone; literal rules after DNS; catch-all apex-only; sending subdomain enrolled separately. Confirms proposed @agents.delo.sh namespace is supported without moving apex mail.

## Corrections applied in synthesis

- Do not claim the whole system costs $0 from Email Routing being free. Worker CPU, storage, delivery queues, retention and existing account usage matter. Use a lightweight Worker, measured pilot budget, explicit quota and outage behavior. An email flood is not bounded by employee count.
- Outbound subscription cost is incremental only if the account lacks Workers Paid. Paying Cloudflare for a domain or other product is not proof of Workers Paid entitlement. Activation remains a separate decision.
- Vendor docs are authoritative for their stated product terms but not independent proof of live delivery, account access or long-term pricing. Retrieved-date confidence and deployment evidence are separate.

## Local-context checks (not evidence about external products)

- Current FLUME board surveyed: 44 issues, no equivalent company-access epic. FLUME-39 owns AutomaticAI member credential provisioning; FLUME-16/17/21/29 cover existing people/memory and portable specialists. FLUME-6/7/10 are older corporate-mail aspirations, not evidence of an implemented mail service.
- Krebs execution-contract.md requires distinct native Plane actors and refuses a shared-key substitution. activation.md (dated 2026-10-06) records multiple Grolf/33god-pm candidate users, a retired identity, and missing project memberships. This is a reconciliation requirement, not a fresh live identity audit. Do not create another Grolf account before resolving existing candidates.
- CodeGraph status showed mostly fake embeddings. No semantic result was used; file/contract inspection was used instead.
- PJangler notebook status for Flume reports a planned binding with no notebook_id and failed remote/Overview checks. No notebook was provisioned or repaired during planning. Repo documentation and ticket links are the delivered artifacts; remote notebook publication is blocked on the existing binding.
