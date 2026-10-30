/**
 * DeepSeek 协议客户端
 *
 * 逆向自 chat.deepseek.com 的前端：
 *
 * 1. PoW 挑战
 *    POST /api/v0/chat/create_pow_challenge
 *    body: {"target_path": "/api/v0/chat/completion"}
 *
 * 2. PoW 求解（algorithm === "DeepSeekHashV1"）
 *    prefix = `${salt}_${expire_at}_`
 *    answer = 最小的 i 使 sha3_256(prefix + i).hex === challenge
 *
 * 3. 应答头 X-DS-PoW-Response: JSON({algorithm,challenge,salt,answer,signature,target_path})
 *
 * 4. 问答 POST /api/v0/chat/completion (SSE)
 *
 * 5. SSE 事件 ready / delta / finish / title / toast
 *    delta 是 JSON Patch 风格，正文字段用 "RESPONSE"，思维链用 "THINK"
 *
 * ⚠️ 关键坑：DeepSeekHashV1 不是标准 SHA3-256。
 *    前端 worker 的 keccak-f 循环是 for(i=1;i<24;i++)，**跳过第 0 轮**，
 *    所以不能用 crypto.subtle.digest('SHA3-256')，必须用下面这个纯 JS 变体。
 */

export const BASE = "https://chat.deepseek.com";
export const TARGET_PATH = "/api/v0/chat/completion";

/* ------------------------------------------------------------------ */
/* PoW                                                                 */
/* ------------------------------------------------------------------ */

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function base64Encode(str) {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, "utf8").toString("base64");
}

/**
 * Keccak-f[1600] 仅执行第 1..23 轮（跳过标准 Keccak 的第 0 轮 iota）。
 * rate=136, padding=0x06, 输出 32 字节。
 */
function sha3_256_js(bytes) {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];
  const MASK = (1n << 64n) - 1n;
  const rotl = (x, n) => {
    n = BigInt(((n % 64) + 64) % 64);
    return ((x << n) | (x >> (64n - n))) & MASK;
  };

  const rate = 136;
  const msgLen = bytes.length;
  const padLen = rate - (msgLen % rate);
  const total = msgLen + padLen;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[msgLen] ^= 0x06;
  buf[total - 1] ^= 0x80;

  const st = new Array(25).fill(0n);

  for (let off = 0; off < total; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(buf[off + i * 8 + b]);
      st[i] ^= lane;
    }
    for (let round = 1; round < 24; round++) {
      const C = new Array(5);
      for (let x = 0; x < 5; x++)
        C[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) st[x + 5 * y] ^= D;
      }
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(st[x + 5 * y], ROT[x][y]);
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          st[x + 5 * y] =
            B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK & B[((x + 2) % 5) + 5 * y]);
        }
      }
      st[0] ^= RC[round];
    }
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return toHex(out);
}

function sha3_256_hex(str) {
  return sha3_256_js(new TextEncoder().encode(str));
}

/** 求解 PoW。answer 必须是「最小」的匹配值。每 2000 次让出一次事件循环避免卡死。 */
export async function solvePoW(ch, onProgress) {
  if (ch.algorithm !== "DeepSeekHashV1") {
    throw new Error("不支持的 PoW 算法: " + ch.algorithm);
  }
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const target = String(ch.challenge).toLowerCase();
  const diff = Number(ch.difficulty) || 0;
  const t0 = Date.now();

  for (let i = 0; i < diff; i++) {
    if (sha3_256_hex(prefix + i) === target) {
      return {
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        salt: ch.salt,
        answer: i,
        signature: ch.signature,
        target_path: TARGET_PATH,
        _duration_ms: Date.now() - t0,
      };
    }
    if (onProgress && i % 5000 === 0) onProgress(i, diff);
    if (i % 2000 === 1999) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`PoW 无解 (difficulty=${diff})`);
}

/* ------------------------------------------------------------------ */
/* token 工具                                                          */
/* ------------------------------------------------------------------ */

export function decodeJwtPayload(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = p + "===".slice((p.length + 3) % 4);
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)))
    );
  } catch {
    return null;
  }
}

