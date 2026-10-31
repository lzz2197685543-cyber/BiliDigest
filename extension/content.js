// 页内悬浮面板：字幕 / 总结 / 聊天
//
// 交互：
//   进入视频页 → 自动静默取字幕
//     ├─ 有字幕 → 右下角出现小胶囊「字幕」
//     │    └─ 点击 → 展开为面板，顶部三个标签：
//     │         · 字幕：全部字幕 + 时间段，点击跳转；下载 TXT / 复制全文
//     │         · 总结：调用 DeepSeek 生成结构化总结（流式）
//     │         · 聊天：就视频内容与 DeepSeek 多轮对话（流式）
//     └─ 无字幕 → 胶囊显示「无字幕」
//
// 技术要点：
//   - 全部 UI 放在 Shadow DOM 里，避免 B 站全局 CSS 污染（B 站样式很强）
//   - 单例：SPA 路由切换时复用同一实例，只更新内容
//   - 网络请求全部在 service worker 里做（CORS + 登录态），这里只负责 UI
//     和渲染流式增量
//
// ⚠️ 重要限制：MV3 的 content script **不能使用 ES module import**。
//    所以在 manifest 里声明的 content.js 必须是自包含的单文件。
//    字幕获取、DeepSeek 协议都已经放在 service worker 里跑，
//    这里只需要几个纯格式化函数，因此直接内联，避免 import 报错。
//    （踩坑记录：曾写 `import {...} from "./lib/subtitle.js"`，
//      结果 content script 直接 SyntaxError 整段不执行，面板完全不出。）

// ---------------------------------------------------------------------------
// 内联工具函数（与 lib/subtitle.js 同名函数行为一致）
// ---------------------------------------------------------------------------

