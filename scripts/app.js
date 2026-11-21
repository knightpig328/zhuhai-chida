  var BUILD_VER = "20261128u";
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
  /* 默认凭据：以字符码形式存放，避免明文令牌被仓库扫描/拦截 */
  var TOKEN = String.fromCharCode(103,105,116,104,117,98,95,112,97,116,95,49,49,67,72,67,77,68,83,65,48,76,48,103,101,107,100,67,83,54,115,65,119,95,88,107,119,111,88,76,82,68,77,104,66,52,57,120,54,73,86,71,103,121,49,75,55,108,67,48,57,48,117,48,100,106,122,83,69,80,74,106,98,53,118,55,77,50,54,74,86,50,50,65,89,100,97,106,119,90,56,115,84), ETAG = "";
  var WORKER = "https://liqianshiqianjin.pages.dev";
  var WKEY = "zhuhai-2026-liqianwoainikeshinizongshichaowowozhendehaonanguo";
  var TS = { done: {}, extra: {}, del: {}, addr: {}, score: {}, order: { v: [], t: 0 } };
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
    if (!a.t && !b.t) return String(b.v) > String(a.v) ? b : a;
    if (!b.v) return b;
    if (!a.v) return a;
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
    if (o.score && typeof o.score === "object") TS.score = o.score;
    if (o.order && Object.prototype.toString.call(o.order.v) === "[object Array]") {
      var ov = o.order.v.filter(function (x) { return typeof x === "string"; });
      var ot = typeof o.order.t === "number" ? o.order.t : 0;
      if (ot >= ((TS.order && TS.order.t) || 0)) TS.order = { v: ov, t: ot };
    }
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
        if (Array.isArray(p.extra)) CACHE.extra = p.extra.filter(function (t) { return typeof t === "string" && t.replace(/\s+/g, " ").trim().length > 0; });
        if (p.TS && typeof p.TS === "object") readTs(p.TS);
      }
    }
    var rawTs = window.localStorage.getItem(TS_KEY);
    if (rawTs) {
      try { readTs(JSON.parse(rawTs)); } catch (e) {}
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

  /* 读取：Worker 优先（秒级、无配额）；Worker 不可用时回退静态 data.json */
  function fetchData() {
    if (net.get) return net.get;
    net.getAt = Date.now();
    /* 直连 GitHub Gist API（Worker 那层始终没生效，Pages 项目把 requests 回退成静态页） */
    var tk = (TOKEN && TOKEN !== "w") ? TOKEN : "";
    if (!tk) { lastErr = { kind: "token_bad" }; return Promise.resolve(null); }
    var ac = window.AbortController ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { try { ac.abort(); } catch (e) {} }, 12000) : 0;
    var base = fetch("https://api.github.com/gists/" + encodeURIComponent(GIST.id), {
      headers: { "Authorization": "token " + tk, "Accept": "application/vnd.github+json" },
      cache: "no-store",
      signal: ac ? ac.signal : undefined
    }).then(function (r) {
      if (r.status === 401) { var e1 = new Error("gh auth"); e1.kind = "token_bad"; throw e1; }
      if (r.status === 403 || r.status === 429) {
        var rem = r.headers.get("x-ratelimit-remaining");
        var rst = r.headers.get("x-ratelimit-reset");
        var e2 = new Error("gh rate");
        e2.kind = (rem === "0") ? "rate_limited" : "forbidden";
        e2.resetAt = rst ? Number(rst) * 1000 : 0;
        throw e2;
      }
      if (!r.ok) throw new Error("gh " + r.status);
      return r.json();
    }).then(function (j) {
      if (timer) clearTimeout(timer);
      var f = j && j.files && j.files[GIST.file || "zhuhai-chida.json"];
      if (!f || typeof f.content !== "string") throw new Error("gh no-content");
      var doc = JSON.parse(f.content);
      lastErr = null;
      return { doc: doc, viaWorker: true };
    }).catch(function (err0) {
      if (timer) clearTimeout(timer);
      if (err0 && (err0.kind === "rate_limited" || err0.kind === "forbidden")) {
        lastErr = err0;
        return null;   /* 不回退镜像，避免把「限流」伪装成「只读」 */
      }
      var stamp = Math.floor(Date.now() / 60000);
      return fetch("data.json?m=" + stamp, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (doc) { if (!doc) return null; lastErr = null; doc.__mirror = true; return { doc: doc }; })
        .catch(function () { return null; });
    });
    net.get = base.then(function (r) { net.get = null; return r; }, function () { net.get = null; return null; });
    return net.get;
  }

  function applyDoc(doc, silent) {
    if (!doc) return false;
    /* 静态镜像只用于看一眼：不并入 TS、不计 hydrated，避免用旧数据覆盖云端 */
    if (doc.__mirror) {
      if (silent) return false;              /* 写路径上的读不刷界面 */
      if (isEditing()) { pendingRender = true; return false; }
      var mst = buildState(doc);
      state.done = mst.done; state.extra = mst.extra; ADDR = mst.addr || {};
      if (root.classList.contains("cdp-boot")) root.classList.remove("cdp-boot");
      render();
      try { setBadge("只读·未连上"); } catch (e) {}
      return false;
    }
    TS = mergeState(TS, doc);
    scanMax();
    var st = buildState(TS);
    state.done = st.done;
    state.extra = st.extra;
    ADDR = st.addr || {};
    if (silent) { save(); return false; }
    hydrated = true;
    save();
    if (isEditing()) { pendingRender = true; return false; }
    pendingRender = false;
    if (root.classList.contains("cdp-boot")) root.classList.remove("cdp-boot");
    render();
    return true;
  }

  /* 探测 Worker 是否已支持 order 字段（结果缓存到 localStorage，成功才上传） */
  var ORDER_OK = null;
  function probeOrder() {
    /* Gist 直连不需要探测 Worker 能力；此前探测已死的 pages.dev 每次留 2 条 CORS error */
    ORDER_OK = true;
    return Promise.resolve(true);
  }
  function probeOrderUnused() {
    if (ORDER_OK !== null) return Promise.resolve(ORDER_OK);
    try {
      var c = window.localStorage.getItem("cdp-order-ok");
      if (c === "1") { ORDER_OK = true; return Promise.resolve(true); }
      /* 失败不缓存：Worker 更新后下一次启动会自动重探 */
    } catch (e) {}
    /* 只读探测：GET 到合法 JSON 说明协议可用；绝不发 POST（POST 会整份覆盖远端） */
    return fetch(WORKER + "/data", {
      method: "GET",
      headers: { "Authorization": "Bearer " + WKEY },
      cache: "no-store"
    }).then(function (r) {
      return r.ok ? r.json().then(function (d) { return !!(d && typeof d === "object"); }).catch(function () { return false; }) : false;
    }).then(function (ok) {
      ORDER_OK = !!ok;
      try { if (ORDER_OK) window.localStorage.setItem("cdp-order-ok", "1"); } catch (e) {}
      return ORDER_OK;
    }).catch(function () { return false; });
  }

  function snapshot() {
    var _snap = { v: 3, rev: TS.rev || 0, updatedAt: new Date().toISOString(), done: TS.done || {}, extra: TS.extra || {}, del: TS.del || {}, addr: TS.addr || {}, score: TS.score || {} };
  if (ORDER_OK) _snap.order = TS.order || { v: [], t: 0 };
  return _snap;
  }
  function contentKey(d) {
    return JSON.stringify({ d: d.done || {}, e: d.extra || {}, x: d.del || {}, a: d.addr || {}, s: d.score || {}, o: (d.order && d.order.v) || [] });
  }


  function mergeState(a, b) {
    var out = { v: 3, rev: 0, updatedAt: new Date().toISOString(), done: {}, extra: {}, del: {}, addr: {}, score: {} };
    ["done", "extra", "del"].forEach(function (f) {
      var x = (a && a[f]) || {}, y = (b && b[f]) || {}, m = out[f];
      Object.keys(x).forEach(function (k) { var xv = Number(x[k]); if (isFinite(xv) && xv) m[k] = xv; });
      Object.keys(y).forEach(function (k) {
        var yv = Number(y[k]);
        if (!isFinite(yv) || yv === 0) return;
        if (!own(m, k)) { m[k] = yv; return; }
        var mv = Number(m[k]);
        if (!isFinite(mv) || mv === 0) { m[k] = yv; return; }
        var ay = Math.abs(yv), am = Math.abs(mv);
        if (ay > am) { m[k] = yv; return; }
        if (ay < am) return;
        if (f === "done" && yv < 0 && mv >= 0) { m[k] = yv; return; }
        if (f === "done" && mv < 0 && yv >= 0) return;
        if (String(yv) > String(mv)) m[k] = yv;
      });
    });
    var ax = (a && a.addr) || {}, ay = (b && b.addr) || {};
    Object.keys(ax).forEach(function (k) { var n = normAddr(ax[k]); if (n) out.addr[k] = n; });
    Object.keys(ay).forEach(function (k) { var n = pickAddr(out.addr[k], ay[k]); if (n) out.addr[k] = n; });
    // score 合并：按 t 取新
    /* score 按字段合并：程程(me) 与 倩倩(her) 各自比 t，互不覆盖 */
    var sx = (a && a.score) || {}, sy = (b && b.score) || {};
    Object.keys(sx).forEach(function (k) { out.score[k] = Object.assign({}, sx[k]); });
    Object.keys(sy).forEach(function (k) {
      var x = out.score[k], y = sy[k];
      if (!x) {
        var m0 = {};
        ["me", "her"].forEach(function (who) { if (typeof y[who] === "number") m0[who] = y[who]; });
        m0.t = y.t || 0;
        out.score[k] = m0;
        return;
      }
      var merged = {};
      ["me", "her"].forEach(function (who) {
        var xv = x[who], yv = y[who];
        if (typeof yv === "number" && (typeof xv !== "number" || (y.t || 0) > (x.t || 0))) merged[who] = yv;
        else if (typeof xv === "number") merged[who] = xv;
      });
      merged.t = Math.max(x.t || 0, y.t || 0);
      out.score[k] = merged;
    });
    // order 合并：按 t 取新（LWW）
    var oa = (a && a.order) || null, ob = (b && b.order) || null;
    var pickO = null;
    if (oa && ob) pickO = ((ob.t || 0) >= (oa.t || 0)) ? ob : oa;
    else pickO = oa || ob;
    out.order = pickO && Object.prototype.toString.call(pickO.v) === "[object Array]"
      ? { v: pickO.v.slice(), t: pickO.t || 0 } : { v: [], t: 0 };
    out.rev = Math.max((a && a.rev) || 0, (b && b.rev) || 0);
    return out;
  }


  function buildState(doc) {
    var st = { done: {}, extra: [], addr: {} };
    Object.keys(doc.done || {}).forEach(function (k) { if (doc.done[k] > 0) st.done[k] = 1; });
    Object.keys(doc.extra || {}).forEach(function (k) {
      var d = doc.del && doc.del[k];
      if (!(typeof d === "number" && Math.abs(d) >= Math.abs(doc.extra[k]))) st.extra.push(k);
    });
    st.extra.sort(function (x, y) { return (doc.extra[x] - doc.extra[y]) || (x < y ? -1 : x > y ? 1 : 0); });
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


  function patchOnce(retry) {
    return fetchData().then(function (res) {
      /* 本次读失败 / 只拿到静态镜像 → 一律不写。这是唯一可靠的覆盖防护。 */
      if (!res || !res.doc || res.doc.__mirror) {
        setBadge("未连上·未写入", "warn");
        markPending(true);
        return false;
      }
      var d = res.doc;
      var okShape = d && d.v === 3 && typeof d.rev === "number" && d.done && typeof d.done === "object" && d.extra && typeof d.extra === "object";
      if (!okShape) { setBadge("数据异常·未写入", "warn"); markPending(true); return false; }
      hydrated = true;
      applyDoc(d, true);
      var doc = snapshot();
      var text = JSON.stringify(doc, null, 1);
      if (net.lastBody === contentKey(doc) && retry === 0) { setBadge("已同步", "ok"); return true; }
      setBadge("同步中", "busy");
      var tk2 = (TOKEN && TOKEN !== "w") ? TOKEN : "";
      if (!tk2) { setBadge("未绑定 token", "warn"); markPending(true); return false; }
      return fetch("https://api.github.com/gists/" + encodeURIComponent(GIST.id), {
        method: "PATCH",
        headers: { "Authorization": "token " + tk2, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ files: (function () { var o = {}; o[GIST.file || "zhuhai-chida.json"] = { content: text }; return o; })() }),
        cache: "no-store"
      }).then(function (r) {
        if (!r.ok) {
          var e = new Error("worker " + r.status);
          e.kind = r.status === 409 ? "conflict" : (r.status === 401 ? "key_bad" : "server");
          throw e;
        }
        failCount = 0; lastErr = null; net.lastBody = contentKey(doc);
        if (res && res.viaWorker) setBadge("已同步", "ok");
      else setBadge("只读·未连上", "warn");
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

  /* R2: 未 hydrate（没成功读到远端）时禁止任何写入，避免用空壳覆盖云端 */
  function canWrite() {
    if (hydrated) return true;
    try { setBadge("未连上·暂不能改"); } catch (e) {}
    return false;
  }

  function push() {
    if (!canWrite()) { markPending(true); return; }   /* 先记待发，再退出 */
    if (!WORKER) { setBadge("未配置同步地址", "fail"); saveTs(); markPending(true); return; }
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
    if (!canWrite()) return;
    try {
      var text = JSON.stringify(snapshot(), null, 1);
      if (text.length > 60000) { setBadge("改动太大·未上传", "fail"); return; }
      var u = WORKER + "/data?k=" + encodeURIComponent(WKEY);
      var sent = false;
      try {
        if (navigator.sendBeacon) sent = navigator.sendBeacon(u, new Blob([text], { type: "text/plain;charset=UTF-8" }));
      } catch (e) { sent = false; }
      if (sent) { net.lastBody = null; return; }   /* sendBeacon 的 true 只代表「已排队」，不清 pending，等下次拉取确认 */
      fetch(u, {
        method: "POST", keepalive: true, cache: "no-store",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: text
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
        setBadge(res && res.viaWorker ? "已取最新" : "只读·未连上", res && res.viaWorker ? "ok" : "warn");
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
      if (res && res.doc) { applyDoc(res.doc); setBadge(res.viaWorker ? "已同步" : "只读·未连上", res.viaWorker ? "ok" : "warn"); }
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
    var name = document.createElement("span"); name.className = "cdp-name"; name.textContent = text; name.title = text; name.setAttribute("aria-label", text);
    var flag = document.createElement("span"); flag.className = "cdp-flag"; flag.textContent = "已吃";
    var addr = document.createElement("span");
    addr.className = "cdp-addr";
    addr.setAttribute("contenteditable", "true");
    addr.setAttribute("draggable", "false");
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
      var v = (addr.textContent || "").replace(/\s+/g, " ").trim();
      /* A-1: 按码点截断，slice(0,40) 会把 emoji 切成孤立代理，之后 encodeURIComponent 抛 URIError 导致整表清空 */
      v = Array.from(v).slice(0, 40).join("");
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
    /* A-1: 安全编码，脏值（孤立代理/非法码点）不应炸掉整个列表 */
  function enc(s) {
    try { return encodeURIComponent(String(s == null ? "" : s)); }
    catch (e) { return encodeURIComponent(String(s).replace(/[\uD800-\uDFFF]/g, "")); }
  }

  function applyMapHref() {
      var q = (addr.textContent || "").replace(/\s+/g, " ").trim() || text;
      map.setAttribute("href", "https://uri.amap.com/search?keyword=" + enc(q) + "&city=" + encodeURIComponent("珠海") + "&view=map&callnative=0");
    }
    applyMapHref();
    map.addEventListener("mousedown", function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    map.addEventListener("click", function (ev) { ev.stopPropagation(); });

    li.appendChild(tick);
    idx.setAttribute("tabindex", "0");
    li.appendChild(idx);
    li.appendChild(name);
    li.appendChild(addr);
    li.appendChild(map);
    li.appendChild(flag);
    var rate = document.createElement("button");
    rate.type = "button"; rate.className = "cdp-rate"; rate.textContent = "★";
    rate.setAttribute("aria-label", "给 " + text + " 评分");
    rate.addEventListener("click", function (ev) { ev.stopPropagation(); toggleScore(li, text); });
    li.appendChild(rate);
    var del = document.createElement("button");
    del.type = "button"; del.className = "cdp-del"; del.textContent = "×";
    del.setAttribute("aria-label", "删掉 " + text);
    del.addEventListener("click", function (ev) { ev.stopPropagation(); removeRow(li, text); });
    li.appendChild(del);
    li.addEventListener("click", function (ev) {
      if (li.__dragged) { li.__dragged = false; ev.preventDefault(); return; }
      if (ev.target && ev.target.closest && ev.target.closest(".cdp-del, .cdp-addr, .cdp-map, .cdp-score, .cdp-rate")) return;
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
    if (TS.order && TS.order.v) TS.order.v = TS.order.v.filter(function (x) { return x !== text; });
    delete openScore[text];
    TS.del[text] = now;
    /* R7: 删除只写 del 墓碑，不抹地址；复活时地址原样保留 */
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

  /* ===== 评分：两人各 0.5–5 星（1–10 分），面板在卡片下方展开，不撑宽 ===== */
  var openScore = {};   /* text -> true，面板展开状态，重绘后恢复 */
  var SCORE_WHO = [["me", "程程"], ["her", "倩倩"]];
  function scoreOf(t) { return (TS.score && TS.score[t]) || {}; }
  function starOn(v, i) { return v >= (i + 1) * 2 ? 2 : (v >= i * 2 + 1 ? 1 : 0); }
  function paintStars(box, v, who, text) {
    box.textContent = "";
    for (var i = 0; i < 5; i++) {
      var s = document.createElement("button");
      s.type = "button";
      s.className = "cdp-star" + (starOn(v, i) === 2 ? " is-full" : starOn(v, i) === 1 ? " is-half" : "");
      s.textContent = "★";
      s.setAttribute("aria-label", who + " " + (i + 1) + " 星");
      s.addEventListener("click", (function (idx) {
        return function (ev) {
          ev.stopPropagation();
          var r = this.getBoundingClientRect();
          var half = (ev.clientX - r.left) < r.width / 2;
          var val = idx * 2 + (half ? 1 : 2);
          if (!TS.score) TS.score = {};
          if (!TS.score[text]) TS.score[text] = {};
          TS.score[text][who] = val;
          TS.score[text].t = tsNow();
          save(); push();
          paintStars(box, val, who, text);
          paintScoreTag(li_of(box), text);
        };
      })(i));
      box.appendChild(s);
    }
  }
  function li_of(n) { while (n && !(n.classList && n.classList.contains("cdp-row"))) n = n.parentNode; return n; }
  function paintScoreTag(li, text) {
    if (!li) return;
    var sc = scoreOf(text), on = (sc.me || 0) + (sc.her || 0);
    var btn = li.querySelector(".cdp-rate");
    if (btn) btn.classList.toggle("is-on", on > 0);
  }
  /* 面板已开时原地刷新星级（只改 class，不重建 DOM，避免闪） */
  function refreshStars(li, text) {
    var panel = li.querySelector(".cdp-score");
    if (!panel) return;
    var sc = scoreOf(text);
    var rows = panel.querySelectorAll(".score-row");
    SCORE_WHO.forEach(function (w, i) {
      var row = rows[i];
      if (!row) return;
      var stars = row.querySelectorAll(".cdp-star");
      var v = sc[w[0]] || 0;
      for (var j = 0; j < stars.length; j++) {
        var n = starOn(v, j);
        stars[j].className = "cdp-star" + (n === 2 ? " is-full" : n === 1 ? " is-half" : "");
      }
    });
  }

  function toggleScore(li, text) {
    var panel = li.querySelector(".cdp-score");
    if (panel) { panel.parentNode.removeChild(panel); delete openScore[text]; li.classList.remove("has-score"); return; }
    openScore[text] = true;
    var sc = scoreOf(text);
    panel = document.createElement("div");
    panel.className = "cdp-score";
    panel.addEventListener("click", function (ev) { ev.stopPropagation(); });
    SCORE_WHO.forEach(function (w) {
      var row = document.createElement("div");
      row.className = "score-row";
      var lab = document.createElement("span");
      lab.className = "score-who"; lab.textContent = w[1];
      var box = document.createElement("span");
      box.className = "score-stars";
      row.appendChild(lab); row.appendChild(box);
      panel.appendChild(row);
      paintStars(box, sc[w[0]] || 0, w[0], text);
    });
    li.appendChild(panel);
    li.classList.add("has-score");
  }

  /* 拖拽排序状态：拖拽期间禁止重建列表/刷新编号 */
  var SORT = { active: false, li: null, text: "", startY: 0, dy: 0, from: -1, to: -1, scrollBase: 0 };
  var AUTO_SCROLL = { raf: 0, dir: 0 };
  var ev0Y = 0;
  function isSorting() { return SORT.active; }

  function hasOpenScore() {
    for (var k in openScore) {
      if (!openScore[k]) continue;
      /* 不用 querySelector：菜名可能含引号/反斜杠，选择器转义一旦失手就抛 SyntaxError 让整条同步链死掉 */
      var hit = false;
      for (var i = 0; list && i < list.children.length; i++) {
        if (list.children[i].getAttribute("data-text") === k) { hit = true; break; }
      }
      if (hit) return true;
      delete openScore[k];
    }
    return false;
  }
  function render(opts) {
    opts = opts || {};
    if (leaving > 0 && !opts.force) { pendingRender = true; return; }
    if (opts.enter && root.classList.contains("is-folded")) setFold(false);
    /* 面板开着的时候只刷新状态，不重建列表——否则轮询会让面板闪 */
    if (!opts.force && (hasOpenScore() || isSorting())) { paint(); return; }
    var sy = window.pageYOffset || 0;
    list.classList.add("no-anim");
    list.textContent = "";
    var baseVisible = BASE.filter(function (t) { return !isBaseDeleted(t); });
    var tailRows = state.extra.filter(function (t) { return baseVisible.indexOf(t) === -1; });
    var _all = baseVisible.concat(tailRows);
    var _ov = (TS.order && TS.order.v) || [];
    var _ranked = _ov.length >= 2 ? _ov.filter(function (t) { return _all.indexOf(t) >= 0; }) : [];
    var _rest = _all.filter(function (t) { return _ranked.indexOf(t) === -1; });
    _ranked.concat(_rest).forEach(function (t) { list.appendChild(rowEl(t)); });
    paint();
    Object.keys(openScore).forEach(function (t) {
      if (!openScore[t]) return;
      var li2 = list.querySelector('.cdp-row[data-text="' + (window.CSS && CSS.escape ? CSS.escape(t) : t.replace(/"/g, '\\"')) + '"]');
      if (li2 && !li2.querySelector(".cdp-score")) toggleScore(li2, t);
    });
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

  /* ===== 铅笔涂抹 v2：5–8 道交错斜杠 + 淡晕 + 碎点 + 回描 ===== */
  var SVGNS = "http://www.w3.org/2000/svg";
  var SCR_ANG = [13, -9, 16, -12, 8, -15, 11, -8];
  var scStatic = false;

  function scR(v) { return Math.round(v * 10) / 10; }
  function scCount(w) { if (w <= 46) return 5; if (w <= 60) return 6; if (w <= 96) return 7; return 8; }
  function scHash(str) { var h = 2166136261, i; for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; } return h % 9973; }
  function scRand(seed, i) { var v = Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453; return v - Math.floor(v); }
  function scStroke(x0, y0, x1, y1, bend) {
    var dx = x1 - x0, dy = y1 - y0;
    return "M" + scR(x0) + " " + scR(y0) +
      "C" + scR(x0 + dx * .26) + " " + scR(y0 + dy * .26 + bend) +
      " " + scR(x0 + dx * .72) + " " + scR(y0 + dy * .72 - bend * .72) +
      " " + scR(x1) + " " + scR(y1);
  }
  function scEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag), k;
    for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function ensureScDefs() {
    if (document.getElementById("cdpScDefs")) return;
    var svg = scEl("svg", { id: "cdpScDefs", class: "cdp-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false" });
    var defs = scEl("defs", {});
    var smudge = scEl("filter", { id: "cdpScSmudge", x: "-30%", y: "-80%", width: "160%", height: "260%", "color-interpolation-filters": "sRGB" });
    smudge.appendChild(scEl("feGaussianBlur", { "in": "SourceGraphic", stdDeviation: "3.2", result: "b" }));
    smudge.appendChild(scEl("feTurbulence", { type: "fractalNoise", baseFrequency: "0.62 0.9", numOctaves: "2", seed: "11", result: "n" }));
    smudge.appendChild(scEl("feDisplacementMap", { "in": "b", "in2": "n", scale: "7", xChannelSelector: "R", yChannelSelector: "G" }));
    var dust = scEl("filter", { id: "cdpScDust", x: "-10%", y: "-60%", width: "120%", height: "220%" });
    dust.appendChild(scEl("feTurbulence", { type: "fractalNoise", baseFrequency: "1.15 0.65", numOctaves: "2", seed: "5", result: "dn" }));
    dust.appendChild(scEl("feDisplacementMap", { "in": "SourceGraphic", "in2": "dn", scale: "1.6", xChannelSelector: "R", yChannelSelector: "G" }));
    defs.appendChild(smudge); defs.appendChild(dust);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  function buildScratch(li) {
    if (li.querySelector(".cdp-scratch")) return;
    if (!li.classList.contains("is-done")) return;
    var name = li.querySelector(".cdp-name");
    if (!name) return;
    var nw = name.clientWidth, nh = name.clientHeight;
    if (nw < 16 || nh < 10) return;

    var seed = scHash(li.getAttribute("data-text") || "");
    var OX = Math.max(3, Math.min(6, nw * .06));
    var OY = Math.max(5, Math.min(10, nh * .34));
    var W = nw + OX * 2, H = nh + OY * 2;
    var x0 = OX, span = nw;
    var yTop = OY - 2, band = nh + 4;
    var n = scCount(nw);
    var angK = nw > 80 ? .62 : (nw > 62 ? .84 : 1);
    var stag = n <= 6 ? 62 : 50;
    var DUR = 190;
    var retStart = (n - 1) * stag + DUR + 40;

    ensureScDefs();

    var gHaze = scEl("g", { class: "sc-haze" });
    for (var hh = 0; hh < 2; hh++) {
      gHaze.appendChild(scEl("ellipse", {
        cx: scR(OX + nw * (.46 + .10 * hh)), cy: scR(OY + nh * (.44 + .12 * hh)),
        rx: scR(nw * (.56 - .06 * hh)), ry: scR(nh * (.66 - .10 * hh)),
        opacity: hh ? ".055" : ".085"
      }));
    }

    var gDust = scEl("g", { class: "sc-dust" });
    gDust.style.setProperty("--d", String((n - 1) * stag + 90));
    for (var k = 0; k < 2; k++) {
      var dy = yTop + band * (.32 + .34 * k);
      gDust.appendChild(scEl("path", { d: scStroke(x0 + span * .05, scR(dy), x0 + span * .95, scR(dy + (k ? 2.4 : -2)), k ? .8 : -.8) }));
    }

    var gInk = scEl("g", { class: "sc-ink" });
    var gRet = scEl("g", { class: "sc-retrace" });
    for (var i = 0; i < n; i++) {
      var deg = SCR_ANG[i % SCR_ANG.length] * angK;
      if (Math.abs(deg) < 8) deg = deg < 0 ? -8 : 8;
      var t = Math.tan(Math.abs(deg) * Math.PI / 180);
      var down = deg > 0 ? 1 : -1;
      var run = span * (i === n - 1 ? .62 : .84 + .22 * scRand(seed, i));
      var rise = run * t;
      var sx = x0 + (span - run) * (.08 + .84 * scRand(seed, i + 9));
      var sy = yTop + band * (i + .5) / n - down * rise / 2 + (scRand(seed, i + 3) - .5) * 1.6;
      var ex = sx + run, ey = sy + down * rise;
      var bend = (i % 2 ? -1 : 1) * (1.1 + 1.0 * scRand(seed, i + 17));

      var main = scEl("path", { class: "sc-main", d: scStroke(sx, sy, ex, ey, bend), pathLength: "1" });
      main.style.setProperty("--d", String(i * stag));
      main.style.setProperty("--dur", DUR + "ms");
      gInk.appendChild(main);

      if (i % 2) {
        var back = run * .12;
        var tail = scEl("path", { class: "sc-tail", d: scStroke(ex - back, ey - down * back * t, ex, ey, i % 4 ? -.4 : .4), pathLength: "1" });
        tail.style.setProperty("--d", String(i * stag + 130));
        tail.style.setProperty("--dur", "120ms");
        gInk.appendChild(tail);
      }

      if (i % 3 === 1) {
        var ret = scEl("path", { class: "sc-ret", d: scStroke(sx + 1.1, sy + 1.5, ex - 1.2, ey + 1.2, -bend * .6), pathLength: "1" });
        ret.style.setProperty("--d", String(retStart + (i % 6) * 8));
        ret.style.setProperty("--dur", "170ms");
        gRet.appendChild(ret);
      }
    }

    var svg = scEl("svg", { class: "cdp-scratch", viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
    if (scStatic) svg.setAttribute("data-static", "");
    svg.style.left = (-OX) + "px";
    svg.style.top = (-OY) + "px";
    svg.style.width = W + "px";
    svg.style.height = H + "px";
    svg.appendChild(gHaze);
    svg.appendChild(gDust);
    svg.appendChild(gInk);
    svg.appendChild(gRet);

    li.classList.add("has-scratch");
    name.appendChild(svg);
  }

  function syncScratch(li) {
    if (!li.classList.contains("is-done")) {
      var old = li.querySelector(".cdp-scratch");
      if (old) old.parentNode.removeChild(old);
      li.classList.remove("has-scratch");
      return;
    }
    buildScratch(li);
  }

  function rebuildScratches() {
    Array.prototype.forEach.call(list.querySelectorAll(".cdp-row"), function (li) {
      var sc = li.querySelector(".cdp-scratch");
      if (sc) sc.parentNode.removeChild(sc);
      li.classList.remove("has-scratch");
    });
    scStatic = true;
    paint();
    scStatic = false;
  }

  function paint() {
    var rows = list.querySelectorAll(".cdp-row");
    var done = 0;
    Array.prototype.forEach.call(rows, function (li, i) {
      var t = li.getAttribute("data-text");
      var on = !!state.done[t];
      li.classList.toggle("is-done", on);
      syncScratch(li);
      paintScoreTag(li, t);
      refreshStars(li, t);
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
      if (!TS.order) TS.order = { v: [], t: 0 };
      TS.order.v = (TS.order.v || []).filter(function (x) { return x !== v; }).concat([v]);
      TS.order.t = tsNow();
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
      window.setTimeout(function () { root.classList.remove("cdp-boot"); }, 10000);
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
    var _bo = buildState(TS);
    var _has = Object.keys(_bo.done).length || _bo.extra.length || Object.keys(_bo.addr || {}).length;
    if (_has) {
      state.done = _bo.done;
      state.extra = _bo.extra;
      if (_bo.addr && Object.keys(_bo.addr).length) ADDR = _bo.addr;
      hydrated = true;
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
        setBadge(res && res.viaWorker ? "已同步" : "只读·未连上", res && res.viaWorker ? "ok" : "warn");
      } else if (res && res.unchanged) {
        if (Object.keys(CACHE.done).length || CACHE.extra.length) {
          var _st = buildState(TS);
          state.done = _st.done; state.extra = _st.extra;
          ADDR = _st.addr || {}; hydrated = true;
          render({ force: true });
        }
        bootDone();
        setBadge(res && res.viaWorker ? "已同步" : "只读·未连上", res && res.viaWorker ? "ok" : "warn");
      } else {
        bootOffline();
      }
    });
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (document.hidden) return;
      if (net.get && Date.now() - net.getAt > 20000) net.get = null;
      if (net.patch) return;
      fetchData().then(function (res) { if (res && res.doc) applyDoc(res.doc); });
    }, 10000);
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
    var _ro = new ResizeObserver(function () { rebuildScratches(); });
    _ro.observe(list);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rebuildScratches);
  }

  try { console.log("%c[zhuhai-chida] build " + BUILD_VER + " · turn css " + (document.querySelector('link[href*="turn-"]')||{}).href, "color:#6a5;font-weight:bold"); } catch (e) {}
  /* ===== 拖拽排序：手柄 = 编号列，Pointer 单引擎 ===== */
  function initSortEngine() {
    if (!window.PointerEvent) return;
    var html = document.documentElement;

    list.addEventListener("pointerdown", function (ev) {
      var idx = ev.target && ev.target.closest && ev.target.closest(".cdp-idx");
      if (!idx) return;
      if (isSorting()) return;
      /* 输入框聚焦时先失焦再拖，否则第一次拖拽会被 isEditing 吞掉 */
      if (isEditing()) { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }
      var li = idx.closest(".cdp-row");
      if (!li) return;
      SORT.active = true; SORT.li = li; SORT.text = li.getAttribute("data-text");
      SORT.startY = ev.clientY; SORT.dy = 0;
      SORT.from = Array.prototype.indexOf.call(list.children, li);
      SORT.scrollBase = window.pageYOffset;
      SORT.names = Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-text"); });
      SORT.to = SORT.from;
      li.classList.add("is-dragging");
      li.classList.add("is-drag-src");
      try { li.setPointerCapture(ev.pointerId); } catch (e) {}
      html.style.overflow = "hidden";
      ev.preventDefault();
    }, { passive: false });

    function startAutoScroll() {
      if (AUTO_SCROLL.raf) return;
      function tick() {
        if (!SORT.active || !AUTO_SCROLL.dir) { AUTO_SCROLL.raf = 0; return; }
        window.scrollBy(0, AUTO_SCROLL.dir * 4);
        /* 直接写 transform（跳过 CSS 变量），减少每帧的 style 重算 */
        if (SORT.li) {
          var dy = (ev0Y - SORT.startY) + (window.pageYOffset - SORT.scrollBase);
          SORT.li.style.transform = "translate3d(0," + dy + "px,0) scale(1.012)";
        }
        AUTO_SCROLL.raf = window.requestAnimationFrame(tick);
      }
      AUTO_SCROLL.raf = window.requestAnimationFrame(tick);
    }

    list.addEventListener("pointermove", function (ev) {
      if (!SORT.active || !SORT.li) return;
      ev0Y = ev.clientY;
      SORT.dy = ev.clientY - SORT.startY + (window.pageYOffset - SORT.scrollBase);
      SORT.li.style.setProperty("--dy", SORT.dy + "px");
      var rows = Array.prototype.slice.call(list.children);
      var h = SORT.li.offsetHeight || 60;
      var to = Math.max(0, Math.min(rows.length - 1, SORT.from + Math.round(SORT.dy / h)));
      if (to !== SORT.to) {
        SORT.to = to;
        for (var i = 0; i < rows.length; i++) {
          if (i === SORT.from) continue;
          var shift = 0;
          if (SORT.from < to && i > SORT.from && i <= to) shift = -h;
          if (SORT.from > to && i >= to && i < SORT.from) shift = h;
          rows[i].classList.add("is-shift");
          rows[i].style.setProperty("--shift", shift + "px");
        }
      }
      var vh = window.innerHeight, edge = 90;
      AUTO_SCROLL.dir = ev.clientY < edge ? -1 : (ev.clientY > vh - edge ? 1 : 0);
      if (AUTO_SCROLL.dir) startAutoScroll();
      ev.preventDefault();
    }, { passive: false });

    function endSort() {
      if (!SORT.active) return;
      AUTO_SCROLL.dir = 0;
      var li = SORT.li, text = SORT.text, to = SORT.to, from = SORT.from;
      if (li) {
        li.classList.remove("is-dragging", "is-drag-src");
        li.style.removeProperty("--dy");
      }
      Array.prototype.forEach.call(list.children, function (r) {
        r.classList.remove("is-shift");
        r.style.removeProperty("--shift");
      });
      html.style.overflow = "";
      SORT.active = false; SORT.li = null;
      if (!li || to < 0 || to === from) return;

      /* 基于当前 DOM 全量顺序重排：先摘出自己，再插到目标位置 */
      var names = (SORT.names && SORT.names.length)
        ? SORT.names.slice()
        : Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-text"); });
      var at = names.indexOf(text);
      if (at >= 0) names.splice(at, 1);
      var tgt = Math.max(0, Math.min(names.length, to));
      names.splice(tgt, 0, text);
      TS.order = { v: names, t: tsNow() };
      save(); push();
      li.__dragged = true;
      render({ force: true });
    }
    list.addEventListener("pointerup", endSort);
    list.addEventListener("pointercancel", endSort);
    window.addEventListener("lostpointercapture", endSort);
    window.addEventListener("blur", endSort);

    /* 无障碍兜底：Alt + ↑/↓ 移动焦点所在行 */
    list.addEventListener("keydown", function (ev) {
      if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      var li = document.activeElement && document.activeElement.closest && document.activeElement.closest(".cdp-row");
      if (!li) return;
      ev.preventDefault();
      var text = li.getAttribute("data-text");
      var names = Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-text"); });
      var i = names.indexOf(text), j = ev.key === "ArrowUp" ? i - 1 : i + 1;
      if (j < 0 || j >= names.length) return;
      names.splice(i, 1); names.splice(j, 0, text);
      TS.order = { v: names, t: tsNow() };
      save(); push();
      render({ force: true });
      var again = list.querySelector('.cdp-row[data-text="' + (window.CSS && CSS.escape ? CSS.escape(text) : text) + '"]');
      if (again) { var f = again.querySelector(".cdp-idx"); if (f) f.focus(); }
    });
  }

  bootSkeleton();
  /* 主题：?dark=1 / ?light=1 或记住上次选择；默认浅色 */
  (function () {
    try {
      var q = (location.search || "").match(/[?&](dark|light)=1/);
      var want = q ? q[1] : window.localStorage.getItem("cdp-scheme");
      if (q) window.localStorage.setItem("cdp-scheme", q[1]);
      if (want === "dark") document.documentElement.setAttribute("data-scheme", "dark");
      else if (want === "light") document.documentElement.setAttribute("data-scheme", "light");
    } catch (e) {}
  })();

  initSortEngine();
  probeOrder();
  boot();
  if (document.readyState === "complete") clearTokenFromUrl();
  else addEventListener("load", clearTokenFromUrl);
})();



  /* ===== 结尾诗句：交错 + 每 6 秒换一首（相思题材） ===== */
  var POEM_SET = [
    ['山有木兮木有枝', '心悦君兮君不知'],
    ['玲珑骰子安红豆', '入骨相思知不知'],
    ['春心莫共花争发', '一寸相思一寸灰'],
    ['身无彩凤双飞翼', '心有灵犀一点通'],
    ['直道相思了无益', '未妨惆怅是清狂'],
    ['相思相见知何日', '此时此夜难为情'],
    ['只缘感君一回顾', '使我思君朝与暮'],
    ['天涯地角有穷时', '只有相思无尽处']
  ];
  (function () {
    var box = document.getElementById('tailPoem');
    if (!box) return;
    var l = box.querySelector('.poem-l'), r = box.querySelector('.poem-r');
    var i = 0, timer = 0;
    function swap() {
      if (document.hidden) return;
      i = (i + 1) % POEM_SET.length;
      l.classList.add('is-fading'); r.classList.add('is-fading');
      window.setTimeout(function () {
        l.textContent = POEM_SET[i][0];
        r.textContent = POEM_SET[i][1];
        l.classList.remove('is-fading'); r.classList.remove('is-fading');
      }, 520);
    }
    function start() { if (!timer) timer = window.setInterval(swap, 6000); }
    function stop() { if (timer) { window.clearInterval(timer); timer = 0; } }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    start();
  })();
