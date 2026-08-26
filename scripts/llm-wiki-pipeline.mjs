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
const doAll = ![...args].some(a => ["--lint", "--index", "--sync", "--rate", "--usage", "--okf", "--prune-memory", "--dsh-export", "--docs-sync"].includes(a));
const RUN = { lint: doAll || args.has("--lint"), index: doAll || args.has("--index"), sync: doAll || args.has("--sync"), usage: doAll || args.has("--usage"), okf: doAll || args.has("--okf"), prune: doAll || args.has("--prune-memory"), dsh: doAll || args.has("--dsh-export"), docs: doAll || args.has("--docs-sync") };
const RATE_TARGET = rawArgs[rawArgs.indexOf("--rate") + 1];
const RATE_VALUE = rawArgs[rawArgs.indexOf("--rating") + 1];
const DO_RATE = args.has("--rate") && RATE_TARGET && RATE_VALUE;

// frontmatter 定位（支持前置杂行）：返回第一个"行首"--- 块（防值内 --- 如 URL 误判）
function extractFmText(content) {
  let start;
  if (content.startsWith("---")) start = 0;
  else {
    const m = content.match(/^---[\r\n]/m);
    if (!m) return null;
    start = m.index;
  }
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
  return content.slice(0, blk.start + 3) + newFm + "\n---" + content.slice(blk.end + 4);
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
          const origMtime = p.mtime; // 恢复原 mtime：元数据回写不触发 sync 重新同步（utimesSync 用秒，mtimeMs 需 /1000）
          writeFileSync(p.full, content);
          try { utimesSync(p.full, origMtime / 1000, origMtime / 1000); } catch {}
          updated++;
        }
      }
    }
    return { tracked: rows.length, updated };
  } finally { try { db.close(); } catch {} }
}

// ── OKF v0.2 对齐：补 description/sources/generated/stale_after（幂等，只补缺字段）──
function okfAlign(pages) {
  let updated = 0, aligned = 0;
  for (const p of pages) {
    if (p.cat === "索引") continue;
    let content = p.content;
    const fm = p.fm;
    const today = new Date().toISOString().slice(0, 10);
    // description：缺则从 summary 补；无 summary 则从正文首段提取（确定性摘要，幂等）
    if (!fm.description) {
      let desc = null;
      if (fm.summary && fm.summary !== "-") desc = fm.summary;
      else {
        const blk = extractFmText(content);
        if (blk) {
          const lines = content.slice(blk.end + 4).split(String.fromCharCode(10));
          let hIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("#")) { hIdx = i; break; }
          }
          for (let i = hIdx + 1; i < lines.length; i++) {
            let s = lines[i].trim();
            if (s.length <= 10) continue;
            if (s.startsWith("#") || s.startsWith("!") || s.startsWith("|")) continue;
            if (s.startsWith("-") || s.startsWith("*") || s.charCodeAt(0) === 96) continue;
            const c0 = s.charCodeAt(0), c1 = s[1];
            if (c0 >= 48 && c0 <= 57 && (c1 === "." || c1 === ")" || c1 === "、")) continue;
            // 引用块/信息卡片：剥离 "> " 前缀后作为候选（callout 头如 [!info] 跳过）
            if (s.startsWith(">")) {
              while (s.startsWith(">")) s = s.slice(1).trim();
              if (!s || s.length <= 10 || s.startsWith("[")) continue;
            }
            desc = s.split(" ").filter(Boolean).join(" ").slice(0, 80);
            break;
          }
        }
      }
      if (desc) content = setFmField(content, "description", JSON.stringify(desc));
    }
    // sources：有 source 单值 → 转 OKF sources 数组（保留原 source 兼容）
    if (fm.source && !fm.sources) {
      const res = /^https?:\/\//.test(fm.source) ? fm.source : fm.source;
      content = setFmField(content, "sources", "[{ resource: " + JSON.stringify(res) + " }]");
    }
    // generated：补 by/at（at 用 created/updated 日期近似 ISO）
    if (!fm.generated) {
      const at = (fm.updated || fm.created || today) + "T00:00:00Z";
      content = setFmField(content, "generated", "{ by: agent/dsh-llm-wiki, at: " + at + " }");
    }
    // stale_after：created/updated + 90 天
    if (!fm.stale_after) {
      const base = fm.updated || fm.created;
      if (base) {
        const d = new Date(base); d.setDate(d.getDate() + STALE_DAYS);
        content = setFmField(content, "stale_after", d.toISOString().slice(0, 10) + "T00:00:00Z");
      }
    }
    if (content !== p.content) {
      // 恢复原 mtime：--okf 是元数据规范化（记忆体条目用 summary 不含 description），不触发 sync 重新导入
      const origMtime = p.mtime;
      writeFileSync(p.full, content);
      try { utimesSync(p.full, origMtime / 1000, origMtime / 1000); } catch {}
      updated++; aligned++;
    }
  }
  return { aligned, updated };
}

