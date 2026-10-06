# Swarm proof — findings summary (Runs 1–5)

**Question:** does a swarm of lightweight local models beat a single larger model?
Five runs on a fixed, frozen evaluation. Honest answer from this box (AMD FX-8350,
CPU-only Ollama): **no, not on this question set — but the routing layer that the
swarm requires is the one thing that held up.**

All runs use `test/swarm-plumbing.test.js` + the run scripts in this directory:
every stage (draft, critic, adjudicator, judge) is a governed LRC route through
the SME lattice with its own LEPR bundle and LRDM replay handle. The lattice
plumbing itself never failed a run.

## Method

- **Question set**: 30 questions frozen in `questions.json` before any run-2
  generation (runs 2+); run 1 used an earlier 8-question subset. Kinds: arithmetic,
  time/unit conversion, probability, logic (incl. non-monotonic), analogies,
  geography, grammar, science, graph-reading, summary.
- **Models (Ollama, temp 0, per-question seeds)**: draft `llama3.2:1b`,
  weak critic `qwen2.5:0.5b`, `llama3.2:3b`, `qwen2.5:3b`.
- **Judging**: blind — judge sees only `question + gold + candidate`, candidates
  shuffled per question, config label never passed. Runs 2-5 use **4 pass/pass:
  llama3.2:3b x3 + qwen2.5:3b x1**. Note judges are themselves 3B models, so the
  "heaviest" member of the eval is not independent of the "best-single" contestant.

Configs tested (all 30q except run 1):
- `weakest-single` qwen2.5:0.5b single-shot
- `best-single` llama3.2:3b single-shot
- `draft-raw` llama3.2:1b single-shot
- `swarm-free` 1b draft -> critic -> 3b adjudicator, free rewrite
- `swarm-fuse` same chain, 3b adjudicator under "keep-or-fix" rule
- `routed` (run 4) 1b draft -> critic; PASS ships draft, FLAG ships best-single, no rewrite
- rules / 1b-critic (run 5) cheap routers

## Scores (all 4 judge passes, runs 2–5)

| config | n | mean | sd | vs best-single | escalated to 3B |
|---|---|---|---|---|---|
| **routed (run 4)** | 119 | **8.82** | 1.73 | 3W/3L/24T | 19/30 |
| **best-single (3B)** | 118 | **8.81** | 1.75 | — | 30/30 |
| draft-raw (1B) | 119 | 8.62 | 2.07 | — | 0/30 |
| swarm-fuse (0.5c) | 118 | 8.57 | 2.21 | 9W/11L/10T | — |
| swarm-free (0.5c) | 118 | 8.53 | 2.32 | 10W/10L/10T | — |
| rules (run 5a) | 119 | 8.71 | 1.96 | 4W/5L/21T | 16/30 |
| 1b-critic thr>=0.8 (run 5b) | 119 | 8.73 | 1.94 | 2W/2L/26T | 22/30 |
| swarm-free-3c (run 3) | 119 | 8.29 | 2.49 | 8W/12L/10T | — |
| swarm-fuse-3c (run 3) | 119 | 8.17 | 2.46 | 7W/16L/7T | — |
| weakest-single (0.5B) | 119 | 6.73 | 3.55 | — | — |

Run-1 (8q, single 3b judge): weakest 7.8, best 8.0, draft 8.4, swarm-free 8.4 —
the swarm tied best-single and beat weakest.

## What failed, and why

1. **Adjudicator rewrites destroy value.** Every config that let the 3B adjudicator
   rewrite a draft scored at or below the raw draft (free-3c 8.29, fuse-3c 8.17
   vs draft 8.62). On FLAG'd questions the rewrite made the answer *worse* more
   often than better (run 3: 10 better / 16 worse). Examples:
   - q02 syllogism — correct draft ("does not follow", 9.0) rewritten into the
     wrong "therefore it follows" (5.5).
   - q05 grammar — correct "effect" (8.8) rewritten to wrong "affect" (5.3).
   - q26 time math — correct "8:25 pm" (9.8) rewritten to bogus "10:00 pm" (6.3).
   The rewrite stage re-derives under pressure and loses the thread. Removing it
   (routed) was the single biggest quality improvement.
2. **Critic false positives (and false negatives).**
   - 0.5B critic: PASS 29/30 — it never fails anything, so fuse degenerated to
     "keep draft" (fuse vs draft 1W/1L/28T). No signal.
   - 3B critic: FLAG 14/30 (plus 5 prose-critical without a marker) — but it
     flagged *correct* drafts (q02, q05, q26 above) and invented errors (q12
     "multiplication order", q21 series rule). False-positive FLAGs fed the bad
     rewrites.
   - 1B critic: robust protocol failure — 40% compliance (12/30 unresolved
     markers), hallucinated critiques (q16: "ice is denser than water"), and
     confidence uncalibrated (copied example 0.8 or wrote 0).
