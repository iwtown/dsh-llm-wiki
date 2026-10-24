#!/usr/bin/env node
// LLM-Wiki 融合检索：BM25(全库) + mnemon recall → RRF → quality/新鲜度重排
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const VAULT = process.env.LLM_WIKI_VAULT || "D:/DB/Obsidian/LLM-Wiki";
const WIKI = path.join(VAULT, "wiki");
const EXCLUDE_DIRS = new Set(["_archived", "trash", ".smart-env", "索引"]);
export const CATS = ["决策", "发现", "概念", "项目", "流程", "命令", "规则", "提示", "记忆", "基因", "引用", "patterns"];
const HAN_L = String.fromCharCode(0x4e00), HAN_R = String.fromCharCode(0x9fff);
const CJK_STRIP = new RegExp("[^" + HAN_L + "-" + HAN_R + "]", "g");

export function loadPages() {
  const pages = [];
  const walk = (dir, cat) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, cat); continue; }
      if (!e.name.endsWith(".md") || e.name === "index.md") continue;
      const content = fs.readFileSync(full, "utf8");
      const fmEnd = content.indexOf("\n---", 4);
      const fm = fmEnd > 0 ? content.slice(4, fmEnd) : "";
      const get = k => { const m = fm.match(new RegExp("^" + k + ":\\s*[\"']?([^\\n\"']+)", "m")); return m ? m[1].trim() : ""; };
      pages.push({
        rel: path.relative(VAULT, full).replace(/\\/g, "/"),
        cat, title: get("title") || e.name.replace(/\.md$/, ""),
        desc: get("description"), quality: Number(get("quality_score")) || 3,
        updated: get("updated") || get("created"), status: get("status"),
        superseded: /^superseded_by:/m.test(fm), content,
      });
    }
  };
  for (const cat of CATS) { const d = path.join(WIKI, cat); if (fs.existsSync(d)) walk(d, cat); }
  return pages;
}

function tokens(s) {
  const out = []; const lower = String(s).toLowerCase();
  for (const w of lower.match(/[a-z0-9_]{2,}/g) || []) out.push(w);
  const cjk = lower.replace(CJK_STRIP, "");
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2));
  return out;
}

export function bm25Search(query, pages, topN = 20) {
  const docs = pages.map(p => { const tk = tokens(p.content); const tf = Object.create(null); for (const t of tk) tf[t] = (tf[t] || 0) + 1; return { p, tf, len: tk.length }; });
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  const df = Object.create(null);
  for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] || 0) + 1;
  const N = docs.length, k1 = 1.2, b = 0.75, qs = tokens(query);
  return docs.map(d => {
    let s = 0;
    for (const t of qs) { const f = d.tf[t]; if (!f) continue; const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)); s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg)); }
    return { rel: d.p.rel, score: s };
  }).sort((a, b2) => b2.score - a.score).slice(0, topN);
}

export function mnemonRecall(query, topN = 20) {
  try {
    const raw = execFileSync("mnemon", ["recall", query, "--limit", String(topN), "--brief", "--excerpt-chars", "2000"], { encoding: "utf8", shell: true, timeout: 30000 });
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return (j.results || []).map(r => {
      const c = String(r.excerpt || "");
      const i = c.lastIndexOf("（来源:");
      let src = "";
      if (i >= 0) {
        let t = c.slice(i + 4);
        const h = t.indexOf("#");
        if (h >= 0) t = t.slice(0, h);
        src = t.replace(/）\s*$/, "").trim().replace(/\\/g, "/");
      }
      return { source: src, excerpt: c };
    }).filter(x => x.source);
  } catch { return []; }
}

