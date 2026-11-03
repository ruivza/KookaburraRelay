import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { html, raw, setLanguage } from '../public/i18n.js';

// Node reports an English locale; the assertions below read the Chinese source strings.
setLanguage('zh');
const source = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const titles = source.slice(source.indexOf('const getTitles'), source.indexOf('const getStates'));
const formatting = source.slice(source.indexOf('const stamp ='), source.indexOf('const appName'));
const templates = source.slice(source.indexOf('function heading('), source.indexOf('function jobRows('));
const channels = source.slice(source.indexOf('function renderChannels('), source.indexOf('function filters('));
const load = source.slice(source.indexOf('async function load('), source.indexOf('function modal('));
const hostile = '<img src=x onerror=alert(1)>';
function page(hash) {
  const elements = { content: { innerHTML: '', querySelectorAll: () => [] }, breadcrumb: { textContent: '' } };
  const context = vm.createContext({
    location: { hash },
    URLSearchParams,
    document: { querySelectorAll: () => [] },
    elements,
    t: s => s,
    html,
    raw,
    locale: () => 'en-US',
    api: async path => (path === '/admin/apps' ? { applications: [], channels: [] } : {}),
    renderOverview: () => '<div>Overview</div>',
    renderList: () => '<div>Records</div>',
    heading: (title, description) => html`<h1>${title}</h1><p>${description}</p>`,
    empty: (title, description) => html`<p>${title}</p>${description}`,
    notice() {},
    translateError: s => s,
  });
  vm.runInContext(
    titles +
      "const $=id=>elements[id];let token='test-session',current='overview',navigation=0,epoch=0,apps=[],catalog=[],lastData,language='zh',states={};const disclosureState=new Map();" +
      formatting +
      channels +
      load,
    context,
  );
  return { run: code => vm.runInContext(code, context), elements };
}
function helpers() {
  const context = vm.createContext({ html, raw, hostile, t: s => s, locale: () => 'en-US', states: {} });
  vm.runInContext(formatting + templates, context);
  return code => vm.runInContext(code, context);
}

test('hash input cannot become channel back-link markup through the load route', async () => {
  for (const hash of [
    '#apns?appId=fixture',
    '#android?appId=fixture',
    '#apns"><img src=x onerror=alert(1)>?appId=fixture',
    '#android%22%3E%3Csvg%20onload=alert(1)%3E?appId=fixture',
  ]) {
    const p = page(hash);
    await p.run('load()');
    assert.ok(!/<(?:img|svg)\b/i.test(p.elements.content.innerHTML));
    if (hash.startsWith('#apns?')) assert.match(p.elements.content.innerHTML, /href="#apns"/);
    else if (hash.startsWith('#android?')) assert.match(p.elements.content.innerHTML, /href="#android"/);
    else assert.equal(p.run('current'), 'overview');
  }
});

test('unknown and inherited object properties are rejected as UI routes', async () => {
  for (const requested of ['unknown', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const p = page('#' + requested);
    await p.run('load()');
    assert.equal(p.run('current'), 'overview');
  }
});

test('channel back-links depend on the rendered channel rather than mutable navigation state', () => {
  const p = page('#apns?appId=fixture');
  p.run('current = ' + JSON.stringify('"><img src=x onerror=alert(1)>'));
  for (const [kind, route] of [
    ['apns', 'apns'],
    ['fcm', 'android'],
  ]) {
    const markup = p.run('String(renderChannels(' + JSON.stringify(kind) + '))');
    assert.match(markup, new RegExp('href="#' + route + '"'));
    assert.ok(!/<img\b/i.test(markup));
  }
});

test('application data interpolated into channel cards is escaped without escaping the card markup', () => {
  const p = page('#apns');
  p.run(
    'apps = [' +
      JSON.stringify({
        id: 'fixture',
        name: hostile,
        enabled: true,
        registrations: 1,
        apns: { hasKey: true, enabled: true, topic: '"><svg onload=alert(1)>', environment: 'production' },
        fcm: {},
      }) +
      ']',
  );
  const markup = p.run("String(renderChannels('apns'))");
  assert.ok(!markup.includes('<img'));
  assert.ok(!markup.includes('<svg onload'));
  assert.ok(markup.includes('<h3>&lt;img src=x onerror=alert(1)&gt;</h3>'));
  assert.ok(markup.includes('<strong>&quot;&gt;&lt;svg onload=alert(1)&gt;</strong>'));
  // The badge and buttons are nested html`` fragments and stay markup.
  assert.ok(markup.includes('<span class="badge green">已配置</span>'));
  assert.ok(
    markup.includes('<button class="quiet danger" data-action="remove-channel" data-id="fixture" data-kind="apns">'),
  );
  assert.ok(!markup.includes('&amp;lt;'));
});

test('table cells escape plain values once and keep nested fragments as markup', () => {
  const run = helpers();
  const markup = run(
    "String(table(['应用', '状态'], [[appCell({ id: 'a&b', name: hostile }), badge('a & b', 'green')], [hostile, html`<em>${'1 < 2'}</em>`]]))",
  );
  assert.ok(!markup.includes('<img'));
  assert.ok(markup.includes('<th>应用</th><th>状态</th>'));
  assert.ok(markup.includes('<span class="app-icon">&lt;</span>'));
  assert.ok(markup.includes('<strong>&lt;img src=x onerror=alert(1)&gt;</strong><small>a&amp;b</small>'));
  assert.ok(markup.includes('<td><span class="badge green">a &amp; b</span></td>'));
  assert.ok(markup.includes('<td>&lt;img src=x onerror=alert(1)&gt;</td><td><em>1 &lt; 2</em></td>'));
  assert.ok(!markup.includes('&amp;amp;') && !markup.includes('&amp;lt;'));
});

test('html escapes strings, numbers, nullish values and array items but trusts html and raw fragments', () => {
  assert.equal(
    String(html`<p title="${'"\'&'}">${hostile}</p>`),
    '<p title="&quot;&#39;&amp;">' + '&lt;img src=x onerror=alert(1)&gt;</p>',
  );
  assert.equal(String(html`${0}|${null}|${undefined}|${false}`), '0|||false');
  assert.equal(String(html`<ul>${['<a>', html`<li>${'&'}</li>`]}</ul>`), '<ul>&lt;a&gt;<li>&amp;</li></ul>');
  assert.equal(String(html`${html`${html`<b>${'<'}</b>`}`}`), '<b>&lt;</b>');
  assert.equal(
    String(html`<div>${raw('<svg viewBox="0 0 1 1"></svg>')}</div>`),
    '<div><svg viewBox="0 0 1 1"></svg></div>',
  );
  assert.equal(`${html`<i>${'x'}</i>`}`, '<i>x</i>');
});

test('html translates static segments but never interpolated values', () => {
  setLanguage('en');
  try {
    assert.equal(String(html`<b>应用</b>${'应用'}`), '<b>Application</b>应用');
  } finally {
    setLanguage('zh');
  }
});
