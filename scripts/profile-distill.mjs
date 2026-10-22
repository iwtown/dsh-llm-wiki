#!/usr/bin/env node
// profile-distill.mjs —— 从证据蒸馏 USER.md 候选（只读，不写 USER.md）
// 用法: node profile-distill.mjs [--since 7d] [--out D:/DB/DSH/reports] [--max 30]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const sinceDays = Number(String(arg("since", "7d")).replace(/d$/, "")) || 7;
const outDir = arg("out", "D:/DB/DSH/reports");
const maxSessions = Number(arg("max", "30")) || 30;
const HOME = os.homedir();
const USER_MD = path.join(HOME, ".mnemon", "runtime", "USER.md");
const SESSIONS = path.join(HOME, ".dsh", "sessions");
const DB = path.join(HOME, ".mnemon", "data", "default", "mnemon.db");
const cutoff = Date.now() - sinceDays * 864e5;

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
function userEntries() { return readText(USER_MD).split(/\u00a7/).map(s => s.trim()).filter(Boolean); }

function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  let text = "";
  for (let i = 0; i < starts.length; i++) { try { text += zstdDecompressSync(buf.subarray(starts[i], starts[i + 1] || buf.length)).toString("utf8"); } catch {} }
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const NOISE = [/^Current runtime context/i, /MNEMON RUNTIME MEMORY SNAPSHOT/, /^Time sampled while preparing/, /dsh-mnemon:delegated/, /^Browser time zone for this request/, /^# LLM-Wiki/];
function isNoise(t) { return NOISE.some(re => re.test(t)); }
function userTexts() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl.zstd")) { try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs }); } catch {} } } };
  try { walk(SESSIONS); } catch {}
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, maxSessions)) {
    let frames = [];
    try { frames = decodeSession(f.p); } catch { continue; }
    const sessionId = path.basename(path.dirname(f.p));
    for (const fr of frames) {
      if (fr.type !== "user/message") continue;
      const blocks = (fr.data && fr.data.content) || [];
      const text = blocks.filter(b => b && b.type === "text").map(b => b.text || "").join(" ").trim();
      if (!text || text.length < 3 || text.length > 1200 || isNoise(text)) continue;
      out.push({ sessionId, date: new Date(f.mtime).toISOString().slice(0, 10), text });
    }
  }
  return out;
}
function preferenceMemories() {
  const out = [];
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("select content from insights where deleted_at is null and source != 'import' and (category = 'preference' or tags like '%preference%')").all();
    db.close();
    for (const r of rows) if (r.content) out.push({ sessionId: "memory-space", date: "", text: String(r.content) });
  } catch {}
  return out;
}

const SIGNAL = /(不要|别再|以后|下次|我更|我比较|偏好|习惯|默认|必须|禁止|应该|请用|我希望|记住|始终|总是|优先|尽量|别用|不需要|先给|先做|先计划)/;
const STRONG = /(不要|禁止|必须|以后都|以后|默认|始终|总是|记住|绝不)/;
const SENT = /[。！？\n]/;
function sentences(text) { return text.split(SENT).map(s => s.trim()).filter(s => s.length >= 4 && s.length <= 120); }
function norm(s) { return s.replace(/[\s，。！？、；：""''（）()\[\]]/g, "").toLowerCase(); }

const SECTIONS = [
  ["红线", /(禁止|绝不|不要|必须|安全|删除|密钥|权限|隐私)/],
  ["沟通", /(回答|输出|格式|表格|简洁|详细|语气|中文|英文|语言|字数|长度|排版)/],
  ["技术", /(代码|工具|模型|provider|依赖|python|node|git|代理|端口|编辑器|命令|插件)/],
  ["决策", /(成本|token|优先|取舍|方案|风险|验证|测试|先计划|先给|先做|评估)/],
  ["工作", /./]
];
function sectionOf(text) { for (const [name, re] of SECTIONS) if (re.test(text)) return name; return "工作"; }

