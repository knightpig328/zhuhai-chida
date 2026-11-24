  var BUILD_VER = "20261130l";
  var DATA_V = 5;   /* 数据结构版本：v5 = items 叶子对象 + 叶子路径 PATCH */
(function () {
  var root = document.getElementById("cdp");
  if (!root) return;

  /* =====================================================================
     数据结构 v5（为什么推倒重来）
     ---------------------------------------------------------------------
     v4 的病根是「整份文档 PUT 覆盖整棵子树」：
       - PUT = 替换整棵子树（含所有子节点），旧客户端一提交就把 delT/rosterT
         这类版本字段归零，别人的改动整片消失；
       - Firebase 没有原生数组，order.v 每次整份写就是把「顺序」当文档级
         事实来抢，两台设备必然互相清空；
       - 写子节点会重建父节点，所以「真删」必然复活，只能留墓碑。

     v5 的规矩：
       meta:  { v:5, minV:4, updatedAt:<ms> }
       items/<id>: { cid, name, ord, done, doneAt, rating, ratingAt,
                     addr, addrAt, del, delAt }
       - 所有写都是叶子路径 PATCH（一次多路径，Firebase 保证原子）；
       - 删除 = del:true + delAt 墓碑，永不删节点；
       - ord 用中点值插入，太挤才整表重排（一次 PATCH 8 条，原子）；
       - done 与 doneAt 拆开：正负号塞一个数字的写法在叶子写里无法原子表达
         「谁更晚」，拆成布尔 + 绝对毫秒，叶子各写各的，最后写者胜。
       - <id> = fbKey(菜名)：菜名照旧当 key，但 Firebase 不允许 . # $ [ ] /
         和空串 / . / ..，这些换成全角同形字；真名永远在 item.name 里。
     ===================================================================== */

  var FB = "https://liqianshiqianjin-default-rtdb.asia-southeast1.firebasedatabase.app";
  var DOC_PATH = "/zhuhai-chida";
  var DOC_URL = FB + DOC_PATH + ".json";
  var SCHEMA_V = DATA_V, MIN_V = 4;

  var UI_KEY = "cdp-ui-v5";          /* 只存界面偏好（折叠状态），不存列表数据 */
  var SCHEME_KEY = "cdp-scheme";     /* 深浅色 */

  var list = document.getElementById("cdp-list");
  var form = document.getElementById("cdp-form");
  var input = document.getElementById("cdp-input");
  var doneEl = document.getElementById("cdp-done");
  var totalEl = document.getElementById("cdp-total");
  var fillEl = document.getElementById("cdp-fill");

  /* HTML 底表菜名：只作「云端 items 变空」时的异常判定，不再当渲染依据 */
  var BASE = [];
  if (list) Array.prototype.forEach.call(list.querySelectorAll(".cdp-row"), function (row) {
    var t = row.getAttribute("data-text");
    if (t && BASE.indexOf(t) === -1) BASE.push(t);
    row.removeAttribute("contenteditable");
  });

  var raf = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : function (fn) { return window.setTimeout(fn, 16); };
  var mqReduce = null;
  try { mqReduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null; } catch (e) {}
  function reducedMotion() { return !!(mqReduce && mqReduce.matches); }

  /* ===== 本地状态 ===== */
  var ITEMS = {};                    /* id -> item 记录（远端读回的结果 + 待发改动的叠加层） */
  var META = null;                   /* 远端 meta */
  var READONLY = false;              /* v4 / 异常文档：只读 */
  var hydrated = false;              /* 成功读到过 v5 才允许写 */
  var PENDING = {};                  /* 叶子路径 -> 值：还没发出去的意图 */
  var net = { get: null, flushing: null };
  var flushTimer = 0, flushFirstAt = 0, failCount = 0, lastErr = null;
  var refreshTimer = 0, staleAgain = false;
  var PATCH_DELAY = 300, PATCH_MAXWAIT = 1200;
  var pendingRender = false, leaving = 0, maxTs = 0;
  var sse = null, sseRetry = 0;
  var bootSettled = false;

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function has(arr, v) { return arr.indexOf(v) !== -1; }
  function num0(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function str0(v) { return typeof v === "string" ? v : ""; }
  function tsNow() { var t = Math.max(Date.now(), maxTs + 1); maxTs = t; return t; }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* A-1: 安全编码，脏值（孤立代理/非法码点）不应炸掉整个列表 */
  function enc(s) {
    try { return encodeURIComponent(String(s == null ? "" : s)); }
    catch (e) { return encodeURIComponent(String(s).replace(/[\uD800-\uDFFF]/g, "")); }
  }

  /* ===== Firebase key =====
     非法字符 . # $ [ ] / 换成全角同形字；空串 / . / .. 也非法。
     与 scripts/migrate-v5.mjs 的 fbKey() 必须保持同一套映射。 */
  var KEY_MAP = { ".": "．", "#": "＃", "$": "＄", "[": "［", "]": "］", "/": "／" };
  function fbKey(name) {
    var s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    if (!s) return "item";
    s = s.replace(/[.#$\[\]\/]/g, function (c) { return KEY_MAP[c]; });
    s = Array.from(s).slice(0, 120).join("");     /* 单段 key < 768 字节，120 字符足够 */
    if (s === "." || s === "..") s = s.replace(/\./g, "．");
    return s;
  }
  function uniqueKey(base) {
    if (!own(ITEMS, base)) return base;
    var i = 2;
    while (own(ITEMS, base + "~" + i)) i++;
    return base + "~" + i;
  }

  /* ===== item 记录 ===== */
  function normalizeItem(id, raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    var rec = {
      id: id,
      cid: str0(raw.cid),
      name: str0(raw.name) || id,
      ord: num0(raw.ord),
      done: raw.done === true,
      doneAt: num0(raw.doneAt),
      rating: num0(raw.rating),
      ratingAt: num0(raw.ratingAt),
      addr: str0(raw.addr),
      addrAt: num0(raw.addrAt),
      del: raw.del === true,
      delAt: num0(raw.delAt)
    };
    if (typeof raw.ratingMe === "number" && isFinite(raw.ratingMe)) rec.ratingMe = raw.ratingMe;
    if (typeof raw.ratingHer === "number" && isFinite(raw.ratingHer)) rec.ratingHer = raw.ratingHer;
    return rec;
  }
  function blankItem(id, name, ord) {
    return normalizeItem(id, { cid: "", name: name, ord: ord, done: false, doneAt: 0, rating: 0, ratingAt: 0, addr: "", addrAt: 0, del: false, delAt: 0 });
  }
  function itemOf(id) { return own(ITEMS, id) ? ITEMS[id] : null; }

  /* 可见条目：墓碑不显示；按 ord 升序，同 ord 用名字兜底 */
  function visibleItems() {
    var out = [];
    Object.keys(ITEMS).forEach(function (id) {
      var it = ITEMS[id];
      if (!it || it.del) return;
      out.push(it);
    });
    out.sort(function (a, b) {
      var d = a.ord - b.ord;
      if (d) return d;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }
  function maxOrd() {
    var m = 0;
    Object.keys(ITEMS).forEach(function (id) { var o = num0(ITEMS[id].ord); if (o > m) m = o; });
    return m;
  }

  /* ===== 文档版本判定（okShape 接受 v4 与 v5） ===== */
  function docVersion(doc) {
    if (!doc || typeof doc !== "object") return 0;
    if (doc.meta && typeof doc.meta === "object" && num0(doc.meta.v) >= DATA_V && doc.items && typeof doc.items === "object") return DATA_V;
    if (doc.v === 3 || doc.v === 4) return 4;
    if (doc.done && typeof doc.done === "object" && doc.extra && typeof doc.extra === "object") return 4;
    if (doc.items && typeof doc.items === "object") return DATA_V;
    return 0;
  }

  /* v4 文档 → 只读视图（兼容期用：老数据在、迁移还没跑时能看不能改） */
  function legacyToItems(doc) {
    var out = {};
    if (!doc || typeof doc !== "object") return out;
    var order = doc.order && Object.prototype.toString.call(doc.order.v) === "[object Array]" ? doc.order.v.filter(function (x) { return typeof x === "string" && x; }) : [];
    var extra = doc.extra && typeof doc.extra === "object" ? doc.extra : {};
    var roster = order.slice();
    Object.keys(extra).sort(function (a, b) { return num0(extra[a]) - num0(extra[b]); }).forEach(function (n) {
      if (!has(roster, n)) roster.push(n);
    });
    var done = doc.done && typeof doc.done === "object" ? doc.done : {};
    var del = doc.del && typeof doc.del === "object" ? doc.del : {};
    var addr = doc.addr && typeof doc.addr === "object" ? doc.addr : {};
    var score = doc.score && typeof doc.score === "object" ? doc.score : {};
    var used = {};
    roster.forEach(function (name, i) {
      var id = fbKey(name);
      while (own(used, id)) id = id + "~2";
      used[id] = 1;
      var signed = Number(done[name]) || 0;
      var a = addr[name];
      var av = "", at = 0;
      if (typeof a === "string") av = a;
      else if (a && typeof a === "object" && typeof a.v === "string") { av = a.v; at = num0(a.t); }
      var sc = score[name] && typeof score[name] === "object" ? score[name] : {};
      var vals = [];
      if (typeof sc.me === "number") vals.push(sc.me);
      if (typeof sc.her === "number") vals.push(sc.her);
      var d = num0(del[name]);
      var rec = blankItem(id, name, i + 1);
      rec.done = signed > 0;
      rec.doneAt = signed ? Math.abs(signed) : 0;
      rec.rating = vals.length ? round1(vals.reduce(function (x, y) { return x + y; }, 0) / vals.length) : 0;
      rec.ratingAt = num0(sc.t);
      if (typeof sc.me === "number") rec.ratingMe = sc.me;
      if (typeof sc.her === "number") rec.ratingHer = sc.her;
      rec.addr = av; rec.addrAt = at;
      rec.del = d > 0; rec.delAt = d > 0 ? d : 0;
      out[id] = rec;
    });
    /* 墓碑里的菜名也进视图（del:true → 不显示），保证删除状态不丢 */
    Object.keys(del).forEach(function (name) {
      if (has(roster, name)) return;
      var id = fbKey(name);
      if (own(out, id)) return;
      var rec = blankItem(id, name, roster.length + Object.keys(out).length + 1);
      rec.del = true; rec.delAt = num0(del[name]);
      out[id] = rec;
    });
    return out;
  }

  /* ===== 站点角标 ===== */
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

  /* ===== 失败分类 ===== */
  var FAIL_TXT = {
    offline: "离线·已存本机意图", timeout: "超时·重试中", conflict: "冲突·重试中",
    forbidden: "无写权限", invalid: "内容被拒", server: "数据库服务器问题",
    upstream: "连不上数据库", http: "同步失败"
  };
  var FAIL_STATE = { offline: "warn", timeout: "warn", conflict: "warn", server: "warn", upstream: "warn" };
  function failText(e) { return FAIL_TXT[(e && e.kind) || "http"] || FAIL_TXT.http; }
  function failState(e) { return FAIL_STATE[(e && e.kind) || "http"] || "fail"; }
  function errTitle(e) {
    if (!e) return "同步状态";
    return failText(e) + (e.msg ? "｜" + String(e.msg).slice(0, 70) : "") + (e.code ? "｜HTTP " + e.code : "");
  }
  function classify(r, txt) {
    if (r.status === 401) return "forbidden";
    if (r.status === 403) return "forbidden";
    if (r.status === 409) return "conflict";
    if (r.status === 412) return "conflict";
    if (r.status === 422) return "invalid";
    if (r.status >= 500) return "server";
    return "http";
  }
  function mkErr(r, txt) {
    var e = new Error("http " + r.status);
    e.code = r.status;
    e.kind = classify(r, txt);
    var m = "";
    try { m = (JSON.parse(txt) || {}).error || ""; } catch (x) { m = String(txt || "").slice(0, 110); }
    e.msg = m;
    return e;
  }

  /* ===== 书页开合（折叠状态是唯一进 localStorage 的东西之一） ===== */
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
  function setFold(on, persist) {
    if (on) root.classList.add("is-folded"); else root.classList.remove("is-folded");
    foldBtn.setAttribute("aria-expanded", on ? "false" : "true");
    foldTxt.textContent = on ? "翻开菜单" : "收起菜单";
    if (on) { try { list.setAttribute("inert", ""); } catch (e) {} }
    else { try { list.removeAttribute("inert"); } catch (e) {} }
    if (persist) { try { window.localStorage.setItem(UI_KEY, JSON.stringify({ fold: !!on })); } catch (e) {} }
  }
  foldBtn.addEventListener("click", function () { setFold(!root.classList.contains("is-folded"), true); });

  /* ===== 读：REST GET（?r= 破 Firebase/CDN 缓存） ===== */
  var readSeq = 0, appliedSeq = 0;
  function fetchDoc() {
    if (net.get) return net.get;
    var seq = ++readSeq;
    var ac = window.AbortController ? new AbortController() : null;
    var timer = ac ? window.setTimeout(function () { try { ac.abort(); } catch (e) {} }, 12000) : 0;
    var url = DOC_URL + "?r=" + Date.now();
    var p = fetch(url, {
      cache: "no-store",
      headers: { "Accept": "application/json" },
      signal: ac ? ac.signal : undefined
    }).then(function (r) {
      if (timer) window.clearTimeout(timer);
      if (!r.ok) { var e0 = new Error("read " + r.status); e0.code = r.status; e0.kind = classify(r, ""); throw e0; }
      return r.text();
    }).then(function (t) {
      var doc = t ? JSON.parse(t) : null;
      lastErr = null;
      return { doc: doc, seq: seq };
    }, function (err0) {
      if (timer) window.clearTimeout(timer);
      var e = err0 || new Error("network");
      if (!e.kind) e.kind = (e.name === "AbortError") ? "timeout" : "offline";
      lastErr = e;
      return null;
    });
    net.get = p.then(function (r) { net.get = null; return r; }, function () { net.get = null; return null; });
    return net.get;
  }

  /* 乱序返回保护：先发的读可能后到，晚到的旧快照不许覆盖新状态 */
  function applyRead(res, silent) {
    if (!res) return false;
    if (typeof res.seq === "number") {
      if (res.seq < appliedSeq) return false;
      appliedSeq = res.seq;
    }
    return applyDoc(res.doc, silent);
  }

  /* ===== 实时层：Firebase REST 的 EventSource 长连接 =====
     任何变更都只做一件事：重读整份文档（8 条菜，几十字节，代价可忽略）。
     合并逻辑全部搬到了服务端 —— 叶子写谁最后写谁赢，客户端不再自己算时间戳战争。 */
  function startSSE() {
    if (!window.EventSource) return;
    try { if (sse) sse.close(); } catch (e) {}
    try { sse = new EventSource(DOC_URL); } catch (e) { return; }
    function onEvt() { scheduleRefresh(); }
    sse.addEventListener("put", onEvt);
    sse.addEventListener("patch", onEvt);
    sse.onopen = function () { sseRetry = 0; };
    sse.onerror = function () {
      sseRetry++;
      if (sseRetry >= 2) setBadge("连接断了·重连中", "warn");
      scheduleRefresh();
    };
  }
  function scheduleRefresh() {
    if (isEditing() || isSorting() || net.flushing) { staleAgain = true; return; }
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(function () {
      refreshTimer = 0;
      net.get = null;
      fetchDoc().then(function (r) { if (r && r.doc) applyRead(r, true); else if (r === null) setBadge(failText(lastErr), failState(lastErr)); });
    }, 350);
  }

  /* ===== 应用远端文档 ===== */
  function applyDoc(doc, silent) {
    var v = docVersion(doc);
    META = doc && doc.meta && typeof doc.meta === "object" ? doc.meta : null;

    if (v === DATA_V) {
      READONLY = false;
      var items = {};
      Object.keys(doc.items || {}).forEach(function (id) {
        if (!id) return;
        items[id] = normalizeItem(id, doc.items[id]);
      });
      /* 云端突然空了但底表还有菜 —— 宁可只读报警，也不要静默抹掉清单 */
      if (!Object.keys(items).length && BASE.length) {
        READONLY = true; hydrated = false;
        setBadge("数据异常·未写入", "warn");
      }
      ITEMS = items;
      applyOverlay();
      hydrated = !READONLY;
      if (silent && (isEditing() || isSorting())) { pendingRender = true; return false; }
      pendingRender = false;
      if (READONLY) { render({ force: true }); return false; }
      render();
      if (!dirtyNow()) setBadge("已同步", "ok");
      return true;
    }

    if (v === 4) {
      /* 兼容期：老文档只读 + 角标提示。绝不写 —— 写就等于把 v5 打回 v4。 */
      READONLY = true; hydrated = false;
      ITEMS = legacyToItems(doc);
      applyOverlay();
      if (silent && (isEditing() || isSorting())) { pendingRender = true; return false; }
      render({ force: true });
      setBadge("旧版本·请刷新升级", "warn");
      return false;
    }

    READONLY = true; hydrated = false;
    setBadge("数据异常·未写入", "warn");
    return false;
  }

  /* ===== 写：叶子路径 PATCH =====
     一次多路径 body：{"items/<id>/done": true, "items/<id>/doneAt": 123, "meta/updatedAt": 123}
     Firebase 对 PATCH 的语义是「只碰点名路径，且原子（要么全成要么全败）」。 */
  function itemPath(id, field) { return "items/" + id + "/" + (field || ""); }

  function dirtyNow() { return Object.keys(PENDING).length > 0; }

  function applyOverlay() {
    Object.keys(PENDING).forEach(function (p) {
      var seg = p.split("/");
      if (seg[0] !== "items") return;
      var id = seg[1];
      if (seg.length === 2) {
        var rec = PENDING[p];
        if (rec && typeof rec === "object") ITEMS[id] = normalizeItem(id, rec);
        else if (rec === null) delete ITEMS[id];
        return;
      }
      if (seg.length === 3) {
        if (!ITEMS[id]) ITEMS[id] = blankItem(id, id, 0);
        ITEMS[id][seg[2]] = PENDING[p];
      }
    });
  }

  function canWrite() {
    if (READONLY) { setBadge("旧版本·请刷新升级", "warn"); return false; }
    if (!hydrated) { setBadge("未连上·暂不能改", "warn"); return false; }
    return true;
  }

  /* 把改动塞进待发队列（PENDING 同时也是乐观层的叠加） */
  function enqueue(patch) {
    if (!canWrite()) return false;
    Object.keys(patch).forEach(function (p) { PENDING[p] = patch[p]; });
    applyOverlay();
    scheduleFlush();
    return true;
  }

  function scheduleFlush() {
    if (!dirtyNow()) return;
    var now = Date.now();
    if (!flushFirstAt) flushFirstAt = now;
    var wait = Math.max(0, Math.min(PATCH_DELAY, PATCH_MAXWAIT - (now - flushFirstAt)));
    if (flushTimer) window.clearTimeout(flushTimer);
    setBadge(wait > 0 ? "待同步" : "同步中", "busy");
    flushTimer = window.setTimeout(function () { flushTimer = 0; flushNow(false); }, wait);
  }

  function flushNow(keepalive) {
    if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
    /* v4 / 未连上时绝不发 PATCH：否则会把 meta/v=5 盖到 v4 文档上，旧客户端读不懂 */
    if (READONLY || !hydrated) return Promise.resolve(false);
    if (!dirtyNow()) return Promise.resolve(true);
    if (net.flushing) return net.flushing;
    flushFirstAt = 0;

    var paths = Object.keys(PENDING);
    var body = {};
    paths.forEach(function (p) { body[p] = PENDING[p]; });
    /* 每次写都顺带把 meta 钉在 v5：任何一次 PATCH 都让文档自证版本 */
    body["meta/v"] = DATA_V;
    body["meta/minV"] = MIN_V;
    body["meta/updatedAt"] = Date.now();

    var ac = window.AbortController ? new AbortController() : null;
    var timer = ac ? window.setTimeout(function () { try { ac.abort(); } catch (e) {} }, 12000) : 0;
    setBadge("同步中", "busy");

    var p = fetch(DOC_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      keepalive: !!keepalive,
      signal: ac ? ac.signal : undefined
    }).then(function (r) {
      if (timer) window.clearTimeout(timer);
      if (r.status === 412 || r.status === 409) { var ec = new Error("conflict"); ec.kind = "conflict"; throw ec; }
      if (!r.ok) return r.text().then(function (txt) { throw mkErr(r, txt); }, function () { throw mkErr(r, ""); });
      /* 只清掉「这批发出去的值没被新意图覆盖」的路径 */
      paths.forEach(function (pth) { if (own(PENDING, pth) && PENDING[pth] === body[pth]) delete PENDING[pth]; });
      failCount = 0; lastErr = null;
      if (!dirtyNow()) { setBadge("已同步", "ok"); if (staleAgain) { staleAgain = false; scheduleRefresh(); } }
      return true;
    }, function (err0) {
      if (timer) window.clearTimeout(timer);
      var e = err0 || new Error("patch failed");
      if (e.name === "AbortError" || e.code === "timeout") e.kind = "timeout";
      if (!e.kind) e.kind = "offline";
      throw e;
    });

    net.flushing = p.then(function (v) {
      net.flushing = null;
      if (dirtyNow()) scheduleFlush();
      return v;
    }, function (e) {
      net.flushing = null;
      failCount++;
      lastErr = e || null;
      setBadge(failText(e), failState(e));
      if (badge) badge.setAttribute("title", errTitle(e));
      /* 待发改动留在队列里，退避重试；用户在页面上再点一下也会立刻重试 */
      var back = Math.min(8000, 600 * Math.pow(2, Math.min(4, failCount - 1)));
      window.setTimeout(function () { if (dirtyNow() && !net.flushing) flushNow(false); }, back);
      return false;
    });
    return net.flushing;
  }

  /* 离页保底：keepalive PATCH，同样只发叶子路径，绝不整份 PUT */
  function sendKeepalive() {
    if (!dirtyNow() || READONLY || !hydrated) return;
    try {
      var body = {};
      Object.keys(PENDING).forEach(function (p) { body[p] = PENDING[p]; });
      body["meta/v"] = DATA_V;
      body["meta/updatedAt"] = Date.now();
      fetch(DOC_URL, {
        method: "PATCH", keepalive: true, cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function () { Object.keys(PENDING).forEach(function (p) { delete PENDING[p]; }); }, function () {});
    } catch (e) {}
  }

  /* ===== 业务操作：每个都只改自己那几个叶子 ===== */
  function setDone(id, on) {
    var it = itemOf(id);
    if (!it) return false;
    if (!canWrite()) return false;
    var t = tsNow();
    var patch = {};
    patch["items/" + id + "/done"] = !!on;
    patch["items/" + id + "/doneAt"] = t;
    if (!enqueue(patch)) return false;
    if (it) { it.done = !!on; it.doneAt = t; }
    paint();
    return true;
  }

  function setAddr(id, v) {
    var it = itemOf(id);
    if (!it) return false;
    v = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    v = Array.from(v).slice(0, 40).join("");     /* 按码点截断，避免切出孤立代理 */
    if (v === (it.addr || "")) return false;
    if (!canWrite()) return false;
    var t = tsNow();
    var patch = {};
    patch["items/" + id + "/addr"] = v;
    patch["items/" + id + "/addrAt"] = t;
    if (!enqueue(patch)) return false;
    it.addr = v; it.addrAt = t;
    return true;
  }

  function scoreOf(id) {
    var it = itemOf(id);
    if (!it) return {};
    var out = { t: num0(it.ratingAt) };
    if (typeof it.ratingMe === "number") out.me = it.ratingMe;
    if (typeof it.ratingHer === "number") out.her = it.ratingHer;
    /* 迁移只给出单值 rating 的条目：两人面板都显示这个值，不假装有第二个人打过分 */
    if (typeof out.me !== "number" && !own(out, "her") && it.rating) out.me = it.rating;
    if (typeof out.her !== "number" && !own(out, "me") && it.rating) out.her = it.rating;
    return out;
  }

  function setRating(id, who, val) {
    var it = itemOf(id);
    if (!it) return false;
    if (!canWrite()) return false;
    var me = who === "me" ? val : (typeof it.ratingMe === "number" ? it.ratingMe : undefined);
    var her = who === "her" ? val : (typeof it.ratingHer === "number" ? it.ratingHer : undefined);
    var vals = [];
    if (typeof me === "number") vals.push(me);
    if (typeof her === "number") vals.push(her);
    var avg = vals.length ? round1(vals.reduce(function (x, y) { return x + y; }, 0) / vals.length) : 0;
    var t = tsNow();
    var patch = {};
    patch["items/" + id + "/" + (who === "me" ? "ratingMe" : "ratingHer")] = val;
    patch["items/" + id + "/rating"] = avg;
    patch["items/" + id + "/ratingAt"] = t;
    if (!enqueue(patch)) return false;
    if (who === "me") it.ratingMe = val; else it.ratingHer = val;
    it.rating = avg; it.ratingAt = t;
    return true;
  }

  /* 新增：整条 item 写成一个子节点（不是整份文档） */
  function addItem(name) {
    var v = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    v = Array.from(v).slice(0, 16).join("");
    if (!v) return "empty";
    if (!canWrite()) return "readonly";
    var id = fbKey(v);
    var old = itemOf(id);
    if (old && !old.del) return "exists";
    if (old && old.del) {
      /* 墓碑复活：只翻 del，不重建记录（地址/评分原样留着） */
      var t0 = tsNow();
      var p0 = {};
      p0["items/" + id + "/del"] = false;
      p0["items/" + id + "/delAt"] = t0;
      if (!enqueue(p0)) return "readonly";
      old.del = false; old.delAt = t0;
      render({ force: true, enter: id });
      return "restored";
    }
    id = uniqueKey(id);
    var rec = blankItem(id, v, maxOrd() + 1000);
    var pn = {};
    pn["items/" + id] = rec;
    if (!enqueue(pn)) return "readonly";
    ITEMS[id] = rec;
    render({ force: true, enter: id });
    return "added";
  }

  /* 删除：墓碑，不真删节点 */
  function removeItem(id) {
    var it = itemOf(id);
    if (!it) return false;
    if (!canWrite()) return false;
    var t = tsNow();
    var patch = {};
    patch["items/" + id + "/del"] = true;
    patch["items/" + id + "/delAt"] = t;
    if (!enqueue(patch)) return false;
    it.del = true; it.delAt = t;
    return true;
  }

  /* 撤销删除 / 复活：只翻 del，地址与评分原样还在 */
  function restoreItem(id) {
    var it = itemOf(id);
    if (!it || !it.del) return false;
    if (!canWrite()) return false;
    var t = tsNow();
    var patch = {};
    patch["items/" + id + "/del"] = false;
    patch["items/" + id + "/delAt"] = t;
    if (!enqueue(patch)) return false;
    it.del = false; it.delAt = t;
    return true;
  }

  /* 中点值：把条目插到 a、b 之间。返回 null = 空隙太挤，调用方应整表重排 */
  function ordBetween(a, b) {
    if (typeof a !== "number" || !isFinite(a)) a = 0;
    if (typeof b !== "number" || !isFinite(b)) b = a + 1000;
    var gap = b - a;
    if (!(gap > 0.0001)) return null;
    return Math.round((a + gap / 2) * 1e6) / 1e6;
  }

  /* 找出「被移动的那一条」：把它摘掉、按其目标下标插回，能复原新顺序才算。
     （不能只看第一个错位元素 —— 把末条拖到首位时第一个错位的其实是原首条，
       那样算出来的 ord 会让顺序错位。）找不到唯一解 = 多点位移，直接整表重排。 */
  function findMoved(visIds, orderedIds) {
    if (visIds.length !== orderedIds.length) return null;
    for (var i = 0; i < visIds.length; i++) {
      var cand = visIds[i];
      var rest = visIds.slice(0, i).concat(visIds.slice(i + 1));
      var tgt = orderedIds.indexOf(cand);
      if (tgt < 0) continue;
      var attempt = rest.slice(0, tgt).concat([cand], rest.slice(tgt));
      if (attempt.join("\u0000") === orderedIds.join("\u0000")) return cand;
    }
    return null;
  }

  /* 拖拽落地：先试中点值，太挤就整表重排（一次 PATCH 全量 ord，原子） */
  function commitOrder(orderedIds) {
    if (!canWrite()) return false;
    var vis = visibleItems();
    if (vis.length < 2) return false;
    var visIds = vis.map(function (it) { return it.id; });
    if (visIds.join("\u0000") === orderedIds.join("\u0000")) return false;   /* 没变 */
    var ordOf = {};
    vis.forEach(function (it) { ordOf[it.id] = it.ord; });
    var moved = findMoved(visIds, orderedIds);

    var mid = null;
    if (moved !== null) {
      var pos = orderedIds.indexOf(moved);
      var prev = pos > 0 ? ordOf[orderedIds[pos - 1]] : null;
      var next = pos < orderedIds.length - 1 ? ordOf[orderedIds[pos + 1]] : null;
      if (prev === null && next === null) mid = 1000;
      else if (prev === null) mid = num0(next) - 1000;          /* 插到最前 */
      else if (next === null) mid = num0(prev) + 1000;          /* 插到最后 */
      else mid = ordBetween(prev, next);                        /* 中间取中点 */
    }

    if (mid !== null && moved !== null) {
      var pm = {};
      pm["items/" + moved + "/ord"] = mid;
      if (!enqueue(pm)) return false;
      if (ITEMS[moved]) ITEMS[moved].ord = mid;
      return true;
    }
    /* 整表重排：8 条一次 update = 一次原子 PATCH，顺带把间距重新拉开 */
    var patch = {};
    orderedIds.forEach(function (id, i2) { patch["items/" + id + "/ord"] = (i2 + 1) * 1000; });
    if (!enqueue(patch)) return false;
    orderedIds.forEach(function (id, i3) { if (ITEMS[id]) ITEMS[id].ord = (i3 + 1) * 1000; });
    return true;
  }

  /* ===== 渲染前的小工具 ===== */
  function isEditing() {
    var a = document.activeElement;
    if (!a || a === document.body) return false;
    if (a === input) return true;
    try { return !!(a.isContentEditable && root.contains(a)); } catch (e) { return false; }
  }

  /* ===== 行 DOM（结构与 class 与 v4 保持一致，CSS 那路不必跟着改） ===== */
  function rowEl(it) {
    var text = it.name, id = it.id;
    var li = document.createElement("li");
    li.className = "cdp-row";
    li.setAttribute("data-text", text);
    li.setAttribute("data-id", id);
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
    addr.textContent = it.addr || "";
    addr.addEventListener("click", function (ev) { ev.stopPropagation(); });
    addr.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
    addr.addEventListener("keydown", function (ev) {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter") { ev.preventDefault(); addr.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); addr.textContent = (itemOf(id) || {}).addr || ""; addr.blur(); }
    });
    addr.addEventListener("focusout", function () {
      try { addr.scrollLeft = 0; } catch (e) {}     /* 失焦后从头显示，而不是停在末尾 */
      var v = Array.from((addr.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 40).join("");
      addr.textContent = v;
      var cur = itemOf(id);
      if (cur && v !== (cur.addr || "")) {
        if (setAddr(id, v)) setBadge(dirtyNow() ? "待同步" : "已同步", dirtyNow() ? "busy" : "ok");
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
    rate.addEventListener("click", function (ev) { ev.stopPropagation(); toggleScore(li, id, text); });
    li.appendChild(rate);
    var del = document.createElement("button");
    del.type = "button"; del.className = "cdp-del"; del.textContent = "×";
    del.setAttribute("aria-label", "删掉 " + text);
    del.addEventListener("click", function (ev) { ev.stopPropagation(); removeRow(li, id); });
    /* 记录按下位置与时刻，供下面的 click 容差判断使用 */
    li.addEventListener("pointerdown", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".cdp-del, .cdp-addr, .cdp-map, .cdp-rate")) { li.__downX = null; return; }
      li.__downX = ev.clientX || 0; li.__downY = ev.clientY || 0; li.__downT = Date.now();
    }, true);
    li.appendChild(del);
    li.addEventListener("click", function (ev) {
      if (li.__dragged) { li.__dragged = false; ev.preventDefault(); return; }
      /* 位移/时长容差：轻扫 2~12px 或长按都会被浏览器算成 click，
         直接把「已吃」翻掉并写远端（2026-11-24 实测 3×4px 就误勾）。
         没有位移记录的 click（键盘/读屏）照常放行。 */
      if (typeof li.__downX === "number") {
        var ddx = Math.abs((ev.clientX || 0) - li.__downX);
        var ddy = Math.abs((ev.clientY || 0) - li.__downY);
        var dtms = Date.now() - (li.__downT || 0);
        if (ddx > 10 || ddy > 10 || dtms > 600) { li.__downX = null; return; }
        li.__downX = null;
      }
      if (ev.target && ev.target.closest && ev.target.closest(".cdp-del, .cdp-addr, .cdp-map, .cdp-score, .cdp-rate")) return;
      if (li.classList.contains("is-leaving")) return;
      var cur = itemOf(id);
      if (!cur) return;
      if (setDone(id, !cur.done)) paint();
    });
    return li;
  }

  function removeRow(li, id) {
    if (li.__leaving) return;
    var cur = itemOf(id);
    if (!cur) return;
    if (!removeItem(id)) return;
    setBadge(dirtyNow() ? "待同步" : "已同步", dirtyNow() ? "busy" : "ok");
    li.__leaving = true;
    delete openScore[id];
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

  /* ===== 评分：两人各 0.5–5 星（1–10 分），面板在卡片下方展开，不撑宽 ===== */
  var openScore = {};   /* id -> true，面板展开状态，重绘后恢复 */
  var SCORE_WHO = [["me", "程程"], ["her", "倩倩"]];
  function starOn(v, i) { return v >= (i + 1) * 2 ? 2 : (v >= i * 2 + 1 ? 1 : 0); }
  function paintStars(box, v, who, id, text) {
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
          /* 键盘/辅助技术触发 click 时 clientX 恒为 0，会一律判成半星；这种来源按整星处理 */
          var half = ev.clientX > 0 ? ((ev.clientX - r.left) < r.width / 2) : false;
          var val = idx * 2 + (half ? 1 : 2);
          if (!setRating(id, who, val)) return;
          setBadge(dirtyNow() ? "待同步" : "已同步", dirtyNow() ? "busy" : "ok");
          paintStars(box, val, who, id, text);
          paintScoreTag(li_of(box), id);
        };
      })(i));
      box.appendChild(s);
    }
  }
  function li_of(n) { while (n && !(n.classList && n.classList.contains("cdp-row"))) n = n.parentNode; return n; }
  function paintScoreTag(li, id) {
    if (!li) return;
    var sc = scoreOf(id), on = (sc.me || 0) + (sc.her || 0);
    var btn = li.querySelector(".cdp-rate");
    if (btn) btn.classList.toggle("is-on", on > 0);
  }
  /* 面板已开时原地刷新星级（只改 class，不重建 DOM，避免闪） */
  function refreshStars(li, id) {
    var panel = li.querySelector(".cdp-score");
    if (!panel) return;
    var sc = scoreOf(id);
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

  function toggleScore(li, id, text) {
    var panel = li.querySelector(".cdp-score");
    if (panel) { panel.parentNode.removeChild(panel); delete openScore[id]; li.classList.remove("has-score"); return; }
    openScore[id] = true;
    var sc = scoreOf(id);
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
      paintStars(box, sc[w[0]] || 0, w[0], id, text);
    });
    li.appendChild(panel);
    li.classList.add("has-score");
  }

  /* 拖拽排序状态：拖拽期间禁止重建列表/刷新编号 */
  var SORT = { active: false, li: null, id: "", startY: 0, dy: 0, from: -1, to: -1, scrollBase: 0, ids: [] };
  var AUTO_SCROLL = { raf: 0, dir: 0 };
  var ev0Y = 0;
  function isSorting() { return SORT.active; }

  function hasOpenScore() {
    for (var k in openScore) {
      if (!openScore[k]) continue;
      var hit = false;
      for (var i = 0; list && i < list.children.length; i++) {
        if (list.children[i].getAttribute("data-id") === k) { hit = true; break; }
      }
      if (hit) return true;
      delete openScore[k];
    }
    return false;
  }

  function render(opts) {
    opts = opts || {};
    if (leaving > 0 && !opts.force) { pendingRender = true; return; }
    if (opts.enter && root.classList.contains("is-folded")) setFold(false, false);
    /* 面板开着的时候只刷新状态，不重建列表——否则远端变更会让面板闪 */
    var _ok = visibleItems().map(function (it) { return it.id + ":" + it.ord; }).join("|");
    var _orderChanged = (_ok !== (window.__lastOrderKey || ""));
    window.__lastOrderKey = _ok;
    if (!opts.force && isSorting()) { paint(); return; }
    if (!opts.force && hasOpenScore() && !_orderChanged) { paint(); return; }
    var sy = window.pageYOffset || 0;
    list.classList.add("no-anim");
    list.textContent = "";
    visibleItems().forEach(function (it) { list.appendChild(rowEl(it)); });
    paint();
    Object.keys(openScore).forEach(function (id) {
      if (!openScore[id]) return;
      for (var i = 0; list && i < list.children.length; i++) {
        var li2 = list.children[i];
        if (li2.getAttribute("data-id") === id && !li2.querySelector(".cdp-score")) {
          toggleScore(li2, id, li2.getAttribute("data-text"));
          break;
        }
      }
    });
    if (opts.enter) {
      var rows = list.querySelectorAll(".cdp-row");
      for (var k = 0; k < rows.length; k++) {
        if (rows[k].getAttribute("data-id") === opts.enter) { rows[k].classList.add("is-enter"); break; }
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

    var seed = scHash(li.getAttribute("data-id") || li.getAttribute("data-text") || "");
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
      var id = li.getAttribute("data-id");
      var it = itemOf(id);
      var on = !!(it && it.done);
      li.classList.toggle("is-done", on);
      syncScratch(li);
      paintScoreTag(li, id);
      refreshStars(li, id);
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
      var v = input && input.value ? input.value : "";
      if (input) input.value = "";
      if (!v.replace(/\s+/g, " ").trim()) return;
      var r = addItem(v);
      if (r === "exists") { setBadge("清单里已有", "fail"); return; }
      if (r === "readonly") return;
      if (r === "restored") { setBadge("已恢复", "ok"); return; }
    });
  }

  var hint = root.querySelector(".cdp-hint");
  var note = root.querySelector(".cdp-note");
  if (hint) hint.removeAttribute("contenteditable");
  if (note) note.removeAttribute("contenteditable");

  /* ===== 强制刷新 ===== */
  function forceRefresh() {
    flushNow(false);
    net.get = null; failCount = 0;
    setBadge("正在读最新", "busy");
    return fetchDoc().then(function (res) {
      if (res && res.doc) { applyRead(res); return true; }
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

  if (badge) badge.addEventListener("click", function () {
    if (holdFired) { holdFired = false; return; }
    failCount = 0;
    if (dirtyNow()) { setBadge("重试中", "busy"); flushNow(false); return; }
    setBadge("检测中", "busy");
    fetchDoc().then(function (res) {
      if (res && res.doc) applyRead(res);
      else setBadge(failText(lastErr), failState(lastErr));
    });
  });

  /* ===== 启动 ===== */
  function bootSkeleton() {
    root.classList.add("is-booting");
    render({ force: true });
    window.setTimeout(function () {
      root.classList.add("cdp-boot");
      window.setTimeout(function () { root.classList.remove("cdp-boot"); }, 3000);
    }, 70);
  }
  function bootDone() {
    if (bootSettled) return;
    bootSettled = true;
    root.classList.remove("is-booting");
  }

  function restoreFold() {
    try {
      var raw = window.localStorage.getItem(UI_KEY);
      if (!raw) return;
      var u = JSON.parse(raw);
      if (u && u.fold) setFold(true, false);
    } catch (e) {}
  }

  function boot() {
    restoreFold();
    setBadge("正在读最新", "busy");
    fetchDoc().then(function (res) {
      if (res && res.doc) {
        applyRead(res);
        bootDone();
      } else {
        bootDone();
        setBadge("离线·拿不到内容", "warn");
      }
    });
    addEventListener("pagehide", function () { sendKeepalive(); });
    addEventListener("visibilitychange", function () {
      if (document.hidden) { sendKeepalive(); }
      else if (!net.flushing) { net.get = null; fetchDoc().then(function (res) { if (res && res.doc) applyRead(res, true); }); }
    });
    addEventListener("focus", function () {
      if (!net.flushing) { net.get = null; fetchDoc().then(function (res) { if (res && res.doc) applyRead(res, true); }); }
    });
    addEventListener("online", function () { if (dirtyNow()) flushNow(false); });
  }

  if (window.ResizeObserver) {
    var _ro = new ResizeObserver(function () { rebuildScratches(); });
    _ro.observe(list);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rebuildScratches);
  }

  try { console.log("%c[zhuhai-chida] build " + BUILD_VER + " · data v" + DATA_V + " · 写路径=PATCH 叶子 · turn css " + (document.querySelector('link[href*="turn-"]') || {}).href, "color:#6a5;font-weight:bold"); } catch (e) {}

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
      SORT.active = true; SORT.li = li; SORT.id = li.getAttribute("data-id");
      SORT.startY = ev.clientY; SORT.dy = 0;
      SORT.from = Array.prototype.indexOf.call(list.children, li);
      SORT.scrollBase = window.pageYOffset;
      SORT.ids = Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-id"); });
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
      var li = SORT.li, id = SORT.id, to = SORT.to, from = SORT.from;
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
      var ids = (SORT.ids && SORT.ids.length)
        ? SORT.ids.slice()
        : Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-id"); });
      var at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      var tgt = Math.max(0, Math.min(ids.length, to));
      ids.splice(tgt, 0, id);
      commitOrder(ids);
      setBadge(dirtyNow() ? "待同步" : "已同步", dirtyNow() ? "busy" : "ok");
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
      var id = li.getAttribute("data-id");
      var ids = Array.prototype.map.call(list.children, function (r) { return r.getAttribute("data-id"); });
      var i = ids.indexOf(id), j = ev.key === "ArrowUp" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      ids.splice(i, 1); ids.splice(j, 0, id);
      commitOrder(ids);
      render({ force: true });
      for (var k = 0; list && k < list.children.length; k++) {
        if (list.children[k].getAttribute("data-id") === id) {
          var f = list.children[k].querySelector(".cdp-idx");
          if (f) f.focus();
          break;
        }
      }
    });
  }

  bootSkeleton();
  /* 主题：?dark=1 / ?light=1 或记住上次选择；默认浅色 */
  (function () {
    try {
      var q = (location.search || "").match(/[?&](dark|light)=1/);
      var want = q ? q[1] : window.localStorage.getItem(SCHEME_KEY);
      if (q) window.localStorage.setItem(SCHEME_KEY, q[1]);
      if (want === "dark") document.documentElement.setAttribute("data-scheme", "dark");
      else if (want === "light") document.documentElement.setAttribute("data-scheme", "light");
    } catch (e) {}
  })();

  initSortEngine();
  startSSE();
  boot();

  /* ===== 对外稳定 API（给上层 UI 用；不要直接摸 ITEMS / PENDING） =====
     l3-ux 的「撤销浮条」等按旧结构 TS.del[text] 写的代码，一律改成调这里：
       cdp.restore(id)  撤销删除（墓碑翻回 del:false）
       cdp.remove(id)   删除（写墓碑）
       cdp.setDone / setAddr / setRating / addItem / commitOrder
       cdp.items()      取只读快照
       cdp.flush()      立刻把待发改动发出去 */
  try {
    window.cdp = {
      setDone: setDone, setAddr: setAddr, setRating: setRating,
      addItem: addItem, remove: removeItem, restore: restoreItem,
      commitOrder: commitOrder, scoreOf: scoreOf,
      items: function () {
        var out = {};
        Object.keys(ITEMS).forEach(function (id) { var o = {}; for (var k in ITEMS[id]) o[k] = ITEMS[id][k]; out[id] = o; });
        return out;
      },
      item: itemOf,
      flush: flushNow,
      version: DATA_V
    };
  } catch (e) {}

  /* ===== 自测钩子（只在挂测试桩时暴露；生产不写任何 DOM 之外的东西） ===== */
  if (window.__CDP_TEST__) {
    window.__cdpTest = {
      DATA_V: DATA_V,
      fbKey: fbKey,
      uniqueKey: uniqueKey,
      ordBetween: ordBetween,
      docVersion: docVersion,
      legacyToItems: legacyToItems,
      normalizeItem: normalizeItem,
      visibleItems: visibleItems,
      items: function () { return ITEMS; },
      pending: function () { return PENDING; },
      flags: function () { return { readonly: READONLY, hydrated: hydrated, dirty: dirtyNow() }; },
      badgeText: function () { return badge ? badge.textContent : ""; },
      applyDoc: function (doc) { return applyDoc(doc); },
      setDone: setDone,
      setAddr: setAddr,
      setRating: setRating,
      addItem: addItem,
      removeItem: removeItem,
      commitOrder: commitOrder,
      flushNow: flushNow,
      scoreOf: scoreOf
    };
  }
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
