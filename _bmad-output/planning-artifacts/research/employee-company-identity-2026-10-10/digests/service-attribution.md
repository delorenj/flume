# Service attribution research digest — employee/company identity

- **Date:** 2026-10-10 (all sources accessed this date)
- **Scope:** Read-only public research. No real services, accounts, or plane.delo.sh endpoints were touched.
- **Method:** `web-search` skill CLI (Tavily/fetch) + `gh` against public GitHub. Budget: **10/10 calls used** (5 page fetches, 2 searches, 3 gh calls). 5 primary docs consulted.
- **Context:** Flume employee identity on GitHub + self-hosted Plane — can each employee be a *native distinct comment author*, vs one shared bot attribution; costs/account restrictions; token mechanics.

---

## 1. GitHub: installation access tokens — expiry, scoping, identity

**Source A (primary):** GitHub Docs, "Generating an installation access token for a GitHub App" — `https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app`. Publisher: GitHub. Continuously-updated doc (no fixed pub date; API version header in examples: `2026-03-10`). Accessed 2026-10-10. **Confidence: High** (vendor doc, fetched directly).

Sourced facts:

- The installation access token **expires after 1 hour**. Exact quote: "The installation access token will expire after 1 hour."
- Token generation is `POST /app/installations/INSTALLATION_ID/access_tokens` authorized by an app JWT.
- **Per-token scoping down is native:** `repositories`/`repository_ids` body params restrict the token to specific repos (max 500 listed; otherwise all repos the installation can see), and `permissions` restricts to a subset of the app's granted permissions — "The installation access token cannot be granted permissions that the app was not granted."
- **Operational caveat (2026):** staged rollout began **April 27, 2026** of a stateless token format `ghs_APPID_JWT` for newly minted installation tokens — tokens are **no longer exactly 40 characters**. Anything assuming 40-char `ghs_…` tokens (validators, DB schemas, regexes in flume/hermes tooling) must be checked. Referenced changelog: `github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header` (cited within the doc; not fetched in this pass).
- Octokit SDKs can mint/rotate installation tokens automatically (noted in doc) — relevant to per-employee worker runtimes.

Implication for per-employee identity: a GitHub App installation token authenticates as **the app's installation**, not as a human. Comments/PRs made with it are attributed to the app (bot) identity. Per-employee *distinct* attribution on GitHub therefore requires **one app (or one account) per employee**, each with its own installation + key material.

## 2. GitHub: machine accounts vs shared logins (costs/account restrictions)

**Source B (primary, via search excerpt of the live page):** GitHub Terms of Service — `https://docs.github.com/site-policy/github-terms/github-terms-of-service` (and the Corporate ToS variant at `/en/site-policy/github-terms/github-corporate-terms-of-service`). Publisher: GitHub. Accessed 2026-10-10 via search excerpt (page not fetched in full — excerpt quality high, exact policy sentences present). **Confidence: High** for the quoted sentences, **Medium** for anything on the page beyond the excerpt.

Sourced quotes (ToS):

- "A machine account is an Account set up by an individual human who accepts the Terms on behalf of the Account, provides a valid email address, and is responsible for its actions. A machine account is used exclusively for performing automated tasks."
- "**Multiple users may direct the actions of a machine account**, but the owner of the Account is ultimately responsible for the machine's actions."
- "You may maintain **no more than one free machine account** in addition to your free Personal Account."
- "Your login may only be used by one person — i.e., a single login may not be shared by multiple people."
- "**A paid Organization may only provide access to as many Personal Accounts as your subscription allows.**" (seat-based billing pressure on per-employee personal/machine accounts)

Corporate ToS mirrors this: a Machine Account is a "User"; "A User's login may not be shared by multiple people."

**Not sourced in this pass (flagged, do not rely on without verification):** whether GitHub App bot users are free / never consume org seats, and the `app-slug[bot]` login convention. Widely believed true but no primary doc was fetched within budget — verify against GitHub Apps pricing/identity docs before making cost claims.

## 3. GitHub: comments vs git commit authorship — exact caveats

**Source C (primary):** GitHub Docs, "Troubleshooting commits" (redirected URL: `https://docs.github.com/en/pull-requests/how-tos/commit-changes/troubleshooting-commits`). Publisher: GitHub. Accessed 2026-10-10. **Confidence: High** (vendor doc, fetched directly).

Key quote: "**GitHub links a commit to a user by matching the email address in the commit header to an email address on a GitHub account.**" Unrecognized emails can show "Unrecognized author"; this report does not claim changing email settings rewrites existing commit objects.

Exact caveats that follow (comments ≠ commits):

1. **Comment authorship is actor-based.** Whoever/whatever authenticated the API call (installation token → app bot; PAT → that account) is the recorded comment author. Two per-employee apps ⇒ two distinct native comment authors.
2. **Commit authorship is data-in-the-commit, matched by email.** Git commits carry `author`/`committer` name+email from local git config. Pushing through an app installation token or a shared machine account does **not** rewrite these fields. Forge-side attribution links the commit to whichever account owns the matching email — "If your commits are linked to the wrong user or no user, update your Git email settings" (Source C).
3. **Consequence (corrected during review):** distinct employee apps can have distinct native comment authors but identical commit attribution; a shared bot can push commits with different author metadata but remains one native comment author. Per-employee git metadata is configured separately (for example, distinct author emails); it is not authenticated API authorship. The push credential alone never establishes commit authorship. Commit linking also does not grant access ("If your commits are linked to another user, that does not give them access to your repository." — Source C).
4. Web-UI-created commits and API "actor" fields are separate systems again; acceptance proofs must test both surfaces independently.

