# CLAUDE.md

Synced against pack version: 1.4

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth

The specification pack at `C:\Push-to-Prod-2026\Warrant-PreHackathon-Pack` governs this build.
`current/` is the **only** active source of truth; `archive/` and `founder-prep/` are context, and
`archive/` is superseded by definition.

**Version-stamp rule.** At the start of every phase, compare the `Synced against pack version:` line
above with `**Pack version:**` in `current/00_README.md`. If they differ, re-read `current/` and
re-sync this file *before* doing any work. A stale spec is not detectable from inside the code.

Pack files worth reading before touching the relevant area:

| Area | File |
|---|---|
| Product definition, scenarios, scope | `current/01_PRODUCT_SPEC.md` |
| Console layout and states | `current/02_UI_WIREFRAMES.md` |
| Model prompts and their hard limits | `current/03_PROMPT_SPECIFICATIONS.md` |
| Demo beats, timing budget, tier ladder | `current/04_DEMO_SCRIPT.md` |
| Acceptance criteria | `current/05_ACCEPTANCE_CRITERIA.md` |
| System boundary diagrams | `current/06_ARCHITECTURE_DIAGRAMS.md` |
| Test cases | `current/07_TEST_CASES.md` |
| Disclosure boundaries and prohibited claims | `current/08_IP_AND_DISCLOSURE_BOUNDARIES.md` |
| Status ledger, never-claim rows, judge answers | `founder-prep/05-FAQ-AND-TRUTH-LEDGER.md` |

## Product

**Warrant** — an authorization layer for agentic commerce. Working name; trademark clearance has not
been run.

> No agent spends without an explicit, enforceable human mandate.

A human writes spending policy in plain English. Claude compiles it into a structured draft. The
human confirms the draft — that is the moment it becomes enforceable. Deterministic code then
classifies every proposed action as `ALLOW`, `ESCALATE`, or `DENY`, citing the governing clause. Only
an allowed or approved-escalation action may reach a Prava **sandbox** payment session. Everything is
written to an append-only authorization record.

Primary user: an operations manager or business owner deploying an AI purchasing agent.

## Architecture

Being designed during this build, not inherited from anywhere. Record decisions here as they are
made — module boundaries, data flow, storage, and where the process boundary sits between model and
evaluator.

Decided so far:

- **Toolchain** — TypeScript strict; tests on `node:test` via type stripping. `erasableSyntaxOnly`
  is load-bearing: source must stay strippable.
- **Dependency policy** — the **engine is zero-dependency** (that is the determinism claim); the
  compiler layer carries exactly one runtime dependency, `@anthropic-ai/sdk`. Nothing else without
  recording it here.
- **Compiler model call** — `claude-opus-5`, streaming, adaptive thinking with
  `display: "summarized"` (the 24–30s compile streams visible reasoning, not a dead pause),
  structured output via `output_config.format` (`additionalProperties: false` throughout).
  Effort stays `high` — measured 24–30s; do not lower it to speed the demo (low risks missing
  the overlap flags, which are a demo beat). **No server-side refusal fallback, ever** — the
  LIVE COMPILE badge must mean exactly one thing (this model, this prompt); a silent server-side
  substitution keeps the badge green while provenance changes, undetectable on camera. Failures
  are loud: labelled stub, or replay the cache. Do not re-add `fallbacks`.
- **`src/engine/`** — pure, clock-free evaluation. `evaluate(warrant, ledger, proposal, at)` takes
  time as a parameter and reads structured fields only: its input type `EvaluableWarrant` omits
  `clauses`, so compiled English text cannot influence a verdict by construction.
- **Verdict union** enforces exactly-one-citation structurally. Expired-mandate and
  invalid-proposal denials carry `reason` with `clause: null` — distinct from clause breaches.
- **Evaluation order is precedence**: validity → shape → C1 → C2 → C3 → C4. C1 before C2 is guarded
  by a dedicated test (scenario C breaches the cap arithmetically and must still cite C1).
