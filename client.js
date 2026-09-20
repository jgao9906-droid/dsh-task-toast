/**
 * dsh-task-toast — 右上角「任务完成」提示（终末地开机动画风格）
 *
 * 视觉语言直接沿用 dsh-theme-endfield 的开机加载屏，不是"类似风格"：
 *   - 左侧 8px 强调色轨，按 scaleY 自上而下填充（对应开机屏那条进度轨）
 *   - 纯边框画的叠层雪佛龙（::before/::after + border-left/bottom + rotate(-45deg)），
 *     不依赖任何字形，所以字体缺失也不会变成豆腐块
 *   - `// KICKER` 大字距标签 + 等宽数字（font-feature-settings: "tnum" 1）
 *   - 底部 6 格方块状态条（对应开机屏的 [data-endfield-loader-squares]）
 *   - 全直角、发丝描边、深色底板 #101110 / 墨色文字 #f5f5f0
 *   - 强调色走 var(--edge-accent, #fff500)：装了终末地主题就自动跟随它的
 *     谷地黄/武陵青，没装则退回信号黄 —— 两者都成立，不是硬编码
 *
 * 信号来自 DSH 唯一的权威位（复用终末地插件已验证的写法）：
 *   ctx.get('sessions').list.current  ->  当前会话 id
 *   ctx.get('sessions').binding(id).session  ->  可观察快照，带 running
 *   running 的 true -> false 边沿 = 一个回合结束
 *   每个会话首个可读值只当基线，静默 —— 切进一个已经在跑的会话不会误报
 *
 * 不声明 inject：web boot 会并发挂载所有插件行，服务可能晚于 apply() 就绪，
 * 所以一律 ctx.get + 重试（同 dsh-client-ui-theme / 终末地主题的约定）。
 */