export function fusedSearch(query, opts = {}) {
  const limit = opts.limit || 5;
  const useMnemon = opts.useMnemon !== false;
  const K = Number(process.env.LLM_WIKI_RRF_K || 5);
  const WB = Number(process.env.LLM_WIKI_RRF_WB || 1.0);
  const WM = Number(process.env.LLM_WIKI_RRF_WM || 0.5);
  const TB = Number(process.env.LLM_WIKI_TITLE_BOOST || 4);
  const pages = loadPages();
  const byRel = new Map(pages.map(p => [p.rel, p]));
  const bm = bm25Search(query, pages, 20);
  const mn = useMnemon ? mnemonRecall(query, 20) : [];
  const rrf = new Map();
  bm.forEach((r, i) => rrf.set(r.rel, (rrf.get(r.rel) || 0) + WB / (K + i + 1)));
  const mnBest = new Map();
  mn.forEach((r, i) => {
    const prev = mnBest.get(r.source);
    if (!prev || prev.rank > i) mnBest.set(r.source, { rank: i, excerpt: r.excerpt });
    rrf.set(r.source, (rrf.get(r.source) || 0) + WM / (K + i + 1));
  });
  const qs = new Set(tokens(query));
  const overlap = text => { if (!qs.size) return 0; const ts = new Set(tokens(text)); let n = 0; for (const t of qs) if (ts.has(t)) n++; return n / qs.size; };
  const now = Date.now();
  return [...rrf.entries()].map(([rel, s]) => {
    const p = byRel.get(rel);
    if (!p) return null;
    const qw = 1 + 0.1 * (p.quality - 3);
    const days = p.updated ? Math.round((now - new Date(p.updated).getTime()) / 864e5) : 999;
    const rw = p.superseded ? 0.5 : p.status === "archived" ? 0.7 : days <= 30 ? 1.05 : days > 180 ? 0.9 : 1.0;
    const tb = 1 + TB * overlap((p.title || "") + " " + (p.desc || ""));
    const catW = Number(process.env.LLM_WIKI_CAT_WEIGHT || 1.0);
    const mnHit = mnBest.get(rel);
    const body = p.content.replace(/^[\s\S]*?\n---\s*\n/, "").replace(/[#>*`\-]/g, " ").replace(/\s+/g, " ").trim();
    return {
      rel, title: p.title, cat: p.cat, quality: p.quality, days, superseded: p.superseded, archived: p.status === "archived",
      summary: (p.desc || body).slice(0, 100),
      score: +(s * qw * rw * tb * catW).toFixed(4),
      bm25_rank: bm.findIndex(x => x.rel === rel), mnemon_rank: mnHit ? mnHit.rank : -1,
      excerpt: mnHit ? mnHit.excerpt.slice(0, 160) : "",
    };
  }).filter(Boolean).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

if (process.argv[1] && process.argv[1].endsWith("wiki-retrieval.mjs")) {
  const args = process.argv.slice(2);
  const q = args.find(a => !a.startsWith("--"));
  if (!q) { console.error('用法: node wiki-retrieval.mjs "<query>" [--json] [--limit N] [--no-mnemon]'); process.exit(2); }
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) || 5 : 5;
  const results = fusedSearch(q, { limit, useMnemon: !args.includes("--no-mnemon") });
  if (args.includes("--json")) console.log(JSON.stringify({ query: q, results }, null, 1));
  else {
    console.log("# " + q + "\n");
    results.forEach((r, i) => {
      const marks = [r.archived ? "archived" : "", r.superseded ? "superseded" : "", r.days > 180 ? "stale" : ""].filter(Boolean).join(",");
      console.log((i + 1) + ". " + r.rel + (marks ? "  [" + marks + "]" : ""));
      console.log("   " + r.summary);
      console.log("   q=" + r.quality + " | bm25#" + (r.bm25_rank >= 0 ? r.bm25_rank + 1 : "-") + " | recall#" + (r.mnemon_rank >= 0 ? r.mnemon_rank + 1 : "-") + " | score=" + r.score);
      if (r.excerpt) console.log("   > " + r.excerpt);
      console.log("");
    });
  }
}
