'use strict';

/**
 * Swarm proof — Run 5. Cheap routing.
 *
 * Same frozen 30q; routed outputs reuse the run-2 judge passes of draft-raw /
 * best-single (llama3.2:3b x3 + qwen2.5:3b x1), so no judging is needed.
 * The only NEW compute is a 1B (llama3.2:1b) critic-with-confidence per
 * question (checkpointed/resumable).
 *
 * Configurations, all shipping EITHER the 1B draft or the 3B best-single
 * answer, never a rewrite:
 *
 *  (a) rules: mechanically-verifiable questions checked by a deterministic
 *      checker against the gold value (times, plain arithmetic, unit
 *      conversion, percentages, series, table-min, multiple choice). Matched
 *      -> ship draft; mismatch -> escalate to 3B. Non-verifiable kinds:
 *      always escalate to 3B (no critic needed at all).
 *
 *  (b) 1b-critic: 1B critic gives FINAL VERDICT + CONFIDENCE 0..1. Ship draft
 *      iff verdict PASS and confidence >= threshold; below threshold escalate
 *      to 3B. Threshold swept {0.0, 0.5, 0.7, 0.8, 0.9, 1.0}. Unresolved
 *      (no/partial markers) escalate (fail-closed).
 *
 *   node swarm-proof/run5.js gen             -> checkpoints/conf-qnn.json
 *   node swarm-proof/run5.js                 -> report (uses run2 checkpoints)
 */

const fs = require('node:fs');
const path = require('node:path');

const sme = require('..');
const ollama = require('./ollama');
const protocol = require('./protocol');

const { MODELS } = protocol;
const CP_DIR = path.join(__dirname, 'checkpoints');
fs.mkdirSync(CP_DIR, { recursive: true });
const QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
).questions;

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const gen2 = (qi) => readJson(path.join(CP_DIR, `gen-q${String(qi + 1).padStart(2, '0')}.json`));
const jud2 = (qi) => readJson(path.join(CP_DIR, `judge-q${String(qi + 1).padStart(2, '0')}.json`));
const confPath = (qi) => path.join(CP_DIR, `conf-q${String(qi + 1).padStart(2, '0')}.json`);
const confRead = (qi) => readJson(confPath(qi));

// ---------------------------------------------------------------------------
// (a) mechanical checker — deterministic, gold-parameterized, kinds only.
//     In deployment the same computation would be the solver (tools), not the
//     gold string; the eval simply measures whether that path matches gold.
// ---------------------------------------------------------------------------

const MECHANICAL = {
  q01: { checker: 'time', expected: [18 * 60], label: '18:00' },
  q04: { checker: 'num', expected: [4] },
  q05: { checker: 'mc', expected: ['effect'] },
  q08: { checker: 'num', expected: [3.5] },
  q09: { checker: 'num', expected: [150] },
  q10: { checker: 'num', expected: [17] },
  q11: { checker: 'frac', expected: [0.125] },
  q12: { checker: 'num', expected: [32] },
  q19: { checker: 'num', expected: [60] },
  q20: { checker: 'mc', expected: ['fewer'] },
  q21: { checker: 'num', expected: [42] },
  q23: { checker: 'num', expected: [2000] },
  q24: { checker: 'mc', expected: ['solar'] },
  q25: { checker: 'num', expected: [15] },
  q26: { checker: 'time', expected: [20 * 60 + 25], label: '20:25 / 8:25pm' },
  q28: { checker: 'num', expected: [9] },
  q30: { checker: 'num', expected: [13] },
};