window.__ModuleLoader__.load({
	id: "dsh-task-toast",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

/* ==========================================================================
   可调参数（v1 不做设置页：设置命名空间要跨 Host/Client 两半，读取时机还有
   一整类竞态 —— 先把它做成"改一行就生效"的常量，稳过再加界面。）
   ========================================================================== */
const TOAST_MS   = 5000   // 页内停留时长。对齐 Windows 系统通知的默认档（5 秒），
                          // 让"看着 DSH"和"没看着"两种情况观感一致。
                          // 反过来对齐做不到：系统通知的时长由 Windows 决定
                          // （设置 › 系统 › 通知 › 显示通知的时长：5/7/15/30 秒），
                          // NotificationOptions 里根本没有 duration 字段。
                          // 你要是把系统那档调成别的，就改这里跟上。
const EXIT_MS    = 260    // 退场动画时长（必须与 CSS 里的 tt-out 一致）
const EDGE       = 18     // 距视口右上角的边距(px)
const WIDTH      = 340    // 提示板宽度(px)
const Z_INDEX    = 2147482800  // 低于终末地开机屏(2147483000)，高于其雷霆大字(2147482000)
const RETRY_MS   = 120    // 服务未就绪时的重试间隔
const CSS_TAG_ID = 'dsh-task-toast'

/* ---- 通知通道开关（各自独立） ---- */
const OS_NOTIFY   = true   // 系统通知：盖在任何程序之上，DSH 在后台/最小化也行（需授权一次）
/* 只在"没看着 DSH"时才发系统通知 —— 这正是最初的需求。
   注意这个开关**只限制系统通知**：页内板子永远显示。把主通道也挂到可见性判据上
   是错的（见 onTurnEnd 的注释）——判据一旦不可用，整个功能就静默了。 */
const OS_NOTIFY_ONLY_WHEN_AWAY = true
const TITLE_BADGE = true   // 标题栏 ● 前缀：任务栏 / 标签页上的廉价兜底

/* 文案。想改成别的语言只动这几个常量即可。 */
const WORD_DONE    = 'COMPLETE'
const KICKER       = '// TASK'
const TAG_DONE     = 'SESSION IDLE'  // 任务名取不到时的回退文案
const NOTIFY_TITLE = '任务完成'    // 系统通知的标题行
const TITLE_PREFIX = '● '          // 标题栏前缀
/* 系统通知的标题行，按状态分开 —— 一条写着"任务完成"的通知其实是报错，
   比不通知更糟。 */
const NOTIFY_TITLE_ERROR    = '任务出错'
const NOTIFY_TITLE_APPROVAL = '等待你授权'
const NOTIFY_TITLE_QUESTION = '等待你回答'
const NOTIFY_TITLE_UNOPENED = '会话打不开'

/* ==========================================================================
   状态表。

   每个状态 = 大字换词 + 强调色换色 + 任务名行换内容。刻意不加版式：终末地那套
   语言本来就吃这个，板子的骨架、尺寸、动画都不动。

   两种性格，生命周期完全不同：

     瞬时型（done / error / unopened）
       一件事发生了 → 弹 TOAST_MS 就走。

     挂起型（approval / question）
       agent 卡住了，正在等你。它不会"5 秒后就没事了"，所以整块显示
       PENDING_FULL_MS 之后收成右上角那条细边，只表示"有东西在等你"，直到
       你处理掉才消失。这类还必须无视可见性发系统通知 —— 它比"完成了"更该
       被你知道。
   ========================================================================== */
const WORD_ERROR    = 'ERROR'      // agent 级错误
const WORD_APPROVAL = 'APPROVAL'   // 待授权：工具请求越权
const WORD_QUESTION = 'QUESTION'   // 待回答：agent 向你提问 / 计划待审
const WORD_UNOPENED = 'UNOPENED'   // 会话打不开
const WORD_SUBAGENT = 'SUBAGENT'   // 本回合结束了，但还有子 agent 在跑

/* 强调色。done / subagent 不覆盖，跟随主题的 --edge-accent。
   rgb 与 hex 必须成对写死：CSS 里描边/辉光用的是 rgba(var(--tt-accent-rgb),x)，
   而 var() 拼不出 rgb 三元组 —— 只改 hex 会让板子变成"红轨黄光"。 */
const ACCENT_ERROR    = ['#ff4d4f', '255, 77, 79']
const ACCENT_APPROVAL = ['#ff9f0a', '255, 159, 10']
const ACCENT_QUESTION = ['#3fd8d0', '63, 216, 208']

/* 挂起型：整块显示多久，然后收成细边 */
const PENDING_FULL_MS = 5000
/* 挂起型是否**无视可见性**也发系统通知。
   默认 false：挂起型跟其它状态守同一条规则（只在没看着 DSH 时发）。
   这曾经是 true —— 当时的理由是"agent 卡着等你，比完成更该被你知道"。真机上用了
   一次就被否掉了：你正盯着屏幕看那块大字板子，同时又弹一条系统通知，纯属重复。
   "系统通知仅限于没看着 DSH 时"是这里最早的、也是唯一的需求，不该为某个状态破例。
   想反过来（挂起一定发）把它改回 true 即可。 */
const PENDING_ALWAYS_NOTIFY = false
/* 细边尺寸。可见的条与接收鼠标的命中区是两回事：
   `EDGE_W/H` 是看得见的那条（`EDGE_H` 只是"还没量到板子高度"时的退路，
   正常情况下脚本会把板子的实测高度写进 `--tt-edge-h`），`EDGE_HIT_W` 与
   `EDGE_HIT_PAD` 决定鼠标真正能碰到的那块。
   `EDGE > EDGE_HIT_W` 必须成立 —— 板子距视口边缘留 `EDGE`，命中区只占最边上
   `EDGE_HIT_W`，两者不重叠，所以鼠标停在命中区时永远不会被板子盖住（那会让
   mouseleave 立刻触发、悬停变成抽搐）。有断言盯着这条不等式。 */
const EDGE_W = 8          // 可见细边宽度（原 6）
const EDGE_H = 128        // 可见细边长度的退路值（实测板子高度优先）
const EDGE_HIT_W = 14     // 鼠标命中区宽度（8px 的条基本点不中）
const EDGE_HIT_PAD = 4    // 命中区比可见的条上下各多出的量

/* 授权请求的文案（对齐 DSH 官方审批面板的措辞） */
const APPROVAL_ASK = '工具 {tool} 请求越权执行'
const QUESTION_ASK = 'agent 在等你回答'
const ASK_KICKER   = '// NOTIFY'
const ASK_TEXT     = '开启系统通知后，DSH 在后台或最小化时也能提醒你。'
const ASK_YES      = '开启'
const ASK_NO       = '不用了'

const ASK_ATTR     = 'data-task-ask'
const ASK_SEEN_KEY = 'dsh-task-toast-asked'
const ASK_AFTER_MS = 600   // 首次提示板消失后，隔多久问一次授权

const CSS = `
[data-task-toast] {
  position: fixed;
  top: ${EDGE}px;
  right: ${EDGE}px;
  z-index: ${Z_INDEX};
  box-sizing: border-box;
  width: ${WIDTH}px;
  padding: 16px 19px 15px 27px;
  background: #101110;
  color: #f5f5f0;
  /* --edge-font 是终末地主题在 body 上声明的；没有它就用回系统字体栈。
     字体栈里刻意保留中文字体，因为 WORD 可能是中文。 */
  font-family: var(--edge-font, Arial, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif);
  /* 等宽数字：时钟跳动时宽度不抖 */
  font-feature-settings: "tnum" 1, "ss01" 1;
  /* 装饰性浮层：绝不吃掉点击与选择 */
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden;
  box-shadow: 0 10px 28px rgb(0 0 0 / .36);
  /* 强调色：装了主题就跟随它的配色令牌，否则用信号黄 */
  --tt-accent: var(--edge-accent, #fff500);
  --tt-accent-rgb: var(--edge-accent-rgb, 255, 245, 0);
  --tt-mid: #8a8d88;
  --tt-dim: #6a6d64;
  --tt-off: #2e302d;
  animation: tt-in 420ms cubic-bezier(.16, 1, .3, 1) both;
}
[data-task-toast][data-task-toast-exit] {
  animation: tt-out ${EXIT_MS}ms ease-in both;
}

/* ---------- 状态配色：只换强调色，骨架不动 ---------- */
[data-task-toast][data-state="error"]    { --tt-accent: ${ACCENT_ERROR[0]};    --tt-accent-rgb: ${ACCENT_ERROR[1]}; }
[data-task-toast][data-state="unopened"] { --tt-accent: ${ACCENT_ERROR[0]};    --tt-accent-rgb: ${ACCENT_ERROR[1]}; }
[data-task-toast][data-state="approval"] { --tt-accent: ${ACCENT_APPROVAL[0]}; --tt-accent-rgb: ${ACCENT_APPROVAL[1]}; }
[data-task-toast][data-state="question"] { --tt-accent: ${ACCENT_QUESTION[0]}; --tt-accent-rgb: ${ACCENT_QUESTION[1]}; }
/* done / subagent 故意没有规则：它们跟随主题的 --edge-accent */

/* ---------- 挂起细边：整块收起后的锚点，也是唯一的鼠标悬停目标 ----------
   贴在视口右上角（不像板子那样留 EDGE 边距），读起来就是"屏幕边缘有个东西亮着"。

   两件事在这里同时解决：

     1. **要看得出来**。原来 6×56 还呼吸到 28% 透明度，实测就是"不明显"。
        现在更长、更宽，呼吸只压到 50%。
     2. **要能悬停**。8px 宽基本点不中，所以真正接收鼠标的是外面这个**命中区**
        （比可见的条宽），可见的条由它的 ::after 画。 */

[data-task-toast-edge] {
  position: fixed;
  /* 和板子共用同一条上边缘：板子从 EDGE 开始，细边也从 EDGE 开始。
     原来是 top:0，比板子整整高出一个 EDGE，看起来就是错位的两截东西。
     命中区比可见的条上下各多 EDGE_HIT_PAD，所以往上让 PAD，可见的条才落在 EDGE 上。 */
  top: calc(${EDGE}px - ${EDGE_HIT_PAD}px);
  right: 0;
  z-index: ${Z_INDEX};
  width: ${EDGE_HIT_W}px;      /* 命中区：比可见的条宽，否则鼠标点不中 */
  height: calc(var(--tt-edge-h, ${EDGE_H}px) + ${EDGE_HIT_PAD * 2}px);
  /* 唯一一处接收鼠标的插件元素。代价是它下面十几像素的应用界面会点不到——
     换来的是"鼠标移上去能重新看到在等什么"。板子本身仍然是穿透的。 */
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
}
[data-task-toast-edge]::after {
  content: '';
  position: absolute;
  top: ${EDGE_HIT_PAD}px;
  right: 0;
  width: ${EDGE_W}px;
  /* 高度由脚本按"板子的实测高度"写进 --tt-edge-h。细边是板子收起后的替身，
     两者必须一样高，否则一眼就看出是两截东西 —— 所以这里不写死常量。 */
  height: var(--tt-edge-h, ${EDGE_H}px);
  background: ${ACCENT_APPROVAL[0]};
  border-radius: 0 0 0 4px;
  box-shadow: 0 0 14px rgb(${ACCENT_APPROVAL[1]} / .55);
  animation: tt-edge 1.5s ease-in-out infinite;
  pointer-events: none;
}
[data-task-toast-edge][data-state="question"]::after {
  background: ${ACCENT_QUESTION[0]};
  box-shadow: 0 0 14px rgb(${ACCENT_QUESTION[1]} / .55);
}
@keyframes tt-edge {
  0%, 100% { opacity: .5 }
  50%      { opacity: 1 }
}

/* ---------- 左侧强调色轨：自上而下填充，对应开机屏那条进度轨 ---------- */
[data-task-toast-rail] {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 10px;
  background: var(--tt-accent);
  transform-origin: top;
  animation: tt-rail 520ms cubic-bezier(.16, 1, .3, 1) both;
}

/* ---------- 头部：// KICKER（时钟挪到底部那行了，见 foot） ---------- */
[data-task-toast-head] {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
[data-task-toast-kicker] {
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: .26em;
  color: var(--tt-accent);
  white-space: nowrap;
}

/* ---------- 主体：雪佛龙 + 大字 ---------- */
[data-task-toast-body] {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 9px;
}
/* 两个叠层雪佛龙，纯边框绘制（继承开机屏的做法：不依赖字形，
   所以任何字体环境下都是同一个形状）。 */
[data-task-toast-chev] {
  position: relative;
  flex: none;
  width: 16px;
  height: 19px;
}
[data-task-toast-chev]::before,
[data-task-toast-chev]::after {
  content: '';
  position: absolute;
  left: 0;
  width: 10px;
  height: 10px;
  border-left: 2px solid var(--tt-accent);
  border-bottom: 2px solid var(--tt-accent);
  transform: rotate(-45deg);
}
[data-task-toast-chev]::before { top: 0; }
[data-task-toast-chev]::after  { top: 8px; }

[data-task-toast-word] {
  font-size: 34px;
  font-weight: 700;
  line-height: 40px;
  letter-spacing: .02em;
  white-space: nowrap;
}

/* ---------- 任务名：一行，超出省略 ----------
   来源是当前会话的 displayTitle —— DSH 自己从对话里生成的简短标题，不是我们编的。
   取不到时由调用方回退成 TAG_DONE。
   单行 + ellipsis 是刻意的：宁可截断，也不让长标题把板子撑成一大块。 */
[data-task-toast-task] {
  margin-top: 5px;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  letter-spacing: .01em;
  color: #cfd3d6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 底部：6 格方块状态条 + 等宽时钟 ---------- */
[data-task-toast-foot] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 11px;
}
[data-task-toast-squares] {
  display: grid;
  grid-template-columns: repeat(6, 13px);
  gap: 4px;
}
[data-task-toast-squares] i {
  display: block;
  height: 4px;
  background: var(--tt-off);
  animation: tt-square 240ms linear both;
}
[data-task-toast-squares] i:nth-child(1) { animation-delay: 120ms; }
[data-task-toast-squares] i:nth-child(2) { animation-delay: 190ms; }
[data-task-toast-squares] i:nth-child(3) { animation-delay: 260ms; }
[data-task-toast-squares] i:nth-child(4) { animation-delay: 330ms; }
[data-task-toast-squares] i:nth-child(5) { animation-delay: 400ms; }
[data-task-toast-squares] i:nth-child(6) { animation-delay: 470ms; }
[data-task-toast-clock] {
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: .08em;
  color: var(--tt-mid);
  white-space: nowrap;
}

/* ---------- 退场扫光：强调色从左铺到右，对应开机屏的黄色铺满 ---------- */
[data-task-toast-wipe] {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  width: 100%;
  background: var(--tt-accent);
  transform-origin: left;
  transform: scaleX(0);
}
[data-task-toast][data-task-toast-exit] [data-task-toast-wipe] {
  animation: tt-wipe ${EXIT_MS}ms cubic-bezier(.4, 0, 1, 1) both;
}

@keyframes tt-in {
  from { opacity: 0; transform: translateX(26px); }
  to   { opacity: 1; transform: none; }
}
@keyframes tt-out {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: translateX(14px); }
}
@keyframes tt-rail {
  from { transform: scaleY(0); }
  to   { transform: scaleY(1); }
}
@keyframes tt-square {
  from { background: var(--tt-off); }
  to   { background: var(--tt-accent); }
}
@keyframes tt-wipe {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}
/* ---------- 一次性授权询问：同一套语言，但可交互 ---------- */
[${ASK_ATTR}] {
  position: fixed;
  top: ${EDGE}px;
  right: ${EDGE}px;
  z-index: ${Z_INDEX};
  box-sizing: border-box;
  width: ${WIDTH}px;
  padding: 13px 15px 13px 23px;
  background: #101110;
  color: #f5f5f0;
  font-family: var(--edge-font, Arial, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-feature-settings: "tnum" 1, "ss01" 1;
  overflow: hidden;
  box-shadow: 0 10px 28px rgb(0 0 0 / .36);
  /* 这块是要点的，不能像提示板那样穿透 */
  pointer-events: auto;
  --tt-accent: var(--edge-accent, #fff500);
  animation: tt-in 420ms cubic-bezier(.16, 1, .3, 1) both;
}
[data-task-ask-rail] {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 8px;
  background: var(--tt-accent);
}
[data-task-ask-kicker] {
  display: block;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: .26em;
  color: var(--tt-accent);
}
[data-task-ask-text] {
  margin-top: 7px;
  font-size: 12px;
  font-weight: 400;
  line-height: 19px;
  color: #e6e6e0;
}
[data-task-ask-actions] {
  display: flex;
  gap: 6px;
  margin-top: 11px;
}
[${ASK_ATTR}] button {
  flex: 1 1 0;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  padding: 6px 10px;
  border-radius: 0;
  cursor: pointer;
  background: transparent;
  color: #f5f5f0;
  border: 1px solid #4a4d49;
  transition: none;
}
[${ASK_ATTR}] button[data-task-ask-yes] {
  background: var(--tt-accent);
  border-color: var(--tt-accent);
  color: #101110;
}
[${ASK_ATTR}] button[data-task-ask-no]:hover { border-color: #6a6d64; }
[${ASK_ATTR}] button:focus-visible { outline: 2px solid var(--tt-accent); outline-offset: 1px; }

/* 尊重系统「减少动态效果」：保留出现/消失（那是信息，不是装饰），
   但取消位移与扫光。和开机屏在 reduced-motion 下的取舍一致。 */
@media (prefers-reduced-motion: reduce) {
  [data-task-toast],
  [data-task-toast][data-task-toast-exit],
  [${ASK_ATTR}] { animation: none; }
  [data-task-toast-rail],
  [data-task-toast-squares] i { animation: none; background: var(--tt-accent); }
  [data-task-toast-wipe] { display: none; }
  /* 细边保留提示，但不再呼吸 —— 常亮即可，动效不是信息。
     动画现在挂在 ::after 上（可见的条），所以要打在 ::after 上。 */
  [data-task-toast-edge]::after { animation: none; opacity: 1; }
}
`

/* ---------------------------------------------------------------- 样式注入 */

function insertCss(css) {
  if (typeof document === 'undefined') return () => {}
  // Idempotent: the bundle can be applied more than once (boot loader + cordis
  // composition). Never stack duplicate sheets.
  document.querySelectorAll('style[data-plugin="' + CSS_TAG_ID + '"]').forEach((old) => old.remove())
  const el = document.createElement('style')
  el.setAttribute('data-plugin', CSS_TAG_ID)
  el.textContent = css
  document.head.appendChild(el)
  return () => { if (el.parentNode) el.parentNode.removeChild(el) }
}

/* ---------------------------------------------------------------- 提示板 */

let plate = null
let plateTimer = null
let plateExitTimer = null
let plateShownAt = null   // ms when the plate went up; used by the stale-plate guard
/* A sticky plate represents a PENDING state, not an event: it has no auto-dismiss
   deadline (it collapses to the edge bar instead), and the stale-plate guard must
   not reap it on the normal TOAST_MS deadline. */
let plateSticky = false
let plateState = 'done'
/* 最近一次渲染出来的板子高度（px）。细边是板子收起后的替身，要跟它一样高——写死一个
   常量就会在字号/主题/文案变化后对不上。0 = 还没量到，回到 EDGE_H 的退路值。 */
let plateHeight = 0

/* ------------------------------------------------------------ 挂起细边 */

let edgeEl = null
let edgeState = null
/* 鼠标是否停在那条细边上，以及当前这块板子是不是"因为悬停才展开的"。
   两者要分开：悬停展开的板子在你移开鼠标时应当收回，但"新挂起刚到达"的那次
   播报不该被你顺手扫过角落的鼠标掐断。 */
let edgeHovered = false
let peekShown = false

/* 把当前已知的板子高度交给细边。两处调用：细边创建时，以及每次渲染完板子之后
   —— 因为第一次挂起时细边是**先于**板子高度测量的（syncPending 先建边、再弹板），
   只在创建时写一次会永远停在退路值上。 */
function applyEdgeHeight() {
  if (edgeEl === null || plateHeight <= 0) return
  try {
    if (edgeEl.style && typeof edgeEl.style.setProperty === 'function') {
      edgeEl.style.setProperty('--tt-edge-h', plateHeight + 'px')
    }
  } catch (e) { /* ignore */ }
}

function showEdge(state) {
  if (typeof document === 'undefined' || document.body === null) return
  edgeState = state
  if (edgeEl !== null) { edgeEl.setAttribute('data-state', state); return }
  const el = document.createElement('div')
  el.setAttribute('data-task-toast-edge', '')
  el.setAttribute('data-state', state)
  el.setAttribute('aria-hidden', 'true')
  // 与板子同高（见 plateHeight 的说明）。没有测量值时什么都不设，CSS 里的
  // var(--tt-edge-h, EDGE_Hpx) 退路会接住。
  try {
    if (plateHeight > 0 && el.style && typeof el.style.setProperty === 'function') {
      el.style.setProperty('--tt-edge-h', plateHeight + 'px')
    }
  } catch (e) { /* ignore */ }
  /* 悬停即重新展开。板子本身是穿透的（没有按钮、没有可点的东西），所以鼠标
     永远不需要移到板子上去 —— 这正是这里不会抽搐的原因：从细边朝板子方向移动
     只是让悬停结束、板子收回而已。 */
  try {
    el.addEventListener('mouseenter', () => { edgeHovered = true; peekPending() })
    el.addEventListener('mouseleave', () => { edgeHovered = false; endPeek() })
  } catch (e) { /* ignore */ }
  document.body.appendChild(el)
  edgeEl = el
}

/* 悬停展开：只在"已经收起"时动手，正在整块播报时不动它。 */
function peekPending() {
  const top = pendingTop()
  if (top === null) return
  if (plate !== null && plateSticky) return
  showToast(top.word, top.detail, top.state, true)
  peekShown = true
}

/* 移开鼠标：只有"悬停展开的那块"才收回去。 */
function endPeek() {
  const top = pendingTop()
  if (top === null) return          // 没有挂起：屏幕上是别人的板子，别动它
  if (peekShown) { peekShown = false; hideToast() }
  showEdge(top.state)
}

function removeEdge() {
  edgeState = null
  edgeHovered = false
  peekShown = false
  if (edgeEl === null) return
  if (edgeEl.parentNode) edgeEl.parentNode.removeChild(edgeEl)
  edgeEl = null
}

/* ---------------------------------------------------------------- 挂起集合

   Approvals and questions arrive from `ctx.remote` and stay open until the user
   answers them (or their transport dies). More than one can be open at once, so
   this is a SET and not a flag: the newest one owns the plate, and the edge bar
   stays up until the set is empty. */
let pendings = []           // [{ id, state, word, detail }]
let pendingSeq = 0
let collapseTimer = null

function pendingTop() { return pendings.length > 0 ? pendings[pendings.length - 1] : null }

function addPending(state, word, detail) {
  pendingSeq += 1
  const id = pendingSeq
  pendings.push({ id, state, word, detail })
  syncPending('arrive')      // a NEW thing is waiting: give it its full announcement
  return id
}

function removePending(id) {
  const before = pendings.length
  pendings = pendings.filter((p) => p.id !== id)
  if (pendings.length !== before) syncPending('depart')
}

/* A pending that is still there may still have changed its wording (the panel
   re-rendered with a different reason). Refresh in place WITHOUT re-announcing —
   an arrival is what earns a full plate, not a repaint. */
function updatePending(id, word, detail) {
  if (word === undefined || detail === undefined) return
  let plateDirty = false
  for (let i = 0; i < pendings.length; i++) {
    if (pendings[i].id !== id) continue
    if (pendings[i].word === word && pendings[i].detail === detail) return
    pendings[i].word = word
    pendings[i].detail = detail
    if (i === pendings.length - 1) plateDirty = true     // the newest owns the plate
  }
  if (plateDirty && plateSticky && plate !== null) {
    const top = pendingTop()
    if (top !== null) showToast(top.word, top.detail, top.state, true)
  }
}

function armCollapse() {
  if (collapseTimer !== null && typeof clearTimeout === 'function') clearTimeout(collapseTimer)
  collapseTimer = null
  if (typeof setTimeout !== 'function') return
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    const still = pendingTop()
    if (still === null) return
    // 鼠标正停在那条细边上：让它保持展开，并把它记成"悬停展开的"，
    // 这样你移开鼠标时它会收回（否则它会一直挂在那儿）。
    if (edgeHovered) { peekShown = true; return }
    hideToast()
    showEdge(still.state)
  }, PENDING_FULL_MS)
}

