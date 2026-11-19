# Independent review request — FLUME-80

Review the pushed branch `fix/FLUME-80-fresh-vault-verification` in an independent isolated worktree. Base is `f85a126835ce3f4a4b5f30198b949d865a9b54b6`; final delivery SHA is provided by the parent/branch remote. Do not share the implementer's checkout or modify main, Plane, live vaults/providers, employee definitions or Access policies. This is a source/fixture review, not authorization for live recovery or merge.

Conduct a review of the changed files in the branch. Inspect them directly before reviewing. Look for what's missing, not only what's wrong. Compute your finding floor N from the changed content size: N = min(floor(sqrt(kB) + 1), 10). State the arithmetic in one line, then find at least N issues to fix or improve. Output a Markdown list of findings with paths/lines and independently verified reachability. Do not invoke another skill or spawn subagents of your own; return findings directly.

Priority safety questions:

- Does invocation-scoped cache bypass cover fresh preflight and post-edit values, preserving Access section and immutable field-ID binding without changing unrelated fields/employees?
- Is deletion possible only after a non-uncertain failed write plus fresh confirmed absence of both Access fields? Can any read/parse/binding/receipt/timeout/signal failure delete a persisted token?
- Are all partial/cleanup results honest, including DELETE success without confirmed absence? Does a repeat apply avoid new token/item/rule/KV writes?
- Does stranded state compare fresh vault metadata/provider inventory/historical receipts and block mint/delete/overwrite before explicit owner-approved reconciliation?
- Can provider/op errors or item contents leak credentials through JSON, human output, receipts or local definitions?
- Are the documented live limitations and FLUME-53/57 boundaries accurate?

Read `_bmad-output/implementation-artifacts/FLUME-80/README.md` and `checks.json`, but do not treat implementer claims as your evidence. Run `npm ci`, initialize the pinned template submodule, and execute the bounded `run-checks.mjs` script in your worktree. It intentionally reports exit 1 for three relevant gateway fixture failures; baseline comparison reproduces the same failures. Reproduce before accepting that attribution. Normal provision regression must pass 22 groups; baseline reproduction mode must assert the old failure, not pass current code by weakening assertions.

Parent owns review classification, remediation authorization and merge decision. Report uncovered cases, live hold gates, and any false success/leak/unsafe rollback; do not repair credentials to make a test pass.
