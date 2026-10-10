# Cloudflare email for per-agent addresses @agents.delo.sh — research digest

**Question:** Per-agent email addresses at `@agents.delo.sh`, no per-mailbox subscription, Cloudflare preferred.
**Accessed:** 2026-10-10 (all sources). **Method:** web-search CLI (Tavily + Brave), 3 searches, 3 primary-source page reads.
**Fit verdict up front:** Cloudflare fits well for inbound and verified-destination outbound at $0; outbound to *arbitrary* recipients requires the $5/mo Workers Paid plan and Email Sending is still **Beta** as of Oct 8, 2026. `agents.delo.sh` works as a subdomain of the existing `delo.sh` zone — but with **no catch-all on subdomains** (apex only), so each agent needs a literal routing rule (200 rules/domain cap).

## Findings

### 1. Email Routing pricing — free, unlimited inbound

- Email Routing (inbound receiving/forwarding) is available on **both Workers Free and Workers Paid** plans; inbound emails **unlimited** on both. Outbound (Email Sending) is "Not available" on Free.
  - Source: https://developers.cloudflare.com/email-service/platform/pricing/ — publisher: Cloudflare docs — "Last updated Jun 9, 2026" — accessed 2026-10-10 — confidence: **high** (primary, fetched full page).
- Marketing page confirms Email Routing is a free service for custom addresses + forwarding; "storing and accessing no email content" (no mailbox storage — see §2).
  - Source: https://www.cloudflare.com/products/email-routing — publisher: Cloudflare — undated marketing page — accessed 2026-10-10 — confidence: **medium-high** (primary marketing, search snippet).
- Third-party corroboration: free on all plans incl. free tier, no per-user fee; "no message-count limit on forwarding."
  - Source: https://nesmachny.com/post/how-i-set-up-free-professional-email-for-my-startup-using-cloudflare-and-you-can-too — publisher: nesmachny.com (blog) — dated 2026 (undated exact) — accessed 2026-10-10 — confidence: **medium** (secondary).

### 2. Email Workers — inbound handling, storage is DIY

- Inbound mail can be routed to an **Email Worker** (code handler) instead of a forwarding address; each routing rule maps one pattern to one destination address **or one Worker**; to fan out to multiple destinations, the Worker calls `forward()` per destination.
  - Source: https://developers.cloudflare.com/email-service/platform/limits/ — Cloudflare docs — "Last updated Sep 25, 2026" — accessed 2026-10-10 — confidence: **high** (primary, fetched full page).
- **No built-in mailbox/storage**: Email Routing is forwarding/Worker-handoff only; to persist mail, the Worker stores into R2/D1/Queues itself ("process incoming mail, store attachments in R2, add tasks to Queues").
  - Sources: https://blog.cloudflare.com/email-service (Cloudflare Blog, ~Jul 15, 2026 per Brave result age) and https://justemails.app/blog/cloudflare-email-routing-vs-justemails (JustEmails, undated comparison) — accessed 2026-10-10 — confidence: **high** (consistent across Cloudflare's own framing and comparison sites; no mailbox product exists in Email Routing).
- Workers handling inbound email count toward **standard Workers CPU/memory limits**; on Workers Free, complex handlers may fail with `EXCEEDED_CPU` and drop the message; Email Routing Worker invocations are billed per **Workers pricing**.
  - Source: limits page (above) + https://developers.cloudflare.com/workers/platform/pricing/ (referenced, not fetched) — accessed 2026-10-10 — confidence: **high** for the limit statement (primary), **medium** for exact Workers dollar figures (see §5).
- Inbound message size cap **25 MiB** (larger rejected); `message.reply()` throws if >100 `References` headers.
  - Source: limits page — confidence: **high**.

### 3. Outbound — verified-recipient restriction vs the new Email Sending / Email Service

This is the biggest change since the "old" Email Routing model. Cloudflare has unified routing + sending into **"Email Service"** (developers.cloudflare.com/email-service), announced as **private beta** on the Cloudflare Blog (result dated ~Jul 15, 2026); the docs homepage (updated **Oct 8, 2026**) still labels Email Sending **"Beta"** — not GA as of access date.

- **Verified-destination rule (the free path):** before onboarding a sending domain you can only send to **verified destination addresses** in your account; sends to verified destinations are **free on all plans** (even with only Email Routing configured), don't count toward monthly quota or daily limits. "You can only send from your routing domains." After onboarding a sending domain, you can send to **any recipient**.
  - Source: https://developers.cloudflare.com/email-service/platform/limits/ (Sep 25, 2026) — confidence: **high**.
