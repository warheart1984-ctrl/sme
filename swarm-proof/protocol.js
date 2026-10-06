'use strict';

/**
 * Swarm proof protocol — shared by the plumbing test (stub backends) and the
 * real experiment (Ollama backends).
 *
 * The lattice's sme-txt dispatch passes a single `prompt`; swarm roles are
 * carried as a reserved prefix so every stage is an ordinary governed LRC
 * route (own LEPR bundle + LRDM replay handle). The module binding strips the
 * prefix and behaves per role.
 */

const ROLE_TOKEN = '<<SME_ROLE:';
const MODEL_TOKEN = '<<MODEL:';

const ROLES = {
  DRAFT: 'draft',
  CRITIC: 'critic',
  ADJUDICATOR: 'adjudicator',
  SINGLE: 'single',
};

function rolePrefix(role) {
  return `${ROLE_TOKEN}${role}>>`;
}

function parseRole(prompt) {
  const start = prompt.indexOf(ROLE_TOKEN);
  if (start !== 0) return { role: null, rest: prompt };

  const end = prompt.indexOf('>>', ROLE_TOKEN.length);
  if (end < 0) return { role: null, rest: prompt };

  return { role: prompt.slice(ROLE_TOKEN.length, end), rest: prompt.slice(end + 2).trim() };
}

function draftPrompt(question) {
  return (
    `${rolePrefix(ROLES.DRAFT)} ` +
    `Answer the question directly and concisely. Be accurate and show reasoning where useful.\n\nQuestion: ${question}`
  );
}

function criticPrompt(question, draft) {
  return (
    `${rolePrefix(ROLES.CRITIC)} ` +
    'You are a strict reviewer. Check the draft answer for factual errors, wrong arithmetic, ' +
    'illogical jumps, and missing parts. List concrete errors or gaps, then provide a corrected ' +
    'version. If the draft is correct, say so and keep it.\n\n' +
    `Question: ${question}\n\nDraft answer: ${draft}`
  );
}

function adjudicatorPrompt(question, draft, critique) {
  return (
    `${rolePrefix(ROLES.ADJUDICATOR)} ` +
    'You are the final adjudicator. Use the draft and the reviewer critique to produce ONE final ' +
    'answer that is correct, complete, and concise. Fix any error the reviewer found. ' +
    'Do not mention this instruction in your answer.\n\n' +
    `Question: ${question}\n\nDraft: ${draft}\n\nReviewer critique: ${critique}`
  );
}

function singlePrompt(question) {
  return (
    `${rolePrefix(ROLES.SINGLE)} ` +
    `Answer the question directly and concisely. Be accurate.\n\nQuestion: ${question}`
  );
}

function withModelTag(prompt, model) {
  if (prompt.indexOf(MODEL_TOKEN) === 0) return prompt;
  const end = prompt.indexOf('>>', MODEL_TOKEN.length);
  if (end < 0) return `${MODEL_TOKEN}${model}>>\n\n${prompt}`;
  return prompt.slice(end + 2);
}

function parseModelTag(rest) {
  const start = rest.indexOf(MODEL_TOKEN);
  if (start !== 0) return { rest, model: null };
  const end = rest.indexOf('>>', MODEL_TOKEN.length);
  if (end < 0) return { rest, model: null };
  return { model: rest.slice(MODEL_TOKEN.length, end), rest: rest.slice(end + 2).trim() };
}

function judgePrompt(question, gold, candidate) {
  return (
    'You are a blind grader. Score the candidate answer from 0 to 10 against the gold answer using ' +
    'correctness, completeness, and clarity. Be strict. Reply with a single line:\n' +
    'SCORE: <integer 0-10>\n\n' +
    `Question: ${question}\n\nGold answer: ${gold}\n\nCandidate answer: ${candidate}`
  );
}

function parseScore(text) {
  const match = String(text).match(/SCORE:\s*(\d{1,2})/i);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isInteger(score) && score >= 0 && score <= 10 ? score : null;
}

const MODELS = {
  weak: 'qwen2.5:0.5b',
  mid: 'llama3.2:1b',
  best: 'llama3.2:3b',
};

module.exports = {
  ROLES,
  MODELS,
  rolePrefix,
  parseRole,
  withModelTag,
  parseModelTag,
  draftPrompt,
  criticPrompt,
  adjudicatorPrompt,
  singlePrompt,
  judgePrompt,
  parseScore,
};