'use strict';
/**
 * dsh-task-toast — multi-state harness.
 *
 * Covers the state layer on top of the single COMPLETE plate:
 *
 *   A  no remote subscription  -> the plugin CANNOT swallow an approval
 *   B  APPROVAL                -> full plate, then collapses to the edge bar
 *   B2 differential            -> the sticky guard under a longer pending deadline
 *   C  the panel IS the state   -> closing it ends the pending; a repaint does not
 *                                 re-announce
 *   D  QUESTION                -> both panel flavours, word/colour/detail
 *   E  several pendings        -> the bar outlives the first; a new one re-expands
 *   F  ERROR                   -> from the session snapshot, deduped, baselined
 *   G  UNOPENED                -> transition, not state
 *   H  SUBAGENT                -> a turn ending is not the same claim as done
 *   I  priority                -> pending outranks a transient plate
 *   J  teardown                -> observer disconnected, nothing left on screen
 *   K  degraded DOM            -> no MutationObserver, panel already open at mount
 *
 * Run: node verify-status.js [path/to/client.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Defaults to the client half sitting next to this file, so a fresh clone can run
   `node verify-status.js` with no arguments and no local paths baked in. */
const TARGET = process.argv[2] || path.join(__dirname, 'client.js');
let src = fs.readFileSync(TARGET, 'utf8');

let failures = 0;
const pass = (m) => console.log('ok    ' + m);
const fail = (m) => { console.error('FAIL  ' + m); failures++; };
const check = (cond, okMsg, badMsg) => { if (cond) pass(okMsg); else fail(badMsg); };

/* Mirrors of client.js timings. Duplicated ON PURPOSE: a silent change there must
   show up as a failure here, not be absorbed by importing the real values. */
const TOAST_MS = 5000;
const PENDING_FULL_MS = 5000;
const EXIT_MS = 260;
const SCAN_DEBOUNCE = 60;
/* Mirrors of the bar geometry. The size/invariant assertions below are the pins for
   "不明显" and for the no-overlap property that keeps hover from flickering. */
const EDGE_W = 8;
const EDGE_H = 128;
const EDGE_HIT_W = 14;
const EDGE = 18;

/* ------------------------------------------------------------------ clock */
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + (typeof ms === 'number' ? ms : 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < next.t.at)) next = { id, t };
        if (next === null) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = target;
    },
    reset() { timers.clear(); now = 0; },
    now: () => now,
    /* Move wall-clock time WITHOUT running any due timer: the only way to model a
       starved timer (a hidden page clamps timeouts, so time passes and the callback
       does not run). advance() cannot express that. */
    starve(ms) { now += ms; },
  };
}

/* ------------------------------------------------------------------ DOM */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, className: '', innerHTML: '',
    parentNode: null, textContent: '', offsetHeight: 0, _q: {}, _ev: {},
    /* The real element exposes CSSStyleDeclaration; the plugin writes the measured
       plate height into a custom property, so the stub has to accept that. */
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = String(v); },
      getPropertyValue(k) { return Object.prototype.hasOwnProperty.call(this._p, k) ? this._p[k] : ''; },
    },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector(sel) { if (!this._q[sel]) this._q[sel] = makeEl('stub'); return this._q[sel]; },
    querySelectorAll: () => [],
    addEventListener(ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev) { for (const fn of (this._ev[ev] || []).slice()) fn(); },
  };
  return el;
}

