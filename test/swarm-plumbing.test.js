'use strict';

/**
 * Swarm proof — Run 1: plumbing.
 * Proves the draft -> critic -> adjudicator swarm flows through the existing
 * lattice harness with STUB backends: routing works, every stage carries a
 * full LEPR evidence bundle, and LRDM replay verifies deterministically.
 * No models, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const sme = require('..');
const {
  ROLES,
  parseRole,
  draftPrompt,
  criticPrompt,
  adjudicatorPrompt,
  singlePrompt,
} = require('../swarm-proof/protocol');

const hash8 = (input) => createHash('sha256').update(String(input)).digest('hex').slice(0, 8);

const stubModule = {
  generate: async ({ prompt, seed }) => {
    const { role } = parseRole(prompt);
    const h = hash8(`${prompt}|${seed ?? 'noseed'}`);
    switch (role) {
      case ROLES.DRAFT:
        return { text: `DRAFT(${h}) role=draft`, role, model: 'stub' };
      case ROLES.CRITIC:
        return { text: `CRITIC flags=none hash=${h}`, role, model: 'stub' };
      case ROLES.ADJUDICATOR:
        return { text: `FINAL ok hash=${h}`, role, model: 'stub' };
      default:
        return { text: `SINGLE(${h})`, role: role ?? 'single', model: 'stub' };
    }
  },
};

function bind(runtime, module = stubModule) {
  return runtime.initialize({
    modules: new Map([['sme-txt', module]]),
    continuityFloor: 0,
  });
}

function seeded(questionIndex, seedOffset = 1000) {
  return seedOffset + questionIndex;
}

describe('swarm proof plumbing', () => {
  it('routes a draft stage with full LEPR bundle and replay handle', async () => {
    const runtime = new sme.SmeLatticeModule();
    await bind(runtime);
    try {
      const seed = seeded(0);
      const res = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload: { prompt: draftPrompt('A train leaves at 2:15 pm and arrives 3h45m later.'), seed },
      });

      assert.equal(res.ok, true, `route should allow: ${res.violationReason}`);
      assert.equal(res.nodeId, 'sme-txt');
      assert.ok(res.evidence, 'evidence bundle required');
      assert.match(res.replayHandle, /^[a-f0-9]{64}$/);

      const ev = res.evidence;
      assert.deepEqual(
        Object.keys(ev.segments).sort(),
        [
          'auditEvidence',
          'authorityEvidence',
          'decisionEvidence',
          'outputEvidence',
          'replayEvidence',
          'validationEvidence',
          'verificationEvidence',
        ].sort(),
        'all seven LEPR segments present',
      );
      assert.ok(ev.bundleHash, 'bundle hash sealed');

      const record = runtime.getReplayRecord(res.requestId);
      assert.ok(record, 'LRDM replay record stored');
      assert.equal(record.recordHash(), res.replayHandle, 'replayHandle is the record hash');

      const recordedOutput = ev.segments.outputEvidence;
      assert.match(recordedOutput.text, /^DRAFT\(/, 'draft output recorded in evidence');
    } finally {
      await runtime.shutdown();
    }
  });

  it('chains critic and adjudicator stages with source replay handles in evidence', async () => {
    const runtime = new sme.SmeLatticeModule();
    await bind(runtime);
    try {
      const q = 'A baker has 12 eggs. Each cake needs 3 eggs. How many cakes, and how many eggs remain?';
      const seed = seeded(1);

      const draftRes = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload: { prompt: draftPrompt(q), seed },
      });
      assert.equal(draftRes.ok, true);

      const criticRes = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload: {
          prompt: criticPrompt(q, draftRes.result.text),
          sourceReplayHandle: draftRes.requestId,
          seed,
        },
      });
      assert.equal(criticRes.ok, true);
      const criticRecord = runtime.getReplayRecord(criticRes.requestId);
      assert.ok(criticRecord, 'critic replay record stored');
      assert.equal(
        criticRecord.inputs.sourceReplayHandle,
        draftRes.requestId,
        'critic replay record logs the draft stage requestId it consumed',
      );
      assert.match(criticRes.result.text, /^CRITIC/, 'critic output produced');

      const adjudicatorRes = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload: {
          prompt: adjudicatorPrompt(q, draftRes.result.text, criticRes.result.text),
          sourceReplayHandle: criticRes.requestId,
          seed,
        },
      });
      assert.equal(adjudicatorRes.ok, true);
      assert.match(adjudicatorRes.result.text, /^FINAL/, 'adjudicator produced the merged final');
      const adjudicatorRecord = runtime.getReplayRecord(adjudicatorRes.requestId);
      assert.ok(adjudicatorRecord, 'adjudicator replay record stored');
      assert.equal(
        adjudicatorRecord.inputs.sourceReplayHandle,
        criticRes.requestId,
        'adjudicator replay record chains back to the critic',
      );

      const hops = adjudicatorRes.evidence.hops;
      assert.ok(hops.length > 0 && hops.every((h) => h.nodeId === 'sme-txt'), 'hop chain recorded');
    } finally {
      await runtime.shutdown();
    }
  });

  it('replays a routed swarm stage deterministically', async () => {
    const runtime = new sme.SmeLatticeModule();
    await bind(runtime);
    try {
      const seed = seeded(2);
      const payload = { prompt: singlePrompt('What is the capital of Iceland?'), seed };

      const first = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload,
      });
      const second = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'generate_text',
        context: { scope: 'text-only', seed },
        payload,
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(
        first.evidence.segments.outputEvidence.text,
        second.evidence.segments.outputEvidence.text,
        'same seed + inputs -> identical recorded output',
      );
      assert.notEqual(first.requestId, second.requestId, 'distinct governed operations');

      const verified = await runtime.router.verifyReplay(first.requestId, () => stubModule.generate(payload));
      assert.equal(verified.verified, true, 'replay matches original record');
      assert.deepEqual(verified.differences, []);
    } finally {
      await runtime.shutdown();
    }
  });

  it('refuses illegal actions with a violation while valid calls keep working', async () => {
    const runtime = new sme.SmeLatticeModule();
    await bind(runtime);
    try {
      const bad = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'read_memory',
        context: { scope: 'text-only' },
        payload: { prompt: singlePrompt('x') },
      });
      assert.equal(bad.ok, false);
      assert.equal(bad.violation, 'capability_integrity');

      const good = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-txt',
        actorId: 'swarm-proof',
        action: 'summarize',
        context: { scope: 'text-only' },
        payload: { prompt: singlePrompt('y'), seed: seeded(3) },
      });
      assert.equal(good.ok, true);
    } finally {
      await runtime.shutdown();
    }
  });

  it('emits a refusal envelope WITH evidence when the law gate rejects', async () => {
    const runtime = new sme.SmeLatticeModule();
    await runtime.initialize({
      modules: new Map([
        ['sme-txt', stubModule],
        ['sme-core', { execute: async () => ({ text: 'should never run' }) }],
      ]),
      continuityFloor: 0,
    });
    try {
      // 'execute' is declared for sme-core in the LNIM but is NOT in the LIRL
      // action allowlist, so the spine rejects at the law gate. This exercises
      // the orchestrated refusal path, which must still carry a sealed LEPR
      // bundle.
      const res = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-core',
        actorId: 'swarm-proof',
        action: 'execute',
        context: { scope: 'spine-routing', seed: seeded(4) },
        payload: { prompt: singlePrompt('z'), seed: seeded(4) },
      });
      assert.equal(res.ok, false);
      assert.equal(res.violation, 'actor_legal');
      assert.ok(res.evidence, 'law-gate refusal still carries a LEPR evidence bundle');
      assert.ok(res.evidence.bundleHash, 'refusal bundle sealed');
      assert.equal(res.evidence.segments.decisionEvidence.verdict, 'DENY');
    } finally {
      await runtime.shutdown();
    }
  });
});