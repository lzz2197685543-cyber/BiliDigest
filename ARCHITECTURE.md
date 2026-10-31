# BiliDigest 架构说明

> 基于对 `extension/` 全部源码的实际阅读整理。
> 本项目已从「扩展 + Python 后端」重构为**纯 Chrome 扩展**。

---

## 一、这个项目是做什么的

一句话：**在 B 站视频页把视频里的语音变成可检索的文字，再让 DeepSeek 总结和问答。**

它解决的核心痛点是「视频里的信息没法检索、没法复习」：一小时课程要重看一遍才能找到某个知识点，而变成文字后可以搜索、可以让大模型总结、可以直接提问。

技术上它是一个**单体的 Chrome 扩展（MV3）**，没有后端：

- `content.js` 负责「在哪用、怎么点、怎么展示」；
- `background.js`（Service Worker）负责所有网络请求：取字幕、调 DeepSeek、维持登录态；
- `lib/` 下是两个协议实现：B站字幕协议、DeepSeek 对话协议。

设计上最重要的三个决定：

| 决定 | 原因 |
|---|---|
| 不需要任何后端服务 | B站字幕接口和 DeepSeek 都能直接用浏览器请求，加一层 Python 只增加部署成本 |
| 字幕优先，不本地转写 | 有 B站 AI 字幕时几百毫秒出结果且准确；Whisper 转写要几分钟，收益不成比例 |
| 用 DeepSeek 网页协议而非官方 API | 不需要 API key、不需要付费，复用用户自己的网页登录态 |

---

## 二、整体架构

### 2.1 分层视图

```text
┌─────────────────────────────────────────────────────────────┐
│  页面上下文（content.js，运行在 bilibili.com 里）             │
│                                                              │
│  胶囊按钮 ──点击──▶ 面板（Shadow DOM）                        │
│                       ├── 字幕标签：时间轴列表 / 搜索 / 下载   │
│                       ├── 总结标签：流式渲染 Markdown          │
│                       └── 聊天标签：气泡对话 / 流式渲染        │
│                                                              │
│  ⚠️ 不能 import、不能跨域 fetch，只做 UI 和纯计算             │
└───────────────────────────┬─────────────────────────────────┘
                            │ chrome.runtime.sendMessage
                            │ chrome.runtime.connect（流式）
┌───────────────────────────▼─────────────────────────────────┐
│  Service Worker（background.js，扩展自己的源）                │
│                                                              │
│  职责一：B站字幕                                              │
│    chrome.cookies ──▶ 登录态                                  │
│    fetch wbi/v2 ──▶ 轨道列表 ──▶ cid 校验 ──▶ 下载字幕文件    │
│    chrome.storage.local 缓存 6 小时                           │
│                                                              │
│  职责二：DeepSeek                                             │
│    chrome.scripting 注入 ──▶ 读 localStorage.userToken       │
│    PoW 求解 ──▶ 建会话 ──▶ SSE 流 ──▶ 逐段转发给 UI           │
│                                                              │
│  ⚠️ 只有这里能跨域请求（host_permissions 授权）              │
└─────────────────────────────────────────────────────────────┘
                            │ HTTPS
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
   api.bilibili.com                     chat.deepseek.com
   aisubtitle.hdslb.com                 （PoW + SSE）
```

### 2.2 一次字幕请求的时序

```text
content.js            background.js                   B站
    │                       │                          │
    │ SUBTITLES{url}        │                          │
    ├──────────────────────▶│                          │
    │                       │ 查缓存（sub:v1:BVxxx:pN）│
    │                       │ 命中且未过期 ─▶ 直接返回  │
    │                       │                          │
    │                       │ GET x/web-interface/view │
    │                       ├─────────────────────────▶│
    │                       │◀─ aid, cid, duration ────┤
    │                       │                          │
    │                       │ GET x/player/wbi/v2      │
    │                       ├─────────────────────────▶│
    │                       │◀─ subtitles[] ───────────┤
    │                       │                          │
    │                       │ 校验：URL 是否含 cid      │
    │                       │ 不匹配 ─▶ 立即重试        │
    │                       │                          │
    │                       │ GET 字幕 JSON            │
    │                       ├─────────────────────────▶│
    │                       │◀─ body[{from,to,content}]│
    │                       │                          │
    │                       │ 校验：末句时间 vs 时长     │
    │                       │ 写缓存                   │
    │◀─ {ok,cues,track} ────┤                          │
    │                       │                          │
    │ 渲染到面板              │                          │
```

### 2.3 一次 AI 请求的时序

```text
content.js        background.js              chat.deepseek.com
    │                   │                          │
    │ connect(ds_stream)│                          │
    ├──────────────────▶│                          │
    │ start{prompt,…}   │                          │
    ├──────────────────▶│ 取 token（缓存/注入读取）  │
    │                   │ POST create_pow_challenge│
    │                   ├─────────────────────────▶│
    │                   │◀─ challenge ─────────────┤
    │                   │                          │
    │                   │ 本地暴力求解 PoW          │
    │                   │ （Keccak 变体，1..23 轮） │
    │                   │                          │
    │                   │ POST chat_session/create │
    │                   ├─────────────────────────▶│
    │                   │◀─ sessionId ─────────────┤
    │                   │                          │
    │                   │ POST chat/completion     │
    │                   │   X-DS-PoW-Response      │
    │                   ├─────────────────────────▶│
    │                   │◀─ SSE: ready/delta/…  ───┤
    │◀─ delta 逐段 ─────┤                          │
    │  渲染 Markdown     │                          │
    │◀─ done ───────────┤                          │
```

