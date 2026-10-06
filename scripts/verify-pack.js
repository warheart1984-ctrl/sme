'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const raw = execSync('npm pack --dry-run --json --ignore-scripts', {
  cwd: root,
  encoding: 'utf8',
});
const report = JSON.parse(raw)[0];
const files = report.files.map((entry) => entry.path);
const forbidden = files.filter((file) =>
  /(^|\/)(node_modules|models)(\/|$)|\.(bin|gguf|onnx|safetensors)$/i.test(file),
);
const required = [
  'dist/index.js',
  'dist/lattice/index.js',
  'dist/lattice/lepr.js',
  'dist/lattice/lrdm.js',
  'types/index.d.ts',
  'PROVENANCE.json',
];
const missing = required.filter((file) => !files.includes(file));

if (forbidden.length > 0) {
  throw new Error('Forbidden package payload: ' + forbidden.join(', '));
}
if (missing.length > 0) {
  throw new Error('Required package files missing: ' + missing.join(', '));
}
if (report.unpackedSize > 1_000_000) {
  throw new Error('Package is unexpectedly large: ' + report.unpackedSize + ' bytes');
}

process.stdout.write(JSON.stringify({
  ok: true,
  name: report.name,
  version: report.version,
  filename: report.filename,
  fileCount: report.entryCount,
  packedSize: report.size,
  unpackedSize: report.unpackedSize,
}, null, 2) + '\n');
