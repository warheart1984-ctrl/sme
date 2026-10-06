'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sme = require('..');

describe('@mandala/sme package boundary', () => {
  it('loads the stable facade without model dependencies', () => {
    assert.equal(sme.packageName, '@mandala/sme');
    assert.equal(sme.version, '0.1.1');
    assert.equal(sme.stability.lattice, 'enforced');
    assert.equal(sme.stability.modelBackends, 'experimental');
    assert.equal(typeof sme.createLattice, 'function');
  });

  it('exports every bounded module constructor', () => {
    for (const name of [
      'SmeCoreModule',
      'SmeTxtModule',
      'SmeVisModule',
      'SmeAudModule',
      'SmeVidModule',
      'SmeGenModule',
      'SmeLogModule',
    ]) {
      assert.equal(typeof sme[name], 'function', name + ' should be exported');
    }
  });

  it('routes a shadow image inspection with evidence and replay', async () => {
    const vis = {
      encode: async (input) => ({
        inspected: true,
        mimeType: input.mimeType,
        sourceSha256: input.imageData.sha256,
        backend: 'deterministic-preflight',
      }),
    };
    const runtime = await sme.createLattice({
      modules: new Map([['sme-vis', vis]]),
    });

    try {
      const response = await runtime.call({
        originNodeId: 'sme-core',
        targetNodeId: 'sme-vis',
        actorId: 'jarvis-shadow',
        action: 'classify',
        context: {
          scope: 'vision-only',
          authoritySignature: 'jarvis-shadow:test',
        },
        payload: {
          imageData: { sha256: 'a'.repeat(64) },
          mimeType: 'image/png',
          extractFeatures: true,
        },
      });

      assert.equal(response.ok, true);
      assert.equal(response.result.inspected, true);
      assert.ok(response.evidence);
      assert.match(response.replayHandle, /^[a-f0-9]{64}$/);
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps models and dependency trees outside the package root', () => {
    const root = path.resolve(__dirname, '..');
    assert.equal(fs.existsSync(path.join(root, 'models')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  });
});
