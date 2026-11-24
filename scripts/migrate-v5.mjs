#!/usr/bin/env node
/* ============================================================================
   migrate-v5.mjs —— 珠海大吃特吃 · v4 文档 → v5 结构迁移
   ----------------------------------------------------------------------------
   默认 dry-run：只读云端 + 打印「现有 v4 会变成什么样」，不写任何远端数据。
   加 --apply 才真正写云端（写前必须人工确认；写前先存原始 JSON 备份）。

   用法：
     node scripts/migrate-v5.mjs                    # dry-run（默认）
     node scripts/migrate-v5.mjs --apply            # 真写云端（幂等保护）
     node scripts/migrate-v5.mjs --from=snap.json   # 用本地快照演练，不联网

   可选参数：
     --url=<base>          Firebase RTDB 根，默认生产库
     --root=/zhuhai-chida  文档路径
     --backup-dir=..\_backup-v5   原始 JSON 备份目录（相对本脚本的上一级）
     --tombstone-orphans  给「有 done 键但不在清单里」的孤儿菜建墓碑
     --include-base       把 index.html 底表里有、云端清单没有的菜也补进 items
     --keep-legacy        apply 时保留 v4 旧字段（默认写 null 清掉，防旧客户端复活）
     --force              已经是 v5 也照跑
     --quiet              只打印摘要与错误

   v5 目标结构：
     zhuhai-chida/
       meta:  { v:5, minV:4, updatedAt:<ms> }
       items/
         <id>: { cid, name, ord, done, doneAt, rating, ratingAt,
                 addr, addrAt, del, delAt }
   说明：
     - <id> = fbKey(菜名)：菜名里的 . # $ [ ] / 换成全角同形字（Firebase key
       非法字符），重名再补 ~2 ~3。真名永远存在 item.name 里，id 只当路径。
     - rating 取 me/her 平均（0–10），同时保留 ratingMe / ratingHer，
       不丢两人的原始分（面板还是要两人分开打星）。
     - done/doneAt 分离：done 是布尔，doneAt 是绝对毫秒（v4 用正负号挤在一个
       数字里，PATCH 叶子写时正负号无法原子表达「谁更晚」，所以拆开）。
     - 删除是真墓碑 del:true + delAt，不删节点（写子节点会重建父节点，真删会复活）。
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");

const DEFAULT_URL = "https://liqianshiqianjin-default-rtdb.asia-southeast1.firebasedatabase.app";
const DEFAULT_ROOT = "/zhuhai-chida";
const SITE_V = 5;
const MIN_V = 4;

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const out = {
    apply: false, from: "", url: DEFAULT_URL, root: DEFAULT_ROOT,
    backupDir: path.resolve(SITE, "..", "_backup-v5"),
    tombstoneOrphans: false, includeBase: false, keepLegacy: false,
    force: false, quiet: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--tombstone-orphans") out.tombstoneOrphans = true;
    else if (a === "--include-base") out.includeBase = true;
    else if (a === "--keep-legacy") out.keepLegacy = true;
    else if (a === "--force") out.force = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--from=")) out.from = a.slice(7);
    else if (a.startsWith("--url=")) out.url = a.slice(6).replace(/\/$/, "");
    else if (a.startsWith("--root=")) out.root = "/" + a.slice(7).replace(/^\/+|\/+$/g, "");
    else if (a.startsWith("--backup-dir=")) out.backupDir = path.resolve(SITE, a.slice(13));
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`未知参数：${a}（--help 看用法）`); process.exit(2); }
  }
  return out;
}
function printHelp() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("============ */")[0].replace(/^#!.*\n/, ""));
}

/* ---------- 小工具 ---------- */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === "string" ? v : "");
const pad = (s, n) => {
  /* 按显示宽度补空格（CJK 记 2） */
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return String(s) + " ".repeat(Math.max(0, n - w));
};
const r1 = (v) => Math.round(v * 10) / 10;

/* Firebase key 非法字符：. # $ [ ] / ；另：空串、. 与 .. 也非法。
   与 scripts/app.js 里的 fbKey() 必须保持同一套映射。 */
