'use strict';

/**
 * Swarm proof — Run 4. "Route, don't rewrite."
 * Pure read-only analysis over run-2 + run-3 checkpoints; no generation, no judging.
 *
 * Policy per question (same frozen 30q, critic = llama3.2:3b):
 *   draft(1b) -> 3b critic review
 *     review PASS  -> ship the draft as-is
 *     review FLAG  -> ship best-single's own 3B answer as-is (no rewriting)
 *     review unresolved (no PASS/FLAG marker) -> escalate to 3B (fail-closed)
 *
 * Scores reuse the identical 4 judge passes (llama3.2:3b x3, qwen2.5:3b x1)
 * already recorded for draft-raw and best-single in run 2.
 *
 *   node swarm-proof/run4.js
 */

const fs = require('node:fs');
const path = require('node:path');

const CP_DIR = path.join(__dirname, 'checkpoints');
const QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
).questions;

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const gen2 = (qi) => readJson(path.join(CP_DIR, `gen-q${String(qi + 1).padStart(2, '0')}.json`));
const jud2 = (qi) => readJson(path.join(CP_DIR, `judge-q${String(qi + 1).padStart(2, '0')}.json`));
const gen3 = (qi) => readJson(path.join(CP_DIR, `gen3-q${String(qi + 1).padStart(2, '0')}.json`));
const jud3 = (qi) => readJson(path.join(CP_DIR, `judge3-q${String(qi + 1).padStart(2, '0')}.json`));

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs, m) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;

const MARKS = ['llama3.2:3b|1', 'llama3.2:3b|2', 'llama3.2:3b|3', 'qwen2.5:3b|1'];
const scoreOf = (cand, mark) => {
  const hit = cand.scores.find((s) => `${s.judge}|${s.pass}` === mark);
  return hit && hit.score !== null ? hit.score : null;
};

const rows = QUESTIONS.map((q, qi) => {
  const g2 = gen2(qi);
  const j2 = jud2(qi);
  const g3 = gen3(qi);
  const j3 = jud3(qi);
  const verdict = (g3 && (g3.stages.review.verdictLenient || g3.stages.review.verdict)) || null;
  const escalate = verdict !== 'PASS';
  return {
    q,
    g2,
    j2,
    g3,
    j3,
    verdict,
    escalate,
    draftText: g2.candidates['draft-raw'].text,
    bestText: g2.candidates['best-single'].text,
    free3Text: g3.candidates['swarm-free-3c'].text,
    fuse3Text: g3.candidates['swarm-fuse-3c'].text,
    reviewText: g3.stages.review.text,
  };
}).filter((r) => r.g2 && r.j2 && r.g3 && r.j3);

function candidatePassScores(r, key) {
  const src = key.endsWith('3c') ? r.j3.candidates[key] : r.j2.candidates[key];
  return MARKS.map((m) => scoreOf(src, m)).filter((s) => s !== null);
}

const routedPassScores = rows.flatMap((r) => {
  const src = r.escalate ? r.j2.candidates['best-single'] : r.j2.candidates['draft-raw'];
  return MARKS.map((m) => scoreOf(src, m)).filter((s) => s !== null);
});

const perQ = (key) =>
  rows.map((r) => {
    const xs = candidatePassScores(r, key);
    return xs.length ? mean(xs) : null;
  }).filter((s) => s !== null);

const perQRouted = rows
  .map((r) => {
    const src = r.escalate ? r.j2.candidates['best-single'] : r.j2.candidates['draft-raw'];
    const xs = MARKS.map((m) => scoreOf(src, m)).filter((s) => s !== null);
    return xs.length ? mean(xs) : null;
  })
  .filter((s) => s !== null);

function pair(a, b) {
  const n = Math.min(a.length, b.length);
  let w = 0, l = 0, t = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i] > b[i]) w += 1;
    else if (a[i] < b[i]) l += 1;
    else t += 1;
  }
  return `${w}W/${l}L/${t}T`;
}

console.log('SCORE SUMMARY (all 4 judge passes):');
console.log('config            n    mean    sd      min  max');
const summary = { routed: routedPassScores };
for (const key of ['routed', 'best-single', 'draft-raw', 'swarm-free-3c']) {
  const ss = key === 'routed' ? routedPassScores : candidatePassScoresAll(key);
  summary[key] = ss;
  console.log(
    `${key.padEnd(15)} ${String(ss.length).padEnd(5)} ${mean(ss).toFixed(2).padStart(5)}  ${sd(ss, mean(ss)).toFixed(2).padStart(5)}  ${String(Math.min(...ss)).padStart(3)}   ${String(Math.max(...ss))}`,
  );
}

function candidatePassScoresAll(key) {
  return rows.flatMap((r) => candidatePassScores(r, key));
}

console.log('\nWIN/LOSS/TIE (per-question mean over 4 passes):');
console.log(`  routed        vs best-single ${pair(perQRouted, perQ('best-single'))}`);
console.log(`  routed        vs draft-raw   ${pair(perQRouted, perQ('draft-raw'))}`);
console.log(`  routed        vs free-3c     ${pair(perQRouted, perQ('swarm-free-3c'))}`);

