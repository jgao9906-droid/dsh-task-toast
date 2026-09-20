'use strict';
/**
 * verify-notify.js — behavioural proof for the three notification channels of
 * dsh-task-toast, run before anything is installed.
 *
 * The in-page plate and the edge detection are already covered by
 * verify-toast.js. This file covers what was added for "notify me while I am in
 * another application":
 *
 *   10  permission 'granted'   -> OS notification raised, with the session title
 *   11  title badge            -> ● prefix on turn end, removed on window focus
 *   12  permission 'default'   -> the one-shot ask appears AFTER the plate has
 *                                 gone; it is asked once, never twice
 *   13  the ask's 开启 button   -> calls requestPermission() (the click IS the
 *                                 gesture), records the answer, removes itself
 *   14  permission 'denied'    -> no ask, no notification, no nagging
 *   15  OS_NOTIFY off is not tested here (it is a compile-time constant), but
 *       the channel independence is: a denied/absent Notification must never
 *       stop the in-page plate from appearing.
 *
 * Usage: node verify-notify.js [path-to-client.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Defaults to the client half sitting next to this file, so a fresh clone can run
   `node verify-notify.js` with no arguments and no local paths baked in. */
const TARGET = process.argv[2] || path.join(__dirname, 'client.js');
const src = fs.readFileSync(TARGET, 'utf8');

let failures = 0;
const pass = (m) => console.log('ok    ' + m);
const fail = (m) => { console.error('FAIL  ' + m); failures++; };

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
    /* Move wall-clock time WITHOUT running any due timer. This is the only way to
       model a starved timer — a hidden page clamps timeouts, so real time passes
       while the callback does not run. advance() cannot express that. */
    starve(ms) { now += ms; },
  };
}

/* ------------------------------------------------------------------ DOM */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, style: {}, className: '', innerHTML: '',
    parentNode: null, textContent: '', _q: {}, _ev: {},
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
  const clock = makeClock();
  clock.reset();
  /* Date is pinned to the same clock as setTimeout. Without this the plugin's
     wall-clock reads (the plate's shown-at stamp) would be REAL time while its
     timers are fake time, and no deadline check could ever be exercised. */
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
  const documentStub = {
    body, head, documentElement: makeEl('html'),
    title: 'DSH',
    // The desktop shell's shim REDEFINES these on the document inside the DSH
    // iframe so they mirror the HOST window. The harness drives them the same
    // way, which is what lets the routing be tested at all.
    hidden: false,
    visibilityState: 'visible',
    createElement: (t) => makeEl(t),
    // showAsk() uses this to avoid a duplicate ask bar.
    querySelector: (sel) => (sel === '[data-task-ask]'
      ? (body.children.find((c) => c.hasAttribute && c.hasAttribute('data-task-ask')) || null)
      : null),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };

  const store = { _d: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };

  const raised = [];
  let requestCalls = 0;
  function NotificationStub(title, o) {
    raised.push({ title, body: (o && o.body) || '', tag: (o && o.tag) || '', sessionId: (o && o.sessionId) || '' });
    this.close = () => {};
    this.onclick = null;
  }
  NotificationStub.permission = opts.permission;
  NotificationStub.requestPermission = () => {
    requestCalls++;
    // Mimic a granted prompt answer so later turns take the OS path.
    NotificationStub.permission = 'granted';
    return { then(res) { if (typeof res === 'function') res('granted'); return this; } };
  };

  // All window events are recorded (not just focus) because the shim dispatches
  // a synthetic `visibilitychange`, and the title badge listens for both.
  const winHandlers = {};
  const windowObj = {
    __ModuleLoader__: null,
    addEventListener(ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    focus() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };

  const sessionA = (() => {
    let state = { running: false };
    const subs = new Set();
    return {
      getSnapshot: () => state,
      subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
      set(next) { state = next; for (const fn of [...subs]) fn(); },
    };
  })();
  const list = (() => {
    let state = { current: 'a', byId: { a: { displayTitle: '我的会话标题' } } };
    const subs = new Set();
    return {
      getSnapshot: () => state,
      subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
      set(next) { state = next; for (const fn of [...subs]) fn(); },
      ping() { for (const fn of [...subs]) fn(); },
    };
  })();
  const sessions = { list, binding: (id) => (id === 'a' ? { sessionId: id, session: sessionA } : undefined) };

  let loaded = null;
  const sandbox = {
    window: windowObj,
    document: documentStub,
    Notification: opts.notification === false ? undefined : NotificationStub,
    localStorage: opts.localStorage === false ? undefined : store,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: () => 0, clearInterval() {},
    Date: FakeDate,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  windowObj.document = documentStub;
  windowObj.__ModuleLoader__ = { load: (m) => { loaded = m; } };

  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'client.js' }).runInContext(sandbox);

  let teardown = null;
  const ctx = {
    get: (n) => (n === 'sessions' ? sessions : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') teardown = d; },
  };
  const mod = loaded.factory(() => null);
  mod.apply(ctx);

  const plates = () => body.children.filter((c) => c.hasAttribute && c.hasAttribute('data-task-toast'));
  const asks = () => body.children.filter((c) => c.hasAttribute && c.hasAttribute('data-task-ask'));

  return {
    clock, body, head, documentStub, raised, store,
    requestCalls: () => requestCalls,
    permission: () => NotificationStub.permission,
    fireWindow: (ev) => { for (const fn of (winHandlers[ev] || []).slice()) fn(); },
    // Mirror the host window becoming hidden / visible, exactly as the shell's
    // shim does: flip the two properties, then dispatch visibilitychange.
    setHidden(v) {
      documentStub.hidden = !!v;
      documentStub.visibilityState = v ? 'hidden' : 'visible';
      for (const fn of (winHandlers['visibilitychange'] || []).slice()) fn();
    },
    endTurn() { sessionA.set({ running: true }); clock.advance(150); sessionA.set({ running: false }); clock.advance(150); },
    plates, asks, mod, ctx, teardown: () => teardown,
    plateWord: (p) => (p._q['[data-task-toast-word]'] || {}).textContent,
  };
}

