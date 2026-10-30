// Service Worker：扩展里唯一可以跨站、带登录态发请求的地方。
//
// ⚠️ 关键架构约束（实测得出）：字幕的**获取与下载都必须在 worker 里做**。
//   aisubtitle.hdslb.com 不返回 CORS 头，在 content script（页面上下文）里
//   fetch 会直接 `TypeError: Failed to fetch`（已验证）。
//   扩展的 host_permissions 授予了该域，worker 中的请求不受同源策略限制。
//
// 因此：content script 只负责 UI，所有网络与校验都在这里完成。

import {
  getSubtitlesForUrl,
  parseVideoUrl,
  fetchVideoInfo,
  setCookieHeader,
} from "./lib/subtitle.js";
import { DeepSeekClient, decodeJwtPayload, isTokenUsable } from "./lib/deepseek.js";

// 成功的字幕缓存 6 小时；B站串号是随机的，缓存能避免反复碰运气
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 登录态
//
// ⚠️ 用 `{domain:"bilibili.com"}` 是不够可靠的：Chrome 的 domain 过滤按
//    cookie 的 host 精确匹配，而 SESSDATA 实际存放在 `.bilibili.com`（带前导点，
//    表示对所有子域生效）。实测这种写法有时拿到 0 个 cookie，于是「明明登录了
//    却提示未登录」。
//
//    改用 `{url:...}` 过滤：它按「这个 URL 请求时会带上哪些 cookie」来匹配，
//    语义正是我们需要的。再叠加多个子域取并集，确保不漏。
// ---------------------------------------------------------------------------

const COOKIE_URLS = [
  "https://www.bilibili.com",
  "https://api.bilibili.com",
  "https://space.bilibili.com",
  "https://passport.bilibili.com",
];

/** 拿 B站所有相关 cookie（去重合并多个子域的结果） */
async function getAllBiliCookies() {
  const seen = new Map();
  for (const url of COOKIE_URLS) {
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list) seen.set(`${c.name}@${c.domain}@${c.path}`, c);
    } catch {
      // 单个 url 失败不影响其它
    }
  }
  // 兜底：再按 domain 取一次（有些 cookie 的 path 特殊）
  for (const domain of ["bilibili.com", ".bilibili.com"]) {
    try {
      const list = await chrome.cookies.getAll({ domain });
      for (const c of list) seen.set(`${c.name}@${c.domain}@${c.path}`, c);
    } catch {}
  }
  return [...seen.values()];
}

async function getBiliCookieHeader() {
  const cookies = await getAllBiliCookies();
  if (!cookies.length) return "";
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * 登录检测。
 *
 * ⚠️ 判定依据是 **B站接口**，不是 `chrome.cookies`。
 *
 * 原因（实测）：`chrome.cookies.getAll()` 在部分环境下会返回 0 个 cookie，
 * 即便网络层明明带着登录态。典型例子是用 CDP/自动化方式启动的 Chrome profile：
 *   实测结果 → chrome.cookies.getAll({}) === 0
 *              fetch(nav, {credentials:"include"}) → isLogin: true, uname: "某某用户"
 * 如果拿 cookie 数量当判定依据，就会出现「明明登录了却提示未登录」。
 *
 * 所以流程是：
 *   1. 直接问 `x/web-interface/nav`，`data.isLogin` 才是权威结论；
 *   2. `chrome.cookies` 只用来补充 UID 之类的展示信息，读不到也不影响判断；
 *   3. 接口请求本身失败（断网）时才降级：读得到 cookie 就认为已登录，
 *      读不到则报 unknown（不武断地说「未登录」，避免误导用户）。
 */
async function checkLogin() {
  // 先试接口（权威）
  try {
    const resp = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      headers: { Accept: "application/json" },
      referrer: "https://www.bilibili.com/",
    });
    const data = await resp.json();
    const d = data.data || {};
    // cookie 读得到就顺便带上数量，读不到也不影响结论
    let count = 0;
    let hasSessdata = false;
    try {
      const cookies = await getAllBiliCookies();
      count = cookies.length;
      hasSessdata = cookies.some((c) => c.name === "SESSDATA" && c.value);
    } catch {}

    if (d.isLogin) {
      return {
        loggedIn: true,
        uid: String(d.mid || ""),
        uname: d.uname || "",
        count,
        hasSessdata,
        reason: "ok",
      };
    }
    // code === -101 表示「账号未登录」
    return {
      loggedIn: false,
      uid: "",
      uname: "",
      count,
      hasSessdata,
      reason: count === 0 && !hasSessdata ? "no-cookie" : `api:${data.code}`,
    };
  } catch (e) {
    // 网络失败：降级用 cookie 判断，但不武断下结论
    let count = 0;
    let hasSessdata = false;
    try {
      const cookies = await getAllBiliCookies();
      count = cookies.length;
      hasSessdata = cookies.some((c) => c.name === "SESSDATA" && c.value);
    } catch {}
    return {
      loggedIn: hasSessdata,
      uid: "",
      uname: "",
      count,
      hasSessdata,
      reason: hasSessdata ? "network" : "unknown",
    };
  }
}

