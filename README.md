# warrant

Authorization layer for AI purchasing agents

## Disclosure of pre-existing work

A private rehearsal was run on 30 July 2026, before the build window opened, to de-risk the Prava sandbox integration. It confirmed the real request and response shapes, established that a payment session requires an interactive browser approval step before a credential is issued, and measured policy-compilation latency at 24–30s.

No code from that rehearsal was used. Everything in this repository was written during the official build window — 31 July to 2 August 2026 Pacific, which is 1 to 3 August 2026 India time — and the commit history reflects that. The rehearsal repository is private and available to judges on request.

Before the build window, a documentation PR correcting four errors in Prava's integration guide was merged into their repository (Prava-Payments/prava-skills#14). It fixed the sandbox base URL, two field names, and a polling snippet that read the wrong nesting level. No code from that PR is part of this submission.

Also pre-existing: the product specification, demo script and Q&A preparation, written before the event. No application code existed before the build window.