// Kept in step with client.js: TOAST_MS (now aligned to the Windows default) and
// ASK_AFTER_MS.
const TOAST_MS = 5000;
const ASK_AT = TOAST_MS + 600;
const EXIT_MS = 260;   // the plate's leave animation; mirrors client.js EXIT_MS

console.log('--- notification channels ---');

/* ---- 10: VISIBLE -> the plate, and NOT the OS toast ------------------- */
{
  const t = boot({ permission: 'granted' });
  t.endTurn();
  if (t.plates().length === 1) pass('10 visible -> in-page plate shown');
  else fail('10 visible -> expected a plate, found ' + t.plates().length);
  // WHICH task finished: the session title, straight from the session list row.
  const taskText = t.plates().length ? (t.plates()[0]._q['[data-task-toast-task]'] || {}).textContent : null;
  if (taskText === '我的会话标题') pass('10 plate names the finished task -> ' + taskText);
  else fail('10 task line was ' + JSON.stringify(taskText));
  if (t.raised.length === 0) pass('10 visible -> NO OS notification (it would just duplicate the plate)');
  else fail('10 visible -> ' + t.raised.length + ' OS notification(s) fired anyway');
  if (t.documentStub.title === 'DSH') pass('10 visible -> no title badge either');
  else fail('10 visible -> title was ' + JSON.stringify(t.documentStub.title));
  if (t.asks().length === 0) pass('10 granted -> never asks for permission');
  else fail('10 asked even though permission was granted');
  t.clock.advance(TOAST_MS + 400);
  if (t.plates().length === 0) pass('10 plate auto-dismisses after TOAST_MS');
  else fail('10 plate outlived TOAST_MS');
}