- **Boundaries**: cap inclusive (total of exactly ₹15,000 escalates, +1 denies); threshold strict
  (exactly ₹5,000 allows). Validity is `issuedAt ≤ t < expiresAt`; outside it — including before
  issuance and NaN timestamps — fails closed with reason `OUTSIDE_VALIDITY` (the UI words the
  expired case as an expired mandate, per the pack).
- **Enforcement boundary** — `src/records/append.ts`. Approvals attach only to ESCALATE decisions;
  session results only to executable ones (ALLOW / approved escalation); records are hash-chained
  from a defined genesis. `src/console/flow.ts` is the app logic: the payment provider is an
  injected port with exactly one call site behind `isExecutable` + a recorded approval, clock
  injected, and provider responses narrowed by explicit field copy (allowlist — extra fields are
  structurally unreachable). Seeded history goes through the boundary (first purchase escalates C4,
  approved by `OPERATOR_ID`).
- **Console** — `src/server/main.ts` (node:http, 127.0.0.1 only) + `public/index.html` (no
  framework, no bundler). View-model in `src/server/view.ts` builds every field explicitly. Badge
  semantics are load-bearing: green LIVE COMPILE only for a compile streamed in the current
  browser session; CACHED REPLAY (blue dashed) and BUILT-IN FALLBACK (striped, loud) are visually
  disjoint. The refusal view never depends on payment state; payment status words are camera-safe
  (never `timeout` etc.). Warrant validity always renders as absolute dates.
- **Record export** — `GET /api/export`, built field-by-field in `src/server/view.ts::exportView`.
  Per-decision `spendStatus` (`hold`/`settled`/`not-counted`) is **derived**, never stored: spend
  counts at approval, not settlement (a lapsed session keeps its hold — correct direction of error
  for a cap; README names the gap). Future reconciliation = appended release entries, not edits.
  Not built, disclosed.
- **Counter scopes are deliberate — do not "clean up" the pair into one counter.** The DENY
  panel's cells are per-decision (`credentialRequestsFor()`, `outboundCallsFor()`) or
  snapshot-vs-now (sessions cell), because the panel's claim is about THIS refusal. The header
  tallies and the ₹X-of-₹15,000 readout are global (header labels say "(total)"). The
  per-decision credential counter exists because the global one keeps climbing while an earlier
  approval's payment leg polls in the background: rendered globally, scenario C's refusal read
  "credential requests: 2 — none requested" on camera — a self-contradiction — and `demo:nopay`
  masked it (its global counter stays 0). A per-decision counter next to a global one is the fix
  for that failure, not an inconsistency.

The one structural rule that is fixed by the spec, and is the whole product claim:

> Claude interprets policy and explains results. A human confirms authority. **Deterministic code
> evaluates proposed actions.** Prava handles the approved sandbox transaction. A tamper-evident
> record captures what happened and why.

The model never decides. If a generated explanation and the evaluator disagree, the evaluator wins
and the explanation is the bug.

## Invariants

These are load-bearing. Violating any of them breaks the product's central claim, not just a test.

1. **The evaluator is authoritative.** Model output is never an enforcement decision.
2. **`DENY` cannot create a payment session.** There must be no code path from a denied evaluation to
   execution. Not a warning that can be clicked through.
3. **`ESCALATE` cannot proceed without an explicit human approval event.**
4. **Every decision cites at least one clause.** Explanations introduce no rationale the evaluator
   did not produce.
5. **Determinism.** Identical inputs always produce an identical result.
6. **The compiler must not emit validity.** No `starts_at`, `expires_at`, or duration from the model.
   The system stamps validity at confirmation time. A model that sets the lifetime of its own mandate
   has no mandate.
7. **Cumulative spend is derived, not stored.** It is the sum of authorization records under the
   warrant. No second spend store, no rolling-window arithmetic.
8. **Four independent clocks; never conflate them.** Warrant validity (7 days from issuance) ·
   limit window (aligned, identical to validity) · payment-session validity (the provider's, ~15 min,
   always labelled as theirs) · decision-level authorization (deliberately **not introduced**).
