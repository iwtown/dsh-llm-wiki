#!/usr/bin/env node
/**
 * llm-wiki-pipeline.mjs —— LLM-Wiki 后处理管线（P2）
 * lint → 索引重建 → 记忆体同步 → log.md。零外部依赖。
 * 用法: node llm-wiki-pipeline.mjs [--lint] [--index] [--sync] [--all] [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
const execFileAsync = promisify(execFile);

// 管道截断（如 head 关闭）不崩溃：忽略 stdout/stderr 的 EPIPE
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// 管道截断（如 head 关闭）不崩溃：忽略 stdout/stderr 的 EPIPE
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
import { createServer } from "node:http";

const VAULT = process.env.LLM_WIKI_VAULT || "/mnt/d/DB/Obsidian/LLM-Wiki";
const WIKI = join(VAULT, "wiki");
const STATE_DIR = join(homedir(), ".dsh/llm-wiki");
const STATE_FILE = process.env.LLM_WIKI_STATE || join(STATE_DIR, "pipeline-state.json");
const FAKE_EMBED = process.env.LLM_WIKI_FAKE_EMBED || "auto";
const EXCLUDE_DIRS = new Set(["_archived", "trash", ".smart-env", "索引"]);
const STALE_DAYS = 90;

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const DRY = args.has("--dry-run");
const doAll = ![...args].some(a => ["--lint", "--index", "--sync", "--rate", "--usage"].includes(a));
const RUN = { lint: doAll || args.has("--lint"), index: doAll || args.has("--index"), sync: doAll || args.has("--sync"), usage: doAll || args.has("--usage") };
const RATE_TARGET = rawArgs[rawArgs.indexOf("--rate") + 1];
const RATE_VALUE = rawArgs[rawArgs.indexOf("--rating") + 1];
const DO_RATE = args.has("--rate") && RATE_TARGET && RATE_VALUE;

// frontmatter 定位（支持前置杂行）：返回第一个 --- 块的 fm 文本
function extractFmText(content) {
  const start = content.indexOf("---");
  if (start < 0) return null;
  const end = content.indexOf("\n---", start + 3);
  if (end < 0) return null;
  return { start, end, fm: content.slice(start + 3, end) };
}

// frontmatter 字段设置（有则替换，无则追加；支持 frontmatter 不在文件开头）
function setFmField(content, field, value) {
  const blk = extractFmText(content);
  if (!blk) return content;
  const re = new RegExp("^" + field + ":.*$", "m");
  const newFm = re.test(blk.fm) ? blk.fm.replace(re, field + ": " + value) : blk.fm + "\n" + field + ": " + value;
  return content.slice(0, blk.start + 3) + newFm + content.slice(blk.end + 4);
}

// --rate: 手动质量反馈（useful +1 分 / outdated 标 stale）
function ratePage(rel, rating) {
  const full = join(VAULT, rel);
  if (!existsSync(full)) return { error: "文件不存在: " + rel };
  let content = readFileSync(full, "utf8");
  const fm = parseFm(content);
  const today = new Date().toISOString().slice(0, 10);
  if (rating === "useful") {
    const cur = Number(fm.quality_score) || 0;
    content = setFmField(content, "quality_score", Math.min(cur + 1, 5));
    content = setFmField(content, "queried_count", (Number(fm.queried_count) || 0) + 1);
    content = setFmField(content, "last_queried", today);
    if (fm.status === "stale") content = setFmField(content, "status", "active");
    writeFileSync(full, content);
    return { ok: true, rel, score: Math.min(cur + 1, 5), note: "useful 反馈，quality_score 提升" };
  }
  if (rating === "outdated") {
    const cur = Number(fm.quality_score) || 0;
    content = setFmField(content, "quality_score", Math.max(cur - 1, 0));
    content = setFmField(content, "status", "stale");
    content = setFmField(content, "last_queried", today);
    writeFileSync(full, content);
    return { ok: true, rel, score: Math.max(cur - 1, 0), note: "outdated 反馈，标记 stale" };
  }
  return { error: "rating 必须是 useful 或 outdated" };
}

// --usage: 从 mnemon 记忆体提取召回热度，回写 queried_count/last_queried
function usageSync(pages) {
  let db;
  try { db = new DatabaseSync(join(homedir(), ".mnemon/data/default/mnemon.db"), { readOnly: true }); }
  catch (e) { return { error: "无法打开 mnemon db: " + e.message }; }
  try {
    const rows = db.prepare("SELECT content, access_count, last_accessed_at FROM insights WHERE content LIKE ? AND deleted_at IS NULL").all("%来源: wiki/%");
    const byRel = new Map();
    for (const r of rows) {
      const m = String(r.content).match(/来源: ([^）)]+)/);
      if (!m) continue;
      const rel = m[1].trim();
      if (!byRel.has(rel)) byRel.set(rel, { count: 0, last: "" });
      const e = byRel.get(rel);
      e.count = Math.max(e.count, Number(r.access_count) || 0);
      if (r.last_accessed_at && String(r.last_accessed_at) > e.last) e.last = String(r.last_accessed_at).slice(0, 10);
    }
    let updated = 0;
    for (const p of pages) {
      const u = byRel.get(p.rel);
      if (!u || u.count <= 0) continue;
      const cur = Number(p.fm.queried_count) || 0;
      if (u.count > cur || (u.last && u.last !== p.fm.last_queried)) {
        let content = p.content;
        content = setFmField(content, "queried_count", u.count);
        if (u.last) content = setFmField(content, "last_queried", u.last);
        if (content !== p.content) {
          const origMtime = p.mtime; // 恢复原 mtime：元数据回写不触发 sync 重新同步
          writeFileSync(p.full, content);
          try { utimesSync(p.full, origMtime, origMtime); } catch {}
          updated++;
        }
      }
    }
    return { tracked: rows.length, updated };
  } finally { try { db.close(); } catch {} }
}

function parseFm(content) {
  const fm = {};
  const blk = extractFmText(content);
  if (!blk) return fm;
  for (const line of blk.fm.split("\n")) {
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

function collectPages() {
  const pages = [];
  function walk(dir, cat) {
    for (const e of readdirSync(dir)) {
      if (EXCLUDE_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) walk(full, cat);
        else if (e.endsWith(".md") && e !== "index.md") {
          const content = readFileSync(full, "utf8");
          const st = statSync(full);
          pages.push({ cat, file: e, full, rel: relative(VAULT, full), content, fm: parseFm(content), mtime: st.mtimeMs, size: st.size });
        }
      } catch {}
    }
  }
  for (const cat of ["决策","发现","概念","项目","流程","命令","规则","提示","记忆","基因","引用"]) {
    const dir = join(WIKI, cat);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, cat);
  }
  return pages;
}

function lint(pages) {
  const issues = [];
  const links = new Map();
  for (const p of pages) {
    for (const f of ["title", "type", "created"]) {
      if (!p.fm[f]) issues.push({ type: "missing_frontmatter", path: p.rel, message: "缺 " + f });
    }
    const wl = (p.content.match(/\[\[[^\]]+\]\]/g) || []).length;
    if (wl < 2) issues.push({ type: "few_wikilinks", path: p.rel, message: "wikilink " + wl });
    for (const m of p.content.matchAll(/\[\[([^\]#|]+)/g)) {
      const t = m[1].trim();
      if (!links.has(t)) links.set(t, new Set());
      links.get(t).add(p.rel);
    }
  }
  const graceCut = new Date(); graceCut.setDate(graceCut.getDate() - 7);
  const orphans = pages.filter(p => {
    if (p.cat === "引用" || p.cat === "索引") return false;
    // 新页面宽限期：创建/更新在 7 天内不算孤立（等入链自然形成）
    const d = p.fm.updated || p.fm.created;
    if (d && new Date(d) > graceCut) return false;
    const name = p.file.replace(/\.md$/, "");
    return ![...links.entries()].some(([t, srcs]) => (t === name || t.endsWith("/" + name)) && srcs.size > 0);
  });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - STALE_DAYS);
  const stale = pages.filter(p => {
    const u = p.fm.updated || p.fm.created;
    return u && new Date(u) < cutoff && p.fm.status !== "stale";
  });
  return { issues, orphans, stale, pageCount: pages.length };
}

function rebuildIndex(pages) {
  const byCat = {};
  for (const p of pages) byCat[p.cat] = (byCat[p.cat] || 0) + 1;
  const cats = ["决策","发现","概念","项目","流程","命令","规则","提示","记忆","基因","引用"].filter(c => byCat[c]);
  let md = "# LLM-Wiki 知识库导航\n\nAgent 自主浏览入口。通过以下分类逐级浏览。\n\n> 此页面由管线自动维护。\n\n## 分类\n\n";
  for (const c of cats) md += "* [wiki/" + c + "](wiki/" + c + "/index.md) — " + byCat[c] + " 条\n";
  const recent = [...pages].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  md += "\n## 最近更新\n\n";
  for (const p of recent) md += "* [" + (p.fm.title || p.file) + "](" + p.rel + ") — " + new Date(p.mtime).toISOString().slice(0, 10) + "\n";
  return md;
}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveState(s) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }
// 变更检测：mtime 单因子（usage 元数据回写会恢复 mtime，不触发重复同步）
function changedPages(pages, state) {
  return pages.filter(p => { const st = state[p.rel]; return !st || st.mtime !== p.mtime; });
}
function generateDraft(changed) {
  return changed.map(p => {
    const summary = p.fm.summary && p.fm.summary !== "-" ? "：" + p.fm.summary : "";
    return {
      content: "[LLM-Wiki/" + p.cat + "] " + (p.fm.title || p.file) + summary + "（来源: " + p.rel + "）",
      tags: ["llm-wiki", p.cat, ...(p.fm.project ? [p.fm.project] : [])].filter(Boolean),
      importance: Number(p.fm.quality_score) >= 5 ? 4 : 3,
    };
  });
}

function startFakeEmbed() {
  const srv = createServer((req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "embedding unavailable" })); });
  return new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(11434, "127.0.0.1", () => resolve(srv)); });
}
async function ollamaAlive() {
  return new Promise(resolve => {
    execFileSync("node", ["-e", "fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { stdio: "ignore" });
    resolve(true);
  }).catch(() => false);
}
async function syncMemory(pages) {
  const syncPages = pages.filter(p => p.cat !== "引用" && !(p.cat === "发现" && p.file.includes("会话复盘")));
  const state = loadState();
  const changed = changedPages(syncPages, state);
  if (changed.length === 0) return { synced: 0, note: "无变更页面" };
  const draft = { schema_version: "1", insights: generateDraft(changed) };
  const tmp = join(STATE_DIR, "sync-draft-" + Date.now() + ".json");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(tmp, JSON.stringify(draft, null, 1));
  let fake = null;
  if (FAKE_EMBED !== "never") {
    const alive = await ollamaAlive();
    if (!alive) { fake = await startFakeEmbed().catch(e => { console.log("[sync] startFakeEmbed 失败:", String(e).slice(0, 80)); return null; }); }
  }
  try {
    await execFileAsync("mnemon", ["import", tmp], { timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const tail = String(e.stdout || "").trim().slice(-150);
    return { synced: 0, error: String(e.message || e).slice(0, 120) + (tail ? " | out:" + tail : "") };
  } finally {
    if (fake) { try { fake.close(); } catch {} }
    try { rmSync(tmp, { force: true }); } catch {}
  }
  const ns = { ...state };
  for (const p of changed) ns[p.rel] = { mtime: p.mtime, size: p.size };
  saveState(ns);
  return { synced: changed.length, changed: changed.map(p => p.rel).slice(0, 5) };
}

function appendLog(entry) {
  const logPath = join(VAULT, "log.md");
  try {
    const line = "## [" + new Date().toISOString().slice(0, 10) + "] pipeline | " + entry + "\n";
    if (existsSync(logPath)) writeFileSync(logPath, line + readFileSync(logPath, "utf8"));
    else writeFileSync(logPath, "# LLM-Wiki 操作日志\n\n" + line);
  } catch {}
}

async function main() {
  console.log("LLM-Wiki pipeline | vault:", VAULT);
  if (DO_RATE) {
    const r = ratePage(RATE_TARGET, RATE_VALUE);
    console.log("\n== rate ==\n", JSON.stringify(r));
    if (r.ok && !DRY) appendLog("rate:" + RATE_TARGET + "=" + RATE_VALUE);
    return;
  }
  const pages = collectPages();
  console.log("页面数:", pages.length);
  const summary = [];
  if (RUN.lint) {
    const r = lint(pages);
    console.log("\n== lint ==");
    console.log("问题:", r.issues.length, "| 孤立节点:", r.orphans.length, "| stale:", r.stale.length);
    for (const i of r.issues.slice(0, 8)) console.log("  [问题]", i.path, i.message);
    for (const o of r.orphans.slice(0, 5)) console.log("  [孤立]", o.rel);
    summary.push("lint:" + r.issues.length + "问题/" + r.orphans.length + "孤立/" + r.stale.length + "stale");
  }
  if (RUN.index) {
    const md = rebuildIndex(pages);
    if (!DRY) { writeFileSync(join(WIKI, "index.md"), md); console.log("\n== index ==\n已重建 wiki/index.md"); summary.push("index:重建"); }
    else console.log("\n== index ==\n(--dry-run) 将重建 wiki/index.md");
  }
  if (RUN.usage) {
    console.log("\n== usage ==");
    if (DRY) console.log("(--dry-run) 将回写召回热度到 wiki 页 frontmatter");
    else { const r = usageSync(pages); console.log("回写:", JSON.stringify(r)); summary.push("usage:" + (r.updated || 0) + "页"); }
  }
  if (RUN.sync) {
    console.log("\n== sync ==");
    if (DRY) {
      const syncPages = pages.filter(p => p.cat !== "引用" && !(p.cat === "发现" && p.file.includes("会话复盘")));
      const state = loadState(); const changed = changedPages(syncPages, state);
      console.log("(--dry-run) 变更页面:", changed.length);
      summary.push("sync(dry):" + changed.length);
    } else {
      const r = await syncMemory(pages);
      console.log("同步:", JSON.stringify(r));
      summary.push("sync:" + (r.synced || 0) + "条" + (r.error ? " ERR:" + r.error : ""));
    }
  }
  if (!DRY) appendLog(summary.join(" | "));
  console.log("\n完成。");
}
main().catch(e => { console.error("pipeline 失败:", e); process.exit(1); });
