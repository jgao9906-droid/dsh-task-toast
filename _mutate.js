'use strict';
/**
 * Mutation controls for dsh-task-toast.
 *
 * Each mutant breaks ONE thing that the harnesses claim to protect, and the
 * harness must then FAIL. A test that survives its mutant is decoration.
 *
 * Usage:  node _mutate.js list
 *         node _mutate.js <name>            -> writes _mutant.js, prints the harness to run
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'client.js');
const OUT = path.join(__dirname, '_mutant.js');

const MUTANTS = {
  /* The exact wrong field name I nearly shipped: the internal `parentSessionId`
     instead of the public `parentId`. Silently never matches -> no SUBAGENT. */
  'internal-parent-field': {
    find: `row.parentId === watchedId`,
    replace: `row.parentSessionId === watchedId`,
    expect: ['H a turn ending while children run says SUBAGENT'],
  },
  /* Give a pending plate the ordinary toast deadline: it vanishes while the agent
     is still blocked on you. */
  'sticky-expires': {
    find: `if (!plateSticky && typeof setTimeout === 'function') plateTimer = setTimeout(hideToast, TOAST_MS)`,
    replace: `if (typeof setTimeout === 'function') plateTimer = setTimeout(hideToast, TOAST_MS)`,
    expect: ['B2 it survives past TOAST_MS'],
  },
  /* Report a sticky error on every publish instead of only on change. */
  'error-refires': {
    find: `if (text === '' || text === lastErrorSeen) return false`,
    replace: `if (text === '') return false`,
    expect: ['F the same message does not re-fire'],
  },
  /* Skip the DOM sweep in teardown: a plate mid-exit is stranded forever. */
  'teardown-orphan': {
    find: `    removeAllPlates()`,
    replace: ``,
    expect: ['J teardown removes the plate'],
  },
  /* Let a transient plate displace a pending one. */
  'transient-wins': {
    find: `if (!(plateSticky && plate !== null)) showToast(word, detail, state, false)`,
    replace: `showToast(word, detail, state, false)`,
    expect: ['I the pending plate is not replaced by an error'],
  },
  /* Never observe the DOM: a panel that appears after mount is invisible. */
  'no-dom-observer': {
    find: `  domObserver = watchDom()`,
    replace: ``,
    expect: ['B a pending approval raises the plate'],
  },
  /* Treat every scan as a brand-new request: a repaint (or every keystroke inside
     the panel) re-announces and re-notifies. */
  'no-key-dedupe': {
    find: `      if (domPending[f.key] !== undefined) {`,
    replace: `      if (false) {`,
    expect: ['C a repaint under the same key does NOT re-expand the plate'],
  },
  /* Keep the panels' own button copy on the detail line. */
  'no-copy-strip': {
    find: `        for (let k = 0; k < probe.strip.length; k++) detail = detail.split(probe.strip[k]).join(' ')`,
    replace: ``,
    expect: ['B the detail strips the panel copy and keeps the reason'],
  },
  /* Let literal Markdown asterisks reach the plate (it is a plain-text HUD). */
  'no-markup-strip': {
    find: `        detail = squash(stripMarkup(detail))`,
    replace: `        detail = squash(detail)`,
    expect: ['D paired Markdown emphasis is stripped'],
  },
  /* Over-reach the other way: strip asterisks unconditionally, corrupting globs
     and multiplication. The control assertions exist precisely for this. */
  'markup-strip-too-greedy': {
    find: `    let out = s.replace(/\\*\\*([^*]+?)\\*\\*/g, '$1')`,
    replace: `    let out = s.split('*').join('')`,
    expect: ['D a glob pattern survives the stripper'],
  },
  /* Leave the panel's submit button on the line. */
  'no-tail-strip': {
    find: `        detail = stripTrailing(detail, probe.tail === undefined ? [] : probe.tail)`,
    replace: ``,
    expect: ['D a trailing button label is cut'],
  },
  /* Strip the button word ANYWHERE instead of only at the tail: a question that
     merely mentions 提交 loses that word. */
  'tail-strip-anywhere': {
    find: `        detail = stripTrailing(detail, probe.tail === undefined ? [] : probe.tail)`,
    replace: `        for (let q = 0; q < (probe.tail === undefined ? [] : probe.tail).length; q++) detail = detail.split(probe.tail[q]).join(' ')`,
    expect: ['D but the same word inside the question is left alone'],
  },
  /* A mutation observed just before teardown schedules a scan that runs after it:
     a detached plugin raises a plate and an OS toast one last time. */
  'scan-after-teardown': {
    find: `      if (disposed || domScanTimer !== null) return`,
    replace: `      if (domScanTimer !== null) return`,
    expect: ['J nothing comes back after teardown'],
  },
  /* Exempt the pending states from the visibility rule again: they toast on top of
     the plate you are already reading. This was the shipped behaviour once and the
     user rejected it after using it — the rule is "notifications only when I am not
     looking", with no state exempt. */
  'pending-exempt-from-visibility': {
    find: `      notifyMaybe(f.notify, f.detail, PENDING_ALWAYS_NOTIFY)`,
    replace: `      notifyMaybe(f.notify, f.detail, true)`,
    expect: ['B looking at DSH: the plate carries it, no OS toast'],
  },
  /* --- the anchor bar: size + hover-to-peek --- */
  /* Point at the bar and nothing happens (the feature is simply absent). */
  'no-hover-expand': {
    find: `    el.addEventListener('mouseenter', () => { edgeHovered = true; peekPending() })`,
    replace: ``,
    expect: ['L pointing at it brings the plate back'],
  },
  /* Remove the bar when the plate goes up: the pointer is left sitting on an
     element that no longer exists, mouseleave never fires, and the hover flag is
     stranded at true forever. */
  'edge-vanishes-on-arrive': {
    find: `  peekShown = false          // 这是播报，不是悬停展开：移开鼠标不该掐断它`,
    replace: `  peekShown = false
  removeEdge()`,
    expect: ['L the hover target survives another arrival too'],
  },
  /* The collapse timer fires while the pointer is on the bar and takes the plate
     away mid-look. */
  'timer-snatches-while-hovered': {
    find: `    if (edgeHovered) { peekShown = true; return }`,
    replace: ``,
    expect: ['L the collapse timer will not snatch it away while you are pointing at it'],
  },
  /* Ship the size that read as invisible again. */
  'bar-still-tiny': {
    find: `const EDGE_H = 128        // 可见细边长度的退路值（实测板子高度优先）`,
    replace: `const EDGE_H = 56`,
    expect: ['L the slip is 8 wide with a 128px fallback height'],
  },
  /* Pin the bar to the viewport corner again: it sticks out a whole EDGE above the
     plate, which is exactly the misalignment the user caught.
     NOTE the `\$` — these are the PLUGIN's template-literal placeholders, and an
     unescaped `${…}` here would be interpolated by THIS file instead. */
  'bar-not-aligned': {
    find: `  top: calc(\${EDGE}px - \${EDGE_HIT_PAD}px);`,
    replace: `  top: 0;`,
    expect: ['L the bar starts at the plate top edge'],
  },
  /* Ignore the measured plate height: the bar keeps the hardcoded fallback and the
     two read as separate objects again. */
  'bar-hardcoded-height': {
    find: `  applyEdgeHeight()      // 细边可能已经先建好了（第一次挂起就是这个顺序）`,
    replace: ``,
    expect: ['L the bar takes the measured plate height'],
  },
  /* Make the pointer target so wide that it collides with the plate's inset: the
     plate then lands under the pointer, the peek ends the moment it begins. */
  'pointer-target-overlaps-plate': {
    find: `const EDGE_HIT_W = 14     // 鼠标命中区宽度（8px 的条基本点不中）`,
    replace: `const EDGE_HIT_W = 24`,
    expect: ['L the plate inset'],
  },
  /* Forget to cancel the hit padding on the visible slip: it sits a few px low. */
  'slip-offset-by-padding': {
    find: `  top: \${EDGE_HIT_PAD}px;`,
    replace: `  top: 0;`,
    expect: ['L the visible slip is inset by the hit padding'],
  },
  /* Leave the reduced-motion rule aimed at the selector the animation moved off. */
  'reduced-motion-stale-selector': {
    find: `  [data-task-toast-edge]::after { animation: none; opacity: 1; }`,
    replace: `  [data-task-toast-edge] { animation: none; opacity: 1; }`,
    expect: ['L reduced-motion still disables the breathing'],
  },
  /* Join the approval waterfall after all: the one mistake that can swallow the
     official panel and hang the agent. */
  'joins-waterfall': {
    find: `  syncFromDom()
  domObserver = watchDom()`,
    replace: `  try { ctx.get('remote').$on('approval/request', function (request, next) { return next() }) } catch (e) {}
  syncFromDom()
  domObserver = watchDom()`,
    expect: ['A no remote listener is ever registered'],
  },
};