/* ------------------------------------------------------------------ sandbox */
function boot(opts) {
  const o = opts || {};
  // A per-boot source override, used by the differential section: the same logic
  // under a different TUNABLE (not a different algorithm). Some guarantees are only
  // load-bearing for some tunings, and a harness that cannot vary the tuning cannot
  // tell those apart from dead code.
  const bootSrc = o.src === undefined ? src : o.src;
  const clock = makeClock();
  clock.reset();
  const RealDate = Date;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(clock.now()).toString();
    return args.length === 0 ? new RealDate(clock.now()) : new RealDate(...args);
  }
  FakeDate.now = () => clock.now();
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const body = makeEl('body');
  const head = makeEl('head');

  /* ---- the pending panels the official plugins render ----
     Real markup carries a SEMANTIC data attribute (`data-approval-key` etc.) whose
     value is the panel's own one-shot key — that value is what makes a repaint
     distinguishable from a new request, so the harness models it exactly. */
  const panels = [];
  const observerCbs = [];
  let observeCalls = 0;
  let disconnectCalls = 0;

  const documentStub = {
    body, head, documentElement: makeEl('html'),
    title: 'DSH',
    hidden: false,
    visibilityState: 'visible',
    createElement: (t) => {
      const el = makeEl(t);
      // A laid-out plate reports a real height; the edge bar is supposed to adopt it.
      if (o.plateHeight !== undefined) el.offsetHeight = o.plateHeight;
      return el;
    },
    querySelector: (sel) => (sel === '[data-task-ask]'
      ? (body.children.find((c) => c.hasAttribute && c.hasAttribute('data-task-ask')) || null)
      : null),
    querySelectorAll: (sel) => {
      // Only the `[attr]` form the plugin uses; anything else resolves to nothing.
      const m = /^\[([a-z-]+)\]$/.exec(String(sel));
      if (m === null) return [];
      return panels.filter((p) => p.attr === m[1]).map((p) => p.node);
    },
    addEventListener() {}, removeEventListener() {},
  };

  const store = { _d: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };

  const raised = [];
  let requestCalls = 0;
  function NotificationStub(title, opt) {
    raised.push({ title, body: (opt && opt.body) || '', tag: (opt && opt.tag) || '', sessionId: (opt && opt.sessionId) || '' });
    this.close = () => {};
    this.onclick = null;
  }
  NotificationStub.permission = o.permission || 'granted';
  NotificationStub.requestPermission = () => { requestCalls++; NotificationStub.permission = 'granted'; return { then(res) { if (typeof res === 'function') res('granted'); return this; } }; };

  const winHandlers = {};
  const windowObj = {
    __ModuleLoader__: null,
    addEventListener(ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) { winHandlers[ev] = (winHandlers[ev] || []).filter((h) => h !== fn); },
    matchMedia: () => ({ matches: false }),
    focus() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };

  let snap = {
    sessionId: 'a', running: false, queue: [], pendingSubmissions: [],
    subagent: null, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false,
    lastAgentError: o.agentError === undefined ? null : o.agentError,
    promptAttempted: false, awaitingFirstTurn: false,
  };
  const subs = new Set();
  const sessionA = {
    getSnapshot: () => snap,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    patch(next) { snap = Object.assign({}, snap, next); for (const fn of [...subs]) fn(); },
    subscriberCount: () => subs.size,
  };

  // List face: `byId` rows carry `parentId` (NOT the internal `parentSessionId`).
  let listState = { current: 'a', ids: ['a'], byId: { a: { id: 'a', displayTitle: '我的会话标题', running: false } } };
  const listSubs = new Set();
  const list = {
    getSnapshot: () => listState,
    subscribe(fn) { listSubs.add(fn); return () => { listSubs.delete(fn); }; },
    set(next) { listState = next; for (const fn of [...listSubs]) fn(); },
  };

  const sessions = {
    list,
    binding: (id) => (id === 'a' ? { sessionId: id, session: sessionA } : undefined),
    scopeOf: () => undefined,
  };

  /* A remote stand-in that RECORDS everything. The whole point of the current
     design is that it is never touched — a plugin that never joins the approval
     waterfall cannot swallow it. */
  const remote = {
    $onCalls: 0, getCalls: 0,
    $on() { remote.$onCalls += 1; return () => {}; },
  };

  /* A panel that is already on screen when the plugin mounts — the reload-with-an-
     approval-open case. Registered BEFORE apply(), so no observer callback can be
     responsible for finding it. */
  if (o.prePanel !== undefined && o.prePanel !== null) {
    const node = makeEl('div');
    node.setAttribute(o.prePanel.attr, o.prePanel.key);
    node.textContent = o.prePanel.text;
    panels.push({ attr: o.prePanel.attr, key: o.prePanel.key, node });
  }

  /* WebSocket stand-in: the plugin must open ONE mux socket, subscribe to the forwarded
     events stream, and hand every frame to its own handler. Tests drive it directly. */
  const wsInstances = [];
  function WebSocketStub(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.send = (data) => { this.sent.push(String(data)); };
    this.close = () => { this.closed = true; };
    wsInstances.push(this);
  }

  let loaded = null;
  const sandbox = {
    window: windowObj,
    document: documentStub,
    Notification: o.notification === false ? undefined : NotificationStub,
    WebSocket: o.webSocket === false ? undefined : WebSocketStub,
    localStorage: o.localStorage === false ? undefined : store,
    MutationObserver: o.mutationObserver === false ? undefined : function (cb) {
      observerCbs.push(cb);
      this.observe = () => { observeCalls += 1; };
      this.disconnect = () => { disconnectCalls += 1; };
    },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: () => 0, clearInterval() {},
    Date: FakeDate,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  windowObj.document = documentStub;
  if (!windowObj.location) windowObj.location = { protocol: 'http:', host: '127.0.0.1:3080' };
  windowObj.__ModuleLoader__ = { load: (m) => { loaded = m; } };

  vm.createContext(sandbox);
  new vm.Script(bootSrc, { filename: 'client.js' }).runInContext(sandbox);

  let teardown = null;
  const ctx = {
    get: (n) => (n === 'sessions' ? sessions : (n === 'remote' ? (remote.getCalls += 1, remote) : undefined)),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') teardown = d; },
  };
  const mod = loaded.factory(() => null);
  mod.apply(ctx);

  const plates = () => body.children.filter((c) => c.hasAttribute && c.hasAttribute('data-task-toast'));
  const livePlates = () => plates().filter((p) => !p.hasAttribute('data-task-toast-exit'));
  const edges = () => body.children.filter((c) => c.hasAttribute && c.hasAttribute('data-task-toast-edge'));

  /* Panel verbs. Each one mutates the DOM and then fires the observer, exactly as
     the real panels do; the plugin debounces, so callers advance the clock. */
  const fireMutation = () => { for (const cb of observerCbs.slice()) cb([], null); };
  const addPanel = (attr, key, text) => {
    const node = makeEl('div');
    node.setAttribute(attr, key);
    node.textContent = text;
    panels.push({ attr, key, node });
    fireMutation();
    return node;
  };
  const closePanel = (key) => {
    const i = panels.findIndex((p) => p.key === key);
    if (i < 0) return false;
    panels.splice(i, 1);
    fireMutation();
    return true;
  };

  return {
    clock, body, head, documentStub, raised, store, remote, sessionA, list, panels,
    wsInstances, ws: () => wsInstances[wsInstances.length - 1],
    mod, ctx,
    teardown: () => teardown,
    subscriberCount: () => sessionA.subscriberCount(),
    observeCalls: () => observeCalls,
    disconnectCalls: () => disconnectCalls,
    plates, livePlates, edges,
    plateWord: (p) => (p._q['[data-task-toast-word]'] || {}).textContent,
    plateTask: (p) => (p._q['[data-task-toast-task]'] || {}).textContent,
    word: () => (livePlates()[0] ? (livePlates()[0]._q['[data-task-toast-word]'] || {}).textContent : undefined),
    task: () => (livePlates()[0] ? (livePlates()[0]._q['[data-task-toast-task]'] || {}).textContent : undefined),
    state: () => (livePlates()[0] ? livePlates()[0].getAttribute('data-state') : undefined),
    edgeState: () => (edges()[0] ? edges()[0].getAttribute('data-state') : undefined),
    cssText: () => (head.children || []).map((c) => c.textContent || '').join('\n'),
    fireWindow: (ev) => { for (const fn of (winHandlers[ev] || []).slice()) fn(); },
    setHidden(v) {
      documentStub.hidden = !!v;
      documentStub.visibilityState = v ? 'hidden' : 'visible';
      for (const fn of (winHandlers['visibilitychange'] || []).slice()) fn();
    },
    panel: addPanel,
    close: closePanel,
    /* Hover the anchor bar, exactly as the pointer would. */
    hover(on) {
      const el = edges()[0];
      if (el === undefined) return false;
      el.fire(on ? 'mouseenter' : 'mouseleave');
      return true;
    },
    /* Add a panel and settle the debounce in one step — the common case. */
    showPanel(attr, key, text) { addPanel(attr, key, text); clock.advance(SCAN_DEBOUNCE + 10); },
    closePanel,
    setPanelText(key, text) {
      const p = panels.find((x) => x.key === key);
      if (p === undefined) return false;
      p.node.textContent = text;
      fireMutation();
      return true;
    },
    endTurn() { sessionA.patch({ running: true }); clock.advance(150); sessionA.patch({ running: false }); clock.advance(150); },
    child(id, running) {
      const byId = Object.assign({}, listState.byId);
      byId[id] = { id, parentId: 'a', running, displayTitle: id };
      list.set(Object.assign({}, listState, { ids: listState.ids.concat([id]), byId }));
    },
    row(id, fields) {
      const byId = Object.assign({}, listState.byId);
      byId[id] = Object.assign({ id }, fields);
      list.set(Object.assign({}, listState, { ids: listState.ids.concat([id]), byId }));
    },
    flush() { return new Promise((res) => setImmediate(res)); },
  };
}

/* Real panel copy, so the detail-stripping is tested against what the panels
   actually render (not a convenient fiction). */
const APPROVAL_TEXT = '等待审批工具 Bash 请求越权执行拒绝允许一次';
const APPROVAL_PLAIN = '等待审批工具 Write 请求越权执行拒绝允许一次';
const QUESTION_TEXT = '计划待审要用哪个方案？方案 A方案 B上一题跳过本题确认执行拒绝去聊天里说';

