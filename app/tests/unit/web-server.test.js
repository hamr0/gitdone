'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { handle } = require('../../bin/server');

// Spin up a throwaway server bound to the handle we export, then
// make real HTTP requests. This validates routing + response shape
// end-to-end without shelling out to the systemd unit.

async function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(handle);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('GET / returns landing page with both create buttons', async () => {
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /Create Event/);
    assert.match(r.body, /Create Crypto/);
    assert.match(r.body, /href="\/events\/new"/);
    assert.match(r.body, /href="\/crypto\/new"/);
  } finally {
    server.close();
  }
});

test('GET /health returns JSON ok', async () => {
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/health');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'gitdone-web');
    assert.ok(body.timestamp);
  } finally {
    server.close();
  }
});

test('GET /nonexistent returns 404', async () => {
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/nope');
    assert.equal(r.status, 404);
    assert.match(r.body, /404/);
  } finally {
    server.close();
  }
});

test('POST / is 404 (no POST handler registered for /)', async () => {
  const { server, port } = await startServer();
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});

test('landing page mentions offline verification', async () => {
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/');
    assert.match(r.body, /gitdone-verify/);
  } finally {
    server.close();
  }
});