9. **No secret reaches the client.** Provider credentials stay server-side.
10. **Fail closed.** Provider unavailable, schema invalid, warrant expired → refuse. An expired
    warrant denies with an expired-mandate reason.
11. **No compiler fabrication.** No invented suppliers, limits, currencies, dates, or exceptions.
    Ambiguity is flagged for human review, never resolved silently.
12. **Logs never contain full card credentials.** No credential value belongs in source, in a log, or
    on screen — including sandbox ones, including for display.

## Clause precedence

A **hard limit breach outranks an approval threshold**, because escalation cannot cure a breach.
Where C3 and C4 both apply, both escalate, so ordering cannot change the outcome — cite **C3**, the
amount being the more specific fact.

Distinguish **clauses evaluated** (every clause checked) from the **determining clause** (the single
clause that produced the outcome). Only the determining clause is cited in the UI and the record.

## Canonical demo data

Policy, compiled warrant, and clause IDs C1–C4 are fixed in `01_PRODUCT_SPEC.md` §5–6. Do not
paraphrase them.

**Deliberate divergence from pack §5:** the demo policy is the **four-sentence** version — the
minimum-stock sentence ("Keep packaging supplies above three days of stock") is dropped, and
`minimum_stock_days` is not compiled. This is a scope decision, not an oversight: the recording
says "Four sentences" out loud, and the recording is the deliverable. Do not add the fifth
sentence back.

**Sentence one names the supplier — "Buy only from approved suppliers — PackRight Supplies." —
and must keep doing so.** A live compile (1 Aug) given the unnamed version correctly refused to
invent a supplier (fabrication is a listed failure condition) and produced an empty allowlist,
which made scenario A deny on C1 and the seed refuse to load. The name is load-bearing input,
not clutter; removing it resurfaces the failure as a wrong verdict, not as an error. The pack §6
canonical warrant lists PackRight for exactly this reason. Still four sentences — the spoken
"Four sentences" beat holds.

Scenarios run **in order against an accumulating ledger** seeded at ₹4,000 by prior authorization
records — so the console's "₹4,000 of ₹15,000" readout is derived, not asserted. Authorized spend
(including approved escalations) accumulates; denials add nothing.

| # | Supplier | Amount | Prior | Expected | Determining clause |
|---|---|---|---|---|---|
| A | PackRight Supplies | ₹3,800 | ₹4,000 | `ALLOW` | none breached |
| B | PackRight Supplies | ₹6,200 | ₹7,800 | `ESCALATE` | C3 |
| C | Unknown Vendor | ₹4,900 | ₹14,000 | `DENY` | C1 |
| D | PackRight Supplies | ₹12,000 | ₹14,000 | `DENY` | C2 |
| E | PackRight Supplies | ₹9,000 | ₹14,000 | `DENY` | C2 |

Scenario C is the hero: **under every limit and refused anyway**, because the supplier is not
approved. No session created, no credential requested.

Scenario E is the reason the ledger is sequential — against the ₹4,000 seed alone it would merely
escalate. It is denied *only* because A and B were authorized before it. Any change that makes E pass
has broken invariant 7.

## Scope

In scope: plain-English policy input · Claude-compiled structured draft · human confirmation ·
deterministic evaluation · clause-level explanation · approval interaction for escalation · Prava
sandbox payment session · tamper-evident authorization record · JSON export · single-screen operator
console.

Out of scope, deliberately: real money · live INR card claims · merchant browser automation ·
inventory integration · ERP · voice · multi-tenant RBAC · analytics dashboard · mobile · multi-currency ·
learning or memory · autonomous recurring purchasing.

> Note: the pack's §8 lists 10 capabilities against 6 ratified at P0 (`00_README.md` open item 7).
> Undeclared decomposition — do not treat the count as settled.

## Acceptance criteria

`current/05_ACCEPTANCE_CRITERIA.md` is the checklist; do not restate it from memory. The gates that
most often get lost mid-build:

- Compiler output is schema-validated and contains no validity period.
- The record carries warrant version, proposal, evidence, decision, clauses, approval event, sandbox
  session reference, outcome, timestamp, previous hash, and record hash; it exports as valid JSON.
- The UI labels every payment action as sandbox, and describes the record as *tamper-evident*, never
  *cryptographically signed*.
- Compile-in-progress renders visible movement, not a static screen. Provider-result-pending does not
  block the record view.
- All critical demo states are reachable from seeded data, with no hidden setup during judging.
- A recorded fallback exists and provider failure does not break the core demo.

Timing gates (P3): three timed runs at **≤115s**, at least two against live Claude and live sandbox;
**the refusal on screen by 1:26 on every run**; CP1–CP4 wall-clock recorded each run. Provider result
retrieval happens in the background and is never waited on. CP3 (1:02, provider surface ready) exists
to protect the hero — if it slips, drop the payment leg without touching the refusal.

## Disclosure boundaries

**Safe to disclose:** the problem, the user, the Warrant concept, policy compilation, the three
decision categories, human confirmation and approval, Prava sandbox integration, clause-level
explanation, the tamper-evident record, public-safe module interfaces, and the demo's limitations and
fallback behaviour.

**Never disclose:** the internal platform's architecture or internals · multi-agent
orchestration · private governance framework · memory systems · internal prompt collections ·
private APIs · internal workflows · repository structure of private systems · roadmap ·
strategic implementation details · private datasets · security controls unrelated to the
public demo.

This constrains code, comments, commit messages, README, and UI copy — not just what is said aloud.

### Never say

In any artifact — UI, docs, comments, commits:

- "cryptographically signed" — unless digital signatures are actually implemented
- "real money moved" — it is sandbox
- "Prava enforces cumulative spending limits" — not officially confirmed
- "merchant locked" — unless confirmed by Prava *and* demonstrated
- "production secure"
- "fully autonomous"
- "compliant with all regulations"
- "built on internal platform components"
- "Claude decides" — it does not

### Say instead

"sandbox payment authorization" · "human-confirmed warrant" · "deterministic enforcement" ·
"clause-level explanation" · "tamper-evident authorization record" · "working name" · "public
demonstration" · "recorded fallback" · "standalone public product".

### Permanent never-claim rows

`NOT BUILT` by design, and staying that way: real-money transactions · cryptographic signatures or
non-repudiation · merchant locking enforced by Warrant · learning, memory, or self-adapting policy ·
autonomous recurring purchasing · production security posture · regulatory compliance.

### The three-word test

If you cannot say **"I can show you"**, it is not built. Describe from the screen, never from the
spec. Status claims live in the ledger at `founder-prep/05-FAQ-AND-TRUTH-LEDGER.md` §1 — every
functional row reads `PLANNED` until verified on the demo machine and dated.

## Build-window and provenance rules

The pack's former constraint *"do not write application code before organiser clarification"* was
**lifted on 30 July** (`00_README.md` §"Governing Constraint"). The application was approved, RSVP is
complete, and the organiser's Builder Handbook governs. Do not reintroduce that constraint and do not
stop on it.

- All application code in this repository is written inside the official build window: **31 July –
  2 August 2026 Pacific** (1–3 August IST). The commit history is the evidence.
- A sibling directory `warrant-rehearsal` contains a pre-window rehearsal implementation. **Do not
  read it, copy from it, or take design cues from it at any point.** Its existence is disclosed in
  `README.md`; no code from it is in this repository.
- Pre-existing and disclosed: the specification pack, demo script, and Q&A preparation, plus a merged
  documentation PR to Prava's integration guide. No application code pre-existed.
- Keep `README.md`'s disclosure section accurate. If what is true changes, the disclosure changes.

## Provider integration

Prava is **sandbox only**. The correct API reference is on disk at
`C:\Users\rmani\.claude\skills\prava-sdk-integration\references\session-api-reference.md`.

`PRAVA_INTEGRATION_GUIDE.md` is **wrong in six places** — do not build against it.