### 2.4 消息类型一览

| 类型 | 方向 | 作用 |
|---|---|---|
| `SUBTITLES` | content → bg | 取字幕（`{url, force}`） |
| `CLEAR_SUB_CACHE` | options → bg | 清显示字幕缓存 |
| `LOGIN_STATE` | 任意 → bg | B站登录态（以接口为准） |
| `VIDEO_INFO` | content → bg | 取视频标题/分P 信息 |
| `DS_SYNC` | 任意 → bg | 同步 DeepSeek token（`{open}` 可自动开登录页） |
| `DS_AUTH_STATE` | 任意 → bg | DeepSeek 登录状态 |
| `DS_SET_TOKEN` | options → bg | 手动设置 token（会先校验） |
| `DS_CLEAR` | options → bg | 清除 DeepSeek 登录态 |
| `OPEN_OPTIONS` | content → bg | 打开设置页 |
| `ds_stream`（port） | content ⇄ bg | 流式问答，双向长连接 |

---

## 三、各模块是怎么实现的

### 3.1 字幕层 `extension/lib/subtitle.js`

**职责**：给定 B站链接，返回经过校验的字幕 cues。

核心函数链：

```text
parseVideoUrl(url)          → {bvid, page}
fetchVideoInfo(bvid, aid)   → {aid, pages[{cid, duration, ...}]}
fetchSubtitleTracks(...)    → 轨道列表（含重试与串号检测）
scoreTrack(track)           → 打分，选最优
downloadSubtitle(url)       → 解析 JSON 成 cues[]
getSubtitlesForUrl(url)     → 串起以上全部 + 时长校验
```

#### 三个实测事实（这是整个模块存在的理由）

| 事实 | 表现 | 应对 |
|---|---|---|
| 未登录时字幕接口恒空 | `login_mid=0`，`subtitles: []` | 提示用户登录，不重试（重试也没用） |
| 约 1/3 请求返回空 `subtitle_url` | 服务端多副本不一致 | 退避重试（12 次，350ms 间隔） |
| 约一半请求返回**别的视频**的字幕 | CDN 缓存串号 | **立即**重试，不做退避 |

> 串号是根因于 CDN 缓存，不是我们选错接口，换接口也解决不了。

#### 串号的两道校验

```js
// 校验一：字幕 URL 路径里嵌了 cid
// 正确形如 //aisubtitle.hdslb.com/bfs/ai_subtitle/prod/8910235{13424301167}c249d...
//                                  ↑ cid 就嵌在这个位置
subtitle_url_matches_cid(url, cid)

// 校验二：字幕末句时间应接近视频时长（允许 15% 或 30s 误差）
validate_cues(cues, duration)
```

这两道校验缺一不可：只查 cid 遇到 URL 不含 cid 的旧格式会漏；只查时长遇到同长度视频的串号会漏。

#### 接口选择：wbi/v2 优先

`x/player/wbi/v2?aid=&cid=` 和 `x/player/v2?bvid=&cid=` 返回同一个字幕文件，但：

| | `player/v2` | `wbi/v2` |
|---|---|---|
| 参数 | bvid | aid |
| 需要 w_rid 签名 | 否 | **否**（实测未签名也 `code:0`） |
| 实测命中率 | 5/6 | **10/10** |
| 平均耗时 | — | 192ms |

所以先用 `wbi/v2`，失败再回退 `player/v2`，两者**交替尝试**。

#### 轨道评分

```js
中文 +1000   // 中文视频必须有中文字幕，否则再高质量也没用
人工 +100    // UP主上传的比 AI 生成的质量高
AI   -50
```

> ⚠️ 踩过的坑：`lan` 字段对 AI 中文是 `ai-zh`。如果直接 `lan.includes("ai")` 判断「是不是 AI」，那 `ai-zh` 会被误判成……同时 `isChineseLang` 也会因为它含 `ai` 而错误降权。必须先剥掉 `ai-` 前缀再判断语种。最初的权重 `+10/-2/+5` 会导致「英文人工」压过「中文 AI」，正是这个 bug。

### 3.2 DeepSeek 层 `extension/lib/deepseek.js`

**职责**：完整实现 chat.deepseek.com 的问答协议。

#### PoW（工作量证明）

```text
POST /api/v0/chat/create_pow_challenge  {"target_path":"/api/v0/chat/completion"}
  → challenge = {
      algorithm: "DeepSeekHashV1",
      challenge: "<64位十六进制>",
      salt, difficulty, signature, expire_at
    }

求解：找到最小的 i ∈ [0, difficulty)
      使 sha3_256(`${salt}_${expire_at}_${i}`) === challenge

应答头：X-DS-PoW-Response: base64({algorithm,challenge,salt,answer,signature,target_path})
```

#### ⚠️ 最容易踩的坑：这不是标准 SHA3-256

前端 worker 的 keccak-f 循环写的是 `for (i = 1; i < 24; i++)`，**跳过了第 0 轮 iota**。