const [, , cmd] = process.argv;

if (cmd === 'list' || cmd === undefined) {
  for (const [name, m] of Object.entries(MUTANTS)) {
    // padEnd alone is not enough: a name longer than the pad width would run
    // straight into "expects:" with no separator, which breaks any caller that
    // splits this output on whitespace.
    console.log(name.padEnd(24) + ' ' + 'expects: ' + m.expect.join(' | '));
  }
  process.exit(0);
}

const mut = MUTANTS[cmd];
if (mut === undefined) {
  console.error('unknown mutant: ' + cmd);
  process.exit(2);
}

const src = fs.readFileSync(SRC, 'utf8');
const parts = src.split(mut.find);
if (parts.length !== 2) {
  console.error('MUTATION DID NOT APPLY CLEANLY: the anchor matched ' + (parts.length - 1) + ' time(s), need exactly 1');
  process.exit(3);
}
const mutated = parts[0] + mut.replace + parts[1];
if (mutated === src) {
  console.error('MUTATION WAS A NO-OP');
  process.exit(3);
}
fs.writeFileSync(OUT, mutated, 'utf8');
console.log('wrote _mutant.js  (' + cmd + ')');
console.log('run: node verify-status.js ' + path.join(__dirname, '_mutant.js').replace(/\\/g, '/'));
console.log('must fail: ' + mut.expect.join(' | '));