/* ==================================================================== A */
/* The safety property that replaced the waterfall contract: the plugin never joins
   the approval/question waterfalls, so it cannot swallow the official panel or
   hang the agent. This is what the old `must return next()` assertions guarded;
   the guard is now structural. */
console.log('--- A: the plugin never joins the approval waterfall ---');
{
  const t = boot();
  check(t.remote.$onCalls === 0, 'A no remote listener is ever registered', 'A the plugin registered ' + t.remote.$onCalls + ' remote listener(s) — a waterfall listener can swallow the official panel');
  check(t.remote.getCalls === 0, 'A the remote service is not even looked up', 'A the plugin touched ctx.get("remote")');
  // The plugin still works off the snapshot alone.
  t.endTurn();
  check(t.word() === 'COMPLETE', 'A and completion still works off the snapshot -> ' + t.word(), 'A completion broke: ' + JSON.stringify(t.word()));
}

/* ==================================================================== B */
console.log('--- B: APPROVAL — full plate, then the edge bar ---');
{
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  check(t.livePlates().length === 1, 'B a pending approval raises the plate', 'B no plate for the pending panel');
  check(t.word() === 'APPROVAL', 'B the word is APPROVAL -> ' + t.word(), 'B the word was ' + JSON.stringify(t.word()));
  check(t.task() === '工具 Bash 请求越权执行', 'B the detail strips the panel copy and keeps the reason -> ' + t.task(), 'B the detail was ' + JSON.stringify(t.task()));
  check(t.state() === 'approval', 'B the plate carries data-state=approval', 'B the plate state was ' + JSON.stringify(t.state()));
  // The bar is NOT removed while the plate is up: it is the hover target, and an
  // element removed from under the pointer never fires mouseleave (which would
  // strand the hover flag at true forever). It reads as the plate's corner anchor.
  check(t.edges().length === 1, 'B the bar stays as the plate anchor', 'B the bar was removed while the plate was up');
  // PENDING_ALWAYS_NOTIFY is false: a pending obeys the SAME visibility rule as
  // every other state. Looking at the plate while an OS toast fires on top of it is
  // duplicate noise, and "notifications only when I am not looking" was the original
  // requirement — no state gets an exemption.
  check(t.raised.length === 0, 'B looking at DSH: the plate carries it, no OS toast', 'B a pending toasted while you were reading the plate');

  t.clock.advance(PENDING_FULL_MS - 500);
  check(t.livePlates().length === 1, 'B still full just before the collapse deadline (it is not a 5s toast)', 'B the pending plate vanished early');

  t.clock.advance(600);
  check(t.edges().length === 1, 'B collapsed to the edge bar at PENDING_FULL_MS', 'B no edge bar after the collapse deadline');
  check(t.edgeState() === 'approval', 'B the bar is coloured for approval -> ' + t.edgeState(), 'B the bar state was ' + JSON.stringify(t.edgeState()));
  t.clock.advance(EXIT_MS + 80);
  check(t.plates().length === 0, 'B the collapsed plate left no node behind', 'B a stale plate node survived the collapse');
}
{
  // ...and away, the same pending DOES reach the OS channel, with its own title and
  // the session id that click-to-focus needs.
  const t = boot();
  t.setHidden(true);
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  check(t.raised.length === 1, 'B away: the pending reaches the OS channel', 'B a pending was silent while away');
  check(t.raised[0] && t.raised[0].title === '等待你授权', 'B its title says 等待你授权 -> ' + (t.raised[0] || {}).title, 'B the notification said ' + JSON.stringify((t.raised[0] || {}).title));
  check(t.raised[0] && t.raised[0].body === '工具 Bash 请求越权执行', 'B its body is the stripped reason', 'B the body was ' + JSON.stringify((t.raised[0] || {}).body));
  check(t.raised[0] && t.raised[0].sessionId === 'a', 'B and it carries the session id for click-to-focus', 'B the notification lost its sessionId');
  check(t.documentStub.title === '● DSH', 'B and the title bar keeps the badge', 'B no badge while away');
}

/* =================================================================== B2 */
/* Differential: the SAME logic under a different tunable. With the shipped values
   TOAST_MS and PENDING_FULL_MS are both 5000, so a pending plate's two possible
   deadlines coincide and the `!plateSticky` guard in showToast() is unobservable —
   it looks like dead code. It is not: it is what keeps a pending plate alive once
   someone tunes the pending display longer than an ordinary toast. */
console.log('--- B2: sticky guard under a longer pending deadline ---');
{
  const tuned = src.replace('const PENDING_FULL_MS = 5000', 'const PENDING_FULL_MS = 15000');
  check(tuned !== src, 'B2 the tuning substitution applied (harness sanity)', 'B2 the constant was not found — this section is untested');
  const t = boot({ src: tuned });
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  check(t.livePlates().length === 1, 'B2 the pending plate is up', 'B2 no pending plate');
  t.clock.advance(TOAST_MS + 500);
  check(t.livePlates().length === 1, 'B2 it survives past TOAST_MS (it is not an ordinary toast)', 'B2 the pending plate was cut to the ordinary toast length');
  check(t.edges().length === 1, 'B2 the anchor bar is there the whole time', 'B2 the bar came and went');
  t.clock.advance(15000);
  check(t.livePlates().length === 0, 'B2 the plate collapses at its own deadline', 'B2 the plate was still up at the tuned deadline');
  check(t.edges().length === 1, 'B2 and only the bar is left', 'B2 no bar at the tuned deadline');
  t.close('approval:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.edges().length === 0, 'B2 and closing the panel still clears everything', 'B2 the bar survived the close');
}

/* ==================================================================== C */
console.log('--- C: the panel IS the state ---');
{
  // Closing the panel ends the pending: no event, no signal — the DOM is gone.
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + 100);
  check(t.edges().length === 1, 'C bar is up while the panel exists', 'C no bar while the panel exists');
  t.close('approval:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.edges().length === 0, 'C closing the panel takes the bar down', 'C the bar outlived the panel');
  check(t.livePlates().length === 0, 'C and leaves no plate behind', 'C a plate outlived the panel');
}
{
  // A repaint under the SAME key must not re-announce (that would nag on every
  // keystroke inside the panel).
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  check(t.plates().length === 0, 'C the announcement has come and gone', 'C the plate never left');
  check(t.edges().length === 1, 'C only the bar remains', 'C no bar after the announcement');
  const raisedBefore = t.raised.length;
  t.setPanelText('approval:1', APPROVAL_PLAIN);
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.plates().length === 0, 'C a repaint under the same key does NOT re-expand the plate', 'C a repaint re-announced the same pending');
  check(t.raised.length === raisedBefore, 'C and does not re-notify either', 'C a repaint fired another OS toast');
  check(t.edges().length === 1, 'C the bar is still up', 'C the bar disappeared on a repaint');
}
{
  // A DIFFERENT key is a genuinely new request: it earns a fresh announcement.
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  t.showPanel('data-approval-key', 'approval:2', APPROVAL_PLAIN);
  check(t.livePlates().length === 1, 'C a new key re-expands the plate', 'C a new key stayed collapsed');
  check(t.task() === '工具 Write 请求越权执行', 'C and shows the new request -> ' + t.task(), 'C the plate showed ' + JSON.stringify(t.task()));
}

