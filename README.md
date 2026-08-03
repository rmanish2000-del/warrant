# Warrant

**Warrant — an authorization layer for AI purchasing agents.** A human writes spending rules in
plain English; Warrant turns them into an enforceable mandate and refuses any action the mandate
doesn't allow.

Writeup: [Claude compiles, code decides](writeup/claude-compiles-code-decides.md)
— the design decision behind this, and its limits.

## What the demo shows

1. You type a four-sentence spending policy.
2. Claude compiles it into numbered clauses — streaming live — and flags the ambiguities it will
   not resolve on its own.
3. You resolve the flags and confirm. That confirmation is the moment the draft becomes an
   enforceable warrant; validity is stamped by the system, never by the model.
4. An agent proposes purchases. Deterministic code returns **ALLOW**, **ESCALATE**, or **DENY**,
   citing the clause that decided it.
5. Only an ALLOW or a human-approved ESCALATE can open a **Prava sandbox** payment session.
   A DENY makes **zero outbound calls** — there is a test pinning that, and a second test that
   pins it even when an approval is forced onto a denied decision.

The hero of the demo is a refusal: a proposal under every spending limit, denied anyway, because
the supplier isn't approved — citing the exact clause the human chose minutes earlier.

## Quickstart

Requires Node ≥ 22.6 (TypeScript runs via built-in type stripping; there is no build step).

```bash
git clone https://github.com/rmanish2000-del/warrant.git
cd warrant
npm install
npm test                # full suite, no network, no keys
npm run demo:headless   # the five canonical scenarios end to end, no browser, no keys
```

For the full operator console:

```bash
cp .env.example .env    # optional — see below
npm start               # http://127.0.0.1:3000
```

Everything degrades honestly without keys: with no `ANTHROPIC_API_KEY` the compile falls back to
a loudly-labelled built-in draft (a striped BUILT-IN FALLBACK badge — never mistakable for a live
compile); with no `PRAVA_SK` / `PRAVA_USER_EMAIL` the payment leg stays off and the console says
so. Refusals, approvals, and the record work in every configuration.

## How it works

Claude interprets policy and explains results. A human confirms authority. Deterministic code
evaluates proposals. Prava handles the approved sandbox transaction. A tamper-evident record
captures what happened and why.

The model never decides: the evaluator's input type structurally excludes the compiled English
text, so a clause's wording cannot influence a verdict — Claude compiles; code decides.

## The authorization record

Every decision is appended to a hash-chained, append-only record: the proposal, the verdict, the
determining clause, the human approval or rejection (with the approver), and the provider session
result when one exists. Each entry's hash covers its content plus the previous entry's hash, from
a defined genesis — **tamper-evident**, and deliberately not described as "signed": there are no
digital signatures here, and the record does not claim non-repudiation. Cumulative spend is
derived by summing authorized entries; there is no stored counter. The record exports as a single
JSON document from the console (`Export JSON`).

## Limitations

- **Sandbox only.** Every payment action is a Prava sandbox session. No real money moves, ever.
- **Demo-grade security.** A local, single-operator console bound to 127.0.0.1 — not a hardened
  service, and not claimed to be.
- **ALLOW execution is not wired to the provider** — only the human-approved escalation path
  opens a payment session. An allowed purchase is authorized and recorded, not executed.
- **Spend counts at approval, not settlement — by design.** A payment session that lapses or
  fails after approval still consumes headroom. That is the correct direction of error for a
  spending cap: counting only settlements would let an agent open ten sessions at once and blow
  through the cap while all are in flight. Each exported decision entry carries a `spendStatus`
  field (`hold` / `settled` / `not-counted`) so a future reconciliation could release expired
  holds by **appending** release entries; that reconciliation is not built, and this is the
  disclosure of it.

## Disclosure of pre-existing work

**Repository scaffold.** This repository was created on 30 July 2026 with a README stub, and the
setup commits — `.gitignore`, `.env.example`, `CLAUDE.md` and this README — were made on 31 July
2026, before the build window opened. It contains no application code.

**Rehearsal.** A private rehearsal was run on 30–31 July 2026 to de-risk the Prava sandbox
integration. It confirmed the real request and response shapes, established that a payment
session requires an interactive browser approval step before a credential is issued, and measured
policy-compilation latency at 24–30s. **No code from that rehearsal was used here.** The
rehearsal repository is private and available to judges on request.

**Documentation PR.** Before the window, a PR correcting four errors in Prava's integration guide
was merged into their repository (Prava-Payments/prava-skills#14). No code from it is part of
this submission.

**Specification.** The product specification, demo script and Q&A preparation were written before
the event.

**Everything else — every line of application code — was written inside the build window (31 July
to 2 August 2026 Pacific / 1 to 3 August 2026 India time), and the commit history shows exactly
which commits fall where.**

**Correction — post-window commits.** The submission-time state is the annotated tag
**`submission`** (`8c7e657`), the last commit inside the build window — judging should read
the repository at that tag. In the 47 minutes after the window closed (12:33–13:16 IST,
3 August 2026), three commits landed: `7ad9a94`, `6d4b3fa` and `e8178a3` — presentation and
documentation only (`public/index.html`, `CLAUDE.md`, `.env.example`). Commits after that
closed window, up to the final form of this paragraph, are documentation corrections to this
disclosure itself. The invariant: **no file under `src/` — evaluator, enforcement, clause
types — has changed since the tag.** Verify: `git diff submission..HEAD -- src/` prints
nothing. If development ever resumes after the event and touches `src/`, that diff will say
so honestly — and the tag still preserves the exact submitted code. This paragraph is final
and will not be edited again.
