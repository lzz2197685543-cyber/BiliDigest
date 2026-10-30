const $ = (id) => document.getElementById(id);

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

/* ---------------- B站登录（只读展示） ---------------- */

async function refreshBiliLogin() {
  const r = await send("LOGIN_STATE");
  if (!r.ok) {
    $("loginBox").innerHTML = `<span class="bad">无法检测：${r.error || ""}</span>`;
    return;
  }
  const d = r.data;
  if (d.loggedIn) {
    $("loginBox").innerHTML =
      `<span class="ok">已登录</span>` +
      (d.uname ? ` · <b>${d.uname}</b>` : "") +
      ` · UID <code>${d.uid || "?"}</code><br/>` +
      `<span class="hint" style="margin-top:6px">B站 AI 字幕可直接获取。</span>`;
    return;
  }
  $("loginBox").innerHTML =
    `<span class="bad">未登录</span> · 字幕接口会返回空数组<br/>` +
    `<span class="hint" style="margin-top:6px">请在<b>本浏览器</b>登录 bilibili.com，然后点「刷新」。</span>`;
}

/* ---------------- DeepSeek 登录 ---------------- */

async function refreshDsLogin() {
  const r = await send("DS_AUTH_STATE");
  if (!r.ok) {
    $("dsBox").innerHTML = `<span class="bad">无法检测：${r.error || ""}</span>`;
    return;
  }
  const d = r.data;
  if (d.loggedIn) {
    const u = d.user || {};
    const who = u.email || u.mobile_number || u.name || "已登录用户";
    $("dsBox").innerHTML =
      `<span class="ok">已登录</span> · ${escapeHtml(who)}<br/>` +
      `<span class="hint" style="margin-top:6px">` +
      `token 同步于 ${new Date(d.syncedAt).toLocaleString("zh-CN")}。` +
      `总结与聊天可直接使用。</span>`;
    return;
  }
  $("dsBox").innerHTML =
    `<span class="bad">未登录</span><br/>` +
    `<span class="hint" style="margin-top:6px">` +
    `点下面的按钮会打开 chat.deepseek.com 登录页，登录后 token 会自动保存。</span>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function syncDs() {
  $("dsBox").textContent = "读取中…";
  const r = await send("DS_SYNC", { open: true });
  const d = r.data || {};
  if (d.ok) {
    await refreshDsLogin();
    $("dsOut").textContent = "登录态已保存。";
    return;
  }
  if (d.reason === "opened") {
    $("dsBox").innerHTML =
      `<span class="bad">等待登录</span><br/>` +
      `<span class="hint" style="margin-top:6px">` +
      `已打开登录页。完成登录后回到本页，点「我已完成登录」。</span>`;
    $("dsOut").textContent = "登录页已打开";
    return;
  }
  await refreshDsLogin();
  $("dsOut").textContent = d.msg || "未获取到 token";
}

async function recheckDs() {
  const r = await send("DS_SYNC", {});
  const d = r.data || {};
  await refreshDsLogin();
  $("dsOut").textContent = d.ok ? "登录成功" : d.msg || "仍未读到 token，请确认已在登录页完成登录";
}

/* ---------------- 字幕缓存 ---------------- */

async function refreshCache() {
  const all = await chrome.storage.local.get(null);
  const n = Object.keys(all).filter((k) => k.startsWith("sub:")).length;
  $("cacheBox").textContent = `已缓存 ${n} 个视频的字幕`;
}

/* ---------------- 初始化 ---------------- */

async function init() {
  $("btnRefreshBili").addEventListener("click", refreshBiliLogin);
  $("btnOpenBili").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.bilibili.com/" });
  });

  $("btnSyncDs").addEventListener("click", syncDs);
  $("btnRecheckDs").addEventListener("click", recheckDs);

  $("btnSetToken").addEventListener("click", async () => {
    const tok = ($("dsToken").value || "").trim();
    if (!tok) {
      $("dsOut").textContent = "请先粘贴 token";
      return;
    }
    $("dsOut").textContent = "校验中…";
    const r = await send("DS_SET_TOKEN", { token: tok });
    if (r.ok) {
      $("dsToken").value = "";
      await refreshDsLogin();
      $("dsOut").textContent = "token 校验通过并已保存";
    } else {
      $("dsOut").textContent = `失败：${r.error || "未知错误"}`;
    }
  });

  $("btnClearDs").addEventListener("click", async () => {
    await send("DS_CLEAR");
    await refreshDsLogin();
    $("dsOut").textContent = "已清除 DeepSeek 登录态";
  });

  $("btnClearCache").addEventListener("click", async () => {
    const r = await send("CLEAR_SUB_CACHE");
    if (r.ok) {
      await refreshCache();
      $("cacheBox").textContent += ` · 已清理 ${r.data.removed} 条`;
    }
  });

  $("btnTestSub").addEventListener("click", async () => {
    const url = ($("testUrl").value || "").trim();
    if (!url) {
      $("testOut").textContent = "请先填一个 B站视频链接";
      return;
    }
    $("testOut").textContent = "测试中…";
    const r = await send("SUBTITLES", { url, force: true });
    if (!r.ok) {
      $("testOut").textContent = `失败：${r.error || "未知错误"}`;
      return;
    }
    const d = r.data;
    if (d.ok) {
      $("testOut").textContent =
        `成功\n` +
        `  标题: ${d.info.title}\n` +
        `  cid:  ${d.page.cid} / 时长 ${d.page.duration}s\n` +
        `  轨道: ${d.track.lan} (ai_type=${d.track.ai_type})\n` +
        `  条数: ${d.cues.length}\n` +
        `  首句: ${d.cues[0] ? d.cues[0].text : ""}\n` +
        `  末句: ${d.cues[d.cues.length - 1] ? d.cues[d.cues.length - 1].text : ""}`;
    } else {
      $("testOut").textContent =
        `未取到字幕\n  原因: ${d.reason || "未知"}\n  登录状态: ${d.login && d.login.loggedIn ? "已登录" : "未登录"}`;
    }
  });

  await Promise.all([refreshBiliLogin(), refreshDsLogin(), refreshCache()]);
}

init();