3. **The 1B is slower than the 3B on this hardware.** Short answers: 3B single
   ~1.9s/question; 1B draft gen ~27.9s; 1B critic ~30.6s. On a CPU box with
   slow llama1B token throughput and short answer lengths, "cheap 1B member"
   is false — the 3B single-shot is the cheapest bottleneck-winning path. This
   inverts the swarm's economic premise for this machine.
4. **Judge noise is large.** Same-answer 3-pass exact agreement of judge A: 44%;
   mean within-answer range ~1.0 on 0-10; judge B (qwen) runs ~0.45 points
   harsher (sd 2.58); the two judges picked the same best candidate only 19/30.
   Sub-1-point config differences are not distinguishable — which is exactly why
   the 1-pass run-1 result was misleading.
5. **The strong claim is not demonstrated.** swarm > best-single never held on
   either the 8q or 30q set. Best observationally is `routed` = `best-single`
   at 3W/3L/24T — statistically indistinguishable.

## What held up

1. **Routing, not rewriting.** `routed` (PASS->ship draft, FLAG->ship 3B single)
   scored highest (8.82), equal-tie with always-3B with fewer 3B generations
   (19/30 instead of 30/30), and beat both rewrite swarm configs. The lesson is
   negative-but-robust: **unreviewed release forms as "don't let a rewrite stage
   exist"; escalate to the best member instead of merging members.**
2. **Deterministic mechanical checks (run 5a).** For the 17 mechanically
   verifiable questions, an O(1) checker against a solver/gold caught the
   draft's final value exactly 14/17; the 3 mismatches (q01, q09, q21) escalated.
   Rules scored 8.71 with 53% 3B usage and pays zero model-router cost. This is
   the genuinely cheap signal — no predictive model involved.
3. **The lattice harness.** All fleets ran clean: allowed/refused routes, sealed
   evidence, replay determinism (43/43 tests). Two real bugs found along the way:
   `continuityFloor`/`extraCenInvariants` are not forwarded to `cen.execute`
   (reported-not-enforced), and LEPR `replayEvidence` carries only seeds (full
   inputs live in the LRDM record, not the bundle).

## Latency (gen ms/question, run-2 measurements)

| path | per-question cost |
|---|---|
| always-3B single-shot | 1.9s (57s wall for 30q) |
| routed | 32.1s (draft 27.9 + critic 3.1 + escalate) — 963s wall |
| rules | ~28.9s (draft + 3B on 16 q) |
| 1b-critic thr>=0.8 | ~59.9s (draft + 1b critic + 3B on 22 q) |

On this box always-3B is both higher-quality *and* cheaper. Every pipeline that
starts with a 1B draft generation pays ~28s/q for the privilege.

## Conditions where a swarm could still win

The failure modes above are hardware- and question-shape-specific. A swarm is
plausibly better when ANY of:

1. **The best single is genuinely expensive** — long answers (summaries, essays,
   code), long contexts, or a shared/slow big model. Then a 1B draft + cheap
   check beats "generate everything with the 3B". The local CPU flips this; a
   GPU or serving box flips it back.
2. **A cheaper router exists** — a fast small model *on the serving hardware*,
   or better, rule-based/tool-based verification the way run 5a did. The router
   must be cheaper than the marginal 3B generation it gates; on this box the 1B
   was not.
3. **Heterogeneous membership with a non-merge protocol.** A number-crunching
   member + a prose member + a verifier, where PASS/FAIL routes to the right
   specialist but **never lets one member rewrite another's correct answer**
   (routed's insight generalized).
4. **Hallucination-dominant error regimes** — self-consistency (majority vote of
   K independent samples) is a cheaper anti-hallucination device than a rewrite.
5. **Judge-quality work**: 4-pass, 2-model blind judging (as done here) is the
   only way to see a 0.3-point effect; single-pass evaluation will misattribute.

## Reproduce

- Plumbing tests: `npm test` (43/43).
- Cold-started per question; results in `checkpoints/` and `results/run{1-5}-*.json`.
- Run scripts: `run.js` (run 1), `run2.js gen|judge|report`, `run3.js gen|judge|report`,
  `run4.js report` (read-only), `run5.js gen|report`. Requires a local Ollama with
  `qwen2.5:0.5b`, `llama3.2:1b`, `llama3.2:3b`, `qwen2.5:3b`. CPU sampling is
  temperature-0 + seeded but not bit-deterministic.