function parseVideoUrl(raw) {
  const url = String(raw || "").trim();
  const m = /(BV[0-9A-Za-z]{10})/.exec(url);
  let bvid = m ? m[1] : null;
  let aid = null;
  if (!bvid) {
    const m2 = /av(\d+)/i.exec(url);
    if (m2) aid = Number(m2[1]);
  }
  let page = 1;
  try {
    const q = new URL(url, location.origin).searchParams.get("p");
    if (q) page = Math.max(1, parseInt(q, 10) || 1);
  } catch {
    page = 1;
  }
  return { bvid, aid, page };
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

function safeName(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** 纯文本：每句一行，不含时间戳（适合喂给大模型 / 直接阅读） */
function cuesToText(cues) {
  return cues.map((c) => c.text).join("\n");
}

/**
 * 导出用 TXT：带时间戳，便于回到视频对应位置。
 * 格式：`[00:12] 字幕内容`
 */
function cuesToTxtWithTime(cues) {
  return cues.map((c) => `[${fmtClock(c.start)}] ${c.text}`).join("\n");
}

const HOST_ID = "bilidigest-host";

let shadow = null;
let els = null;
let state = {
  url: "",
  loading: false,
  expanded: false,
  tab: "sub",          // sub | sum | chat
  data: null,          // 字幕结果
  error: "",
  login: null,
  keyword: "",
  sum: {
    loading: false,
    text: "",
    thinking: "",
    sessionId: null,
  },
  // 聊天状态按「模式」分开存，切换模式时互不影响。
  // 这样在同一视频里来回切 视频/普通，两个模式的聊天记录都还在。
  chat: {
    mode: "video",       // 当前显示的模式：video | free
    sessions: {
      video: newChatSession("video"),
      free: newChatSession("free"),
    },
  },
};

/** 一个模式下的独立对话状态 */
function newChatSession(mode) {
  return {
    mode: mode || "video",
    sending: false,
    history: [],
    buffer: "",
    thinking: "",
    sessionId: null,
    parentMessageId: null,
    stream: null,
    files: [], // [{name, mimeType, dataUrl}]
    // 已完成的对话轮次，用于切换模式后重绘
    // [{role:"user"|"ai", text, files, thinking}]
    turns: [],
    scrollTop: 0,
    liveEl: null, // 正在流式输出的气泡元素
  };
}

/** 当前模式的会话对象 */
function cs() {
  return state.chat.sessions[state.chat.mode];
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

const CSS = `

:host { all: initial; }
* { box-sizing: border-box; }

/* ============================================================
   设计基调
   - 中性灰白底 + 一支玫红作为唯一强调色
   - 圆角统一 8/10/12/16，阴影分三档（浮起/面板/气泡）
   - 所有过渡走 160ms cubic-bezier(.4,0,.2,1)，跟 Material 一致
   ============================================================ */
.wrap {
  /* ========== 设计令牌 ========== */
  --pink: #fb7299;        /* 主色 */
  --pink-d: #f25b8b;
  --pink-dd: #e04a7c;
  --pink-l: #fff0f4;      /* 主色淡底：选中行 / 用户气泡 / code */
  --pink-b: #ffe3ec;      /* 主色淡边 */

  --ink: #18181b;         /* 标题 */
  --fg: #222222;          /* 正文 */
  --sub: #71717a;         /* 次要文字 */
  --mute: #a1a1aa;        /* 更弱：时间戳、占位、底栏 */

  --bg: #ffffff;          /* 面板底 */
  --bg-2: #f9fafb;        /* 悬停 */
  --bg-3: #eef0f3;        /* 分段控件槽 */
  --card: #fafafa;        /* 卡片底 */
  --code-bg: #fff0f4;     /* 代码/标签底 */

  --line: #ececef;
  --line-2: #e0e0e6;
  --line-3: #c9c9d1;
  --blue: #3b82f6;
  --green: #10b981;

  /* 圆角：面板 12 / 卡片 10 / 按钮 8 */
  --r-sm: 8px;
  --r-md: 10px;
  --r-lg: 12px;
  --r-xl: 12px;

  --sh-1: 0 1px 2px rgba(16,24,40,.05);
  --sh-2: 0 2px 6px rgba(16,24,40,.07);
  --sh-3: 0 8px 28px -8px rgba(16,24,40,.16), 0 2px 8px -2px rgba(16,24,40,.08);

  --ease: cubic-bezier(.4, 0, .2, 1);
  /* 统一过渡：所有可交互元素都用这一条 */
  --t: all .15s ease;

  /* 全局面板内边距：顶栏、标签、工具栏、列表、输入区都对齐到这一条竖轴。
     之前是 12/13/14 混用，左边缘会轻微跳动，看着「不整齐」。 */
  --pad: 14px;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
  position: fixed;
  right: 20px;
  bottom: 96px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  /* 容器自身不超视口：面板宽度以它为上限，避免 100vw 把滚动条宽度算进去
     导致窄屏下左边被裁 */
  max-width: calc(100% - 20px);
}

/* ---------- 深色模式 ----------
   只覆盖令牌，组件规则一行都不用改。
   外面包 @media，跟随系统；面板在 Shadow DOM 里也能正常响应。 */
@media (prefers-color-scheme: dark) {
  .wrap {
    --ink: #f4f4f5;
    --fg: #e8e8ea;
    --sub: #a1a1aa;
    --mute: #7c7c86;

    --bg: #18181b;
    --bg-2: #232327;
    --bg-3: #2a2a31;
    --card: #202024;
    --code-bg: #3a2029;

    --line: #2c2c33;
    --line-2: #3a3a42;
    --line-3: #4d4d57;

    --pink-l: #3a2029;
    --pink-b: #4a2632;

    --sh-1: 0 1px 2px rgba(0,0,0,.4);
    --sh-2: 0 2px 6px rgba(0,0,0,.45);
    --sh-3: 0 8px 28px -8px rgba(0,0,0,.7), 0 2px 8px -2px rgba(0,0,0,.5);
  }
}

/* ---------- 折叠态：悬浮 AI 入口 ----------
   它是扩展在视频页上的唯一入口，要「浮在页面上」而不只是「贴一个标签」：
   胶囊形 + 主色渐变 + 带主色的柔和投影 + 悬停抬升。
   注意投影用的是主色的 rgba 而不是中性黑——这样它看起来是被粉色「托着」，
   而不是盖了一层灰。 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px 0 8px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(180deg, #fc92b4 0%, #fb7299 52%, #f0578a 100%);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: .3px;
  cursor: grab;
  box-shadow:
    0 1px 1px rgba(240,87,138,.28),
    0 6px 16px -2px rgba(251,114,153,.42),
    0 14px 30px -10px rgba(251,114,153,.34),
    inset 0 1px 0 rgba(255,255,255,.42);
  transition: transform .18s var(--ease), box-shadow .18s var(--ease), filter .18s var(--ease);
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
}
.pill > [data-el="pillText"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 悬停：轻微放大 + 阴影加深 + 亮度提升 */
.pill:hover {
  transform: translateY(-1px) scale(1.03);
  filter: brightness(1.04);
  box-shadow:
    0 2px 3px rgba(240,87,138,.3),
    0 10px 22px -2px rgba(251,114,153,.52),
    0 20px 40px -12px rgba(251,114,153,.42),
    inset 0 1px 0 rgba(255,255,255,.5);
}
.pill:active {
  transform: translateY(0) scale(.98);
  filter: brightness(.97);
  box-shadow:
    0 1px 1px rgba(240,87,138,.3),
    0 3px 10px -2px rgba(251,114,153,.4),
    inset 0 1px 0 rgba(255,255,255,.35);
}
.pill:focus-visible {
  outline: 2px solid var(--pink);
  outline-offset: 3px;
}

/* 图标底座：半透明白圆，把图形从渐变底上「托」出来 */
.pill-ic {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: rgba(255,255,255,.2);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.3);
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.pill-ic svg { width: 15px; height: 15px; display: block; }

/* 加载中 / 无字幕：降级为中性白底，避免粉色一直亮着 */
.pill.dim {
  background: var(--bg);
  color: var(--sub);
  box-shadow:
    0 0 0 1px var(--line-2),
    0 2px 6px -2px rgba(16,24,40,.1),
    0 8px 20px -8px rgba(16,24,40,.14);
  filter: none;
}
.pill.dim:hover {
  filter: none;
  color: var(--fg);
  box-shadow:
    0 0 0 1px var(--line-3),
    0 4px 10px -2px rgba(16,24,40,.14),
    0 12px 26px -10px rgba(16,24,40,.18);
}
.pill.dim .pill-ic {
  background: var(--bg-3);
  box-shadow: inset 0 0 0 1px var(--line-2);
}
.pill.dim .pill-ic svg { color: var(--mute); }

/* 状态点：字幕就绪 = 绿点，挂在图标右上角当角标。
   描边色跟按钮底色一致，看起来是「嵌」进去的而不是贴上去的。 */
.pill .dot {
  position: absolute;
  right: -1px;
  top: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 2px #fb7ba2;
}
.pill.dim .dot {
  background: var(--mute);
  box-shadow: 0 0 0 2px var(--bg);
}

/* 加载指示器 */
.spin {
  position: absolute;
  right: -1px;
  top: -1px;
  width: 9px; height: 9px;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,.5);
  border-top-color: #fff;
  animation: rot .7s linear infinite;
}
.pill.dim .spin { border-color: var(--line-3); border-top-color: var(--pink); }
@keyframes rot { to { transform: rotate(360deg); } }

/* ---------- 展开态：面板 ---------- */
.panel {
  position: relative;      /* 关闭键定位基准 */
  width: 468px;
  max-width: calc(100vw - 40px);
  height: 78vh;
  max-height: 760px;
  min-height: 340px;
  background: var(--bg);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-3);
  outline: 1px solid rgba(16,24,40,.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: panelIn .22s var(--ease);
  transform-origin: bottom right;
}
@keyframes panelIn {
  from { opacity: 0; transform: translateY(8px) scale(.985); }
  to   { opacity: 1; transform: none; }
}

/* 顶栏：深色。
   浅色模式下也保持深色——它承担的是「品牌 + 上下文」的角色，
   和下面白色的内容区形成明确分层，比整块浅色更容易一眼定位。 */
.hd {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 10px 13px var(--pad);
  border-bottom: none;
  flex: 0 0 auto;
  min-width: 0;
  position: relative;
  background:
    radial-gradient(120% 180% at 100% 0%, rgba(139,92,246,.35) 0%, rgba(139,92,246,0) 55%),
    linear-gradient(135deg, #14161f 0%, #1a1e2c 60%, #1d1a2b 100%);
  color: #fff;
}
/* 顶栏底部的细高光，避免深色块和白色内容区直接硬碰 */
.hd::after {
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 1px;
  background: rgba(255,255,255,.08);
}

/* 品牌图标：圆角方块 + 主色渐变 */
.logo {
  width: 28px;
  height: 28px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: #fff;
  background: linear-gradient(135deg, #fb7299 0%, #f0578a 45%, #8b5cf6 100%);
  box-shadow: 0 2px 6px -1px rgba(251,114,153,.5), inset 0 1px 0 rgba(255,255,255,.35);
}
.logo svg { width: 15px; height: 15px; display: block; }

.hd .t {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -.1px;
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* AI 小徽章 */
.ai-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .4px;
  padding: 1.5px 4.5px;
  border-radius: 4px;
  background: rgba(251,114,153,.22);
  color: #ffa8c5;
  border: 1px solid rgba(251,114,153,.35);
  line-height: 1.2;
}
.hd .meta {
  font-size: 11.5px;
  color: rgba(255,255,255,.62);
  font-weight: 400;
  white-space: nowrap;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

/* 关闭键：跟随顶栏的圆形描边按钮 */
.closebtn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.18);
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.85);
  font-size: 13px;
}
.closebtn:hover {
  background: rgba(255,255,255,.14);
  border-color: rgba(255,255,255,.3);
  color: #fff;
}
.closebtn:active { background: rgba(255,255,255,.22); color: #fff; }
/* 窄屏：面板更窄，工具栏按钮收紧，仍然不压标题 */
@media (max-width: 520px) {
  .wrap {
    right: 12px;
    left: 12px;
    bottom: 84px;
    /* 左右都定位 = 容器宽 = 视口 - 24px，不再依赖 100vw */
    max-width: none;
  }
  .panel {
    /* 相对 wrap 自适应，绝不超过容器 */
    width: 100%;
    max-width: 100%;
  }
  /* 窄屏优先保证两个开关和输入框，快捷键提示让位 */
  .kbd-hint { display: none; }
  /* 工具栏按钮在窄屏收窄内边距，给搜索框留出空间 */
  .tools .btn { padding: 0 11px; }
}

.iconbtn {
  width: 26px; height: 26px;
  display: grid; place-items: center;
  border: 1px solid transparent;
  background: none;
  border-radius: var(--r-sm);
  color: var(--sub);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex: 0 0 auto;
  transition: background-color .13s var(--ease), border-color .13s var(--ease),
              color .13s var(--ease);
}
.iconbtn:hover { background: var(--bg-2); border-color: var(--line); color: var(--fg); }
.iconbtn:active { background: var(--bg-3); border-color: var(--line-2); color: var(--fg); }
.iconbtn:disabled { color: var(--mute); background: none; border-color: transparent; cursor: not-allowed; }

/* 顶部标签：胶囊分段。
   选中项是主色描边胶囊，下面再压一条短指示条——比纯下划线更像「当前选中」，
   又比灰底分段控件轻，不会在深色顶栏下面再压一块深色。 */
.tabs {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 9px var(--pad) 0;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  background: var(--bg);
}
.tab {
  position: relative;
  padding: 6px 14px;
  margin-bottom: 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--sub);
  cursor: pointer;
  white-space: nowrap;
  transition: var(--t);
}
.tab:hover { color: var(--fg); background: var(--bg-2); }
.tab:active { background: var(--bg-3); }
.tab.active {
  background: var(--pink-l);
  border-color: var(--pink);
  color: var(--pink);
  font-weight: 600;
}
.tab.active:hover { background: var(--pink-l); }
/* 选中指示条：贴在标签栏底边上，宽度跟着胶囊走 */
.tab.active::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -9px;
  height: 3px;
  border-radius: 2px 2px 0 0;
  background: var(--pink);
}
.tab:disabled { color: var(--mute); cursor: not-allowed; }
.pane { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pane.hidden { display: none; }

/* 工具条 */
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px var(--pad);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  background: var(--bg);
}
/* 工具栏里的按钮比正文里的大一号：这一行是主要操作区 */
.tools .btn {
  height: 38px;
  padding: 0 16px;
  border-radius: var(--r-md);
  font-size: 13px;
  background: var(--bg-2);
  border-color: var(--line);
}
.tools .btn:hover { background: var(--bg-3); border-color: var(--line-2); }
.tools .btn:active { background: var(--line); }
.tools .btn.primary {
  background: var(--pink);
  border-color: var(--pink);
  color: #fff;
}
.tools .btn.primary:hover:not(:disabled) { background: var(--pink-d); border-color: var(--pink-d); }

/* 开关（toggle）。仍然是原生 <input type="checkbox">，
   只是把外观整个接管掉——这样 JS 读 .checked 的逻辑一行都不用改，
   键盘可聚焦、读屏可识别也都还在。 */
.chk {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--sub);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: var(--t);
}
.chk:hover { color: var(--fg); }

.chk input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 30px;
  height: 17px;
  margin: 0;
  border: none;
  border-radius: 999px;
  background: var(--line-3);
  cursor: pointer;
  flex: 0 0 auto;
  transition: background-color .18s var(--ease);
}
.chk input[type="checkbox"]::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(16,24,40,.28);
  transition: transform .18s var(--ease);
}
.chk input[type="checkbox"]:checked { background: var(--pink); }
.chk input[type="checkbox"]:checked::after { transform: translateX(13px); }
.chk input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--pink);
  outline-offset: 2px;
}
/* 开着的时候把标签文字也提亮一点，状态更明确 */
.chk:has(input[type="checkbox"]:checked) { color: var(--fg); }

/* ---------- 聊天空态 ----------
   垂直居中 + 示例问题，让空白区域有结构，而不是顶上挂一行提示。 */
.chat-empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 8px;
  text-align: center;
}
.ce-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
}
.ce-sub {
  font-size: 12px;
  color: var(--mute);
  line-height: 1.6;
}
.ce-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 10px;
}
.ce-chip {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color .13s var(--ease), border-color .13s var(--ease),
              color .13s var(--ease);
}
.ce-chip:hover { background: var(--bg-2); border-color: var(--line-3); color: var(--fg); }
.ce-chip:active { background: var(--bg-3); }
.ce-chip:focus-visible { outline: 2px solid var(--pink); outline-offset: 1px; }
/* ---------- 正文排版 ---------- */
/* 注意选择器要写成 .body.xxx：单纯 .sum-body 会被后面的 .body 规则覆盖掉 */
.body.sum-body, .body.chat-body { padding: 12px var(--pad) 14px; }
.pane-chat > .body { background: var(--bg-2); }

.md { font-size: 13.5px; line-height: 1.78; word-break: break-word; color: var(--fg); }
.md h1, .md h2, .md h3 {
  font-size: 14px;
  margin: 16px 0 7px;
  font-weight: 650;
  color: var(--ink);
  letter-spacing: -.1px;
}
.md h1:first-child, .md h2:first-child, .md h3:first-child { margin-top: 0; }
.md p { margin: 0 0 9px; }
.md p:last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 0 0 9px; padding-left: 19px; }
.md li { margin: 3px 0; }
.md li::marker { color: var(--mute); }
.md code {
  background: var(--code-bg);
  padding: 1.5px 5px;
  border-radius: 5px;
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--pink-dd);
}
/* 代码块：深色卡片 + 语言条 + 复制键。
   DeepSeek 的回答里代码占比很高，用浅色底会和平铺的段落糊在一起。 */
.code {
  margin: 0 0 10px;
  border-radius: var(--r-md);
  overflow: hidden;
  background: #1b1b21;
  border: 1px solid rgba(0,0,0,.1);
}
.code-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255,255,255,.045);
  border-bottom: 1px solid rgba(255,255,255,.07);
}
.code-lang {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .4px;
  text-transform: uppercase;
  color: rgba(255,255,255,.5);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.code-copy {
  margin-left: auto;
  border: none;
  background: transparent;
  color: rgba(255,255,255,.6);
  font-family: inherit;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  cursor: pointer;
  transition: var(--t);
}
.code-copy:hover { background: rgba(255,255,255,.13); color: #fff; }
.code-copy:active { background: rgba(255,255,255,.2); }
.code pre {
  margin: 0;
  padding: 11px 12px;
  overflow-x: auto;
  background: none;
  border: none;
  border-radius: 0;
}
.code code {
  background: none;
  padding: 0;
  border-radius: 0;
  color: #e4e4e9;
  font-size: 12px;
  line-height: 1.65;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  white-space: pre;
}
.code pre::-webkit-scrollbar { height: 7px; }
.code pre::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 4px; }

/* 表格 */
.md-table { overflow-x: auto; margin: 0 0 10px; border-radius: var(--r-sm); }
.md table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.md th, .md td {
  border: 1px solid var(--line);
  padding: 6px 10px;
  vertical-align: top;
}
.md th { background: var(--bg-2); font-weight: 600; color: var(--ink); white-space: nowrap; }
.md tbody tr:nth-child(even) { background: var(--bg-2); }

/* 嵌套列表收紧一点，否则两层之间的空隙太大 */
.md li > ul, .md li > ol { margin: 3px 0 2px; }
.md strong { font-weight: 650; color: var(--ink); }
.md blockquote {
  margin: 0 0 9px;
  padding-left: 11px;
  border-left: 2.5px solid var(--line-2);
  color: var(--sub);
}
.md hr { border: none; border-top: 1px solid var(--line); margin: 14px 0; }
.md a { color: var(--blue); text-decoration: none; }
.md a:hover { text-decoration: underline; }

/* 流式光标 */
.streaming::after {
  content: "";
  display: inline-block;
  width: 2px; height: 13px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--pink);
  border-radius: 1px;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

/* ---------- 聊天气泡 ---------- */
/* ---------- 对话流 ----------
   阅读工具的做法：用户提问是轻量色块，AI 回答是正文。
   AI 内容不加卡片底和边框——那是一整块阅读区，不是消息气泡，
   加框反而把正文压缩成一小块，视觉噪音也大。 */
.msg { margin-bottom: 14px; display: flex; }
.msg:last-child { margin-bottom: 2px; }
.msg.user { justify-content: flex-end; padding-left: 40px; }
.msg.ai { padding-right: 0; }
.msg .bubble {
  max-width: 100%;
  padding: 0;
  border-radius: 0;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
  animation: bubbleIn .18s var(--ease);
}
@keyframes bubbleIn {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}
/* 用户提问：浅色块 + 右下角小圆角，弱化到不抢注意力 */
.msg.user .bubble {
  max-width: 86%;
  padding: 7px 11px;
  background: var(--pink-l);
  color: var(--fg);
  border: 1px solid var(--pink-b);
  border-radius: var(--r-lg);
  border-bottom-right-radius: 4px;
}
/* AI 回答：正文形态，无底色无边框 */
.msg.ai .bubble {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 11px 13px;
  box-shadow: 0 1px 2px rgba(16,24,40,.04);
}
.msg.ai .bubble.md { background: var(--bg); }
.msg .bubble.md { white-space: normal; }
.msg.ai .bubble.md { background: none; }

/* AI 气泡内首尾元素去掉多余外边距，视觉更贴合 */
.msg.ai .bubble.md > *:first-child { margin-top: 0; }
.msg.ai .bubble.md > *:last-child { margin-bottom: 0; }

/* ---------- AI 回答的操作栏 ----------
   默认半透明，悬停这一条时才完全显现，避免每段回答下面都挂一排按钮。 */
.msg.ai {
  flex-direction: column;
  align-items: stretch;
}
.msg-actions {
  display: flex;
  gap: 4px;
  margin-top: 7px;
  opacity: .55;
  transition: opacity .15s ease;
}
.msg.ai:hover .msg-actions,
.msg-actions:focus-within { opacity: 1; }
.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--sub);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: var(--t);
}
.act-btn:hover { background: var(--bg-2); border-color: var(--line-2); color: var(--fg); }
.act-btn:active { background: var(--bg-3); }
.act-btn svg { width: 12px; height: 12px; flex: 0 0 auto; }
.act-btn:focus-visible { outline: 2px solid var(--pink); outline-offset: 1px; }
/* ---------- 聊天：模式栏 ---------- */
.chatbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px var(--pad);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  background: var(--bg);
}
.seg {
  display: inline-flex;
  padding: 3px;
  gap: 3px;
  border-radius: 999px;
  background: var(--bg-3);
  border: none;
}
.segbtn {
  border: 1px solid transparent;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--sub);
  padding: 4px 12px;
  border-radius: 999px;
  white-space: nowrap;
  transition: background-color .13s var(--ease), color .13s var(--ease),
              border-color .13s var(--ease);
}
.segbtn:hover { color: var(--fg); background: rgba(255,255,255,.6); }
.segbtn:active { background: rgba(255,255,255,.9); color: var(--fg); }
/* 选中态：白底 + 细边框，不用投影 */
.segbtn.active {
  background: var(--bg);
  border-color: var(--line-2);
  color: var(--fg);
  font-weight: 600;
}
.segbtn:disabled { color: var(--mute); cursor: not-allowed; background: none; }

/* ---------- 输入区 ---------- */
.composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px var(--pad) 10px;
  border-top: 1px solid var(--line);
  flex: 0 0 auto;
  background: var(--bg);
}
.send-row { display: flex; gap: 7px; align-items: flex-end; }
.opts {
  display: flex;
  gap: 11px;
  align-items: center;
  font-size: 12px;
}
.opts .chk { font-size: 12px; }
.file-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--sub);
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-2);
  border-radius: 14px;
  background: var(--bg);
  white-space: nowrap;
  transition: var(--t);
}
.file-label:hover { background: var(--bg-2); border-color: var(--line-3); color: var(--fg); }
.file-label:active { background: var(--bg-3); border-color: var(--line-3); }

.chat-input {
  flex: 1;
  min-height: 40px;
  max-height: 108px;
  padding: 10px 14px;
  border: 1px solid var(--line-2);
  border-radius: 14px;
  background: var(--bg);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--fg);
  resize: none;
  outline: none;
  transition: border-color .13s var(--ease), background-color .13s var(--ease);
}
.chat-input::placeholder { color: var(--mute); }
.chat-input:focus {
  border-color: var(--pink);
  background: var(--bg);
}

/* 输入框下方快捷键提示 */
.kbd-hint {
  font-size: 10.5px;
  color: var(--mute);
  user-select: none;
  letter-spacing: .1px;
  /* 放在选项行右侧空位，窄屏下优先让位，不挤压左侧两个开关 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kbd-hint kbd {
  font-family: inherit;
  font-size: 10.5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-3);
  color: var(--sub);
  border: 1px solid var(--line-2);
}

/* ---------- 按钮 ---------- */
/* ============================================================
   按钮体系
   ------------------------------------------------------------
   设计原则：克制、轻量、信息优先。参照专业阅读/效率工具，
   而不是营销落地页。

   - 主操作（每屏至多一个）：B站红实底
   - 次操作：白底 + 细边框，中性灰文字
   - 三级操作：纯文字，无边框无底色
   - 无渐变、无重阴影、无胶囊；圆角统一 6px
   ============================================================ */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  /* 窄屏保护：文字不溢出，必要时省略 */
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  vertical-align: middle;
  transition: background-color .13s var(--ease), border-color .13s var(--ease),
              color .13s var(--ease);
}

/* 默认 / 悬停 / 按下 / 禁用 —— 次操作（中性灰） */
.btn:hover { background: var(--bg-2); border-color: var(--line-3); }
.btn:active { background: var(--bg-3); border-color: var(--line-3); }
.btn:disabled,
.btn[aria-disabled="true"] {
  background: var(--bg-2);
  border-color: var(--line);
  color: var(--mute);
  cursor: not-allowed;
  opacity: 1;          /* 用配色表达禁用，不用整体透明度 */
}

/* 键盘可达性：只对键盘生效，不干扰鼠标点击 */
.btn:focus-visible,
.iconbtn:focus-visible,
.tab:focus-visible,
.segbtn:focus-visible,
.file-label:focus-visible {
  outline: 2px solid var(--pink);
  outline-offset: 1px;
}

/* 主操作 —— B站红实底，不加渐变与投影 */
.btn.primary {
  background: var(--pink);
  border-color: var(--pink);
  color: #fff;
  font-weight: 500;
}
.btn.primary:hover:not(:disabled) {
  background: var(--pink-d);
  border-color: var(--pink-d);
}
.btn.primary:active:not(:disabled) {
  background: var(--pink-dd);
  border-color: var(--pink-dd);
}
.btn.primary:disabled {
  background: var(--bg-3);
  border-color: var(--line);
  color: var(--mute);
}

/* 三级操作 —— 纯文字按钮，用在「新对话」这类低权重入口 */
.btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--sub);
  height: 26px;
  padding: 0 7px;
  font-size: 12px;
  font-weight: 400;
}
.btn.ghost:hover { background: var(--bg-2); color: var(--fg); }
.btn.ghost:active { background: var(--bg-3); color: var(--fg); }
.btn.ghost:disabled { background: transparent; color: var(--mute); border-color: transparent; }

/* 发送键：方形微圆角，与输入框同高，不做圆形胶囊 */
.btn.send-btn {
  width: 40px;
  height: 40px;
  min-width: 40px;
  padding: 0;
  flex: 0 0 auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  box-shadow: 0 3px 10px -2px rgba(251,114,153,.45);
}
.btn.send-btn svg { width: 18px; height: 18px; display: block; }
.btn.send-btn:hover:not(:disabled) { box-shadow: 0 4px 14px -2px rgba(251,114,153,.55); }
.btn.send-btn:disabled { box-shadow: none; }

/* ---------- 附件 ---------- */
.attaches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px var(--pad);
  border-top: 1px solid var(--line);
  flex: 0 0 auto;
  background: var(--bg-2);
}
.attaches.hidden { display: none; }
.attach {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 3px 7px;
  font-size: 11.5px;
  color: var(--fg);
  max-width: 168px;
  box-shadow: var(--sh-1);
}
.attach .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach .rm {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--mute);
  font-size: 13px;
  padding: 0 1px;
  line-height: 1;
  transition: color .16s var(--ease);
}
.attach .rm:hover { color: #dc2626; }

/* ---------- 思维链 ---------- */
.think-box {
  margin-bottom: 8px;
  border-left: 2px solid var(--line-2);
  padding: 2px 0 2px 10px;
}
.think-box summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--sub);
  list-style: none;
  user-select: none;
  transition: color .16s var(--ease);
}
.think-box summary:hover { color: var(--pink); }
.think-box summary::-webkit-details-marker { display: none; }
.think-box summary::before {
  content: "▸";
  display: inline-block;
  margin-right: 5px;
  transition: transform .16s var(--ease);
}
.think-box[open] summary::before { transform: rotate(90deg); }
.think-box .think-body {
  font-size: 12px;
  color: var(--sub);
  line-height: 1.68;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- 提示框 ---------- */
.hint-box {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: var(--r-md);
  background: var(--card);
  border: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--sub);
  line-height: 1.65;
  text-align: left;
}
.chat-body .hint-box:first-child { margin-top: 4px; }
.hint-box .btn { margin-top: 9px; }

/* ---------- 卡片 ----------
   总结按 ## 小节拆成独立卡片，每节一张。
   卡片之间 12px，卡内 14px 内边距。 */
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 14px;
  margin-bottom: 12px;
  transition: var(--t);
}
.card:last-child { margin-bottom: 0; }
.card:hover { border-color: var(--line-2); }
/* 卡片标题：由 markdown 的 h2 渲染而来 */
.card > h2,
.card > h3 {
  font-size: 12.5px !important;
  font-weight: 650 !important;
  color: var(--pink) !important;
  margin: 0 0 8px !important;
  letter-spacing: .2px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.card > h2::before,
.card > h3::before {
  content: "";
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: var(--pink);
  flex: 0 0 auto;
}
/* 卡片内的要点行：hover 浅灰，时间标签是可点的小胶囊 */
.card li { transition: var(--t); border-radius: 6px; }
.card li:hover { background: var(--bg-2); }

/* 总结里形如 [02:15] 的时间标签 */
.ts-tag {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  margin: 0 2px;
  border-radius: 999px;
  background: var(--pink-l);
  color: var(--pink-dd);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  border: none;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  transition: var(--t);
  vertical-align: 1px;
}
.ts-tag:hover { background: var(--pink); color: #fff; }

/* ---------- 搜索框 ---------- */
/* 放大镜绝对定位叠在输入框左侧。input 仍是原来那个元素，
   els.search 与 input 事件都不用改。 */
.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.search-ic {
  position: absolute;
  left: 13px;
  width: 15px;
  height: 15px;
  color: var(--mute);
  pointer-events: none;
  transition: color .15s ease;
}
.search-wrap:focus-within .search-ic { color: var(--pink); }

/* 胶囊输入框 */
.search {
  flex: 1;
  height: 38px;
  padding: 0 14px 0 36px;
  min-width: 0;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: var(--bg-2);
  font-family: inherit;
  font-size: 13px;
  color: var(--fg);
  outline: none;
  transition: var(--t);
}
.search:hover { border-color: var(--line-3); }
.search::placeholder { color: var(--mute); }
.search:focus {
  border-color: var(--pink);
  background: var(--bg);
}

/* ---------- 滚动容器 ---------- */
.body {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 8px;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
.body::-webkit-scrollbar { width: 9px; }
.body::-webkit-scrollbar-track { background: transparent; }
.body::-webkit-scrollbar-thumb {
  background: var(--line-2);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.body::-webkit-scrollbar-thumb:hover { background: #c3c8d0; background-clip: padding-box; }

/* ---------- 字幕列表：时间线卡片 ----------
   左侧一条竖轴 + 节点，右侧是每条字幕的卡片。
   列表底色压成浅灰，白色卡片才浮得起来；这是和原面板最大的视觉差别。 */
.pane-sub > .body {
  background: var(--bg-2);
  padding: 12px var(--pad) 14px;
}

.cue {
  position: relative;
  display: flex;
  gap: 8px;
  padding: 0 0 10px 22px;
  border: none;
  background: none;
  cursor: pointer;
}

/* 竖轴：每一条自己画一段，靠 padding-bottom 连成一条不断的线 */
.cue::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--line-2);
}
.cue:first-child::before { top: 14px; }
.cue:last-child::before { bottom: auto; height: 14px; }

/* 节点：空心圆，当前条填充主色 */
.cue::after {
  content: "";
  position: absolute;
  left: 0;
  top: 14px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--bg-2);
  box-shadow: inset 0 0 0 1.5px var(--line-3);
  transition: var(--t);
}

/* 时间列：保持窄，只做定位用 */
.cue .ts {
  flex: 0 0 auto;
  min-width: 34px;
  font-size: 11px;
  color: var(--mute);
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  padding-top: 11px;
  transition: var(--t);
}

/* 文字卡片 */
.cue .tx {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  box-shadow: 0 1px 2px rgba(16,24,40,.04);
  transition: var(--t);
}

.cue:hover .tx {
  border-color: var(--line-2);
  box-shadow: 0 2px 8px -2px rgba(16,24,40,.1);
}
.cue:hover::after { box-shadow: inset 0 0 0 1.5px var(--pink); }

.cue.active .tx {
  background: var(--pink-l);
  border-color: var(--pink);
  box-shadow: 0 2px 10px -2px rgba(251,114,153,.35);
}
.cue.active .ts { color: var(--pink); font-weight: 600; }
.cue.active::after {
  background: var(--pink);
  box-shadow: 0 0 0 3px rgba(251,114,153,.22);
}

.cue .tx mark {
  background: #fef08a;
  color: inherit;
  padding: 0 1.5px;
  border-radius: 2px;
}
/* ---------- 空状态 / 错误 ---------- */
.state {
  padding: 40px var(--pad);
  text-align: center;
  color: var(--sub);
  font-size: 13px;
  line-height: 1.7;
}
.state .big {
  font-size: 15px;
  color: var(--ink);
  font-weight: 650;
  margin-bottom: 7px;
}
.state .err { color: #dc2626; }
.state code {
  background: var(--bg-3);
  padding: 1.5px 5px;
  border-radius: 5px;
  font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.state .actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}

/* ---------- 底栏 ----------
   三段式：左「连接状态」、中「字幕来源」、右「同步/缓存说明」。
   它是独立固定的一行，不跟着内容滚走。 */
.ft {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px var(--pad);
  border-top: 1px solid var(--line);
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--mute);
  background: var(--bg);
}
.ft-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  color: var(--fg);
  white-space: nowrap;
}
.ft-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(16,185,129,.14);
  transition: var(--t);
  flex: 0 0 auto;
}
.ft-state.loading .ft-dot {
  background: var(--line-3);
  box-shadow: 0 0 0 3px rgba(161,161,170,.14);
}
.ft-state.bad .ft-dot {
  background: #ef4444;
  box-shadow: 0 0 0 3px rgba(239,68,68,.14);
}
.ft-mid {
  flex: 1 1 auto;
  text-align: center;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ft-mid.ai { color: var(--pink-dd); }
.ft-mid.ok { color: #15803d; }
.ft-note {
  flex: 0 0 auto;
  color: var(--mute);
  white-space: nowrap;
}
.ft .sp { flex: 1; }
.tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10.5px;
  font-weight: 500;
  background: var(--bg-3);
  color: var(--sub);
  letter-spacing: .2px;
}
.tag.ok { background: #dcfce7; color: #15803d; }
.tag.ai { background: var(--pink-l); color: var(--pink-dd); }

.sp { flex: 1; }
.hidden { display: none !important; }

/* ---------- 深色模式：组件级覆盖 ---------- */
@media (prefers-color-scheme: dark) {
  .panel { outline: 1px solid rgba(255,255,255,.06); }
  .hd {
    background:
      radial-gradient(120% 180% at 100% 0%, rgba(139,92,246,.28) 0%, rgba(139,92,246,0) 55%),
      linear-gradient(135deg, #0c0d13 0%, #12141d 60%, #16121f 100%);
  }
  .tag.ok { background: #14361f; color: #4ade80; }
  .tag.ai { background: #3a2029; color: #f9a8c4; }
  .md mark { background: #5a4a10; color: #fde68a; }
  .cue .tx mark { background: #5a4a10; color: #fde68a; }
  .md code { color: #f9a8c4; }
  .ts-tag { color: #f9a8c4; }
  .attach .rm:hover { color: #f87171; }
  .state .err { color: #f87171; }
  .pill .dot { box-shadow: 0 0 0 2px #fb7ba2; }
  .pill.dim .dot { box-shadow: 0 0 0 2px var(--bg); }
}
/* ---------- 面板拖拽与缩放 ---------- */

/* 标题栏是拖动把手。用 grab 光标明确「这里可以抓」 */
.hd { cursor: grab; }
.wrap.dragging .hd { cursor: grabbing; }

/* 胶囊同样可拖：光标提示 + 拖动中禁止选中 */
.pill { cursor: grab; }
.wrap.dragging .pill { cursor: grabbing; }

/* 拖动过程中禁止选中文本，否则会拖出一片蓝色选区 */
.wrap.dragging { user-select: none; -webkit-user-select: none; }
.wrap.dragging iframe { pointer-events: none; }

/* 右下角缩放柄。做得克制：默认几乎不可见，悬停才显形 */
.resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  z-index: 3;
  cursor: nwse-resize;
  /* 扩大命中区但不遮住底部文字 */
  border-bottom-right-radius: var(--r-xl);
}
.resizer::after {
  content: "";
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid var(--line-3);
  border-bottom: 1.5px solid var(--line-3);
  transition: border-color .15s var(--ease);
}
.resizer:hover::after,
.wrap.dragging .resizer::after { border-color: var(--pink); }

`;

// ---------------------------------------------------------------------------
// 滚轮隔离
//
// B站播放器在 document/window 上注册了 wheel 与键盘快捷键：
//   - 滚轮在视频上调音量、在进度条上调时间
//   - 空格/方向键控制播放
// 面板是 Shadow DOM，鼠标明明落在面板上，事件却仍会冒泡到 document 被播放器处理，
// 结果就是「字幕列表滚不动，反而把视频进度拖了」。
//
// 解法：在 window 的 **capture 阶段** 先一步判断事件是否落在面板内，
// 是就 stopPropagation，让播放器永远收不到。
// 用 capture + 最外层（window）能覆盖播放器在 document/元素上的任何监听。
//
// 注意：不能 preventDefault，否则面板自身的原生滚动也会被取消。
// ---------------------------------------------------------------------------

let panelHostEl = null;
let panelOpenGetter = null;

/* ---------------- 输入框按键处理 ----------------
 *
 * ⚠️ 这里有一个非常隐蔽的坑，务必先读完再改。
 *
 * installScrollIsolation 为了不让 B站播放器抢走面板内的按键（在搜索框里打空格会
 * 触发暂停/播放），在 window 的 **capture 阶段** 调用了 e.stopPropagation()。
 *
 * 副作用：事件在 window 就被拦下，**永远传不到 textarea**，所以挂在
 * .chat-input 上的 keydown 监听器根本不会触发。
 *
 * 为什么打字还正常？因为插入字符是浏览器的「默认行为」，不受 stopPropagation
 * 影响。所以症状特别迷惑人：能打字、能换行（Shift+Enter 走默认行为），
 * 但 Enter 永远不发送。
 *
 * 解法：把 Enter 的处理挂到 window capture 这一层——也就是事件真正会经过的
 * 地方。同一个节点上的多个监听器不受 stopPropagation 影响，所以放在
 * stopPropagation 之后执行也来得及。
 *
 * 判断「按在哪个元素上」必须用 composedPath()[0]，不能用 e.target：
 * 跨 shadow 边界时 target 会被重定向成宿主 div。
 */
let composingUntil = 0;

function handleComposerKey(e) {
  // ⚠️ 只处理 keydown。
  // onGlobalKeyCapture 同时挂在 keydown / keyup / keypress 上，
  // 而 keyup 的 e.key 同样是 "Enter"——不拦的话按一次键会发送两次。
  // 注意 __bdHandled 拦不住这种情况：keydown 和 keyup 是两个不同的事件对象。
  if (e.type !== "keydown") return;

  if (e.__bdHandled) return;          // 防止两条路径都触发导致重复发送
  if (e.key !== "Enter") return;
  if (!els || !els.chatInput) return;

  // 换行组合键直接放行，交给浏览器插入 \n
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;

  // 输入法保护（三道防线）
  //   1. e.isComposing —— 标准属性，组字中为 true
  //   2. keyCode === 229 —— 部分输入法/浏览器在组字中固定报 229
  //   3. composingUntil —— compositionend 与 keydown 的时序不可靠，某些输入法
  //      确认候选词后仍会补发一个 Enter，60ms 静默期内一律不算发送
  if (e.isComposing || e.keyCode === 229 || Date.now() < composingUntil) return;

  e.__bdHandled = true;
  e.preventDefault();
  sendChat();
}

function onGlobalWheelCapture(e) {
  if (!panelHostEl || !panelHostEl.shadowRoot) return;
  if (panelOpenGetter && !panelOpenGetter()) return;

  const sr = panelHostEl.shadowRoot;
  const panel = sr.querySelector(".panel");
  if (!panel || panel.classList.contains("hidden")) return;

  // composedPath 能穿透 shadow 边界，拿到真实的事件路径
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  const inside = path.includes(panel) || path.includes(panelHostEl);
  if (!inside) return;

  // 面板内滚动：不让它传出去影响播放器
  e.stopPropagation();
  // 注意不调 preventDefault —— 面板自己的滚动要继续工作
}

function onGlobalKeyCapture(e) {
  if (!panelHostEl || !panelHostEl.shadowRoot) return;
  const sr = panelHostEl.shadowRoot;
  const panel = sr.querySelector(".panel");
  if (!panel || panel.classList.contains("hidden")) return;
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (!(path.includes(panel) || path.includes(panelHostEl))) return;

  // 先处理我们自己关心的按键，再阻断播放器。
  // 顺序不能反：下面这行 stopPropagation 之后，事件就再也到不了 textarea 了，
  // 所以聊天框的 Enter 必须在这一层接住（详见 handleComposerKey 的注释）。
  const realTarget = path[0];
  if (els && els.chatInput && realTarget === els.chatInput) {
    handleComposerKey(e);
  }

  // 面板内的按键（尤其是搜索框里打空格）不要触发播放器的快捷键
  e.stopPropagation();
}

function installScrollIsolation(host, isOpen) {
  panelHostEl = host;
  panelOpenGetter = isOpen;
  window.addEventListener("wheel", onGlobalWheelCapture, { capture: true, passive: true });
  window.addEventListener("mousewheel", onGlobalWheelCapture, { capture: true, passive: true });
  window.addEventListener("keydown", onGlobalKeyCapture, { capture: true });
  window.addEventListener("keyup", onGlobalKeyCapture, { capture: true });
  window.addEventListener("keypress", onGlobalKeyCapture, { capture: true });

  // 第二道防线：在面板内部直接接管滚轮，自己算 scrollTop。
  // 为什么需要它：如果播放器的监听器也注册在 window 的 capture 阶段且比我们更早，
  // stopPropagation 就来不及生效。此时直接操作 scrollTop 保证「至少能滚」。
  const manualWheel = (e) => {
    const body = els && els.body;
    if (!body) return;
    if (els.panel.classList.contains("hidden")) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(els.panel)) return;
    // 鼠标在头部/工具栏上时不接管
    if (!path.includes(body)) return;
    e.stopPropagation();
    e.preventDefault();
    body.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  };
  shadow.addEventListener("wheel", manualWheel, { capture: true, passive: false });
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

function isVideoPage() {
  return /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/.test(location.pathname);
}

function build() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:static;";
  document.body.appendChild(host);

  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.innerHTML = `
    <div class="panel hidden" part="panel">
      <div class="hd">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"></path>
            <path d="M9 10.5v3"></path>
            <path d="M12 9v6"></path>
            <path d="M15 10.5v3"></path>
          </svg>
        </span>
        <span class="t">BiliDigest<span class="ai-badge">AI</span></span>
        <span class="sp"></span>
        <span class="meta"></span>
        <button class="iconbtn closebtn" data-act="collapse" title="收起面板" aria-label="收起面板">✕</button>
      </div>

      <div class="tabs">
        <button class="tab active" data-tab="sub">字幕</button>
        <button class="tab" data-tab="sum">总结</button>
        <button class="tab" data-tab="chat">聊天</button>
      </div>

      <!-- 字幕 -->
      <div class="pane pane-sub">
        <div class="tools">
          <span class="search-wrap">
            <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <path d="M20 20l-3.5-3.5"></path>
            </svg>
            <input class="search" type="text" placeholder="搜索字幕…" />
          </span>
          <button class="btn" data-act="export-txt" title="导出为 TXT 文件">导出</button>
          <button class="btn" data-act="copy" title="复制全部字幕">复制</button>
        </div>
        <div class="body"></div>
      </div>

      <!-- 总结 -->
      <div class="pane pane-sum hidden">
        <div class="tools">
          <button class="btn primary" data-act="do-sum">生成总结</button>
          <button class="btn" data-act="copy-sum" title="复制总结全文">复制</button>
          <span class="sp"></span>
          <label class="chk"><input type="checkbox" class="think" /> 深度思考</label>
        </div>
        <div class="body sum-body"></div>
      </div>

      <!-- 聊天 -->
      <div class="pane pane-chat hidden">
        <div class="chatbar">
          <div class="seg">
            <button class="segbtn active" data-mode="video">视频</button>
            <button class="segbtn" data-mode="free">普通</button>
          </div>
          <button class="btn ghost" data-act="new-chat" title="开始新对话">新对话</button>
        </div>
        <div class="body chat-body"></div>
        <div class="attaches hidden"></div>
        <div class="composer">
          <div class="opts">
            <label class="chk"><input type="checkbox" class="c-think" /> 深度思考</label>
            <label class="chk"><input type="checkbox" class="c-search" /> 联网搜索</label>
            <span class="sp"></span>
            <span class="kbd-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div class="send-row">
            <textarea
              class="chat-input"
              rows="1"
              placeholder="就视频内容提问…"
            ></textarea>
            <label class="chk file-label" title="上传文件（单个上限 20MB）">
              <input type="file" class="c-file" multiple hidden /> 📎 文件
            </label>
            <button class="btn primary send-btn" data-act="send" title="发送（Enter）" aria-label="发送">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 19V5"></path>
                <path d="M5.5 11.5L12 5l6.5 6.5"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div class="ft">
        <span class="ft-state">
          <span class="ft-dot"></span>
          <span data-el="ftState">加载中</span>
        </span>
        <span class="ft-mid" data-el="srcTag"></span>
        <span class="ft-note" data-el="footNote"></span>
      </div>

      <!-- 右下角拖拽柄：按住可自由调整面板宽高 -->
      <div class="resizer" data-el="resizer" title="拖拽调整大小（双击恢复默认）"></div>
    </div>
    <button class="pill" data-act="toggle" title="打开 BiliDigest">
      <span class="pill-ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"></path>
          <path d="M8.5 10v3"></path>
          <path d="M12 8.5v6"></path>
          <path d="M15.5 10.5v2"></path>
        </svg>
        <span class="dot"></span>
      </span>
      <span data-el="pillText">加载字幕…</span>
    </button>
  `;
  shadow.appendChild(wrap);

  els = {
    wrap,
    panel: wrap.querySelector(".panel"),
    hd: wrap.querySelector(".hd"),
    resizer: wrap.querySelector(".resizer"),
    pill: wrap.querySelector(".pill"),
    pillText: wrap.querySelector('[data-el="pillText"]'),
    meta: wrap.querySelector(".hd .meta"),
    body: wrap.querySelector(".pane-sub .body"),
    search: wrap.querySelector(".search"),
    srcTag: wrap.querySelector('[data-el="srcTag"]'),
  ftState: wrap.querySelector('[data-el="ftState"]'),
    footNote: wrap.querySelector('[data-el="footNote"]'),
    tabs: [...wrap.querySelectorAll(".tab")],
    panes: {
      sub: wrap.querySelector(".pane-sub"),
      sum: wrap.querySelector(".pane-sum"),
      chat: wrap.querySelector(".pane-chat"),
    },
    sumBody: wrap.querySelector(".sum-body"),
    chatBody: wrap.querySelector(".chat-body"),
    chatInput: wrap.querySelector(".chat-input"),
    thinkBox: wrap.querySelector(".think"),
    chatThink: wrap.querySelector(".c-think"),
    chatSearch: wrap.querySelector(".c-search"),
    chatFile: wrap.querySelector(".c-file"),
    attaches: wrap.querySelector(".attaches"),
    segBtns: [...wrap.querySelectorAll(".segbtn")],
  };

  els.pill.addEventListener("click", () => toggle());
  els.search.addEventListener("input", () => {
    state.keyword = els.search.value.trim();
    renderCues();
  });

  // 聊天框按键：Enter 发送，Shift/Ctrl/Cmd+Enter 换行。
  // 实际判断在 handleComposerKey()——因为 window capture 会拦下事件，
  // 真正的入口在 onGlobalKeyCapture 里。这里保留一份监听做兜底
  // （比如将来移除 stopPropagation 之后仍然可用），靠 __bdHandled 去重。
  els.chatInput.addEventListener("compositionstart", () => {
    composingUntil = Infinity; // 组字开始，持续屏蔽
  });
  els.chatInput.addEventListener("compositionend", () => {
    composingUntil = Date.now() + 60;
  });

  els.chatInput.addEventListener("keydown", handleComposerKey);
  els.chatInput.addEventListener("input", () => {
    els.chatInput.style.height = "auto";
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 104) + "px";
  });

  // 视频 / 普通 模式切换
  for (const b of els.segBtns) {
    b.addEventListener("click", () => switchChatMode(b.dataset.mode));
  }

  // 选文件
  els.chatFile.addEventListener("change", async () => {
    const files = [...(els.chatFile.files || [])];
    els.chatFile.value = "";
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) {
        appendNotice(`「${f.name}」超过 20MB，已跳过`);
        continue;
      }
      const dataUrl = await fileToDataUrl(f);
      cs().files.push({ name: f.name, mimeType: f.type || "application/octet-stream", dataUrl });
    }
    renderAttaches();
  });

  shadow.addEventListener("click", onPanelClick);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function renderAttaches() {
  const list = cs().files;
  if (!list.length) {
    els.attaches.classList.add("hidden");
    els.attaches.innerHTML = "";
    return;
  }
  els.attaches.classList.remove("hidden");
  els.attaches.innerHTML = list
    .map(
      (f, i) =>
        `<span class="attach"><span class="nm">${escapeHtml(f.name)}</span>` +
        `<button class="rm" data-act="rm-file" data-idx="${i}" title="移除">×</button></span>`
    )
    .join("");
}