/** 在 worker 里获取字幕（带登录态、无 CORS 限制） */
async function doGetSubtitles(url) {
  // 显式把 Cookie 交给 lib 层。
  // 注意：读不到 cookie 时 setCookieHeader("") 会让 lib 层只靠
  // credentials:"include"（实测同样能拿到登录态），所以这里不需要特殊处理。
  setCookieHeader(await getBiliCookieHeader());
  const login = await checkLogin();
  const result = await getSubtitlesForUrl(url);
  return { ...result, login };
}

/** 同一视频的并发去重，防止多个 content script 同时请求 */
const inflight = new Map();

/** 从 url 提取稳定缓存键（避免 ?p=1 与无参数的差异） */
function cacheKey(url) {
  const { bvid, page } = parseVideoUrl(url);
  return bvid ? `sub:v1:${bvid}:p${page}` : null;
}

/**
 * 带整轮重试的获取。
 *
 * 为什么需要两层重试：单次 getSubtitlesForUrl 内部已有 12 次快速重试，
 * 但实测偶尔会连续命中串号分片、耗尽 15 秒预算。
 * 此时隔一小段时间再整轮重试，命中率显著提升（服务端多副本分片会轮换）。
 */
async function doGetSubtitlesWithRetry(url, rounds = 2, onLog) {
  let last = null;
  for (let i = 0; i < rounds; i++) {
    last = await doGetSubtitles(url);
    if (last.ok) return last;
    // 只有「没字幕」值得重试；链接错误之类重试无意义
    if (last.reason !== "no-subtitle") return last;
    if (i < rounds - 1) {
      if (onLog) onLog(`第 ${i + 1} 轮未命中，稍后重试…`);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return last;
}

async function getSubtitlesCached(url, force = false) {
  const key = cacheKey(url);
  if (!force && key) {
    const got = await chrome.storage.local.get(key);
    const entry = got[key];
    if (entry && entry.data && entry.data.ok && Date.now() - entry.ts < CACHE_TTL_MS) {
      return { ...entry.data, fromCache: true };
    }
  }
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    const data = await doGetSubtitlesWithRetry(url);
    if (data.ok && key) {
      await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
    }
    return data;
  })();

  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

/** 清理字幕缓存（设置页用） */
async function clearSubtitleCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("sub:"));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

// ---------------------------------------------------------------------------
// DeepSeek 登录态
//
// token 存在 chat.deepseek.com 的 localStorage.userToken 里。
// worker 读不到别的域的 localStorage，所以有两种取法：
//   1. 用 chrome.scripting 往 chat.deepseek.com 的标签页里注入函数读取（MAIN world）
//   2. 用户在设置页手动粘贴
// 拿到后缓存在 chrome.storage.local，失效时再走一次流程。
// ---------------------------------------------------------------------------

const DS_ORIGIN = "https://chat.deepseek.com";

async function findDeepSeekTab() {
  const tabs = await chrome.tabs.query({ url: DS_ORIGIN + "/*" });
  return tabs.length ? tabs[0] : null;
}

/** 往 chat.deepseek.com 标签页注入脚本读 localStorage（必须 MAIN world） */
async function readTokenFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN", // localStorage 属于页面，同源才能读
      func: () => {
        const out = { token: null, key: null, user: null };
        try {
          const bag = ["userToken"];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && /token/i.test(k) && !bag.includes(k)) bag.push(k);
          }
          for (const k of bag) {
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            let v = raw;
            try {
              const j = JSON.parse(raw);
              if (j && typeof j === "object") v = j.value || j.token || v;
            } catch {}
            if (typeof v === "string" && v.trim()) {
              out.token = v;
              out.key = k;
              break;
            }
          }
        } catch {}
        try {
          const raw = localStorage.getItem("__appKit_userInfo");
          if (raw) {
            const j = JSON.parse(raw);
            out.user = j && j.value ? j.value : j;
          }
        } catch {}
        return out;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