/* ---- 11: HIDDEN -> the OS toast AND the plate (the plate is unconditional) --- */
{
  const t = boot({ permission: 'granted' });
  t.setHidden(true);
  t.endTurn();
  if (t.raised.length === 1) pass('11 hidden -> exactly one OS notification');
  else fail('11 hidden -> expected 1 OS notification, got ' + t.raised.length);
  const n = t.raised[0] || {};
  if (n.title === '任务完成') pass('11 notification title is 任务完成');
  else fail('11 notification title was ' + JSON.stringify(n.title));
  if (n.body === '我的会话标题') pass('11 notification body carries the session title');
  else fail('11 body was ' + JSON.stringify(n.body));
  // The tag is a CONTRACT with the Tauri desktop shell: its notification shim
  // recovers the session id from the tag with EXACTLY this pattern, and uses it
  // to focus the right session when the notification is clicked. A tag that
  // does not match still notifies — but the click goes nowhere, silently.
  const DSH_TAG_RE = /^dsh-notification-(?:pending-)?(.+)-\d+$/;
  const tagMatch = DSH_TAG_RE.exec(n.tag || '');
  if (tagMatch && tagMatch[1] === 'a') pass('11 tag yields the session id -> ' + n.tag);
  else fail('11 tag does not match the shell pattern: ' + JSON.stringify(n.tag));
  if (n.sessionId === 'a') pass('11 sessionId also passed explicitly (both channels)');
  else fail('11 sessionId option was ' + JSON.stringify(n.sessionId));
  // The plate is the PRIMARY channel and is no longer gated on visibility: it
  // goes up whether or not you are looking, because suppressing it is how the
  // popup silently stopped appearing at all.
  if (t.plates().length === 1) pass('11 hidden -> the plate is rendered anyway (primary channel)');
  else fail('11 hidden -> expected a plate, got ' + t.plates().length);
  if (t.plateWord(t.plates()[0]) === 'COMPLETE') pass('11 hidden -> the plate still carries the word');
  else fail('11 hidden plate word was ' + JSON.stringify(t.plateWord(t.plates()[0])));
  if (t.documentStub.title === '● DSH') pass('11 title badge applied while away');
  else fail('11 title was ' + JSON.stringify(t.documentStub.title));

  // Coming back must clear the badge. This plate still has most of its life left,
  // so it must survive the return — see case 17 for the overdue counterpart.
  t.setHidden(false);
  if (t.documentStub.title === 'DSH') pass('11 title badge cleared on return');
  else fail('11 title after returning was ' + JSON.stringify(t.documentStub.title));
  t.clock.advance(TOAST_MS + 100);            // let the first plate finish its life
  const raisedBefore = t.raised.length;
  t.endTurn();
  if (t.plates().length === 1 && t.raised.length === raisedBefore) pass('11 back and visible -> plate again, no extra OS toast');
  else fail('11 after returning: plates=' + t.plates().length + ' raised=' + t.raised.length);
}

/* ---- 12/13: default -> the one-shot ask, then 开启 ------------------- */
{
  const t = boot({ permission: 'default' });
  t.endTurn();
  if (t.raised.length === 0) pass('12 default -> no OS notification yet');
  else fail('12 raised a notification without permission');
  if (t.asks().length === 0) pass('12 the ask does NOT appear while the plate is up');
  else fail('12 the ask overlapped the plate');

  t.clock.advance(ASK_AT + 400);
  if (t.asks().length === 1) pass('12 the ask appears after the plate has gone');
  else fail('12 expected 1 ask bar, got ' + t.asks().length);
  if (t.requestCalls() === 0) pass('12 no permission request until the user clicks');
  else fail('12 requested permission without a user gesture');

  const ask = t.asks()[0];
  ask.querySelector('[data-task-ask-yes]').fire('click');
  if (t.requestCalls() === 1) pass('13 点击「开启」triggers requestPermission (the gesture)');
  else fail('13 requestPermission calls = ' + t.requestCalls());
  if (t.asks().length === 0) pass('13 ask bar removes itself after answering');
  else fail('13 ask bar still present after answering');
  if (t.store.getItem('dsh-task-toast-asked') === '1') pass('13 the answer is recorded (asked at most once)');
  else fail('13 answer not recorded');

  // It must not come back on the next turn.
  t.endTurn();
  t.clock.advance(ASK_AT + 400);
  if (t.asks().length === 0) pass('13 never asks a second time');
  else fail('13 asked a second time');

  // Permission flipped to granted — but the OS path only engages while AWAY.
  t.endTurn();
  if (t.raised.length === 0) pass('13 granted but still visible -> still no OS toast');
  else fail('13 toasted while visible');
  t.setHidden(true);
  const before = t.raised.length;
  t.endTurn();
  if (t.raised.length > before) pass('13 hidden + granted -> the OS channel engages');
  else fail('13 OS channel did not engage after granting while away');
  t.setHidden(false);
}