所以：
- `crypto.subtle.digest('SHA3-256', bytes)` → **永远不匹配**
- 任何现成的 SHA3 库 → **永远不匹配**

必须用 `lib/deepseek.js` 里的纯 JS 实现，它把轮次从 1 开始、并跳过 RC[0]。

验证方法：拿真实挑战，穷举到 `difficulty` 范围内的某个 i，用 `answer` 反算摘要必须等于 `challenge`。

#### SSE 解析

DeepSeek 返回的是 SSE，但正文增量用的是**空 event 名**加 JSON Patch 风格载荷：

```text
data: {"v":"你好"}                                        ← 正文
data: {"p":"response/fragments/-1/content","o":"APPEND", "v":"世界"}
data: {"p":"response/thinking_content","v":"让我想想"}     ← 思维链
event: ready
data: {"response_message_id":"<uuid>"}                   ← 多轮用的 parent_message_id
```

判断依据是 `p` 路径里含 `THINK` 还是 `RESPONSE`/`content`。`lib/deepseek.js` 的 `_consumeSSE` 同时兼容「单个 patch」和「patch 数组」两种形式。

#### 流式如何穿过 Service Worker

MV3 的 Service Worker 可能随时休眠，`sendMessage` 不适合承载长流。所以用 **long-lived port**：

```js
content.js:  port = chrome.runtime.connect({name:"ds_stream"})
             port.onMessage ← {type:"delta", text}
background:  port.onMessage.addListener(...)
             port.postMessage({type:"delta", text})   // 每收到一段就转发
```

好处：面板收起、页面切换都不会中断请求；断开时 `port.onDisconnect` 能收到通知。

#### 系统提示词只在首轮发送

聊天有两种模式（视频 / 普通），但**系统提示词只在会话第一轮拼接**：

```js
const isFirstTurn = !state.chat.sessionId;
if (isVideo && isFirstTurn) {
  systemPrompt = CHAT_SYSTEM_PROMPT;
  prompt = `以下是视频字幕…\n\n${ctx}\n\n---\n\n我的问题：${text}`;
} else if (isVideo) {
  prompt = text;        // 字幕已在服务端会话历史里
}
```

原因：DeepSeek 用 `chat_session_id` + `parent_message_id` 维持上下文。系统提示词进入首轮后已经在历史中，后续重复拼接会白白消耗 token（每轮几千字规则），还可能让模型误以为用户在重复强调要求。

> 这也意味着：**必须在服务端会话有效期内**。如果会话过期而本地还拿着 sessionId，后续轮次会丢失视频上下文。所以「新对话」和切换模式都会清空 sessionId。

#### 文件上传的两个坑

```js
// 坑一：不能手动设 Content-Type，否则覆盖 fetch 的 multipart boundary
const headers = this.baseHeaders();
delete headers["Content-Type"];
headers[pow.header] = pow.value;

// 坑二：上传成功 ≠ 可用。必须轮询到 SUCCESS
await client.waitFileReady(info.id);   // PENDING → PARSING → SUCCESS
refFileIds.push(info.id);              // 这时才能引用
```

#### 两个模式的会话互不干扰

`state.chat` 不是一个会话，而是**按模式分开存两份**：

```js
state.chat = {
  mode: "video",                       // 当前显示哪个
  sessions: {
    video: newChatSession("video"),    // 各自独立的 sessionId / turns
    free:  newChatSession("free"),
  },
};
const cs = () => state.chat.sessions[state.chat.mode];
```

切换模式时**不清空**另一份，只做两件事：保存当前滚动位置、按当前模式重绘。

```js
function switchChatMode(mode) {
  cs().scrollTop = els.chatBody.scrollTop;   // 记住滚到哪了
  state.chat.mode = mode;
  renderChatPane();                          // 从 turns 数组全量重绘
}
```

重绘而不是切换两块 DOM，是因为两个模式共享同一套输入框和附件区；全量重绘最简单也最不容易状态错乱（记录量级只有几条到几十条，没有性能问题）。

> **一个必须在实现时防住的坑**：流式回调里不能写 `cs().xxx`。
> 用户可能在生成过程中切换模式，那时 `cs()` 已经指向另一个会话了。所以发送时先把会话对象捕获成局部变量：
>
> ```js
> const S = cs();                 // 捕获
> S.stream = startDeepSeekStream(..., {
>   onDelta(t) { S.buffer += t; } // 始终写回它自己那份
> });
> ```
>
> 同时用 `S.mode === state.chat.mode` 判断是否该更新 DOM，避免把 A 模式的增量画到 B 模式的界面上。

#### 视觉系统：一套令牌撑起所有组件

所有颜色、圆角、过渡都收在 `.wrap` 上的 CSS 变量里，组件规则只引用变量、不写字面值。这样深色模式只需要覆盖令牌，**组件规则一行都不用改**。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--pink` | `#fb7299` | 主色：主按钮、选中态、强调 |
| `--pink-l` | `#fff0f4` | 主色淡底：当前字幕行、用户气泡、code |
| `--fg` / `--sub` / `--mute` | `#222` / `#71717a` / `#a1a1aa` | 正文 / 次要 / 更弱（时间戳、占位） |
| `--bg` / `--bg-2` / `--card` | `#fff` / `#f9fafb` / `#fafafa` | 面板底 / 悬停 / 卡片底 |
| `--code-bg` | `#fff0f4` | 代码与术语标签底 |
| `--r-sm` / `--r-md` / `--r-xl` | `8px` / `10px` / `12px` | 按钮 / 卡片 / 面板 |
| `--t` | `all .15s ease` | 所有可交互元素的统一过渡 |

