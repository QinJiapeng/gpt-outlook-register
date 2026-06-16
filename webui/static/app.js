// 团子喵的 WebUI 交互逻辑 ~

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ──────────────────────── 工具 ────────────────────────

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || resp.statusText);
  return data;
}

function fmtTime(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

function logLine(text, kind = "") {
  const box = $("#logBox");
  const div = document.createElement("div");
  div.className = "line " + kind;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function classifyLog(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("失败") || l.includes("拒绝")) return "err";
  if (l.includes("warning") || l.includes("warn")) return "warn";
  if (l.includes("成功") || l.includes("完成") || l.includes("命中") || l.includes("ok")) return "ok";
  return "";
}

// ──────────────────────── 统计栏 ────────────────────────

async function refreshStats() {
  try {
    const { stats } = await api("/api/stats");
    const items = [
      { v: stats.total,     cls: "" },
      { v: stats.available, cls: "ok" },
      { v: stats.in_use,    cls: "warn" },
      { v: stats.done,      cls: "done" },
      { v: stats.failed,    cls: "bad" },
    ];
    $$("#statsBar .pill").forEach((el, i) => {
      el.querySelector("b").textContent = items[i].v;
    });
  } catch (e) {
    console.error("stats:", e);
  }
}

// ──────────────────────── 导入 ────────────────────────

$("#btnImport").addEventListener("click", async () => {
  const text = $("#importText").value.trim();
  if (!text) {
    $("#importResult").textContent = "请输入要导入的接码号";
    return;
  }
  $("#btnImport").disabled = true;
  $("#importResult").textContent = "导入中...";
  try {
    const r = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    $("#importResult").textContent =
      `✅ 解析 ${r.parsed} 行，新增 ${r.inserted}，更新 ${r.updated}，跳过 ${r.skipped}`;
    $("#importResult").className = "result ok";
    $("#importText").value = "";
    refreshStats();
    refreshPool();
  } catch (e) {
    $("#importResult").textContent = "❌ " + e.message;
    $("#importResult").className = "result bad";
  } finally {
    $("#btnImport").disabled = false;
  }
});

// ──────────────────────── 触发注册 ────────────────────────

let currentEs = null;

$("#btnRun").addEventListener("click", async () => {
  const email = $("#regEmail").value.trim();
  const opts = {
    email: email || null,
    proxy: $("#regProxy").value.trim(),
    otp_timeout: parseInt($("#regOtpTimeout").value || "180", 10),
    want_access_token: true,
    want_session_token: true,
    want_refresh_token: true,
  };
  $("#btnRun").disabled = true;
  $("#runStatus").textContent = "启动中...";
  $("#runStatus").className = "result";
  $("#logBox").innerHTML = "";

  try {
    const r = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    $("#runStatus").textContent = `🚀 已启动 run_id=${r.run_id} email=${r.email}`;
    logLine(`[client] 启动注册 run_id=${r.run_id} email=${r.email}`, "evt");
    streamRun(r.run_id);
  } catch (e) {
    $("#runStatus").textContent = "❌ " + e.message;
    $("#runStatus").className = "result bad";
    $("#btnRun").disabled = false;
  }
});

function streamRun(runId) {
  if (currentEs) { try { currentEs.close(); } catch (_) {} }
  const es = new EventSource(`/api/runs/${runId}/stream`);
  currentEs = es;

  es.addEventListener("log", (e) => {
    try {
      const d = JSON.parse(e.data);
      if (!d.line) return;
      logLine(d.line, classifyLog(d.line));
    } catch (_) {}
  });

  es.addEventListener("status", (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.kind === "done") {
        const s = `✅ 注册完成: access_token=${d.access_token_len}${d.partial ? "  (部分凭证)" : ""}`;
        const buttons = [];
        if (d.access_token_len > 0)  buttons.push(`<button class="quick-copy" data-email="${d.email}" data-field="access_token">📋 复制 access_token</button>`);
        $("#runStatus").innerHTML = `<span class="ok">${s}</span>${buttons.length ? "<br>" + buttons.join(" ") : ""}`;
        logLine("[client] " + s, "evt");
      } else if (d.kind === "error") {
        $("#runStatus").textContent = "❌ " + d.message;
        $("#runStatus").className = "result bad";
        logLine("[client] ❌ " + d.message, "err");
      } else if (d.kind === "phase") {
        logLine(`[client] phase=${d.phase} email=${d.email}`, "evt");
      }
    } catch (_) {}
  });

  es.addEventListener("end", () => {
    try { es.close(); } catch (_) {}
    currentEs = null;
    $("#btnRun").disabled = false;
    refreshStats();
    refreshPool();
    refreshRegistered();
    refreshRuns();
  });

  es.onerror = () => {
    try { es.close(); } catch (_) {}
    currentEs = null;
    $("#btnRun").disabled = false;
  };
}

// 状态栏快捷复制按钮（注册完成后直接显示在这里，不用切 Tab）
$("#runStatus").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("button.quick-copy");
  if (copyBtn) {
    const email = copyBtn.dataset.email;
    const field = copyBtn.dataset.field;
    try {
      const cred = await _loadCred(email);
      const val = cred[field] || "";
      if (!val) { alert(`${field} 为空`); return; }
      await _copyText(val, copyBtn);
    } catch (err) { alert("加载凭证失败: " + err.message); }
  }
});