/* ---- 14: denied -> respects it, and falls back to the plate ---------- */
{
  const t = boot({ permission: 'denied' });
  t.setHidden(true);                       // away, and the OS channel is refused
  t.endTurn();
  if (t.raised.length === 0) pass('14 denied -> no OS notification');
  else fail('14 raised a notification while denied');
  // The fallback is the point: a finished turn must never be silent.
  if (t.plates().length === 1) pass('14 denied + away -> falls back to the in-page plate');
  else fail('14 denied and no fallback plate — the turn went silent');
  t.clock.advance(ASK_AT + 800);
  if (t.asks().length === 0) pass('14 denied -> never asks (respects the answer)');
  else fail('14 nagged while denied');
}

/* ---- 15: no Notification API at all ---------------------------------- */
{
  const t = boot({ permission: 'default', notification: false });
  t.setHidden(true);
  let threw = false;
  try { t.endTurn(); } catch (e) { threw = true; fail('15 threw without the Notification API: ' + e.message); }
  if (!threw) pass('15 absent Notification API: no throw');
  if (t.plates().length === 1) pass('15 absent Notification API + away -> plate fallback');
  else fail('15 absent Notification API left the turn silent');
  try { t.clock.advance(ASK_AT + 800); } catch (e) { fail('15 threw while advancing: ' + e.message); }
  if (t.asks().length === 0) pass('15 absent Notification API: no ask');
  else fail('15 asked for a permission that cannot exist');
}

/* ---- 16: no localStorage (private mode / different origin) ----------- */
{
  const t = boot({ permission: 'default', localStorage: false });
  let threw = false;
  try { t.endTurn(); t.clock.advance(ASK_AT + 400); } catch (e) { threw = true; fail('16 threw without localStorage: ' + e.message); }
  if (!threw && t.asks().length === 1) pass('16 absent localStorage: still asks, no throw (worst case it asks again)');
  else if (!threw) fail('16 ask did not appear without localStorage');
}

/* ---- 17: a plate whose timer was STARVED is reaped on return ---------
   The plate now goes up whether or not you are looking, so it can go up while the
   page is hidden — and a hidden page clamps timers. Without the guard the plate
   outlives its own deadline and is still sitting there when you come back. */
{
  // (a) overdue: real time passed, the timeout never ran.
  const t = boot({ permission: 'granted' });
  t.setHidden(true);
  t.endTurn();
  if (t.plates().length === 1) pass('17 plate is up while hidden');
  else fail('17 no plate to reap');
  t.clock.starve(TOAST_MS + 1200);          // dead past its deadline, callback never ran
  if (t.plates().length === 1) pass('17 starved timer really did not fire (control)');
  else fail('17 the timer was not actually starved — the guard is untested');
  t.setHidden(false);
  if (t.plates()[0] && t.plates()[0].hasAttribute('data-task-toast-exit')) pass('17 overdue plate is reaped on return');
  else fail('17 overdue plate survived the return');
  t.clock.advance(EXIT_MS + 120);
  if (t.plates().length === 0) pass('17 its node is gone after the exit animation');
  else fail('17 reaped plate left a node behind: ' + t.plates().length);

  // (b) control: a plate that has NOT overstayed keeps its full life.
  const u = boot({ permission: 'granted' });
  u.setHidden(true);
  u.endTurn();
  u.clock.starve(TOAST_MS - 1500);          // throttled, but not yet due
  u.setHidden(false);
  const p = u.plates()[0];
  if (p && !p.hasAttribute('data-task-toast-exit')) pass('17 not-yet-due plate survives the return (guard is not over-eager)');
  else fail('17 the guard cut a plate short');
  u.clock.advance(1500 + 10);               // now its own deadline arrives
  if (u.plates()[0] && u.plates()[0].hasAttribute('data-task-toast-exit')) pass('17 it then leaves on its own schedule');
  else fail('17 the surviving plate never expired');
}

console.log('');
if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('all notification-channel checks passed');
