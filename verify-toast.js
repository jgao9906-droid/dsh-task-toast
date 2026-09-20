'use strict';
/**
 * verify-toast.js — behavioural proof for dsh-task-toast, before it is ever
 * installed into a profile.
 *
 * Runs the real client.js in a VM against a fake DOM, a fake `sessions` service
 * and a fake clock, then drives the exact sequences that matter:
 *
 *   1  no sessions service yet      -> stays silent, does not throw
 *   2  service arrives late         -> retry picks it up (the real boot race)
 *   3  bind on a running:false face -> baseline, silence
 *   4  false -> true                -> START edge: must NOT toast
 *   5  true  -> false               -> COMPLETE edge: toast, with the right text
 *   6  auto-dismiss                 -> gone after TOAST_MS, node removed
 *   7  switch into a RUNNING session-> baseline, silence; its end still toasts
 *   8  unrelated list publishes     -> no churn, no spurious toast
 *   9  teardown                     -> plate removed, subscriptions released
 *
 * Usage: node verify-toast.js [path-to-client.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Defaults to the client half sitting next to this file, so a fresh clone can run
   `node verify-toast.js` with no arguments and no local paths baked in. */
const TARGET = process.argv[2] || path.join(__dirname, 'client.js');
const src = fs.readFileSync(TARGET, 'utf8');

let failures = 0;
const pass = (m) => console.log('ok    ' + m);
const fail = (m) => { console.error('FAIL  ' + m); failures++; };

// Kept in step with client.js: the plate's on-screen duration. Aligned to the
// Windows notification default, so this is 5000 — not the original 4200. A stale
// value here would make the auto-dismiss assertions pass for the wrong reason.
const TOAST_MS = 5000;

/* ------------------------------------------------------------------ fake clock */
let now = 0, seq = 0;
const timers = new Map();
const fakeSetTimeout = (fn, ms) => {
  const id = ++seq;
  timers.set(id, { fn, at: now + (typeof ms === 'number' ? ms : 0) });
  return id;
};
const fakeClearTimeout = (id) => { timers.delete(id); };
const advance = (ms) => {
  const target = now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.at <= target && (next === null || t.at < next.t.at)) next = { id, t };
    }
    if (next === null) break;
    timers.delete(next.id);
    now = next.t.at;
    next.t.fn();
  }
  now = target;
};

/* ------------------------------------------------------------------ fake DOM */
const makeEl = (tag) => {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, style: {}, className: '', innerHTML: '',
    parentNode: null, isConnected: true, _q: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    // Records one text stub per selector so the harness can read back what the
    // plugin wrote (word / kicker / tag) without parsing innerHTML.
    querySelector(sel) {
      if (!this._q[sel]) this._q[sel] = { textContent: '' };
      return this._q[sel];
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  };
  return el;
};
const body = makeEl('body');
const head = makeEl('head');
const documentStub = {
  body, head, documentElement: makeEl('html'),
  title: 'DSH',                        // the title-badge channel reads/writes this
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
};

const plates = () => body.children.filter((c) => c.hasAttribute && c.hasAttribute('data-task-toast'));
const wordOf = (p) => (p._q['[data-task-toast-word]'] || {}).textContent;
const taskOf = (p) => (p._q['[data-task-toast-task]'] || {}).textContent;
const sheets = () => head.children.filter((c) => c.getAttribute && c.getAttribute('data-plugin') === 'dsh-task-toast');

/* ------------------------------------------------------------------ fake observables */
const makeObservable = (initial) => {
  let state = initial;
  const subs = new Set();
  return {
    getSnapshot: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    set(next) { state = next; for (const fn of [...subs]) fn(); },
    ping() { for (const fn of [...subs]) fn(); },
    get subscriberCount() { return subs.size; },
  };
};

const sessionA = makeObservable({ running: false });
const sessionB = makeObservable({ running: false });
const list = makeObservable({ current: 'a' });
let sessionsService;   // deliberately undefined at apply() time (case 1)
const sessions = {
  list,
  binding: (id) => {
    if (id === 'a') return { sessionId: id, session: sessionA };
    if (id === 'b') return { sessionId: id, session: sessionB };
    return undefined;
  },
};

/* ------------------------------------------------------------------ load bundle */
let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { loaded = m; } },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    innerWidth: 1400, innerHeight: 900,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  },
  document: documentStub,
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  performance: { now: () => now },
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  setInterval: () => 0, clearInterval() {},
  console: { log() {}, warn() {}, error() {} },
};
sandbox.globalThis = sandbox;
sandbox.window.document = documentStub;

vm.createContext(sandbox);
try {
  new vm.Script(src, { filename: 'client.js' }).runInContext(sandbox);
} catch (e) { fail('client.js threw while loading: ' + e.message); process.exit(1); }
if (loaded === null) { fail('module never registered with __ModuleLoader__'); process.exit(1); }
pass('bundle registers via window.__ModuleLoader__.load');

const mod = loaded.factory(() => null);

let teardown = null;
const ctx = {
  get: (n) => (n === 'sessions' ? sessionsService : undefined),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') teardown = d; },
};