function switchChatMode(mode) {
  if (state.chat.mode === mode) return;

  // 保存当前模式的滚动位置，切回来时恢复
  const prev = cs();
  prev.scrollTop = els.chatBody.scrollTop;

  state.chat.mode = mode;
  for (const b of els.segBtns) b.classList.toggle("active", b.dataset.mode === mode);
  els.chatInput.placeholder = mode === "video" ? "就视频内容提问…" : "随便问点什么…";

  // 注意：不清空另一份会话。两个模式各自持有独立的 turns / sessionId，
  // 切换只是「换一份显示」，来回切都能看到原有记录。
  renderChatPane();
}

/**
 * 根据当前模式的数据重绘整个聊天区。
 *
 * 之所以要重绘而不是切换两块 DOM：两个模式共享同一套输入框和附件区，
 * 重绘最简单也最不容易状态错乱。聊天记录量级很小（几条到几十条），
 * 全量重绘没有性能问题。
 */
function renderChatPane() {
  const s = cs();
  els.chatBody.innerHTML = "";

  // 正在生成时，要把进行中的那一轮也画出来
  for (const t of s.turns) {
    const el = appendMsg(t.role === "user" ? "user" : "ai", t.text, t.files || []);
    if (t.role === "ai" && t.thinking) {
      el.innerHTML = renderAiBubble(t.thinking, t.text, null, true);
    }
  }

  // 有进行中的请求：补一个流式气泡并接管
  if (s.sending) {
    const live = appendMsg("ai", "");
    live.classList.add("streaming");
    s.liveEl = live;
    updateAiBubble(live);
  }

  if (!s.turns.length && !s.sending) {
    const isVideo = state.chat.mode === "video";
    // 空态给「可以问什么」的具体示范，点一下填进输入框。
    // 比原来一行说明文字更有引导性，也让大片空白有内容支撑。
    const examples = isVideo
      ? ["这个视频讲了什么？", "第二部分说了什么？", "提炼关键步骤"]
      : ["帮我梳理要点", "解释一下这个概念"];
    els.chatBody.innerHTML = `
      <div class="chat-empty">
        <div class="ce-title">${isVideo ? "就这个视频提问" : "随便问点什么"}</div>
        <div class="ce-sub">${
          isVideo ? "回答会结合当前视频的字幕内容" : "也可以上传文件让我分析"
        }</div>
        <div class="ce-chips">
          ${examples.map((q) => `<button class="ce-chip" data-fill="${q}">${q}</button>`).join("")}
        </div>
      </div>`;
  }

  // 恢复滚动位置
  els.chatBody.scrollTop = s.scrollTop || els.chatBody.scrollHeight;
  renderAttaches();
}