/* Reconcile the presentation with the pending set. Idempotent, and the only place
   that decides between the three presentations (full plate / edge bar / nothing).

   The two transitions are NOT symmetric, and that asymmetry is the whole point:

     arrive  -> full plate. A new thing is waiting; announce it properly.
     depart  -> the bar (or back to the plate if the pointer is holding it open).
                You just answered something, so the screen goes quiet and the bar
                keeps only the remaining fact. Re-announcing here would both nag
                and — worse — leave the plate showing the item you already dealt
                with.

   The bar element itself lives for as long as ANYTHING is pending — it is the
   hover target, and an element removed from under the pointer never fires
   `mouseleave`, which would strand `edgeHovered` at true forever. */
function syncPending(mode) {
  const top = pendingTop()
  if (top === null) {
    if (collapseTimer !== null && typeof clearTimeout === 'function') clearTimeout(collapseTimer)
    collapseTimer = null
    removeEdge()
    if (plateSticky) hideToast()
    return
  }
  showEdge(top.state)
  if (mode !== 'arrive') {
    // 鼠标还停在细边上：收掉板子等于跟你作对，重新展开它。
    if (edgeHovered) { peekPending(); return }
    if (plateSticky && plate !== null) hideToast()
    return
  }
  // 到达：整块播报。细边**保留**——它是悬停目标，而一个从鼠标底下被移除的元素
  // 永远不会触发 mouseleave，那会把 edgeHovered 永久卡在 true。视觉上它成了板子
  // 旁边的锚点（板子距边缘 18px，命中区只占最边上 14px，两者不重叠）。
  peekShown = false          // 这是播报，不是悬停展开：移开鼠标不该掐断它
  showToast(top.word, top.detail, top.state, true)
  armCollapse()
}

