'use strict';

const lattice = require('./lattice');
const { SmeCoreModule } = require('./core');
const { SmeTxtModule } = require('./txt');
const { SmeVisModule } = require('./vis');
const { SmeAudModule } = require('./aud');
const { SmeVidModule } = require('./vid');
const { SmeGenModule } = require('./gen');
const { SmeLogModule } = require('./log');
const packageMetadata = require('../package.json');

const STABILITY = Object.freeze({
  packageContract: 'stable-v0',
  lattice: 'enforced',
  evidenceAndReplay: 'enforced',
  modelBackends: 'experimental',
});

async function createLattice(config = {}) {
  const runtime = new lattice.SmeLatticeModule();
  await runtime.initialize({
    modules: config.modules || new Map(),
    continuityFloor: config.continuityFloor ?? 0,
    extraCenInvariants: config.extraCenInvariants || [],
    lrcVersion: config.lrcVersion || lattice.LRC_VERSION,
  });
  return runtime;
}

module.exports = Object.freeze({
  packageName: packageMetadata.name,
  version: packageMetadata.version,
  stability: STABILITY,
  createLattice,
  ...lattice,
  SmeCoreModule,
  SmeTxtModule,
  SmeVisModule,
  SmeAudModule,
  SmeVidModule,
  SmeGenModule,
  SmeLogModule,
});
