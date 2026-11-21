(function () {
  var root = document.getElementById("cdp");
  if (!root) return;
  var KEY = "guizang-zhuhai-chida-v1";
  var TS_KEY = KEY + ":ts";
  var list = document.getElementById("cdp-list");
  var form = document.getElementById("cdp-form");
  var input = document.getElementById("cdp-input");
  var doneEl = document.getElementById("cdp-done");
  var totalEl = document.getElementById("cdp-total");
  var fillEl = document.getElementById("cdp-fill");
  var canStore = (function () { try { var k = "__cdp_probe__"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return true; } catch (e) { return false; } })();
  var BASE = [];
  Array.prototype.forEach.call(list.querySelectorAll(".cdp-row"), function (row) {
    BASE.push(row.getAttribute("data-text"));
    row.removeAttribute("contenteditable");
  });

  var raf = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : function (fn) { return window.setTimeout(fn, 16); };
  var mqReduce = null;
  try { mqReduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null; } catch (e) {}
  function reducedMotion() { return !!(mqReduce && mqReduce.matches); }

  /* ===== 协同层 ===== */
  var CFG_KEY = "cdp-sync-cfg-v1";
  var GIST = { id: "4bb6f3b536c05a65de7132179a8826e9", file: "zhuhai-chida.json" };
  var TOKEN = "", ETAG = "";
  var TS = { done: {}, extra: {}, del: {}, addr: {} };
  var ADDR = {};
  var CACHE = { done: {}, extra: [] };
  var state = { done: {}, extra: [] };
  var hydrated = false, bootSettled = false;
  var pushTimer = 0, pollTimer = 0, failCount = 0, pendingRender = false, leaving = 0, maxTs = 0;
  var pushFirstAt = 0, leaveSent = 0, lastErr = null;
  var PUSH_DELAY = 1800, PUSH_MAXWAIT = 4000;
  var net = { get: null, getAt: 0, patch: null, dirty: false, pending: false };

  function normAddr(e) {
    if (typeof e === "string") return { t: 0, v: e };
    if (e && typeof e === "object" && typeof e.v === "string") {
      var t = typeof e.t === "number" && isFinite(e.t) ? e.t : 0;
      return { t: t, v: e.v };
    }
    return null;
  }
  function pickAddr(x, y) {
    var a = normAddr(x), b = normAddr(y);
    if (!a) return b;
    if (!b) return a;
    if (b.t > a.t) return b;
    if (b.t < a.t) return a;
    return String(b.v) > String(a.v) ? b : a;
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function has(arr, v) { return arr.indexOf(v) !== -1; }

  function readTs(o) {
    if (!o || typeof o !== "object") return;
    TS.done = o.done && typeof o.done === "object" ? o.done : TS.done;
    TS.extra = o.extra && typeof o.extra === "object" ? o.extra : TS.extra;
    TS.del = o.del && typeof o.del === "object" ? o.del : TS.del;
    if (typeof o.rev === "number") TS.rev = o.rev;
    var a = o.addr && typeof o.addr === "object" ? o.addr : {};
    Object.keys(a).forEach(function (k) { var n = normAddr(a[k]); if (n) TS.addr[k] = n; });
  }

  /* 本地只作「上次真相的副本 + 未发送意图」；内容进 CACHE，不直接上屏 */
  try {
    var raw = window.localStorage.getItem(KEY);
    if (raw) {
      var p = JSON.parse(raw);
      if (p && typeof p === "object") {
        if (p.done && typeof p.done === "object") CACHE.done = p.done;
        if (Array.isArray(p.extra)) CACHE.extra = p.extra.filter(function (t) { return typeof t === "string" && t; });
        if (p.TS && typeof p.TS === "object") readTs(p.TS);
      }
    }
    if (!Object.keys(TS.done).length && !TS.rev) {
      var rawTs = window.localStorage.getItem(TS_KEY);
      if (rawTs) readTs(JSON.parse(rawTs));
    }
  } catch (e) {}

  /* 老缓存迁移：seed=1，永远输给任何真实时间戳，只在远端缺键时兜底 */
  if (!Object.keys(TS.done).length && Object.keys(CACHE.done).length) {
    Object.keys(CACHE.done).forEach(function (k) { if (CACHE.done[k]) TS.done[k] = 1; });
    CACHE.extra.forEach(function (t) { if (!TS.extra[t]) TS.extra[t] = 1; });
  }

  function scanMax() {
    ["done", "extra", "del"].forEach(function (f) {
      var o = TS[f] || {};
      Object.keys(o).forEach(function (k) { var v = Math.abs(Number(o[k]) || 0); if (v > maxTs) maxTs = v; });
    });
    var a = TS.addr || {};
    Object.keys(a).forEach(function (k) { var n = normAddr(a[k]); if (n && n.t > maxTs) maxTs = n.t; });
  }
  function tsNow() { var t = Math.max(Date.now(), maxTs + 1); maxTs = t; return t; }

  function hydrateAddr() {
    ADDR = {};
    Object.keys(TS.addr || {}).forEach(function (k) {
      var a = normAddr(TS.addr[k]);
      if (!a) return;
      var d = TS.del && TS.del[k];
      if (typeof d === "number" && d >= a.t) return;
      if (a.v) ADDR[k] = a.v;
    });
  }

  function saveTs() { try { window.localStorage.setItem(TS_KEY, JSON.stringify(TS)); } catch (e) {} }
  function save() {
    try {
      if (!hydrated) { saveTs(); return; }
      window.localStorage.setItem(KEY, JSON.stringify({ done: state.done, extra: state.extra, TS: TS }));
      window.localStorage.removeItem(TS_KEY);
    } catch (e) {}
  }
  function markPending(v) {
    try { if (v) window.localStorage.setItem(KEY + ":pending", "1"); else window.localStorage.removeItem(KEY + ":pending"); } catch (e) {}
  }
  function readPending() { try { return window.localStorage.getItem(KEY + ":pending") === "1"; } catch (e) { return false; } }

  /* ===== 失败分类 ===== */
  var FAIL_TXT = {
    token_bad: "token 失效·点我换", token_scope: "无 gist 写权限", forbidden: "被拒·查 gist",
    rate_limited: "限流·稍后自愈", abuse: "请求太密·稍后自愈", gist_missing: "gist 找不到",
    invalid: "内容被拒", server: "GitHub 服务器问题", offline: "离线·已存本机",
    timeout: "超时·已存本机", conflict: "冲突·重试中", http: "同步失败"
  };
  var FAIL_STATE = {
    rate_limited: "warn", abuse: "warn", server: "warn", offline: "warn",
    timeout: "warn", conflict: "warn",
    token_bad: "fail", token_scope: "fail", forbidden: "fail",
    gist_missing: "fail", invalid: "fail", http: "fail"
  };
  function failText(e) { return FAIL_TXT[(e && e.kind) || "http"] || FAIL_TXT.http; }
  function failState(e) { return FAIL_STATE[(e && e.kind) || "http"] || "fail"; }
  function errTitle(e) {
    if (!e) return "同步状态";
    return failText(e) + (e.msg ? "｜" + String(e.msg).slice(0, 70) : "") + (e.code ? "｜HTTP " + e.code : "");
  }
  function classify(r, txt) {
    if (r.status === 401) return "token_bad";
    if (r.status === 403) {
      if (r.headers.get("X-RateLimit-Remaining") === "0") return "rate_limited";
      return "forbidden";
    }
    if (r.status === 404) return "gist_missing";
    if (r.status === 409) return "conflict";
    if (r.status === 422) return /spam|rate/i.test(txt || "") ? "abuse" : "invalid";
    if (r.status >= 500) return "server";
    return "http";
  }
  function mkErr(r, txt) {
    var e = new Error("http " + r.status);
    e.code = r.status;
    e.kind = classify(r, txt);
    var m = "";
    try { m = (JSON.parse(txt) || {}).message || ""; } catch (x) { m = String(txt || "").slice(0, 110); }
    e.msg = m;
    return e;
  }

  /* ===== 状态角标 ===== */
  var badge = document.createElement("span");
  badge.className = "cdp-sync";
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  badge.setAttribute("tabindex", "0");
  badge.setAttribute("title", "同步状态｜点一下重试｜按住 800ms 强制拉最新｜Shift+回车 同上");
  badge.setAttribute("aria-label", "同步状态。回车重试，Shift 加回车强制拉取最新");
  badge.setAttribute("data-state", "local");
  var head = root.querySelector(".cdp-head");
  if (head) head.appendChild(badge);
  function setBadge(txt, st) {
    if (!badge) return;
    st = st || "local";
    if (badge.textContent === txt && badge.getAttribute("data-state") === st) return;
    badge.textContent = txt;
    badge.setAttribute("data-state", st);
  }

  /* ===== 书页开合 ===== */
  var foldBtn = document.createElement("button");
  foldBtn.type = "button";
  foldBtn.className = "cdp-fold-btn";
  foldBtn.setAttribute("aria-controls", "cdp-list");
  foldBtn.setAttribute("aria-expanded", "true");
  var foldIco = document.createElement("span");
  foldIco.className = "cdp-fold-ico";
  foldIco.setAttribute("aria-hidden", "true");
  var foldTxt = document.createElement("span");
  foldTxt.textContent = "收起菜单";
  foldBtn.appendChild(foldIco);
  foldBtn.appendChild(foldTxt);
  if (head && head.parentNode) head.parentNode.insertBefore(foldBtn, head.nextSibling);
  function setFold(on) {
    if (on) root.classList.add("is-folded"); else root.classList.remove("is-folded");
    foldBtn.setAttribute("aria-expanded", on ? "false" : "true");
    foldTxt.textContent = on ? "翻开菜单" : "收起菜单";
    if (on) { try { list.setAttribute("inert", ""); } catch (e) {} }
    else { try { list.removeAttribute("inert"); } catch (e) {} }
  }
  foldBtn.addEventListener("click", function () { setFold(!root.classList.contains("is-folded")); });

  /* ===== 配置 ===== */
  function loadCfg() { try { return JSON.parse(window.localStorage.getItem(CFG_KEY) || "null"); } catch (e) { return null; } }
  function saveCfg(c) { try { window.localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  function api(url, opt) {
    opt = opt || {}; opt.cache = "no-store";
    opt.headers = Object.assign({ "Accept": "application/vnd.github+json", "Content-Type": "application/json" }, opt.headers || {});
    if (TOKEN) opt.headers.Authorization = "Bearer " + TOKEN;
    var ctl = null, timer = 0;
    try { if (window.AbortController) { ctl = new AbortController(); opt.signal = ctl.signal; } } catch (e) {}
    if (ctl) timer = window.setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 12000);
    function stop() { if (timer) { window.clearTimeout(timer); timer = 0; } }
    return fetch(url, opt).then(function (r) {
      stop();
      if (r.status === 304) return { notModified: true };
      if (r.ok) { ETAG = r.headers.get("ETag") || ETAG; return r.json(); }
      return r.text().then(function (txt) { throw mkErr(r, txt); }, function () { throw mkErr(r, ""); });
    }, function (err) {
      stop();
      var e = err || new Error("network");
      e.kind = (e.name === "AbortError") ? "timeout" : "offline";
      e.msg = "";
      throw e;
    });
  }

  function readDoc(j) {
    if (!j || j.notModified) return null;
    var f = j.files && j.files[GIST.file];
    if (!f || f.truncated) return null;
    try { return JSON.parse(f.content); } catch (e) { return null; }
  }

  function parseDoc(j) {
    if (!j) return null;
    if (j.notModified) return { unchanged: true };
    var doc = readDoc(j);
    if (!doc) { lastErr = { kind: "invalid", msg: "文档解析失败" }; return null; }
    lastErr = null;
    return { doc: doc };
  }

  /* 读取不需要 token：secret gist 匿名可读；401 时自动丢掉旧 token 降级重读 */
  function fetchData() {
    if (net.get) return net.get;
    var hadToken = !!TOKEN;
    var h = ETAG ? { "If-None-Match": ETAG } : {};
    var gid = "https://api.github.com/gists/" + GIST.id;
    net.getAt = Date.now();
    var base = api(gid, { headers: h }).then(parseDoc).catch(function (e) {
      lastErr = e || null;
      if (hadToken && e && e.code === 401) {
        TOKEN = ""; ETAG = "";
        saveCfg({ gist: GIST.id, token: "" });
        return api(gid, { headers: {} }).then(parseDoc).catch(function (e2) { lastErr = e2 || null; return null; });
      }
      return null;
    });
    net.get = base.then(function (r) { net.get = null; return r; }, function () { net.get = null; return null; });
    return net.get;
  }

  function mergeState(a, b) {
    var out = { v: 3, rev: 0, updatedAt: new Date().toISOString(), done: {}, extra: {}, del: {}, addr: {} };
    ["done", "extra", "del"].forEach(function (f) {
      var x = (a && a[f]) || {}, y = (b && b[f]) || {}, m = out[f];
      Object.keys(x).forEach(function (k) { m[k] = x[k]; });
      Object.keys(y).forEach(function (k) {
        if (!own(m, k) || Math.abs(y[k]) > Math.abs(m[k]) || (Math.abs(y[k]) === Math.abs(m[k]) && String(y[k]) > String(m[k]))) m[k] = y[k];
      });
    });
    var ax = (a && a.addr) || {}, ay = (b && b.addr) || {};
    Object.keys(ax).forEach(function (k) { var n = normAddr(ax[k]); if (n) out.addr[k] = n; });
    Object.keys(ay).forEach(function (k) { var n = pickAddr(out.addr[k], ay[k]); if (n) out.addr[k] = n; });
    out.rev = Math.max((a && a.rev) || 0, (b && b.rev) || 0) + 1;
    return out;
  }

  function buildState(doc) {
    var st = { done: {}, extra: [], addr: {} };
    Object.keys(doc.done || {}).forEach(function (k) { if (doc.done[k] > 0) st.done[k] = 1; });
    Object.keys(doc.extra || {}).forEach(function (k) {
      var d = doc.del && doc.del[k];
      if (!(typeof d === "number" && Math.abs(d) >= Math.abs(doc.extra[k]))) st.extra.push(k);
    });
    st.extra.sort(function (x, y) { return doc.extra[x] - doc.extra[y]; });
    Object.keys(doc.addr || {}).forEach(function (k) {
      var a = normAddr(doc.addr[k]);
      if (!a) return;
      var d = doc.del && doc.del[k];
      if (typeof d === "number" && d >= a.t) return;
      if (a.v) st.addr[k] = a.v;
    });
    return st;
  }

  function isEditing() {
    var a = document.activeElement;
    if (!a || a === document.body) return false;
    if (a === input) return true;
    try { return !!(a.isContentEditable && root.contains(a)); } catch (e) { return false; }
  }

  function applyDoc(doc, silent) {
    if (!doc) return false;
    TS = mergeState(TS, doc);
    scanMax();
    var st = buildState(TS);
    state.done = st.done;
    state.extra = st.extra;
    if (silent) { save(); return false; }
    hydrated = true;
    ADDR = st.addr || {};
    save();
    if (isEditing()) { pendingRender = true; return false; }
    pendingRender = false;
    if (root.classList.contains("cdp-boot")) root.classList.remove("cdp-boot");
    render();
    return true;
  }

  function snapshot() {
    return { v: 3, rev: (TS.rev || 0) + 1, updatedAt: new Date().toISOString(), done: TS.done || {}, extra: TS.extra || {}, del: TS.del || {}, addr: TS.addr || {} };
  }
  function contentKey(d) {
    return JSON.stringify({ d: d.done || {}, e: d.extra || {}, x: d.del || {}, a: d.addr || {} });
  }

  function patchOnce(retry) {
    return fetchData().then(function (res) {
      if (res && res.doc) applyDoc(res.doc, true);
      var doc = snapshot();
      var body = { files: {} };
      body.files[GIST.file] = { content: JSON.stringify(doc, null, 1) };
      if (net.lastBody === contentKey(doc) && retry === 0) { setBadge("已同步", "ok"); return true; }
      setBadge("同步中", "busy");
      return api("https://api.github.com/gists/" + GIST.id, { method: "PATCH", body: JSON.stringify(body) })
        .then(function () {
          failCount = 0; lastErr = null; net.lastBody = contentKey(doc);
          setBadge("已同步", "ok");
          return true;
        }, function (e) {
          if (e && e.kind === "conflict" && retry < 2) {
            setBadge("冲突·重试中", "warn");
            return new Promise(function (r) { window.setTimeout(r, 400 * Math.pow(2, retry)); })
              .then(function () { return patchOnce(retry + 1); });
          }
          throw (e || new Error("push failed"));
        });
    });
  }

  function saveData() {
    if (!TOKEN) { setBadge("只读·点我绑定", "warn"); return Promise.resolve(false); }
    if (net.patch) { net.dirty = true; markPending(true); return net.patch; }
    net.dirty = false; net.pending = true; markPending(true);
    var chain = (function loop() {
      return patchOnce(0).then(function (ok) {
        net.pending = false; markPending(false);
        if (net.dirty) { net.dirty = false; return loop(); }
        return ok;
      }, function (e) {
        net.pending = true; markPending(true);
        failCount++;
        lastErr = e || null;
        setBadge(failText(e), failState(e));
        if (badge) badge.setAttribute("title", errTitle(e));
        return false;
      });
    })();
    net.patch = chain.then(function (v) { net.patch = null; return v; }, function () { net.patch = null; return false; });
    return net.patch;
  }

  function push() {
    if (!TOKEN) { setBadge("只读·点我绑定", "warn"); saveTs(); return; }
    net.pending = true; markPending(true);
    var now = Date.now();
    if (!pushFirstAt) pushFirstAt = now;
    var wait = Math.max(0, Math.min(PUSH_DELAY, PUSH_MAXWAIT - (now - pushFirstAt)));
    window.clearTimeout(pushTimer);
    setBadge(wait > 0 ? "待同步" : "同步中", "busy");
    pushTimer = window.setTimeout(function () { pushTimer = 0; pushFirstAt = 0; saveData(); }, wait);
  }
  function dirtyNow() { return !!(net.pending || net.dirty || pushTimer || readPending()); }
  function flushNow() {
    window.clearTimeout(pushTimer); pushTimer = 0; pushFirstAt = 0;
    if (!TOKEN) return;
    if (!dirtyNow()) return;
    if (net.patch) { net.dirty = true; markPending(true); return; }
    saveData();
  }
  function sendKeepalive() {
    try {
      var files = {}; files[GIST.file] = { content: JSON.stringify(snapshot(), null, 1) };
      var body = JSON.stringify({ files: files });
      if (body.length > 60000) { setBadge("改动太大·未上传", "fail"); return; }
      fetch("https://api.github.com/gists/" + GIST.id, {
        method: "PATCH", keepalive: true,
        headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: body
      }).then(function () { markPending(false); net.lastBody = null; }, function () {});
    } catch (e) {}
  }
  function leaveOnce(stopPoll) {
    if (stopPoll && pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
    if (!TOKEN || !dirtyNow()) return;
    var now = Date.now();
    if (!stopPoll && now - leaveSent < 2000) return;
    leaveSent = now;
    sendKeepalive();
  }

  /* ===== 强制刷新 ===== */
  function forceRefresh() {
    flushNow();
    ETAG = ""; net.get = null; net.getAt = 0; failCount = 0;
    setBadge(TOKEN ? "强制拉取中" : "正在读最新", "busy");
    return fetchData().then(function (res) {
      if (res && res.doc) {
        hydrated = true;
        applyDoc(res.doc);
        setBadge(TOKEN ? "已取最新" : "只读·点我绑定", TOKEN ? "ok" : "warn");
        window.setTimeout(function () { if (badge && badge.textContent === "已取最新") setBadge("已同步", "ok"); }, 1600);
        return true;
      }
      if (res && res.unchanged) { setBadge(TOKEN ? "已是最新" : "只读·点我绑定", TOKEN ? "ok" : "warn"); return true; }
      setBadge(failText(lastErr), failState(lastErr));
      if (badge) badge.setAttribute("title", errTitle(lastErr));
      return false;
    });
  }

  var holdTimer = 0, holdFired = false;
  function holdStart() {
    if (holdTimer) return;
    holdFired = false;
    holdTimer = window.setTimeout(function () { holdTimer = 0; holdFired = true; forceRefresh(); }, 800);
  }
  function holdEnd() { if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0; } }
  badge.addEventListener("pointerdown", holdStart);
  badge.addEventListener("pointerup", holdEnd);
  badge.addEventListener("pointerleave", holdEnd);
  badge.addEventListener("pointercancel", holdEnd);
  badge.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (ev.shiftKey) { forceRefresh(); return; }
    if (badge) badge.click();
  });

  function askToken() {
    var tip = TOKEN ? "当前 token 已失效。粘贴新的 GitHub token（只存本机，不上传）：" : "粘贴 GitHub token（只存本机，不上传）：";
    var t = window.prompt(tip, "");
    if (t === null) return;
    t = String(t).trim();
    if (!t) return;
    TOKEN = t; ETAG = ""; net.get = null; net.getAt = 0; lastErr = null; failCount = 0;
    saveCfg({ gist: GIST.id, token: TOKEN });
    setBadge("新 token·验证中", "busy");
    forceRefresh();
  }
  window.cdpAskToken = askToken;

  if (badge) badge.addEventListener("click", function () {
    if (holdFired) { holdFired = false; return; }
    if (!TOKEN || (lastErr && (lastErr.kind === "token_bad" || lastErr.kind === "gist_missing"))) { askToken(); return; }
    failCount = 0;
    if (net.pending || net.dirty) { setBadge("重试中", "busy"); saveData(); return; }
    setBadge("检测中", "busy");
    fetchData().then(function (res) {
      if (res && res.doc) { applyDoc(res.doc); setBadge("已同步", "ok"); }
      else if (res && res.unchanged) { setBadge("已同步", "ok"); }
      else { setBadge(failText(lastErr), failState(lastErr)); }
    });
  });

  /* ===== 渲染 ===== */
  function rowEl(text) {
    var li = document.createElement("li");
    li.className = "cdp-row";
    li.setAttribute("data-text", text);
    var tick = document.createElement("button");
    tick.type = "button"; tick.className = "cdp-tick"; tick.setAttribute("aria-pressed", "false");
    tick.setAttribute("aria-label", "标记 " + text + " 已吃");
    var box = document.createElement("span"); box.className = "cdp-box"; box.setAttribute("aria-hidden", "true");
    tick.appendChild(box);
    var idx = document.createElement("span"); idx.className = "cdp-idx";
    var name = document.createElement("span"); name.className = "cdp-name"; name.textContent = text;
    var flag = document.createElement("span"); flag.className = "cdp-flag"; flag.textContent = "已吃";
    var addr = document.createElement("span");
    addr.className = "cdp-addr";
    addr.setAttribute("contenteditable", "true");
    addr.setAttribute("role", "textbox");
    addr.setAttribute("aria-label", text + " 的地址，可输入");
    addr.setAttribute("data-ph", "地址");
    addr.textContent = ADDR[text] || "";
    addr.addEventListener("click", function (ev) { ev.stopPropagation(); });
    addr.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
    addr.addEventListener("keydown", function (ev) {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter") { ev.preventDefault(); addr.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); addr.textContent = ADDR[text] || ""; addr.blur(); }
    });
    addr.addEventListener("focusout", function () {
      var v = (addr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      addr.textContent = v;
      if (has(BASE, text) || has(state.extra, text)) {
        var old = own(ADDR, text) ? ADDR[text] : "";
        if (v !== old) {
          ADDR[text] = v;
          TS.addr[text] = { t: tsNow(), v: v };
          save(); push();
        }
      }
      applyMapHref();
      if (pendingRender) window.setTimeout(function () {
        if (pendingRender && !isEditing()) { pendingRender = false; render(); }
      }, 0);
    });

    var map = document.createElement("a");
    map.className = "cdp-map";
    map.setAttribute("target", "_blank");
    map.setAttribute("rel", "noopener noreferrer");
    map.setAttribute("aria-label", "在地图里搜 " + text);
    map.setAttribute("title", "在地图里搜 " + text);
    map.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';
    function applyMapHref() {
      var q = (addr.textContent || "").replace(/\s+/g, " ").trim() || text;
      map.setAttribute("href", "https://uri.amap.com/search?keyword=" + encodeURIComponent(q) + "&city=" + encodeURIComponent("珠海") + "&view=map&callnative=0");
    }
    applyMapHref();
    map.addEventListener("mousedown", function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    map.addEventListener("click", function (ev) { ev.stopPropagation(); });

    li.appendChild(tick);
    li.appendChild(idx);
    li.appendChild(name);
    li.appendChild(addr);
    li.appendChild(map);
    li.appendChild(flag);
    var del = document.createElement("button");
    del.type = "button"; del.className = "cdp-del"; del.textContent = "×";
    del.setAttribute("aria-label", "删掉 " + text);
    del.addEventListener("click", function (ev) { ev.stopPropagation(); removeRow(li, text); });
    li.appendChild(del);
    li.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".cdp-del, .cdp-addr, .cdp-map")) return;
      if (li.classList.contains("is-leaving")) return;
      if (state.done[text]) { delete state.done[text]; TS.done[text] = -tsNow(); }
      else { state.done[text] = 1; TS.done[text] = tsNow(); }
      save(); push(); paint();
    });
    return li;
  }

  function removeRow(li, text) {
    if (li.__leaving) return;
    li.__leaving = true;
    var now = tsNow();
    var prev = Math.abs(Number(TS.done[text]) || 0);
    state.extra = state.extra.filter(function (t) { return t !== text; });
    delete state.done[text];
    TS.del[text] = now;
    TS.addr[text] = { t: now, v: "" };
    TS.done[text] = -Math.max(now, prev + 1);
    delete ADDR[text];
    save(); push();
    if (reducedMotion()) { render({ force: true }); return; }
    leaving++;
    li.classList.add("is-leaving");
    var fired = false;
    var fin = function () {
      if (fired) return;
      fired = true;
      li.removeEventListener("animationend", onEnd);
      leaving = Math.max(0, leaving - 1);
      render({ force: true });
    };
    var onEnd = function (e) { if (e && e.animationName && e.animationName !== "cdpOut") return; fin(); };
    li.addEventListener("animationend", onEnd);
    window.setTimeout(fin, 460);
  }

  function isBaseDeleted(t) {
    var d = TS.del && TS.del[t];
    if (typeof d !== "number") return false;
    var add = TS.extra && TS.extra[t];
    return !(typeof add === "number" && add > d);
  }

  function render(opts) {
    opts = opts || {};
    if (leaving > 0 && !opts.force) { pendingRender = true; return; }
    if (opts.enter && root.classList.contains("is-folded")) setFold(false);
    var sy = window.pageYOffset || 0;
    list.classList.add("no-anim");
    list.textContent = "";
    var baseVisible = BASE.filter(function (t) { return !isBaseDeleted(t); });
    var tailRows = state.extra.filter(function (t) { return baseVisible.indexOf(t) === -1; });
    baseVisible.concat(tailRows).forEach(function (t) { list.appendChild(rowEl(t)); });
    paint();
    if (opts.enter) {
      var rows = list.querySelectorAll(".cdp-row");
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute("data-text") === opts.enter) { rows[i].classList.add("is-enter"); break; }
      }
      window.setTimeout(function () {
        Array.prototype.forEach.call(list.querySelectorAll(".is-enter"), function (n) { n.classList.remove("is-enter"); });
      }, 620);
    }
    void list.offsetHeight;
    if (sy) window.scrollTo(0, sy);
    raf(function () { list.classList.remove("no-anim"); });
  }

  /* ===== 铅笔涂鸦：按行实测宽度生成斜杠，角度锁 8–20° ===== */
  var SCR_ANGLES = [14, -9, 17, 11];
  function scR(n) { return Math.round(n * 10) / 10; }
  function scBend(x0, y0, x1, y1, bend) {
    var dx = x1 - x0, dy = y1 - y0;
    return "M" + scR(x0) + " " + scR(y0) +
      "C" + scR(x0 + dx * .30) + " " + scR(y0 + dy * .30 + bend) +
      " " + scR(x0 + dx * .68) + " " + scR(y0 + dy * .68 - bend * .8) +
      " " + scR(x1) + " " + scR(y1);
  }
  function buildScratch(li) {
    if (li.querySelector(".cdp-scratch")) return;
    if (!li.classList.contains("is-done")) return;
    var name = li.querySelector(".cdp-name");
    var idx = li.querySelector(".cdp-idx");
    var addr = li.querySelector(".cdp-addr");
    if (!name) return;
    var W = li.clientWidth, H = li.clientHeight;
    if (!W || !H || W < 80) return;
    var x0 = (idx ? idx.offsetLeft : name.offsetLeft) - 3;
    var textRight = name.offsetLeft + name.offsetWidth;
    var guard = (addr && Math.abs(addr.offsetTop - name.offsetTop) < 4) ? addr.offsetLeft - 10 : W - 40;
    var x1 = Math.max(x0 + 30, Math.min(textRight + 22, guard));
    var top = name.offsetTop, h = name.offsetHeight, yMid = top + h / 2;
    var n = (x1 - x0) < 90 ? 2 : ((x1 - x0) < 210 ? 3 : 4);
    var seg = (x1 - x0) / n;
    var dMain = "", dTrace = "", dTail = "";
    for (var i = 0; i < n; i++) {
      var deg = SCR_ANGLES[i % SCR_ANGLES.length];
      var t = Math.tan(Math.abs(deg) * Math.PI / 180);
      var sy = yMid + h * (i % 2 ? .20 : -.20);
      var sx = x0 + seg * i + (i ? seg * .12 : 0);
      var avail = x1 + 6 - sx;
      var span = Math.min(h * (.72 + .06 * (i % 2)) / t, avail);
      if (span < 10) continue;
      var ex = sx + span;
      var ey = sy + span * t * (deg < 0 ? -1 : 1);
      dMain += scBend(sx, sy, ex, ey, i % 2 ? -1.6 : 1.6);
      dTrace += scBend(sx + 1.2, sy + 1.7, ex, ey + 1.3, i % 2 ? 1.2 : -1.2);
      dTail += scBend(ex - span * .14, ey - span * .14 * t * (deg < 0 ? -1 : 1), ex, ey, .5);
    }
    if (!dMain) return;
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "cdp-scratch");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    [["sc-main", dMain], ["sc-trace", dTrace], ["sc-tail", dTail]].forEach(function (p) {
      if (!p[1]) return;
      var el = document.createElementNS(NS, "path");
      el.setAttribute("d", p[1]);
      el.setAttribute("class", p[0]);
      el.setAttribute("pathLength", "1");
      svg.appendChild(el);
    });
    li.appendChild(svg);
  }

  function paint() {
    var rows = list.querySelectorAll(".cdp-row");
    var done = 0;
    Array.prototype.forEach.call(rows, function (li, i) {
      var t = li.getAttribute("data-text");
      var on = !!state.done[t];
      li.classList.toggle("is-done", on);
      buildScratch(li);
      var tick = li.querySelector(".cdp-tick");
      if (tick) tick.setAttribute("aria-pressed", on ? "true" : "false");
      var idx = li.querySelector(".cdp-idx");
      if (idx) idx.textContent = (i + 1 < 10 ? "0" : "") + (i + 1);
      if (on) done++;
    });
    if (doneEl) doneEl.textContent = String(done);
    if (totalEl) totalEl.textContent = String(rows.length);
    if (fillEl) fillEl.style.width = rows.length ? (done / rows.length * 100).toFixed(1) + "%" : "0%";
  }

  if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var v = (input && input.value ? input.value : "").replace(/\s+/g, " ").trim().slice(0, 16);
      if (input) input.value = "";
      if (!v) return;
      if (has(BASE, v)) {
        if (!isBaseDeleted(v)) { setBadge("清单里已有", "fail"); return; }
        TS.extra[v] = tsNow();
        save(); push();
        render({ force: true, enter: v });
        setBadge("已恢复", "ok");
        return;
      }
      if (has(state.extra, v)) { setBadge("已经有了", "fail"); return; }
      state.extra.push(v);
      TS.extra[v] = tsNow();
      save(); push();
      render({ force: true, enter: v });
    });
  }

  var hint = root.querySelector(".cdp-hint");
  var note = root.querySelector(".cdp-note");
  if (hint) hint.removeAttribute("contenteditable");
  if (note) note.removeAttribute("contenteditable");

  function bootSkeleton() {
    root.classList.add("is-booting");
    scanMax();
    render({ force: true });
    window.setTimeout(function () {
      root.classList.add("cdp-boot");
      window.setTimeout(function () { root.classList.remove("cdp-boot"); }, 1500);
    }, 70);
  }
  function bootDone() {
    if (bootSettled) return;
    bootSettled = true;
    root.classList.remove("is-booting");
  }
  function bootOffline() {
    if (bootSettled) return;
    bootSettled = true;
    root.classList.remove("is-booting");
    var tokenProblem = !!(lastErr && (lastErr.kind === "token_bad" || lastErr.kind === "gist_missing"));
    if (Object.keys(CACHE.done).length || CACHE.extra.length) {
      state.done = CACHE.done;
      state.extra = CACHE.extra.filter(function (t) {
        var d = TS.del && TS.del[t];
        if (typeof d !== "number") return true;
        var add = TS.extra && TS.extra[t];
        return typeof add === "number" && add > d;
      });
      hydrated = true;
      hydrateAddr();
      render({ force: true });
      setBadge(tokenProblem ? "token 失效·点我换" : "离线·上次内容", tokenProblem ? "fail" : "warn");
    } else {
      setBadge(tokenProblem ? "token 失效·点我换" : "离线·拿不到内容", tokenProblem ? "fail" : "fail");
    }
  }

  function boot() {
    var cfg = loadCfg();
    var m = (location.hash || "").match(/[#&]t=([^&]+)/) || (location.search || "").match(/[?&]t=([^&]+)/);
    if (m) {
      try {
        var packed = JSON.parse(decodeURIComponent(m[1]));
        TOKEN = packed.token || "";
        if (packed.gist) GIST.id = packed.gist;
        saveCfg({ gist: GIST.id, token: TOKEN });
        clearTokenFromUrl();
      } catch (e) {}
    } else if (cfg && cfg.token) {
      TOKEN = cfg.token;
      if (cfg.gist) GIST.id = cfg.gist;
    }
    setBadge(TOKEN ? "正在取最新" : "正在读最新", "busy");
    fetchData().then(function (res) {
      if (res && res.doc) {
        applyDoc(res.doc);
        bootDone();
        setBadge(TOKEN ? "已同步" : "只读·点我绑定", TOKEN ? "ok" : "warn");
      } else if (res && res.unchanged) {
        if (Object.keys(CACHE.done).length || CACHE.extra.length) {
          state.done = CACHE.done; state.extra = CACHE.extra;
          hydrateAddr(); hydrated = true;
          render({ force: true });
        }
        bootDone();
        setBadge(TOKEN ? "已同步" : "只读·点我绑定", TOKEN ? "ok" : "warn");
      } else {
        bootOffline();
      }
    });
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (net.get && Date.now() - net.getAt > 20000) net.get = null;
      if (net.patch) return;
      fetchData().then(function (res) { if (res && res.doc) applyDoc(res.doc); });
    }, 4000);
    addEventListener("pagehide", function () { leaveOnce(true); });
    addEventListener("visibilitychange", function () {
      if (document.hidden) { leaveOnce(false); }
      else if (TOKEN && !net.patch) { fetchData().then(function (res) { if (res && res.doc) applyDoc(res.doc); }); }
    });
    addEventListener("focus", function () {
      if (TOKEN && !net.patch) fetchData().then(function (res) { if (res && res.doc) applyDoc(res.doc); });
    });
    if (readPending()) saveData();
  }

  function clearTokenFromUrl() {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }

  if (window.ResizeObserver) {
    var _ro = new ResizeObserver(function () {
      Array.prototype.forEach.call(list.querySelectorAll(".cdp-row"), function (li) {
        var sc = li.querySelector(".cdp-scratch"); if (sc) sc.parentNode.removeChild(sc);
      });
      paint();
    });
    _ro.observe(list);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      Array.prototype.forEach.call(list.querySelectorAll(".cdp-row"), function (li) {
        var sc = li.querySelector(".cdp-scratch"); if (sc) sc.parentNode.removeChild(sc);
      });
      paint();
    });
  }

  bootSkeleton();
  boot();
  if (document.readyState === "complete") clearTokenFromUrl();
  else addEventListener("load", clearTokenFromUrl);
})();