/** 校验 token 是否真的可用（只读接口） */
async function verifyDeepSeekToken(token) {
  try {
    const res = await fetch(DS_ORIGIN + "/api/v0/users/current", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "*/*",
        "x-client-platform": "web",
        "x-client-version": "1.0.0",
      },
    });
    const body = await res.json();
    return {
      ok: body.code === 0 && !!body.data,
      code: body.code,
      msg: body.msg,
      data: body.data || null,
    };
  } catch (e) {
    return { ok: false, msg: String(e && e.message) };
  }
}

/**
 * 同步 DeepSeek 登录态。
 * @param {boolean} openLogin 未登录时是否自动打开登录页
 */
async function syncDeepSeek(openLogin = false) {
  const tab = await findDeepSeekTab();

  if (tab) {
    const info = await readTokenFromTab(tab.id);
    if (info && info.token) {
      const auth = {
        token: info.token,
        user: info.user || null,
        syncedAt: Date.now(),
        jwt: decodeJwtPayload(info.token),
      };
      await chrome.storage.local.set({ ds_auth: auth });
      return { ok: true, auth };
    }
  }

  if (openLogin) {
    const url = DS_ORIGIN + "/sign_in";
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      return { ok: false, reason: "opened", tabId: tab.id, msg: "已跳转到登录页" };
    }
    const created = await chrome.tabs.create({ url, active: true });
    return { ok: false, reason: "opened", tabId: created.id, msg: "已打开登录页" };
  }

  return {
    ok: false,
    reason: tab ? "no_token" : "no_tab",
    msg: tab ? "页面里没有找到登录 token" : "没有打开 chat.deepseek.com",
  };
}

async function getDeepSeekAuth() {
  const { ds_auth } = await chrome.storage.local.get("ds_auth");
  if (ds_auth && isTokenUsable(ds_auth.token)) {
    // 顺手验一次，避免拿到过期 token 还以为有效
    const v = await verifyDeepSeekToken(ds_auth.token);
    if (v.ok) {
      return { ...ds_auth, verified: true, user: v.data || ds_auth.user };
    }
  }
  // 尝试从标签页里救一次
  const r = await syncDeepSeek(false);
  return r.ok ? r.auth : null;
}

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "SUBTITLES": {
          const data = await getSubtitlesCached(msg.url, Boolean(msg.force));
          sendResponse({ ok: true, data });
          return;
        }
        case "CLEAR_SUB_CACHE": {
          const n = await clearSubtitleCache();
          sendResponse({ ok: true, data: { removed: n } });
          return;
        }
        case "LOGIN_STATE": {
          sendResponse({ ok: true, data: await checkLogin() });
          return;
        }
        case "VIDEO_INFO": {
          const { bvid, aid } = parseVideoUrl(msg.url);
          const info = await fetchVideoInfo(bvid, aid);
          sendResponse({ ok: true, data: info });
          return;
        }
        case "SERVER_HEALTH": {
          // 纯 JS 版没有本地服务了，保留消息类型以兼容旧 UI
          sendResponse({ ok: false, data: null });
          return;
        }
        case "DS_SYNC": {
          sendResponse({ ok: true, data: await syncDeepSeek(Boolean(msg.open)) });
          return;
        }
        case "DS_AUTH_STATE": {
          const auth = await getDeepSeekAuth();
          sendResponse({
            ok: true,
            data: auth
              ? { loggedIn: true, user: auth.user, syncedAt: auth.syncedAt }
              : { loggedIn: false },
          });
          return;
        }
        case "DS_SET_TOKEN": {
          const tok = String(msg.token || "").trim();
          if (!tok) {
            sendResponse({ ok: false, error: "token 为空" });
            return;
          }
          const v = await verifyDeepSeekToken(tok);
          if (!v.ok) {
            sendResponse({ ok: false, error: `token 无效：${v.msg || v.code}` });
            return;
          }
          const auth = {
            token: tok,
            user: v.data,
            jwt: decodeJwtPayload(tok),
            syncedAt: Date.now(),
            manual: true,
          };
          await chrome.storage.local.set({ ds_auth: auth });
          sendResponse({ ok: true, data: { loggedIn: true, user: v.data } });
          return;
        }
        case "DS_CLEAR": {
          await chrome.storage.local.remove("ds_auth");
          sendResponse({ ok: true });
          return;
        }
        case "OPEN_OPTIONS": {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: e.message || String(e),
        status: e.status || 0,
        offline: !e.status,
      });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// DeepSeek 流式问答
