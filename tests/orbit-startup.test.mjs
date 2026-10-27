import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/enterprise-orbits-v12/enterprise.js', import.meta.url), 'utf8');
function bootstrap({ phone = false, reduced = false, reading = false } = {}) {
  let modelLoads = 0;
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: true, dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, remove() {} }, addEventListener() {}, setAttribute(name, value) { this[name] = value; }, querySelectorAll() { return []; } });
    return elements.get(selector);
  };
  const context = { URLSearchParams, URL, console, THREE: { Raycaster: class {} }, MTWHolograms: { load() { modelLoads++; return new Promise(() => {}); } }, matchMedia(query) { return { matches: query.includes('max-width') ? phone : reduced, addEventListener() {} }; }, location: { search: reading ? '?view=reading' : '', hash: '', href: 'https://ai2026orbit.makingthings.work/' }, document: { querySelector: element, querySelectorAll() { return []; }, addEventListener() {}, body: element('body'), hidden: false }, addEventListener() {}, innerWidth: phone ? 390 : 1440, innerHeight: 844, devicePixelRatio: 1 };
  context.window = context;
  vm.runInNewContext(source, context);
  return { modelLoads, elements };
}
for (const [name, preferences] of [['desktop', {}], ['phone', { phone: true }], ['reduced motion', { reduced: true }]]) {
  test(`${name} starts loading the 3D model`, () => assert.equal(bootstrap(preferences).modelLoads, 1));
}
test('Reading view remains an explicit alternative on phones', () => assert.equal(bootstrap({ phone: true, reading: true }).modelLoads, 0));
test('reduced motion starts with the visible 3D scene paused', () => assert.equal(bootstrap({ reduced: true }).elements.get('#pause-motion')['aria-pressed'], 'true'));
