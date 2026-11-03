import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './helpers.mjs';
import { route, match, routeName } from '../src/router.js';

test('path parameters match one identifier segment and logs see only route patterns', () => {
  const routes = [
    route('GET', '/admin/apps/:id', {}, () => {}),
    route('PUT', '/admin/apps/:id/channels/:kind(apns|fcm)', {}, () => {}),
  ];
  assert.deepEqual(match(routes, 'GET', '/admin/apps/notes').params, { id: 'notes' });
  assert.equal(match(routes, 'GET', '/admin/apps/a/b'), null);
  assert.equal(match(routes, 'GET', '/admin/apps/a.b'), null);
  assert.equal(match(routes, 'POST', '/admin/apps/notes'), null);
  assert.equal(match(routes, 'PUT', '/admin/apps/x/channels/sms'), null);
  assert.deepEqual(match(routes, 'PUT', '/admin/apps/x/channels/fcm').params, { id: 'x', kind: 'fcm' });
  assert.equal(routeName(routes, '/admin/apps/secret-id/channels/apns'), '/admin/apps/:id/channels/:kind');
  assert.equal(routeName(routes, '/admin/apps/x/../y'), '/unknown');
});

test('every admin route requires a console session, and the route table has no duplicates', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-routes-'));
  const app = await createGateway({ dataDir, adminToken: 'route-table-operator'.repeat(3), autoStart: false });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const admin = app.routes.filter(entry => entry.pattern.startsWith('/admin/'));
  assert.ok(admin.length >= 40, String(admin.length));
  assert.deepEqual(
    admin.filter(entry => entry.auth !== 'admin').map(entry => entry.method + ' ' + entry.pattern),
    [],
  );
  assert.deepEqual(
    app.routes.filter(entry => entry.auth === 'monitor').map(entry => entry.pattern),
    ['/metrics', '/monitor/report'],
  );
  for (const entry of app.routes) assert.ok(['none', 'admin', 'monitor', 'device', 'server'].includes(entry.auth));
  const keys = app.routes.map(entry => entry.method + ' ' + entry.pattern);
  assert.equal(new Set(keys).size, keys.length);

  // Enforcement, not just declaration: each admin route refuses a request without a session.
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const sample = entry =>
    entry.pattern.replace(/:(\w+)(?:\(([^)]+)\))?/g, (_, key, choices) =>
      choices?.includes('|') ? choices.split('|')[0] : choices ? '00000000-0000-0000-0000-000000000000' : 'x',
    );
  for (const entry of admin) {
    const path = sample(entry);
    assert.ok(entry.regex.test(path), path);
    const response = await fetch(base + path, {
      method: entry.method,
      headers: { 'Content-Type': 'application/json' },
      body: entry.method === 'GET' ? undefined : '{}',
    });
    assert.equal(response.status, 401, entry.method + ' ' + path);
  }
});