// ──────────────────────── Tabs ────────────────────────

$$(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $$(".tab-content").forEach((c) => c.classList.add("hidden"));
    $("#tab-" + t.dataset.tab).classList.remove("hidden");
    if (t.dataset.tab === "registered") refreshRegistered();
    if (t.dataset.tab === "runs") refreshRuns();
    if (t.dataset.tab === "mailcfg") loadMailConfig();
    if (t.dataset.tab === "smscfg") loadSmsConfig();
  });
});

// ──────────────────────── 号池列表 ────────────────────────

async function refreshPool() {
  const status = $("#poolFilter").value;
  const { items } = await api(`/api/accounts?status=${encodeURIComponent(status)}`);
  const tb = $("#poolTable tbody");
  tb.innerHTML = "";
  for (const r of items) {
    const tr = document.createElement("tr");
    const canReset = (r.status === "done" || r.status === "failed");
    tr.innerHTML = `
      <td><input type="checkbox" class="pool-check" data-email="${r.email}"></td>
      <td>${r.email}</td>
      <td><span class="status ${r.status}">${r.status}</span></td>
      <td title="${r.fail_reason || ''}">${(r.fail_reason || '').slice(0, 50)}</td>
      <td>
        <button data-act="use" data-email="${r.email}">使用</button>
        ${canReset ? `<button data-act="reset" data-email="${r.email}" title="改回 available 重新注册">🔄 重置</button>` : ""}
        <button data-act="del" data-email="${r.email}">删除</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  $("#poolSelectAll").checked = false;
  _updateSelCount();
}
$("#btnRefreshPool").addEventListener("click", refreshPool);
$("#poolFilter").addEventListener("change", refreshPool);

$("#btnResetFailed").addEventListener("click", async () => {
  if (!confirm("把所有 failed 号重置为 available？")) return;
  $("#poolActionResult").textContent = "处理中...";
  $("#poolActionResult").className = "result";
  try {
    const r = await api("/api/accounts/reset_failed", { method: "POST" });
    $("#poolActionResult").textContent = `✅ 重置 ${r.reset} 个号为 available`;
    $("#poolActionResult").className = "result ok";
    refreshPool(); refreshStats();
  } catch (e) {
    $("#poolActionResult").textContent = "❌ " + e.message;
    $("#poolActionResult").className = "result bad";
  }
});

$("#btnReleaseStale").addEventListener("click", async () => {
  $("#poolActionResult").textContent = "处理中...";
  $("#poolActionResult").className = "result";
  try {
    const r = await api("/api/accounts/release_stale", { method: "POST" });
    $("#poolActionResult").textContent = `✅ 释放 ${r.released} 个卡死号`;
    $("#poolActionResult").className = "result ok";
    refreshPool(); refreshStats();
  } catch (e) {
    $("#poolActionResult").textContent = "❌ " + e.message;
    $("#poolActionResult").className = "result bad";
  }
});

// ── 号池：复选框选择 + 批量删除 ──

function _selectedEmails() {
  return Array.from(document.querySelectorAll(".pool-check:checked"))
    .map(c => c.dataset.email);
}
function _updateSelCount() {
  const n = _selectedEmails().length;
  $("#selCount").textContent = n;
  $("#selCount2").textContent = n;
  $("#btnDeleteSelected").disabled = n === 0;
  $("#btnResetSelected").disabled = n === 0;
}
$("#poolTable").addEventListener("change", (e) => {
  if (e.target.classList.contains("pool-check")) _updateSelCount();
});
$("#poolSelectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".pool-check").forEach(c => c.checked = e.target.checked);
  _updateSelCount();
});

$("#btnResetSelected").addEventListener("click", async () => {
  const emails = _selectedEmails();
  if (!emails.length) return;
  if (!confirm(`重置选中的 ${emails.length} 个号为 available？\n（号会重新可用，已保存的凭证不变）`)) return;
  $("#poolActionResult").textContent = "重置中...";
  $("#poolActionResult").className = "result";
  try {
    const r = await api("/api/accounts/bulk_reset", {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    $("#poolActionResult").textContent = `✅ 已重置 ${r.reset} 个号`;
    $("#poolActionResult").className = "result ok";
    refreshPool(); refreshStats();
  } catch (e) {
    $("#poolActionResult").textContent = "❌ " + e.message;
    $("#poolActionResult").className = "result bad";
  }
});

$("#btnDeleteSelected").addEventListener("click", async () => {
  const emails = _selectedEmails();
  if (!emails.length) return;
  if (!confirm(`确定删除选中的 ${emails.length} 个号？(不可恢复)`)) return;
  $("#poolActionResult").textContent = "删除中...";
  $("#poolActionResult").className = "result";
  try {
    const r = await api("/api/accounts/bulk_delete", {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    $("#poolActionResult").textContent = `✅ 已删除 ${r.deleted} 个号`;
    $("#poolActionResult").className = "result ok";
    refreshPool(); refreshStats();
  } catch (e) {
    $("#poolActionResult").textContent = "❌ " + e.message;
    $("#poolActionResult").className = "result bad";
  }
});

$("#btnBulkDelStatus").addEventListener("click", async () => {
  const status = $("#bulkDelStatus").value;
  if (!status) {
    $("#poolActionResult").textContent = "请先选择要删除的状态";
    $("#poolActionResult").className = "result bad";
    return;
  }
  const tip = status === "all"
    ? "⚠️ 这会删除号池里所有号（含未注册的），确定？"
    : `确定删除全部 ${status} 状态的号？`;
  if (!confirm(tip)) return;
  $("#poolActionResult").textContent = "删除中...";
  $("#poolActionResult").className = "result";
  try {
    const r = await api("/api/accounts/bulk_delete", {
      method: "POST",
      body: JSON.stringify({ status }),
    });
    $("#poolActionResult").textContent = `✅ 已删除 ${r.deleted} 个 ${status} 号`;
    $("#poolActionResult").className = "result ok";
    $("#bulkDelStatus").value = "";
    refreshPool(); refreshStats();
  } catch (e) {
    $("#poolActionResult").textContent = "❌ " + e.message;
    $("#poolActionResult").className = "result bad";
  }
});

$("#poolTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const email = btn.dataset.email;
  if (btn.dataset.act === "use") {
    $("#regEmail").value = email;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (btn.dataset.act === "reset") {
    if (!confirm(`重置 ${email} 为 available？\n（号会重新可用，但已保存的凭证不变）`)) return;
    try {
      await api(`/api/accounts/reset/${encodeURIComponent(email)}`, { method: "POST" });
      refreshPool();
      refreshStats();
    } catch (err) {
      alert("重置失败: " + err.message);
    }
  } else if (btn.dataset.act === "del") {
    if (!confirm(`删除 ${email}？`)) return;
    await api(`/api/accounts/${encodeURIComponent(email)}`, { method: "DELETE" });
    refreshPool();
    refreshStats();
  }
});

// ──────────────────────── 注册结果列表 ────────────────────────

async function refreshRegistered() {
  const { items } = await api("/api/registered");
  const filter = document.querySelector("input[name='regFilter']:checked")?.value || "all";

  // 按筛选条件过滤
  let filtered = items;
  if (filter === "has_rt") {
    filtered = items.filter(r => r.rt_len > 0);
  } else if (filter === "no_rt") {
    filtered = items.filter(r => r.rt_len === 0);
  }

  const tb = $("#regTable tbody");
  tb.innerHTML = "";
  for (const r of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="reg-check" data-email="${r.email}"></td>
      <td>${r.email}</td>
      <td>${r.at_len > 0 ? `<button class="copy-cell" data-email="${r.email}" data-field="access_token" title="点击复制 access_token">✅ ${r.at_len} 📋</button>` : "—"}</td>
      <td>${r.st_len > 0 ? `<button class="copy-cell" data-email="${r.email}" data-field="session_token" title="点击复制 session_token">✅ ${r.st_len} 📋</button>` : "—"}</td>
      <td>${r.rt_len > 0 ? `<button class="copy-cell" data-email="${r.email}" data-field="refresh_token" title="点击复制 refresh_token">✅ ${r.rt_len} 📋</button>` : "—"}</td>
      <td>${fmtTime(r.created_at)}</td>
      <td>
        <button data-act="view" data-email="${r.email}">查看凭证</button>
        <button data-act="refetch_rt" data-email="${r.email}" title="重新走 Codex OAuth 拿 refresh_token">🔑 RT</button>
        <button data-act="del" data-email="${r.email}">删除</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  $("#regSelectAll").checked = false;
  _updateSelCountReg();
}
$("#btnRefreshReg").addEventListener("click", refreshRegistered);

// radio 切换时自动刷新
document.querySelectorAll("input[name='regFilter']").forEach(r => {
  r.addEventListener("change", refreshRegistered);
});

// ── 注册结果：复选框 + 批量删 + 单行删 ──

function _selectedRegEmails() {
  return Array.from(document.querySelectorAll(".reg-check:checked")).map(c => c.dataset.email);
}
function _updateSelCountReg() {
  const n = _selectedRegEmails().length;
  $("#selCountReg").textContent = n;
  $("#btnDeleteSelectedReg").disabled = n === 0;
  $("#btnBulkRefetchRt").disabled = n === 0;
}
$("#regTable").addEventListener("change", (e) => {
  if (e.target.classList.contains("reg-check")) _updateSelCountReg();
});
$("#regSelectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".reg-check").forEach(c => c.checked = e.target.checked);
  _updateSelCountReg();
});

$("#btnDeleteSelectedReg").addEventListener("click", async () => {
  const emails = _selectedRegEmails();
  if (!emails.length) return;
  if (!confirm(`确定删除选中的 ${emails.length} 条凭证？(不可恢复)`)) return;
  $("#exportResult").textContent = "删除中...";
  $("#exportResult").className = "result";
  try {
    const r = await api("/api/registered/bulk_delete", {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    $("#exportResult").textContent = `✅ 已删除 ${r.deleted} 条凭证`;
    $("#exportResult").className = "result ok";
    refreshRegistered();
  } catch (e) {
    $("#exportResult").textContent = "❌ " + e.message;
    $("#exportResult").className = "result bad";
  }
});

$("#btnDeleteAllReg").addEventListener("click", async () => {
  if (!confirm("⚠️ 这会清空注册结果表里的所有凭证！\n确定继续？（号池不受影响）")) return;
  if (!confirm("再次确认：真的要删除全部凭证吗？此操作不可恢复！")) return;
  $("#exportResult").textContent = "清空中...";
  $("#exportResult").className = "result";
  try {
    const r = await api("/api/registered/bulk_delete", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    $("#exportResult").textContent = `✅ 已清空 ${r.deleted} 条凭证`;
    $("#exportResult").className = "result ok";
    refreshRegistered();
  } catch (e) {
    $("#exportResult").textContent = "❌ " + e.message;
    $("#exportResult").className = "result bad";
  }
});

$("#btnBulkRefetchRt").addEventListener("click", async () => {
  const emails = _selectedRegEmails();
  if (!emails.length) return;
  if (!confirm(`对选中的 ${emails.length} 个号串行重走 Codex OAuth 拿 refresh_token？\n已有 RT 的号会自动跳过；缺 RT 的号每个 ~10s`)) return;
  $("#exportResult").textContent = `处理中 0/${emails.length}...`;
  $("#exportResult").className = "result";
  const proxy = $("#regProxy").value.trim();
  try {
    const r = await api("/api/registered/bulk_refetch_rt", {
      method: "POST",
      body: JSON.stringify({ emails, proxy, force: false }),
    });
    $("#exportResult").textContent = `✅ 完成: 新拿到 ${r.newly_got || 0} 个 / 跳过 ${r.skipped || 0} 个 / 失败 ${r.total - r.succeeded} 个`;
    $("#exportResult").className = "result ok";
    for (const item of r.results || []) {
      if (item.skipped) {
        logLine(`[refetch] ⏭️  ${item.email} 已有 RT (len=${item.refresh_token_len})`, "evt");
      } else if (item.ok) {
        logLine(`[refetch] ✅ ${item.email} RT len=${item.refresh_token_len}`, "ok");
      } else {
        logLine(`[refetch] ❌ ${item.email}: ${item.error || "失败"}`, "err");
      }
    }
    _credCache = null;
    refreshRegistered();
  } catch (e) {
    $("#exportResult").textContent = "❌ " + e.message;
    $("#exportResult").className = "result bad";
  }
});

$("#btnExportAll").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ 导出中...";
  $("#exportResult").textContent = "";
  $("#exportResult").className = "result";
  try {
    const resp = await fetch("/api/registered/export?limit=10000");
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || resp.statusText);
    }
    const count = parseInt(resp.headers.get("X-Account-Count") || "0", 10);
    if (!count) {
      $("#exportResult").textContent = "❌ 没有可导出的注册结果";
      $("#exportResult").className = "result bad";
      return;
    }
    const blob = await resp.blob();
    // 取后端给的文件名（attachment; filename="..."）
    const dispo = resp.headers.get("Content-Disposition") || "";
    const m = dispo.match(/filename="([^"]+)"/);
    const fname = m ? m[1] : `gpt-accounts-${Date.now()}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $("#exportResult").textContent = `✅ 已下载 ${count} 个号的 ZIP 包`;
    $("#exportResult").className = "result ok";
  } catch (err) {
    $("#exportResult").textContent = "❌ " + err.message;
    $("#exportResult").className = "result bad";
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// 缓存最近查看的凭证（用于"复制全部 JSON"按钮和单字段复制）
let _credCache = null;

async function _loadCred(email) {
  if (_credCache && _credCache.email === email) return _credCache;
  const { data } = await api(`/api/registered/${encodeURIComponent(email)}`);
  _credCache = data;
  return data;
}

async function _copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      const cls = btn.className;
      btn.textContent = "✅ 已复制";
      btn.className = cls + " copied";
      setTimeout(() => { btn.textContent = orig; btn.className = cls; }, 1200);
    }
  } catch (e) {
    alert("复制失败: " + e.message);
  }
}