//
// 用 long-lived port 承载：content script 关闭面板或切换视频时请求不会丢，
// 而且能逐字把增量推回 UI。
//
// port 名 "ds_stream"，协议：
//   发 → {type:"start", payload:{
//          prompt, systemPrompt?, chatSessionId?, parentMessageId?,
//          thinking, search, files?:[{name, mimeType, dataUrl}]
//        }}
//   收 ← {type:"delta", text}     正文增量
//        {type:"think", text}     思维链增量（深度思考时）
//        {type:"session", sessionId}
//        {type:"upload", text}    文件上传/解析进度
//        {type:"done", text, thinking, messageId}
//        {type:"error", msg, needLogin}
//
// 关于 systemPrompt：只在该会话的**第一轮**传。后续轮次靠 chat_session_id
// + parent_message_id 维持上下文，重复拼系统提示词既浪费 token 又可能让模型
// 把规则当成用户的新要求重复回应。
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ds_stream") return;

  let aborted = false;
  port.onDisconnect.addListener(() => {
    aborted = true;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "abort") {
      aborted = true;
      return;
    }
    if (msg.type !== "start") return;

    const p = msg.payload || {};
    try {
      const auth = await getDeepSeekAuth();
      if (!auth) {
        port.postMessage({ type: "error", msg: "未登录 DeepSeek", needLogin: true });
        return;
      }

      const client = new DeepSeekClient({ token: auth.token });

      let sessionId = p.chatSessionId;
      if (!sessionId) {
        const s = await client.createSession();
        sessionId = s.chatSessionId;
        port.postMessage({ type: "session", sessionId });
      }

      // 上传附件（如有），必须等解析完成才能引用
      const refFileIds = [];
      const files = Array.isArray(p.files) ? p.files : [];
      for (const f of files) {
        if (aborted) return;
        port.postMessage({ type: "upload", text: `上传 ${f.name}…` });
        const bytes = dataUrlToBytes(f.dataUrl);
        const info = await client.uploadFile(bytes, f.name, f.mimeType);
        port.postMessage({ type: "upload", text: `解析 ${f.name}…` });
        await client.waitFileReady(info.id, {
          onProgress: (status) => {
            if (!aborted) port.postMessage({ type: "upload", text: `解析 ${f.name}… ${status}` });
          },
        });
        refFileIds.push(info.id);
        port.postMessage({ type: "upload", text: `${f.name} ✓` });
      }

      // 系统提示词只拼在第一轮
      const prompt = p.systemPrompt ? `${p.systemPrompt}\n\n---\n\n${p.prompt}` : p.prompt;

      const result = await client.completion({
        prompt,
        chatSessionId: sessionId,
        parentMessageId: p.parentMessageId || null,
        thinkingEnabled: !!p.thinking,
        searchEnabled: !!p.search,
        refFileIds,
        onDelta: (t) => {
          if (!aborted) port.postMessage({ type: "delta", text: t });
        },
        onThink: (t) => {
          if (!aborted) port.postMessage({ type: "think", text: t });
        },
        onToast: (d) => {
          if (!aborted) port.postMessage({ type: "toast", data: d });
        },
      });

      if (!aborted) {
        port.postMessage({
          type: "done",
          text: result.text,
          thinking: result.thinking,
          messageId: result.messageId,
        });
      }
    } catch (e) {
      const msgText = String((e && e.message) || e);
      if (!aborted) {
        port.postMessage({
          type: "error",
          msg: msgText,
          needLogin: msgText === "AUTH_EXPIRED",
        });
      }
    }
  });
});

/** 把 dataUrl 还原成 Uint8Array（content script 传文件用这个格式） */
function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;]*);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("无效的文件数据");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

chrome.runtime.onInstalled.addListener(async () => {
  // 纯 JS 版不再需要本地服务地址
  await chrome.storage.local.remove(["serverBase", "bili"]);
});

// 点击图标：跳到设置页（面板已内嵌在页面里，不再需要独立标签页）
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