/* ==================================================================== D */
console.log('--- D: QUESTION ---');
{
  const t = boot();
  t.showPanel('data-question-key', 'question:1', QUESTION_TEXT);
  check(t.word() === 'QUESTION', 'D the word is QUESTION -> ' + t.word(), 'D the word was ' + JSON.stringify(t.word()));
  check(t.state() === 'question', 'D the plate carries data-state=question', 'D the plate state was ' + JSON.stringify(t.state()));
  check(t.raised.length === 0, 'D looking at DSH: plate only, no OS toast', 'D a question toasted while you were reading the plate');
  t.clock.advance(PENDING_FULL_MS + 100);
  check(t.edgeState() === 'question', 'D the bar is coloured for a question -> ' + t.edgeState(), 'D the bar state was ' + JSON.stringify(t.edgeState()));
}
{
  const t = boot();
  t.setHidden(true);
  t.showPanel('data-question-key', 'question:1', QUESTION_TEXT);
  check(t.raised.length === 1 && t.raised[0].title === '等待你回答', 'D away: it notifies with the question title -> ' + (t.raised[0] || {}).title, 'D the question did not notify while away');
}
{
  // The plan-review panel is a different attribute but the same "someone is
  // waiting on you" state.
  const t = boot();
  t.showPanel('data-plan-review-key', 'plan:1', QUESTION_TEXT);
  check(t.word() === 'QUESTION', 'D a plan-review panel also reads as QUESTION -> ' + t.word(), 'D plan-review was not recognised: ' + JSON.stringify(t.word()));
  check(t.state() === 'question', 'D with the question accent', 'D the state was ' + JSON.stringify(t.state()));
}
{
  // The composer's action labels are stripped, so the line is the question itself.
  const t = boot();
  t.showPanel('data-question-key', 'question:1', QUESTION_TEXT);
  const detail = t.task();
  check(detail.indexOf('确认执行') < 0 && detail.indexOf('跳过本题') < 0, 'D the composer action labels are stripped -> ' + detail, 'D the detail kept the button copy: ' + JSON.stringify(detail));
  check(detail.indexOf('要用哪个方案') >= 0, 'D the question text survives', 'D the question text was stripped away: ' + JSON.stringify(detail));
}
{
  // The line is a plain-text HUD: it does not interpret Markdown, so `**bold**`
  // would show up as literal asterisks. Paired emphasis is stripped — and ONLY
  // paired, because `*.png`, `2*3` and `file_name` are real text that a blanket
  // "delete the punctuation" rule would corrupt.
  const t = boot();
  t.showPanel('data-question-key', 'question:1', '请确认 **这个方案** 是否可以');
  const detail = t.task();
  check(detail.indexOf('*') < 0, 'D paired Markdown emphasis is stripped -> ' + detail, 'D literal asterisks reached the plate: ' + JSON.stringify(detail));
  check(detail.indexOf('这个方案') >= 0, 'D and the emphasised words survive', 'D stripping ate the content: ' + JSON.stringify(detail));
}
{
  // Control: the stripper must not touch text that merely CONTAINS those
  // characters. Without this, "strip punctuation" would pass the test above.
  const t = boot();
  t.showPanel('data-question-key', 'question:1', '排除 *.png 和 2*3 还有 file_name');
  const detail = t.task();
  check(detail.indexOf('*.png') >= 0, 'D a glob pattern survives the stripper -> ' + detail, 'D the stripper mangled *.png: ' + JSON.stringify(detail));
  check(detail.indexOf('2*3') >= 0, 'D so does a multiplication sign', 'D the stripper mangled 2*3: ' + JSON.stringify(detail));
  check(detail.indexOf('file_name') >= 0, 'D and an underscore identifier (underscores are never touched)', 'D the stripper mangled file_name: ' + JSON.stringify(detail));
}
{
  // The submit button lives at the END of the panel's DOM order, and its label
  // (`提交`, from DSH's shared vocabulary) is also an ordinary word. So it is cut
  // only as a TRAILING suffix.
  const t = boot();
  t.showPanel('data-question-key', 'question:1', '这条提示看得清吗提交');
  const detail = t.task();
  check(detail === '这条提示看得清吗', 'D a trailing button label is cut -> ' + JSON.stringify(detail), 'D the trailing label survived: ' + JSON.stringify(detail));
}
{
  // Control: the SAME word in the middle of a question must survive — otherwise
  // "strip the button label" would be indistinguishable from "delete the word".
  const t = boot();
  t.showPanel('data-question-key', 'question:1', '提交前要检查什么');
  const detail = t.task();
  check(detail.indexOf('提交') === 0, 'D but the same word inside the question is left alone -> ' + JSON.stringify(detail), 'D the stripper ate a meaningful word: ' + JSON.stringify(detail));
}