function switchTab(name) {
  state.tab = name;
  for (const t of els.tabs) t.classList.toggle("active", t.dataset.tab === name);
  for (const [k, el] of Object.entries(els.panes)) el.classList.toggle("hidden", k !== name);
  if (name === "chat") {
    // 首次进入时重绘一次（两个模式各自保留记录，切回来能看到）
    if (!els.chatBody.children.length) renderChatPane();
    setTimeout(() => els.chatInput.focus(), 50);
  }
}

function onPanelClick(e) {
  const tabEl = e.target.closest(".tab");
  if (tabEl) {
    switchTab(tabEl.dataset.tab);
    return;
  }
  // 空态里的示例问题：点一下填进输入框，不直接发送（给用户改的机会）
  const fillEl = e.target.closest("[data-fill]");
  if (fillEl) {
    els.chatInput.value = fillEl.dataset.fill;
    els.chatInput.focus();
    els.chatInput.dispatchEvent(new Event("input"));
    return;
  }
  // 总结卡片里的时间胶囊：点了跳到对应位置
  const seekEl = e.target.closest("[data-seek]");
  if (seekEl) {
    seekTo(parseTs(seekEl.dataset.seek));
    return;
  }
  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const act = actEl.dataset.act;
    if (act === "collapse") toggle(false);
    else if (act === "copy") copyAll();
    else if (act === "export-txt") exportTxt();
    else if (act === "retry") loadSubtitle(state.url, true);
    else if (act === "do-sum") generateSummary();
    else if (act === "copy-sum") copySummary();
    else if (act === "copy-msg") copyMsg(actEl);
    else if (act === "copy-code") copyCode(actEl);
    else if (act === "send") sendChat();
    else if (act === "new-chat") newChat();
    else if (act === "rm-file") {
      const i = Number(actEl.dataset.idx);
      cs().files.splice(i, 1);
      renderAttaches();
    }
    else if (act === "ds-login") loginDeepSeek();
    else if (act === "ds-check") recheckDsLogin();
    else if (act === "openOptions") chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    return;
  }
  const cueEl = e.target.closest(".cue");
  if (cueEl) {
    const t = Number(cueEl.dataset.start || 0);
    seekTo(t);
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/* ---------------- 面板布局：拖动 + 缩放 ---------------- */

/**
 * 默认（layout === null）沿用 CSS：468px 宽、78vh 高、锚定右下角。
 *
 * 一旦用户拖动或缩放，就切换成像素定位并把结果存进 chrome.storage.local。
 * 之所以不一开始就用像素：78vh 会跟着窗口高度自适应，把默认值固化成
 * 像素反而丢掉了这个好处。
 */
const LAYOUT_KEY = "layout:v1";
const PILL_KEY = "pill:v1";
const LAYOUT_MIN_W = 360;
const LAYOUT_MIN_H = 340;
const LAYOUT_EDGE = 8;      // 与视口边缘至少留出的距离

let layout = null;
let dragState = null;
let layoutSaveTimer = null;

/** 收起态胶囊的位置。null = 保持 CSS 默认（右下角） */
let pillPos = null;
let pillDrag = null;
let pillJustDragged = false;
let pillSaveTimer = null;

/**
 * 约束顺序很重要：先把尺寸定死，再收位置。
 *
 * 反过来的话会出问题：位置先被限制在 vw-120，随后尺寸被最小值
 * 顶到 360，两者叠在一起就把面板推出了视口右边（实测 560 宽视口下
 * 面板右边缘跑到 666）。
 */
function clampLayout(L) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 视口比最小尺寸还小时，让步给视口，否则必然溢出
  const maxW = Math.max(240, vw - LAYOUT_EDGE * 2);
  const maxH = Math.max(200, vh - LAYOUT_EDGE * 2);

  let width = Math.min(Math.round(L.width), maxW);
  let height = Math.min(Math.round(L.height), maxH);
  width = Math.max(width, Math.min(LAYOUT_MIN_W, maxW));
  height = Math.max(height, Math.min(LAYOUT_MIN_H, maxH));

  // 尺寸确定后，把面板整体收进视口
  let left = Math.round(L.left);
  let top = Math.round(L.top);
  left = Math.min(Math.max(left, LAYOUT_EDGE), vw - width - LAYOUT_EDGE);
  top = Math.min(Math.max(top, LAYOUT_EDGE), vh - height - LAYOUT_EDGE);

  return { left, top, width, height };
}