**深色模式**用 `@media (prefers-color-scheme: dark)` 只重定义令牌。Shadow DOM 里的媒体查询照样跟随系统，不需要额外监听：

```css
@media (prefers-color-scheme: dark) {
  .wrap { --bg: #18181b; --fg: #e8e8ea; --line: #2c2c33; --pink-l: #3a2029; ... }
}
```

少量组件（`.md code` 的字色、`.md mark` 的高亮黄）在浅色下够用、深色下会糊，单独补一个覆盖块。

> 之前有一批 `background: #fff` 硬编码，深色模式下会变成一排刺眼的白块。统一换成 `var(--bg)` 后才可能整体换肤。

#### 深色标题栏

标题栏在**浅色模式下也是深色**。它承担的是「品牌 + 当前视频上下文」的角色，和下面白色内容区分开，比整块浅色更容易一眼定位。

```css
.hd {
  background:
    radial-gradient(120% 180% at 100% 0%, rgba(139,92,246,.35) 0%, transparent 55%),
    linear-gradient(135deg, #14161f 0%, #1a1e2c 60%, #1d1a2b 100%);
}
```

两层渐变叠加：底子是深蓝黑的对角线渐变，右上角再压一个紫色径向光晕，避免深色块显得死板。底部用 `::after` 画一条 `rgba(255,255,255,.08)` 的高光，而不是边框——深色块和白色内容区直接硬碰会有明显的接缝。

关闭键原本是绝对定位在面板右上角的，改成放进标题栏的 flex 流里并做成圆形描边按钮。因为 `.hd` 是拖动把手，而 `wireLayout` 的 `pointerdown` 会跳过 `BUTTON`，所以点关闭不会被当成拖动。

> 深色模式下标题栏会再压暗一档（`#0c0d13` 起），否则和 `--bg: #18181b` 几乎同色，层次就没了。

#### 时间线卡片字幕列表

字幕区从「一行一行的表格」改成「左侧竖轴 + 右侧卡片」：

- 列表底色压成 `--bg-2`，白色卡片才浮得起来
- 竖轴用每条自己的 `::before` 画一段，靠 `padding-bottom` 连成连续的一条线
- 节点用 `::after` 画空心圆，当前播放条填成主色并加一圈光晕
- 首尾两条要单独处理，否则线头会戳出节点之外：

```css
.cue:first-child::before { top: 14px; }         /* 从第一个节点开始 */
.cue:last-child::before  { bottom: auto; height: 14px; }  /* 到最后一个节点结束 */
```

时间列保持在 34px 左右不放大——它只是定位用的，卡片才是内容主体。

#### 三段式固定底栏

底栏从「左边标签 + 右边说明」改成 `状态 / 来源 / 说明` 三段：

| 位置 | 内容 | 数据来源 |
|---|---|---|
| 左 | 圆点 + 已连接 / 加载中 / 未连接 | `setFtState()` |
| 中 | B站 AI 字幕 / UP主字幕 | `els.srcTag` |
| 右 | 缓存 / 已加载 / 已总结 | `els.footNote` |

圆点的颜色由父元素的 class 决定（`.ft-state.bad` / `.loading`），所以 `setFtState` 只需要改父节点的 `className` 和文字：

```js
function setFtState(kind, text) {
  const box = els.ftState.parentElement;
  box.className = "ft-state" + (kind && kind !== "ok" ? " " + kind : "");
  els.ftState.textContent = text;
}
```

来源标签原来挂的是 `.tag .ai` 这套徽章样式，现在改成 `.ft-mid .ai`——否则徽章的内边距和底色会跟着带进底栏，把三段布局顶歪。

#### 分段标签栏

顶部三个标签是**胶囊分段**：选中项是主色描边胶囊，下面再压一条 3px 的短指示条。

```css
.tab { padding: 6px 14px; margin-bottom: 9px; border-radius: 999px; }
.tab.active { background: var(--pink-l); border-color: var(--pink); color: var(--pink); }
.tab.active::after { position: absolute; left: 10px; right: 10px; bottom: -9px; height: 3px; }
```

指示条的几何是算出来的，不是试出来的：`.tab` 的下外边距是 9px，`.tabs` 没有下内边距，所以标签盒底部往下 9px 正好是标签栏那条细线的上沿。把 `::after` 的 `bottom` 设成 `-9px`，它的底边就恰好压在这条线上——多一点会被裁掉半截，少一点会浮起来一条缝。

> 试错记录：一开始 `margin-bottom: 8px` 配 `bottom: -9px`，指示条有 1px 越过了细线，截图上看像被切了一刀。把两者对齐后才干净。

聊天页的模式切换（视频 / 普通）也用胶囊圆角，和顶部分段保持同一套语言；但它保留浅灰槽底，避免和上方已经有一条粉色胶囊的标签栏抢注意力。

#### 开关：接管外观，保留原生语义

