/**
 * zhuhai-chida-sync · Cloudflare Workers
 * 路由：GET /data 读；POST /data 写；OPTIONS 预检；GET /healthz 存活
 * 鉴权：Authorization: Bearer <SHARED_KEY> 或 ?k=<SHARED_KEY>
 * 并发：POST 带 If-Match 时先读比对，不一致 409
 */
const DEFAULTS = {
  GIST_ID: "4bb6f3b536c05a65de7132179a8826e9",
  GIST_FILE: "zhuhai-chida.json",
  ALLOWED_ORIGINS: "https://knightpig328.github.io",
  MAX_BYTES: 262144
};
const GH_API = "https://api.github.com";
const GH_HEADERS = {
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "zhuhai-chida-sync-worker"
};
const DOC_KEYS = ["v", "rev", "updatedAt", "done", "extra", "del", "addr", "score", "order"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = readCfg(env);
    const origin = request.headers.get("Origin") || "";
    const originAllowed = !origin || cfg.origins.indexOf(origin) !== -1;
    if (request.method === "OPTIONS") return preflight(origin, originAllowed, cfg);
    const path = normPath(url.pathname);
    if (path === "/healthz") return json({ ok: true }, 200, null, origin, cfg);
    if (path !== "/" && path !== "/data") return fail(404, "not_found", "只支持 GET/POST / 与 /data", origin, cfg);
    if (!originAllowed) return fail(403, "forbidden", "Origin 不在白名单", origin, cfg);
    if (!cfg.token) return fail(500, "server", "服务端未配置 GIST_TOKEN", origin, cfg);
    if (!cfg.sharedKey) return fail(500, "server", "服务端未配置 SHARED_KEY", origin, cfg);
    const given = readKey(request, url);
    if (!(await sameKey(given, cfg.sharedKey))) return fail(401, "key_bad", "共享密钥缺失或错误", origin, cfg);
    if (request.method === "GET") return handleGet(request, url, cfg, origin);
    if (request.method === "POST") return handlePost(request, url, cfg, origin);
    return fail(405, "method_not_allowed", "只支持 GET / POST / OPTIONS", origin, cfg);
  }
};

async function handleGet(request, url, cfg, origin) {
  const g = await ghGet(cfg);
  if (!g.ok) return fail(g.status, g.kind, g.message, origin, cfg);
  const file = g.file;
  if (!file) return fail(404, "gist_missing", "Gist 里没有目标文件", origin, cfg);
  if (file.truncated) return fail(502, "upstream", "上游文件被截断", origin, cfg);
  const body = typeof file.content === "string" ? file.content : "";
  const hash = (await sha256Hex(body)).slice(0, 32);
  const etag = '"' + hash + '"';
  const probe = normEtag(url.searchParams.get("h") || request.headers.get("If-None-Match") || "");
  const h = corsHeaders(origin, cfg);
  h.set("ETag", etag);
  h.set("X-Content-Hash", hash);
  h.set("Cache-Control", "no-store");
  if (g.etag) h.set("X-Github-Etag", g.etag);
  if (probe && probe === hash) { h.set("X-Unchanged", "1"); return new Response(null, { status: 204, headers: h }); }
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status: 200, headers: h });
}

async function handlePost(request, url, cfg, origin) {
  let raw = "";
  try { raw = await request.text(); } catch (e) { return fail(400, "invalid", "读取请求体失败", origin, cfg); }
  raw = raw.replace(/^\uFEFF/, "");
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes === 0) return fail(422, "invalid", "请求体为空", origin, cfg);
  if (bytes > cfg.maxBytes) return fail(413, "invalid", "内容超过上限", origin, cfg);

  const picked = extractContent(raw, request.headers.get("Content-Type") || "");
  const check = validateDoc(picked.text);
  if (!check.ok) return fail(422, "invalid", check.message, origin, cfg);

  const ifMatch = normEtag(request.headers.get("If-Match") || "");
  if (ifMatch) {
    const g = await ghGet(cfg);
    if (!g.ok) return fail(g.status, g.kind, g.message, origin, cfg);
    const cur = g.file && typeof g.file.content === "string" ? (await sha256Hex(g.file.content)).slice(0, 32) : "";
    if (cur && cur !== ifMatch) return fail(409, "conflict", "内容已被别处修改", origin, cfg, { "X-Content-Hash": cur });
  }

  const hash = (await sha256Hex(picked.text)).slice(0, 32);
  if (url.searchParams.get("dry") === "1") return json({ ok: true, dry: true, bytes: bytes, rev: check.rev, hash: hash }, 200, null, origin, cfg);

  const w = await ghPatch(cfg, picked.text);
  if (!w.ok) return fail(w.status, w.kind, w.message, origin, cfg);

  const h = corsHeaders(origin, cfg);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("ETag", '"' + hash + '"');
  h.set("X-Content-Hash", hash);
  return new Response(JSON.stringify({ ok: true, bytes: bytes, rev: check.rev, hash: hash }), { status: 200, headers: h });
}

