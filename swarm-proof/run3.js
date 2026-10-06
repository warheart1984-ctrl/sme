'use strict';

/**
 * Swarm proof — Run 3. Critic upgrade baseline comparison.
 *
 * Run-2 baseline configs (kept, already judged): critic = qwen2.5:0.5b
 * Run-3 configs (this file): critic = llama3.2:3b
 *
 * Same frozen 30 questions, same draft (llama3.2:1b), same adjudicator
 * (llama3.2:3b), same two adjudicator rules (free / fuse). The singles
 * (weakest-single, best-single, draft-raw) are REUSED from run-2 checkpoints —
 * no re-generation or re-judging.
 *
 * Reuses the run-2 judge rig: each answer judged by llama3.2:3b x3 and
 * qwen2.5:3b x1, blind, frozen question set.
 *
 *   node swarm-proof/run3.js gen            -> checkpoints/gen3-qnn.json
 *   node swarm-proof/run3.js judge [limit]  -> checkpoints/judge3-qnn.json
 *   node swarm-proof/run3.js report         -> console + results/run3-<ts>.json
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

const CRITIC_3 = MODELS.best; // llama3.2:3b
const CRITIC_BASE = MODELS.weak; // qwen2.5:0.5b (from run 2)
const NEW_KEYS = ['swarm-free-3c', 'swarm-fuse-3c'];
const MAX_TOKENS = { draft: 130, review: 140, adjudicator: 140, judge: 8 };
const JUDGE_A = MODELS.best;
const JUDGE_B = MODELS.judgeB;

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
      const modelName = model || {
        [protocol.ROLES.DRAFT]: MODELS.mid,
        [protocol.ROLES.CRITIC]: MODELS.best,
        [protocol.ROLES.ADJUDICATOR]: MODELS.best,
        [protocol.ROLES.SINGLE]: MODELS.mid,
      }[role];
      const started = Date.now();
      const text = await ollama.rawGenerate(modelName, rest, {
        temperature: temperature ?? 0,
        seed: seed ?? 0,
        numPredict: maxTokens ?? 128,
      });
      return { text, role, model: modelName, ms: Date.now() - started };
    },
  };
}

async function route(runtime, prompt, { seed, maxTokens, sourceReplayHandle } = {}) {
  const res = await runtime.call({
    originNodeId: 'sme-core',
    targetNodeId: 'sme-txt',
    actorId: 'run3',
    action: 'generate_text',
    context: { scope: 'text-only', seed },
    payload: { prompt, seed, maxTokens, ...(sourceReplayHandle ? { sourceReplayHandle } : {}) },
  });
  if (!res.ok) throw new Error(`route refused: ${res.violation} :: ${res.violationReason}`);
  return res;
}

const seedFor = (qi) => 9000 + qi * 101;
const judgeSeedFor = (qi) => 40000 + qi * 101;

function cp2Gen(qi) {
  return readJson(path.join(CP_DIR, `gen-q${String(qi + 1).padStart(2, '0')}.json`));
}
function cp3Gen(qi) {
  return readJson(path.join(CP_DIR, `gen3-q${String(qi + 1).padStart(2, '0')}.json`));
}
function cp3Judge(qi) {
  return readJson(path.join(CP_DIR, `judge3-q${String(qi + 1).padStart(2, '0')}.json`));
}
function cp2Judge(qi) {
  return readJson(path.join(CP_DIR, `judge-q${String(qi + 1).padStart(2, '0')}.json`));
}
function p3Gen(qi) {
  return path.join(CP_DIR, `gen3-q${String(qi + 1).padStart(2, '0')}.json`);
}
function p3Judge(qi) {
  return path.join(CP_DIR, `judge3-q${String(qi + 1).padStart(2, '0')}.json`);
}
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

function reviewVerdict(text) {
  const strict = protocol.parseReviewVerdict(text);
  if (strict) return { verdict: strict, lenient: strict };
  const t = String(text);
  if (/\bFLAG\b/.test(t)) return { verdict: null, lenient: 'FLAG' };
  if (/\bPASS\b/.test(t)) return { verdict: null, lenient: 'PASS' };
  return { verdict: null, lenient: null };
}

async function gen(runtime) {
  for (let qi = 0; qi < QUESTIONS.length; qi += 1) {
    const q = QUESTIONS[qi];
    const base = cp2Gen(qi);
    if (!base) {
      console.log(`[warn] no run2 gen for ${q.id} — run run2 gen first`);
      continue;
    }
    if (cp3Gen(qi)) {
      console.log(`[skip] ${q.id} gen3 exists`);
      continue;
    }
    const seed = seedFor(qi);
    console.log(`-- [${q.id}] ${q.prompt.slice(0, 40)}...`);

    const review = await route(
      runtime,
      protocol.reviewPrompt(q.prompt, base.candidates['draft-raw'].text),
      { seed, maxTokens: MAX_TOKENS.review, sourceReplayHandle: base.chain.draft },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));
    const rv = reviewVerdict(review.text);
    review.verdict = rv.verdict;
    review.verdictLenient = rv.lenient;
    console.log(`    review3 (${CRITIC_3}) ${review.ms}ms verdict=${review.verdict} lenient=${review.verdictLenient}`);

    const free = await route(
      runtime,
      protocol.adjudicatorPrompt(q.prompt, base.candidates['draft-raw'].text, review.text),
      { seed, maxTokens: MAX_TOKENS.adjudicator, sourceReplayHandle: review.requestId },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));

    const fuse = await route(
      runtime,
      protocol.adjudicatorFusePrompt(q.prompt, base.candidates['draft-raw'].text, review.text),
      { seed, maxTokens: MAX_TOKENS.adjudicator, sourceReplayHandle: review.requestId },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));
    const fuseKept = fuse.text.trim() === base.candidates['draft-raw'].text.trim();
    console.log(`    free3/fuse3 ok (${free.ms}ms / ${fuse.ms}ms, fuseKept=${fuseKept})`);

    fs.writeFileSync(
      p3Gen(qi),
      JSON.stringify(
        {
          qid: q.id,
          kind: q.kind,
          prompt: q.prompt,
          gold: q.gold,
          critic: CRITIC_3,
          criticBase: CRITIC_BASE,
          fuseKept,
          chain: { review: review.requestId, free: free.requestId, fuse: fuse.requestId },
          candidates: {
            'swarm-free-3c': { text: free.text, model: free.model, ms: free.ms },
            'swarm-fuse-3c': { text: fuse.text, model: fuse.model, ms: fuse.ms },
          },
          stages: {
            review: { model: review.model, ms: review.ms, verdict: review.verdict, verdictLenient: review.verdictLenient, text: review.text },
            freeAdj: { model: free.model, ms: free.ms },
            fuseAdj: { model: fuse.model, ms: fuse.ms },
          },
          baseReviewVerdict: base.stages.review.verdict,
        },
        null,
        2,
      ),
    );
    console.log(`    saved gen3-${q.id}.json`);
  }
}

const passPlan = () => [
  { pass: 1, judge: JUDGE_A, offset: 0 },
  { pass: 2, judge: JUDGE_A, offset: 1 },
  { pass: 3, judge: JUDGE_A, offset: 2 },
  { pass: 1, judge: JUDGE_B, offset: 5 },
];

async function judge(runtime, limit) {
  let done = 0;
  for (let qi = 0; qi < QUESTIONS.length; qi += 1) {
    const genCfg = cp3Gen(qi);
    if (!genCfg) {
      console.log(`[warn] no gen3 checkpoint for q${qi + 1}`);
      continue;
    }
    const jPath = p3Judge(qi);
    const jDoc = cp3Judge(qi) || { qid: genCfg.qid, kind: genCfg.kind, candidates: {} };
    for (const key of NEW_KEYS) {
      if (!jDoc.candidates[key]) jDoc.candidates[key] = { scores: [] };
      const rec = jDoc.candidates[key];
      const existing = new Set(rec.scores.map((s) => `${s.judge}|${s.pass}`));
      for (const plan of passPlan()) {
        const mark = `${plan.judge}|${plan.pass}`;
        if (existing.has(mark)) continue;
        const prompt =
          `${protocol.rolePrefix(protocol.ROLES.SINGLE)}${protocol.modelTag(plan.judge)}\n\n` +
          protocol.judgePrompt(genCfg.prompt, genCfg.gold, genCfg.candidates[key].text);
        const started = Date.now();
        const res = await route(runtime, prompt, {
          seed: judgeSeedFor(qi) + plan.offset,
          maxTokens: MAX_TOKENS.judge,
        });
        rec.scores.push({
          judge: plan.judge,
          pass: plan.pass,
          score: protocol.parseScore(res.result.text),
          raw: res.result.text.trim().slice(0, 60),
          ms: Date.now() - started,
        });
        fs.writeFileSync(jPath, JSON.stringify(jDoc, null, 2));
        done += 1;
        console.log(`  [${genCfg.qid} ${key}] ${plan.judge} p${plan.pass} -> ${protocol.parseScore(res.result.text) ?? 'PF'} (${Date.now() - started}ms)`);
        if (limit && done >= limit) {
          console.log(`judged ${done} this call; rerun to continue`);
          return;
        }
      }
    }
  }
  console.log('judging complete');
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs, m) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;

function report() {
  const rows = QUESTIONS.map((q, qi) => ({
    q,
    baseGen: cp2Gen(qi),
    baseJudge: cp2Judge(qi),
    gen3: cp3Gen(qi),
    judge3: cp3Judge(qi),
  })).filter((r) => r.baseGen && r.baseJudge && r.gen3 && r.judge3);

  const ALL = ['weakest-single', 'best-single', 'draft-raw', 'swarm-free', 'swarm-fuse', 'swarm-free-3c', 'swarm-fuse-3c'];
  const passScores = (key) =>
    (key.includes('3c') ? rows.flatMap((r) => r.judge3.candidates[key].scores) : rows.flatMap((r) => r.baseJudge.candidates[key].scores))
      .map((s) => s.score)
      .filter((s) => s !== null);

  console.log('SCORE SUMMARY (all judge passes combined):');
  console.log('key               n    mean    sd     min  max');
  for (const key of ALL) {
    const ss = passScores(key);
    console.log(
      `${key.padEnd(16)} ${String(ss.length).padEnd(4)} ${mean(ss).toFixed(2).padStart(5)}  ${sd(ss, mean(ss)).toFixed(2).padStart(5)}  ${String(Math.min(...ss)).padStart(3)}  ${String(Math.max(...ss))}`,
    );
  }

  const perQ = (key) =>
    rows.map((r) => {
      const src = key.includes('3c') ? r.judge3.candidates[key].scores : r.baseJudge.candidates[key].scores;
      const s = src.map((x) => x.score).filter((x) => x !== null);
      return s.length ? mean(s) : null;
    }).filter((s) => s !== null);

  function pair(a, b) {
    const A = perQ(a);
    const B = perQ(b);
    const n = Math.min(A.length, B.length);
    let w = 0, l = 0, t = 0;
    for (let i = 0; i < n; i += 1) {
      if (A[i] > B[i]) w += 1;
      else if (A[i] < B[i]) l += 1;
      else t += 1;
    }
    return `${w}W/${l}L/${t}T`;
  }

  console.log('\nWIN/LOSS/TIE (per-question mean over all 4 judge passes):');
  for (const rival of ['weakest-single', 'best-single', 'draft-raw', 'swarm-free', 'swarm-fuse']) {
    console.log(`  swarm-free-3c vs ${rival.padEnd(15)} ${pair('swarm-free-3c', rival)}`);
  }
  for (const rival of ['weakest-single', 'best-single', 'draft-raw', 'swarm-free-3c']) {
    console.log(`  swarm-fuse-3c vs ${rival.padEnd(15)} ${pair('swarm-fuse-3c', rival)}`);
  }

  // Per-pass comparison final vs draft (same judge+seed) -> "FAIL led to better?"
  function passCompare(finalKey, draftKey) {
    const marks = ['llama3.2:3b|1', 'llama3.2:3b|2', 'llama3.2:3b|3', 'qwen2.5:3b|1'];
    let better = 0, worse = 0, tie = 0, n = 0;
    for (const r of rows) {
      for (const m of marks) {
        const f = finalKey.includes('3c') ? r.judge3.candidates[finalKey].scores : r.baseJudge.candidates[finalKey].scores;
        const d = r.baseJudge.candidates[draftKey].scores;
        const fsx = f.find((s) => `${s.judge}|${s.pass}` === m);
        const dsx = d.find((s) => `${s.judge}|${s.pass}` === m);
        if (!fsx || !dsx || fsx.score === null || dsx.score === null) continue;
        n += 1;
        if (fsx.score > dsx.score) better += 1;
        else if (fsx.score < dsx.score) worse += 1;
        else tie += 1;
      }
    }
    return { better, worse, tie, n };
  }

  function verdictSets() {
    const flagged = [];
    const passed = [];
    const unparsed = [];
    for (const r of rows) {
      const v = r.gen3.stages.review.verdictLenient || r.gen3.stages.review.verdict;
      if (v === 'FLAG') flagged.push(r);
      else if (v === 'PASS') passed.push(r);
      else unparsed.push(r);
    }
    return { flagged, passed, unparsed };
  }

  console.log('\nCRITIC FAIL RATE (verdict=FLAG, frozen q set n=30):');
  const baseSets = { flagged: [], passed: [], unparsed: [] };
  for (const r of rows) {
    const v = r.baseGen.stages.review.verdict;
    if (v === 'FLAG') baseSets.flagged.push(r);
    else if (v === 'PASS') baseSets.passed.push(r);
    else baseSets.unparsed.push(r);
  }
  console.log(`  0.5b critic: strict FLAG ${baseSets.flagged.length} / PASS ${baseSets.passed.length} / unparseable ${baseSets.unparsed.length}`);
  const crit3 = verdictSets();
  const c3strict = rows.filter((r) => r.gen3.stages.review.verdict === 'FLAG').length;
  console.log(`  3b critic:   lenient FLAG ${crit3.flagged.length} / PASS ${crit3.passed.length} / unparseable ${crit3.unparsed.length} (strict-marker FLAG ${c3strict})`);

  console.log('\nFAIL -> final answer impact (same judge pass, pairwise):');
  const cmpFree3 = passCompare('swarm-free-3c', 'draft-raw');
  const cmpFuse3 = passCompare('swarm-fuse-3c', 'draft-raw');
  const cmpFree0 = passCompare('swarm-free', 'draft-raw');
  const cmpFuse0 = passCompare('swarm-fuse', 'draft-raw');
  console.log(`  free-3c  vs draft: better ${cmpFree3.better} / worse ${cmpFree3.worse} / tie ${cmpFree3.tie}  (n=${cmpFree3.n})`);
  console.log(`  fuse-3c  vs draft: better ${cmpFuse3.better} / worse ${cmpFuse3.worse} / tie ${cmpFuse3.tie}  (n=${cmpFuse3.n})`);
  console.log(`  free-0c  vs draft: better ${cmpFree0.better} / worse ${cmpFree0.worse} / tie ${cmpFree0.tie}  (n=${cmpFree0.n})`);
  console.log(`  fuse-0c  vs draft: better ${cmpFuse0.better} / worse ${cmpFuse0.worse} / tie ${cmpFuse0.tie}  (n=${cmpFuse0.n})`);

  console.log('\nFLAG-subset analysis (3b critic; drafts the critic rejected):');
  const flag5b = rows.filter((r) => (r.gen3.stages.review.verdictLenient || r.gen3.stages.review.verdict) === 'FLAG');
  if (flag5b.length) {
    let b = 0, w = 0, t = 0, n = 0;
    for (const r of flag5b) {
      const d = r.baseJudge.candidates['draft-raw'].scores;
      const f = r.judge3.candidates['swarm-free-3c'].scores;
      for (const dx of d) {
        const fx = f.find((s) => s.judge === dx.judge && s.pass === dx.pass);
        if (!fx || dx.score === null || fx.score === null) continue;
        n += 1;
        if (fx.score > dx.score) b += 1;
        else if (fx.score < dx.score) w += 1;
        else t += 1;
      }
    }
    console.log(`  on FLAG questions, free-3c vs draft: better ${b} / worse ${w} / tie ${t}  (n=${n})`);
  } else {
    console.log('  (no FLAGs)');
  }

  console.log('\nFUSE behavior under 3b critic:');
  console.log(`  fuse kept draft verbatim: ${rows.filter((r) => r.gen3.fuseKept).length}/${rows.length}`);
  console.log(`  (run2 baseline fuse kept 26/30 under 0.5b critic)`);

  console.log('\nLATENCY (gen ms per question, mean +/- sd):');
  const stages = [
    ['draft (1b, shared)', 'baseGen.candidates.draft-raw.ms'],
    ['review 0.5b', 'baseGen.stages.review.ms'],
    ['review 3b', 'gen3.stages.review.ms'],
    ['adj free 3b (0.5c)', 'baseGen.candidates.swarm-free.ms'],
    ['adj free 3b (3c)', 'gen3.stages.freeAdj.ms'],
    ['adj fuse 3b (0.5c)', 'baseGen.candidates.swarm-fuse.ms'],
    ['adj fuse 3b (3c)', 'gen3.stages.fuseAdj.ms'],
  ];
  const get = (r, path) => path.split('.').reduce((o, k) => o && o[k], r);
  for (const [label, p] of stages) {
    const xs = rows.map((r) => get(r, p)).filter((x) => typeof x === 'number');
    console.log(`  ${label.padEnd(20)} ${mean(xs).toFixed(0)} +/- ${sd(xs, mean(xs)).toFixed(0)}`);
  }

  const total3 = rows.reduce(
    (acc, r) => acc + r.gen3.stages.review.ms + r.gen3.stages.freeAdj.ms + r.gen3.stages.fuseAdj.ms,
    0,
  );
  const total0 = rows.reduce(
    (acc, r) => acc + r.baseGen.stages.review.ms + r.baseGen.candidates['swarm-free'].ms + r.baseGen.candidates['swarm-fuse'].ms,
    0,
  );
  console.log(`\n  swarm chain wall: 0.5c=${(total0 / 1000).toFixed(0)}s, 3c=${(total3 / 1000).toFixed(0)}s`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, 'results', `run3-${ts}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ critic3: CRITIC_3, critic0: CRITIC_BASE, notes: { judgeA: JUDGE_A, judgeB: JUDGE_B } }, null, 2));
  console.log(`report -> ${outPath}`);
}

(async () => {
  const cmd = process.argv[2] || 'report';
  let runtime = null;
  try {
    if (cmd === 'gen' || cmd === 'judge') {
      runtime = new sme.SmeLatticeModule();
      await runtime.initialize({ modules: new Map([['sme-txt', makeRealModule()]]), continuityFloor: 0 });
    }
    if (cmd === 'gen') await gen(runtime);
    else if (cmd === 'judge') await judge(runtime, process.argv[3] ? Number(process.argv[3]) : 0);
    else report();
  } catch (e) {
    console.error('RUN3 FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (runtime) await runtime.shutdown();
  }
})();