Facts established and safe to rely on: a payment session requires an interactive browser approval
step before a credential is issued; `currency: "INR"` with `country_code_iso2: "IN"` creates a session
on the sandbox host and renders as ₹; `merchant_details` is the **destination merchant**, forwarded to
Visa to scope the credential — not the integrating app.

Verified live (1 Aug, probe + implementation in `src/provider/prava.ts`):

- Base URL `https://sandbox.api.prava.space` only; `api.prava.space` is production — never call it.
- `POST /v1/sessions` → **201**; ids come back as `session_id` with prefix `ses_` (no `id` field);
  amounts are strings (`total_amount`, `product_details[].unit_price` — a wrong name errors two
  levels up as `purchase_context: ["Required"]`); use the server's `expires_at`, never a computed
  15 minutes; `session_token` is dropped at the boundary and stored nowhere.
- The flow is not server-only: the create response's `iframe_url` opens the provider's approval
  page; `card.card_id` pre-selects the saved card but never skips the passkey — by design.
- **Never embed the approval page — decided, verified live (1 Aug).** The collect page spawns its
  own inner Visa FIDO iframe (`sbx.vts.auth.visa.com`); embedded under our origin that frame is
  double-nested and its handshake stalls (spinner → retries → `FIDO_START_FAILED` at ~40s), while
  the identical session opened top-level sails through to the ceremony. Additionally, **the
  collect link is single-use per page LOAD** — an embed attempt or a tab reload consumes it and
  any second load shows "Session Already Used". The console therefore renders exactly one
  click-to-open anchor (`target="_blank"`, real user gesture, consumed on click); the provider's
  own popup fallback exists but is never used (the video bans popups; new tab is DECIDE-7-blessed).
- The provider's ~40s FIDO clock starts at **page load** — i.e. at the button click — not at
  session creation (verified: an unloaded session stays `awaiting_verification` for minutes; every
  observed `FIDO_START_FAILED` came ~40s after a load). Before the click, only the provider's
  ~15-minute session expiry applies. Practical rule: click when ready, then do the passkey
  immediately.
- **THE TRAP**: never wait for `status === "completed"` — it never arrives. Readiness is
  `transactions[0].line_items[0].token` existing while status is still `awaiting_result`.
  Pre-passkey the response is `status: "pending"` with `transactions: []` (empty).
- Credential values (`token`, `dynamic_cvv`, expiry) never leave `pollResult` — only `txn_ref_id`
  crosses the port. `POST /v1/sessions/{id}/report-status` with `txn_status: "APPROVED"` is
  mandatory; its `visa_confirmation` ("SUCCESS") is surfaced in the UI — the provider's own word.
- Sessions are single-use, ~15 min, fresh session per attempt; a poll cycle costs ~3.26s.
- Saved card auto-discovered at server boot via `/v1/listCards` (default card), or pinned with
  `PRAVA_CARD_ID`. Seeded history's approvals never execute — no session is created for the seed.
- **Lapsed or provider-closed sessions: no retry control — decided, PR-07 wins.** "No retry without
  re-evaluation" over EV-11's narrower reading. A lapsed session means the authorization must be
  made **again**, not resumed: the execution authority died with the session. On camera that means
  a fresh take or `demo:nopay`. This is correct product behaviour, not a limitation — do not add a
  "fresh session" convenience button at hour 30.

## Repository conventions

### Secrets and git hygiene

- **Never `git add -A`.** Name every path. A blanket add previously swept in an unreviewed file.
- **`.gitignore` does nothing to an already-tracked file.** Treat a new ignore rule as a no-op until
  `git rm --cached` proves otherwise. Check with `git ls-files -i -c --exclude-standard`.
- **No credential in source** — not in a log line, not in a comment, not for display, not even a
  sandbox value.
- **Never read, print, or echo the contents of `.env`.**
- Secrets load from `.env` (gitignored). `.env.example` is the committed template and survives the
  `.env.*` rule only because of the `!.env.example` negation — keep the negation after the rule and
  re-verify with `git check-ignore` if the file is edited.
