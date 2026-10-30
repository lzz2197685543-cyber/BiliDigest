// 字幕获取核心逻辑：与 server/bili.py 保持完全一致的规则。
//
// 为什么校验必须保留——以下是实测到的 B 站服务端行为，与客户端形态无关：
//   1. 未登录时 subtitle.subtitles 恒为空数组；
//   2. 登录后约 1/3 请求返回轨道但 subtitle_url 为空；
//   3. ⚠️ 约半数请求会返回【别的视频】的字幕（CDN 缓存串号）。
// 第 3 条不会报错，会把无关内容静默当成当前视频，必须靠 cid 校验拦住。

const API_VIEW = "https://api.bilibili.com/x/web-interface/view";
const API_PLAYER = "https://api.bilibili.com/x/player/v2";
// 页面自身使用的接口（带 aid）。实测与上面那个返回同一份字幕文件，
// 但更贴近 B站官方前端行为，因此优先使用。
const API_PLAYER_WBI = "https://api.bilibili.com/x/player/wbi/v2";

export const SUBTITLE_MAX_ATTEMPTS = 12;
export const SUBTITLE_RETRY_DELAY = 350;   // ms
export const SUBTITLE_MAX_MS = 15000;

const BV_RE = /(BV[0-9A-Za-z]{10})/;
const AV_RE = /av(\d+)/i;

// ---------------------------------------------------------------------------
// 链接解析
// ---------------------------------------------------------------------------

export function parseVideoUrl(raw) {
  const url = String(raw || "").trim();
  const m = BV_RE.exec(url);
  let bvid = m ? m[1] : null;
  let aid = null;
  if (!bvid) {
    const m2 = AV_RE.exec(url);
    if (m2) aid = Number(m2[1]);
  }
  let page = 1;
  try {
    const p = new URL(url, "https://www.bilibili.com").searchParams.get("p");
    if (p) page = Math.max(1, Number(p) || 1);
  } catch {
    page = 1;
  }
  return { bvid, aid, page };
}

// ---------------------------------------------------------------------------
// 校验：这几条是整个模块的核心，不可删
// ---------------------------------------------------------------------------

/**
 * 字幕 URL 是否属于该 cid。
 * 实测正确 URL 形如：
 *   //aisubtitle.hdslb.com/bfs/ai_subtitle/prod/8910235<cid>c249d...?auth_key=...
 * 方向：正确 URL 的 path 里一定嵌着 cid；串号 URL 里没有。
 */
export function subtitleUrlMatchesCid(url, cid) {
  if (!cid) return false;
  let path;
  try {
    const abs = url.startsWith("//") ? `https:${url}` : url;
    path = new URL(abs).pathname;
  } catch {
    return false;
  }
  return path.includes(String(cid));
}

/**
 * 判断轨道是否为中文。
 *
 * B站 lan 字段的真实取值：`zh-CN`（人工）、`ai-zh`（AI 生成的中文）。
 * 注意 `ai-zh` 里的 "ai" 是「AI 生成」前缀，不是语言代码的一部分，
 * 所以不能简单用 lan.includes("ai") 判断语言，也不能据此判断语种。
 */
function isChineseLang(lan) {
  const s = String(lan || "").toLowerCase();
  // 去掉 ai- 前缀后再判断语种：ai-zh → zh
  const bare = s.replace(/^ai-/, "");
  return bare.startsWith("zh") || bare.includes("-zh") || bare === "zh";
}

/**
 * 轨道打分：优先中文，其次人工 CC 优于 AI 字幕。
 *
 * 权重设计（这里踩过坑，务必保持量级）：
 *   语言权重必须**远大于** AI/人工权重，否则会出现
 *   「英文人工 > 中文AI」这种对中文视频明显错误的结果。
 *
 *     中文 +1000
 *     人工CC +100（AI 字幕 −50）
 *
 *   → 中文人工 1100 > 中文AI 950 >> 英文人工 100 > 英文AI 50
 */
export function scoreTrack(track) {
  const lan = String(track?.lan || "").toLowerCase();
  const aiType = track?.ai_type;
  const isAi =
    lan.startsWith("ai-") ||
    !(aiType === null || aiType === undefined || aiType === 0 || aiType === "0");
  let v = 0;
  if (isChineseLang(lan)) v += 1000;
  v += isAi ? -50 : 100;
  return v;
}