/* ==================================================================== E */
console.log('--- E: several pendings at once ---');
{
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + 200);
  check(t.edges().length === 1, 'E first pending collapsed to the bar', 'E first pending did not collapse');
  t.showPanel('data-question-key', 'question:1', QUESTION_TEXT);
  check(t.livePlates().length === 1, 'E a NEW pending re-expands the full plate', 'E a new pending stayed as a bar');
  check(t.word() === 'QUESTION', 'E the plate shows the newest pending -> ' + t.word(), 'E the plate showed ' + JSON.stringify(t.word()));
  check(t.edgeState() === 'question', 'E the anchor bar follows the newest -> ' + t.edgeState(), 'E the bar state was ' + JSON.stringify(t.edgeState()));
  // Close the newest: the older one is still open, so the bar must come back —
  // and the plate must NOT keep showing the item that is gone.
  t.close('question:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.livePlates().length === 0, 'E closing the newest drops the plate', 'E the plate outlived its panel');
  check(t.edges().length === 1, 'E the older pending keeps the bar up', 'E the bar disappeared while a pending was still open');
  check(t.edgeState() === 'approval', 'E and the bar reflects the one still open -> ' + t.edgeState(), 'E the bar state was ' + JSON.stringify(t.edgeState()));
  t.close('approval:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.edges().length === 0, 'E closing the last one clears the bar entirely', 'E the bar outlived every pending');
}

/* ==================================================================== F */
console.log('--- F: ERROR (from the session snapshot) ---');
{
  const t = boot();
  t.sessionA.patch({ lastAgentError: '模型网关 502' });
  check(t.livePlates().length === 1, 'F an error raises a plate', 'F no plate for the error');
  check(t.word() === 'ERROR', 'F the word is ERROR -> ' + t.word(), 'F the word was ' + JSON.stringify(t.word()));
  check(t.task() === '模型网关 502', 'F the detail carries the message', 'F the detail was ' + JSON.stringify(t.task()));
  check(t.state() === 'error', 'F the plate carries data-state=error', 'F the plate state was ' + JSON.stringify(t.state()));
  check(t.raised.length === 0, 'F looking at DSH: the plate carries it, no OS toast', 'F an error toasted while you were reading the plate');

  t.clock.advance(TOAST_MS + EXIT_MS + 100);
  check(t.plates().length === 0, 'F an error plate is transient (it leaves)', 'F the error plate never left');
  t.sessionA.patch({ lastAgentError: '模型网关 502' });       // same sticky value again
  check(t.livePlates().length === 0, 'F the same message does not re-fire (lastAgentError is sticky)', 'F a sticky error re-fired on every publish');
  t.sessionA.patch({ lastAgentError: '换了一个错' });
  check(t.word() === 'ERROR', 'F a NEW message does fire again', 'F a changed error was swallowed');
}
{
  const t = boot();
  t.setHidden(true);
  t.sessionA.patch({ lastAgentError: '模型网关 502' });
  check(t.raised.length === 1, 'F away: the error reaches the OS channel', 'F an error was silent while away');
  check(t.raised[0] && t.raised[0].title === '任务出错', 'F its title says 任务出错, not 任务完成 -> ' + (t.raised[0] || {}).title, 'F the error notification said ' + JSON.stringify((t.raised[0] || {}).title));
  check(t.raised[0] && t.raised[0].body === '模型网关 502', 'F its body carries the message', 'F the body was ' + JSON.stringify((t.raised[0] || {}).body));
  check(t.documentStub.title === '● DSH', 'F and the title bar keeps the badge', 'F no badge while away');
}
{
  // Baseline: arriving on a session that ALREADY carries an old error is silent.
  const t = boot({ agentError: '很久以前的错误' });
  check(t.livePlates().length === 0, 'F an error that predates the visit is not re-announced', 'F a stale error was announced on arrival');
  t.sessionA.patch({ lastAgentError: '刚刚才出错的' });
  check(t.word() === 'ERROR', 'F but a NEW error after arrival does fire', 'F a new error was swallowed as a baseline');
}

/* ==================================================================== G */
console.log('--- G: UNOPENED ---');
{
  const t = boot();
  t.sessionA.patch({ openState: 'loading' });
  check(t.livePlates().length === 0, 'G loading is not an error', 'G loading raised a plate');
  t.sessionA.patch({ openState: 'error', openError: { code: 'session/not-found' } });
  check(t.word() === 'UNOPENED', 'G a failed open raises UNOPENED -> ' + t.word(), 'G the word was ' + JSON.stringify(t.word()));
  check(t.state() === 'unopened', 'G the plate state is unopened -> ' + t.state(), 'G the state was ' + JSON.stringify(t.state()));
  const css = t.cssText();
  const rule = /\[data-task-toast\]\[data-state="unopened"\]\s*\{([^}]*)\}/.exec(css);
  const errRule = /\[data-task-toast\]\[data-state="error"\]\s*\{([^}]*)\}/.exec(css);
  check(rule !== null, 'G a CSS rule exists for the unopened accent', 'G no CSS rule for data-state="unopened" — it would fall back to the theme accent');
  check(rule !== null && errRule !== null && rule[1].trim() === errRule[1].trim(), 'G it reuses the error accent verbatim', 'G the unopened accent drifted from the error accent');
  t.clock.advance(TOAST_MS + EXIT_MS + 100);
  t.sessionA.patch({ openState: 'error' });
  check(t.livePlates().length === 0, 'G re-publishing the error state does not re-fire (transition, not state)', 'G a permanent state re-fired forever');
}

/* ==================================================================== H */
console.log('--- H: SUBAGENT ---');
{
  const t = boot();
  t.endTurn();
  check(t.word() === 'COMPLETE', 'H with no children the word stays COMPLETE -> ' + t.word(), 'H the word was ' + JSON.stringify(t.word()));
  t.clock.advance(TOAST_MS + EXIT_MS + 100);
  t.child('child-1', true);
  t.endTurn();
  check(t.word() === 'SUBAGENT', 'H a turn ending while children run says SUBAGENT, not COMPLETE -> ' + t.word(), 'H the word was ' + JSON.stringify(t.word()));
  check(t.task() === '我的会话标题', 'H the detail line is still the session title', 'H the detail was ' + JSON.stringify(t.task()));
  t.clock.advance(TOAST_MS + EXIT_MS + 100);
  t.child('child-1', false);
  t.endTurn();
  check(t.word() === 'COMPLETE', 'H once children stop it is COMPLETE again -> ' + t.word(), 'H the word was ' + JSON.stringify(t.word()));
}
{
  const t = boot();
  const byId = Object.assign({}, t.list.getSnapshot().byId);
  byId.other = { id: 'other', parentId: 'some-other-session', running: true };
  t.list.set(Object.assign({}, t.list.getSnapshot(), { byId }));
  t.endTurn();
  check(t.word() === 'COMPLETE', 'H an unrelated session\'s running child does not count', 'H a foreign child was counted as ours');
}

/* ==================================================================== M */
/* 跨会话：别人跑完了也要报。改之前只盯当前会话 —— 你一切走，原来那个会话跑完是静默的，
   而且切回去也不会补（重新绑定会把当时的 running 当成新基线）。 */