- **Pricing for arbitrary-recipient sending:** requires **Workers Paid** ($5/mo minimum per account per third parties); **3,000 outbound emails/month included per account**, then **$0.35 per 1,000**; hard-bounces count, API-rejected/suppression-blocked sends don't.
  - Sources: pricing page (Jun 9, 2026, primary, **high**) + https://whichdevtool.com/tools/cloudflare-email-service/ (whichdevtool, ~2 weeks old, corroboration, medium).
- **Sending channels:** REST API, Workers `send_email` binding, and **SMTP** all exist under Email Sending. Gotcha: Worker-sent emails appear as "dropped" in the Email Routing summary even when delivered; use Email Sending metrics.
  - Source: limits page (Sep 25, 2026) — confidence: **high**.
- **Beta-announcement quote:** "Email Sending will require a paid Workers subscription… we're still finalizing the packaging… Email Routing limits will remain unchanged."
  - Source: https://blog.cloudflare.com/email-service — Cloudflare Blog — dated ~2026-07-15 (Brave age; Tavily undated) — accessed 2026-10-10 — confidence: **medium-high** (publisher primary; exact date from search index, page not fetched).
- ⚠️ **Conflicting outlier — distrust:** flowmails.net (Jul 10, 2026) claims "$0.09 per 1,000 emails" and that Email Service "moved out of beta" — contradicts the official $0.35/1,000 and the Oct 8, 2026 Beta label. Treat as wrong/stale/unreliable. mailertogo claims "public beta in April 2026," also inconsistent with the Jul 15 private-beta blog date. Official docs win.

### 4. Subdomain constraints for `agents.delo.sh` — works, with two sharp edges

- Email Routing is a **zone-level feature on the apex domain by default**, but you **can extend it to subdomains of the same zone** (dashboard: apex domain → Settings → Subdomains inline form). Cloudflare adds the required DNS records (MX) to the subdomain; afterwards you create **literal routing rules** for addresses on it. **No separate Cloudflare zone needed** — important because subdomain-as-zone is an Enterprise feature.
  - Source: https://developers.cloudflare.com/email-service/configuration/subdomains/ — Cloudflare docs — "Last updated Sep 25, 2026" — accessed 2026-10-10 — confidence: **high** (primary, fetched full page).
- **Sharp edge 1 — no catch-all on subdomains:** catch-all rules are **only available for the apex domain**. Every `agent-<name>@agents.delo.sh` needs its own literal routing rule.
  - Source: subdomains page — confidence: **high**.
- **Sharp edge 2 — counts:** max **30 domains per zone** configured for Routing or Sending combined (incl. apex); **200 routing rules per domain**; **200 verified destination addresses per account** (shared across all domains in the account). A fleet of ~25 agents fits; a much larger fleet approaches the 200-rule cap on one subdomain.
  - Source: limits page (Sep 25, 2026) — confidence: **high**.
- **Sending from the subdomain:** Email Sending treats a subdomain as a **separate sending domain**; onboarding adds `cf-bounce` MX, SPF, DKIM, DMARC records to the subdomain, then you can send `notifications@agents.delo.sh`-style via REST API or Worker binding.
  - Source: subdomains page — confidence: **high**.
- Generic mail-DNS footgun (any provider): a hostname with a CNAME cannot carry MX; null-MX (RFC 7505) has historically been awkward on Cloudflare DNS.
  - Source: https://portalzine.de/mx-records-for-subdomains-the-complete-guide-to-routing-email-like-a-pro — portalZINE.DE — undated — accessed 2026-10-10 — confidence: **medium** (secondary, generic DNS expertise).

### 5. Workers costs (the compute underneath)

- Email Routing Workers billed per Workers pricing (primary statement). Workers Paid = **$5/month minimum** (repeated by whichdevtool, mailertogo, agentmail comparisons). Workers **free tier = 100,000 requests/day** (nesmachny; consistent with known Workers pricing). Exact current per-million overage figures **not verified from the official Workers pricing page** (budget).
  - Sources: pricing page reference link https://developers.cloudflare.com/workers/platform/pricing/ (not fetched); https://resources.mailertogo.com/comparisons/smtp-vs-email-api-cloudflare-workers (MailerToGo, 2026); https://www.agentmail.to/blog/cloudflare-vs-agentmail (AgentMail, Jul 15, 2026) — accessed 2026-10-10 — confidence: **medium** (figure corroborated by 3 independents; official page unread).