需求是「不要原生 checkbox」。做法不是换成 `<div>`，而是保留 `<input type="checkbox">` 只把外观整个接管：

```css
.chk input[type="checkbox"] { appearance: none; width: 30px; height: 17px; border-radius: 999px; }
.chk input[type="checkbox"]::after { /* 白色圆钮 */ transition: transform .18s var(--ease); }
.chk input[type="checkbox"]:checked { background: var(--pink); }
.chk input[type="checkbox"]:checked::after { transform: translateX(13px); }
```

好处是 JS 读 `.checked` 的代码一行不改，键盘 `Tab` 聚焦、空格切换、读屏播报也全都还在——换成 `<div>` 这些都得手写。

#### 总结分卡片

DeepSeek 的输出是 Markdown，系统提示词固定用 `## 小节` 组织，所以在**渲染出的 HTML 字符串**上切块即可，不用改 DOM 结构：

```js
const parts = out.split(/(?=<h2[\s>])/i);   // 零宽前瞻，按 h2 切开但不消耗它
const cards = parts.filter((p) => /^\s*<h2[\s>]/i.test(p));
return head + cards.map((c) => `<section class="card">${c}</section>`).join("");
```

两个细节：

- 用**零宽前瞻**切分，`<h2>` 本身留在每个片段开头，否则每张卡片会丢掉标题
- 第一个片段可能是标题前的内容（比如「字幕质量有限」的提醒），要单独留在卡片外
- 只要出现第一个 `##` 就立刻成卡，不要等凑够两节——否则流式输出时会先平铺、结束才变卡片，画面会跳一下

时间戳 `[02:15]` 用正则换成 `<button class="ts-tag" data-seek>`，正向处理而不是事后遍历 DOM——流式时每帧都重渲染，遍历 DOM 太贵。**只认方括号包起来的时间**，否则正文里的「3:4 比例」也会被误伤。

#### 按钮视觉规范

参照专业阅读工具，而非营销落地页。核心是「克制、轻量、信息优先」。

| 层级 | 用途 | 样式 |
|---|---|---|
| 主操作 | 每屏至多一个（生成总结、发送） | B站粉 `#fb7299` 实底、白字 |
| 次操作 | 导出、复制、文件 | 白底 + 1px 细边框、深灰字 |
| 三级操作 | 新对话等低权重入口 | 纯文字、无边框无底色 |

统一约束：

- **面板内的按钮无渐变、无重阴影、无胶囊形**；圆角统一 8px
- 尺寸紧凑：高度 28px（发送键 34px）
- 四态齐全：默认 / hover（浅灰底）/ active（更深灰）/ disabled（灰字灰底）
- 禁用态用**配色**表达而非整体 `opacity`，避免文字发虚
- `focus-visible` 用 2px B站粉描边，只对键盘生效，鼠标点击不出现

> 唯一的例外是收起态的悬浮入口（见下节）：它是浮在页面上的单一行动按钮，允许胶囊形和彩色投影。

> AI 回答不加卡片底色和边框——它是一整块阅读区，加框会把正文压成小色块，视觉噪音大。只有用户提问才用浅粉色块标识。

**窄屏保护**：所有按钮带 `overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`，`max-width:100%`，空间不足时省略而不撑破布局。

#### 悬浮入口按钮

收起态的「字幕」按钮不是普通标签，是这个扩展在页面上的唯一入口，要读起来像「浮起来的 AI 助手」：

- 胶囊形 + 主色纵向渐变（浅 → 深），40px 高
- 投影用**主色的 rgba** 而不是中性黑——它看起来是被粉色「托着」，而不是盖了一层灰
- 图标放在半透明白圆底座里，用 `inset 0 0 0 1px` 描一圈，把它从渐变底上分离出来
- hover：`translateY(-1px) scale(1.03)` + `brightness(1.04)` + 阴影加深，`active` 回弹到 `scale(.98)`

状态点没有丢，改成挂在图标右上角的**角标**：字幕就绪 = 绿点，加载中/无字幕 = 灰点。描边色取按钮底色，看起来是「嵌」进去的而不是贴上去的。

> 注意 `.pill` 必须保留 `overflow:hidden`，否则文字过长会溢出按钮；省略号要靠里面的 `[data-el="pillText"]` 自己带 `text-overflow:ellipsis`。

### 3.3 面板层 `extension/content.js`

**职责**：所有 UI 与交互，自包含单文件。

#### ⚠️ 必须知道的坑：content script 不能用 ES module

MV3 的 `content_scripts` 里声明的 JS **不支持 `import`**。写了会抛：

```
SyntaxError: Cannot use import statement outside a module
```

**整段脚本不执行**，表现为「扩展似乎没生效、面板完全不出来」，而且错误不明显。

所以 `content.js` 里需要共享的函数（`parseVideoUrl`、`fmtClock`、`safeName` 等）全部内联。真正的协议逻辑都在 Service Worker 里（`background.js` 是 `"type":"module"`，可以正常 import）。

#### ⚠️ 必须知道的坑：面板滚动会被播放器抢走

**现象**：在字幕列表里滚动，字幕不滚，反而视频被调了音量或拖动进度。