/* ---- 1: mount with the service absent ---------------------------------- */
try { mod.apply(ctx); } catch (e) { fail('apply() threw without a sessions service: ' + e.message); process.exit(1); }
if (plates().length === 0) pass('1 no sessions service -> silent');
else fail('1 a plate appeared without a sessions service');
if (sheets().length === 1) pass('1 stylesheet injected exactly once');
else fail('1 expected 1 stylesheet, found ' + sheets().length);

advance(600);
if (plates().length === 0) pass('1 still silent while retrying (no crash, no spam)');
else fail('1 plate appeared while the service was still missing');

/* ---- 2: the service arrives late -------------------------------------- */
sessionsService = sessions;
advance(400);                       // let the 120ms retry fire
if (sessionA.subscriberCount === 1) pass('2 late service picked up, current session bound');
else fail('2 late service never bound (subscribers=' + sessionA.subscriberCount + ')');

/* ---- 3/4/5: the edges -------------------------------------------------- */
advance(1000);
if (plates().length === 0) pass('3 baseline (running:false) is silent');
else fail('3 baseline produced a plate');

sessionA.set({ running: true });
advance(200);
if (plates().length === 0) pass('4 false -> true (start edge) does NOT toast');
else fail('4 start edge toasted: ' + wordOf(plates()[0]));

sessionA.set({ running: false });
advance(200);
if (plates().length === 1) pass('5 true -> false (end edge) toasts');
else fail('5 end edge produced ' + plates().length + ' plates');
if (plates().length === 1 && wordOf(plates()[0]) === 'COMPLETE') pass('5 word is COMPLETE');
else fail('5 word was ' + JSON.stringify(plates().length ? wordOf(plates()[0]) : null));
// This harness's session-list stub carries no byId row, so there is no title to
// show — the documented fallback must appear rather than an empty line.
if (plates().length === 1 && taskOf(plates()[0]) === 'SESSION IDLE') pass('5 no session title -> task line falls back to SESSION IDLE');
else fail('5 task fallback was ' + JSON.stringify(plates().length ? taskOf(plates()[0]) : null));
if (plates().length === 1 && plates()[0].getAttribute('aria-hidden') === 'true') pass('5 plate is aria-hidden');
else fail('5 plate is not aria-hidden');
if (plates().length === 1 && plates()[0].getAttribute('data-task-toast') === '') pass('5 plate carries its hook attribute');
else fail('5 plate hook attribute missing');

const plateRef = plates()[0];

/* ---- 8: unrelated list publishes must not churn or toast --------------- */
for (let i = 0; i < 5; i++) list.ping();
advance(300);
if (plates()[0] === plateRef && plates().length === 1) pass('8 unrelated list publishes: no extra plate, no rebuild');
else fail('8 a list publish disturbed the plate');
if (sessionA.subscriberCount === 1) pass('8 still exactly one session subscription');
else fail('8 subscription churned (count=' + sessionA.subscriberCount + ')');

/* ---- 6: auto-dismiss --------------------------------------------------- */
advance(TOAST_MS + 400);
if (plates().length === 0) pass('6 auto-dismissed and the node was removed');
else fail('6 plate outlived TOAST_MS (' + plates().length + ' still up)');

/* ---- 7: switching into an ALREADY RUNNING session ---------------------- */
sessionB.set({ running: true });
list.set({ current: 'b' });
advance(300);
if (plates().length === 0) pass('7 switching into a running session is silent (baseline)');
else fail('7 switching into a running session toasted: ' + wordOf(plates()[0]));
if (sessionB.subscriberCount === 1) pass('7 new session subscribed');
else fail('7 new session not subscribed (count=' + sessionB.subscriberCount + ')');
if (sessionA.subscriberCount === 0) pass('7 previous session released');
else fail('7 previous session still subscribed (count=' + sessionA.subscriberCount + ')');

sessionB.set({ running: false });
advance(200);
if (plates().length === 1) pass('7 its real end edge still toasts');
else fail('7 end edge after a switch was swallowed');
advance(TOAST_MS + 400);

/* ---- 9: teardown ------------------------------------------------------- */
if (typeof teardown !== 'function') fail('9 apply() registered no ctx.effect teardown');
else {
  // Drive the session that is actually watched (B), so there IS a plate up at
  // the moment of teardown — otherwise the assertion below proves nothing.
  sessionB.set({ running: true });
  advance(200);
  sessionB.set({ running: false });
  advance(200);
  const before = plates().length;
  if (before === 1) pass('9 a plate is up before teardown');
  else fail('9 expected 1 plate before teardown, found ' + before);
  teardown();
  if (plates().length === 0) pass('9 teardown removes the plate (had ' + before + ')');
  else fail('9 teardown left ' + plates().length + ' plate(s)');
  if (sessionA.subscriberCount === 0 && sessionB.subscriberCount === 0 && list.subscriberCount === 0) {
    pass('9 teardown released every subscription');
  } else {
    fail('9 teardown leaked subscriptions: a=' + sessionA.subscriberCount + ' b=' + sessionB.subscriberCount + ' list=' + list.subscriberCount);
  }
  sessionB.set({ running: true });
  sessionB.set({ running: false });
  advance(300);
  if (plates().length === 0) pass('9 no edges after teardown');
  else fail('9 an edge after teardown still toasted');
}

console.log('');
if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('all dsh-task-toast checks passed');
