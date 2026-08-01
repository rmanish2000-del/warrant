# warrant

Authorization layer for AI purchasing agents

## The authorization record

Every decision is appended to a hash-chained, append-only record: the proposal, the verdict, the
determining clause, the human approval or rejection (with the approver), and the provider session
result when one exists. Each entry's hash covers its content plus the previous entry's hash, from a
defined genesis — **tamper-evident**, and deliberately not described as "signed" or
"cryptographically" anything: there are no digital signatures here, and the record does not claim
non-repudiation. Cumulative spend is derived by summing authorized entries; there is no stored
counter. The record exports as a single JSON document from the console (`Export JSON`).

**Known gap, by design:** spend counts against the cap at **approval**, not at settlement. A payment
session that lapses or fails after approval still consumes headroom. This is the correct direction
of error for a spending cap — counting only settlements would let an agent open ten sessions at
once and blow through the cap while all are in flight. Each exported decision entry carries a
`spendStatus` field (`hold` / `settled` / `not-counted`) so a future reconciliation could release
expired holds by **appending** release entries; that reconciliation is not built, and this is the
disclosure of it.

## Disclosure of pre-existing work

**Repository scaffold.** This repository was created on 30 July 2026 with a README stub, and the setup commits — `.gitignore`, `.env.example`, `CLAUDE.md` and this README — were made on 31 July 2026, before the build window opened. It contains no application code.

**Rehearsal.** A private rehearsal was run on 30–31 July 2026 to de-risk the Prava sandbox integration. It confirmed the real request and response shapes, established that a payment session requires an interactive browser approval step before a credential is issued, and measured policy-compilation latency at 24–30s. **No code from that rehearsal was used here.** The rehearsal repository is private and available to judges on request.

**Documentation PR.** Before the window, a PR correcting four errors in Prava's integration guide was merged into their repository (Prava-Payments/prava-skills#14). No code from it is part of this submission.

**Specification.** The product specification, demo script and Q&A preparation were written before the event.

**Everything else — every line of application code — was written inside the build window (31 July to 2 August 2026 Pacific / 1 to 3 August 2026 India time), and the commit history shows exactly which commits fall where.**