// ── --dsh-export: 把 DSH 会话（~/.dsh/sessions/*/session-*/session.jsonl.zstd）导出为复盘 markdown 到 raw/sessions/dsh/
// 幂等：state.exportedDsh 记录 {sessionId: mtime}；只导出 user 文本 + assistant 正文（不导出 reasoning/工具详情）
const DSH_SESSIONS = join(homedir(), ".dsh/sessions");

function buildSessionMd(sessionId, raw) {
  const meta = { cwd: "", preset: "", createdAt: 0 };
  const blocks = [];
  let asstBuf = [];
  let curTurn = -1;
  const flush = () => {
    if (asstBuf.length) {
      const text = asstBuf.join("").trim();
      if (text) blocks.push({ role: "assistant", text });
      asstBuf = [];
    }
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "session") {
      meta.cwd = ev.cwd || ""; meta.preset = ev.agentPreset || ""; meta.createdAt = ev.createdAt || 0;
    } else if (ev.type === "agent/inbox/spliced" && ev.data && Array.isArray(ev.data.inserted)) {
      for (const ins of ev.data.inserted) {
        if (ins.role === "user" && Array.isArray(ins.content)) {
          const text = ins.content.map(c => (c && c.text) || "").join("").trim();
          if (text) { flush(); blocks.push({ role: "user", text }); }
        }
      }
    } else if (ev.type === "text-chunks" && ev.data && Array.isArray(ev.data.texts)) {
      const turn = ev.data.turn || 0;
      if (turn !== curTurn) { flush(); curTurn = turn; }
      asstBuf.push(ev.data.texts.join(""));
    }
  }
  flush();
  const date = meta.createdAt ? new Date(meta.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const title = "DSH 会话复盘" + (meta.cwd ? "：" + String(meta.cwd).split("/").filter(Boolean).pop() : "");
  let md = "---\ntitle: \"" + title + "\"\ntags: [dsh, session]\ntype: \"发现\"\ncreated: " + date + "\nsource: \"dsh:" + sessionId + "\"\n---\n\n# " + title + "\n\n- **会话**: " + sessionId + "\n- **工作目录**: " + (meta.cwd || "-") + "\n- **Agent 预设**: " + (meta.preset || "-") + "\n- **创建时间**: " + (meta.createdAt ? new Date(meta.createdAt).toISOString() : "-") + "\n- **消息块**: " + blocks.length + "\n\n## 对话记录\n\n";
  for (const b of blocks) {
    md += "### " + (b.role === "user" ? "用户" : "助手") + "\n\n" + b.text + "\n\n";
  }
  return md;
}

