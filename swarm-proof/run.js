'use strict';

/**
 * Swarm proof — Run 2: real models.
 *
 * Question: does a swarm of lightweights beat a heavy single shot?
 *
 * Candidates judged blind per question (judge sees only:
 *   question + gold + candidate — never a config label):
 *   weakest-single  qwen2.5:0.5b  single-shot
 *   best-single     llama3.2:3b   single-shot
 *   draft-raw       llama3.2:1b   the swarm's raw draft (no critique/adjudicate)
 *   swarm-final     adjudicator over llama3.2:1b draft + qwen2.5:0.5b critique
 *
 * Every stage — including judge calls — is a governed LRC route with a full
 * LEPR bundle and LRDM replay handle. Results written to
 * swarm-proof/results/run-<timestamp>.json.
 *
 * Usage: node swarm-proof/run.js
 */

const fs = require('node:fs');
const path = require('node:path');

const sme = require('..');
const ollama = require('./ollama');
const protocol = require('./protocol');

const { MODELS } = protocol;

const QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
).questions;

const MAX_TOKENS = { draft: 130, critic: 150, adjudicator: 140, single: 130, judge: 32 };

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
  const payload = { prompt, seed, maxTokens };
  if (sourceReplayHandle) payload.sourceReplayHandle = sourceReplayHandle;
  const res = await runtime.call({
    originNodeId: 'sme-core',
    targetNodeId: 'sme-txt',
    actorId: 'swarm-proof',
    action: 'generate_text',
    context: { scope: 'text-only', seed },
    payload,
  });
  if (!res.ok) {
    throw new Error(`route refused: ${res.violation} :: ${res.violationReason}`);
  }
  return res;
}

const seedFor = (qIndex) => 9000 + qIndex * 101;

function judgeCandidate(runtime, q, candidate, seed) {
  const prompt =
    `${protocol.rolePrefix(protocol.ROLES.SINGLE)}${protocol.modelTag(MODELS.best)}\n\n` +
    protocol.judgePrompt(q.prompt, q.gold, candidate);
  return route(runtime, prompt, { seed: seed + 13, maxTokens: MAX_TOKENS.judge });
}

function parseJudgeScores(result) {
  const score = protocol.parseScore(result.result.text);
  return { score, raw: result.result.text.trim() };
}