console.log('--- M: other sessions report too ---');
{
  const t = boot();
  t.setHidden(true);   // 走开：板子照样发，系统通知该走 OS 通道
  t.row('b', { displayTitle: '另一个会话', running: true });
  check(t.livePlates().length === 0, 'M first sight of a running session is a baseline, not an event', 'M the plugin reported a session that was already running when the page loaded');
  t.row('b', { displayTitle: '另一个会话', running: false });
  check(t.word() === 'COMPLETE' && t.task() === '另一个会话', 'M a background session finishing reports COMPLETE with ITS title -> ' + t.word() + ' / ' + t.task(), 'M it reported ' + JSON.stringify([t.word(), t.task()]));
  check(t.raised.length === 1 && t.raised[0].sessionId === 'b' && t.raised[0].tag.indexOf('b') >= 0, 'M the OS toast carries the reported session id, so click-to-focus lands on THAT session', 'M the toast kept the current session id: clicking it would open the wrong session');
  t.row('b', { displayTitle: '另一个会话', running: false });
  check(t.raised.length === 1, 'M publishing the same running=false again does not re-fire', 'M a steady state re-fired forever');
}
{
  const t = boot();
  t.setHidden(true);
  t.sessionA.patch({ running: true });
  t.clock.advance(150);
  t.row('a', { displayTitle: '我的会话标题', running: true });
  const before = t.raised.length;
  t.sessionA.patch({ running: false });
  t.clock.advance(150);
  t.row('a', { displayTitle: '我的会话标题', running: false });
  check(t.raised.length - before === 1, 'M ending the CURRENT session reports exactly once (the row path stays out of it) -> ' + (t.raised.length - before), 'M the current session was reported twice: the row path duplicated the session subscription');
}
{
  const t = boot();
  t.row('b', { displayTitle: '另一个会话', running: false });
  t.list.set(Object.assign({}, t.list.getSnapshot(), { current: 'b' }));
  t.row('a', { displayTitle: '我的会话标题', running: true });
  t.row('a', { displayTitle: '我的会话标题', running: false });
  check(t.task() === '我的会话标题', 'M a session that finishes AFTER you switched away is still reported -> ' + t.task(), 'M switching away swallowed the completion - the bug this section exists for');
}
{
  const t = boot();
  t.child('child-1', true);
  t.child('child-1', false);
  check(t.livePlates().length === 0, 'M a subagent session finishing is not reported on its own', 'M a child session produced its own plate on top of the parent SUBAGENT');
}

/* ==================================================================== N */
/* 跨会话的挂起：别的会话在等授权/等回答时，DOM 里没有它的面板，只能走官方事件流。
   分工同样划开 —— 当前会话仍由 DOM 负责，事件流只管别的会话，同一个挂起不会被报两遍。 */
console.log('--- N: pendings from other sessions ($events stream) ---');
const FRAME_APPROVAL = (agentId, eventId) => JSON.stringify({
  type: 'item', streamId: 'x', value: {
    type: 'waterfall', event: 'approval/request', eventId, agentId,
    request: { toolName: 'Bash', reason: '工具 Bash 请求越权执行' },
  },
});
const FRAME_QUESTION = (agentId, eventId) => JSON.stringify({
  type: 'item', streamId: 'x', value: {
    type: 'waterfall', event: 'user-questions/request', eventId, agentId,
    request: { questions: [{ id: 'q1', question: '要用哪个方案？', header: '选择' }] },
  },
});
const FRAME_CANCEL = (eventId) => JSON.stringify({
  type: 'item', streamId: 'x', value: { type: 'cancel', eventId },
});
{
  const t = boot();
  check(t.wsInstances.length === 1, 'N it opens one mux socket', 'N no mux socket was opened');
  t.ws().onopen();
  check(t.ws().sent.length === 1
    && t.ws().sent[0].indexOf('endpoint') >= 0
    && t.ws().sent[0].indexOf('events') >= 0
    && t.ws().sent[0].indexOf('args') >= 0,
    'N on open it subscribes to the forwarded-events stream -> ' + t.ws().sent[0],
    'N the open frame did not subscribe to the events stream');
  t.ws().onmessage({ data: FRAME_QUESTION('b', 'ev-1') });
  check(t.word() === 'QUESTION', 'N a question for ANOTHER session pops a plate -> ' + t.word(), 'N the word was ' + JSON.stringify(t.word()));
  check(t.task() === '要用哪个方案？', 'N the detail line is that question -> ' + t.task(), 'N the detail was ' + JSON.stringify(t.task()));
  check(t.edgeState() === 'question', 'N and the edge bar is coloured for a question -> ' + t.edgeState(), 'N the edge state was ' + JSON.stringify(t.edgeState()));
  t.ws().onmessage({ data: FRAME_CANCEL('ev-1') });
  check(t.edges().length === 0, 'N cancel takes the pending down entirely', 'N a cancelled pending left its edge behind');
  check(t.livePlates().length === 0, 'N and its plate with it', 'N a cancelled pending left its plate behind');
}
{
  const t = boot();
  t.ws().onopen();
  t.ws().onmessage({ data: FRAME_APPROVAL('b', 'ev-2') });
  check(t.word() === 'APPROVAL' && t.task() === '工具 Bash 请求越权执行',
    'N an approval for another session reports tool + reason -> ' + t.word() + ' / ' + t.task(),
    'N it reported ' + JSON.stringify([t.word(), t.task()]));
}
{
  const t = boot();
  t.ws().onopen();
  // 当前会话的挂起归 DOM 那条路：事件流再报一遍就是两块板子、两条细边
  t.ws().onmessage({ data: FRAME_QUESTION('a', 'ev-3') });
  check(t.livePlates().length === 0 && t.edges().length === 0,
    'N an event for the CURRENT session is ignored (the DOM path owns it)',
    'N the current session got a second, event-driven pending');
}
{
  const t = boot();
  t.ws().onopen();
  t.ws().onmessage({ data: 'this is not json' });
  t.ws().onmessage({ data: JSON.stringify({ type: 'item', value: { type: 'waterfall', event: 'approval/request' } }) });
  t.ws().onmessage({ data: JSON.stringify({ type: 'nonsense' }) });
  check(t.livePlates().length === 0, 'N malformed frames and frames with no agentId are ignored, not thrown', 'N a malformed frame produced a plate (or threw)');
  t.ws().onclose();
  t.clock.advance(2000);
  check(t.wsInstances.length === 2, 'N a dropped connection is retried with backoff -> ' + t.wsInstances.length, 'N the stream was never retried after a drop');
}
{
  const t = boot();
  t.ws().onopen();
  t.ws().onmessage({ data: FRAME_QUESTION('b', 'ev-9') });
  const sock = t.ws();
  t.teardown()();
  check(sock.closed === true, 'N teardown closes the mux socket', 'N the socket stayed open after teardown');
  check(sock.onmessage === null, 'N and unhooks its handlers', 'N the handlers survived teardown');
  check(t.plates().length === 0 && t.edges().length === 0, 'N teardown clears the pendings it owned', 'N a teardown left an orphaned edge on screen');
}
{
  const t = boot();
  // 你正看着某个挂起时切走：面板卸载不能让它从屏幕上消失
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(300);
  check(t.edges().length === 1 && t.word() === 'APPROVAL', 'O a pending you are reading is on screen', 'O the approval never showed up');
  // 切到另一个会话：b 没有可绑定的 face，插件会退化成没有当前会话
  t.row('b', { displayTitle: '另一个会话', running: false });
  t.list.set(Object.assign({}, t.list.getSnapshot(), { current: 'b' }));
  t.clock.advance(60);
  t.closePanel('approval:1');      // 面板随会话切换卸载
  t.clock.advance(300);
  check(t.edges().length === 1, 'O it survives the switch: an unmounting panel must not erase a pending that is still open -> edges=' + t.edges().length, 'O switching away erased the pending - the bug this section exists for');
  // 切回去：DOM 重新接管，搬运的那条撤掉；面板已经不在了，所以细边应当随之消失
  t.list.set(Object.assign({}, t.list.getSnapshot(), { current: 'a' }));
  t.clock.advance(300);
  check(t.edges().length === 0, 'O and switching back hands it over to the DOM path (no double bookkeeping) -> edges=' + t.edges().length, 'O the carried copy outlived the handover: two records for one pending');
}
console.log('--- N done ---');