function pad2(n) { return (n < 10 ? '0' : '') + n }

function stamp() {
  const d = new Date()
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

function hideToast() {
  if (plateTimer !== null) { clearTimeout(plateTimer); plateTimer = null }
  plateShownAt = null
  plateSticky = false
  if (plate === null) return
  const el = plate
  plate = null
  el.setAttribute('data-task-toast-exit', '')
  const drop = () => { if (el.parentNode) el.parentNode.removeChild(el) }
  if (typeof setTimeout === 'function') {
    plateExitTimer = setTimeout(() => { plateExitTimer = null; drop() }, EXIT_MS + 40)
  } else drop()
}

/* Sweep EVERY plate node out of the body, including one that is mid-exit.
   Needed by teardown: cancelling plateExitTimer (which teardown must do) also
   cancels the removal it was going to perform, so a plate that happened to be
   animating out at that moment would be orphaned in the DOM forever with nothing
   left holding a reference to it. */
function removeAllPlates() {
  try {
    if (typeof document === 'undefined' || document.body === null) return
    const kids = document.body.children
    if (kids === null || kids === undefined) return
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i]
      if (c !== null && c !== undefined && typeof c.hasAttribute === 'function' && c.hasAttribute('data-task-toast')) {
        if (c.parentNode) c.parentNode.removeChild(c)
      }
    }
  } catch (e) { /* ignore */ }
}

/* Reap a plate whose own timer was starved.
   The plate is shown whatever you are looking at, so it can go up while the page
   is hidden — and a hidden page clamps timers hard (a background tab will not
   honour a 5s timeout on schedule, a suspended webview may not run it at all).
   The result is a plate still on screen long after it asked to leave. Judge the
   deadline by the clock instead of trusting the timer that got throttled, and
   only reap what has genuinely overstayed: anything younger keeps its full life.

   A STICKY plate has no leave deadline — its deadline is the collapse to the bar,
   which is a different (longer) one. Applying TOAST_MS to it would cut a pending
   plate short, so it gets its own branch. */
function reapStalePlate() {
  if (plate === null || plateShownAt === null) return
  if (!isLookingAtDsh()) return
  // 鼠标正指着它：这时候把它收掉等于跟用户作对。
  if (edgeHovered) return
  if (plateSticky) {
    if (Date.now() - plateShownAt < PENDING_FULL_MS) return
    const still = pendingTop()
    if (still === null) { hideToast(); return }
    hideToast()
    showEdge(still.state)
    return
  }
  if (Date.now() - plateShownAt < TOAST_MS) return
  hideToast()
}

