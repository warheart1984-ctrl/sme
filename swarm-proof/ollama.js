'use strict';

/**
 * Minimal Ollama HTTP client for the swarm proof. Talks to the local Ollama
 * server on 127.0.0.1:11434. No dependencies.
 */

const http = require('node:http');

const OLLAMA_HOST = process.env.SME_OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.SME_OLLAMA_PORT || 11434);

function rawGenerate(model, prompt, { temperature = 0, seed = 12345, numPredict = 160, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature,
        seed,
        num_predict: numPredict,
      },
    });

    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.response ?? '');
          } catch (error) {
            reject(new Error(`ollama parse failed (http ${res.statusCode}): ${error.message}`));
          }
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`ollama generate timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function list() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET', timeout: 10000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).models ?? []);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

module.exports = { rawGenerate, list, OLLAMA_HOST, OLLAMA_PORT };