/* ==================================================================== I */
console.log('--- I: priority — a pending outranks a transient plate ---');
{
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  const before = t.raised.length;
  t.sessionA.patch({ lastAgentError: '期间出错了' });
  check(t.word() === 'APPROVAL', 'I the pending plate is not replaced by an error', 'I the error stole the plate from a pending state');
  // PINNED CONTRACT (a deliberate trade, not an accident): while a pending plate
  // owns the screen, a transient state is dropped from BOTH local channels — the
  // plate is held by the pending, and the OS toast is suppressed because you are
  // demonstrably looking. DSH's own transcript still shows the error.
  check(t.raised.length === before, 'I while a pending holds the plate, the transient costs no OS toast', 'I a transient toasted on top of a pending');
  t.close('approval:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.livePlates().length === 0, 'I once closed, nothing is left over', 'I something survived the close');
}

/* ==================================================================== J */
console.log('--- J: teardown ---');
{
  const t = boot();
  check(t.observeCalls() === 1, 'J the DOM is observed exactly once', 'J observe() was called ' + t.observeCalls() + ' time(s)');
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + 100);
  check(t.edges().length === 1, 'J a bar is up before teardown', 'J no bar to clean up');
  t.teardown()();
  check(t.disconnectCalls() === 1, 'J the observer is disconnected', 'J the MutationObserver leaked');
  check(t.edges().length === 0, 'J teardown removes the edge bar', 'J the bar outlived the plugin');
  check(t.plates().length === 0, 'J teardown removes the plate', 'J the plate outlived the plugin');
  // A mutation after teardown must not resurrect anything.
  const raisedBefore = t.raised.length;
  t.showPanel('data-approval-key', 'approval:2', APPROVAL_TEXT);
  check(t.plates().length === 0 && t.edges().length === 0 && t.raised.length === raisedBefore, 'J nothing comes back after teardown', 'J a detached plugin still reacted to the DOM');
}

/* ==================================================================== K */
console.log('--- K: degraded DOM ---');
{
  // No MutationObserver at all: the mount-time scan still catches an open panel,
  // and nothing throws.
  const t = boot({ mutationObserver: false });
  let threw = false;
  try { t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT) } catch (e) { threw = true; fail('K threw without a MutationObserver: ' + e.message) }
  if (!threw) pass('K no MutationObserver: no throw');
  check(t.observeCalls() === 0, 'K and of course nothing was observed', 'K observe() ran without an observer');
  check(t.livePlates().length === 0, 'K a panel appearing later is simply missed (documented degradation)', 'K something was detected without an observer');
  // ...but coming back into view re-scans, which is the recovery path.
  t.setHidden(true);
  t.setHidden(false);
  check(t.word() === 'APPROVAL', 'K returning to the foreground re-scans and finds it -> ' + t.word(), 'K the visibility re-scan did not find the open panel');
}
{
  // A panel that is ALREADY open when the plugin mounts (a reload with an approval
  // on screen) must be picked up by the mount scan — no event will ever fire for it.
  const t = boot({ prePanel: { attr: 'data-approval-key', key: 'approval:1', text: APPROVAL_TEXT } });
  check(t.panels.length === 1, 'K the pre-existing panel is in the DOM before apply (harness sanity)', 'K the pre-mount panel was not registered');
  check(t.livePlates().length === 1, 'K a panel present at mount is detected by the mount scan', 'K a pre-existing panel was missed');
  check(t.word() === 'APPROVAL', 'K and it reads correctly -> ' + t.word(), 'K the mounted plate said ' + JSON.stringify(t.word()));
}

/* ==================================================================== L */
/* The bar itself: visible enough to notice, and hoverable.
   The user's verdict on the shipped version was "不明显" and "想鼠标移上去看看",
   so both properties are pinned here rather than left to taste. */