/* `state` picks the accent (see the state table); `sticky` marks a plate that
   represents a PENDING state and therefore has no auto-dismiss deadline — its
   lifecycle is owned by syncPending(), not by a timer here. */
function showToast(word, task, state, sticky) {
  if (typeof document === 'undefined' || document.body === null) return
  // One plate at a time: a second completion replaces the first rather than
  // stacking, and the exit animation of the old one is dropped with it.
  if (plate !== null) {
    if (plateExitTimer !== null) { clearTimeout(plateExitTimer); plateExitTimer = null }
    if (plate.parentNode) plate.parentNode.removeChild(plate)
    plate = null
  }
  if (plateTimer !== null) { clearTimeout(plateTimer); plateTimer = null }

  const el = document.createElement('div')
  el.setAttribute('data-task-toast', '')
  // Decorative: keep it out of the accessibility tree and out of translators'
  // way (a toast is not information a screen reader must read over the reply).
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('translate', 'no')
  el.setAttribute('lang', 'en')
  el.className = 'notranslate'
  el.innerHTML =
    '<div data-task-toast-rail></div>' +
    '<div data-task-toast-head>' +
      '<span data-task-toast-kicker></span>' +
    '</div>' +
    '<div data-task-toast-body>' +
      '<div data-task-toast-chev></div>' +
      '<div data-task-toast-word></div>' +
    '</div>' +
    '<div data-task-toast-task></div>' +
    '<div data-task-toast-foot>' +
      '<span data-task-toast-squares>' +
        '<i></i><i></i><i></i><i></i><i></i><i></i>' +
      '</span>' +
      '<span data-task-toast-clock></span>' +
    '</div>' +
    '<div data-task-toast-wipe></div>'
  // textContent, never innerHTML, for anything variable. The task line is user
  // content (a session title) and MUST NOT be interpolated into markup.
  el.querySelector('[data-task-toast-kicker]').textContent = KICKER
  el.querySelector('[data-task-toast-clock]').textContent = stamp()
  el.querySelector('[data-task-toast-word]').textContent = word
  el.querySelector('[data-task-toast-task]').textContent = task

  document.body.appendChild(el)
  plate = el
  plateShownAt = Date.now()
  plateSticky = sticky === true
  plateState = state === undefined || state === null ? 'done' : state
  el.setAttribute('data-state', plateState)
  /* 记下这一块的实际高度，细边要跟它一样高。用 offsetHeight 而不是
     getBoundingClientRect()：后者包含 transform，而入场动画正是靠 translateX 做的。 */
  try {
    const h = el.offsetHeight
    if (typeof h === 'number' && h > 0) plateHeight = h
  } catch (e) { /* ignore */ }
  applyEdgeHeight()      // 细边可能已经先建好了（第一次挂起就是这个顺序）
  // A sticky plate is owned by syncPending(); giving it a TOAST_MS deadline here
  // would dismiss a pending state that nobody has answered yet.
  if (!plateSticky && typeof setTimeout === 'function') plateTimer = setTimeout(hideToast, TOAST_MS)
}

/* ---------------------------------------------------------------- 系统通知 */

/* The OS toast — the only channel that reaches you while you are in another
   application. Returns true only when one was actually raised, so callers (and
   the verification harness) can tell "not permitted" from "permitted".

   THE TAG IS A CONTRACT WITH THE TAURI DESKTOP SHELL. That shell injects a shim
   which replaces window.Notification inside the DSH iframe, reports
   permission === 'granted' unconditionally, forwards every `new Notification`
   to the host as `dsh://native-notification`, and raises a real OS notification.
   To wire up click-to-focus it recovers the session id as:

       options.sessionId || /^dsh-notification-(?:pending-)?(.+)-\d+$/.exec(tag)

   A tag that does NOT match still notifies, but clicking it goes nowhere. So the
   id is passed BOTH ways — the explicit option and a tag in the expected shape —
   which keeps working whichever one the host reads.

   None of this is special on a plain browser: unknown Notification options are
   ignored per spec, and the tag just gives each session its own dedupe slot. */
function notifyOS(body, sessionId, title) {
  if (typeof Notification === 'undefined' || Notification === null) return false
  let perm
  try { perm = Notification.permission } catch (e) { return false }
  if (perm !== 'granted') return false
  try {
    const id = (typeof sessionId === 'string' && sessionId !== '') ? sessionId : ''
    const opts = {
      body: body || '',
      tag: id === '' ? 'dsh-task-toast' : ('dsh-notification-' + id + '-0'),
    }
    if (id !== '') opts.sessionId = id
    const n = new Notification(typeof title === 'string' && title !== '' ? title : NOTIFY_TITLE, opts)
    // Clicking the OS toast: on the desktop shell the host focuses the session
    // itself; on a plain browser this at least brings the window forward.
    try {
      n.onclick = () => {
        try { if (typeof window !== 'undefined' && window.focus) window.focus() } catch (e) { /* ignore */ }
        try { n.close() } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return true
  } catch (e) { return false }
}

/* ------------------------------------------------------------ 我正被看着吗 */

/* The gate for every channel meant to reach you ELSEWHERE, and the reason the
   two visible channels never double up.

   Read document.hidden / visibilityState — deliberately NOT document.hasFocus():

   - On the Tauri desktop shell this is exactly right and not a guess. Its
     injected shim REDEFINES both properties inside the DSH iframe so they mirror
     the HOST window (host blur/background -> hidden, host focus -> visible), and
     corrects them from `dsh://visibility-state`. It exists precisely so a page
     can tell whether the desktop app is being looked at.
   - On a plain browser the same read is the standard tab-visibility signal, the
     closest equivalent there is.
   - hasFocus() would be WRONG here: the DSH page lives in an iframe, so clicking
     the shell's own navbar blurs the iframe and would read as "not looking" —
     producing an OS toast while you are staring straight at DSH.

   Fails SAFE: anything unreadable counts as "looking", because the failure mode
   we refuse is spamming a desktop notification, not missing a plate. */
const isLookingAtDsh = () => {
  try {
    if (typeof document === 'undefined') return true
    if (document.hidden === true) return false
    if (document.visibilityState === 'hidden') return false
    return true
  } catch (e) { return true }
}

/* ---------------------------------------------------------------- 标题栏前缀 */

let titleSaved = null

function flashTitle() {
  if (typeof document === 'undefined') return
  if (titleSaved !== null) return                  // already badged
  const cur = document.title
  if (cur.indexOf(TITLE_PREFIX) === 0) return
  titleSaved = cur
  document.title = TITLE_PREFIX + cur
  // Clear as soon as you are back. BOTH events are registered: the desktop
  // shell's shim dispatches a synthetic `visibilitychange`, while a plain
  // browser fires `focus` — and a stale ● would outlive the thing it stands for.
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', clearTitleFlash, { once: true })
      window.addEventListener('visibilitychange', clearTitleFlash, { once: true })
    }
  } catch (e) { /* ignore */ }
}

function clearTitleFlash() {
  if (titleSaved === null) return
  // visibilitychange also fires on the way OUT; only clear on the way back IN.
  if (!isLookingAtDsh()) return
  // Only undo our OWN badge: if the app rewrote the title while we were badged,
  // that value is newer and must win.
  if (typeof document !== 'undefined' && document.title === TITLE_PREFIX + titleSaved) {
    document.title = titleSaved
  }
  titleSaved = null
}

/* ---------------------------------------------------------------- 授权询问 */

let askEl = null
let askTimer = null

function askSeen() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(ASK_SEEN_KEY) === '1' } catch (e) { return false }
}
function markAskSeen() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(ASK_SEEN_KEY, '1') } catch (e) { /* ignore */ }
}