const NUM_RE = /(\d+(?:\.\d+)?)/g;
const TIME_RE = /(\d{1,2}):(\d{2})\s*(am|pm)?/gi;
const lastTimeMin = (text) => {
  let m;
  let best = null;
  const matches = [...text.matchAll(TIME_RE)];
  for (const mm of matches) {
    let h = Number(mm[1]);
    const min = Number(mm[2]);
    const ap = (mm[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    best = h * 60 + min;
  }
  return best;
};
const lastNumber = (text) => {
  const nums = [...text.matchAll(NUM_RE)].map((m) => Number(m[1]));
  return nums.length ? nums[nums.length - 1] : null;
};

function mechanicalPass(qid, draftText) {
  const spec = MECHANICAL[qid];
  if (!spec) return null; // not mechanically verifiable
  const t = String(draftText);
  if (spec.checker === 'time') {
    const v = lastTimeMin(t);
    return v !== null && v === spec.expected[0];
  }
  if (spec.checker === 'frac') {
    if (/1\s*\/\s*8/.test(t)) return true;
    const v = lastNumber(t);
    return v !== null && Math.abs(v - spec.expected[0]) < 0.01;
  }
  if (spec.checker === 'mc') {
    return spec.expected.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
  }
  const v = lastNumber(t);
  return v !== null && Math.abs(v - spec.expected[0]) < 0.01;
}

// ---------------------------------------------------------------------------
// generation: 1B critic-with-confidence
// ---------------------------------------------------------------------------

function makeRealModule() {
  return {
    async generate({ prompt, maxTokens, temperature, seed }) {
      const { role } = protocol.parseRole(prompt);
      if (!role) return { text: '<no role>', role: 'none', model: null };
      let rest = prompt.slice(prompt.indexOf('>>') + 2).trim();
      let model = null;
      const modelParse = protocol.parseModelTag(rest);
      if (modelParse.model) {
        model = modelParse.model;
        rest = modelParse.rest;
      }
      const modelName = model || MODELS.mid;
      const started = Date.now();
      const text = await ollama.rawGenerate(modelName, rest, {
        temperature: temperature ?? 0,
        seed: seed ?? 0,
        numPredict: maxTokens ?? 160,
      });
      return { text, role, model: modelName, ms: Date.now() - started };
    },
  };
}

async function route(runtime, prompt, { seed, maxTokens } = {}) {
  const res = await runtime.call({
    originNodeId: 'sme-core',
    targetNodeId: 'sme-txt',
    actorId: 'run5',
    action: 'generate_text',
    context: { scope: 'text-only', seed },
    payload: { prompt, seed, maxTokens },
  });
  if (!res.ok) throw new Error(`route refused: ${res.violation} :: ${res.violationReason}`);
  return res;
}

const seedFor = (qi) => 9000 + qi * 101;

const CRITIC_PROMPT =
  (question, draft) =>
    `${protocol.rolePrefix(protocol.ROLES.CRITIC)}` +
    'You are a strict reviewer that also rates your own confidence. Check the draft answer for ' +
    'factual errors, wrong arithmetic, illogical jumps, and missing parts. If you find any concrete ' +
    'error or gap, list the exact errors, then end with:\n' +
    'FINAL VERDICT: FLAG\nCONFIDENCE: 0.80\n' +
    'If the draft is correct, end with:\n' +
    'FINAL VERDICT: PASS\nCONFIDENCE: 0.80\n' +
    'CONFIDENCE is a decimal 0.0 to 1.0 reflecting how sure you are of that verdict.\n\n' +
    `Question: ${question}\n\nDraft answer: ${draft}`;

function parseConfidence(text) {
  const m = String(text).match(/CONFIDENCE:\s*(1(?:\.0+)?|0(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 1 ? v : null;
}

async function gen(runtime) {
  for (const [qi] of QUESTIONS.entries()) {
    const base = gen2(qi);
    if (!base) {
      console.log(`[warn] no run2 gen for q${qi + 1}`);
      continue;
    }
    if (confRead(qi)) {
      console.log(`[skip] ${base.qid} conf exists`);
      continue;
    }
    const seed = seedFor(qi);
    const prompt = CRITIC_PROMPT(base.prompt, base.candidates['draft-raw'].text);
    console.log(`-- [${base.qid}] 1B critic-with-confidence...`);
    const started = Date.now();
    const res = await route(runtime, protocol.withModelTag(prompt, MODELS.mid), {
      seed,
      maxTokens: 160,
    });
    const text = res.result.text;
    const verdict = protocol.parseReviewVerdict(text) || (/\bFLAG\b/.test(text) ? 'FLAG' : /\bPASS\b/.test(text) ? 'PASS' : null);
    const confidence = parseConfidence(text);
    console.log(`    verdict=${verdict} confidence=${confidence} (${Date.now() - started}ms)`);
    fs.writeFileSync(
      confPath(qi),
      JSON.stringify({ qid: base.qid, verdict, confidence, text, ms: Date.now() - started }, null, 2),
    );
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs, m) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
const MARKS = ['llama3.2:3b|1', 'llama3.2:3b|2', 'llama3.2:3b|3', 'qwen2.5:3b|1'];
const scoreOf = (cand, mark) => {
  const hit = cand.scores.find((s) => `${s.judge}|${s.pass}` === mark);
  return hit && hit.score !== null ? hit.score : null;
};
const passScores = (r, key) => MARKS.map((m) => scoreOf(r.j2.candidates[key], m)).filter((s) => s !== null);

function configScores(rows, shipDraftFn) {
  const perQ = rows.map((r) => {
    const shipDraft = shipDraftFn(r);
    const src = shipDraft ? r.j2.candidates['draft-raw'] : r.j2.candidates['best-single'];
    const marks = MARKS.length; // placeholder, replaced below
    const xs = MARKS.map((m) => scoreOf(src, m)).filter((s) => s !== null);
    return { shipDraft, xs };
  });
  const all = perQ.flatMap((p) => p.xs);
  const meanQ = perQ.map((p) => (p.xs.length ? mean(p.xs) : null)).filter((x) => x !== null);
  return { all, meanQ, escalated: perQ.filter((p) => !p.shipDraft).length };
}

function WLT(a, b) {
  const n = Math.min(a.length, b.length);
  let w = 0, l = 0, t = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i] > b[i]) w += 1;
    else if (a[i] < b[i]) l += 1;
    else t += 1;
  }
  return `${w}W/${l}L/${t}T`;
}

function report() {
  const rows = QUESTIONS.map((q, qi) => ({
    qid: q.id,
    q,
    draftText: gen2(qi).candidates['draft-raw'].text,
    bestText: gen2(qi).candidates['best-single'].text,
    j2: jud2(qi),
    draftMs: gen2(qi).candidates['draft-raw'].ms,
    bestMs: gen2(qi).candidates['best-single'].ms,
    critMs: confRead(qi) ? confRead(qi).ms : null,
    critVerdict: confRead(qi) ? confRead(qi).verdict : null,
    critConf: confRead(qi) ? confRead(qi).confidence : null,
    mechanical: MECHANICAL[q.id] ? mechanicalPass(q.id, gen2(qi).candidates['draft-raw'].text) : null,
  })).filter((r) => r.j2);

  const bestCfg = configScores(rows, () => false);
  const draftCfg = configScores(rows, () => true);

  // (a) rules
  const rulesCfg = configScores(rows, (r) =>
    r.mechanical === true ? true : false, // mechanical-pass ships draft; else escalate
  );

  console.log('CONFIG SCORES (4 judge passes, mean+/-sd):');
  function row(label, cfg) {
    console.log(
      `${label.padEnd(16)} n=${String(cfg.all.length).padEnd(4)} mean=${mean(cfg.all).toFixed(2).padStart(5)} sd=${sd(cfg.all, mean(cfg.all)).toFixed(2).padStart(5)}  escalated=${cfg.escalated}/30`,
    );
  }
  row('always-3B', bestCfg);
  row('1B draft only', draftCfg);
  row('rules (a)', rulesCfg);

  console.log('\n(a) MECHANICAL ROUTER (17 verifiable q, 13 auto-escalated):');
  const mechRows = rows.filter((r) => r.qid in MECHANICAL);
  const mechMatch = mechRows.filter((r) => r.mechanical === true);
  const mechMiss = mechRows.filter((r) => r.mechanical === false || r.mechanical === null);
  console.log(`  verifiable: ${mechRows.length}, draft matched gold: ${mechMatch.length}, mismatch->3B: ${mechMiss.length}`);
  if (mechMiss.length) {
    console.log(`  mismatched: ${mechMiss.map((r) => r.qid).join(', ')}`);
  }
  const nonMech = rows.filter((r) => !(r.qid in MECHANICAL));
  console.log(`  non-verifiable kinds (always 3B): ${nonMech.length}  (${nonMech.map((r) => r.qid).join(', ')})`);

  console.log('\nWIN/LOSS/TIE (per-question mean of 4 passes):');
  console.log(`  rules   vs best-single ${WLT(rulesCfg.meanQ, bestCfg.meanQ)}`);
  console.log(`  rules   vs draft-raw   ${WLT(rulesCfg.meanQ, draftCfg.meanQ)}`);

  console.log('\n(b) 1B-CRITIC-WITH-CONFIDENCE (verdict/confidence from 1B):');
  const thresholds = [0.0, 0.5, 0.7, 0.8, 0.9, 1.0];
  console.log('threshold  escalate/fail-closed  mean    sd     vs best-single   vs draft-raw   critPASS');
  const sweep = {};
  for (const thr of thresholds) {
    const cfg = configScores(rows, (r) => {
      if (r.critVerdict !== 'PASS') return false;
      if (r.critConf === null || r.critConf < thr) return false;
      return true;
    });
    sweep[thr] = cfg;
    console.log(
      `${String(thr).padEnd(9)} ${String(cfg.escalated).padEnd(20)} ${mean(cfg.all).toFixed(2).padStart(5)}  ${sd(cfg.all, mean(cfg.all)).toFixed(2).padStart(5)}  ${WLT(cfg.meanQ, bestCfg.meanQ).padStart(18)}  ${WLT(cfg.meanQ, draftCfg.meanQ).padStart(18)}  `,
    );
  }
  const critBreakdown = {};
  for (const r of rows) {
    const v = r.critVerdict || 'UNRESOLVED';
    critBreakdown[v] = (critBreakdown[v] || 0) + 1;
  }
  console.log(` 1B critic verdicts: ${Object.entries(critBreakdown).map(([v, n]) => `${v}=${n}`).join('  ')}`);
  const confs = rows.map((r) => r.critConf).filter((c) => c !== null);
  console.log(` confidence parsed: ${confs.length}/30, mean ${mean(confs).toFixed(2)} (unparsed -> escalate)`);

  console.log('\nLATENCY (gen ms per question, mean +/- sd; wall):');
  const wall = (xs) => `${mean(xs).toFixed(0)} +/- ${sd(xs, mean(xs)).toFixed(0)}   (${(xs.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s wall)`;
  const bestMsAll = rows.map((r) => r.bestMs);
  const draftMsAll = rows.map((r) => r.draftMs);
  const critMsAll = rows.map((r) => r.critMs).filter((x) => x !== null);
  console.log(`  always-3B            ${wall(bestMsAll)}`);
  console.log(`  1B draft gen         ${wall(draftMsAll)}`);
  console.log(`  1B critic gen        ${wall(critMsAll)}`);
  const rulesEsc = rows.filter((r) => !(r.mechanical === true));
  console.log(`  rules policy         draft(${mean(draftMsAll).toFixed(0)}) + 0 critic + 3B-on-${rulesEsc.length} (${(rulesEsc.length * mean(bestMsAll)).toFixed(0)}ms avg) = ${(mean(draftMsAll) + (rulesEsc.length / 30) * mean(bestMsAll)).toFixed(0)}ms avg`);
  const esc1b = rows.filter((r) => !(r.critVerdict === 'PASS' && (r.critConf ?? 0) >= 0.8));
  console.log(`  1b-critic thr=0.8    draft(${mean(draftMsAll).toFixed(0)}) + critic(${mean(critMsAll).toFixed(0)}) + 3B-on-${esc1b.length} = ${(mean(draftMsAll) + mean(critMsAll) + (esc1b.length / 30) * mean(bestMsAll)).toFixed(0)}ms avg`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, 'results', `run5-${ts}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        rules: { escalated: rulesCfg.escalated, mean: mean(rulesCfg.all), sd: sd(rulesCfg.all, mean(rulesCfg.all)) },
        sweeps: Object.fromEntries(
          thresholds.map((t) => [t, { escalated: sweep[t].escalated, mean: mean(sweep[t].all), sd: sd(sweep[t].all, mean(sweep[t].all)) }]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`report -> ${outPath}`);
}

(async () => {
  const cmd = process.argv[2] || 'report';
  let runtime = null;
  try {
    if (cmd === 'gen') {
      runtime = new sme.SmeLatticeModule();
      await runtime.initialize({ modules: new Map([['sme-txt', makeRealModule()]]), continuityFloor: 0 });
      await gen(runtime);
    } else {
      report();
    }
  } catch (e) {
    console.error('RUN5 FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (runtime) await runtime.shutdown();
  }
})();