## 4. Plane: API keys are user-associated

**Source D (primary):** Plane Developer Docs, API Reference Introduction — `https://developers.plane.so/api-reference/introduction`. Publisher: Plane (makeplane). Accessed 2026-10-10. **Confidence: High** (vendor doc, fetched directly).

Sourced facts:

- Auth is a per-key header: `X-API-Key: <key>` (example prefix `plane_api_<token>`). OAuth 2.0 apps may alternatively use `Authorization: Bearer <oauth-access-token>`, scoped to user-granted scopes.
- "**You must have a Plane account or be registered to your instance to generate a key.**" Keys are created in **Profile Settings → Personal Access Tokens**, with title/description and **optional expiry**.
- Self-hosted instances use their own base URL (Plane Cloud is `https://api.plane.so/`).

Implication: a Plane API key **is associated with a user** — activity performed with that key is natively attributed to that user account. So per-employee Plane identity = per-employee user accounts (or OAuth per-employee authorizations); one shared key = shared attribution for everything, with no per-call actor override documented on this page. Docs root (`https://developers.plane.so/`, fetched) confirms the surface: REST API ("180+ endpoints"), webhooks, OAuth Apps, MCP server, agents.

## 5. Plane: bot / external-source support

**Evidence (code search, primary source = repo):** `gh search code --repo makeplane/plane "external_source"` (2026-10-10) returns `external_id`/`external_source` columns across many models in `apps/api/plane/`: page, project, cycle, state, label, issue_type, intake, asset, issue — i.e., the **external-source pattern is real and pervasive** in the public Plane backend. **Confidence: Medium-High** for the pattern; see below for the gap.

**Unverified within budget:** a dedicated **Bot model / bots endpoint** (historically used by Plane's GitHub sync, with `external_source: "github"`) was **not confirmed** — `apps/api/plane/db/models/bot.py` returned HTTP 404 on current `makeplane/plane` main, and no bot-specific file appeared in the search results. Possible causes: model moved/renamed in the current layout, bots removed/rewritten, or search index gaps. **Do not build against a Plane bots API without first confirming the endpoint on the installed instance.** Treat "bot external source support" as *plausible but unproven* on current Plane.

## 6. Unknown: installed Plane edition/version at plane.delo.sh

Not determined — this pass was read-only and did not contact the instance. Developers docs confirm self-hosted licensing tiers exist (Community vs. **Pro/Business license activation**: `developers.plane.so/self-hosting/manage/manage-licenses/activate-pro-and-business`, linked from the fetched docs root). Feature availability (API keys, comment endpoints, bots) can differ by edition/version. **Recommended non-invasive identification later:** instance-admin panel version string, the self-hosted license/edition page, or an unauthenticated version/instance endpoint on plane.delo.sh — one read-only request when the task permits touching the service.

---

## Minimal demo acceptance proof (recommended)

One throwaway GitHub repo + one throwaway local Plane (docker) instance — nothing on existing accounts/services:

1. **GitHub distinct comment authors:** register two scratch GitHub Apps ("employee-a", "employee-b"), install both on one scratch repo. For each: JWT → `POST /app/installations/{id}/access_tokens` (exercise `permissions`/`repositories` scoping; observe 1-hour `expires_at`). POST one issue comment per token. **Pass:** `GET /repos/{o}/{r}/issues/comments` shows two different author identities (the two apps), and each token mint logs the scoping + expiry.
2. **GitHub comments ≠ commit authorship:** from two checkouts, commit with distinct local author emails; push both through employee-a's token. **Pass:** both comments still author as their own app identity, while commit `author` follows each checkout's email (email-match rule), *not* the push token — captured from the commit API response.
3. **Plane API-key-associated user:** on a fresh local Plane, create two users; generate a Personal Access Token per user (Profile Settings → Personal Access Tokens, set an expiry). POST one work-item comment per key. **Pass:** each comment's actor/user field equals that key's owner (native distinct authors); a shared single key collapses attribution to one user (negative control).
4. Record JSON responses as the artifact; no assertions about bot endpoints until §5 is confirmed on the installed instance.

## Source list

| # | Source | Publisher | Date | Accessed | Confidence |
|---|--------|-----------|------|----------|------------|
| A | Generating an installation access token for a GitHub App (docs.github.com) | GitHub | rolling doc (API version 2026-03-10; rollout note 2026-04-27) | 2026-10-10 | High |
| B | GitHub Terms of Service (site-policy, incl. Corporate ToS) | GitHub | current ToS (live page, excerpt) | 2026-10-10 | High (quotes) / Medium (page beyond excerpt) |
| C | Troubleshooting commits (docs.github.com, redirected URL) | GitHub | rolling doc | 2026-10-10 | High |
| D | Plane API Reference — Introduction (developers.plane.so) | Plane | rolling doc | 2026-10-10 | High |
| E | developers.plane.so docs root (self-hosting/license links) | Plane | rolling doc | 2026-10-10 | High |
| F | `gh search code` on makeplane/plane for `external_source`; `gh api …/models/bot.py` (404) | GitHub repo makeplane/plane | current main | 2026-10-10 | Medium-High (pattern) / Unverified (bot model) |

**Explicitly unsourced:** GitHub App seat/pricing claims; `app-slug[bot]` login format; existence of a bots API in current Plane. Verify before use.