function removeAsk() {
  if (askEl === null) return
  const el = askEl
  askEl = null
  if (el.parentNode) el.parentNode.removeChild(el)
}

function requestPermission() {
  try {
    if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return
    // Called straight from the button's click handler: that IS the user gesture
    // the browser requires. The promise form is used when available; the legacy
    // callback form returns undefined and is simply not awaited.
    const p = Notification.requestPermission()
    if (p && typeof p.then === 'function') p.then(() => {}, () => {})
  } catch (e) { /* ignore */ }
}

function showAsk() {
  if (typeof document === 'undefined' || document.body === null) return
  if (askEl !== null) return
  if (document.querySelector('[' + ASK_ATTR + ']') !== null) return
  hideToast()   // never let the two plates overlap

  const el = document.createElement('div')
  el.setAttribute(ASK_ATTR, '')
  el.setAttribute('translate', 'no')
  el.innerHTML =
    '<div data-task-ask-rail></div>' +
    '<span data-task-ask-kicker></span>' +
    '<div data-task-ask-text></div>' +
    '<div data-task-ask-actions>' +
      '<button type="button" data-task-ask-yes></button>' +
      '<button type="button" data-task-ask-no></button>' +
    '</div>'
  el.querySelector('[data-task-ask-kicker]').textContent = ASK_KICKER
  el.querySelector('[data-task-ask-text]').textContent = ASK_TEXT
  const yes = el.querySelector('[data-task-ask-yes]')
  const no = el.querySelector('[data-task-ask-no]')
  yes.textContent = ASK_YES
  no.textContent = ASK_NO
  yes.addEventListener('click', () => { markAskSeen(); requestPermission(); removeAsk() })
  no.addEventListener('click', () => { markAskSeen(); removeAsk() })

  document.body.appendChild(el)
  askEl = el
}

/* Ask at most once, and only while the outcome is still undecided: 'granted'
   needs nothing, and 'denied' must be respected, never nagged. */
function maybeAskPermission() {
  if (!OS_NOTIFY) return
  if (typeof Notification === 'undefined' || Notification === null) return
  let perm
  try { perm = Notification.permission } catch (e) { return }
  if (perm !== 'default') return
  if (askSeen()) return
  if (askTimer !== null) return
  if (typeof setTimeout !== 'function') return
  askTimer = setTimeout(() => {
    askTimer = null
    // Re-check: permission may have been granted elsewhere in the meantime.
    try { if (Notification.permission !== 'default') return } catch (e) { return }
    showAsk()
  }, TOAST_MS + ASK_AFTER_MS)
}

/* ---------------------------------------------------------------- 信号源 */