const KEY_MAP = { ".": "．", "#": "＃", "$": "＄", "[": "［", "]": "］", "/": "／" };
function fbKey(name) {
  let s = String(name == null ? "" : name).trim();
  if (!s) return "item";
  s = s.replace(/[.#$\[\]\/]/g, (c) => KEY_MAP[c]);
  /* 单段路径 <768 字节；按码点截断到 120 字符足够 */
  s = Array.from(s).slice(0, 120).join("");
  if (s === "." || s === "..") s = s.replace(/\./g, "．");
  return s;
}
function uniqueKey(base, used) {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(base + "~" + i)) i++;
  return base + "~" + i;
}

/* v4 的 addr 值：字符串 or {t,v} */
function normAddr(e) {
  if (typeof e === "string") return { t: 0, v: e };
  if (isObj(e) && typeof e.v === "string") return { t: num(e.t), v: e.v };
  return null;
}

/* ---------- 读云端 ---------- */
async function fetchDoc(opts) {
  const url = `${opts.url}${opts.root}.json?r=${Date.now()}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const txt = await r.text();
  if (!txt || txt === "null") return { doc: null, raw: txt, url };
  let doc;
  try { doc = JSON.parse(txt); } catch (e) { throw new Error("云端返回不是 JSON：" + txt.slice(0, 200)); }
  return { doc, raw: txt, url };
}

/* ---------- 从 index.html 抽底表菜名 ---------- */
function readBaseNames() {
  try {
    const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
    const names = [];
    for (const m of html.matchAll(/data-text="([^"]*)"/g)) {
      const n = m[1].trim();
      if (n && !names.includes(n)) names.push(n);
    }
    return names;
  } catch { return []; }
}

/* ---------- 核心：v4 → v5 ---------- */
function planMigration(doc, opts) {
  doc = isObj(doc) ? doc : {};
  const warnings = [];
  const baseNames = readBaseNames();

  /* 1) 清单顺序：order.v 是权威；extra 里多出来的按时间顺延 */
  const orderV = isObj(doc.order) && Array.isArray(doc.order.v) ? doc.order.v.filter((x) => typeof x === "string" && x) : [];
  const extra = isObj(doc.extra) ? doc.extra : {};
  const ordMap = new Map();
  orderV.forEach((name, i) => { if (!ordMap.has(name)) ordMap.set(name, i + 1); });
  let nextOrd = Math.max(0, ...ordMap.values()) + 1;
  Object.keys(extra)
    .sort((a, b) => num(extra[a]) - num(extra[b]) || (a < b ? -1 : a > b ? 1 : 0))
    .forEach((name) => { if (!ordMap.has(name)) ordMap.set(name, nextOrd++); });

  /* 墓碑里的菜名也要落成 item（del:true），否则「真删」在 v5 里没有记录可依，
     将来任何一次写子节点都可能把它重建出来。 */
  const delBag = isObj(doc.del) ? doc.del : {};
  Object.keys(delBag).forEach((name) => { if (!ordMap.has(name)) ordMap.set(name, nextOrd++); });

  /* 底表里云端没有的菜 */
  const baseMissing = baseNames.filter((n) => !ordMap.has(n));
  if (baseMissing.length && opts.includeBase) {
    baseMissing.forEach((n) => ordMap.set(n, nextOrd++));
  } else if (baseMissing.length) {
    warnings.push(`index.html 底表有 ${baseMissing.length} 个菜云端清单里没有（默认不迁移，迁移后不再显示）：${baseMissing.join("、")}　※ 要保留请加 --include-base`);
  }
  if (!ordMap.size) warnings.push("清单是空的：order.v 与 extra 都没有可用菜名，items 会是空对象");

  /* 2) 组装 items */
  const done = isObj(doc.done) ? doc.done : {};
  const del = isObj(doc.del) ? doc.del : {};
  const addr = isObj(doc.addr) ? doc.addr : {};
  const score = isObj(doc.score) ? doc.score : {};
  const used = new Set();
  const items = [];
  for (const [name, ord] of [...ordMap.entries()].sort((a, b) => a[1] - b[1])) {
    const id = uniqueKey(fbKey(name), used);
    used.add(id);
    const signed = num(done[name]);
    const a = normAddr(addr[name]);
    const sc = isObj(score[name]) ? score[name] : {};
    const me = typeof sc.me === "number" ? sc.me : undefined;
    const her = typeof sc.her === "number" ? sc.her : undefined;
    const vals = [me, her].filter((v) => typeof v === "number");
    const rating = vals.length ? r1(vals.reduce((x, y) => x + y, 0) / vals.length) : 0;
    const d = num(del[name]);
    const rec = {
      cid: "",
      name,
      ord,
      done: signed > 0,
      doneAt: signed === 0 ? 0 : Math.abs(signed),
      rating,
      ratingAt: num(sc.t),
      addr: a ? a.v : "",
      addrAt: a ? a.t : 0,
      del: d > 0,
      delAt: d > 0 ? Math.abs(d) : 0,
    };
    /* 两人分保留，面板要用；rating 只是给「一个数」的场合用 */
    if (typeof me === "number") rec.ratingMe = me;
    if (typeof her === "number") rec.ratingHer = her;
    items.push({ id, ...rec });
  }

  /* 3) 孤儿 done 键：有打勾记录但不在清单里 = 曾被真删（没有墓碑），
        默认不迁移也不渲染；--tombstone-orphans 时建墓碑防复活 */
  const orphanNames = Object.keys(done).filter((k) => !ordMap.has(k));
  const orphans = [];
  for (const name of orphanNames) {
    const signed = num(done[name]);
    const row = { name, signed, abs: Math.abs(signed) };
    if (opts.tombstoneOrphans) {
      const id = uniqueKey(fbKey(name), used);
      used.add(id);
      items.push({
        id,
        cid: "", name, ord: nextOrd++,
        done: signed > 0, doneAt: signed === 0 ? 0 : Math.abs(signed),
        rating: 0, ratingAt: 0, addr: "", addrAt: 0,
        del: true, delAt: Math.abs(num(del[name])) || Math.abs(signed) || 1,
      });
      row.tombstoned = true;
    }
    orphans.push(row);
  }
  /* 有地址记录的孤儿也列出来，避免「以为迁过去了」 */
  const addrOnly = Object.keys(addr).filter((k) => !ordMap.has(k));

  /* 4) meta + 旧字段处理 */
  const now = Date.now();
  const meta = { v: SITE_V, minV: MIN_V, updatedAt: now };
  const legacyKeys = ["v", "rev", "updatedAt", "done", "extra", "del", "delT", "rosterT", "addr", "score", "order"]
    .filter((k) => Object.prototype.hasOwnProperty.call(doc, k));

  return { items, meta, warnings, orphans, addrOnly, baseNames, baseMissing, orderV, extra, legacyKeys, now };
}

/* ---------- 打印 ---------- */
function printPlan(doc, plan, opts) {
  const dv = isObj(doc) ? doc : {};
  console.log("─".repeat(78));
  console.log(`现有文档：v=${dv.v === undefined ? "(无)" : dv.v}  rev=${dv.rev ?? "(无)"}  顶层键：${Object.keys(dv).sort().join(", ") || "(空)"}`);
  console.log(`  done ${Object.keys(isObj(dv.done) ? dv.done : {}).length} 项 · extra ${Object.keys(isObj(dv.extra) ? dv.extra : {}).length} 项 · ` +
    `order.v ${Array.isArray(dv.order?.v) ? dv.order.v.length : 0} 项 · addr ${Object.keys(isObj(dv.addr) ? dv.addr : {}).length} 项 · ` +
    `score ${Object.keys(isObj(dv.score) ? dv.score : {}).length} 项 · del ${Object.keys(isObj(dv.del) ? dv.del : {}).length} 项`);
  console.log("─".repeat(78));
  console.log("迁移后的 items（v5 全部条目，按 ord 排序）：");
  console.log("  " + pad("ord", 5) + pad("id", 22) + pad("name", 22) + pad("done", 7) + pad("doneAt", 16) + pad("me/her→rating", 16) + "addr");
  for (const it of plan.items) {
    const ratingCell = `${it.ratingMe ?? "–"}/${it.ratingHer ?? "–"}→${it.rating}`;
    console.log("  " + pad(it.ord, 5) + pad(it.id, 22) + pad(it.name, 22) + pad(it.done ? "true" : "false", 7) +
      pad(it.doneAt || 0, 16) + pad(ratingCell, 16) +
      (it.addr ? `${it.addr}${it.addrAt ? "@" + it.addrAt : ""}` : "–") +
      (it.del ? "   [墓碑]" : "") + (it.ord > 100 ? "" : ""));
  }
  console.log("─".repeat(78));
  console.log(`计数：items ${plan.items.length} 条（其中墓碑 ${plan.items.filter((i) => i.del).length} 条、已吃 ${plan.items.filter((i) => i.done).length} 条）`);
  if (plan.orphans.length) {
    console.log(`孤儿 done 键 ${plan.orphans.length} 个（不在清单里，默认不迁移 → 迁移后不显示，也不会复活）：`);
    for (const o of plan.orphans) {
      console.log(`  - ${pad(o.name, 24)} done 原始值 ${o.signed}${o.tombstoned ? "  → 已建墓碑" : ""}`);
    }
    if (!opts.tombstoneOrphans) console.log("    ※ 想把它们钉死成墓碑：加 --tombstone-orphans");
  }
  if (plan.addrOnly.length) console.log(`孤儿 addr 键 ${plan.addrOnly.length} 个（不迁移）：${plan.addrOnly.join("、")}`);
  if (plan.warnings.length) {
    console.log("警告：");
    for (const w of plan.warnings) console.log("  ! " + w);
  }
  console.log("─".repeat(78));
  const body = buildPatchBody(plan, opts);
  console.log(`apply 时会发出的 PATCH ${opts.root}.json：${Object.keys(body).length} 个路径，${JSON.stringify(body).length} 字节`);
  if (!opts.quiet) {
    const keys = Object.keys(body);
    for (const k of keys.slice(0, 12)) console.log("   " + pad(k, 40) + " = " + JSON.stringify(body[k]).slice(0, 90));
    if (keys.length > 12) console.log(`   …… 其余 ${keys.length - 12} 个路径省略（--quiet 可关掉这段）`);
  }
  console.log("─".repeat(78));
}

function buildPatchBody(plan, opts) {
  const body = { meta: plan.meta, v: SITE_V };
  for (const it of plan.items) {
    const rec = { ...it };
    delete rec.id;
    body[`items/${it.id}`] = rec;
  }
  if (!opts.keepLegacy) {
    for (const k of plan.legacyKeys) {
      if (k === "v" || k === "updatedAt") continue;
      if (k === "meta") continue;
      body[k] = null;
    }
    /* 旧 updatedAt 是 ISO 字符串，跟 meta 重复，清掉 */
    if (plan.legacyKeys.includes("updatedAt")) body.updatedAt = null;
  }
  return body;
}

/* ---------- apply ---------- */
async function applyPatch(opts, body) {
  const url = `${opts.url}${opts.root}.json`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`PATCH 失败 HTTP ${r.status}：${txt.slice(0, 300)}`);
  return txt;
}

/* ---------- 主流程 ---------- */
async function main() {
  const opts = parseArgs(process.argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  let doc, raw, source;
  if (opts.from) {
    raw = fs.readFileSync(path.resolve(opts.from), "utf8");
    doc = JSON.parse(raw);
    source = "local:" + opts.from;
  } else {
    ({ doc, raw, url: source } = await fetchDoc(opts));
  }
  console.log(`数据源：${source}`);
  if (!doc) { console.log("云端文档不存在（null）→ 没有可迁移的东西，退出。"); process.exit(0); }

  const isV5 = isObj(doc.meta) && num(doc.meta.v) >= SITE_V && isObj(doc.items);
  if (isV5 && !opts.force) {
    console.log(`已经是 v5（meta.v=${doc.meta.v}，items ${Object.keys(doc.items).length} 条）→ 无需迁移。要强制重跑加 --force。`);
    process.exit(0);
  }

  const plan = planMigration(doc, opts);

  /* 备份原始 JSON（dry-run 也存，留证据） */
  const bkDir = path.join(opts.backupDir, stamp);
  fs.mkdirSync(bkDir, { recursive: true });
  fs.writeFileSync(path.join(bkDir, "raw-v4.json"), raw, "utf8");
  fs.writeFileSync(path.join(bkDir, "plan-v5.json"), JSON.stringify({ meta: plan.meta, items: Object.fromEntries(plan.items.map((i) => [i.id, i])), orphans: plan.orphans }, null, 2), "utf8");
  console.log(`原始 JSON 已备份：${path.join(bkDir, "raw-v4.json")}`);

  printPlan(doc, plan, opts);

  if (!opts.apply) {
    console.log(`DRY-RUN：没有写云端。加 --apply 才会写（写前会再读一次云端并核对）。`);
    return;
  }

  /* apply：重读一次，确认期间没人动过（旧客户端可能刚覆盖过） */
  const fresh = await fetchDoc(opts);
  const freshSig = JSON.stringify({ v: fresh.doc?.v, rev: fresh.doc?.rev, rosterT: fresh.doc?.rosterT, delT: fresh.doc?.delT });
  const seenSig = JSON.stringify({ v: doc.v, rev: doc.rev, rosterT: doc.rosterT, delT: doc.delT });
  if (freshSig !== seenSig) {
    console.error(`拒绝写入：读取后云端又变了（${seenSig} → ${freshSig}）。请重跑 dry-run 复核。`);
    process.exit(3);
  }

  const body = buildPatchBody(plan, opts);
  console.log(`APPLY：PATCH ${opts.root}.json（${Object.keys(body).length} 个路径，${JSON.stringify(body).length} 字节）…`);
  await applyPatch(opts, body);
  console.log("写入完成，开始回读校验…");

  const after = await fetchDoc(opts);
  const a = after.doc || {};
  const problems = [];
  if (!(isObj(a.meta) && num(a.meta.v) === SITE_V)) problems.push(`meta.v 不是 ${SITE_V}（实际 ${a.meta?.v}）`);
  const aItems = isObj(a.items) ? a.items : {};
  if (Object.keys(aItems).length !== plan.items.length) problems.push(`items 条数 ${Object.keys(aItems).length} ≠ 计划 ${plan.items.length}`);
  for (const it of plan.items) {
    const got = aItems[it.id];
    if (!got) { problems.push(`缺 item ${it.id}`); continue; }
    if (got.name !== it.name) problems.push(`${it.id}.name ${got.name} ≠ ${it.name}`);
    if (num(got.ord) !== it.ord) problems.push(`${it.id}.ord ${got.ord} ≠ ${it.ord}`);
    if (!!got.done !== it.done) problems.push(`${it.id}.done ${got.done} ≠ ${it.done}`);
    if (num(got.doneAt) !== it.doneAt) problems.push(`${it.id}.doneAt ${got.doneAt} ≠ ${it.doneAt}`);
    if (!!got.del !== it.del) problems.push(`${it.id}.del ${got.del} ≠ ${it.del}`);
  }
  if (!opts.keepLegacy) {
    for (const k of ["done", "extra", "del", "order", "score", "addr"]) {
      if (Object.prototype.hasOwnProperty.call(a, k)) problems.push(`旧字段 ${k} 还在（旧客户端可能据此复活）`);
    }
  }
  if (problems.length) {
    console.error("回读校验失败：");
    for (const p of problems) console.error("  ! " + p);
    process.exit(4);
  }
  console.log(`回读校验通过：meta.v=${a.meta.v}，items ${Object.keys(aItems).length} 条，旧字段已清（keepLegacy=${opts.keepLegacy}）。`);
}

main().catch((e) => { console.error("迁移失败：" + (e && e.stack ? e.stack : e)); process.exit(1); });
