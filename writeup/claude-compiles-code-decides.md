# Claude compiles, code decides

An agent that can spend money has to be authorized, not trusted. Those are different properties and the difference is the whole problem.

Trust is a disposition. Authorization is a fact about a system: this action was permitted, by this rule, which this human ratified at this time, and here is the record. You can audit the second one. You cannot audit a disposition.

The two obvious approaches fail in opposite directions.

**Human approves everything.** Correct and useless. If a person confirms every purchase, the agent is a form with extra steps, and the approver stops reading by the fortieth request — which is worse than not approving at all, because now there's a signature on it.

**Hand the agent a credential.** Fast and unbounded. The agent's judgement becomes the only control, which means the control surface is a model's inference at runtime — an artifact you cannot enumerate, cannot diff, and cannot test. When it goes wrong you don't get a policy violation you can point at. You get a plausible purchase nobody authorized.

What's needed sits between: a human states intent once, in language; the system converts that into something enforceable; and enforcement is deterministic and citable back to the human's words.

I built [Warrant](https://github.com/rmanish2000-del/warrant) to see whether that boundary could be structural rather than procedural.

## The model compiles, and flags rather than guessing

You write a spending policy in plain English. Claude compiles it into numbered clauses. Where the policy is genuinely ambiguous, it **flags** instead of resolving.

Here is the demo policy, four sentences:

> Buy only from approved suppliers — PackRight Supplies. Don't exceed ₹15,000 per week. Any order above ₹5,000 requires my approval. Never buy from a new supplier without approval.

That reads as complete. It compiles to four clauses and three flags. The flags, verbatim from the compiler output:

**F1 — clauses 1 and 4.** *"When a purchase is attempted from a supplier that is not on the approved list, should the request be denied outright or escalated to you for a decision?"*

Sentence 1 describes a closed list. Sentence 4 says the list is extensible with approval. Both cannot hold.

**F2 — clauses 2 and 3.** *"If you have already approved an order under the ₹5,000 per-order rule, but that order would push weekly spending past the ₹15,000 cumulative cap, should the cap deny it or should it come back to you?"*

Does approval override a cap, or does a cap override approval? Nothing in four sentences says.

**F3 — clauses 3 and 4.** *"When an order is both from a new supplier and above the ₹5,000 threshold, which clause should be cited as the reason approval is being requested?"*

F3 is the one I'd point at. Both branches escalate — the *decision* is identical either way. What differs is which clause gets named as the reason. The compiler is flagging an ambiguity in the explanation, not in the outcome.

Now the part that makes flags more than a prompt trick. Each answer writes a structured key into the warrant:

```
F1 → { "C1.onUnapprovedSupplier": "deny" | "escalate" }
F2 → { "C2.onCapBreachDespiteApproval": "deny" | "escalate" }
F3 → { "C4.whenNewSupplierAboveThreshold": "cite_C3" | "cite_C4" }
```

The human's answer does not become another English sentence for a model to re-read later. It becomes a field the evaluator reads. And confirmation is blocked while any flag is unanswered — that confirmation is the moment a draft becomes enforceable. Validity is stamped by the system, never by the model.

A model asked to produce enforceable rules from that policy will produce them. It will pick a resolution for each conflict, and every pick will be defensible. None will be the human's. That's the failure you can't detect downstream, because a wrong-but-plausible compilation looks exactly like success — it enforces confidently, and it enforces something nobody chose.

A model that refuses to resolve ambiguity is more useful here than one that resolves it well.

## The boundary is a type

The obvious implementation keeps the clause text around and lets the evaluator consult it. Then a sentence a model wrote is an input to a runtime authorization decision, and the safeguard is a convention — *don't read the text field* — which holds until someone is debugging at 2am.

Instead, `src/engine/types.ts`:

```typescript
/**
 * What the evaluator is allowed to see: structured constraint fields and
 * system-stamped validity only. `clauses` (English text) is typed out of
 * reach — "Claude compiles, code decides" is enforced at the type boundary,
 * not by discipline.
 */
export type EvaluableWarrant = Omit<Warrant, 'clauses'>;
```

And the only function that returns a verdict, `src/engine/evaluate.ts`:

```typescript
export function evaluate(
  warrant: EvaluableWarrant,
  ledger: readonly LedgerEntry[],
  proposal: Proposal,
  at: number,
): Verdict {
```

That's the entire trust boundary. One `Omit`.

The clause English still exists — the human reads it, and the decision cites it. It is simply not in scope where verdicts are produced. Passing a `Warrant` where an `EvaluableWarrant` is expected doesn't get flagged in review; it fails to compile.

I want to be precise about what this does and doesn't buy. It does not make the compilation correct — a badly compiled predicate is still a badly compiled predicate. What it removes is an entire category of failure: model-written prose influencing a runtime decision through some path nobody intended. Convention is a promise about future behaviour. A type is a fact about the current build. Only one survives a deadline.

## Which makes decisions testable

Deterministic decisions are reproducible, and reproducible decisions can be pinned — including the negatives, which are the ones that matter.

**139 tests across 41 suites, 139 passing.** Two are the point.

The first asserts that a DENY makes zero outbound calls. The second forces a human approval onto an already-denied decision and still asserts zero outbound calls.

That second test exists because approval is the obvious hole. Deny-then-approve is the shape of most authorization bypasses, and a system where a human's approval can resurrect a denial has a control that holds only while everyone behaves. A test makes it hold while nobody is watching.

The hero of the demo is a refusal: a proposal under every spending limit, denied anyway, because the supplier isn't approved — citing the exact clause the human confirmed minutes earlier. Not "the model considered this risky." Clause 1, in the human's own words.

## Limits

**Sandbox only.** Every payment action is a Prava sandbox session. No real money moves.

**Demo-grade security.** A local single-operator console bound to 127.0.0.1. Not a hardened service, and not presented as one.

**ALLOW is not wired to the provider.** Only the human-approved escalation path opens a payment session. An allowed purchase is authorized and recorded, not executed.

**Spend counts at authorization, not settlement — deliberately.** A session that lapses after approval still consumes headroom. That is the correct direction of error for a cap: counting only settlements would let an agent open ten sessions concurrently and blow past the limit while all are in flight. Over-counting costs headroom. Under-counting costs the cap. Each exported decision carries a `spendStatus` (`hold` / `settled` / `not-counted`) so a reconciliation could later release expired holds by *appending* release entries. That reconciliation is not built, and this is the disclosure of it.

The record is hash-chained and append-only — each entry's hash covers its content plus the previous entry's. That makes it tamper-evident. It is deliberately not called "signed": there are no digital signatures here, and it claims no non-repudiation.

## The generalisable part

Warrant is a demo. The boundary isn't.

Language models are very good at two things this problem needs: reading intent out of how people actually write, and explaining a decision back in terms the person recognises. They are structurally wrong for a third — being the thing that decides, at runtime, in a system that has to be accountable. Not because they're unreliable, but because their output isn't enumerable. You cannot diff an inference. You cannot write a test that pins what a model will conclude next Tuesday.

So put the model on both ends and keep it out of the middle. Interpretation at the front, where a human ratifies before anything binds. Explanation at the back, where being wrong costs nothing already decided. Between them, an evaluator whose input type makes model output structurally unable to reach a verdict.

Claude compiles. Code decides. The engineering is in making that a type error rather than a team norm.