**原因**：B站播放器在 `document`/`window` 上注册了 `wheel` 和键盘监听。面板虽然在更高层级、鼠标也落在面板上，但事件**照样冒泡到 document**。Shadow DOM 只隔离样式，**不隔离事件冒泡**。

**解法**（`installScrollIsolation`，两层）：

1. window 的 **capture 阶段**用 `e.composedPath()` 判断是否落在面板内，是就 `stopPropagation()`
2. 在 shadow root 上自己接管 `wheel`，手动算 `scrollTop += deltaY`（兜住播放器监听器注册更早的情况）

配套 `.body { overscroll-behavior: contain }`，滚到尽头不带动外层页面。

> 注意：capture 阶段**不能**无条件 `preventDefault()`，否则面板自身的滚动也会被取消。

#### ⚠️ 必须知道的坑：`chrome.cookies` 的 domain 过滤

`chrome.cookies.getAll({domain:"bilibili.com"})` 有时返回 **0 个 cookie**，导致「明明登录了却提示未登录」。

原因：`domain` 按 cookie 的 host **精确匹配**，而 SESSDATA 存放在 `.bilibili.com`（带前导点）。

更重要的发现：**有些环境下 `chrome.cookies.getAll()` 连 `{}` 都返回 0，但 `fetch(credentials:"include")` 依然带登录态**（例如用 CDP 启动的 profile）。

所以登录判定**以接口为准**：

```js
const r = await fetch(".../x/web-interface/nav", { credentials: "include" });
if (data.data.isLogin) return { loggedIn: true, ... };   // ← 唯一权威
// chrome.cookies 只用来补充展示信息，读不到不影响判断
```

#### Markdown 渲染

DeepSeek 返回 Markdown。`renderMarkdown()` 是一个**极简**实现，只处理标题、粗体、列表、代码块、段落。

关键：**先 `escapeHtml` 再替换结构**，避免模型输出里的 HTML 变成 XSS。

#### 流式渲染

```js
onDelta(t) {
  state.sum.text += t;
  mdEl.innerHTML = renderMarkdown(state.sum.text);   // 每段重渲染
  els.sumBody.scrollTop = els.sumBody.scrollHeight;  // 自动跟到底
}
```

每段全量重渲染而不是增量追加，是因为 Markdown 语法跨行（比如列表项还没结束），局部更新容易出错。字幕几万字量级下性能足够。

#### 布局对齐：一条竖轴

所有行的水平内边距统一走 `--pad: 14px`：

```css
:root { --pad: 14px; }
.hd     { padding: 13px 42px 10px var(--pad); }
.tabs   { padding: 0 var(--pad); }
.tools  { padding: 9px var(--pad); }
.cue    { padding: 6px var(--pad) 6px calc(var(--pad) - 2.5px); }  /* 减掉左边框 */
.composer { padding: 8px var(--pad) 10px; }
.ft     { padding: 7px var(--pad); }
```

之前这里是 12 / 13 / 14 混用，左边缘会在每行之间轻微跳动，**单看每一行都正常，整体就是「不整齐」**。这类问题很难靠感觉定位，要靠量：取每一行内第一个元素相对面板左边缘的偏移，全部相等才算对齐。

标签栏用 `margin` 而不是 `padding` 拉开间距，`.tab { padding: 9px 0; margin-right: 24px }`，这样第一个标签的文字正好压在 `14px` 那条线上，下划线也贴合文字宽度。

#### 关闭按钮的定位方式

关闭键**不放在头部流式布局里**，而是相对面板绝对定位：

```css
.panel { position: relative; }
.closebtn { position: absolute; top: 12px; right: 12px; z-index: 2; }
/* 头部右侧留出按钮宽度 + 间距，长标题不会钻到按钮底下 */
.hd { padding-right: 40px; }
.hd .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

这样做的原因：如果关闭键是 flex 子项，标题变长时会把按钮往左挤，位置随内容浮动；绝对定位让它与面板边缘保持恒定间距（始终 12px），标题再长也只是自己省略。

两侧都要做保护——**padding 让标题不压按钮，ellipsis 让标题不撑破头部**。

#### ⚠️ 必须知道的坑：窄屏下 `100vw` 会把面板挤出视口

用 `max-width: calc(100vw - 24px)` 约束面板宽度时，`100vw` **包含纵向滚动条宽度**。当 `window.innerWidth = 480` 而 `documentElement.clientWidth = 465` 时，面板宽 456 + 右侧留白 20 就超过了 465，导致**面板左边缘被裁掉 11px**。

解法是不依赖 `vw`，让容器自己约束：

```css
.wrap { max-width: calc(100% - 20px); }        /* 容器不超视口 */