function dshSessionExport() {
  const state = loadState();
  const exported = state.exportedDsh || {};
  const outDir = join(VAULT, "raw/sessions/dsh");
  mkdirSync(outDir, { recursive: true });
  let exportedNow = 0;
  const results = [];
  try {
    for (const ws of readdirSync(DSH_SESSIONS)) {
      const wsDir = join(DSH_SESSIONS, ws);
      let sessionDirs;
      try { if (!statSync(wsDir).isDirectory()) continue; sessionDirs = readdirSync(wsDir); } catch { continue; }
      for (const sd of sessionDirs) {
        if (!sd.startsWith("session-")) continue;
        const sdir = join(wsDir, sd);
        const zf = join(sdir, "session.jsonl.zstd");
        try {
          if (!statSync(sdir).isDirectory() || !existsSync(zf)) continue;
          const st = statSync(zf);
          if (exported[sd] === st.mtimeMs) continue;
          const raw = execFileSync("zstd", ["-d", "-c", zf], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
          const md = buildSessionMd(sd, raw);
          const date = new Date(st.mtimeMs).toISOString().slice(0, 10);
          const dest = join(outDir, date + "-" + sd.replace(/^session-/, "").slice(0, 8) + ".md");
          writeFileSync(dest, md);
          exported[sd] = st.mtimeMs;
          exportedNow++;
          results.push(sd.slice(0, 16));
        } catch (e) { results.push(sd.slice(0, 16) + " ERR"); }
      }
    }
    if (exportedNow > 0) saveState({ ...state, exportedDsh: exported });
    return { exported: exportedNow, tracked: Object.keys(exported).length, results: results.slice(0, 6) };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}

// ── --docs-sync: 把 mnemon Documents（~/.mnemon/documents/active/*.md）回流为 wiki 页
// 幂等：state.docsImported 记录 {fileName: content_hash}；title 与已有 wiki 页重复则跳过
const DOCS_DIR = join(homedir(), ".mnemon/documents/active");

function docCategory(title) {
  if (/计划|规划|方案|调研|决策|适配|评估/.test(title)) return "决策";
  if (/接入|部署|配置|环境|发布|导航|优化/.test(title)) return "项目";
  if (/准则|原则|规范|参考|收录/.test(title)) return "引用";
  return "概念";
}

function docsSync() {
  const state = loadState();
  const imported = state.docsImported || {};
  const results = [];
  let importedNow = 0;
  try {
    if (!existsSync(DOCS_DIR)) return { error: "无 documents 目录" };
    // 已有 wiki 页 title 规范化集（去重）
    const existing = new Set();
    for (const cat of ["决策","发现","概念","项目","流程","命令","规则","提示","记忆","基因","引用"]) {
      const dir = join(WIKI, cat);
      let files = [];
      try { files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "index.md"); } catch { continue; }
      for (const f of files) {
        const t = parseFm(readFileSync(join(dir, f), "utf8")).title;
        if (t) existing.add(String(t).replace(/\s+/g, ""));
      }
    }
    for (const f of readdirSync(DOCS_DIR).filter(f => f.endsWith(".md")).sort()) {
      const text = readFileSync(join(DOCS_DIR, f), "utf8");
      const fm = parseFm(text);
      if (!fm.id || !fm.title) continue;
      if (imported[f] === fm.content_hash) continue;
      const cat = docCategory(String(fm.title));
      const normTitle = String(fm.title).replace(/\s+/g, "");
      if (existing.has(normTitle)) { results.push(String(fm.title) + " SKIP(已有页)"); imported[f] = fm.content_hash; continue; }
      const blk = extractFmText(text);
      const body = blk ? text.slice(blk.end + 4).trim() : text.trim();
      const date = String(fm.created_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const fname = String(fm.title).replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
      const md = "---\ntitle: " + JSON.stringify(String(fm.title)) + "\ntags: [wiki/" + cat + ", compiled, mnemon]\ntype: \"" + cat + "\"\ncreated: " + date + "\nupdated: " + date + "\nsource: \"mnemon:document:" + fm.id + "\"\ndescription: " + (fm.description ? JSON.stringify(String(fm.description)) : "\"\"") + "\n---\n\n" + body + "\n\n## 相关\n\n- [[wiki/决策/llm-wiki-架构设计决策]]\n- [[wiki/概念/LLM-Wiki理念]]\n";
      const dest = join(WIKI, cat, fname + ".md");
      writeFileSync(dest, md);
      imported[f] = fm.content_hash;
      importedNow++;
      existing.add(normTitle);
      results.push(cat + "/" + fname);
    }
    if (importedNow > 0) saveState({ ...state, docsImported: imported });
    return { imported: importedNow, results: results.slice(0, 12) };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}

// ── --prune-memory: 清记忆体孤儿条目（来源指向不存在的 wiki 页）──
function pruneMemory() {
  let db;
  try { db = new DatabaseSync(join(homedir(), ".mnemon/data/default/mnemon.db"), { readOnly: false }); }
  catch (e) { return { error: "无法打开 mnemon db: " + e.message }; }
  try {
    const rows = db.prepare("SELECT id, content FROM insights WHERE content LIKE ? AND deleted_at IS NULL").all("%来源: wiki/%");
    let pruned = 0;
    const gone = [];
    for (const r of rows) {
      const m = String(r.content).match(/来源: ([^）)]+)/);
      if (!m) continue;
      const rel = m[1].trim();
      if (!existsSync(join(VAULT, rel))) {
        // 软删（mnemon 的 deleted_at 机制）
        db.prepare("UPDATE insights SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
        pruned++;
        gone.push(rel);
      }
    }
    return { scanned: rows.length, pruned, gone: gone.slice(0, 8) };
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
    // OKF 结构检查
    const content = p.content;
    if (!content.startsWith("---")) issues.push({ type: "okf", path: p.rel, message: "frontmatter 不在文件开头" });
    else {
      const closing = content.indexOf("\n---", 4);
      if (closing < 0) issues.push({ type: "okf", path: p.rel, message: "frontmatter 无 closing ---" });
    }
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
    const desc = (p.fm.description || p.fm.summary) && (p.fm.description || p.fm.summary) !== "-" ? "：" + (p.fm.description || p.fm.summary) : "";
    return {
      content: "[LLM-Wiki/" + p.cat + "] " + (p.fm.title || p.file) + desc + "（来源: " + p.rel + "）",
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
  if (RUN.okf) {
    console.log("\n== okf ==");
    if (DRY) console.log("(--dry-run) 将补 OKF v0.2 字段（description/sources/generated/stale_after）");
    else { const r = okfAlign(pages); console.log("OKF 对齐:", JSON.stringify(r)); summary.push("okf:" + (r.aligned || 0) + "页"); }
  }
  if (RUN.docs) {
    console.log("\n== docs-sync ==");
    if (DRY) console.log("(--dry-run) 将把 mnemon Documents 回流为 wiki 页");
    else { const r = docsSync(); console.log("回流:", JSON.stringify(r)); summary.push("docs:" + (r.imported || 0) + "个"); }
  }
  if (RUN.dsh) {
    console.log("\n== dsh-export ==");
    if (DRY) console.log("(--dry-run) 将导出 DSH 会话复盘到 raw/sessions/dsh/");
    else { const r = dshSessionExport(); console.log("导出:", JSON.stringify(r)); summary.push("dsh:" + (r.exported || 0) + "个"); }
  }
  if (RUN.prune) {
    console.log("\n== prune-memory ==");
    if (DRY) console.log("(--dry-run) 将软删来源指向不存在 wiki 页的记忆体条目");
    else { const r = pruneMemory(); console.log("清理:", JSON.stringify(r)); summary.push("prune:" + (r.pruned || 0) + "条"); }
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