function applyLayout() {
  if (!els || !els.panel) return;
  const open = !els.panel.classList.contains("hidden");

  if (!open) {
    // 收起态：只关心胶囊自己的位置，面板样式全部还给 CSS
    els.panel.style.width = "";
    els.panel.style.height = "";
    els.panel.style.maxWidth = "";
    els.panel.style.maxHeight = "";
    els.panel.style.minHeight = "";
    if (pillPos) {
      els.wrap.style.right = "auto";
      els.wrap.style.bottom = "auto";
      els.wrap.style.left = pillPos.left + "px";
      els.wrap.style.top = pillPos.top + "px";
    } else {
      els.wrap.style.left = "";
      els.wrap.style.top = "";
      els.wrap.style.right = "";
      els.wrap.style.bottom = "";
    }
    return;
  }

  // 展开态但没有自定义布局 → 退回 CSS 默认（锚定右下角）
  if (!layout) {
    els.wrap.style.left = "";
    els.wrap.style.top = "";
    els.wrap.style.right = "";
    els.wrap.style.bottom = "";
    els.panel.style.width = "";
    els.panel.style.height = "";
    // 默认态的上下限由 CSS 管，这里必须清掉，否则拖大之后复位会失效
    els.panel.style.maxWidth = "";
    els.panel.style.maxHeight = "";
    els.panel.style.minHeight = "";
    return;
  }

  els.wrap.style.right = "auto";
  els.wrap.style.bottom = "auto";
  // 每次套用前重新校验：窗口可能比上次保存时小得多（换显示器、改缩放）
  layout = clampLayout(layout);
  els.wrap.style.left = layout.left + "px";
  els.wrap.style.top = layout.top + "px";
  els.panel.style.width = layout.width + "px";
  els.panel.style.height = layout.height + "px";
  // CSS 里的 max-height: 760px / min-height: 340px 是给默认态用的，
  // 不解除的话用户永远拖不出 760px 以上，等于白拖。
  els.panel.style.maxWidth = "none";
  els.panel.style.maxHeight = "none";
  els.panel.style.minHeight = "0";
}

function setLayout(next) {
  layout = clampLayout(next);
  applyLayout();
}

/** 把面板当前的实际几何固化成像素，作为拖动起点 */
function grabLayout() {
  const r = els.panel.getBoundingClientRect();
  // 宽高用 offset* 而不是 rect：开合动画带 transform: scale(.985)，
  // rect 读到的是变换后的视觉尺寸，会把 468 记成 461。
  return {
    left: r.left,
    top: r.top,
    width: els.panel.offsetWidth,
    height: els.panel.offsetHeight,
  };
}

function scheduleLayoutSave() {
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    try { chrome.storage.local.set({ [LAYOUT_KEY]: layout }); } catch (e) { /* 存不了就算了 */ }
  }, 250);
}

/* ---------- 收起态：胶囊的拖动 ---------- */

function clampPillPos(p) {
  const r = els.pill.getBoundingClientRect();
  const w = r.width || 110;
  const h = r.height || 32;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.min(Math.max(Math.round(p.left), LAYOUT_EDGE), Math.max(LAYOUT_EDGE, vw - w - LAYOUT_EDGE)),
    top: Math.min(Math.max(Math.round(p.top), LAYOUT_EDGE), Math.max(LAYOUT_EDGE, vh - h - LAYOUT_EDGE)),
  };
}

function schedulePillSave() {
  clearTimeout(pillSaveTimer);
  pillSaveTimer = setTimeout(() => {
    try { chrome.storage.local.set({ [PILL_KEY]: pillPos }); } catch (e) { /* ignore */ }
  }, 250);
}

function onPillPointerDown(e) {
  if (e.button !== 0) return;
  pillJustDragged = false;
  const r = els.pill.getBoundingClientRect();
  pillDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
  // 这里**不能** preventDefault：否则点一下不会触发 click，面板就打不开了。
  // 只有真的移动之后才拦截。
  window.addEventListener("pointermove", onPillPointerMove, true);
  window.addEventListener("pointerup", onPillPointerUp, true);
  window.addEventListener("pointercancel", onPillPointerUp, true);
}

function onPillPointerMove(e) {
  if (!pillDrag) return;
  const dx = e.clientX - pillDrag.x;
  const dy = e.clientY - pillDrag.y;

  if (!pillDrag.moved) {
    // 手抖容忍：位移太小仍视为点击
    if (Math.abs(dx) + Math.abs(dy) < 4) return;
    pillDrag.moved = true;
    els.wrap.classList.add("dragging");
  }

  pillPos = clampPillPos({ left: pillDrag.left + dx, top: pillDrag.top + dy });
  applyLayout();
  e.preventDefault();
  e.stopPropagation();
}

function onPillPointerUp(e) {
  window.removeEventListener("pointermove", onPillPointerMove, true);
  window.removeEventListener("pointerup", onPillPointerUp, true);
  window.removeEventListener("pointercancel", onPillPointerUp, true);
  if (!pillDrag) return;

  const moved = pillDrag.moved;
  pillDrag = null;
  els.wrap.classList.remove("dragging");

  if (!moved) return;   // 没动过 → 交给 click 正常展开面板

  pillJustDragged = true;
  schedulePillSave();
  e.preventDefault();
  e.stopPropagation();
  // pointerup 之后浏览器还会补一个 click，用它把这次点击吞掉
  setTimeout(() => { pillJustDragged = false; }, 300);
}

function loadLayout() {
  try {
    chrome.storage.local.get([LAYOUT_KEY, PILL_KEY], (o) => {
      const L = o && o[LAYOUT_KEY];
      if (L && typeof L.width === "number" && typeof L.height === "number") {
        layout = clampLayout(L);
      }
      const P = o && o[PILL_KEY];
      if (P && typeof P.left === "number" && typeof P.top === "number") {
        pillPos = clampPillPos(P);
      }
      applyLayout();
    });
  } catch (e) { /* 读不到就用默认 */ }
}

function beginDrag(mode, e) {
  if (e.button !== 0) return;

  layout = clampLayout(grabLayout());
  dragState = {
    mode,
    x: e.clientX,
    y: e.clientY,
    left: layout.left,
    top: layout.top,
    width: layout.width,
    height: layout.height,
  };

  els.wrap.classList.add("dragging");
  applyLayout();

  window.addEventListener("pointermove", onDragMove, true);
  window.addEventListener("pointerup", onDragEnd, true);
  window.addEventListener("pointercancel", onDragEnd, true);

  // 必须在捕获阶段掐断：否则 B 站播放器会同时收到这次按下，
  // 拖面板的过程中视频进度条也跟着动。
  e.preventDefault();
  e.stopPropagation();
}

function onDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.x;
  const dy = e.clientY - dragState.y;

  if (dragState.mode === "move") {
    setLayout({
      left: dragState.left + dx,
      top: dragState.top + dy,
      width: dragState.width,
      height: dragState.height,
    });
  } else {
    setLayout({
      left: dragState.left,
      top: dragState.top,
      width: dragState.width + dx,
      height: dragState.height + dy,
    });
  }

  e.preventDefault();
  e.stopPropagation();
}

function onDragEnd(e) {
  if (!dragState) return;
  dragState = null;
  els.wrap.classList.remove("dragging");
  window.removeEventListener("pointermove", onDragMove, true);
  window.removeEventListener("pointerup", onDragEnd, true);
  window.removeEventListener("pointercancel", onDragEnd, true);
  scheduleLayoutSave();
  if (e) { e.preventDefault(); e.stopPropagation(); }
}

function resetLayout() {
  layout = null;
  pillPos = null;
  applyLayout();
  try { chrome.storage.local.remove([LAYOUT_KEY, PILL_KEY]); } catch (e) { /* ignore */ }
}