$("#regTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const email = btn.dataset.email;
  if (!email) return;

  // 行内快捷复制（access/session/refresh 列直接点）
  if (btn.classList.contains("copy-cell")) {
    const field = btn.dataset.field;
    try {
      const cred = await _loadCred(email);
      const val = cred[field] || "";
      if (!val) { alert(`${field} 为空`); return; }
      await _copyText(val, btn);
    } catch (err) { alert("加载凭证失败: " + err.message); }
    return;
  }

  // 「查看凭证」打开模态框
  if (btn.dataset.act === "view") {
    try {
      const cred = await _loadCred(email);
      _renderCredModal(email, cred);
    } catch (err) { alert("加载凭证失败: " + err.message); }
  }

  // 「删除」单行删
  if (btn.dataset.act === "del") {
    if (!confirm(`删除 ${email} 的凭证？`)) return;
    try {
      await api(`/api/registered/${encodeURIComponent(email)}`, { method: "DELETE" });
      refreshRegistered();
    } catch (err) { alert("删除失败: " + err.message); }
  }

  // 「🔑 RT」单行重拿 refresh_token
  if (btn.dataset.act === "refetch_rt") {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳";
    try {
      const proxy = $("#regProxy").value.trim();
      // 第一次 force=false：已有 RT 会跳过
      let r = await api("/api/registered/refetch_rt", {
        method: "POST",
        body: JSON.stringify({ email, proxy, force: false }),
      });
      if (r.skipped) {
        // 已有 RT，询问是否强制覆盖
        const ok = confirm(`${email} 已有 refresh_token (len=${r.refresh_token_len})\n是否强制重新拿一次覆盖？（一般不需要）`);
        if (!ok) {
          logLine(`[refetch] ⏭️  ${email} 已有 RT，跳过`, "evt");
          return;
        }
        r = await api("/api/registered/refetch_rt", {
          method: "POST",
          body: JSON.stringify({ email, proxy, force: true }),
        });
      }
      if (r.ok) {
        logLine(`[refetch] ✅ ${email} 拿到 RT (len=${r.refresh_token_len})`, "ok");
        if (_credCache && _credCache.email === email) _credCache = null;
        refreshRegistered();
      } else {
        logLine(`[refetch] ❌ ${email}: ${r.error}`, "err");
        alert("失败: " + r.error);
      }
    } catch (err) {
      alert("失败: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
});


function _renderCredModal(email, cred) {
  $("#credTitle").textContent = email;
  const box = $("#credFields");
  box.innerHTML = "";

  // 主要凭证按顺序展示，每项独立复制按钮
  const KEYS = [
    ["access_token",  "access_token"],
    ["session_token", "session_token"],
    ["refresh_token", "refresh_token"],
    ["id_token",      "id_token"],
    ["device_id",     "device_id"],
    ["csrf_token",    "csrf_token"],
    ["cookie_header", "cookie_header"],
    ["password",      "password"],
  ];
  for (const [key, label] of KEYS) {
    const val = cred[key] || "";
    if (!val) continue;
    const row = document.createElement("div");
    row.className = "cred-row";
    row.innerHTML = `
      <div class="cred-row-head">
        <span class="cred-label">${label}</span>
        <span class="cred-meta">len=${val.length}</span>
        <button class="cred-copy" data-val-key="${key}">📋 复制</button>
      </div>
      <pre class="cred-val">${escapeHtml(val)}</pre>
    `;
    box.appendChild(row);
  }

  // extra（含 cookie 同步等其他元数据）
  if (cred.extra && Object.keys(cred.extra).length > 0) {
    const row = document.createElement("div");
    row.className = "cred-row";
    row.innerHTML = `
      <div class="cred-row-head">
        <span class="cred-label">extra</span>
        <span class="cred-meta">${Object.keys(cred.extra).length} keys</span>
        <button class="cred-copy" data-val-key="__extra__">📋 复制 JSON</button>
      </div>
      <pre class="cred-val">${escapeHtml(JSON.stringify(cred.extra, null, 2))}</pre>
    `;
    box.appendChild(row);
  }

  $("#credModal").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// 模态框内单字段复制
$("#credFields").addEventListener("click", async (e) => {
  const btn = e.target.closest("button.cred-copy");
  if (!btn) return;
  const key = btn.dataset.valKey;
  const val = key === "__extra__"
    ? JSON.stringify(_credCache.extra, null, 2)
    : (_credCache[key] || "");
  await _copyText(val, btn);
});

$("#credClose").addEventListener("click", () => {
  $("#credModal").classList.add("hidden");
});
$("#credCopyJson").addEventListener("click", async (e) => {
  if (!_credCache) return;
  await _copyText(JSON.stringify(_credCache, null, 2), e.currentTarget);
});

// ──────────────────────── 运行记录 ────────────────────────

async function refreshRuns() {
  const { items } = await api("/api/runs");
  const tb = $("#runTable tbody");
  tb.innerHTML = "";
  for (const r of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${r.run_id}</code></td>
      <td>${r.email}</td>
      <td><span class="status ${r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : 'running'}">${r.status}</span></td>
      <td>${fmtTime(r.started_at)}</td>
      <td title="${r.error || ''}">${(r.error || '').slice(0, 60)}</td>
    `;
    tb.appendChild(tr);
  }
}
$("#btnRefreshRuns").addEventListener("click", refreshRuns);

// ──────────────────────── 🤖 Auto-Loop 全自动批量 ────────────────────────

const AUTO_BTNS = {
  start:  $("#btnAutoStart"),
  pause:  $("#btnAutoPause"),
  resume: $("#btnAutoResume"),
  stop:   $("#btnAutoStop"),
};

function _autoOptions() {
  return {
    proxy: $("#regProxy").value.trim(),
    proxy_pool: $("#autoProxyPool").value,
    concurrency: parseInt($("#autoConcurrency").value || "1", 10),
    otp_timeout: parseInt($("#regOtpTimeout").value || "180", 10),
    want_access_token: true,
    want_session_token: true,
    want_refresh_token: true,
    cool_down_seconds: parseFloat($("#autoCoolDown").value || "3") || 0,
  };
}

async function autoStart() {
  try {
    await api("/api/auto/start", { method: "POST", body: JSON.stringify(_autoOptions()) });
  } catch (e) { alert("启动失败: " + e.message); }
}
async function autoCall(path) {
  try { await api(path, { method: "POST" }); }
  catch (e) { alert(`${path} 失败: ${e.message}`); }
}
AUTO_BTNS.start.addEventListener("click", autoStart);
AUTO_BTNS.pause.addEventListener("click", () => autoCall("/api/auto/pause"));
AUTO_BTNS.resume.addEventListener("click", () => autoCall("/api/auto/resume"));
AUTO_BTNS.stop.addEventListener("click", () => autoCall("/api/auto/stop"));

function _renderAutoStatus(s) {
  const stateLabel = {
    "stopped": "⚪ 未运行",
    "running": "🟢 运行中",
    "paused":  "⏸ 已暂停",
  }[s.state] || s.state;
  const elapsed = s.elapsed ? Math.round(s.elapsed) + "s" : "—";
  const workers = Array.isArray(s.workers) ? s.workers : [];
  const workerRows = workers.length
    ? workers.map(w => {
        const dur = w.started_at ? Math.round(Date.now() / 1000 - w.started_at) + "s" : "";
        const px = w.proxy ? ` [${escapeHtml(w.proxy.slice(0, 30))}${w.proxy.length > 30 ? "..." : ""}]` : "";
        return `<div class="auto-worker">worker-${w.id} ▶ <code>${escapeHtml(w.email)}</code> ${dur}${px}</div>`;
      }).join("")
    : "";
  const meta = `并发=${s.concurrency || 1}` + (s.proxy_pool_size ? ` 代理池=${s.proxy_pool_size}` : "");
  $("#autoStatus").innerHTML = `
    <b>${stateLabel}</b>
    &nbsp;|&nbsp; 已完成: <b class="ok">${s.registered_ok}</b> 成功 / <b class="bad">${s.registered_fail}</b> 失败
    &nbsp;|&nbsp; 运行: ${elapsed}
    &nbsp;|&nbsp; <span class="auto-meta">${meta}</span>
    ${workerRows ? "<br>" + workerRows : ""}
    <br><span class="auto-msg">${escapeHtml(s.last_message || "")}</span>
  `;
  // 按钮可用性
  const st = s.state;
  AUTO_BTNS.start.disabled  = (st === "running" || st === "paused");
  AUTO_BTNS.pause.disabled  = (st !== "running");
  AUTO_BTNS.resume.disabled = (st !== "paused");
  AUTO_BTNS.stop.disabled   = (st === "stopped");
}

let _autoEs = null;
function _connectAutoStream() {
  if (_autoEs) { try { _autoEs.close(); } catch (_) {} }
  const es = new EventSource("/api/auto/stream");
  _autoEs = es;
  es.addEventListener("state", (e) => {
    try { _renderAutoStatus(JSON.parse(e.data)); } catch (_) {}
  });
  es.addEventListener("run_started", (e) => {
    try {
      const d = JSON.parse(e.data);
      logLine(`[auto] ▶ 开始注册 ${d.email} (run=${d.run_id})`, "evt");
      // 复用单跑的 SSE 流，自动接管日志框 + 状态栏复制按钮
      streamRun(d.run_id);
    } catch (_) {}
  });
  es.addEventListener("run_finished", (e) => {
    try {
      const d = JSON.parse(e.data);
      const tag = d.ok ? "✅" : (d.category === "network" ? "🌐 网络错误（号已 release）" : "❌");
      logLine(`[auto] ${tag} ${d.email} 完成`, d.ok ? "ok" : "err");
    } catch (_) {}
  });
  es.addEventListener("circuit_break", (e) => {
    try {
      const d = JSON.parse(e.data);
      logLine(`[auto] ⚠️ 熔断: ${d.reason}`, "err");
      _showBanner(d.reason);
    } catch (_) {}
  });
  es.onerror = () => {
    // 自动重连
    try { es.close(); } catch (_) {}
    _autoEs = null;
    setTimeout(_connectAutoStream, 2000);
  };
}

// 顶部红色告警横幅
function _showBanner(msg) {
  const b = $("#alertBanner");
  $("#alertBannerMsg").textContent = msg;
  b.classList.remove("hidden");
}
$("#alertBannerClose").addEventListener("click", () => {
  $("#alertBanner").classList.add("hidden");
});

// ──────────────────────── 表单持久化（localStorage 自动保存/恢复）────────────────────────

const FORM_KEY = "gpt_outlook_register_form_v1";

// id -> 类型（默认 text；checkbox 走 .checked）
const PERSIST_FIELDS = {
  regProxy:        "text",
  regOtpTimeout:   "text",
  autoCoolDown:    "text",
  autoConcurrency: "text",
  autoProxyPool:   "text",
};

function _saveForm() {
  const data = {};
  for (const [id, kind] of Object.entries(PERSIST_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    data[id] = kind === "check" ? !!el.checked : (el.value || "");
  }
  try { localStorage.setItem(FORM_KEY, JSON.stringify(data)); } catch (_) {}
}

function _loadForm() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(FORM_KEY) || "{}"); } catch (_) { data = {}; }
  for (const [id, kind] of Object.entries(PERSIST_FIELDS)) {
    if (!(id in data)) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    if (kind === "check") el.checked = !!data[id];
    else el.value = data[id] || "";
  }
}

// 绑定 input/change 自动保存
function _bindAutoSave() {
  for (const id of Object.keys(PERSIST_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", _saveForm);
    el.addEventListener("change", _saveForm);
  }
}

// ──────────────────────── 📧 邮箱配置 ────────────────────────

function _syncCfFields(source) {
  $("#cfTempCfg").classList.toggle("hidden", source !== "cf_temp");
}

async function loadMailConfig() {
  try {
    const { config } = await api("/api/settings/mail");
    const src = config.mail_source || "outlook";
    const radio = document.querySelector(`input[name="mailSource"][value="${src}"]`);
    if (radio) radio.checked = true;
    _syncCfFields(src);
    $("#cfApiUrl").value = config.cf_api_url || "";
    $("#cfDomain").value = config.cf_domain || "";
    $("#cfAdminToken").value = "";
    if (config.cf_admin_token === "***") {
      $("#cfAdminToken").placeholder = "已设置（留空不修改）";
    } else {
      $("#cfAdminToken").placeholder = "Worker 配置的 ADMIN_PASSWORDS";
    }
  } catch (e) {
    console.error("loadMailConfig:", e);
  }
}

// radio 切换显隐
document.querySelectorAll("input[name='mailSource']").forEach(r => {
  r.addEventListener("change", () => _syncCfFields(r.value));
});

$("#btnSaveMailCfg").addEventListener("click", async () => {
  const source = document.querySelector("input[name='mailSource']:checked")?.value || "outlook";
  const isCf = source === "cf_temp";
  const body = {
    mail_source:    source,
    cf_api_url:     isCf ? $("#cfApiUrl").value.trim() : "",
    cf_admin_token: isCf ? ($("#cfAdminToken").value.trim() || "***") : "***",
    cf_domain:      isCf ? $("#cfDomain").value.trim() : "",
  };
  try {
    await api("/api/settings/mail", { method: "POST", body: JSON.stringify(body) });
    $("#mailCfgResult").textContent = "✅ 保存成功";
    $("#mailCfgResult").className = "result ok";
  } catch (e) {
    $("#mailCfgResult").textContent = "❌ " + e.message;
    $("#mailCfgResult").className = "result bad";
  }
  setTimeout(() => { $("#mailCfgResult").textContent = ""; }, 3000);
});

$("#btnTestMail").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "⏳ 测试中...";
  $("#mailCfgResult").textContent = "";
  try {
    const r = await api("/api/settings/mail/test", { method: "POST" });
    $("#mailCfgResult").textContent = "✅ " + r.message;
    $("#mailCfgResult").className = "result ok";
  } catch (err) {
    $("#mailCfgResult").textContent = "❌ " + err.message;
    $("#mailCfgResult").className = "result bad";
  } finally {
    btn.disabled = false;
    btn.textContent = "🔌 测试 CF 连通性";
  }
});

// ──────────────────────── 📱 SMS 接码配置 ────────────────────────

// 全量国家列表（id → name_cn + openai_sms_safe）；首次加载配置时从后端拿
let _smsAllCountries = [];
let _smsSafeCountrySet = new Set();

async function _loadSmsAllCountries() {
  if (_smsAllCountries.length) return _smsAllCountries;
  try {
    const r = await api("/api/settings/sms/all_countries");
    _smsAllCountries = r.countries || [];
    _smsSafeCountrySet = new Set(r.openai_sms_safe || []);
  } catch (e) {
    console.error("加载国家列表失败:", e);
  }
  return _smsAllCountries;
}

function _renderSmsCountrySelect(selectEl, currentValue) {
  selectEl.innerHTML = "";
  for (const c of _smsAllCountries) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.id} - ${c.name_cn}`;
    selectEl.appendChild(opt);
  }
  if (currentValue) selectEl.value = currentValue;
}

function _renderSmsAllowedCountriesBox(checkedIds) {
  const box = $("#smsAllowedCountriesBox");
  box.innerHTML = "";
  const checkedSet = new Set((checkedIds || "").split(",").map(s => s.trim()).filter(Boolean));

  // 先渲染所有国家（带 data 属性用于搜索）
  for (const c of _smsAllCountries) {
    const lab = document.createElement("label");
    lab.className = "check country-item";
    lab.style.fontSize = "12px";
    lab.style.padding = "4px 6px";
    lab.style.lineHeight = "1.4";
    lab.dataset.countryId = c.id;
    lab.dataset.countryName = c.name_cn.toLowerCase();

    // 显示：ID·国家名 (价格/库存)
    const priceInfo = c.price != null && c.count != null
      ? ` <span style="color:#999;font-size:11px">(${c.price}/${c.count})</span>`
      : "";
    lab.innerHTML = `<input type="checkbox" value="${c.id}" ${checkedSet.has(c.id) ? "checked" : ""}>${c.id}·${c.name_cn}${priceInfo}`;
    box.appendChild(lab);
  }

  _updateAllowedCountryCount();
  box.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", _updateAllowedCountryCount);
  });

  // 绑定搜索框
  const searchInput = $("#smsCountrySearch");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase().trim();
      box.querySelectorAll(".country-item").forEach(lab => {
        const id = lab.dataset.countryId || "";
        const name = lab.dataset.countryName || "";
        const match = !query || id.includes(query) || name.includes(query);
        lab.style.display = match ? "" : "none";
      });
    });
  }
}