const messages = [...userTexts(), ...preferenceMemories()];
const groups = new Map();
for (const m of messages) {
  for (const s of sentences(m.text)) {
    if (!SIGNAL.test(s)) continue;
    // 提问不是偏好：末尾问号/吗呢、疑问句式直接丢弃
    if (/[?？]\s*$/.test(s) || /(吗|呢)\s*$/.test(s)) continue;
    if (/(如何|怎么|能不能|是否|为什么|要不要|可不可以)/.test(s) && s.length > 15) continue;
    const key = norm(s).slice(0, 80);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, text: s, quotes: [], sessions: new Set(), dates: [] });
    const g = groups.get(key);
    if (g.quotes.length < 3) g.quotes.push({ sessionId: m.sessionId, date: m.date, text: s });
    g.sessions.add(m.sessionId);
    if (m.date) g.dates.push(m.date);
  }
}
const candidates = [];
for (const g of groups.values()) {
  const count = g.sessions.size;
  const strong = STRONG.test(g.text);
  if (count < 2 && !strong) continue;
  const confidence = count >= 2 ? (strong ? 0.9 : 0.75) : 0.8;
  const lastDate = g.dates.sort().slice(-1)[0] || "";
  candidates.push({ text: g.text.slice(0, 60), section: sectionOf(g.text), confidence, count, lastDate, quotes: g.quotes });
}
const current = userEntries();
const curNorm = current.map(norm);
function covered(text) {
  const n = norm(text);
  const pot = /(不要|不用|禁止|绝不|别再|不需要)/.test(text);
  return current.some((c, i) => {
    const cn = curNorm[i];
    if (cn === n || (cn.length > 6 && (cn.includes(n) || n.includes(cn)))) return true;
    // 语义近似：同一主题词 >=2 且极性一致，视为已覆盖
    return overlaps(text, c) >= 1 && pot === /(不要|不用|禁止|绝不|别再|不需要)/.test(c);
  });
}
// 中文分词不可用：用主题词表判断“同一主题”，避免字面不同导致重复写入
const TOPICS = ["代理", "v2ray", "模型", "provider", "免费", "token", "成本", "语言", "中文", "英文", "格式", "表格", "简洁", "详细", "计划", "验证", "测试", "删除", "密钥", "路径", "端口", "git", "python", "node", "代码", "工具", "插件", "依赖", "风险", "方案", "长度", "时间", "备份", "同步", "记忆"];
function overlaps(a, b) { const B = new Set(TOPICS.filter(t => String(b).includes(t))); return TOPICS.filter(t => String(a).includes(t)).filter(t => B.has(t)).length; }
for (const c of candidates) {
  c.action = covered(c.text) ? "exists" : "new";
  if (c.action === "new") {
    for (const cur of current) {
      if ((/(不要|不用|禁止|绝不|别再|不需要)/.test(c.text) !== /(不要|不用|禁止|绝不|别再|不需要)/.test(cur)) && overlaps(c.text, cur) >= 1) { c.action = "conflict"; c.conflictWith = cur; break; }
    }
  }
}
const picked = candidates.filter(c => c.action !== "exists").sort((a, b) => b.confidence - a.confidence || b.count - a.count);
const budget = [];
let bytes = 0;
for (const c of picked) {
  const size = Buffer.byteLength(c.text, "utf8") + 8;
  if (budget.length >= 40 || bytes + size > 2048) continue;
  budget.push(c); bytes += size;
}
const date = new Date().toISOString().slice(0, 10);
const md = [];
md.push("# USER.md 蒸馏候选（" + date + "）", "");
md.push("> 只读候选，未写入 USER.md。证据窗口 " + sinceDays + " 天；会话 " + (new Set(messages.filter(m => m.sessionId !== "memory-space").map(m => m.sessionId))).size + " 个。", "");
md.push("## 建议新增（" + budget.filter(c => c.action === "new").length + "）", "");
for (const c of budget.filter(c => c.action === "new")) md.push("- [" + c.section + "] " + c.text + "（置信 " + c.confidence + "，证据 " + c.count + " 次" + (c.lastDate ? "，最近 " + c.lastDate : "") + "）");
md.push("", "## 可能冲突（" + budget.filter(c => c.action === "conflict").length + "）", "");
for (const c of budget.filter(c => c.action === "conflict")) md.push("- [" + c.section + "] " + c.text + " ↔ 现有：" + (c.conflictWith || "").slice(0, 50));
md.push("", "## 已存在（跳过，前 10）", "");
for (const c of candidates.filter(c => c.action === "exists").slice(0, 10)) md.push("- " + c.text);
md.push("", "## 证据附录（前 20 条）", "");
for (const c of budget.slice(0, 20)) for (const q of c.quotes.slice(0, 2)) md.push("- " + q.sessionId + " " + q.date + "：「" + q.text.slice(0, 80) + "」");
md.push("", "## 统计", "", "- 候选总数: " + candidates.length, "- 可写入预算: " + budget.length + " 条 / " + bytes + " B", "- 当前 USER.md: " + Buffer.byteLength(current.join("\u00a7"), "utf8") + " B / " + current.length + " 条", "");
fs.mkdirSync(outDir, { recursive: true });
const mdPath = path.join(outDir, "profile-candidate-" + date + ".md");
const jsonPath = path.join(outDir, "profile-candidate-" + date + ".json");
fs.writeFileSync(mdPath, md.join("\n"), "utf8");
fs.writeFileSync(jsonPath, JSON.stringify({ date, sinceDays, userBytes: Buffer.byteLength(current.join("\u00a7"), "utf8"), userCount: current.length, budgetBytes: bytes, candidates: budget }, null, 1), "utf8");
console.log(JSON.stringify({ date, messages: messages.length, candidates: candidates.length, new: budget.filter(c => c.action === "new").length, conflict: budget.filter(c => c.action === "conflict").length, exists: candidates.filter(c => c.action === "exists").length, budgetBytes: bytes, md: mdPath }));
