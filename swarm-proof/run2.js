'use strict';

/**
 * Swarm proof — Run 2. 30 frozen questions, two adjudicator configs compared,
 * every answer judged by two model judges (one 3x, one 1x).
 *
 * Configs (identical draft + identical review for both swarms — the ONLY
 * difference is the adjudicator rule):
 *   weakest-single  qwen2.5:0.5b                          single-shot
 *   best-single     llama3.2:3b                           single-shot
 *   draft-raw       llama3.2:1b                           swarm's raw draft
 *   swarm-free      llama3.2:1b -> qwen2.5:0.5b -> llama3.2:3b (free rewrite)
 *   swarm-fuse      same chain, llama3.2:3b adjudicator in KEEP-OR-FIX mode
 *
 * Judges: llama3.2:3b (3 passes/candidate) and qwen2.5:3b (1 pass/candidate),
 * both blind (question + gold + candidate only, shuffled order).
 *
 * Phase-separated and resumable so long runs survive tool timeouts:
 *   node swarm-proof/run2.js gen            -> checkpoints/gen-qnn.json
 *   node swarm-proof/run2.js judge [limit]  -> checkpoints/judge-qnn.json
 *   node swarm-proof/run2.js report         -> console + results/run2-<ts>.json
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

const GEN_KEYS = ['weakest-single', 'best-single', 'draft-raw', 'swarm-free', 'swarm-fuse'];
const MAX_TOKENS = { draft: 130, review: 120, adjudicator: 140, single: 130, judge: 8 };
const JUDGE_A = MODELS.best; // llama3.2:3b
const JUDGE_B = MODELS.judgeB; // qwen2.5:3b

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
        [protocol.ROLES.CRITIC]: MODELS.weak,
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
    actorId: 'run2',
    action: 'generate_text',
    context: { scope: 'text-only', seed },
    payload: { prompt, seed, maxTokens, ...(sourceReplayHandle ? { sourceReplayHandle } : {}) },
  });
  if (!res.ok) throw new Error(`route refused: ${res.violation} :: ${res.violationReason}`);
  return res;
}

const seedFor = (qi) => 9000 + qi * 101;
const judgeSeedFor = (qi) => 40000 + qi * 101;

function cpGenPath(qi) {
  return path.join(CP_DIR, `gen-q${String(qi + 1).padStart(2, '0')}.json`);
}
function cpJudgePath(qi) {
  return path.join(CP_DIR, `judge-q${String(qi + 1).padStart(2, '0')}.json`);
}
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

async function gen(runtime) {
  for (let qi = 0; qi < QUESTIONS.length; qi += 1) {
    const q = QUESTIONS[qi];
    const cpPath = cpGenPath(qi);
    if (readJson(cpPath)) {
      console.log(`[skip] ${q.id} checkpoint exists`);
      continue;
    }
    const seed = seedFor(qi);
    console.log(`-- [${q.id}] ${q.prompt.slice(0, 40)}...`);

    const weak = await route(runtime, protocol.singlePrompt(q.prompt, MODELS.weak), {
      seed,
      maxTokens: MAX_TOKENS.single,
    }).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));

    const best = await route(runtime, protocol.singlePrompt(q.prompt, MODELS.best), {
      seed,
      maxTokens: MAX_TOKENS.single,
    }).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));
    console.log(`    single weak/best ok (${weak.ms}ms / ${best.ms}ms)`);

    const draft = await route(runtime, protocol.draftPrompt(q.prompt), {
      seed,
      maxTokens: MAX_TOKENS.draft,
    }).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));

    const review = await route(
      runtime,
      protocol.reviewPrompt(q.prompt, draft.text),
      { seed, maxTokens: MAX_TOKENS.review, sourceReplayHandle: draft.requestId },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));
    review.verdict = protocol.parseReviewVerdict(review.text);
    console.log(`    draft/review ok (${draft.ms}ms / ${review.ms}ms, verdict=${review.verdict})`);

    const free = await route(
      runtime,
      protocol.adjudicatorPrompt(q.prompt, draft.text, review.text),
      { seed, maxTokens: MAX_TOKENS.adjudicator, sourceReplayHandle: review.requestId },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));

    const fuse = await route(
      runtime,
      protocol.adjudicatorFusePrompt(q.prompt, draft.text, review.text),
      { seed, maxTokens: MAX_TOKENS.adjudicator, sourceReplayHandle: review.requestId },
    ).then((r) => ({ text: r.result.text, ms: r.result.ms, model: r.result.model, requestId: r.requestId }));
    const fuseKept = fuse.text.trim() === draft.text.trim();
    console.log(`    free/fuse adjud ok (${free.ms}ms / ${fuse.ms}ms, fuseKept=${fuseKept})`);

    fs.writeFileSync(
      cpPath,
      JSON.stringify(
        {
          qid: q.id,
          kind: q.kind,
          prompt: q.prompt,
          gold: q.gold,
          chain: {
            draft: draft.requestId,
            review: review.requestId,
            free: free.requestId,
            fuse: fuse.requestId,
          },
          fuseKept,
          candidates: {
            'weakest-single': { text: weak.text, model: weak.model, ms: weak.ms },
            'best-single': { text: best.text, model: best.model, ms: best.ms },
            'draft-raw': { text: draft.text, model: draft.model, ms: draft.ms },
            'swarm-free': { text: free.text, model: free.model, ms: free.ms },
            'swarm-fuse': { text: fuse.text, model: fuse.model, ms: fuse.ms },
          },
          stages: {
            draft: { model: draft.model, ms: draft.ms },
            review: { model: review.model, ms: review.ms, verdict: review.verdict },
            freeAdj: { model: free.model, ms: free.ms },
            fuseAdj: { model: fuse.model, ms: fuse.ms },
            weakSingle: { model: weak.model, ms: weak.ms },
            bestSingle: { model: best.model, ms: best.ms },
          },
        },
        null,
        2,
      ),
    );
    console.log(`    saved ${path.basename(cpPath)}`);
  }
}

const passPlan = () => [
  { pass: 1, judge: JUDGE_A, offset: 0 },
  { pass: 2, judge: JUDGE_A, offset: 1 },
  { pass: 3, judge: JUDGE_A, offset: 2 },
  { pass: 1, judge: JUDGE_B, offset: 5 },
];

async function judge(runtime, limit) {
  let doneThisCall = 0;
  for (let qi = 0; qi < QUESTIONS.length; qi += 1) {
    const genCfg = readJson(cpGenPath(qi));
    if (!genCfg) {
      console.log(`[warn] no gen checkpoint for q${qi + 1} — run gen first`);
      continue;
    }
    const jPath = cpJudgePath(qi);
    const jDoc = readJson(jPath) || { qid: genCfg.qid, kind: genCfg.kind, candidates: {} };

    for (const key of GEN_KEYS) {
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
        const score = protocol.parseScore(res.result.text);
        rec.scores.push({
          judge: plan.judge,
          pass: plan.pass,
          score,
          raw: res.result.text.trim().slice(0, 60),
          ms: Date.now() - started,
        });
        doneThisCall += 1;
        console.log(
          `      [${genCfg.qid} ${key}] ${plan.judge} pass ${plan.pass} -> ${score ?? 'PARSE_FAIL'} (${Date.now() - started}ms)`,
        );
        fs.writeFileSync(jPath, JSON.stringify(jDoc, null, 2));
        if (limit && doneThisCall >= limit) {
          console.log(`judged ${doneThisCall} this call; run 'judge' again to continue`);
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
  const rows = QUESTIONS.map((q, qi) => ({ gen: readJson(cpGenPath(qi)), jud: readJson(cpJudgePath(qi)) }))
    .filter((r) => r.gen && r.jud);

  const passScores = (key) => rows.flatMap((r) => r.jud.candidates[key].scores.map((s) => s.score).filter((s) => s !== null));
  console.log('SCORE SUMMARY (all judge passes combined):');
  console.log('key               n    mean    sd     min  max');
  for (const key of GEN_KEYS) {
    const ss = passScores(key);
    console.log(
      `${key.padEnd(16)} ${String(ss.length).padEnd(4)} ${mean(ss).toFixed(2).padStart(5)}  ${sd(ss, mean(ss)).toFixed(2).padStart(5)}  ${String(Math.min(...ss)).padStart(3)}  ${String(Math.max(...ss))}`,
    );
  }

  const perQ = (key, judgeFilter) =>
    rows.map((r) => {
      const scores = r.jud.candidates[key].scores
        .filter((s) => !judgeFilter || s.judge === judgeFilter)
        .map((s) => s.score)
        .filter((s) => s !== null);
      return scores.length ? mean(scores) : null;
    }).filter((s) => s !== null);

  function pair(a, b, scoresF) {
    const A = scoresF(a);
    const B = scoresF(b);
    const n = Math.min(A.length, B.length);
    let w = 0, l = 0, t = 0;
    for (let i = 0; i < n; i += 1) {
      if (A[i] > B[i]) w += 1;
      else if (A[i] < B[i]) l += 1;
      else t += 1;
    }
    return `${w}W/${l}L/${t}T`;
  }

  const rivalsAll = ['weakest-single', 'best-single', 'draft-raw', 'swarm-fuse'];
  const rivalsA = ['weakest-single', 'best-single', 'draft-raw', 'swarm-fuse'];

  console.log('\nWIN/LOSS/TIE — swarm-free (mean of ALL judge passes):');
  for (const rival of rivalsAll) {
    console.log(`  swarm-free  vs ${rival.padEnd(15)} ${pair('swarm-free', rival, (k) => perQ(k, null))}`);
  }
  console.log('\nWIN/LOSS/TIE — swarm-fuse (mean of ALL judge passes):');
  for (const rival of ['weakest-single', 'best-single', 'draft-raw', 'swarm-free']) {
    console.log(`  swarm-fuse  vs ${rival.padEnd(15)} ${pair('swarm-fuse', rival, (k) => perQ(k, null))}`);
  }
  console.log('\nWIN/LOSS/TIE — judge-A only (llama3.2:3b, mean of 3):');
  for (const rival of rivalsA) {
    console.log(`  swarm-free  vs ${rival.padEnd(15)} ${pair('swarm-free', rival, (k) => perQ(k, JUDGE_A))}`);
  }
  console.log(`  swarm-fuse  vs best-single ${pair('swarm-fuse', 'best-single', (k) => perQ(k, JUDGE_A))}`);

  console.log('\nJUDGE AGREEMENT:');
  const trips = [];
  for (const r of rows) {
    for (const key of GEN_KEYS) {
      const s = r.jud.candidates[key].scores.filter((x) => x.judge === JUDGE_A).map((x) => x.score);
      if (s.length === 3) trips.push(s);
    }
  }
  const allEqual = trips.filter((t) => t[0] === t[1] && t[1] === t[2]);
  const tripSDs = trips.map((t) => sd(t, mean(t)));
  const tripRanges = trips.map((t) => Math.max(...t) - Math.min(...t));
  console.log(`  judgeA same-answer 3-pass exact agreement: ${allEqual.length}/${trips.length} (${(100 * allEqual.length / trips.length).toFixed(1)}%)`);
  console.log(`  judgeA self SD: mean ${mean(tripSDs).toFixed(2)}  mean range ${mean(tripRanges).toFixed(2)}`);

  const bDiffs = [];
  let winnerAgree = 0;
  let qs = 0;
  for (const r of rows) {
    const bestA = {};
    const bestB = {};
    for (const key of GEN_KEYS) {
      const sA = r.jud.candidates[key].scores.filter((x) => x.judge === JUDGE_A).map((x) => x.score).filter((s) => s !== null);
      const sB = r.jud.candidates[key].scores.filter((x) => x.judge === JUDGE_B).map((x) => x.score).filter((s) => s !== null);
      if (sA.length && sB.length) bDiffs.push(mean(sB) - mean(sA));
      bestA[key] = sA.length ? mean(sA) : null;
      bestB[key] = sB.length ? sB[0] : null;
    }
    const aKey = Object.keys(bestA).filter((k) => bestA[k] !== null).sort((x, y) => bestA[y] - bestA[x])[0];
    const bKey = Object.keys(bestB).filter((k) => bestB[k] !== null).sort((x, y) => bestB[y] - bestB[x])[0];
    qs += 1;
    if (aKey === bKey) winnerAgree += 1;
  }
  const mD = mean(bDiffs);
  console.log(`  judgeA vs judgeB per-candidate score diff (B-A): mean ${mD.toFixed(2)}, sd ${sd(bDiffs, mD).toFixed(2)} (n=${bDiffs.length})`);
  console.log(`  both judges pick the SAME best candidate per question: ${winnerAgree}/${qs}`);

  console.log('\nLATENCY (gen, ms per question, mean +/- sd):');
  for (const key of GEN_KEYS) {
    const xs = rows.map((r) => r.gen.candidates[key].ms);
    console.log(`  ${key.padEnd(16)} ${mean(xs).toFixed(0)} +/- ${sd(xs, mean(xs)).toFixed(0)}`);
  }
  const reviewMs = rows.map((r) => r.gen.stages.review.ms);
  console.log(`  review stage     ${mean(reviewMs).toFixed(0)} +/- ${sd(reviewMs, mean(reviewMs)).toFixed(0)}`);

  const judgeMs = rows.flatMap((r) => Object.values(r.jud.candidates).flatMap((c) => c.scores.map((s) => s.ms)));
  console.log(`\n  judge passes: ${judgeMs.length} total, ${(judgeMs.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s wall, ${mean(judgeMs).toFixed(0)}ms avg`);
  const genTot = rows.reduce(
    (acc, r) => acc + Object.values(r.gen.candidates).reduce((a, c) => a + c.ms, 0) + r.gen.stages.review.ms,
    0,
  );
  console.log(`  gen wall total: ${(genTot / 1000).toFixed(0)}s over ${rows.length} questions`);

  console.log('\nFUSE-MODE behavior:');
  const kept = rows.filter((r) => r.gen.fuseKept);
  const verdicts = {};
  for (const r of rows) {
    const v = r.gen.stages.review.verdict || 'UNPARSEABLE';
    verdicts[v] = (verdicts[v] || 0) + 1;
  }
  console.log(`  review verdicts: ${Object.entries(verdicts).map(([v, n]) => `${v}=${n}`).join(', ')}`);
  console.log(`  fuse kept draft verbatim in ${kept.length}/${rows.length} questions`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, 'results', `run2-${ts}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        notes: { judgeA: JUDGE_A, judgeB: JUDGE_B, passesPerCandidate: { [JUDGE_A]: 3, [JUDGE_B]: 1 } },
        summary: Object.fromEntries(GEN_KEYS.map((k) => [k, { n: passScores(k).length, mean: mean(passScores(k)), sd: sd(passScores(k), mean(passScores(k))) }])),
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
    if (cmd === 'gen' || cmd === 'judge') {
      runtime = new sme.SmeLatticeModule();
      await runtime.initialize({ modules: new Map([['sme-txt', makeRealModule()]]), continuityFloor: 0 });
    }
    if (cmd === 'gen') await gen(runtime);
    else if (cmd === 'judge') await judge(runtime, process.argv[3] ? Number(process.argv[3]) : 0);
    else report();
  } catch (e) {
    console.error('RUN2 FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (runtime) await runtime.shutdown();
  }
})();