function extractContent(raw, ct) {
  if (!/application\/json/i.test(ct)) return { text: raw };
  let o; try { o = JSON.parse(raw); } catch (e) { return { text: raw }; }
  if (o && typeof o === "object" && typeof o.content === "string") return { text: o.content };
  return { text: raw };
}

function validateDoc(text) {
  let o; try { o = JSON.parse(text); } catch (e) { return { ok: false, message: "请求体不是合法 JSON" }; }
  if (!isPlainObject(o)) return { ok: false, message: "顶层必须是 JSON 对象" };
  if (o.files || o.description) return { ok: false, message: "请直接发送文件内容本身" };
  const unknown = Object.keys(o).filter(k => DOC_KEYS.indexOf(k) === -1);
  if (unknown.length) return { ok: false, message: "未知字段：" + unknown.join(",") };
  if (typeof o.v !== "number" || !Number.isFinite(o.v)) return { ok: false, message: "缺少数值字段 v" };
  if (o.rev !== undefined && (typeof o.rev !== "number" || !Number.isFinite(o.rev))) return { ok: false, message: "rev 必须是数字" };
  for (const f of ["done", "extra", "del"]) {
    if (o[f] === undefined) continue;
    if (!isPlainObject(o[f])) return { ok: false, message: f + " 必须是对象" };
    const ks = Object.keys(o[f]);
    if (ks.length > 5000) return { ok: false, message: f + " 条目过多" };
    for (const k of ks) if (typeof o[f][k] !== "number" || !Number.isFinite(o[f][k])) return { ok: false, message: f + "[" + k + "] 必须是数字" };
  }
  if (o.addr !== undefined) {
    if (!isPlainObject(o.addr)) return { ok: false, message: "addr 必须是对象" };
    const ks = Object.keys(o.addr);
    if (ks.length > 5000) return { ok: false, message: "addr 条目过多" };
    for (const k of ks) {
      const v = o.addr[k];
      if (typeof v === "string") continue;
      if (isPlainObject(v) && typeof v.v === "string" && (v.t === undefined || (typeof v.t === "number" && Number.isFinite(v.t)))) continue;
      return { ok: false, message: "addr[" + k + "] 格式不对" };
    }
  }
  if (o.order !== undefined) {
    if (!isPlainObject(o.order)) return { ok: false, message: "order 必须是对象 {v:[],t:0}" };
    if (!Array.isArray(o.order.v)) return { ok: false, message: "order.v 必须是字符串数组" };
    if (o.order.v.length > 5000) return { ok: false, message: "order.v 条目过多" };
    for (const x of o.order.v) {
      if (typeof x !== "string" || !x || x.length > 64) return { ok: false, message: "order.v 每项必须是 1-64 字字符串" };
    }
    if (o.order.t !== undefined && (typeof o.order.t !== "number" || !Number.isFinite(o.order.t))) {
      return { ok: false, message: "order.t 必须是有限数字" };
    }
  }
  return { ok: true, rev: typeof o.rev === "number" ? o.rev : 0 };
}

async function ghGet(cfg) {
  let r;
  try {
    r = await fetch(GH_API + "/gists/" + encodeURIComponent(cfg.gistId), {
      method: "GET", headers: Object.assign({ Authorization: "Bearer " + cfg.token }, GH_HEADERS), cache: "no-store"
    });
  } catch (e) { return { ok: false, status: 502, kind: "offline", message: "连不上 GitHub" }; }
  if (!r.ok) return Object.assign({ ok: false }, mapGh(r.status, r.headers, await safeText(r)));
  let j; try { j = await r.json(); } catch (e) { return { ok: false, status: 502, kind: "upstream", message: "GitHub 返回非 JSON" }; }
  const file = j && j.files ? j.files[cfg.gistFile] : null;
  return { ok: true, file: file || null, etag: r.headers.get("etag") || "" };
}