function _updateAllowedCountryCount() {
  const checked = $("#smsAllowedCountriesBox").querySelectorAll("input[type=checkbox]:checked");
  $("#smsAllowedCountryCount").textContent = `已选 ${checked.length} 个国家`;
}

function _getAllowedCountriesValue() {
  const checked = $("#smsAllowedCountriesBox").querySelectorAll("input[type=checkbox]:checked");
  return Array.from(checked).map(cb => cb.value).join(",");
}

async function loadSmsConfig() {
  await _loadSmsAllCountries();
  try {
    const { config } = await api("/api/settings/sms");
    $("#smsEnabled").checked = config.sms_enabled === "1";
    const provider = config.sms_provider || "smsbower";
    const radio = document.querySelector(`input[name="smsProvider"][value="${provider}"]`);
    if (radio) radio.checked = true;
    $("#smsApiKey").value = "";
    $("#smsApiKey").placeholder = (config.sms_api_key === "***")
      ? "已设置（留空不修改）"
      : "粘贴接码平台 API Key";
    _renderSmsCountrySelect($("#smsCountry"), config.sms_country || "150");
    $("#smsService").value = config.sms_service || "dr";
    $("#smsMaxPrice").value = config.sms_max_price || "";
    $("#smsPhoneSuccessMax").value = config.sms_phone_success_max || "3";
    $("#smsReusePhone").checked = config.sms_reuse_phone === "1";
    $("#smsAutoCountry").checked = config.sms_auto_country === "1";
    $("#smsAutoMinStock").value = config.sms_auto_min_stock || "20";
    $("#smsAutoMaxPrice").value = config.sms_auto_max_price || "";
    _renderSmsAllowedCountriesBox(config.sms_allowed_countries || "");
    $("#smsMaxPhoneAttempts").value = config.sms_max_phone_attempts || "";
    $("#smsPerPhoneTimeout").value = config.sms_per_phone_timeout || "80";
    $("#smsProxy").value = config.sms_proxy || "";
  } catch (e) {
    console.error("loadSmsConfig:", e);
  }
}