export function isTokenUsable(token) {
  if (!token || typeof token !== "string" || !token.trim()) return false;
  const p = decodeJwtPayload(token);
  if (p && typeof p.exp === "number" && p.exp * 1000 < Date.now()) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

export class DeepSeekClient {
  constructor(opts = {}) {
    this.token = opts.token || "";
    this.clientVersion = opts.clientVersion || "1.0.0";
  }

  baseHeaders() {
    const h = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "x-client-platform": "web",
      "x-client-version": this.clientVersion,
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
      Origin: BASE,
      Referer: BASE + "/",
    };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }

  async createPowChallenge(targetPath = TARGET_PATH) {
    const res = await fetch(BASE + "/api/v0/chat/create_pow_challenge", {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ target_path: targetPath }),
    });
    const body = await res.json();
    if (body.code !== 0) {
      throw new Error(`create_pow_challenge 失败: code=${body.code} msg=${body.msg}`);
    }
    if (body.data.biz_code !== 0) {
      throw new Error(
        `create_pow_challenge biz_code=${body.data.biz_code} biz_msg=${body.data.biz_msg}`
      );
    }
    return body.data.biz_data.challenge;
  }

  async makePowHeader(targetPath = TARGET_PATH, onProgress) {
    const ch = await this.createPowChallenge(targetPath);
    const solved = await solvePoW(ch, onProgress);
    const payload = {
      algorithm: solved.algorithm,
      challenge: solved.challenge,
      salt: solved.salt,
      answer: solved.answer,
      signature: solved.signature,
      target_path: targetPath,
    };
    return { header: "X-DS-PoW-Response", value: base64Encode(JSON.stringify(payload)) };
  }

  /** 创建会话。真正的会话 ID 在 data.biz_data.chat_session.id */
  async createSession() {
    const res = await fetch(BASE + "/api/v0/chat_session/create", {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({}),
    });
    const body = await res.json();
    if (body.code !== 0 || !body.data || !body.data.biz_data) {
      throw new Error(`create_session 失败: code=${body.code} msg=${body.msg}`);
    }
    const biz = body.data.biz_data;
    const session = biz.chat_session || biz;
    return { chatSessionId: session.id, title: session.title || null };
  }

  /**
   * 上传文件。
   *
   * 上传接口同样需要 PoW，但 target_path 是 /api/v0/file/upload_file。
   *
   * ⚠️ 两个坑：
   *   1. 不能手动设 Content-Type，否则会覆盖 fetch 自动生成的 multipart boundary，
   *      导致服务端解析失败。
   *   2. 上传成功 ≠ 可以立即提问。文件要经过 PENDING → PARSING → SUCCESS
   *      的解析流程，必须轮询到 SUCCESS 才能作为 ref_file_ids 使用。
   *
   * @returns {Promise<{id:string, name:string, ...}>} biz_data
   */
  async uploadFile(content, fileName, mimeType) {
    const targetPath = "/api/v0/file/upload_file";
    const pow = await this.makePowHeader(targetPath);

    const headers = this.baseHeaders();
    delete headers["Content-Type"]; // 让 fetch 自己带 multipart boundary
    headers[pow.header] = pow.value;

    const blob =
      typeof content === "string"
        ? new Blob([content], { type: mimeType || "text/plain" })
        : new Blob([content], { type: mimeType || "application/octet-stream" });

    const fd = new FormData();
    fd.append("file", blob, fileName);

    const res = await fetch(BASE + targetPath, { method: "POST", headers, body: fd });
    const body = await res.json();
    if (body.code !== 0 || !body.data || body.data.biz_code !== 0) {
      throw new Error(
        `upload_file 失败: code=${body.code} biz_code=${body.data?.biz_code} biz_msg=${body.data?.biz_msg}`
      );
    }
    return body.data.biz_data;
  }

  /**
   * 轮询文件解析状态直到 SUCCESS。
   * 状态机：PENDING → PARSING → SUCCESS | FAILED | CONTENT_FILTER | CONTENT_TOO_LONG | ...
   */
  async waitFileReady(fileId, opts = {}) {
    const intervalMs = opts.intervalMs || 1000;
    const maxTries = opts.maxTries || 40;
    const failed = new Set([
      "FAILED",
      "CONTENT_FILTER",
      "CONTENT_TOO_LONG",
      "CANCELLED",
      "CONTENT_EMPTY",
    ]);

    for (let i = 0; i < maxTries; i++) {
      const res = await fetch(
        `${BASE}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { method: "GET", headers: this.baseHeaders() }
      );
      const body = await res.json();
      const file = body.data?.biz_data?.files?.[0];
      if (file && file.status === "SUCCESS") return file;
      if (file && failed.has(file.status)) {
        throw new Error(`文件解析失败: status=${file.status} code=${file.error_code || ""}`);
      }
      if (opts.onProgress) opts.onProgress(file?.status || "PENDING", i);
      if (i < maxTries - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("文件解析超时");
  }

  /**
   * 流式问答。
   *
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.chatSessionId]
   * @param {string|null} [p.parentMessageId]  多轮上下文，传上一轮 ready 事件给的 response_message_id
   * @param {boolean} [p.thinkingEnabled]      深度思考（R1 式推理）
   * @param {boolean} [p.searchEnabled]        联网搜索
   * @param {string[]} [p.refFileIds]          引用的已上传文件 id
   * @param {(t:string)=>void} [p.onDelta]
   * @param {(t:string)=>void} [p.onThink]
   * @param {AbortSignal} [p.signal]
   */
  async completion(p) {
    const body = {
      chat_session_id: p.chatSessionId || null,
      parent_message_id: p.parentMessageId || null,
      model_type: p.modelType || "default",
      prompt: p.prompt,
      ref_file_ids: Array.isArray(p.refFileIds) ? p.refFileIds : [],
      thinking_enabled: !!p.thinkingEnabled,
      search_enabled: !!p.searchEnabled,
      action: null,
      preempt: false,
    };

    const pow = await this.makePowHeader(TARGET_PATH, p.onPowProgress);
    const res = await fetch(BASE + TARGET_PATH, {
      method: "POST",
      headers: {
        ...this.baseHeaders(),
        Accept: "text/event-stream",
        [pow.header]: pow.value,
      },
      body: JSON.stringify(body),
      signal: p.signal,
    });

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const txt = await res.text();
      // 401/403 通常意味着 token 失效
      if (res.status === 401 || res.status === 403) {
        throw new Error("AUTH_EXPIRED");
      }
      throw new Error(`非 SSE 响应 status=${res.status} body=${txt.slice(0, 200)}`);
    }

    return this._consumeSSE(res, p);
  }

  async _consumeSSE(res, p) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let thinking = "";
    let messageId = null;

    const handleEvent = (evName, dataStr) => {
      let data = null;
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }

      const emit = (t) => {
        if (p.onDelta) p.onDelta(t);
        text += t;
      };
      const emitThink = (t) => {
        if (p.onThink) p.onThink(t);
        thinking += t;
      };

      if (evName === "ready") {
        if (data && data.response_message_id) messageId = data.response_message_id;
        return;
      }
      if (evName === "toast") {
        if (p.onToast) p.onToast(data);
        return;
      }
      if (evName === "title") {
        if (data && data.content && p.onTitle) p.onTitle(data.content);
        return;
      }
      if (evName === "finish") return;

      // 正文增量：DeepSeek 用空 event 名，data 形如
      //   {p:"response/fragments/-1/content", o:"APPEND", v:"..."}
      if (data && typeof data === "object") {
        const v = data.v !== undefined ? data.v : data.value;
        const path = String(data.p || data.path || "");
        if (typeof v === "string") {
          if (path.includes("THINK")) emitThink(v);
          else if (path.includes("token_usage") || path.includes("status")) return;
          else emit(v);
        } else if (Array.isArray(data)) {
          for (const pt of data) {
            if (!pt || typeof pt !== "object") continue;
            const pv = pt.v !== undefined ? pt.v : pt.value;
            const pp = String(pt.p || pt.path || "");
            if (typeof pv === "string") {
              if (pp.includes("THINK")) emitThink(pv);
              else if (!pp.includes("token_usage") && !pp.includes("status")) emit(pv);
            }
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        if (!block.trim()) continue;

        let evName = "";
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) evName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        const dataStr = dataLines.join("\n");
        if (!evName && !dataStr) continue;
        handleEvent(evName, dataStr);
      }
    }

    return { text, thinking, messageId };
  }
}

/* ------------------------------------------------------------------ */
/* 从页面 localStorage 读 token                                        */
/* ------------------------------------------------------------------ */

/** 在 chat.deepseek.com 页面的 MAIN world 里执行，读出 userToken */
export function readTokenFromPage() {
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
}