function shuffle(keys) {
  const arr = [...keys];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function fmt(n) {
  return Number.isNaN(n) ? '  -  ' : n.toFixed(1);
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log('== SME swarm proof — real run ==');
  console.log(`models: weak=${MODELS.weak} mid=${MODELS.mid} best=${MODELS.best}`);
  console.log(`candidates: weakest-single, best-single, draft-raw, swarm-final`);
  console.log(`judge model: ${MODELS.best} (blind: q+gold+candidate only, shuffled order)`);
  console.log(`questions: ${QUESTIONS.length}`);
  console.log('');

  const runtime = new sme.SmeLatticeModule();
  await runtime.initialize({ modules: new Map([['sme-txt', makeRealModule()]]), continuityFloor: 0 });

  const results = { startedAt, config: { models: MODELS, temperature: 0 }, questions: [] };
  let swarmChain = null;

  try {
    for (let qi = 0; qi < QUESTIONS.length; qi += 1) {
      const q = QUESTIONS[qi];
      const seed = seedFor(qi);
      console.log(`-- [${q.id}] ${q.prompt.slice(0, 48)}...`);

      const weak = await route(
        runtime,
        protocol.singlePrompt(q.prompt, MODELS.weak),
        { seed, maxTokens: MAX_TOKENS.single },
      );
      console.log(`    weakest-single ${MODELS.weak} ${weak.result.ms}ms`);

      const best = await route(
        runtime,
        protocol.singlePrompt(q.prompt, MODELS.best),
        { seed, maxTokens: MAX_TOKENS.single },
      );
      console.log(`    best-single    ${MODELS.best} ${best.result.ms}ms`);

      const draft = await route(runtime, protocol.draftPrompt(q.prompt), {
        seed,
        maxTokens: MAX_TOKENS.draft,
      });
      console.log(`    draft          ${MODELS.mid} ${draft.result.ms}ms`);

      const critique = await route(
        runtime,
        protocol.criticPrompt(q.prompt, draft.result.text),
        { seed, maxTokens: MAX_TOKENS.critic, sourceReplayHandle: draft.requestId },
      );
      console.log(`    critique       ${MODELS.weak} ${critique.result.ms}ms`);

      const adjud = await route(
        runtime,
        protocol.adjudicatorPrompt(q.prompt, draft.result.text, critique.result.text),
        { seed, maxTokens: MAX_TOKENS.adjudicator, sourceReplayHandle: critique.requestId },
      );
      console.log(`    adjudicator    ${MODELS.best} ${adjud.result.ms}ms`);

      if (!swarmChain) {
        swarmChain = {
          qid: q.id,
          draft: { requestId: draft.requestId, replayHandle: draft.replayHandle },
          critique: { requestId: critique.requestId, replayHandle: critique.replayHandle },
          adjudicator: { requestId: adjud.requestId, replayHandle: adjud.replayHandle },
        };
      }

      const candidates = {
        'weakest-single': weak.result.text,
        'best-single': best.result.text,
        'draft-raw': draft.result.text,
        'swarm-final': adjud.result.text,
      };

      const order = shuffle(Object.keys(candidates));
      const scores = {};
      for (const key of order) {
        const judgeRes = await judgeCandidate(runtime, q, candidates[key], seed);
        const { score, raw } = parseJudgeScores(judgeRes);
        scores[key] = { score, judgeRaw: raw };
        console.log(`    judge[${key}] score=${score ?? 'PARSE_FAIL'}`);
      }

      results.questions.push({
        id: q.id,
        prompt: q.prompt,
        gold: q.gold,
        candidates: Object.fromEntries(
          Object.entries(candidates).map(([k, text]) => [k, { text, score: scores[k].score }]),
        ),
        swarmChain: {
          draft: draft.requestId,
          critique: critique.requestId,
          adjudicator: adjud.requestId,
        },
      });
    }
  } finally {
    await runtime.shutdown();
  }

  results.swarmChain = swarmChain;

  const keys = ['weakest-single', 'best-single', 'draft-raw', 'swarm-final'];
  const perQuestion = results.questions.map((q) =>
    Object.fromEntries(keys.map((k) => [k, q.candidates[k]?.score ?? null])),
  );

  console.log('');
  console.log('SCORES (blind LLM judge, 0-10):');
  console.log('key             ' + QUESTIONS.map((q) => q.id.padStart(4)).join('') + '   mean');
  for (const k of keys) {
    const scores = perQuestion.map((row) => row[k]);
    console.log(
      `${k.padEnd(16)}` + scores.map((s) => (s === null ? '  -  ' : String(s).padStart(4))).join('') + `   ${fmt(mean(scores))}`,
    );
  }

  const judgeMean = (k) => {
    const vals = results.questions.map((q) => q.candidates[k]?.score).filter((s) => s !== null);
    return { n: vals.length, mean: mean(vals) };
  };

  function pair(winner, loser) {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let missing = 0;
    for (const row of perQuestion) {
      const a = row[winner];
      const b = row[loser];
      if (a === null || b === null) { missing += 1; continue; }
      if (a > b) wins += 1;
      else if (a < b) losses += 1;
      else ties += 1;
    }
    return { wins, losses, ties, missing };
  }

  const sums = Object.fromEntries(keys.map((k) => [k, judgeMean(k)]));

  console.log('');
  console.log('AGGREGATE (mean over scored questions):');
  for (const k of keys) {
    console.log(`  ${k.padEnd(16)} n=${sums[k].n}  mean=${fmt(sums[k].mean)}`);
  }

  console.log('');
  console.log('PAIRWISE (vs swarm-final):');
  for (const rival of ['weakest-single', 'best-single', 'draft-raw']) {
    const p = pair('swarm-final', rival);
    console.log(
      `  swarm vs ${rival.padEnd(15)} win=${p.wins} lose=${p.losses} tie=${p.ties} missing=${p.missing}`,
    );
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `run-${startedAt.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(
    path.join(outDir, fileName),
    JSON.stringify(
      { ...results, aggregate: sums, pairwise: Object.fromEntries(['weakest-single', 'best-single', 'draft-raw'].map((r) => [r, pair('swarm-final', r)])) },
      null,
      2,
    ),
  );
  console.log(`\nresults -> ${path.join('swarm-proof', 'results', fileName)}`);
}

main().catch((error) => {
  console.error('\nRUN FAILED:', error);
  process.exitCode = 1;
});