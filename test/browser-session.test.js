import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function readSession'), source.indexOf("import "));
const apiCode = source.slice(source.indexOf('async function api('), source.indexOf('async function action'));
const lockCode = source.slice(source.indexOf('function lock()'), source.indexOf('async function api('));
function page(storage, status = 200) {
  const element = new Proxy(function () {}, { get: () => element, apply: () => element, set: () => true });
  const context = vm.createContext({
    sessionStorage: storage, AbortController, setTimeout, clearTimeout, clearInterval,
    $: () => element, document: element, clearSecurity() {}, route() {}, message() {}, notice() {}, t: s => s,
    fetch: async () => ({ status, ok: status === 200, json: async () => ({ error: 'Expired' }) }),
  });
  vm.runInContext(helpers + `
    let token = readSession(), epoch = 0, navigation = 0, apps = [], lastData,
      me, health, poll, invitationCode, sessionData, userData, pushConfig;
    const controllers = new Set(), disclosureState = new Map();
  ` + lockCode + apiCode, context);
  return code => vm.runInContext(code, context);
}
function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
test('reload restores session and logout removes it', () => {
  const saved = storage(), first = page(saved);
  first("token = 'issued-session'; saveSession(token)");
  const reloaded = page(saved);
  assert.equal(reloaded('token'), 'issued-session');
  reloaded('lock()');
  assert.equal(page(saved)('token'), '');
});
test('server rejection clears persisted session', async () => {
  const saved = storage();
  page(saved)("saveSession('expired-session')");
  const reload = page(saved, 401);
  await assert.rejects(reload("api('/protected')"), /Expired/);
  assert.equal(reload('token'), '');
  assert.equal(page(saved)('token'), '');
});
test('transient server failure retains session for retry', async () => {
  const saved = storage();
  page(saved)("saveSession('valid-session')");
  await assert.rejects(page(saved, 503)("api('/protected')"));
  assert.equal(page(saved)('token'), 'valid-session');
});
test('blocked browser storage does not prevent in-memory login', () => {
  const blocked = () => { throw Error('Storage blocked'); };
  const run = page({ getItem: blocked, setItem: blocked, removeItem: blocked });
  assert.equal(run('token'), '');
  run("token = 'issued-session'; saveSession(token)");
  assert.equal(run('token'), 'issued-session');
  run('lock()');
  assert.equal(run('token'), '');
});