async function ghPatch(cfg, text) {
  const body = { files: {} };
  body.files[cfg.gistFile] = { content: text };
  let r;
  try {
    r = await fetch(GH_API + "/gists/" + encodeURIComponent(cfg.gistId), {
      method: "PATCH",
      headers: Object.assign({ Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" }, GH_HEADERS),
      body: JSON.stringify(body), cache: "no-store"
    });
  } catch (e) { return { ok: false, status: 502, kind: "offline", message: "连不上 GitHub" }; }
  if (!r.ok) return Object.assign({ ok: false }, mapGh(r.status, r.headers, await safeText(r)));
  return { ok: true };
}

function mapGh(status, headers, txt) {
  const msg = pickGhMessage(txt);
  if (status === 401) return { status: 502, kind: "upstream_auth", message: "Worker 的 GIST_TOKEN 无效" };
  if (status === 403) {
    if (headers.get("x-ratelimit-remaining") === "0") return { status: 429, kind: "rate_limited", message: "GitHub 限流" };
    return { status: 502, kind: "upstream", message: "GitHub 拒绝访问：" + msg };
  }
  if (status === 404) return { status: 404, kind: "gist_missing", message: "Gist 不存在或无权限" };
  if (status === 409) return { status: 409, kind: "conflict", message: "上游冲突" };
  if (status === 422) return { status: 422, kind: "invalid", message: "GitHub 拒绝内容：" + msg };
  if (status === 429) return { status: 429, kind: "rate_limited", message: "GitHub 限流" };
  if (status >= 500) return { status: 502, kind: "server", message: "GitHub 服务器 " + status };
  return { status: 502, kind: "upstream", message: "GitHub HTTP " + status };
}

function pickGhMessage(txt) { try { const j = JSON.parse(txt); return String((j && j.message) || "").slice(0, 160); } catch (e) { return String(txt || "").slice(0, 160); } }
async function safeText(r) { try { return await r.text(); } catch (e) { return ""; } }

function readCfg(env) {
  const e = env || {};
  const pick = (v, d) => (v === undefined || v === null || v === "") ? d : String(v);
  const num = (v, d) => { const n = parseInt(String(v === undefined || v === null ? "" : v), 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    gistId: pick(e.GIST_ID, DEFAULTS.GIST_ID),
    gistFile: pick(e.GIST_FILE, DEFAULTS.GIST_FILE),
    origins: String(pick(e.ALLOWED_ORIGINS, DEFAULTS.ALLOWED_ORIGINS)).split(",").map(x => x.trim()).filter(Boolean),
    maxBytes: num(e.MAX_BYTES, DEFAULTS.MAX_BYTES),
    token: typeof e.GIST_TOKEN === "string" ? e.GIST_TOKEN.trim() : "",
    sharedKey: typeof e.SHARED_KEY === "string" ? e.SHARED_KEY.trim() : ""
  };
}
function normPath(p) { let s = String(p || "/").replace(/\/{2,}/g, "/"); if (s.length > 1) s = s.replace(/\/+$/, ""); return s || "/"; }
function readKey(request, url) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1].trim();
  const k = url.searchParams.get("k");
  return k ? k.trim() : "";
}
async function sameKey(given, expect) {
  if (!given || !expect) return false;
  const a = await sha256Hex(given), b = await sha256Hex(expect);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}
function normEtag(v) { return String(v === undefined || v === null ? "" : v).trim().replace(/^W\//i, "").replace(/^"/, "").replace(/"$/, "").trim(); }
function isPlainObject(x) { return !!x && typeof x === "object" && !Array.isArray(x); }
function corsHeaders(origin, cfg) {
  const h = new Headers();
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match, If-Match, Accept");
  h.set("Access-Control-Expose-Headers", "ETag, X-Content-Hash, X-Unchanged, X-Github-Etag, Retry-After");
  h.set("Access-Control-Max-Age", "600");
  if (origin && cfg.origins.indexOf(origin) !== -1) h.set("Access-Control-Allow-Origin", origin);
  return h;
}
function preflight(origin, ok, cfg) {
  if (!ok) return new Response("origin not allowed", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: 204, headers: corsHeaders(origin, cfg) });
}
function json(obj, status, extra, origin, cfg) {
  const h = corsHeaders(origin, cfg);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  if (extra) for (const k in extra) h.set(k, String(extra[k]));
  return new Response(JSON.stringify(obj), { status, headers: h });
}
function fail(status, kind, message, origin, cfg, extra) {
  const e = Object.assign({}, extra || {});
  if (status === 429) e["Retry-After"] = "30";
  return json({ error: kind, message: String(message || "").slice(0, 200) }, status, e, origin, cfg);
}