- For this use case inbound Worker invocations (one per received email) are trivially inside free tiers at fleet scale.

## Cost model for @agents.delo.sh (evidence-derived)

| Capability | Plan needed | Cost |
|---|---|---|
| Receive at agent-<name>@agents.delo.sh → forward or Worker | Free | $0 |
| Worker processing inbound (storage DIY in R2/D1/KV) | Free (CPU-limited) | $0 |
| Agent *sends* only to verified operator addresses | Free | $0, unlimited, no quota impact |
| Agent sends to arbitrary external recipients | Workers Paid + onboarded sending domain | $5/mo + 3,000/mo included, then $0.35/1k |

## Explicit unknowns

1. **Exact daily sending quotas** — docs say new accounts start "conservative" and auto-scale; no numbers published (limits page).
2. **GA vs Beta status after Oct 8, 2026** — docs homepage still says Beta on Oct 8; no GA announcement found within budget. The blog's "final pricing" caveat means numbers could still move.
3. **Official Workers pricing page figures** (per-million overage, exact CPU ms on Free) — not fetched; third-party corroborated only.
4. **Whether Email Routing forwarding to unverified external addresses counts as "sending"** — not addressed; forwarding to verified destinations is the documented pattern.
5. **DKIM selector specifics / bounce handling details** for sending subdomains — `cf-bounce` MX noted, deeper deliverability docs unread.

## Date sanity flags (per task instruction)

- All four official pages carry 2026 "Last updated" dates (Jun 9 / Sep 25 ×2 / Oct 8) — internally consistent and recent relative to the Oct 10, 2026 access date. No future dates found.
- Odd ordering worth noting: the pricing page's update date (Jun 9, 2026) **predates** the private-beta blog announcement (~Jul 15, 2026) — likely the page lived under the older Email Routing docs tree pre-unification, or the index date is unreliable. Low impact: the fetched page content is self-consistent with the Sep/Oct pages.
- flowmails.net's "out of beta" claim is **inconsistent with the official Oct 8, 2026 Beta label** — flagged above as an outlier to distrust.

## Source register

| # | URL | Publisher | Pub date | Accessed | Confidence |
|---|---|---|---|---|---|
| 1 | https://developers.cloudflare.com/email-service/platform/pricing/ | Cloudflare docs | Jun 9, 2026 | 2026-10-10 | high (primary, fetched) |
| 2 | https://developers.cloudflare.com/email-service/platform/limits/ | Cloudflare docs | Sep 25, 2026 | 2026-10-10 | high (primary, fetched) |
| 3 | https://developers.cloudflare.com/email-service/configuration/subdomains/ | Cloudflare docs | Sep 25, 2026 | 2026-10-10 | high (primary, fetched) |
| 4 | https://blog.cloudflare.com/email-service | Cloudflare Blog | ~Jul 15, 2026 (search-index age; page not fetched) | 2026-10-10 | medium-high |
| 5 | https://developers.cloudflare.com/email-service/ | Cloudflare docs (homepage snippet) | Oct 8, 2026 | 2026-10-10 | medium-high (snippet) |
| 6 | https://www.cloudflare.com/products/email-routing | Cloudflare marketing | undated | 2026-10-10 | medium-high (snippet) |
| 7 | https://whichdevtool.com/tools/cloudflare-email-service/ | whichdevtool | ~Sep 2026 | 2026-10-10 | medium |
| 8 | https://nesmachny.com/post/how-i-set-up-free-professional-email-for-my-startup-using-cloudflare-and-you-can-too | nesmachny.com | 2026, undated | 2026-10-10 | medium |
| 9 | https://resources.mailertogo.com/comparisons/smtp-vs-email-api-cloudflare-workers | MailerToGo | 2026 | 2026-10-10 | medium |
| 10 | https://www.agentmail.to/blog/cloudflare-vs-agentmail | AgentMail | Jul 15, 2026 | 2026-10-10 | medium |
| 11 | https://justemails.app/blog/cloudflare-email-routing-vs-justemails | JustEmails | 2026, undated | 2026-10-10 | medium |
| 12 | https://portalzine.de/mx-records-for-subdomains-the-complete-guide-to-routing-email-like-a-pro | portalZINE.DE | undated | 2026-10-10 | medium |
| 13 | https://flowmails.net/blog/transactional-email-pricing-cloudflare (and /cloudflare-workers-email-cost) | Flowmails | Jul 10, 2026 | 2026-10-10 | **low — contradicts primary, distrusted** |