function wireLayout() {
  // 标题栏拖动。按钮/输入框等交互元素不参与拖动。
  els.hd.addEventListener("pointerdown", (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.some((n) => n && /^(BUTTON|INPUT|TEXTAREA|A|SELECT|LABEL)$/.test(n.tagName || ""))) return;
    beginDrag("move", e);
  });

  // 右下角缩放
  els.resizer.addEventListener("pointerdown", (e) => beginDrag("resize", e));

  // 双击复位
  els.hd.addEventListener("dblclick", () => resetLayout());
  els.resizer.addEventListener("dblclick", () => resetLayout());

  // 收起态：胶囊可拖动
  els.pill.addEventListener("pointerdown", onPillPointerDown);

  // 拖完胶囊松手时浏览器仍会补一个 click，这里在捕获阶段吞掉，
  // 否则「拖走」会被当成「点了一下」，面板立刻弹出来。
  els.pill.addEventListener("click", (e) => {
    if (!pillJustDragged) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  // 窗口尺寸变化时把面板/胶囊拉回可视范围（比如拔掉外接显示器）
  window.addEventListener("resize", () => {
    let changed = false;
    if (layout) {
      layout = clampLayout(layout);
      changed = true;
    }
    if (pillPos) {
      pillPos = clampPillPos(pillPos);
      changed = true;
    }
    if (!changed) return;
    applyLayout();
    scheduleLayoutSave();
    schedulePillSave();
  });
}

function toggle(force) {
  const opening = force === undefined ? !state.expanded : Boolean(force);
  // 必须在隐藏胶囊之前量，否则拿不到它的位置
  const pillRect = opening ? els.pill.getBoundingClientRect() : null;

  state.expanded = opening;
  els.panel.classList.toggle("hidden", !opening);
  els.pill.classList.toggle("hidden", opening);

  /**
   * 从「被拖走的胶囊」打开面板时，让面板从胶囊的位置长出来。
   *
   * 不这么做的话，用户把按钮拖到左上角、点开却在右下角弹出面板，
   * 拖按钮这件事就白做了。面板以右下角对齐胶囊，效果和默认态一致：
   * 默认时胶囊在右下角，面板正好盖在它上方。
   */
  if (opening && !layout && pillPos && pillRect && pillRect.width) {
    const w = els.panel.offsetWidth || 468;
    const h = els.panel.offsetHeight || Math.round(window.innerHeight * 0.78);
    layout = clampLayout({
      left: pillRect.right - w,
      top: pillRect.bottom - h,
      width: w,
      height: h,
    });
  }

  applyLayout();          // 展开时套用记忆的尺寸/位置，收起时恢复胶囊位置
  if (state.expanded) {
    if (!state.data) loadSubtitle(state.url);
    renderCues();
  }
}

function setPill(text, dim = false, loading = false) {
  els.pillText.textContent = text;
  els.pill.classList.toggle("dim", dim);
  const dot = els.pill.querySelector(".dot");
  if (loading) {
    if (dot) dot.outerHTML = '<span class="spin"></span>';
  } else {
    const sp = els.pill.querySelector(".spin");
    if (sp) sp.outerHTML = '<span class="dot"></span>';
  }
}

function renderCues() {
  const d = state.data;
  if (!d || !d.ok) {
    els.body.innerHTML = "";
    return;
  }
  const kw = state.keyword.toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;

  d.cues.forEach((c, i) => {
    let html = escapeHtml(c.text);
    if (kw) {
      if (!c.text.toLowerCase().includes(kw)) return;
      html = highlight(html, kw);
    }
    shown++;
    const div = document.createElement("div");
    div.className = "cue";
    div.dataset.start = String(c.start);
    div.dataset.idx = String(i);
    div.innerHTML = `<span class="ts">${fmtClock(c.start)}</span><span class="tx">${html}</span>`;
    frag.appendChild(div);
  });

  els.body.innerHTML = "";
  if (!shown) {
    els.body.innerHTML = `<div class="state">没有匹配「${escapeHtml(state.keyword)}」的字幕</div>`;
    return;
  }
  els.body.appendChild(frag);

  // 高亮当前播放位置
  syncActiveCue();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlight(escaped, kw) {
  const escKw = escapeHtml(kw);
  if (!escKw) return escaped;
  try {
    const re = new RegExp(escKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  } catch {
    return escaped;
  }
}

function renderStatusPanel({ title, detail, err, actions = [] }) {
  const acts = actions
    .map((a) => `<button class="btn ${a.primary ? "primary" : ""}" data-act="${a.act}">${escapeHtml(a.label)}</button>`)
    .join("");
  els.body.innerHTML = `
    <div class="state">
      <div class="big">${escapeHtml(title)}</div>
      <div class="${err ? "err" : ""}">${detail || ""}</div>
      ${acts ? `<div class="actions">${acts}</div>` : ""}
    </div>`;
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function send(type, extra = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "无响应" });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function loadSubtitle(url, force = false) {
  if (!url || state.loading) return;
  state.loading = true;
  state.error = "";
  setPill("加载字幕…", false, true);
  setFtState("loading", "加载中");

  const r = await send("SUBTITLES", { url, force });
  state.loading = false;

  if (!r.ok) {
    state.data = { ok: false, reason: r.error || "请求失败" };
    setPill("字幕获取失败", true);
    setFtState("bad", "未连接");
    renderFailure();
    return;
  }

  const d = r.data;
  state.data = d;
  state.login = d.login || null;

  if (d.ok) {
    const isAi = String(d.track?.lan || "").includes("ai") || d.track?.ai_type === 1;
    // 胶囊上只显示「字幕」，不显示条数：
    // cues 是字幕分段条数（69 条），并不是「69 个字」或「69 句」，容易被误解。
    // 真实信息放在面板头部（总时长/分P）和底部标签（来源）里。
    setPill("字幕", false);
    els.meta.textContent = `${fmtClock(d.page.duration)} · P${d.page.index}`;
    els.srcTag.textContent = isAi ? "B站 AI 字幕" : "UP主字幕";
    els.srcTag.className = "ft-mid " + (isAi ? "ai" : "ok");
    els.footNote.textContent = r.data.fromCache ? "缓存" : "已加载";
    setFtState("ok", "已连接");
    renderCues();
    if (state.expanded) els.panel.classList.remove("hidden");
  } else {
    setPill(d.reason === "no-subtitle" ? "无字幕" : "不可用", true);
    renderFailure();
  }
}

function renderFailure() {
  const d = state.data || {};
  const login = state.login;
  const noLogin = login && !login.loggedIn;

  if (d.reason === "no-subtitle") {
    const actions = [{ act: "retry", label: "重新检查", primary: true }];

    let title, detail;
    if (noLogin) {
      // 区分「没 cookie」和「cookie 过期」，这俩处理方式不同
      if (login.reason === "no-cookie") {
        title = "当前浏览器未登录 B站";
        detail =
          "没有找到 bilibili 的登录信息。<br/>" +
          "请在<b>这个浏览器</b>里登录 B站，然后点「重新检查」。";
      } else {
        title = "B站登录已失效";
        detail =
          "找到了登录信息但已过期。<br/>" +
          "请重新登录 bilibili.com，然后点「重新检查」。";
      }
    } else {
      title = "该视频没有可用字幕";
      detail = "B站没有为这个视频生成字幕。<br/>没有字幕就无法做总结和问答。";
    }
    renderStatusPanel({ title, detail, actions });
  } else {
    renderStatusPanel({
      title: "字幕获取失败",
      detail: escapeHtml(d.reason || "未知原因"),
      err: true,
      actions: [
        { act: "retry", label: "重试", primary: true },
        { act: "openOptions", label: "设置" },
      ],
    });
  }
  els.meta.textContent = "";
  els.srcTag.textContent = "";
  els.srcTag.className = "ft-mid";
  els.footNote.textContent = "";
}

// ---------------------------------------------------------------------------
// 播放器联动：点击跳到对应时间、自动高亮当前句
// ---------------------------------------------------------------------------

/** "02:15" / "1:02:15" → 秒数 */
function parseTs(s) {
  const parts = String(s).split(":").map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 底栏左侧的连接状态：ok / loading / bad */
function setFtState(kind, text) {
  if (!els.ftState) return;
  const box = els.ftState.parentElement;
  if (box) box.className = "ft-state" + (kind && kind !== "ok" ? " " + kind : "");
  els.ftState.textContent = text;
}
function seekTo(sec) {
  const v = document.querySelector("video");
  if (v) {
    v.currentTime = Math.max(0, Number(sec) || 0);
    v.play().catch(() => {});
    return;
  }
  // 兜底：B 站播放器包裹层
  const wrap = document.querySelector(".bpx-player-video-wrap video");
  if (wrap) {
    wrap.currentTime = Math.max(0, Number(sec) || 0);
    wrap.play().catch(() => {});
  }
}

let videoBound = false;
function syncActiveCue() {
  const v = document.querySelector("video");
  if (!v || !state.data || !state.data.ok) return;
  if (!videoBound) {
    videoBound = true;
    v.addEventListener("timeupdate", syncActiveCue);
  }
  if (!state.expanded) return;
  const t = v.currentTime;
  const cues = state.data.cues;
  let idx = -1;
  for (let i = 0; i < cues.length; i++) {
    if (t >= cues[i].start && t < (cues[i + 1]?.start ?? Infinity)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  const nodes = els.body.querySelectorAll(".cue");
  nodes.forEach((n) => n.classList.toggle("active", Number(n.dataset.idx) === idx));
  const active = els.body.querySelector(".cue.active");
  if (active && state.expanded) {
    const br = els.body.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    if (ar.top < br.top || ar.bottom > br.bottom) {
      active.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

// ---------------------------------------------------------------------------
// 导出 / 复制
// ---------------------------------------------------------------------------

/**
 * 触发下载。
 *
 * 注意：`<a>` 必须 append 到文档里再 click，否则在部分情况下
 * （尤其是 Shadow DOM 里创建的游离节点）点击不生效。
 * 另外加 rel="noopener" 避免不必要的 opener 关联。
 */
function download(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // 立刻移除节点，稍后再释放 URL（太快释放可能导致下载失败）
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function baseName() {
  const d = state.data;
  const title = d?.info?.title || document.title;
  const p = d?.page?.index || 1;
  return `${safeName(title)}_P${p}`;
}

function exportTxt() {
  if (!state.data?.ok || !state.data.cues?.length) return;
  download(`${baseName()}.txt`, cuesToTxtWithTime(state.data.cues));
}

async function copyAll() {
  if (!state.data?.ok) return;
  const text = cuesToText(state.data.cues);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const btn = shadow.querySelector('[data-act="copy"]');
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

// ---------------------------------------------------------------------------
// DeepSeek：总结与聊天
// ---------------------------------------------------------------------------

/**
 * 总结用的系统提示词（固定）。
 *
 * 设计要点：
 *  - 明确「你是助手不是复读机」，避免直接把字幕原样吐回来
 *  - 输出结构固定，保证每次格式一致，方便一眼扫读
 *  - 要求引用时间戳，这样点击能回到原文（配合我们已有的 seek）
 *  - 明确禁止编造字幕里没有的信息
 */
const SUMMARY_SYSTEM_PROMPT = `你是一个专业的视频内容总结助手。用户会给你一份B站视频的完整字幕文本（可能没有标点、有错别字、有口语重复）。

请严格按以下结构输出总结，使用 Markdown：

## 一句话概括
用一句话说清这个视频讲了什么（不超过40字）。

## 核心要点
用 3-6 条要点列出视频的主要内容，每条以 "- " 开头。每条要点后标注对应的字幕时间戳，格式如 [02:15]。

## 关键概念
列出视频中出现的专业术语或关键名词，每个用一句话解释（如果视频没有专业术语，写「无」）。

## 适合谁看
一句话说明这个视频适合什么人群。

要求：
1. 只依据字幕内容，绝对不要编造字幕里没提到的信息。
2. 如果字幕内容明显不完整或质量很差，在开头明确说明「字幕质量有限，以下总结可能不准确」。
3. 语言简洁，不要重复视频原话，要提炼。`;

/** 聊天用的系统提示词（固定） */
const CHAT_SYSTEM_PROMPT = `你是一个视频内容问答助手。用户正在观看一个B站视频，你可以看到该视频的完整字幕文本。

规则：
1. 只依据提供的字幕内容回答。如果用户问的内容字幕里没有，直接说「视频里没有提到这一点」，不要猜测或编造。
2. 回答简洁直接，一般不超过 150 字。
3. 如果字幕里提到了相关的时间点，请标注时间戳，格式如 [02:15]。
4. 用中文回答。`;

/** 把字幕压成给模型的上下文。带时间戳，让模型能引用。 */
function buildTranscriptContext() {
  if (!state.data?.ok) return "";
  const cues = state.data.cues;
  const lines = cues.map((c) => `[${fmtClock(c.start)}] ${c.text}`);
  const title = state.data.info?.title || document.title;
  const dur = fmtClock(state.data.page?.duration || 0);
  return `视频标题：${title}
视频时长：${dur}
字幕（共 ${cues.length} 条）：

${lines.join("\n")}`;
}

/** 极简 Markdown → HTML（只处理标题、粗体、列表、代码、段落） */
/* ---------------- Markdown 渲染 ----------------
 *
 * 自己写而不引库：这是免构建的 content script，引 markdown-it 要多背 100KB，
 * 而这里真正需要支持的语法就那几种。
 *
 * 处理顺序是关键：
 *   1. 先把围栏代码块整块摘出来——否则里面的 ** 和 # 会被当成格式吃掉
 *   2. 行内代码同理，先换成占位符，最后再放回来
 *   3. 逐行做块级解析（标题/列表/引用/表格/段落）
 *   4. 块内文本统一 escapeHtml 后再做行内格式，避免 XSS
 */

const MD_PH = "\uE000";   // 私有区字符，正文里不会出现

/** 行内格式：代码 → 链接 → 粗体 → 斜体。入参必须已经 escape 过 */
function mdInline(escaped) {
  const codes = [];
  let s = String(escaped).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `${MD_PH}${codes.length - 1}${MD_PH}`;
  });

  // 链接只放行 http(s) / mailto，其余降级成锚点，防止 javascript: 伪协议
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const ok = /^(https?:\/\/|mailto:)/i.test(href);
    return `<a href="${ok ? href : "#"}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  // 斜体的前后各加一个边界，避免把 "2 * 3" 这类算式当成强调
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!_)/g, "$1<em>$2</em>");

  return s.replace(new RegExp(MD_PH + "(\\d+)" + MD_PH, "g"), (_, i) => `<code>${codes[+i]}</code>`);
}

/** 围栏代码块：深色卡片 + 语言条 + 复制键 */
function mdCodeBlock(codeEscaped, lang) {
  const l = String(lang || "").toLowerCase();
  return (
    `<div class="code">` +
      `<div class="code-hd">` +
        `<span class="code-lang">${l || "text"}</span>` +
        `<button type="button" class="code-copy" data-act="copy-code">复制</button>` +
      `</div>` +
      `<pre><code>${codeEscaped}</code></pre>` +
    `</div>`
  );
}

/** 表格分隔行：只由 | - : 和空格组成，且至少有一个 - */
function mdIsSep(l) {
  return /^\s*[|\s:-]+$/.test(l) && l.includes("-");
}

function mdSplitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** 这一行会不会开启一个新的块？段落循环靠它决定在哪停 */
function mdIsBlockStart(line) {
  return (
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^\s*\|/.test(line)
  );
}

/** 列表：支持一层嵌套（缩进更深的行归到上一条下面） */
function mdList(lines, start) {
  const baseIndent = lines[start].match(/^[ \t]*/)[0].length;
  const ordered = /^\s*\d+[.)]\s+/.test(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(/^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/);
    if (!m) break;
    if (m[1].length !== baseIndent) break;   // 更浅=回到上层，更深=交给递归

    let text = m[3];
    i++;

    // 续行：缩进更深、又不是新的列表项，并回当前条目
    while (i < lines.length && lines[i].trim() && !/^([ \t]*)([-*+]|\d+[.)])[ \t]+/.test(lines[i]) && /^[ \t]{2,}/.test(lines[i])) {
      text += " " + lines[i].trim();
      i++;
    }

    // 子列表
    let sub = "";
    if (i < lines.length) {
      const nm = lines[i].match(/^([ \t]*)([-*+]|\d+[.)])[ \t]+/);
      if (nm && nm[1].length > baseIndent) {
        const r = mdList(lines, i);
        sub = r.html;
        i = r.next;
      }
    }

    items.push(`<li>${mdInline(escapeHtml(text))}${sub}</li>`);
  }

  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

function renderMarkdown(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 围栏代码块。没闭合就把剩下的全当代码——流式输出中途必然是这种状态
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++;   // 吃掉收尾的 ```
      out.push(mdCodeBlock(escapeHtml(buf.join("\n")), fence[1]));
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr/>"); i++; continue; }

    // 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${mdInline(escapeHtml(h[2]))}</h${lv}>`);
      i++;
      continue;
    }

    // 引用：整块再走一遍块级解析，里面可以继续有列表
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格：当前行有竖线，且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && mdIsSep(lines[i + 1])) {
      const head = mdSplitRow(line);
      const aligns = mdSplitRow(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""
      );
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(mdSplitRow(lines[i++]));
      const cell = (tag, text, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${mdInline(escapeHtml(text))}</${tag}>`;
      const thead = head.map((c, k) => cell("th", c, k)).join("");
      const tbody = rows
        .map((r) => "<tr>" + head.map((_, k) => cell("td", r[k] ?? "", k)).join("") + "</tr>")
        .join("");
      out.push(`<div class="md-table"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const r = mdList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 段落：至少吃掉一行，避免某行被判成块首却没被任何分支接手时死循环
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !mdIsBlockStart(lines[i]))) {
      para.push(lines[i++]);
    }
    out.push(`<p>${mdInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br/>")}</p>`);
  }

  return out.join("");
}

/** 统一的 DeepSeek 流式调用（返回 port 句柄，便于中断） */
function startDeepSeekStream(payload, handlers) {
  const port = chrome.runtime.connect({ name: "ds_stream" });
  let finished = false;

  port.onMessage.addListener((m) => {
    if (m.type === "delta") handlers.onDelta?.(m.text);
    else if (m.type === "think") handlers.onThink?.(m.text);
    else if (m.type === "session") handlers.onSession?.(m.sessionId);
    else if (m.type === "upload") handlers.onUpload?.(m.text);
    else if (m.type === "done") {
      finished = true;
      handlers.onDone?.(m);
      port.disconnect();
    } else if (m.type === "error") {
      finished = true;
      handlers.onError?.(m);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (!finished) handlers.onError?.({ msg: "连接中断" });
  });

  port.postMessage({ type: "start", payload });
  return {
    abort() {
      try {
        port.postMessage({ type: "abort" });
        port.disconnect();
      } catch {}
    },
  };
}

/* ---------------- 总结 ---------------- */

let sumStream = null;

/** 总结/聊天之前检查前置条件，缺什么就提示什么 */
function requireSubtitle(container) {
  if (state.data?.ok && state.data.cues?.length) return true;
  container.innerHTML = `
    <div class="hint-box">
      还没有可用的字幕，无法${state.tab === "sum" ? "总结" : "问答"}。<br/>
      请先到「字幕」标签确认字幕已加载。
    </div>`;
  return false;
}

/**
 * 总结正文美化：
 *   1. 把 [02:15] 这种时间戳变成可点击的小胶囊
 *   2. 按 ## 小节把内容拆成独立卡片
 *
 * 之所以在 HTML 字符串上做而不是改 DOM：流式输出时每帧都要重渲染，
 * 字符串处理一次到位，比反复遍历 DOM 便宜。
 */
function decorateSummary(html) {
  if (!html) return html;

  // 只认方括号包起来的时间戳，避免误伤正文里的普通数字
  let out = html.replace(
    /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g,
    '<button class="ts-tag" data-seek="$1" title="跳转到 $1">$1</button>'
  );

  // 按二级标题切块。第一块可能是标题前的内容（比如「字幕质量有限」的提示）
  // 流式输出时只要出现第一个小节就立刻成卡，避免「先平铺、结束才变卡片」的跳变
  const parts = out.split(/(?=<h2[\s>])/i);
  const cards = parts.filter((p) => /^\s*<h2[\s>]/i.test(p));
  if (!cards.length) return out;   // 没有分节结构就保持原样

  const head = parts.length && !/^\s*<h2[\s>]/i.test(parts[0]) ? parts[0] : "";
  return head + cards.map((c) => `<section class="card">${c}</section>`).join("");
}

async function generateSummary() {
  if (!requireSubtitle(els.sumBody)) return;
  if (state.sum.loading) return;
  if (state.sum.text) {
    // 已有总结：不重复生成，除非用户强制（点按钮视为强制已由 UI 处理）
  }

  const auth = await checkDsLogin();
  if (!auth) {
    // 与聊天一致：未登录必须给出可点的反馈，不能静默失败
    els.sumBody.innerHTML = `<div class="hint-box">
      需要先登录 DeepSeek 才能生成总结。
      <br/><button class="btn primary" data-act="ds-login">登录 DeepSeek</button>
    </div>`;
    return;
  }
  const ctx = buildTranscriptContext();
  const MAX_CTX = 40000;
  let transcript = ctx;
  let truncated = false;
  if (ctx.length > MAX_CTX) {
    transcript = ctx.slice(0, MAX_CTX);
    truncated = true;
  }

  state.sum = { loading: true, text: "", sessionId: null };
  els.sumBody.innerHTML = `<div class="md streaming"></div>`;
  const mdEl = els.sumBody.querySelector(".md");
  els.sumBody.scrollTop = 0;

  const btn = shadow.querySelector('[data-act="do-sum"]');
  if (btn) btn.disabled = true;

  const think = els.thinkBox.checked;

  sumStream = startDeepSeekStream(
    {
      prompt: truncated
        ? `${transcript}\n\n（注意：字幕过长已截断，以上是不完整内容）`
        : transcript,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      thinking: think,
    },
    {
      onDelta(t) {
        state.sum.text += t;
        mdEl.innerHTML = decorateSummary(renderMarkdown(state.sum.text));
        mdEl.classList.add("streaming");
        // 流式时自动跟到底部
        els.sumBody.scrollTop = els.sumBody.scrollHeight;
      },
      onThink(t) {
        state.sum.thinking = (state.sum.thinking || "") + t;
      },
      onSession(id) {
        state.sum.sessionId = id;
      },
      onDone(m) {
        mdEl.innerHTML = decorateSummary(renderMarkdown(m.text || state.sum.text));
        mdEl.classList.remove("streaming");
        state.sum.loading = false;
        if (btn) btn.disabled = false;
        els.footNote.textContent = m.thinking
          ? `已总结 · 思考 ${m.thinking.length} 字`
          : "已总结";
      },
      onError(m) {
        state.sum.loading = false;
        if (btn) btn.disabled = false;
        renderDsError(m, els.sumBody);
      },
    }
  );
}

/** 按钮上短暂显示「已复制」。有 <span> 标签的只改 span，别把图标抹掉 */
function flashLabel(btn, text) {
  if (!btn) return;
  const target = btn.querySelector("span") || btn;
  const old = target.textContent;
  target.textContent = text;
  setTimeout(() => (target.textContent = old), 1200);
}

/** 复制整条 AI 回答（复制的是渲染后的纯文本，不是 markdown 源码） */
async function copyMsg(btn) {
  const box = btn.closest(".msg");
  const bubble = box?.querySelector(".bubble");
  if (!bubble) return;

  // 思考过程不该进剪贴板。折叠状态下 <summary> 的文字仍然可见，
  // 直接取 innerText 会把「思考过程」四个字带进去，所以克隆一份剔掉再取。
  // 克隆体必须挂到文档里量，否则 innerText 会退化成 textContent，
  // 列表项之间不会换行。
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll(".think-box, .think-body").forEach((n) => n.remove());
  clone.style.cssText = "position:absolute;left:-9999px;top:0;white-space:normal";
  document.body.appendChild(clone);
  const text = clone.innerText.trim();
  clone.remove();

  if (!text) return;
  await copyText(text);
  flashLabel(btn, "已复制");
}

/** 复制单个代码块 */
async function copyCode(btn) {
  const box = btn.closest(".code");
  const code = box?.querySelector("code");
  if (!code) return;
  await copyText(code.textContent);
  flashLabel(btn, "已复制");
}
async function copySummary() {
  const text = state.sum?.text;
  if (!text) return;
  await copyText(text);
  flashBtn('[data-act="copy-sum"]', "已复制");
}

/* ---------------- 聊天 ---------------- */

/**
 * 发送门闩。
 *
 * sendChat 内部有 await（校验登录态、拼字幕），在 await 期间
 * `cs().sending` 还没置位。如果此时又来一次触发（Enter 的 keydown+keyup、
 * 或者用户连点发送键），两次调用都能通过检查，结果发出两条消息。
 *
 * 所以用一个同步的模块级标志位，在进入异步流程前就把门关上。
 */
let sendLock = false;

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (sendLock || cs().sending) return;

  sendLock = true;
  try {
    await sendChatInner(text);
  } finally {
    // 无论成功、失败还是抛异常，都要开门，否则输入框会一直发不出去
    sendLock = false;
  }
}

async function sendChatInner(text) {
  const isVideo = state.chat.mode === "video";

  // 视频模式必须有字幕；普通模式不需要
  if (isVideo && !state.data?.ok) {
    requireSubtitle(els.chatBody);
    // 不清空输入框：用户已经打好的问题不该因为没字幕就丢掉
    return;
  }

  const auth = await checkDsLogin();
  if (!auth) {
    // 未登录时必须给出反馈。之前这里是静默 return——
    // 用户按发送什么都不会发生，看上去就像「按钮坏了 / Enter 没反应」。
    els.chatBody.insertAdjacentHTML(
      "beforeend",
      `<div class="hint-box">
        需要先登录 DeepSeek 才能提问。
        <br/><button class="btn primary" data-act="ds-login">登录 DeepSeek</button>
      </div>`
    );
    els.chatBody.scrollTop = els.chatBody.scrollHeight;
    // 不清空输入框，登录回来还能直接发
    return;
  }

  const files = cs().files.slice();

  // 清空输入框，但保留一份原始文本：万一请求失败要回填
  const originalText = els.chatInput.value;
  els.chatInput.value = "";
  els.chatInput.style.height = "auto";

  // ⚠️ 关键：把当前会话对象捕获成局部变量。
  // 用户可能在生成过程中切换模式，那时 cs() 会指向另一个模式的对象。
  // 用局部引用能保证这段流的回调始终写回它自己所属的会话，
  // 两边记录都不会串。
  const S = cs();

  const userTurn = { role: "user", text, files: files.map((f) => f.name) };
  appendMsg("user", text, userTurn.files);
  S.history.push({ role: "user", content: text });
  S.turns.push(userTurn);

  S.sending = true;
  const aiEl = appendMsg("ai", "");
  aiEl.classList.add("streaming");
  S.liveEl = aiEl;

  /**
   * 系统提示词只在该会话的第一轮携带。
   *
   * 原因：DeepSeek 靠 chat_session_id + parent_message_id 维持上下文，
   * 系统提示词一旦进入首轮就已经在会话历史里了。后续轮次重复拼接会：
   *   1. 浪费 token（每轮都重复几千字规则）
   *   2. 让模型误以为用户又强调了一遍要求，容易跑偏
   *
   * 所以用 isFirstTurn 判断。点「新对话」会重置 sessionId，届时又变回首轮。
   * 注意：切换模式**不会**重置，两个模式各自独立地保持自己的会话。
   */
  const isFirstTurn = !S.sessionId;

  let systemPrompt = null;
  let prompt = text;

  if (isVideo) {
    const transcript = buildTranscriptContext();
    const MAX_CTX = 30000;
    const ctx =
      transcript.length > MAX_CTX
        ? transcript.slice(0, MAX_CTX) + "\n…（字幕已截断）"
        : transcript;

    if (isFirstTurn) {
      // 首轮：系统提示词 + 字幕 + 问题
      systemPrompt = CHAT_SYSTEM_PROMPT;
      prompt = `以下是视频字幕，作为回答依据：\n\n${ctx}\n\n---\n\n我的问题：${text}`;
    } else {
      // 后续轮次：字幕已经在会话上下文里，只发问题。
      // 但会话是 DeepSeek 服务端保存的，它确实"记得"首轮给过的字幕。
      prompt = text;
    }
  } else if (isFirstTurn) {
    // 普通模式首轮不带任何视频相关系统提示词
    systemPrompt = null;
    prompt = text;
  }

  S.files = [];
  renderAttaches();

  // 正在生成时切走模式，回来要能看到这个进行中的气泡
  const liveFor = (el) => {
    if (state.chat.mode === S.mode) return el;
    return S.liveEl || el;
  };

  S.stream = startDeepSeekStream(
    {
      prompt,
      systemPrompt,
      chatSessionId: S.sessionId,
      parentMessageId: S.parentMessageId,
      thinking: els.chatThink.checked,
      search: els.chatSearch.checked,
      files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, dataUrl: f.dataUrl })),
    },
    {
      onDelta(t) {
        S.buffer += t;
        updateAiBubble(liveFor(aiEl));
        if (state.chat.mode === S.mode) els.chatBody.scrollTop = els.chatBody.scrollHeight;
      },
      onThink(t) {
        S.thinking = (S.thinking || "") + t;
        updateAiBubble(liveFor(aiEl));
        if (state.chat.mode === S.mode) els.chatBody.scrollTop = els.chatBody.scrollHeight;
      },
      onUpload(t) {
        aiEl.dataset.upload = t;
        updateAiBubble(liveFor(aiEl));
      },
      onSession(id) {
        S.sessionId = id;
      },
      onDone(m) {
        aiEl.classList.remove("streaming");
        const text2 = m.text || S.buffer;
        const think2 = m.thinking || S.thinking;
        S.turns.push({ role: "ai", text: text2, thinking: think2 });
        aiEl.innerHTML = renderAiBubble(think2, text2, null, true);

        S.history.push({ role: "assistant", content: text2 });
        S.parentMessageId = m.messageId || null;
        S.buffer = "";
        S.thinking = "";
        S.sending = false;
        S.stream = null;
        S.liveEl = null;

        if (state.chat.mode === S.mode) els.chatBody.scrollTop = els.chatBody.scrollHeight;
      },
      onError(m) {
        aiEl.classList.remove("streaming");
        aiEl.innerHTML = `<div class="bubble">⚠️ ${escapeHtml(
          m.needLogin ? "DeepSeek 登录已失效" : m.msg || "请求失败"
        )}</div>`;
        if (m.needLogin) {
          aiEl.innerHTML += `<div class="hint-box"><button class="btn primary" data-act="ds-login">重新登录 DeepSeek</button></div>`;
        }
        S.buffer = "";
        S.thinking = "";
        S.sending = false;
        S.stream = null;
        S.liveEl = null;

        // 失败时把问题回填到输入框，避免用户重打一遍。
        // 只在输入框仍为空时回填，不覆盖用户失败后新输入的内容。
        if (state.chat.mode === S.mode && !els.chatInput.value.trim()) {
          els.chatInput.value = originalText;
          els.chatInput.style.height = "auto";
          els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 104) + "px";
        }
      },
    }
  );
}

/** 渲染 AI 气泡的 HTML（思维链可折叠 + 正文 + 上传状态） */
function renderAiBubble(thinking, body, upload, final) {
  const parts = [];
  if (thinking) {
    parts.push(
      `<details class="think-box"${final ? "" : " open"}><summary>思考过程</summary>` +
        `<div class="think-body">${escapeHtml(thinking)}</div></details>`
    );
  } else if (upload) {
    parts.push(`<div class="think-body">${escapeHtml(upload)}</div>`);
  }
  if (body) parts.push(renderMarkdown(body));

  // 操作栏只在生成结束后出现：流式过程中一直在重渲染，挂上去会闪
  const actions =
    final && body
      ? `<div class="msg-actions">
           <button type="button" class="act-btn" data-act="copy-msg" title="复制这条回答">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
               <rect x="9" y="9" width="12" height="12" rx="2"></rect>
               <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
             </svg>
             <span>复制</span>
           </button>
         </div>`
      : "";
  return `<div class="bubble md">${parts.join("")}</div>${actions}`;
}

/** 流式过程中更新 AI 气泡 */
function updateAiBubble(aiEl, final = false) {
  aiEl.innerHTML = renderAiBubble(cs().thinking, cs().buffer, aiEl.dataset.upload, final);
}

/**
 * 开始新对话：只清空**当前模式**的会话。
 *
 * 另一个模式（比如切到普通后点新对话）的历史保持不动，
 * 切回去照样能看到。
 */
function newChat() {
  const s = cs();
  if (s.stream) {
    s.stream.abort();
    s.stream = null;
  }
  s.sending = false;
  s.history = [];
  s.buffer = "";
  s.thinking = "";
  s.sessionId = null;
  s.parentMessageId = null;
  s.files = [];
  s.turns = [];
  s.scrollTop = 0;
  s.liveEl = null;

  if (els) {
    els.chatBody.innerHTML = "";
    renderAttaches();
    els.chatThink.checked = false;
    els.chatSearch.checked = false;
    els.chatBody.scrollTop = 0;
  }
  appendNotice(
    state.chat.mode === "video"
      ? "已开始新对话。可以就这个视频提问。"
      : "已开始新对话。"
  );
}

function appendNotice(text) {
  const div = document.createElement("div");
  div.className = "hint-box";
  div.textContent = text;
  els.chatBody.appendChild(div);
  els.chatBody.scrollTop = els.chatBody.scrollHeight;
}

function appendMsg(role, text, fileNames = []) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const fileHtml = fileNames.length
    ? `<div class="attach" style="margin-top:5px">📎 ${fileNames.map(escapeHtml).join("、")}</div>`
    : "";
  div.innerHTML =
    role === "user"
      ? `<div class="bubble">${escapeHtml(text)}${fileHtml}</div>`
      : renderAiBubble(null, text, null, true);
  els.chatBody.appendChild(div);
  els.chatBody.scrollTop = els.chatBody.scrollHeight;
  return div;
}

/* ---------------- DeepSeek 登录 ---------------- */

async function checkDsLogin() {
  const r = await send("DS_AUTH_STATE");
  if (r.ok && r.data?.loggedIn) return r.data;
  return null;
}

async function loginDeepSeek() {
  const r = await send("DS_SYNC", { open: true });
  const d = r.data || {};
  if (d.ok) {
    flashBtn('[data-act="ds-login"]', "已登录");
    // 登录成功，重试刚才的动作
    if (state.tab === "sum" && !state.sum.text) generateSummary();
    return;
  }
  // 已打开登录页：提示用户完成登录后回来
  renderDsLoginPrompt();
}

function renderDsLoginPrompt() {
  const html = `
    <div class="hint-box">
      已打开 DeepSeek 登录页。<br/>
      完成登录后回到这个视频页，点下面的按钮：
      <br/><button class="btn primary" data-act="ds-check">我已完成登录</button>
    </div>`;
  if (state.tab === "sum") els.sumBody.innerHTML = html;
  else els.chatBody.insertAdjacentHTML("beforeend", html);
}

/** 用户从登录页回来后，重新读取 token 并接着做刚才的事 */
async function recheckDsLogin() {
  const r = await send("DS_SYNC", {});
  const d = r.data || {};
  if (!d.ok) {
    // 还是没拿到，提示继续等待
    if (state.tab === "sum") {
      els.sumBody.innerHTML = `
        <div class="hint-box">
          还没有读到登录信息。<br/>
          请确认已在 chat.deepseek.com 完成登录，再点一次。
          <br/><button class="btn primary" data-act="ds-check">重试</button>
        </div>`;
    }
    return;
  }
  if (state.tab === "sum") generateSummary();
  // 聊天场景：清理提示，让用户直接发问
  else {
    els.chatBody
      .querySelectorAll(".hint-box")
      .forEach((n) => n.remove());
    els.chatInput.focus();
  }
}

function renderDsError(m, container) {
  if (m.needLogin) {
    container.innerHTML = `
      <div class="hint-box">
        DeepSeek 登录已失效。<br/>
        <button class="btn primary" data-act="ds-login">重新登录</button>
      </div>`;
    return;
  }
  container.innerHTML = `<div class="hint-box">⚠️ ${escapeHtml(m.msg || "请求失败")}</div>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function flashBtn(sel, text) {
  const btn = shadow.querySelector(sel);
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---------------------------------------------------------------------------
// 生命周期：SPA 路由
// ---------------------------------------------------------------------------

let lastPath = "";

async function syncRoute() {
  if (!isVideoPage()) {
    if (shadow) els.wrap.classList.add("hidden");
    return;
  }
  els.wrap.classList.remove("hidden");
  const url = location.href;
  if (url === state.url) return;

  const prev = parseVideoUrl(state.url);
  const next = parseVideoUrl(url);
  const sameVideo =
    prev.bvid && next.bvid && prev.bvid === next.bvid && prev.page === next.page;
  if (sameVideo) {
    state.url = url;
    return;
  }

  // 切换到新视频：重置
  state.url = url;
  state.data = null;
  state.keyword = "";
  // 总结与聊天也要清空，否则会拿上一个视频的上下文
  state.sum = { loading: false, text: "", thinking: "", sessionId: null };

  // 先中断两个模式里可能还在跑的流（换视频后旧上下文已无意义）
  for (const key of ["video", "free"]) {
    const s = state.chat.sessions[key];
    if (s.stream) {
      s.stream.abort();
      s.stream = null;
    }
  }
  // 换成新视频：两个模式的记录都要清空（它们都是针对旧视频的）
  const curMode = state.chat.mode;
  state.chat.sessions = {
    video: newChatSession("video"),
    free: newChatSession("free"),
  };
  state.chat.mode = curMode;

  els.search.value = "";
  els.body.innerHTML = "";
  els.sumBody.innerHTML = "";
  els.chatBody.innerHTML = "";
  renderAttaches();
  els.meta.textContent = "";
  els.srcTag.textContent = "";
  els.srcTag.className = "ft-mid";
  els.footNote.textContent = "";
  setPill("加载字幕…", false, true);
  setFtState("loading", "加载中");
  await loadSubtitle(url);
}

function init() {
  if (!isVideoPage()) return;

  // 扩展重载后，旧 content script 留下的 host 元素还在页面上，
  // 但新脚本已经没有任何引用（旧脚本的闭包已销毁）。
  // 此时必须把残留节点清掉重建，否则「面板在、但不响应」。
  const stale = document.getElementById(HOST_ID);
  if (stale) {
    // 能拿到 _dbg 说明是同一份脚本的实例，直接复用
    if (stale._dbg) {
      attachDebugHook();
      return;
    }
    stale.remove();
  }

  build();
  // 安装滚轮/按键隔离（必须在 build 之后，需要拿到 host 和展开状态）
  installScrollIsolation(
    document.getElementById(HOST_ID),
    () => state.expanded
  );
  // 拖动/缩放：先接线，再读记忆的布局
  wireLayout();
  loadLayout();
  attachDebugHook();
  state.url = location.href;
  loadSubtitle(state.url);

  // B 站是 SPA：监听 DOM 变化 + popstate
  const mo = new MutationObserver(() => {
    if (location.href !== state.urlOrLast) {
      state.urlOrLast = location.href;
      setTimeout(syncRoute, 400);
    }
  });
  state.urlOrLast = location.href;
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", () => setTimeout(syncRoute, 300));
  window.addEventListener("hashchange", () => setTimeout(syncRoute, 300));
}

// 调试钩子：挂在 DOM 上（content script 在隔离世界，window 变量页面拿不到，
// 但 DOM 属性两边都能读写）。
//
// 用法：const D = document.getElementById("bilidigest-host")._dbg;
//       D.fakeTurn("问","答"); D.snapshot();
function attachDebugHook() {
  const dbg = {
    get state() {
      return state;
    },
    switchMode: (m) => switchChatMode(m),
    newChat: () => newChat(),
    /** 塞一轮假对话（不调网络），用于验证记录保留 */
    fakeTurn(q, a) {
      const s = cs();
      s.turns.push({ role: "user", text: q, files: [] });
      s.turns.push({ role: "ai", text: a, thinking: "" });
      renderChatPane();
    },
    snapshot() {
      const s = state.chat.sessions;
      return {
        mode: state.chat.mode,
        video: { turns: s.video.turns.length, sessionId: s.video.sessionId },
        free: { turns: s.free.turns.length, sessionId: s.free.sessionId },
        domCount: els.chatBody.children.length,
      };
    },
  };
  window.__bilidigest_debug = dbg;
  const hostEl = document.getElementById(HOST_ID);
  if (hostEl) hostEl._dbg = dbg;
}

init();