export function pickBestTrack(tracks) {
  if (!tracks || !tracks.length) return null;
  return [...tracks].sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
}

/**
 * 校验字幕时间跨度是否与视频时长吻合（兜底，防止 cid 恰好撞上）。
 * 允许误差：时长 ×1.15 + 30 秒。
 */
export function validateCues(cues, durationSec) {
  if (!cues || !cues.length) return false;
  if (!durationSec) return true;
  const span = Math.max(...cues.map((c) => Number(c.end) || 0));
  return span <= durationSec * 1.15 + 30;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可选的显式 Cookie 头（由 background 注入）。
// 正常情况下 credentials:"include" 就够了（host_permissions 已授权），
// 但某些 Chrome 版本对 SW 里的 include 处理不一致，显式带上更稳。
let explicitCookie = "";
export function setCookieHeader(cookie) {
  explicitCookie = String(cookie || "");
}

async function getJson(url, referer) {
  const headers = { Accept: "application/json, text/plain, */*" };
  if (explicitCookie) headers.Cookie = explicitCookie;
  const resp = await fetch(url, {
    credentials: "include",
    headers,
    referrer: referer || "https://www.bilibili.com/",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`code=${data.code} ${data.message || ""}`);
  return data.data || {};
}

export async function fetchVideoInfo(bvid, aid) {
  const key = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const d = await getJson(`${API_VIEW}?${key}`);
  const pages = (d.pages || []).map((p, i) => ({
    index: Number(p.page) || i + 1,
    cid: Number(p.cid),
    part: p.part || `P${i + 1}`,
    duration: Number(p.duration) || 0,
  }));
  if (!pages.length && d.cid) {
    pages.push({ index: 1, cid: Number(d.cid), part: d.title || "正片", duration: Number(d.duration) || 0 });
  }
  return {
    bvid: d.bvid || bvid,
    aid: Number(d.aid) || 0,
    title: d.title || "",
    owner: d.owner?.name || "",
    duration: Number(d.duration) || 0,
    cover: d.pic || "",
    pages,
  };
}

/**
 * 拉取字幕轨道：重试 + cid 校验 + 空数组退避。
 * 规则与 server/bili.py 的 fetch_subtitles 完全一致。
 *
 * 接口选择（实测对比见 ARCHITECTURE.md）：
 *   页面自身用的是 `x/player/wbi/v2`（带 aid），我们优先用它；
 *   `x/player/v2`（带 bvid）作为兜底 —— 两者返回的 subtitle_url 路径相同。
 *   wbi 签名（w_rid/wts）对这个接口不是必需的，未签名实测同样 code=0。
 */
export async function fetchSubtitleTracks(bvid, cid, onLog, aid) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const clean = [];
  const seen = new Set();
  let dropped = 0;
  let deadEnd = 0;
  const deadline = Date.now() + SUBTITLE_MAX_MS;

  // 两个接口轮换，避免单个接口的分片问题持续命中
  const endpoints = [];
  if (aid) endpoints.push(`${API_PLAYER_WBI}?aid=${aid}&cid=${cid}`);
  endpoints.push(`${API_PLAYER}?bvid=${bvid}&cid=${cid}`);

  for (let attempt = 0; attempt < SUBTITLE_MAX_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) {
      log(`超过 ${SUBTITLE_MAX_MS / 1000}s 预算，放弃字幕路径`);
      break;
    }
    const api = endpoints[attempt % endpoints.length];
    let data;
    try {
      data = await getJson(api, `https://www.bilibili.com/video/${bvid}`);
    } catch (e) {
      log(`接口失败: ${e.message}`);
      // 某个接口持续失败时不要立刻放弃，换另一个再试
      if (attempt + 1 >= SUBTITLE_MAX_ATTEMPTS) return [];
      continue;
    }

    const tracks = (data.subtitle && data.subtitle.subtitles) || [];
    let gotWrong = false;
    for (const t of tracks) {
      const url = String(t.subtitle_url || "").trim();
      if (!url) continue;
      if (!subtitleUrlMatchesCid(url, cid)) {
        // 缓存串号：属于别的视频，丢弃
        dropped += 1;
        gotWrong = true;
        continue;
      }
      const key = String(t.id_str || t.id || url);
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(t);
    }

    if (clean.length) break;

    if (gotWrong) {
      // 正确缓存存在，只是本次分片错了：立即重试
      deadEnd = 0;
      continue;
    }
    deadEnd += 1;
    await sleep(SUBTITLE_RETRY_DELAY * deadEnd);
  }

  if (dropped) {
    log(`丢弃 ${dropped} 个不匹配轨道（CDN 串号），${clean.length ? "命中" : "未命中"} cid=${cid}`);
  }
  return clean;
}