$("#btnClearAllowedCountries")?.addEventListener("click", () => {
  $("#smsAllowedCountriesBox").querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.checked = false;
  });
  _updateAllowedCountryCount();
});

$("#btnSaveSmsCfg").addEventListener("click", async () => {
  const apiKeyInput = $("#smsApiKey").value.trim();
  const body = {
    sms_enabled:           $("#smsEnabled").checked ? "1" : "0",
    sms_provider:          document.querySelector("input[name='smsProvider']:checked")?.value || "smsbower",
    sms_api_key:           apiKeyInput || "***",
    sms_country:           $("#smsCountry").value.trim() || "52",
    sms_service:           $("#smsService").value.trim() || "dr",
    sms_max_price:         $("#smsMaxPrice").value.trim(),
    sms_phone_success_max: $("#smsPhoneSuccessMax").value.trim() || "3",
    sms_reuse_phone:       $("#smsReusePhone").checked ? "1" : "0",
    sms_auto_country:      $("#smsAutoCountry").checked ? "1" : "0",
    sms_allowed_countries: _getAllowedCountriesValue(),
    sms_auto_min_stock:    $("#smsAutoMinStock").value.trim() || "20",
    sms_auto_max_price:    $("#smsAutoMaxPrice").value.trim(),
    sms_max_phone_attempts: $("#smsMaxPhoneAttempts").value.trim(),
    sms_per_phone_timeout: $("#smsPerPhoneTimeout").value.trim() || "80",
    sms_proxy:             $("#smsProxy").value.trim(),
  };
  try {
    await api("/api/settings/sms", { method: "POST", body: JSON.stringify(body) });
    $("#smsCfgResult").textContent = "✅ 保存成功";
    $("#smsCfgResult").className = "result ok";
    setTimeout(loadSmsConfig, 300);
  } catch (e) {
    $("#smsCfgResult").textContent = "❌ " + e.message;
    $("#smsCfgResult").className = "result bad";
  }
  setTimeout(() => { $("#smsCfgResult").textContent = ""; }, 3500);
});

$("#btnTestSms").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "⏳ 测试中...";
  $("#smsCfgResult").textContent = "";
  try {
    const r = await api("/api/settings/sms/test", { method: "POST" });
    $("#smsCfgResult").textContent = "✅ " + r.message;
    $("#smsCfgResult").className = "result ok";
  } catch (err) {
    $("#smsCfgResult").textContent = "❌ " + err.message;
    $("#smsCfgResult").className = "result bad";
  } finally {
    btn.disabled = false;
    btn.textContent = "🔌 测试余额";
  }
});

// ──────────────────────── 启动 ────────────────────────

_loadForm();
_bindAutoSave();
refreshStats();
refreshPool();
_connectAutoStream();
setInterval(refreshStats, 5000);
