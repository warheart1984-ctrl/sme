# Swarm proof

Does a swarm of lightweight models out-think a single larger model?
This directory contains a falsifiable experiment against that claim.

## Protocol

- **Run 1 — plumbing** (`../test/swarm-plumbing.test.js`, in the normal `npm test`
  suite): draft -> critic -> adjudicator through the existing lattice harness
  with deterministic stubs. Proves every stage is a governed LRC route carrying
  a full 7-segment LEPR bundle and an LRDM replay handle, that swarm hops record
  their `sourceReplayHandle`, and that refusal envelopes still carry sealed
  evidence. 43/43 tests green.
- **Run 2 — real models** (`run.js`, depends on a local Ollama server):
  same lattice paths, real backends. Judge (llama3.2:3b) is blind: it sees only
  `question + gold + candidate`, candidates are shuffled per question, no label
  is ever passed to the judge. Question set frozen in `questions.json` before
  any model ran.

## Lineup

- `weakest-single`  qwen2.5:0.5b  single-shot
- `best-single`     llama3.2:3b   single-shot
- `draft-raw`       llama3.2:1b   the swarm's raw draft (no critique/adjudicate)
- `swarm-final`     adjudicator(3b) over draft(1b) + critique(0.5b)

Fixed seed per question, temperature = 0, results in `results/`.

## Honest findings (2026-10-06)

| key            | mean (0-10) | pairwise vs swarm-final |
|----------------|-------------|--------------------------|
| weakest-single | 7.8         | swarm 4 wins / 2 losses / 2 ties |
| best-single    | 8.0         | swarm 3 / 3 / 2           |
| draft-raw      | 8.4         | swarm 4 / 1 / 3           |
| swarm-final    | 8.4         | —                         |

1. **Strong claim NOT demonstrated.** swarm-final matched best-single on mean
   (8.4 vs 8.0, 8 questions, n=1 judge pass) and split pairwise 3-3-2. One
   corruption (q1: adjudicator ruined an already-correct draft, 10 -> 4)
   cost it a clear win.
2. **Adjudication reliably improves its own draft** (4-1-3 vs draft-raw) —
   the critic+adjudicator stage mostly lifts quality.
3. **Swarm clearly beats the weakest model** (4-2-2, +0.6 mean).
4. **Latency cost is real**: q1-q8 swarm gate ~50-70s vs ~2-5s best-single
   on this CPU (FX-8350, AVX1). The swarm pays ~15-25x for a marginal gain.

Caveats: single blind-judge pass (judge noise untested), temperature 0 but
Ollama CPU scheduling is not bit-guaranteed, n=8 questions, all questions are
text-reasoning (no VIS/AUD/GEN yet).

## Harness discoveries worth fixing

- `continuityFloor` / `extraCenInvariants` are effectively dead wiring:
  `ConstitutionalOrchestrator.evaluateAndDispatch` never forwards its
  `cenInvariants` to `this.cen.execute()` (cen.js runs with an empty invariant
  set). CRITICAL floors are reported but not enforced.
- LRC bundle `replayEvidence` carries only seeds; full inputs live in the LRDM
  replay record (`runtime.getReplayRecord(requestId).inputs`), not in the
  bundle. Assertions that expect inputs in the bundle will fail.

## Results

`results/run-*.json` contains per-question candidate texts, judge scores, and
the swarm's governed hop chain (draft/critique/adjudicator requestId +
replayHandle).