const flaggedQs = rows.filter((r) => r.verdict === 'FLAG');
const unresolved = rows.filter((r) => r.verdict === null);
const passed = rows.filter((r) => r.verdict === 'PASS');
console.log('\nESCALATION (route to 3B):');
console.log(`  of 30 questions: PASS ${passed.length} -> draft shipped`);
console.log(`                   FLAG ${flaggedQs.length} + unresolved ${unresolved.length} = ${rows.filter((r) => r.escalate).length} -> 3B answer shipped (63%)`);
console.log(`  vs always-running-3B: would run 3B on 30/30 (100%)`);

console.log('\nLATENCY (gen ms per question, mean +/- sd; policy cost):');
const draftMs = rows.map((r) => r.g2.candidates['draft-raw'].ms);
const reviewMs = rows.map((r) => r.g3.stages.review.ms);
const bestMs = rows.map((r) => r.g2.candidates['best-single'].ms);
const policyMs = rows.map((r) => r.g2.candidates['draft-raw'].ms + r.g3.stages.review.ms + (r.escalate ? r.g2.candidates['best-single'].ms : 0));
console.log(`  draft(1b)               ${mean(draftMs).toFixed(0)} +/- ${sd(draftMs, mean(draftMs)).toFixed(0)}`);
console.log(`  3b critic review        ${mean(reviewMs).toFixed(0)} +/- ${sd(reviewMs, mean(reviewMs)).toFixed(0)}`);
console.log(`  best-single 3B (used on escalate) ${mean(bestMs).toFixed(0)} +/- ${sd(bestMs, mean(bestMs)).toFixed(0)}`);
console.log(`  ROUTE policy total      ${mean(policyMs).toFixed(0)} +/- ${sd(policyMs, mean(policyMs)).toFixed(0)}  (wall ${(policyMs.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s)`);
console.log(`  ALWAYS-3B total         ${mean(bestMs).toFixed(0)} +/- ${sd(bestMs, mean(bestMs)).toFixed(0)}  (wall ${(bestMs.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s)`);
console.log('  note: in this harness the router IS a 3B, so routing does not save 3B-time on PASS;');
console.log('  it saves the earlier run-3 chain by skipping the adjudicator entirely.');

console.log('\n3 EXAMPLES — adjudicator rewrite made a FLAG\'d draft WORSE:');
const worsened = rows
  .filter((r) => r.verdict === 'FLAG')
  .map((r) => {
    const d = candidatePassScores(r, 'draft-raw');
    const f = candidatePassScores(r, 'swarm-free-3c');
    const b = candidatePassScores(r, 'best-single');
    return {
      r,
      delta: mean(d) - mean(f),
      draftMean: mean(d),
      free3Mean: mean(f),
      fuse3Mean: mean(candidatePassScores(r, 'swarm-fuse-3c')),
      bestMean: mean(b),
    };
  })
  .filter((x) => x.free3Mean < x.draftMean)
  .sort((a, b) => b.delta - a.delta);

for (const ex of worsened.slice(0, 3)) {
  const r = ex.r;
  console.log(`\n  --- ${r.q.id} (${r.q.kind}) | draft->free3 rewrite: ${ex.draftMean.toFixed(1)} -> ${ex.free3Mean.toFixed(1)} (delta ${ex.delta.toFixed(1)}) ---`);
  console.log(`  Q: ${r.q.prompt}`);
  console.log(`  GOLD: ${r.q.gold}`);
  console.log(`  DRAFT(${ex.draftMean.toFixed(1)}): ${r.draftText.slice(0, 220)}`);
  console.log(`  3B critique: ${r.reviewText.slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log(`  ADJ-REWRITE(${ex.free3Mean.toFixed(1)}): ${r.free3Text.slice(0, 220)}`);
  console.log(`  BEST-3B(${ex.bestMean.toFixed(1)}): ${r.bestText.slice(0, 160)}`);
  console.log(`  (fuse-3c=${ex.fuse3Mean.toFixed(1)}; routed here would ship 3B at ${ex.bestMean.toFixed(1)})`);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(__dirname, 'results', `run4-${ts}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      policy: 'route, don\'t rewrite: PASS->draft, FLAG|unresolved->best-single (3B)',
      escalated: rows.filter((r) => r.escalate).length,
      routedScore: { n: summary.routed.length, mean: mean(summary.routed), sd: sd(summary.routed, mean(summary.routed)) },
      bestScore: { n: summary['best-single'].length, mean: mean(summary['best-single']), sd: sd(summary['best-single'], mean(summary['best-single'])) },
      draftScore: { n: summary['draft-raw'].length, mean: mean(summary['draft-raw']), sd: sd(summary['draft-raw'], mean(summary['draft-raw'])) },
    },
    null,
    2,
  ),
);
console.log(`\nreport -> ${outPath}`);