@media (max-width: 520px) {
  .wrap { right: 12px; left: 12px; max-width: none; }  /* 左右都定位 = 宽度即视口-24px */
  .panel { width: 100%; max-width: 100%; }              /* 相对容器，绝不溢出 */
}
```

#### ⚠️ 必须知道的坑：Enter 永远不触发（被自己的 stopPropagation 拦死）

**现象**：输入框能正常打字、能换行，但按 Enter 完全不发送，界面上毫无反应。

**原因**：为了不让 B站播放器抢走面板内的按键，`installScrollIsolation` 在 **window 的 capture 阶段** 调用了 `e.stopPropagation()`：

```js
window.addEventListener("keydown", onGlobalKeyCapture, { capture: true });
// onGlobalKeyCapture 内部：
e.stopPropagation();   // ← 事件在这里就停了
```

capture 阶段在 window 就中止传播，事件**永远到不了 textarea**，所以挂在 `.chat-input` 上的 `keydown` 监听器根本不会执行。

迷惑点在于打字仍然正常：插入字符是浏览器的**默认行为**，不受 `stopPropagation` 影响。所以「能打字但 Enter 没用」这个症状极具误导性。

**解法**：把 Enter 的处理挂到事件真正会经过的那一层——window capture。同一个节点上的多个监听器不受 `stopPropagation` 影响，所以在 `stopPropagation()` 之后紧接着调用也来得及：

```js
function onGlobalKeyCapture(e) {
  // ...
  const realTarget = path[0];          // ← 必须用 composedPath()[0]
  if (els?.chatInput && realTarget === els.chatInput) handleComposerKey(e);
  e.stopPropagation();
}
```

判断「按在哪个元素上」**不能用 `e.target`**：跨 shadow 边界时它会被重定向成宿主 div。

> 调试教训：用 `new KeyboardEvent(...)` 在 CDP 里派发事件时，`composed` 默认是 `false`，事件不会经过 window，导致测试**假通过**。复现真实情况必须显式写 `composed: true`。

#### ⚠️ 必须知道的坑：按一次 Enter 发出两条消息

把 Enter 的处理挂到 window capture 之后，用户反馈「发两条」。

原因：`onGlobalKeyCapture` 同时注册在三个事件上：

```js
window.addEventListener("keydown", onGlobalKeyCapture, { capture: true });
window.addEventListener("keyup",   onGlobalKeyCapture, { capture: true });
window.addEventListener("keypress", onGlobalKeyCapture, { capture: true });
```

而 **`keyup` 的 `e.key` 同样是 `"Enter"`**。于是：

- `keydown` → 发送
- `keyup`   → 又发送一次

> `preventDefault()` 能取消 `keypress`，但**取消不了 `keyup`**——`keyup` 一定会发。

事件对象上的去重标志（`e.__bdHandled`）也拦不住：`keydown` 和 `keyup` 是**两个不同的对象**。

修法是在处理器最前面按事件类型过滤：

```js
function handleComposerKey(e) {
  if (e.type !== "keydown") return;   // ← 关键
  ...
}
```

**第二层防护：发送锁**

`sendChat` 内部有 `await checkDsLogin()`，在 await 期间 `cs().sending` 还没置位。此时第二次触发同样能通过 `sending` 检查。所以需要一个**同步**的模块级门闩：

```js
let sendLock = false;

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (sendLock || cs().sending) return;
  sendLock = true;
  try { await sendChatInner(text); }
  finally { sendLock = false; }   // 失败/异常也要开门，否则再也发不出去
}
```

实测四种情形：完整 keydown+keypress+keyup = 1 条；仅 keyup = 0；连按三次 = 1；Shift+Enter = 0。

#### 面板拖动与缩放

面板默认用 CSS 定位（`width:468px`、`height:78vh`、锚定右下角）。用户开始拖动或缩放时，才切换成像素定位，并把结果写进 `chrome.storage.local` 的 `layout:v1`。

**为什么不一开始就用像素**：`78vh` 会跟着窗口高度自适应，一上来就固化成像素反而丢掉了这个好处。所以 `layout === null` 代表「用 CSS 默认」，只有用户真正调过之后才变成具体像素。

拖动时 `layout` 的取值顺序也有讲究：**先把尺寸定死，再收位置**。

```js
// 正确顺序
width  = clamp(L.width);   // 先定尺寸
left   = clamp(L.left, 0, vw - width - 8);   // 再收位置
```

反过来写会出事：位置先被限制在 `vw - 120`，随后尺寸又被最小值顶到 360px，两者叠加就把面板推出了视口右边——实测 560px 宽的视口下，面板右边缘跑到了 666px。

**三个容易踩的点**：

1. **`max-height` 会把内联 `height` 压回去**
   CSS 里写着 `max-height: 760px`，直接设 `style.height = "802px"` 不生效，因为 `max-height` 是独立属性。自定义尺寸时要一并解除：

   ```js
   panel.style.maxWidth = "none";
   panel.style.maxHeight = "none";
   panel.style.minHeight = "0";
   ```

   复位时记得清空，否则默认态就再也回不到 78vh。

2. **`getBoundingClientRect()` 读到的是变换后的尺寸**
   开合动画 `panelIn` 带 `transform: scale(.985)`。如果动画被冻结（后台标签页会这样），`rect.width` 会返回 461 而不是 468——存进去的尺寸就少了 7px。所以宽高用 `offsetWidth/offsetHeight`（不受 transform 影响），只有位置用 `rect`。

3. **`Emulation.setDeviceMetricsOverride` 不派发 `resize`**
   这只影响自动化测试。但也提醒了一件事：面板每次展开都应该重新 `clampLayout`，因为窗口可能在收起期间变小了（拔掉外接显示器、改系统缩放）。所以 `applyLayout()` 里有一句 `layout = clampLayout(layout)`。

拖动用的是 pointer events，并在捕获阶段 `preventDefault + stopPropagation`——否则 B站播放器会同时收到这次按下，拖面板的过程中视频进度条也跟着动。

#### 胶囊（收起态按钮）的拖动

胶囊既是按钮又要能拖，就得区分「点击」和「拖动」：

- `pointerdown` 时**不能** `preventDefault`——否则 `click` 根本不会触发，面板就打不开了
- 位移超过 4px 才认定为拖动，否则算点击（容忍手抖）
- 拖动结束后，浏览器仍会补发一个 `click`，必须在捕获阶段吞掉：

```js
els.pill.addEventListener("click", (e) => {
  if (!pillJustDragged) return;
  e.stopImmediatePropagation();   // 拦在 shadow root 的代理监听之前
  e.preventDefault();
}, true);
```

否则「把按钮拖走」会被当成「点了一下」，面板立刻弹出来，根本拖不动。

**面板跟随胶囊**：从拖走的胶囊打开面板时，面板要以右下角对齐胶囊的位置长出来——

```js
layout = clampLayout({
  left: pillRect.right - w,
  top:  pillRect.bottom - h,
  width: w, height: h,
});
```

不这么做的话，用户把按钮拖到左上角、点开却在右下角弹面板，拖按钮这件事就白做了。默认态本来就是「胶囊在右下角、面板盖在它上方」，这个公式在默认位置下算出来正好是原来的位置，两种状态一致。

胶囊的位置单独存在 `pill:v1`，和面板的 `layout:v1` 互不影响——面板拖到别处不该把按钮也带走。

#### 输入框按键与中文输入法

```js
let composingUntil = 0;
els.chatInput.addEventListener("compositionstart", () => { composingUntil = Infinity; });
els.chatInput.addEventListener("compositionend", () => { composingUntil = Date.now() + 60; });