function apply(ctx) {
  // One application per page session; released on teardown so a dispose +
  // re-apply mounts the feature again instead of staying dead.
  if (typeof window !== 'undefined' && window.__dshTaskToastApplied) return
  if (typeof document === 'undefined') return
  window.__dshTaskToastApplied = true

  const disposeStyles = insertCss(CSS)

  const getSessions = () => {
    try { return ctx.get('sessions') } catch (e) { return undefined }
  }

  // The authoritative running bit. Returns null when the face is not readable
  // yet (a session staged before its window opens) — null is a live state, and
  // it is what the baseline guard keys off.
  const readRunning = (face) => {
    try {
      const snap = face.getSnapshot()
      if (snap === null || typeof snap !== 'object') return null
      return typeof snap.running === 'boolean' ? snap.running : null
    } catch (e) { return null }
  }
  const readSnap = (face) => {
    try {
      const snap = face.getSnapshot()
      return (snap === null || typeof snap !== 'object') ? null : snap
    } catch (e) { return null }
  }

  let rebindTimer = null
  let unsubList = null
  let unsubSession = null
  let watchedId = null
  let lastRunning = null
  let disposed = false
  let domObserver = null
  let domScanTimer = null

  // A session's display title, for the OS toast's body and the detail line.
  // Best-effort: an absent row simply yields an empty string, and the toast still
  // works. Takes an id because a pending state may belong to ANOTHER session.
  const titleOf = (id) => {
    try {
      if (typeof id !== 'string' || id === '') return ''
      const sessions = getSessions()
      if (sessions === undefined || sessions === null) return ''
      const snap = sessions.list.getSnapshot()
      const row = (snap && snap.byId) ? snap.byId[id] : null
      return (row && typeof row.displayTitle === 'string') ? row.displayTitle : ''
    } catch (e) { return '' }
  }
  const currentTitle = () => titleOf(watchedId)

  /* ---- 还有别的会话挂在它底下在跑吗 ----
     用来把"这一回合结束了"和"整件事干完了"分开。两条容易搞错的事实：

       1. 快照上的 `subagent` 说的是"**这个会话自己**是个 subagent"（主会话上
          永远是 null），不是"它有子 agent"。父侧信号只在列表快照里。
       2. 列表行投影到公开面时，父链接叫 `parentId`，不叫内部的
          `parentSessionId`。用错名字会得到一个永远为假的判定。
     只认"有子会话在跑"，不认 catalog —— catalog 只有你展开过才建。 */
  const childrenRunning = () => {
    try {
      const sessions = getSessions()
      if (sessions === undefined || sessions === null) return false
      const snap = sessions.list.getSnapshot()
      const byId = snap && snap.byId
      if (byId === null || typeof byId !== 'object') return false
      const ids = Object.keys(byId)
      for (let i = 0; i < ids.length; i++) {
        const row = byId[ids[i]]
        if (row && row.parentId === watchedId && row.running === true) return true
      }
      return false
    } catch (e) { return false }
  }

  /* ---- 两个可见通道的公共出口 ----
     瞬时型状态全都从这里走，所以"板子永远显示、系统通知才挂可见性判据"这条
     规则只有一份实现。`force` 给挂起型用：agent 正卡着等你，那比"完成了"更
     该被你知道，所以无视可见性也要发。 */
  const notifyMaybe = (title, body, force) => {
    const away = !isLookingAtDsh()
    if (!OS_NOTIFY) return false
    if (force || away || !OS_NOTIFY_ONLY_WHEN_AWAY) return notifyOS(body, watchedId, title)
    return false
  }
  const announce = (word, detail, state, notifyTitle, force) => {
    // 挂起中的整块板子优先：它代表"有东西在等你"，不能被一条完成/错误顶掉。
    if (!(plateSticky && plate !== null)) showToast(word, detail, state, false)
    notifyMaybe(notifyTitle, detail, force === true)
    badgeIfAway()
  }
  // The `●` title badge is the cheap taskbar affordance, and it follows the same
  // visibility rule as the OS toast. Shared so the pending path cannot drift from
  // the transient one (it did: pendings used to notify without badging).
  function badgeIfAway() {
    if (TITLE_BADGE && !isLookingAtDsh()) flashTitle()
  }

  /* ---- 错误 ----
     `api-session/error` 是"没有 turn 位置的实时失败"的出口，它喂的是快照上的
     lastAgentError。关键在于 lastAgentError 是**粘性**的 —— 只在连接/重置时清空，
     不会自己消失。所以"非空就报"会永远挂着一个过期的 ERROR：只在**内容变化**
     时报一次，而且切换会话时把到达时那个值当基线。 */
  let lastErrorSeen = null
  let lastOpenState = null
  const reportError = (message) => {
    let text = ''
    try { text = message === null || message === undefined ? '' : String(message) } catch (e) { text = '' }
    if (text === '' || text === lastErrorSeen) return false
    lastErrorSeen = text
    announce(WORD_ERROR, text, 'error', NOTIFY_TITLE_ERROR, false)
    return true
  }
  const reportOpenError = (openError) => {
    let text = ''
    try {
      if (openError !== null && openError !== undefined) {
        text = typeof openError === 'string' ? openError : String(openError.message || openError.code || openError)
      }
    } catch (e) { text = '' }
    if (text === '') text = currentTitle() || TAG_DONE
    announce(WORD_UNOPENED, text, 'unopened', NOTIFY_TITLE_UNOPENED, false)
  }

  /* ---- 曾经的写法：订阅远程瀑布事件 ----
     这里原来注册 `approval/request` / `user-questions/request` / `api-session/error`
     三个 `ctx.remote.$on` 监听器（含"必须 return next() 交回决策"的契约）。真机上
     一个事件都收不到，已整块换成下面的 DOM 观测；这段注释留着是为了说明**为什么
     不走那条路**，免得以后有人又照着官方插件的写法改回去。 */

  /* ============================ 挂起状态：看 DOM ============================

     为什么不订阅 `approval/request` / `user-questions/request`。

     那两个是 DSH 的**瀑布远程事件**，官方插件用的就是它们，我也按同样的写法实现
     过（含"必须 return next()"的契约和对应的变异测试）。但真机上**一个远程事件都
     送不到**：实测 `sess=yes remote=yes $on=yes` 而命中数为 0，即服务取得到、`$on`
     不报错、监听器却从不被调用。查过 cordis 的投递实现（EventsService 建在 root、
     子 ctx 原型继承、emit 类派发不过滤），也验过同类的用户插件 `dsh-tauri-model-config`
     确实是用 `ctx.get('remote')` 的——所以"这条路对用户插件不成立"不成立，但在这个
     桌面环境里它就是不工作，而我没有可靠手段继续往下挖。

     改用**官方面板渲染出来的 DOM** 作为唯一真相：两个面板都带语义化的 data 属性
     （`data-approval-key` / `data-question-key` / `data-plan-review-key`），这是它们
     自己的选择器钩子，不是哈希过的 CSS 类名。

     这条路顺带**消掉了本插件唯一一处"写错会让 DSH 卡死"的风险**：不再监听瀑布，
     就再也不可能吞掉官方审批面板。 */
  /* The panels' own fixed copy, so the detail line is what is being ASKED rather
     than the buttons. Taken from the official dictionaries (approval: waiting /
     reject / allowOnce; user-questions: the composer's nav + action labels). Not
     stripping them would put 拒绝允许一次 on the card. `计划待审` is deliberately
     KEPT — it is a meaningful state label, not a button. */
  const APPROVAL_COPY = ['等待审批', 'Waiting for approval', '审批详情', 'Approval details', '拒绝', 'Reject', '允许一次', 'Allow once']
  const QUESTION_COPY = [
    '请先完成这道问题。', '请选择一个选项或填写自定义答案。',
    '上一题', '下一题', '收起问题卡片', '展开问题卡片', '放弃整组问题', '推荐',
    '输入你的答案', '跳过本题', '确认执行', '拒绝', '去聊天里说',
    'Previous question', 'Next question', 'Dismiss all questions',
    'Skip this question', 'Submit', 'Recommended', 'Enter your answer',
  ]

  const PENDING_PROBES = [
    { state: 'approval', word: WORD_APPROVAL, notify: NOTIFY_TITLE_APPROVAL, attr: 'data-approval-key', strip: APPROVAL_COPY },
    { state: 'question', word: WORD_QUESTION, notify: NOTIFY_TITLE_QUESTION, attr: 'data-question-key', strip: QUESTION_COPY },
    { state: 'question', word: WORD_QUESTION, notify: NOTIFY_TITLE_QUESTION, attr: 'data-plan-review-key', strip: QUESTION_COPY },
  ]

  const squash = (s) => {
    let out = ''
    let space = false
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      const isSpace = c === 32 || c === 9 || c === 10 || c === 13 || c === 0x3000
      if (isSpace) { space = out !== ''; continue }
      if (space) { out += ' '; space = false }
      out += s.charAt(i)
    }
    return out
  }

  const scanPending = () => {
    const found = []
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return found
    for (let i = 0; i < PENDING_PROBES.length; i++) {
      const probe = PENDING_PROBES[i]
      let nodes = null
      try { nodes = document.querySelectorAll('[' + probe.attr + ']') } catch (e) { nodes = null }
      if (nodes === null || nodes === undefined || typeof nodes.length !== 'number') continue
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j]
        let raw = ''
        try { raw = typeof node.textContent === 'string' ? node.textContent : '' } catch (e) { raw = '' }
        let detail = squash(raw)
        for (let k = 0; k < probe.strip.length; k++) detail = detail.split(probe.strip[k]).join(' ')
        detail = squash(detail)
        if (detail === '') detail = probe.state === 'approval' ? APPROVAL_ASK.split('{tool}').join('?') : QUESTION_ASK
        let key = ''
        try { key = node.getAttribute(probe.attr) } catch (e) { key = '' }
        if (typeof key !== 'string' || key === '') key = probe.attr + ':' + String(j)
        found.push({ state: probe.state, word: probe.word, notify: probe.notify, key: probe.key || (probe.attr + '|' + key), detail: detail })
      }
    }
    return found
  }

  /* Diff the DOM against the pending set: appear -> announce, disappear -> clear.
     Keyed by the panel's own attribute value, so a panel that re-renders in place
     (same key) is not re-announced. */
  let domPending = {}      // probeKey -> pending id
  const syncFromDom = () => {
    let found = []
    try { found = scanPending() } catch (e) { found = [] }
    const present = {}
    for (let i = 0; i < found.length; i++) {
      const f = found[i]
      present[f.key] = true
      if (domPending[f.key] !== undefined) {
        // Already known: refresh the wording (a re-render may change the reason).
        updatePending(domPending[f.key], f.word, f.detail)
        continue
      }
      const id = addPending(f.state, f.word, f.detail)
      domPending[f.key] = id
      notifyMaybe(f.notify, f.detail, PENDING_ALWAYS_NOTIFY)
      badgeIfAway()
    }
    const keys = Object.keys(domPending)
    for (let i = 0; i < keys.length; i++) {
      if (present[keys[i]] === true) continue
      const id = domPending[keys[i]]
      delete domPending[keys[i]]
      removePending(id)
    }
  }

  const watchDom = () => {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined' || document.body === null) return null
    /* `disposed` is the load-bearing half of teardown for the DOM route: without it
       a mutation observed just before teardown would schedule a scan that runs
       after it, and a detached plugin would raise a plate (and an OS toast) one
       last time. Teardown disconnects the observer and cancels any armed timer
       too, so this is the guard that covers the in-flight case. */
    const schedule = () => {
      if (disposed || domScanTimer !== null) return
      if (typeof setTimeout !== 'function') { syncFromDom(); return }
      domScanTimer = setTimeout(() => { domScanTimer = null; syncFromDom() }, 60)
    }
    let mo = null
    try {
      mo = new MutationObserver(() => { schedule() })
      mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    } catch (e) { mo = null }
    return mo
  }

  /* Everything that happens when one turn ends. Kept in ONE place so the channels
     cannot drift apart, and so each stays independently switchable.

     THE TWO CHANNELS ARE INDEPENDENT — the plate is the primary one and always
     fires; the OS toast is the one that is conditioned:

       plate  -> always. This is the in-DSH answer to "a task finished", and it is
                 what the popup is FOR; suppressing it because the page judges
                 itself unfocused made the feature silently do nothing.
       OS     -> only while you are NOT looking at DSH (OS_NOTIFY_ONLY_WHEN_AWAY).
                 An OS toast on top of a plate you are already reading is noise.
       ● title-> only while away; a taskbar affordance means nothing while focused.

     Note this also keeps the plate out of a backgrounded page, where timer
     throttling would otherwise leave it on screen longer than asked — see
     reapStalePlate(), which is the second half of that guarantee. */
  const onTurnEnd = () => {
    const title = currentTitle()
    // The session title IS the brief "what was this about" label: DSH derives it
    // from the conversation itself, so nothing is invented here and nothing extra
    // is fetched. A brand-new session has no title yet — fall back to a neutral
    // status word rather than showing an empty line.
    const task = title !== '' ? title : TAG_DONE
    // "This turn is over" is not the same claim as "the work is done": if subagent
    // sessions are still running under this one, COMPLETE would be a lie.
    const delegated = childrenRunning()
    if (delegated) announce(WORD_SUBAGENT, task, 'subagent', NOTIFY_TITLE, false)
    else announce(WORD_DONE, task, 'done', NOTIFY_TITLE, false)
    maybeAskPermission()                       // one-shot, only while undecided
  }

  const detachSession = () => {
    if (typeof unsubSession === 'function') { try { unsubSession() } catch (e) { /* ignore */ } }
    unsubSession = null
    watchedId = null
    lastRunning = null
    lastOpenState = null
  }

  const subscribeList = (sessions) => {
    if (unsubList !== null) return
    try {
      if (sessions.list && typeof sessions.list.subscribe === 'function') {
        const u = sessions.list.subscribe(() => { rebind() })
        unsubList = typeof u === 'function' ? u : null
      }
    } catch (e) { unsubList = null }
  }

  /* Bind the CURRENT session's face and edge-detect `running`.
     Mirrors the proven shape (and its two hard-won properties):
       1. the first readable value is a BASELINE, never an edge — so switching
          into a session that is already running stays silent;
       2. `early === null` is respected: a face whose window is not open yet is
          still subscribed, and its first real value becomes the baseline. */
  function rebind() {
    if (disposed) return
    if (rebindTimer !== null) { clearTimeout(rebindTimer); rebindTimer = null }
    const sessions = getSessions()
    if (sessions === undefined || sessions === null) {
      // The service can legitimately settle after apply(): the web boot mounts
      // every plugin row concurrently. Keep retrying rather than giving up.
      if (typeof setTimeout === 'function') rebindTimer = setTimeout(rebind, RETRY_MS)
      return
    }
    subscribeList(sessions)

    let id
    try {
      const snap = sessions.list.getSnapshot()
      id = (snap === null || typeof snap !== 'object') ? undefined : snap.current
    } catch (e) { return }

    if (id === undefined || id === null) { detachSession(); return }
    // sessions.list publishes for every unrelated reason (a title change, a job
    // row, a sidebar refresh); rebinding on each one would churn the
    // subscription for nothing.
    if (id === watchedId && unsubSession !== null) return

    detachSession()
    let face = null
    try {
      const binding = sessions.binding(id)
      if (binding !== undefined && binding !== null) face = binding.session
    } catch (e) { face = null }
    if (face === null || typeof face.subscribe !== 'function' || typeof face.getSnapshot !== 'function') {
      if (typeof setTimeout === 'function') rebindTimer = setTimeout(rebind, RETRY_MS)
      return
    }

    watchedId = id
    const first = readSnap(face)
    lastRunning = first === null ? null : (typeof first.running === 'boolean' ? first.running : null)
    lastOpenState = first === null ? null : (typeof first.openState === 'string' ? first.openState : null)
    // Baseline the sticky error flag: arriving on a session that ALREADY carries an
    // old error must not fire a plate for something that happened long ago.
    if (first !== null && typeof first.lastAgentError === 'string' && first.lastAgentError !== '') {
      lastErrorSeen = first.lastAgentError
    }
    let u = null
    try {
      u = face.subscribe(() => {
        const snap = readSnap(face)
        if (snap === null) return
        // 1) the running edge: one turn ended (true -> false is the only thing
        //    this plugin reacts to, and the first value is a baseline, not an edge)
        const next = typeof snap.running === 'boolean' ? snap.running : null
        if (next !== null && next !== lastRunning) {
          const prev = lastRunning
          lastRunning = next
          if (prev === true && next === false) onTurnEnd()
        }
        // 2) a session that could not be opened: report the TRANSITION, not the
        //    state, so a permanently broken session does not sit on screen
        if (typeof snap.openState === 'string' && snap.openState !== lastOpenState) {
          lastOpenState = snap.openState
          if (snap.openState === 'error') reportOpenError(snap.openError)
        }
        // 3) agent-level errors, as the fallback path for the remote event (the
        //    snapshot carries the same sticky value the event writes)
        if (typeof snap.lastAgentError === 'string' && snap.lastAgentError !== '') reportError(snap.lastAgentError)
      })
    } catch (e) { u = null }
    unsubSession = typeof u === 'function' ? u : null
    if (unsubSession === null) watchedId = null
  }

  /* Coming back into view is the only moment a throttled-away deadline can be
     noticed, so that is where the guard is hooked. The DOM is re-synced at the same
     moment: a panel that appeared while the page was hidden never fired a mutation
     we could see (a hidden page throttles MutationObserver delivery too). */
  const onVisibilityReturn = () => { reapStalePlate(); syncFromDom() }
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('visibilitychange', onVisibilityReturn)
      window.addEventListener('focus', onVisibilityReturn)
    }
  } catch (e) { /* ignore */ }

  rebind()

  ctx.effect(() => () => {
    disposed = true
    try {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('visibilitychange', onVisibilityReturn)
        window.removeEventListener('focus', onVisibilityReturn)
      }
    } catch (e) { /* ignore */ }
    if (rebindTimer !== null && typeof clearTimeout === 'function') clearTimeout(rebindTimer)
    rebindTimer = null
    if (unsubList !== null) { try { unsubList() } catch (e) { /* ignore */ } }
    unsubList = null
    detachSession()
    if (domObserver !== null) { try { domObserver.disconnect() } catch (e) { /* ignore */ } }
    domObserver = null
    if (domScanTimer !== null && typeof clearTimeout === 'function') clearTimeout(domScanTimer)
    domScanTimer = null
    domPending = {}
    if (collapseTimer !== null && typeof clearTimeout === 'function') clearTimeout(collapseTimer)
    collapseTimer = null
    pendings = []
    removeEdge()
    if (plateTimer !== null && typeof clearTimeout === 'function') clearTimeout(plateTimer)
    plateTimer = null
    if (plateExitTimer !== null && typeof clearTimeout === 'function') clearTimeout(plateExitTimer)
    plateExitTimer = null
    if (askTimer !== null && typeof clearTimeout === 'function') clearTimeout(askTimer)
    askTimer = null
    plate = null
    plateSticky = false
    // Clear the DOM by sweeping, not by dropping our one reference: a plate
    // mid-exit has no reference left, and cancelling its timer above is exactly
    // what would otherwise strand it on screen.
    removeAllPlates()
    removeAsk()
    clearTitleFlash()
    disposeStyles()
    if (typeof window !== 'undefined') window.__dshTaskToastApplied = false
  })

  /* The DOM is the only source of pending state (see the note above). Run once at
     mount — a panel may already be open — then keep watching. */
  syncFromDom()
  domObserver = watchDom()
}

exports.name = 'dsh-task-toast'
exports.apply = apply
/* Exposed for the verification harness; NOT part of the plugin contract. */
exports.__internals = {
  notifyOS, flashTitle, clearTitleFlash, showAsk, removeAsk, maybeAskPermission,
  // state layer, for the multi-state harness. (notifyMaybe/announce/syncFromDom live
  // inside apply()'s closure and are deliberately NOT exposed: the harness drives
  // them through the real entry points — the session face and the panel DOM.)
  showToast, hideToast, showEdge, removeEdge, syncPending, addPending, removePending,
  updatePending, reapStalePlate, removeAllPlates,
}
return module.exports;
	}
});