- Two silent Windows failure modes are documented in `.env.example`: a UTF-8 BOM voids the first
  variable, and Notepad saves `.env` as `.env.txt`.

### Artifacts

Generated console HTML contains real session ids. It builds to `dist/` and is gitignored. `npm run
demo` regenerates it, so a judge running the project still sees it. **Nothing generated is
committed.** This is decided — do not re-open it.

### Recurring checks

- **Allow-list.** Every command approved in a session becomes a permanent rule in
  `.claude/settings.local.json`, and write-capable rules such as `git add -A` creep back in over a
  long build. Pruning once does not hold. Re-read and prune anything pre-approving a write at hour 20.
- **History scan.** Scan *full git history and reflog*, not just the working tree. Report **file and
  commit locations only — never the matched content**. Use `git grep -l`, which prints `commit:path`
  and no content:

  ```bash
  REVS=$(git rev-list --all --reflog); git grep -l -I -E "<pattern>" $REVS
  ```

  Patterns — each key prefix requires 8+ key characters after it, so prose that merely *names* a
  prefix does not match:

  | What | Pattern |
  |---|---|
  | Stripe-style secret | `sk_test_[A-Za-z0-9]{8,}` · `sk_live_[A-Za-z0-9]{8,}` |
  | Anthropic | `sk-ant-[A-Za-z0-9_-]{8,}` |
  | Stripe-style publishable | `pk_test_[A-Za-z0-9]{8,}` · `pk_live_[A-Za-z0-9]{8,}` |
  | Bearer token | `[Bb]earer[[:space:]]+[A-Za-z0-9._~+/=-]{8,}` |
  | JWT | `eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*` |
  | 16-digit run | `[0-9]{16}` · `([0-9][ -]?){15}[0-9]` |

  The entropy requirement is deliberate. A bare-prefix pattern matches this very file and returns the
  same benign hit forever, which teaches you to ignore hits — the exact failure the scan exists to
  prevent. **A clean run must mean clean.** Baseline at hour 0: clean on all nine patterns across the
  whole history. If a hit ever appears, report the location and stop for instruction before any
  history rewrite.

## Commands

- `npm test` — full test suite (Node's built-in runner; `.ts` runs via `--experimental-strip-types`, Node ≥22.6). New test files must be added to the script's explicit list — discovery is deliberate, not globbed.
- `npm run typecheck` — `tsc --noEmit`, strict; `erasableSyntaxOnly` keeps every source file strippable.
- `npm run demo:fresh` — the ONE live compile per recording session (needs `ANTHROPIC_API_KEY` in `.env`); streams the model's output and writes `demo-policy-compiled.json` (gitignored via `demo-policy*.json`).
- `npm run demo:reset` — replays the exact cached compile; never calls the API. Every retake after the compile take uses this.
- `npm start` — operator console at `http://127.0.0.1:3000` (node:http, zero deps; the server is plumbing, not the product). One window: compile streams to the page, flags resolve by click, proposals and approvals are buttons.
- `npm run demo:headless` — the five canonical scenarios end to end without the browser; recording fallback and exit-code check (non-zero on any deviation from the canonical table).
- `npm run demo:nopay` — the console with the payment leg OFF (the recording card's fallback if the payment leg misbehaves on camera). DENY, approvals, and the record are unaffected. Runs with a **frozen clock** (fixed epoch, +1s per read) so identical click sequences are byte-identical between runs. Flags are `--skip-payment --freeze-clock` — never rename to `--no-payment`: npm eats `--no-*` args as its own config negation.
- `npm run prava:probe` — one throwaway sandbox session + saved-card list, raw response shapes printed with credential-bearing values redacted. Run before trusting any parser change.
- `npm run gonogo` — the hour-32 Go/No-Go probe: one INR session through the real escalation path, ≤10s, verdict GO / DEGRADED / NO-GO (exit 0/2/1). Never touches the compile cache (stub warrant), never attempts the passkey.

Record build, lint, single-test, and `npm run demo` invocations here as they are established, so
this section stays the fastest way to run the project.