/** 下载字幕 JSON，返回 [{start,end,text}]。
 *
 * ⚠️ 必须运行在 Service Worker（background）里，不能在 content script 里调：
 * aisubtitle.hdslb.com 不返回 CORS 头，页面发起 fetch 会直接 TypeError: Failed to fetch。
 * 扩展的 host_permissions 授予了该域，worker 里的请求不受此限制。
 */
export async function downloadSubtitle(subUrl) {
  let url = subUrl;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("http://")) url = `https${url.slice(4)}`;

  // 字幕文件本身不校验 Cookie（实测），但带上不会有副作用，
  // 也避免某些 CDN 节点对匿名请求限流。
  const headers = { Accept: "*/*" };
  if (explicitCookie) headers.Cookie = explicitCookie;

  const resp = await fetch(url, {
    credentials: "include",
    headers,
    referrer: "https://www.bilibili.com/",
  });
  if (!resp.ok) throw new Error(`字幕下载失败 HTTP ${resp.status}`);
  const payload = await resp.json();
  const body = payload.body || [];
  const cues = [];
  for (const it of body) {
    const text = String(it.content || "").trim();
    if (!text) continue;
    cues.push({ start: Number(it.from) || 0, end: Number(it.to) || 0, text });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// 一次性完成：解析 → 取轨道 → 校验 → 下载 → 校验时长
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:boolean, reason?:string, info?:object, page?:object, cues?:Array, track?:object}}
 */
export async function getSubtitlesForUrl(rawUrl, onProgress) {
  const prog = typeof onProgress === "function" ? onProgress : () => {};
  const { bvid, aid, page } = parseVideoUrl(rawUrl);
  if (!bvid && !aid) return { ok: false, reason: "链接中没有识别到 BV 号或 av 号" };

  prog("解析视频信息…");
  let info;
  try {
    info = await fetchVideoInfo(bvid, aid);
  } catch (e) {
    return { ok: false, reason: `视频信息获取失败：${e.message}` };
  }

  const pageInfo = info.pages.find((p) => p.index === page) || info.pages[0];
  if (!pageInfo) return { ok: false, reason: "没有找到分P信息", info };

  prog("检查字幕…");
  // 注意传 info.aid：wbi 接口用 aid，view 接口返回的 aid 比 URL 里更可靠
  const tracks = await fetchSubtitleTracks(info.bvid, pageInfo.cid, prog, info.aid);
  if (!tracks.length) {
    return {
      ok: false,
      reason: "no-subtitle",
      info,
      page: pageInfo,
    };
  }

  const track = pickBestTrack(tracks);
  prog("下载字幕…");
  let cues;
  try {
    cues = await downloadSubtitle(track.subtitle_url);
  } catch (e) {
    return { ok: false, reason: `字幕下载失败：${e.message}`, info, page: pageInfo };
  }

  if (!validateCues(cues, pageInfo.duration)) {
    // 即便 URL 带 cid，也再校验一次时间跨度
    return { ok: false, reason: "字幕与视频时长不符，已丢弃", info, page: pageInfo };
  }

  return { ok: true, info, page: pageInfo, cues, track };
}

// ---------------------------------------------------------------------------
// 输出格式
// ---------------------------------------------------------------------------

export function cuesToText(cues) {
  return cues.map((c) => c.text).join("\n");
}

function fmtTs(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
}

export function cuesToSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${fmtTs(c.start).replace(".", ",")} --> ${fmtTs(c.end).replace(".", ",")}\n${c.text}\n`)
    .join("\n");
}

/** 时间戳标签，用于面板里显示 [00:12] */
export function fmtClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function safeName(s) {
  return String(s || "video").replace(/[\\/:*?"<>|\n\r]/g, "_").slice(0, 80);
}