els.chatInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;        // 换行组合键放行
  if (e.isComposing || e.keyCode === 229 ||                // 三道防线
      Date.now() < composingUntil) return;
  e.preventDefault();
  sendChat();
});
```

三道防线缺一不可：

| 防线 | 拦的是什么 |
|---|---|
| `e.isComposing` | 标准属性，组字中为 `true` |
| `keyCode === 229` | 部分输入法/浏览器在组字中固定报 229 |
| `composingUntil` 静默期 | `compositionend` 与 `keydown` 的时序不可靠，某些输入法确认候选词后仍会补发一个 Enter |

没有第三道的话，用户打完拼音按回车选词，会**把半句话发出去**——这是中文场景下最容易漏掉的 bug。

### 3.4 设置页 `extension/options.html/js`

管理两个登录态 + 字幕诊断：

- **B站**：展示登录状态（以接口为准）
- **DeepSeek**：登录/同步、手动粘贴 token、清除
- **字幕测试**：输入任意 B站链接，走完整链路并打印 cid / 时长 / 轨道 / 条数 / 首末句

---

## 四、关键设计取舍汇总

| 取舍 | 选择 | 放弃的方案 | 原因 |
|---|---|---|---|
| 部署形态 | 纯扩展 | 扩展 + Python 后端 | 后端只增加部署成本，所有请求浏览器都能直接发 |
| 无字幕时的兜底 | 提示「无字幕」 | 本地 Whisper 转写 | 转写要几分钟、占几 GB 模型，且大多数热门视频已有 AI 字幕 |
| 大模型接入 | DeepSeek 网页协议 | 官方 API | 不需要 key、不花钱，复用用户已有登录态 |
| 流式传输 | long-lived port | sendMessage | SW 会休眠，长连接能承载流且能感知断开 |
| 面板位置 | 页内 Shadow DOM | 独立窗口 / 弹窗 | 不遮挡视频、随页面切换自动跟随、样式完全隔离 |
| 字幕缓存 | 6 小时 | 不缓存 | B站串号是随机的，缓存保证同一视频结果稳定 |

---

## 五、已知限制

1. **必须有 B站 AI 字幕**。B站没生成字幕的视频，扩展无能为力（已去掉转写功能）。
2. **DeepSeek 协议可能失效**。这是逆向实现，DeepSeek 前端改版（尤其是 PoW 算法或 SSE 格式）会导致失效，需要重新分析。
3. **登录态不跨浏览器**。扩展只能读它所在浏览器的登录状态。
4. **超长字幕会截断**。总结限制 40000 字符、聊天 30000 字符，超出部分丢弃并在 prompt 里注明。
5. **单次 PoW 可能较慢**。`difficulty` 由服务端决定，极端情况下求解需要几秒（有 `setTimeout(0)` 让出主线程，不会卡死 UI，但会慢）。

---

## 六、调试技巧

| 问题 | 怎么查 |
|---|---|
| 面板不出现 | 看页面控制台有没有 `SyntaxError`（多半是误用了 import） |
| 字幕拿不到 | 设置页「字幕测试」输入链接，能直接看出是没登录、没字幕还是别的问题 |
| DeepSeek 报错 | Service Worker 控制台（`chrome://extensions` → 该扩展 → 「检查视图 service worker」） |
| PoW 求解失败 | 大概率是算法实现与线上不一致，用真实挑战反算验证 |
| 登录态读不到 | 注意 `chrome.cookies` 可能返回 0，以 `nav` 接口的 `isLogin` 为准 |