console.log('--- L: the anchor bar — size and hover-to-peek ---');
{
  const t = boot();
  const css = t.cssText();
  const edgeRule = /\[data-task-toast-edge\]\s*\{([\s\S]*?)\}/.exec(css);
  const slipRule = /\[data-task-toast-edge\]::after\s*\{([\s\S]*?)\}/.exec(css);
  check(edgeRule !== null && slipRule !== null, 'L both bar rules are present (harness sanity)', 'L could not find the bar CSS rules');
  // Mirror check: the harness's own copies of the shipped numbers, so a silent
  // change in the plugin fails here until it is acknowledged.
  check(slipRule !== null && slipRule[1].indexOf('width: ' + EDGE_W + 'px') >= 0 && slipRule[1].indexOf('var(--tt-edge-h, ' + EDGE_H + 'px)') >= 0,
    'L the slip is ' + EDGE_W + ' wide with a ' + EDGE_H + 'px fallback height', 'L the slip geometry is not the expected shape');
  // INVARIANT checks read the REAL numbers out of the plugin source. Asserting an
  // invariant against the harness's own copies proves nothing about the plugin —
  // a mutant of EDGE_HIT_W survived exactly that way before this was fixed.
  const srcNum = (name) => {
    const m = new RegExp('const ' + name + '\\s*=\\s*(-?\\d+)').exec(src);
    return m === null ? NaN : Number(m[1]);
  };
  const pW = srcNum('EDGE_W'), pH = srcNum('EDGE_H'), pHit = srcNum('EDGE_HIT_W'), pEdge = srcNum('EDGE'), pTop = srcNum('TOP_GAP'), pPad = srcNum('EDGE_HIT_PAD');
  check(!isNaN(pW) && !isNaN(pH) && !isNaN(pHit) && !isNaN(pEdge) && !isNaN(pTop) && !isNaN(pPad),
    'L the geometry constants are readable from the source (harness sanity)', 'L could not read the geometry constants — the invariants below would be vacuous');
  const pulse = /@keyframes tt-edge\s*\{([\s\S]*?)\}/.exec(css);
  check(pulse !== null && /opacity:\s*\.5/.test(pulse[1]), 'L the pulse floor was raised off near-invisible (.28 -> .5)', 'L the pulse still fades to almost nothing');
  /* ALIGNMENT — the thing the user actually caught. The bar used to start at the
     viewport corner (top:0) while the plate starts EDGE down, so it stuck out a
     whole EDGE above it. Both now share the plate's top edge, and the hit area's
     extra padding is subtracted so the VISIBLE slip lands exactly on it. */
  check(edgeRule !== null && /top:\s*calc\(/.test(edgeRule[1]) && edgeRule[1].indexOf(pTop + 'px') >= 0,
    'L the bar starts at the plate top edge (' + pTop + 'px), not at the viewport corner', 'L the bar is still pinned to the corner: it will stick out above the plate');
  check(slipRule !== null && new RegExp('top:\\s*' + pPad + 'px').test(slipRule[1]),
    'L the visible slip is inset by the hit padding, so the padding cancels out', 'L the visible slip is not offset by the hit padding — it would sit ' + pPad + 'px low');
  // Hoverability: the pointer target must be WIDER than the visible slip, and the
  // plate's inset must clear it — otherwise the plate lands under the pointer, the
  // peek ends the instant it begins, and it flickers.
  check(pHit > pW, 'L the pointer target (' + pHit + 'px) is wider than the slip (' + pW + 'px), or it cannot be hit', 'L the pointer target ' + pHit + ' is no wider than the slip ' + pW);
  check(pEdge > pHit, 'L the plate inset (' + pEdge + 'px) clears the pointer target (' + pHit + 'px) — no overlap, so no flicker', 'L the plate would land under the pointer: hovering would flicker');
  check(css.indexOf('pointer-events: auto') >= 0, 'L the bar accepts the pointer', 'L the bar still ignores the pointer');
  const plateRule = /\[data-task-toast\]\s*\{([\s\S]*?)\}/.exec(css);
  check(plateRule !== null && /pointer-events:\s*none/.test(plateRule[1]), 'L while the plate itself stays transparent to clicks', 'L the plate became click-blocking');
  /* The vertical gap moved off EDGE once window controls started sitting ON TOP of the
     page: on a 2K machine the plate clipped the titlebar close button. Two things must
     hold — the gap must clear the tallest common caption row (48 CSS px at 150% OS
     scaling), and plate + bar must share the SAME vertical constant or they split into
     two objects again (the exact misalignment the user caught once already). */
  check(!isNaN(pTop) && pTop >= 48, 'L the top gap (' + pTop + 'px) clears a Windows caption row even at 150% scaling', 'L the top gap is under 48px: the plate will clip the window controls again');
  check(plateRule !== null && new RegExp('top:\\s*' + pTop + 'px').test(plateRule[1]),
    'L the plate starts ' + pTop + 'px from the top', 'L the plate top is not the new gap');
  check(edgeRule !== null && edgeRule[1].indexOf(pTop + 'px') >= 0 && edgeRule[1].indexOf(pEdge + 'px') < 0,
    'L the bar shares the plate vertical gap (' + pTop + 'px), not the horizontal inset', 'L the bar and the plate no longer share a top edge');
  // The pulse moved onto ::after; a reduced-motion rule aimed at the old selector
  // would silently stop working.
  check(/prefers-reduced-motion[\s\S]*\[data-task-toast-edge\]::after\s*\{\s*animation:\s*none/.test(css),
    'L reduced-motion still disables the breathing (it moved to ::after)', 'L the reduced-motion rule is aimed at the old selector and does nothing');
}
{
  /* The bar adopts the plate's MEASURED height. A hardcoded length drifts the moment
     the plate's own height changes (font, theme, wording) and the two read as two
     separate objects — which is exactly what the user saw. */
  const t = boot({ plateHeight: 146 });
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  const bar = t.edges()[0];
  check(bar !== undefined, 'L the bar exists after the collapse', 'L no bar to measure');
  const h = bar === undefined ? '' : bar.style.getPropertyValue('--tt-edge-h');
  check(h === '146px', 'L the bar takes the measured plate height (' + h + ')', 'L the bar height var was ' + JSON.stringify(h));
  check(src.indexOf("height: var(--tt-edge-h") >= 0, 'L and the CSS actually consumes that variable', 'L the variable is written but the CSS ignores it — the bar would use the fallback');
}
{
  // No measurable height (the harness's default): fall back rather than write junk.
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  const bar = t.edges()[0];
  const h = bar === undefined ? '' : bar.style.getPropertyValue('--tt-edge-h');
  check(h === '', 'L with no measurement the variable is left unset (CSS fallback takes over)', 'L wrote a bogus height var: ' + JSON.stringify(h));
}
{
  // Hover: collapse, point at it, it comes back; move away, it goes again.
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  check(t.livePlates().length === 0 && t.edges().length === 1, 'L collapsed to the bar after the announcement', 'L the plate never collapsed');
  check(t.hover(true), 'L the bar is there to point at', 'L no bar to hover');
  check(t.livePlates().length === 1, 'L pointing at it brings the plate back', 'L hovering did nothing');
  check(t.word() === 'APPROVAL', 'L and it shows what is waiting -> ' + t.word(), 'L the peek showed ' + JSON.stringify(t.word()));
  check(t.edges().length === 1, 'L with the bar still in place (the pointer never leaves it)', 'L the hover target vanished under the pointer');
  t.hover(false);
  check(t.livePlates().length === 0, 'L moving away puts it back to just the bar', 'L the plate stayed after the pointer left');
  check(t.edges().length === 1, 'L and the bar is still there', 'L the bar disappeared with the plate');
}
{
  // The hover target must be the SAME node before and after an announcement: an
  // element swapped out from under the pointer never fires mouseleave, which would
  // strand the hover flag at true and make the bar ignore the pointer forever.
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  const first = t.edges()[0];
  t.clock.advance(PENDING_FULL_MS + EXIT_MS + 200);
  const after = t.edges()[0];
  check(first !== undefined && first === after, 'L the hover target survives the collapse unchanged', 'L the bar node was replaced — the pointer would be stranded');
  // A second arrival must not replace it either.
  t.showPanel('data-question-key', 'question:1', QUESTION_TEXT);
  check(t.edges()[0] === after, 'L and survives another arrival too', 'L a new arrival replaced the hover target');
}
{
  // Hovering during an announcement must not be cut short by the collapse timer,
  // and leaving must then collapse it (otherwise the peek sticks forever).
  const t = boot();
  t.showPanel('data-approval-key', 'approval:1', APPROVAL_TEXT);
  t.hover(true);
  t.clock.advance(PENDING_FULL_MS + 500);
  check(t.livePlates().length === 1, 'L the collapse timer will not snatch it away while you are pointing at it', 'L the timer collapsed it under the pointer');
  t.hover(false);
  check(t.livePlates().length === 0, 'L and leaving then collapses it (the peek cannot stick)', 'L the peek stuck after the pointer left');
  check(t.edges().length === 1, 'L leaving the bar in place, still pending', 'L the bar was lost');
  // The pending is still there: hovering again works.
  check(t.hover(true) && t.livePlates().length === 1, 'L pointing at it again still works', 'L the second hover did nothing');
  t.close('approval:1');
  t.clock.advance(SCAN_DEBOUNCE + 10);
  check(t.edges().length === 0, 'L answering it takes the bar down even while hovered', 'L the bar outlived the pending');
}

console.log('');
if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('all multi-state checks passed');
