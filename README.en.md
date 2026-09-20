# dsh-task-toast

English | [中文](README.md)

A DeepSeek Harness plugin that **puts agent status in the top-right corner** — completion, errors,
pending approvals, pending questions, and subagents still running.
The visual language is borrowed from the
[`dsh-theme-endfield`](https://github.com/ymh0000123/dsh-theme-endfield) boot screen
(**the design language only — this plugin is not affiliated with that theme**; install it and the
plate follows its accent colour, don't install it and everything still works).

```bash
dsh plugin --profile web add github:jgao9906-droid/dsh-task-toast
```

Zero dependencies, no build step, no profile patch to edit by hand. See [Install](#install).

<img src="assets/approval.png" width="470" alt="Pending approval: the orange APPROVAL plate, whose detail line is the requester's own reason, ellipsised to one line when it is long">

<img src="assets/question.png" width="470" alt="Pending question: the cyan QUESTION plate, whose detail line is the question itself">

> Both are real screenshots. The orange one happens to be a **sandbox escalation request**, so its
> detail line is the host-generated `escalate sandbox to danger-full-access: …` — that is the
> reason the *requester* supplied, and the plugin does not rewrite it, it only ellipsises it to one
> line (the official panel shows it over several lines; this HUD has one). A tool-level approval
> instead reads `tool Bash requests privileged execution` — see the ASCII sketch below.

```
┌────────────────────────────────────────────────────┐
│▌ // TASK                                           │  ← 10px accent rail (fills downward) + wide-tracked kicker
│▌                                                   │
│▌ ❯❯ APPROVAL                                       │  ← bordered stacked chevrons + 34px word
│▌                                                   │
│▌ tool Bash requests privileged execution           │ ← one detail line (ellipsised)
│▌ ▬▬▬▬▬▬                                   14:32:07 │  ← 6-square status bar + tabular clock
└────────────────────────────────────────────────────┘
                                                     ▐  ← once pending times out it collapses to this 8px slip
                                                     ▐     its height is the plate's measured height, so the
                                                     ▐     two edges line up; hover it and the plate returns
```

**No layout ever changes — only three variables**: the big word, the accent colour, the detail line.

The slip is **hoverable**: after a pending state collapses into it, pointing at it brings the plate
back so you can see again *what* is waiting; moving away collapses it again. There is no button and
it performs no action — it is purely "take another look".

The slip and the plate **share the same top edge** (both start 18px from the top), and the slip's
length is the plate's **measured** height rather than a hardcoded constant — the two must line up
exactly, or they read as two misaligned objects. (Originally it hugged the viewport corner at
`top:0`, sticking out a full margin above the plate. That was the bug.)

## The six states

| State | Word | Accent | Detail line | Nature |
| --- | --- | --- | --- | --- |
| Turn finished | `COMPLETE` | follows the theme's `--edge-accent` | session title | transient: 5s |
| Error | `ERROR` | red `#ff4d4f` | the error message | transient |
| Session won't open | `UNOPENED` | red (same as ERROR) | error code / session title | transient |
| Subagents still running | `SUBAGENT` | follows the theme | session title | transient |
| **Pending approval** | `APPROVAL` | orange `#ff9f0a` | `tool Bash requests privileged execution`, or the requester's own reason | **pending** |
| **Pending question** | `QUESTION` | cyan `#3fd8d0` | the question title (the panel's own `1 / N` counter stays on the line too) | **pending** |

### Transient vs pending are fundamentally different

- **Transient**: something happened → show it for `TOAST_MS` and leave.
- **Pending**: **the agent is stuck waiting on you.** It will not "be fine in 5 seconds", so: show
  the full plate for `PENDING_FULL_MS` → **collapse to the slip in the top-right corner** (which
  only says "something is waiting", with no text) → **and it stays until you deal with it.**
  The slip's colour tells you which kind is waiting (orange = approval, cyan = question), and
  **pointing at it brings the plate back**.

Pending states **obey exactly the same visibility rule as everything else**: while you are looking
at DSH you get the plate only; the OS notification is added when you are not looking.
(This rule used to have an exemption for pending states, reasoning that "an agent stuck waiting on
you deserves to be known" — one real use killed it: you are staring at the big plate and an OS
notification pops on top of it. Pure duplication.)

A few edge behaviours:

- **More than one thing can be pending at once** (approvals stack). A new one → the plate expands;
  answer one while others remain → it collapses to the slip (**it will not** keep showing the one
  you already dealt with); answer the last one → the slip disappears.
- **The slip stays on screen while the plate is expanded.** It is the plate's anchor *and* the hover
  target, and that is not a nicety: an element **removed from under the pointer** never fires
  `mouseleave`, so the hover flag would stick at true forever and the slip would stop responding to
  the mouse. An assertion pins that this node is the same object across collapse, expand and a new
  arrival.
- **Hovering never flickers.** The pointer target occupies only the outermost 14px of the viewport
  while the plate keeps an 18px inset, so the two **never overlap** — the plate cannot land under
  the pointer. That geometric invariant (`EDGE > EDGE_HIT_W`) is asserted, and asserted against
  **values read out of the source** (an earlier version compared the harness's own mirrored
  constants, and one mutant survived because of it).
- **A hover-expanded plate collapses when you move away**, while the announcement of a
  *newly arrived* pending is **not** cut short by your pointer sweeping across the corner — the two
  are tracked by different flags.
- **Pending outranks transient**: while a pending plate owns the screen, transients like
  completion or error **do not steal it** (they are still in DSH's own transcript) and do not send
  an extra OS notification either (you are demonstrably looking). That is a deliberate trade, not
  an oversight.

## Three visible channels, the in-page plate is always on

Each is independently switchable (constants at the top of `client.js`):

| Channel | Constants | Reach | Requires |
| --- | --- | --- | --- |
| In-page plate | always on | always | nothing |
| **OS notification** | `OS_NOTIFY` + `OS_NOTIFY_ONLY_WHEN_AWAY` | **on top of any application**; works while DSH is backgrounded or minimised | one permission grant |
| Title-bar `● ` prefix | `TITLE_BADGE` | the cheap taskbar/tab fallback | nothing |

The OS notification *title* is per state too (`任务完成` / `任务出错` / `等待你授权` / `等待你回答` /
`会话打不开`) — a notification that says "task finished" when the task actually failed is worse
than no notification.

### Only the OS notification is gated on visibility; the plate always shows

```
always           ->  the in-page plate (primary channel, immune to any predicate)
not looking at DSH ->  OS notification  +  title-bar ●
looking at DSH     ->  the plate alone (an OS toast on top of it is just noise)
```

**Every state follows the same rule; nothing is exempt.** `PENDING_ALWAYS_NOTIFY = true` would let
pending states ignore the predicate and always notify — that *used* to be the default (reasoning:
"an agent stuck waiting on you is more important than a completion"), and one real use rejected it:
staring at the big plate while an OS notification fires on top of it is pure duplication. Set it
back to `true` if you want that behaviour.

`OS_NOTIFY_ONLY_WHEN_AWAY = false` degrades to "send both".

**Keeping the plate off the predicate is deliberate** (a real bug fixed during development): the
moment the predicate is unavailable in some environment, the primary channel goes silent with it —
the symptom is "the task finished and nothing popped up at all". The failure mode has to be "one
notification too many", never "nothing at all".

The predicate is `document.hidden` / `document.visibilityState` (see `isLookingAtDsh()`).
**Deliberately not `document.hasFocus()`**: the DSH page lives in an iframe, so clicking the shell's
own navbar blurs the iframe and would read as "not looking" — producing an OS toast while you are
staring straight at DSH.

On the Tauri desktop shell this predicate is **not a guess**: the host injects a shim that
**redefines** those two properties inside the iframe to mirror the **host window** (host blur or
minimise → `hidden`, return → `visible`), corrected via `dsh://visibility-state`.

### A starved plate gets reaped

While a page is hidden, browsers and WebViews throttle timers hard (a background tab will not honour
a 5-second timeout on schedule; a suspended WebView may not run it at all). The plate is no longer
blocked by visibility, so it can go up while the page is hidden and then **still be on screen long
after it timed out**.

`reapStalePlate()` therefore ignores the timer and reads the clock: on returning to the foreground
a plate past its own deadline is dismissed, and **one that has not overstayed keeps its full life**
(there is a control test preventing it from cutting plates short). A pending plate's deadline is
`PENDING_FULL_MS` (collapse to the slip), not `TOAST_MS` — with the shipped values those two are
equal, so that guard looks like dead code; **a dedicated differential test watches it** (see
[How to verify](#how-to-verify)).

### Dwell time

`TOAST_MS = 5000`, **matching the Windows notification default (5 seconds)** so both read the same.

The reverse is not achievable: **the OS notification's duration is Windows' decision**
(Settings › System › Notifications › "Show notifications for": 5/7/15/30 seconds);
`NotificationOptions` has no duration field at all. If you change the system setting, change
`TOAST_MS` to follow.

### The permission flow

Browsers require `Notification.requestPermission()` to be triggered by a **user click**, so after
the first finished turn a one-shot ask plate appears in the same style (`// NOTIFY` → enable /
no thanks). It is deliberately scheduled after the in-page plate has disappeared so the two never
overlap. The answer is stored in `localStorage` and it **never asks twice**; if permission is
already `denied` it never asks at all.

> On the Tauri desktop shell this ask plate **never appears**: the host shim makes
> `Notification.permission` always return `'granted'` and wires every `new Notification(...)` to
> the host's own native notifications. That logic only matters in a plain browser.

The OS notification body carries the current session title; the `tag` is
`dsh-notification-<session id>-0`, **whose shape is a contract with the host** — it parses the
session id out of the tag so that **clicking the notification jumps to that session**. Repeat
completions reuse the same tag, so they **replace rather than stack**.

### Two preconditions (both hold for this launcher)

- `http://127.0.0.1` is a **secure context** (localhost exemption), so the Notification API works
  over plain http;
- permission is remembered **per origin**, and the launcher pins the port to `3080`, so **one grant
  lasts**. If you ever switch to a DSH Desktop that picks a random port, the origin changes every
  launch and you would have to grant again.

### What it cannot reach

**A fully closed DSH window gets no notification** — notifications live in the page, and no page
means no notification. That case needs host-side notifications (the `dsh web` process is still
alive and could use a native Windows channel); it is a different implementation and this plugin
does not do it.

Windows Focus Assist / Do Not Disturb also suppresses OS notifications. That is a system setting,
not something a plugin can route around.

## Install

```bash
dsh plugin --profile web add github:jgao9906-droid/dsh-task-toast
```

Restart or reload the `web` profile and it is live.

**No extra build step, and no profile patch to edit by hand.** Two details worth knowing:

- The package has **no `prepare` / `postinstall` script**; `client.js` is source that runs as-is.
  `dsh plugin` is a thin pnpm forwarder, and pnpm blocks build scripts for git-sourced packages
  until you allowlist them under `allowBuilds` in `pnpm-workspace.yaml` — this plugin sidesteps that
  entire class of friction.
- The package declares `dsh.bundle.patch`, so `dsh plugin add` **automatically** adds it to the
  profile's `dsh.profile.bundles` layer stack. No manual `cordis.patch.yml` editing.

While developing, installing with `link:` is more convenient (edit, refresh the page, done):

```bash
dsh plugin --profile web add link:<path you cloned to>
```

Uninstall:

```bash
dsh plugin --profile web rm dsh-task-toast
```

### Compatibility

- **Platform**: a pure client plugin — just DOM and `document.hidden`, no platform-specific code.
  Verified on DSH Desktop (the Tauri shell); in a plain browser everything behaves the same except
  the OS notification plumbing.
- **DSH version**: developed and verified against `0.1.5-rc.x`. It depends on two kinds of internal
  interfaces: session-snapshot field names, and **three `data-` attributes on the official panels**
  (`data-approval-key` / `data-question-key` / `data-plan-review-key`). The latter are unofficial
  hooks: if DSH renames them, pending approvals and questions **disappear silently** (every other
  state is unaffected) — no error, no crash.
- **Build dependencies**: none at runtime.
- **The user-facing copy is Chinese.** Every string the user sees is a constant at the top of
  `client.js` — the OS notification titles (`任务完成`, `任务出错`, `等待你授权`, `等待你回答`,
  `会话打不开`) and the fallback detail line (`SESSION IDLE`). Only `// TASK`, `COMPLETE`, `ERROR`,
  `APPROVAL`, `QUESTION`, `UNOPENED` and `SUBAGENT` ship in English. Translating the interface is a
  handful of one-line edits under [Tunables](#tunables); nothing else reads those constants.

### Developers: how to check it is actually good

Three harnesses and a mutation matrix ship in the repo. **Zero dependencies, no DSH required**
(`vm` plus a fake DOM and fake clock):

```bash
npm test                 # three harnesses, 191 assertions
node _mutate.js list     # list all 24 mutants and the assertion each one targets
```

## How it knows each state

### Completion / subagents: one status bit

It trusts exactly one source — DSH's own authoritative state:

| Step | Call |
| --- | --- |
| Get the service | `ctx.get('sessions')` |
| Current session | `sessions.list.getSnapshot().current` |
| Session face | `sessions.binding(id).session` (`SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`) |
| The bit | `session.getSnapshot().running` |

**It reacts to one edge only, `true → false`** (a turn ended), and:

- the **first value read for a session is a baseline**, never an edge — so switching into a session
  that is already running stays silent;
- `sessions.list` publishes for all sorts of unrelated reasons (a title change, a job row, a sidebar
  refresh), so the same session is not re-subscribed;
- when a session snapshot is temporarily unreadable (its window is not open yet) it keeps
  subscribing, and that session's first real value becomes the baseline;
- services can settle after `apply()` (the web boot mounts every plugin row concurrently), so it
  declares no `inject` and always uses `ctx.get` with a 120ms retry.

**"This turn ended" is not the same claim as "the work is done"**: if other sessions are still
running under this one, the word is `SUBAGENT`, not `COMPLETE`. Two things that are easy to get
wrong (pinned by mutation testing):

1. The snapshot's `subagent` field means "**this session is itself a subagent**" (always `null` on
   a top-level session), **not** "it has subagents". The parent-side signal lives only in the
   **list snapshot**.
2. When list rows are projected onto the public face the parent link is called **`parentId`**, not
   the internal `parentSessionId`. Using the latter yields a predicate that is always false — no
   compile error, no log line, the state simply never appears.

### Errors / unopenable sessions: read from the snapshot, report on *change*

| Source | Notes |
| --- | --- |
| `session.getSnapshot().lastAgentError` | The **only** source. It is fed by the host's `api-session/error` event (which DSH's own comment calls the outlet for "**live failures with no turn position**"), but the plugin reads the **snapshot value** and does not subscribe to that event |
| `openState === 'error'` + `openError` | the session could not be opened |

⚠️ **`lastAgentError` is sticky**: it is only cleared on connect/reset and **does not go away on its
own**. "Report whenever it is non-empty" would leave a stale ERROR on screen forever. So it is
reported once, **when the content changes**, and switching sessions baselines whatever value was
already there (arriving at a session that has carried an old error for ages does not pop a plate).
`openState` is the same: only the **transition into** `error` is reported.

### Pending approvals / questions: read the official panels' DOM

**It does not subscribe to the remote events**, even though those are the "proper" interface. The
reason is a measured finding, recorded here so nobody re-implements it the official way:

> Official plugins use the waterfall remote events `ctx.remote.$on('approval/request', fn)` /
> `'user-questions/request'`. **This plugin was implemented that way first**, including the
> "you must `return next()` to hand the decision back to the host" contract and the mutation tests
> for it. But **on the machine this was developed on (Windows + DSH Desktop, `0.1.5-rc.x`) not a
> single remote event arrives**:
>
> Measured (with diagnostic readouts rendered onto the plate and written to the shell log):
> `sess=yes remote=yes $on=yes` while the hit count stayed **0** — the service resolves, `$on` does
> not throw, and the listener is simply never called; even an emit-style event like
> `api-session/status` never shows up. I read cordis's dispatch implementation (`EventsService` is
> constructed on the root, child contexts inherit the same `_hooks` map through the prototype, and
> emit-style dispatch applies no filter at all), and confirmed that a comparable user plugin,
> `dsh-tauri-model-config`, does use `ctx.get('remote')` — so it is not that "this route is
> unavailable to user plugins", it is that it does not work in that environment.
>
> **⚠️ That is an environment-specific observation, not a universal conclusion.** On other machines
> remote events are very likely fine (the official plugins depend on them). If you find
> `ctx.remote.$on` working in your environment you can absolutely switch back — but do it together
> with the "a waterfall listener must `return next()`" contract, or you will swallow the official
> approval panel and **leave the agent stuck forever waiting for approval**.
>
> A second reason to prefer the DOM: by not subscribing to the waterfall at all, that mistake is
> **structurally impossible**.
>
> Conclusion: **the DOM the official panels render is the single source of truth.**

Both panels carry **semantic `data-` attributes** (not hashed CSS module class names) — their own
selector hooks:

| Panel | Attribute | State |
| --- | --- | --- |
| Approval panel `dsh-client-ui-approval` | `data-approval-key` | pending approval |
| Question panel `dsh-client-ui-user-questions` | `data-question-key` | pending question |
| Plan review (another panel from the same plugin) | `data-plan-review-key` | pending question |

The mechanism: a `MutationObserver` watches `document.body` (childList + subtree + characterData),
re-scans after a 60ms debounce, and **panel present = something is waiting, panel gone = it is
over**. It also scans once at mount and once on returning to the foreground — the first covers
"the approval panel was already on screen when you reloaded", the second covers "the panel appeared
while hidden, when the MutationObserver was throttled too".

The detail line is the panel's `textContent` with three kinds of noise subtracted in order:

1. **The panel's own fixed copy** (`等待审批` / `拒绝` / `允许一次` / `跳过本题` / `确认执行` …, taken
   from the official dictionaries). `计划待审` is **deliberately kept** — it is a meaningful state
   label, not a button.
2. **Paired Markdown emphasis** (`**x**`, `` `x` ``) — the line is a plain-text HUD that does not
   parse Markdown, so without this the asterisks show literally. **Single-asterisk `*x*` is
   deliberately not handled**: it collides too hard with globs and multiplication, and a control
   test caught `排除 *.png 和 2*3` being eaten into `排除 .png 和 23`. Underscores and tildes are
   untouched too (far too common in identifiers and paths).
3. **Trailing short button labels** (`提交` / `跳过` / `取消`; `提交` comes from DSH's shared
   vocabulary rather than the panel's own dictionary). These are **ordinary words**, so they are cut
   only as a trailing suffix — the action row is genuinely last in DOM order, which is why
   `提交前要检查什么` does not lose its leading `提交`.

Three properties follow:

- **Deduplication uses the panel's own key** (the attribute value, e.g. `approval:1`). Re-rendering
  under the same key does **not** replay the announcement (otherwise every keystroke inside the
  panel would pop a plate); a new key is a genuinely new request and earns a fresh announcement.
- **This plugin can no longer swallow the approval panel**: not listening to the waterfall removes
  the "forgot `next()`, agent hangs forever" failure mode entirely. That warning used to be a real
  risk; now it is structurally impossible.
- The cost: this is an **unofficial hook**. If DSH changes those `data-` attributes, the states
  degrade silently (see below).

### Signals it cannot reach (don't count on them)

| Wanted | Why it is out of reach |
| --- | --- |
| `turn/end`'s `reason` (`completed` / `error` / `aborted` / `blocked` / `max-tokens` / `interrupted`) | It exists in `SessionEventMap`, but **a client plugin has no subscription point**: `Session.events` is the internal stream the session object uses to page its own transcript, not a public subscription. Having swept every `lib/client.js`, **no client consumer touches `turn/end`**. So "how did this turn end" cannot be derived |
| `tool/result`'s `error: {name, code}` | Also a session event, also unreachable. So "some tool failed" cannot be reported — only **agent-level** errors |
| Which session a pending state belongs to | The DOM only holds the panel; it does not say which session it is attached to. (The remote-event route could have used `ctx.sessions.scopeOf(this)`, but that route does not work.) So pending states are **not labelled with a session**, and the OS notification's click-to-focus points at the **current session** — a subagent's approval may jump to the wrong one |
| "All subagents under the main session have finished" | A child session stopping or disappearing **does not** produce another `COMPLETE`. After `SUBAGENT` there is nothing — to know the whole job is done, send another message or watch the sidebar |

**Compatibility risk**: pending approvals/questions depend on the official panels' **`data-`
attributes** (an rc release could rename them). Worst case those two states **disappear silently**
(you still get `COMPLETE` / `ERROR`) — nothing crashes, because every scan is wrapped in try/catch
and a missing node is treated as "nothing there".

## Visuals

This is not "a similar style" — it is a deliberate re-creation of the boot screen's techniques:

| Boot screen | This plugin |
| --- | --- |
| 8–10px accent progress rail on the left | 8px accent rail on the left, filled top→bottom with `scaleY` |
| Yellow sweep to finish | accent wipe across the bottom (`scaleX`) |
| `END` / `FIELD` stacked wordmark | the big word: `COMPLETE` / `ERROR` / `APPROVAL` / `QUESTION` / `UNOPENED` / `SUBAGENT` |
| 6-square status bar | the same 6 squares, lit in sequence with `animation-delay` |
| Border-drawn stacked chevron | the same `border-left` + `border-bottom` + `rotate(-45deg)` |
| `letter-spacing: .26em` kicker | the same value |
| `font-feature-settings: "tnum" 1` | the same value (so the ticking clock does not jitter) |
| Square corners, hairline borders, `#101110` / `#f5f5f0` | the same values |

**The accent for completion / subagents is not hardcoded**: it uses `var(--edge-accent, #fff500)`.
Install the Endfield theme and it follows that theme's palette automatically; don't, and it falls
back to signal yellow — both cases work.

**Every other state uses its own colour** (red = error, orange = pending approval, cyan = pending
question), because the colour is saying "this is not a normal completion" and should not be eaten by
a theme palette. Those live in CSS `[data-state="…"]` rules with the **hex and the rgb triplet
hardcoded as a pair**: borders and glows use `rgba(var(--tt-accent-rgb), x)` and `var()` cannot
compose an rgb triplet — changing only the hex gives you a red rail with a yellow glow.
`UNOPENED`'s rule is byte-for-byte identical to `ERROR`'s, with an assertion watching that they do
not drift apart.

## Tunables

The top of `client.js` is a block of constants (there is deliberately no settings page: a settings
namespace would have to span the host and client halves, and the client-side read timing has a whole
class of races — so it is "change one line and reload" for now):

```js
const TOAST_MS = 5000                  // transient dwell (matches the OS notification's 5s)
const PENDING_FULL_MS = 5000           // how long a pending plate stays full before collapsing
const PENDING_ALWAYS_NOTIFY = false    // should pending states bypass the visibility rule? (see above)
const EDGE_W = 8                        // visible slip width (was 6)
const EDGE_H = 128                      // FALLBACK slip length; normally the plate's measured height
const EDGE_HIT_W = 14                   // pointer-target width: wider than the slip, or it cannot be hit
const EDGE_HIT_PAD = 4                  // how much taller the pointer target is than the slip

const WORD_DONE     = 'COMPLETE'
const WORD_ERROR    = 'ERROR'
const WORD_APPROVAL = 'APPROVAL'
const WORD_QUESTION = 'QUESTION'
const WORD_UNOPENED = 'UNOPENED'
const WORD_SUBAGENT = 'SUBAGENT'

const ACCENT_ERROR    = ['#ff4d4f', '255, 77, 79']  // hex and rgb must be a pair
const ACCENT_APPROVAL = ['#ff9f0a', '255, 159, 10']
const ACCENT_QUESTION = ['#3fd8d0', '63, 216, 208']

const KICKER = '// TASK'
const TAG_DONE = 'SESSION IDLE'        // fallback when no task name can be read
const OS_NOTIFY = true                 // OS notifications, master switch
const OS_NOTIFY_ONLY_WHEN_AWAY = true  // only notify when DSH is not being looked at
const TITLE_BADGE = true               // title-bar ● prefix
```

**Want a longer `PENDING_FULL_MS`** (say, a pending plate that stays full for 30 seconds before
collapsing)? Just change it — a guard exists specifically so `TOAST_MS` cannot cut it short, which is
the easiest thing to overlook.

**Slip geometry**: `EDGE_W` is the visible width; `EDGE_H` is only the fallback for "the plate's
height has not been measured yet" — normally the script writes the plate's measured height into
`--tt-edge-h` and the slip follows the plate. `EDGE_HIT_W` and `EDGE_HIT_PAD` decide the part the
pointer can actually touch. Three geometric relations must hold, all asserted (against values read
from the source):

1. **the pointer target is wider than the visible slip** (or the mouse cannot hit it);
2. **the plate's `EDGE` inset is larger than the pointer target's width** (or the plate covers the
   pointer, the peek ends instantly and it flickers);
3. **the visible slip starts exactly at the plate's top edge** (the hit area's extra PAD must be
   subtracted internally, or the whole slip sits PAD pixels low).

Reload the profile after editing. To also pop on turn **start**, add an
`else if (prev === false && next === true)` branch next to the
`if (prev === true && next === false)` in the subscription callback (the edge tracking is already
running).

## How to verify

Three harnesses, plain Node, no DSH running and no real DOM touched (vm + a fake DOM and fake
clock):

```bash
node verify-toast.js     # signal and lifecycle: baseline, edges, singleton, teardown
node verify-notify.js    # channels: visibility routing, stale-plate reaping, permission ask, OS contract
node verify-status.js    # multi-state: six states, pending lifecycle, DOM dedupe, detail-line cleanup, priority
```

A few things in `verify-status.js` worth calling out:

- **It does not subscribe to the waterfall**: the very first assertion is "no remote listener is
  ever registered". That is not fastidiousness — it is the statement of the safety property "this
  plugin can no longer swallow the official approval panel".
- **Differential test**: re-run the same logic with `PENDING_FULL_MS` set to 15000 and check that a
  pending plate outlives `TOAST_MS`. With the shipped values the two deadlines are equal, so that
  guard looks like dead code — changing one constant is the only way to prove it is not.
- **Panel-key dedupe**: re-rendering under the same key must **not** replay (otherwise every
  keystroke in the panel pops a plate), while a new key must. Both directions are asserted.
- **Notify only when not looking**: three states each have a "looking → 0 OS notifications"
  assertion plus a "not looking → correct notification title" counterpart. Pending states once had
  an exemption from this rule; real use rejected it, so a mutant now watches that it cannot sneak
  back.
- **Detail-line cleanup has counter-examples**: stripping Markdown and trailing labels each have
  assertions in both directions — "must be stripped" and "must never be damaged"
  (`*.png`, `2*3` and `file_name` must survive verbatim; the leading `提交` in
  `提交前要检查什么` must stay).
- **Panel already present at mount**: the case where the panel exists **before** the plugin mounts
  (you reloaded with an approval open) is tested separately, because that path has no
  MutationObserver event to rely on and only the mount scan can catch it.

### Mutation testing (proving those assertions have teeth)

`_mutate.js` builds one mutant per assertion that **breaks exactly that one thing**, and the
harness must then fail:

```bash
node _mutate.js list              # list every mutant and the assertion it targets
node _mutate.js no-dom-observer   # write _mutant.js
node verify-status.js "$PWD/_mutant.js"   # must fail
```

| Mutant | What it breaks | Result |
| --- | --- | --- |
| `no-dom-observer` | never observe the DOM, so panels appearing after mount are invisible | 28 assertions fail |
| `edge-vanishes-on-arrive` | remove the slip while the plate is up (the element under the pointer disappears) | 6 |
| `no-hover-expand` | hovering does nothing (the feature is simply absent) | 4 |
| `no-copy-strip` | leave the panel's own button copy on the detail line | 4 |
| `no-markup-strip` | let literal asterisks reach the plate | 1 |
| `markup-strip-too-greedy` | strip every asterisk, destroying globs and multiplication | 2 |
| `no-tail-strip` | leave the submit button on the line | 1 |
| `tail-strip-anywhere` | strip trailing labels globally, eating the same word inside the question | 2 |
| `bar-still-tiny` | revert the slip to the length that read as invisible | 1 |
| `bar-not-aligned` | pin the slip back to the viewport corner (a margin above the plate) | 1 |
| `bar-hardcoded-height` | ignore the measured plate height, use the hardcoded length | 1 |
| `slip-offset-by-padding` | forget to cancel the hit padding internally (the slip sits 4px low) | 1 |
| `pointer-target-overlaps-plate` | widen the pointer target into the plate (hovering would flicker) | 1 |
| `sticky-expires` | give a pending plate the ordinary toast deadline | 2 |
| `no-key-dedupe` | treat every re-scan as a new request (repaint = replay) | 2 |
| `transient-wins` | let a transient state displace a pending plate | 2 |
| `teardown-orphan` | skip the DOM sweep at teardown | 2 |
| `pending-exempt-from-visibility` | exempt pending states from the visibility rule and notify while you read the plate | 2 |
| `joins-waterfall` | quietly subscribe to the approval waterfall (the one mistake that can hang the agent) | 2 |
| `timer-snatches-while-hovered` | the timer takes the plate away while you are pointing at it | 1 |
| `reduced-motion-stale-selector` | aim the reduced-motion rule at the element the animation moved off | 1 |
| `scan-after-teardown` | a scan already queued still fires after teardown | 1 |
| `internal-parent-field` | use the internal `parentSessionId` instead of `parentId` | 1 |
| `error-refires` | drop the sticky-error deduplication | 1 |

A mutant counts as **surviving** only if the harness **exits 0 _and_ prints its success line** —
looking only for `FAIL` lines misreads "the harness crashed outright" as "survived" (my first
runner made exactly that mistake).

Mutation testing here is not ceremony; every category it caught was a mistake of my own: a piece of
**unreachable** defensive code (deleted), a reduced-motion rule that was **aimed at nothing** (the
animation moved to `::after` and the rule did not follow), **an invariant compared against the
harness's own constants** (which is why `pointer-target-overlaps-plate` survived at first),
**a height written only once** (on the first pending the slip is created before the plate's height
is measured, so it stayed at the fallback forever), and **an over-reaching cleanup rule**
(unconditional asterisk removal, which ate `*.png 和 2*3` into `.png 和 23`).

## Boundaries

- The plate and the slip are `<body>` children with `pointer-events: none`; they never intercept
  clicks or text selection, and they are `aria-hidden` so they do not interrupt screen readers.
- Only one plate exists at a time: a second completion replaces the first rather than stacking.
  The slip stays for as long as anything is pending (see above).
- **The slip is the only element in this plugin that accepts the mouse** (a 14px-wide hit area in
  the top-right corner). The cost is that the handful of application pixels underneath cannot be
  clicked — traded for "point at it and see again what is waiting". The plate itself still passes
  clicks straight through.
- **Hovering is a mouse convenience**; a keyboard user cannot reach it. It performs no action (there
  is nothing to "activate"), and the information is already present in DSH's own panel — which is
  why it is `aria-hidden`, not because accessibility was forgotten.
- **While a pending plate owns the screen, transient states are dropped** (they do not steal it and
  do not notify). That is a deliberate trade: pending means the agent is stuck, which is more urgent
  than "finished", and you are demonstrably looking at DSH, whose own transcript shows the error.
- Pending states depend on the official panels' `data-` attributes, i.e. an **unofficial hook**; if
  DSH renames them, those two states disappear silently.
- Under `prefers-reduced-motion` appear/disappear are kept (that is information) while translation
  and the wipe are dropped; the slip stops breathing and stays lit.
- The plate and the slip sit at `z-index: 2147482800` — below the Endfield theme's boot screen
  (2147483000) and above its thunder wordmark (2147482000), so they still cover the app while the
  theme's loading animation plays.

## License

MIT
