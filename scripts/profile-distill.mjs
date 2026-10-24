#!/usr/bin/env node
// profile-distill.mjs v2 —— 画像蒸馏（只读）：画像页 + 会话 + 记忆空间 + USER.md → 候选/冲突/过期/预算
// 用法: node profile-distill.mjs [--since 7d] [--out D:/DB/DSH/reports] [--max 30] [--profile <画像页>]
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
const USER_MD = process.env.USER_MD || path.join(HOME, ".mnemon", "runtime", "USER.md");
const PROFILE = process.env.PROFILE_PAGE || arg("profile", "D:/DB/Obsidian/LLM-Wiki/wiki/项目/习惯与偏好（Agent 自适应画像）.md");
const SESSIONS = path.join(HOME, ".dsh", "sessions");
const DB = path.join(HOME, ".mnemon", "data", "default", "mnemon.db");
const cutoff = Date.now() - sinceDays * 864e5;
const TODAY = new Date().toISOString().slice(0, 10);

const readText = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const userEntries = () => readText(USER_MD).split(/\u00a7/).map(s => s.trim()).filter(Boolean);
const norm = s => String(s).replace(/[\s，。！？、；：""''（）()\[\]]/g, "").toLowerCase();
const POL = t => /(不要|不用|不走|不写|不装|不改|不允许|禁止|绝不|别再|不需要|不擅自|不得|严禁|勿|无需|避免|杜绝|拒绝)/.test(String(t));
const TOPICS = ["代理","v2ray","模型","provider","免费","token","成本","语言","中文","英文","格式","表格","简洁","详细","计划","验证","测试","删除","密钥","路径","端口","git","python","node","代码","工具","插件","依赖","风险","方案","长度","时间","备份","同步","记忆","结论","展开","流水账","改页","wiki","mnemon","环境","隐私","权限","组件","身份"];
const topicsOf = t => TOPICS.filter(x => String(t).includes(x));
const overlaps = (a, b) => { const B = new Set(topicsOf(b)); return topicsOf(a).filter(x => B.has(x)).length; };

// ── 画像页解析 ──
function parseProfile() {
  const text = readText(PROFILE);
  const out = [];
  if (!text) return out;
  let section = "";
  for (const line of text.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    if (!/^-\s+/.test(line)) continue;
    if (/演变记录/.test(section)) continue;
    const body = line.replace(/^-\s+/, "").trim();
    if (!body || body.startsWith("（待补充）")) continue;
    const parts = body.split("｜").map(s => s.trim());
    const rule = (parts[0] || "").replace(/^反偏好[：:]\s*/, "");
    if (!rule) continue;
    const field = key => { const p = parts.find(x => x.startsWith(key)); return p ? p.slice(key.length).replace(/^[：:]\s*/, "").trim() : ""; };
    const validity = field("有效期");
    const conf = field("置信") || "medium";
    const status = field("状态") || "active";
    const importance = field("重要度");
    const ev = field("证据");
    const num = (ev.match(/（(\d+)\s*次）/) || ev.match(/\/\s*(\d+)\s*次/) || [])[1];
    out.push({ section, rule, conf, status, validity, importance, evidence: ev, evidenceCount: Number(num || (ev ? 1 : 0)) });
  }
  return out;
}

// ── 会话证据 ──
function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) starts.push(i);
  let text = "";
  for (let i = 0; i < starts.length; i++) { try { text += zstdDecompressSync(buf.subarray(starts[i], starts[i+1] || buf.length)).toString("utf8"); } catch {} }
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const NOISE = [/^Current runtime context/i, /MNEMON RUNTIME MEMORY SNAPSHOT/, /^Time sampled while preparing/, /dsh-mnemon:delegated/, /^Browser time zone for this request/, /^# LLM-Wiki/];
const isNoise = t => NOISE.some(re => re.test(t));
function userTexts() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl.zstd")) { try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs }); } catch {} } } };
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

// ── evidence v3 加载（profile-extract.mjs 产出）──
const EVID_DIR = process.env.PROFILE_EVIDENCE_DIR || "D:/DB/DSH/reports/profile-evidence";
function loadEvidence() {
  const out = [];
  try {
    if (!fs.existsSync(EVID_DIR)) return out;
    for (const f of fs.readdirSync(EVID_DIR).filter(x => x.endsWith(".jsonl"))) {
      const p = path.join(EVID_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) continue; } catch { continue; }
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const x = JSON.parse(line); if (x && x.rule) out.push(x); } catch {}
      }
    }
  } catch {}
  return out;
}
const evidence = loadEvidence();

// ── 证据 → 候选 ──
const SIGNAL = /(不要|别再|以后|下次|我更|我比较|偏好|习惯|默认|必须|禁止|应该|请用|我希望|记住|始终|总是|优先|尽量|别用|不需要|先给|先做|先计划|为我|对我)/;
const STRONG = /(不要|禁止|必须|以后都|以后|默认|始终|总是|记住|绝不)/;
const messages = [...userTexts(), ...preferenceMemories()];
const groups = new Map();
for (const m of messages) {
  for (const s of m.text.split(/[。！？\n]/).map(x => x.trim())) {
    if (s.length < 4 || s.length > 120 || !SIGNAL.test(s)) continue;
    if (/[?？]\s*$/.test(s) || /(吗|呢)\s*$/.test(s)) continue;
    if (/(如何|怎么|能不能|是否|为什么|要不要|可不可以)/.test(s) && s.length > 15) continue;
    const key = norm(s).slice(0, 80);
    if (!groups.has(key)) groups.set(key, { text: s, sessions: new Set(), dates: [], quotes: [] });
    const x = groups.get(key);
    x.sessions.add(m.sessionId); if (m.date) x.dates.push(m.date);
    if (x.quotes.length < 3) x.quotes.push({ sessionId: m.sessionId, date: m.date, text: s });
  }
}
const profile = parseProfile();
const current = userEntries();
const profByNorm = new Map(profile.map(p => [norm(p.rule), p]));

const candidates = [];
for (const g of groups.values()) {
  if (evidence.length) continue;
  const count = g.sessions.size;
  const strong = STRONG.test(g.text);
  if (count < 2 && !strong) continue;
  const confidence = count >= 2 ? (strong ? 0.9 : 0.75) : 0.8;
  const lastDate = g.dates.sort().slice(-1)[0] || "";
  const matchUser = current.find(c => { const n = norm(c), m = norm(g.text); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))); });
  const matchProf = [...profByNorm.values()].find(p => { const n = norm(p.rule), m = norm(g.text); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))); });
  let action = "add";
  if (matchUser) action = "refresh";
  else if (current.some(c => POL(c) !== POL(g.text) && overlaps(c, g.text) >= 1)) action = "supersede";
  else if (current.some(c => overlaps(c, g.text) >= 2 && POL(c) === POL(g.text))) action = "refresh";
  else if (current.some(c => norm(g.text).includes(norm(c)) && norm(g.text).length > norm(c).length + 4)) action = "refine";
  if (matchProf && !matchUser) action = "promote"; // 画像页 active 但 USER.md 缺失
  candidates.push({ kind: "evidence", action, decision: "ADD", slot: "unclassified", text: g.text.slice(0, 70), confidence, count, lastDate,
    conflictsWith: current.find(c => POL(c) !== POL(g.text) && overlaps(c, g.text) >= 1) || "",
    profileRule: matchProf ? matchProf.rule : "", quotes: g.quotes });
}
// ── v3.2 复核：稳定偏好 vs 当次任务（LLM 批量判定，带缓存）──
const REVIEW_CACHE = path.join(EVID_DIR, ".review-cache.json");
const REVIEW_MODELS = (process.env.LLM_WIKI_REVIEW_MODELS || "deepseek-flash").split(",").map(x => x.trim()).filter(Boolean);
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const writeJson = (p, o) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1), "utf8"); } catch {} };
const sfKey2 = () => { try { const c = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8"); const m = c.match(/^\s*SF_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, "") : ""; } catch { return ""; } };
function dsKey() { try { const c = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8"); const m = c.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, "") : ""; } catch { return ""; } }
const reviewModelsUsed = {};
function zaiKey2() { try { const c = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8"); const m = c.match(/^\s*ZAI_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, "") : ""; } catch { return ""; } }
async function callReview(prompt, maxTokens = 800) {
  let lastErr;
  for (const model of REVIEW_MODELS) {
    for (let a = 1; a <= 2; a++) {
      try {
        const isOfficial = /^deepseek-(flash|pro|chat|reasoner)/.test(model);
        const isZai = /^glm-/.test(model);
        const key = isOfficial ? (process.env.DEEPSEEK_API_KEY || dsKey())
          : isZai ? (process.env.ZAI_API_KEY || zaiKey2())
          : (process.env.LLM_WIKI_LLM_KEY || sfKey2());
        if (!key) throw new Error("no key");
        const ep = isOfficial ? ((process.env.LLM_WIKI_REVIEW_ENDPOINT || "https://api.deepseek.com/v1").replace(/\/$/, "") + "/chat/completions")
          : isZai ? "https://api.z.ai/api/paas/v4/chat/completions"
          : (process.env.LLM_WIKI_LLM_ENDPOINT || "https://api.siliconflow.cn/v1").replace(/\/$/, "") + "/chat/completions";
        const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: Math.max(maxTokens, 1200) };
        if (isOfficial) body.reasoning_effort = "low";
        else if (!isZai) body.enable_thinking = false; else body.thinking = { type: "disabled" };
        const res = await fetch(ep, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
          body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        reviewModelsUsed[model] = (reviewModelsUsed[model] || 0) + 1;
        return String(j.choices?.[0]?.message?.content || "");
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error("review failed");
}
async function reviewEvidence(groups) {
  if (process.env.PROFILE_REVIEW === "off") { const c = {}; for (const [k] of groups) c[k] = { keep: true, reason: "review off" }; return c; }
  const cache = readJson(REVIEW_CACHE);
  const todo = [];
  const TYPE_AUTO = new Set(["decision_pattern", "work_habit", "anti_preference"]);
  const OBJECT_BOUND = /https?:|\\\\|\/|\.md|\d+\.\d+\.\d+|仓库|端口|pcie|aspm|token|C盘|D盘/i;
  for (const [key, g] of groups) {
    if (cache[key]) continue;
    if (TYPE_AUTO.has(String(g.type || "")) && g.sessions.size >= 2 && !OBJECT_BOUND.test(String(g.rule || ""))) { cache[key] = { keep: true, reason: "type 放行" }; continue; }
    todo.push({ key, rule: g.rule, type: g.type, quotes: g.quotes.slice(0, 2) });
  }
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const lines = batch.map((x, idx) => (idx + 1) + ". 规则：" + x.rule + "\n   原话：" + (x.quotes.map((q) => q.text).join(" / ") || "")).join("\n");
    const prompt = "你是用户画像评审员。判断每条候选是【稳定偏好/习惯】还是【当次任务/一次性指令】。\n" +
      "只输出 JSON 数组：[{\"i\":1,\"keep\":true|false,\"reason\":\"≤20字\"}]。\n" +
      "判定标准：稳定偏好 = 跨任务适用、用户表达的是“以后/默认/不要/必须”或明确纠正；当次任务 = 针对某个项目/文件/动作的一次性指令（如“先盘点损失”“处理 github 欠债”）。\n" +
      "宁严勿宽：不确定就 keep=false。\n候选：\n" + lines;
    try {
      const out = await callReview(prompt);
      const a = out.indexOf("["), b = out.lastIndexOf("]");
      const arr = a >= 0 && b > a ? JSON.parse(out.slice(a, b + 1)) : [];
      arr.forEach((x, idx) => { const t = batch[(x.i || idx + 1) - 1]; if (t) cache[t.key] = { keep: !!x.keep, reason: String(x.reason || "").slice(0, 40) }; });
      for (const x of batch) if (!cache[x.key]) cache[x.key] = { keep: false, reason: "review 未返回" };
    } catch (e) {
      for (const x of batch) if (!cache[x.key]) cache[x.key] = { keep: false, reason: "review 失败:" + String(e.message).slice(0, 30) };
    }
  }
  writeJson(REVIEW_CACHE, cache);
  return cache;
}

// evidence v3 聚簇 → 候选
const evGroups = new Map();
for (const e of evidence) {
  const key = norm(e.rule).slice(0, 60);
  if (!evGroups.has(key)) evGroups.set(key, { rule: e.rule, type: e.type, polarity: e.polarity, scope: e.scope, confidence: e.confidence || 0.6, sessions: new Set(), dates: [], quotes: [], slots: {} });
  const g = evGroups.get(key);
  g.sessions.add(e.sessionId);
  if (e.date) g.dates.push(e.date);
  g.confidence = Math.max(g.confidence, e.confidence || 0);
  if (e.slot) g.slots[e.slot] = (g.slots[e.slot] || 0) + 1;
  if (g.quotes.length < 3) g.quotes.push({ sessionId: e.sessionId, date: e.date, text: e.quote || e.rule });
}
// 同义/错别字模糊合并（同极性、Jaccard≥0.5 或包含关系）
function similarRule(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 6 && nb.length >= 6 && (na.includes(nb) || nb.includes(na))) return true;
  const bg = x => { const t = new Set(); for (let i = 0; i < x.length - 1; i++) t.add(x.slice(i, i + 2)); return t; };
  const A = bg(na), B = bg(nb); let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni > 0 && inter / uni >= 0.4 && POL(a) === POL(b);
}
const mergedGroups = new Map();
for (const [key, g] of evGroups) {
  let target = null;
  for (const [mk, mg] of mergedGroups) if (similarRule(mg.rule, g.rule)) { target = [mk, mg]; break; }
  if (!target) { mergedGroups.set(key, g); continue; }
  const mg = target[1];
  if (String(g.rule).length > String(mg.rule).length) mg.rule = g.rule;
  for (const sid of g.sessions) mg.sessions.add(sid);
  mg.dates.push(...g.dates);
  for (const q of g.quotes) if (mg.quotes.length < 6) mg.quotes.push(q);
  mg.confidence = Math.max(mg.confidence, g.confidence);
  for (const [k, v] of Object.entries(g.slots || {})) mg.slots[k] = (mg.slots[k] || 0) + v;
}
// ── 槽位本体（schema v1）──
const SCHEMA = (() => { try { return JSON.parse(fs.readFileSync(process.env.PROFILE_SCHEMA || fileURLToPath(new URL("./profile-schema.json", import.meta.url)), "utf8")); } catch { return { slots: [] }; } })();
const SLOTS = SCHEMA.slots || [];
function slotOf(text) {
  const t = norm(text); let best = "unclassified"; let bs = 0;
  for (const s of SLOTS) {
    let score = 0;
    for (const k of (s.keywords || [])) if (t.includes(norm(k))) score += 2;
    if (t.includes(norm(s.name))) score += 3;
    if (score > bs) { bs = score; best = s.id; }
  }
  return bs > 0 ? best : "unclassified";
}
const ANT_PAIRS = [[/免费/, /付费/], [/开启/, /关闭/], [/允许/, /禁止/], [/本地/, /远程/], [/保留/, /删除/], [/默认/, /显式/], [/冒烟/, /回归/], [/小步/, /一次到底/]];
function contrasts(a, b) {
  const A = String(a), B = String(b);
  return ANT_PAIRS.some(([x, y]) => (x.test(A) && y.test(B)) || (y.test(A) && x.test(B)));
}
function opposes(a, b) {
  const pos = /(允许|应该|必须|可以|建议|默认走)/, neg = /(不要|不用|不走|不写|不装|不改|不允许|禁止|不得|严禁|别|避免)/;
  return (pos.test(a) && neg.test(b)) || (pos.test(b) && neg.test(a));
}
const CORE_OBJECT = /(轮子|代理|免责|方案|计划|测试|验证|依赖|插件|模型|目录|配置|啰嗦|自检|优先级|阶段|复核|归档)/g;
function sharedBigrams(a, b) {
  const bg = s => { const t = new Set(); for (let i = 0; i < s.length - 1; i++) t.add(s.slice(i, i + 2)); return t; };
  const A = bg(norm(a)), B = bg(norm(b));
  let hit = 0; for (const x of A) if (B.has(x)) hit++;
  return hit;
}
function sameObject(a, b) {
  const A = String(a).match(CORE_OBJECT) || [], B = String(b).match(CORE_OBJECT) || [];
  return A.some(x => B.includes(x));
}
function addsCondition(rule, existing) {
  const cues = ['审核', '之后', '然后', '同时', '至少', '不超过', '超过', '必须', '只', '仅', '再'];
  return cues.some(c => String(rule).includes(c) && !String(existing).includes(c));
}
function coveredBy(rule, existing) {
  const bigrams = s => { const t = new Set(); for (let i = 0; i < s.length - 1; i++) t.add(s.slice(i, i + 2)); return t; };
  const a = bigrams(norm(rule)), b = bigrams(norm(existing));
  if (!a.size || !b.size) return false;
  let hit = 0; for (const x of a) if (b.has(x)) hit++;
  return hit / a.size >= 0.6;
}
function classifyConflict(existing, rule) {
  if (/(以后|现在|改成|换成|改为|不再|已经)/.test(rule)) return "temporal";
  if (contrasts(existing, rule)) return "factual";
  const hard = /(只|仅|必须|禁止|默认|全部)/;
  if (hard.test(existing) && hard.test(rule)) return "factual";
  return "contextual";
}

const review = await reviewEvidence(mergedGroups);
for (const g of mergedGroups.values()) {
  const rk = norm(g.rule).slice(0, 60);
  if (review[rk] && review[rk].keep === false) continue;
  if (/^(否定|指出|要求|说明|确认|回复|表示)/.test(String(g.rule || ""))) continue;
  const count = g.sessions.size;
  const PROCESS_RULE = /(先.{0,10}(再|然后)|方案|计划|审核|复盘|拆解|小步)/;
  const need = (g.type === "explicit_correction" || g.type === "anti_preference") ? 1
    : g.type === "repeated_request" ? 2
    : PROCESS_RULE.test(String(g.rule || "")) ? 2 : 3;
  if (count < need) continue;
  const lastDate = g.dates.sort().slice(-1)[0] || "";
  const matchUser = current.find(c => { const n = norm(c), m = norm(g.rule); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))); });
  const matchProf = [...profByNorm.values()].find(p => { const n = norm(p.rule), m = norm(g.rule); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))); });
  const slotTop = Object.entries(g.slots || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "unclassified";
  const slot = slotTop !== "unclassified" ? slotTop : slotOf(g.rule);
  let action = "add";
  if (matchUser) action = "refresh";
  else if (current.some(c => contrasts(g.rule, c) || (POL(c) !== POL(g.rule) && overlaps(c, g.rule) >= 1 && opposes(g.rule, c)))) action = "supersede";
  else if (current.some(c => overlaps(c, g.rule) >= 2 && POL(c) === POL(g.rule))) action = "refresh";
  else if (current.some(c => overlaps(c, g.rule) >= 1)) action = "refine";
  else if (current.some(c => norm(g.rule).includes(norm(c)) && norm(g.rule).length > norm(c).length + 4)) action = "refine";
  if (matchProf && !matchUser) action = "promote";
  const conflictsWith = current.find(c => POL(c) !== POL(g.rule) && overlaps(c, g.rule) >= 1) || "";
  let decision = "ADD";
  if (matchUser) decision = "NOOP";
  else if (action === "supersede") decision = "CONFLICT";
  else if (action === "refine" || action === "refresh") decision = "UPDATE";
  if (decision !== "NOOP" && decision !== "CONFLICT" && current.some(c => (coveredBy(g.rule, c) && !addsCondition(g.rule, c)) || (POL(c) === POL(g.rule) && sameObject(g.rule, c) && sharedBigrams(g.rule, c) >= 2 && !addsCondition(g.rule, c)))) decision = "NOOP";
  const conflictType = decision === "CONFLICT" ? classifyConflict(conflictsWith, g.rule) : null;
  candidates.push({ kind: "evidence-v3", action, decision, slot, conflictType, text: g.rule.slice(0, 70), type: g.type, confidence: g.confidence, count, lastDate,
    conflictsWith, profileRule: matchProf ? matchProf.rule : "", quotes: g.quotes });
}

// 画像页自身检查：过期 / 无证据 / 与 USER.md 不一致
for (const p of profile) {
  if (p.validity && p.validity !== "永久" && p.validity < TODAY && p.status === "active")
    candidates.push({ kind: "profile", action: "expire", decision: "EXPIRE", slot: slotOf(p.rule), text: p.rule, section: p.section, confidence: 0.9, count: p.evidenceCount, validity: p.validity });
  if (p.status === "active" && p.evidenceCount === 0)
    candidates.push({ kind: "profile", action: "orphan-evidence", decision: "ORPHAN", slot: slotOf(p.rule), text: p.rule, section: p.section, confidence: 0.6, count: 0 });
  const inUser = current.some(c => { const n = norm(c), m = norm(p.rule); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))) || (overlaps(c, p.rule) >= 2 && POL(c) === POL(p.rule)); });
  if (p.status === "active" && !inUser)
    candidates.push({ kind: "profile", action: "promote", decision: "ADD", slot: slotOf(p.rule), text: p.rule, section: p.section, confidence: 0.8, count: p.evidenceCount });
}

// ── 同槽近似候选合并（保留更长表述）──
{
  const kept = [];
  for (const c of candidates) {
    if (!["ADD", "UPDATE"].includes(c.decision)) { kept.push(c); continue; }
    const hit = kept.find(x => x.decision === c.decision && x.slot === c.slot && (coveredBy(c.text, x.text) || coveredBy(x.text, c.text)));
    if (hit) {
      if (String(c.text).length > String(hit.text).length) hit.text = c.text;
      hit.count = Math.max(hit.count || 0, c.count || 0);
      hit.confidence = Math.max(hit.confidence || 0, c.confidence || 0);
      hit.quotes = [...(hit.quotes || []), ...(c.quotes || [])].slice(0, 6);
      continue;
    }
    kept.push(c);
  }
  candidates.length = 0; candidates.push(...kept);
}

// ── 预算 ──
const userBytes = Buffer.byteLength(current.join("\u00a7"), "utf8");
const LIMIT = 4096, TARGET = 2048;
const adds = candidates.filter(c => ["ADD", "UPDATE"].includes(c.decision));
let budget = [], bytes = userBytes;
const MAX_ADD = Number(process.env.PROFILE_MAX_ADD || 12);
const bucketOf = c => /(不要|禁止|必须|不得)/.test(c.text) || c.type === "anti_preference" ? "red"
  : /(沟通|啰嗦|免责|结论|输出|语言|格式)/.test(c.text) ? "comm"
  : /(先|方案|计划|核实|验证|优先级|复盘|拆解|设计)/.test(c.text) ? "work" : "other";
const QUOTA = { red: 3, comm: 2, work: 5, other: 2 };
const usedBucket = { red: 0, comm: 0, work: 0, other: 0 };
for (const c of adds.sort((a, b) => b.confidence - a.confidence || b.count - a.count)) {
  if (budget.length >= MAX_ADD) break;
  const bk = bucketOf(c);
  if (usedBucket[bk] >= QUOTA[bk]) continue;
  const size = Buffer.byteLength(c.text, "utf8") + 8;
  if (bytes + size > TARGET) continue;
  budget.push(c); bytes += size; usedBucket[bk]++;
}

// ── 预算淘汰建议（超目标时；只提案，不自动删）──
const sizeOf = t => Buffer.byteLength(t, "utf8") + 8;
const placed = new Set(budget.map(c => c.text));
const pendingAdds = adds.filter(c => !placed.has(c.text));
const evictions = [];
const PROTECT = /(代理|模型|token|偏好|红线|禁止|必须|隐私|密钥|方案|计划|结论|验证|目标|最小实现|外科|调研|边界|歧义|自主|依赖|免责|产出)/;
if (pendingAdds.length || bytes > TARGET) {
  const scored = current.map((text, i) => {
    const pe = [...profByNorm.values()].find(pp => { const n = norm(pp.rule), m = norm(text); return n === m || (n.length > 6 && (n.includes(m) || m.includes(n))); });
    const ev = pe ? pe.evidenceCount : 1;
    const conf = pe ? pe.conf : "medium";
    return { text, i, ev, conf, val: pe ? (pe.validity || "") : "", protect: PROTECT.test(text) ? 2 : 0 };
  });
  scored.sort((a, b) => (a.ev + a.protect) - (b.ev + b.protect) || ((a.conf === "low" ? 0 : 1) - (b.conf === "low" ? 0 : 1)) || a.i - b.i);
  let excess = bytes + pendingAdds.reduce((a, c) => a + sizeOf(c.text), 0) - TARGET;
  for (const s of scored) {
    if (excess <= 0 || evictions.length >= 5) break;
    if (s.protect) continue;
    evictions.push({ kind: "evict", text: s.text, evidenceCount: s.ev, confidence: s.conf, validity: s.val, reason: s.ev === 0 ? "无证据" : (s.conf === "low" ? "低置信" : "最久未确认") });
    excess -= sizeOf(s.text);
  }
  var evictShortfall = Math.max(0, excess);
}

// ── 输出 ──
const byAction = a => candidates.filter(c => c.action === a);
const md = [];
md.push("# 画像蒸馏候选 " + TODAY, "");
const reviewed = Object.values(review || {}); md.push("> 只读：未写 USER.md。复核：" + reviewed.filter(x => x.keep).length + " keep / " + reviewed.filter(x => !x.keep).length + " drop。证据源：" + (evidence.length ? ("extract v3（" + evidence.length + " 条 / " + new Set(evidence.map(e => e.sessionId)).size + " 会话）") : "正则兜底") + " | 画像页条目 " + profile.length + " | USER.md " + current.length + " 条 " + userBytes + "B/" + LIMIT + "B | 证据窗口 " + sinceDays + "d | 会话 " + new Set(messages.filter(m => m.sessionId !== "memory-space").map(m => m.sessionId)).size + " 个", "");
const byDecision = dec => candidates.filter(c => c.decision === dec);
md.push("## ADD 新增（候选 " + byDecision("ADD").length + " / 入预算 " + budget.filter(c => c.decision === "ADD").length + "）", "");
for (const c of budget.filter(c => c.decision === "ADD")) md.push("- [" + c.slot + " | 置信 " + c.confidence + " | 证据 " + c.count + " 次 / 最近 " + (c.lastDate || "-") + "] " + c.text);
md.push("", "## UPDATE 更新（" + budget.filter(c => c.decision === "UPDATE").length + "）", "");
for (const c of budget.filter(c => c.decision === "UPDATE")) md.push("- [" + c.slot + "] " + c.text + (c.profileRule ? "（画像页：" + c.profileRule.slice(0, 40) + "）" : ""));
md.push("", "## NOOP 已覆盖（" + byDecision("NOOP").length + "）", "");
for (const c of byDecision("NOOP").slice(0, 8)) md.push("- [" + c.slot + "] " + c.text);
md.push("", "## CONFLICT 冲突（" + byDecision("CONFLICT").length + "）", "");
for (const c of byDecision("CONFLICT")) md.push("- [" + (c.conflictType || "contextual") + " | " + c.slot + "] 新：" + c.text + " ↔ 现有：" + (c.conflictsWith || "").slice(0, 60));
md.push("", "## EXPIRE / ORPHAN（" + (byDecision("EXPIRE").length + byDecision("ORPHAN").length) + "）", "");
for (const c of byDecision("EXPIRE")) md.push("- [过期 " + (c.validity || "") + " | " + c.slot + "] " + c.text);
for (const c of byDecision("ORPHAN")) md.push("- [无证据 | " + c.slot + "] " + c.text);
md.push("", "## 槽位覆盖", "");
const slotCount = {};
for (const c of candidates) if (c.slot && c.slot !== "unclassified") slotCount[c.slot] = (slotCount[c.slot] || 0) + 1;
const covered = Object.keys(slotCount).length, total = SLOTS.length || 1;
md.push("- 候选覆盖槽位 " + covered + "/" + total + "：" + Object.entries(slotCount).map(([k, v]) => k + "=" + v).join("，"));
const uncl = candidates.filter(c => c.slot === "unclassified").length;
if (uncl) md.push("- unclassified " + uncl + " 条（交复核，不直接入画像）");
md.push("");
md.push("", "## 预算淘汰建议（" + evictions.length + "）", "");
for (const e of evictions) md.push("- [" + e.reason + " | 证据 " + e.evidenceCount + " 次] " + e.text.slice(0, 60));
if (!evictions.length) md.push("- 无（预算内）");
if (typeof evictShortfall === "number" && evictShortfall > 0) { md.push("- 仍需再释放约 " + evictShortfall + "B"); if (!evictions.length) md.push("- 无低价值可自动建议；需人工选择：合并相近规则 / 降重要性 / 删除已过期规则"); }
md.push("", "## 预算", "", "- 当前 " + userBytes + "B / 上限 " + LIMIT + "B；目标 " + TARGET + "B；本批可写 " + budget.length + " 条 → " + bytes + "B", "");
if (userBytes > LIMIT * 0.8) md.push("- ⚠ 已超 80% 预算，需产淘汰候选（stale → 低重要度 → 最久未确认）", "");
md.push("## 证据附录", "");
for (const c of candidates.slice(0, 15)) for (const q of (c.quotes || []).slice(0, 2)) md.push("- " + q.sessionId + " " + q.date + "：「" + q.text.slice(0, 70) + "」");

fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, "profile-candidate-" + TODAY);
fs.writeFileSync(base + ".md", md.join("\n") + "\n", "utf8");
fs.writeFileSync(base + ".jsonl", candidates.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");
const diff = [];
diff.push("# 建议的 USER.md 变更（人工确认后经 mnemon_runtime_memory 应用）");
diff.push("# 当前 " + userBytes + "B / " + current.length + " 条；建议后 " + bytes + "B / " + (current.length + budget.length) + " 条");
for (const c of budget) diff.push((c.decision === "UPDATE" ? "~ " : "+ ") + "[" + c.slot + "] " + c.text);
for (const c of byAction("supersede")) diff.push("~ 替换：" + c.conflictsWith.slice(0, 50) + " → " + c.text);
for (const c of byAction("expire")) diff.push("- 过期候选：" + c.text);
for (const e of evictions) diff.push("- [淘汰建议/需确认] " + e.text);
fs.writeFileSync(path.join(outDir, "profile-diff-" + TODAY + ".txt"), diff.join("\n") + "\n", "utf8");
console.log(JSON.stringify({ reviewModels: reviewModelsUsed,  date: TODAY, profileEntries: profile.length, userEntries: current.length, userBytes,
  candidates: candidates.length, budget: budget.length, actions: { add: byAction("add").length, promote: byAction("promote").length,
  refine: byAction("refine").length, supersede: byAction("supersede").length, expire: byAction("expire").length,
  orphan: byAction("orphan-evidence").length, refresh: byAction("refresh").length }, evictions: evictions.length, leftoverAdds: pendingAdds.length,
  decisions: { ADD: byDecision("ADD").length, UPDATE: byDecision("UPDATE").length, NOOP: byDecision("NOOP").length, CONFLICT: byDecision("CONFLICT").length, EXPIRE: byDecision("EXPIRE").length, ORPHAN: byDecision("ORPHAN").length },
  md: base + ".md", jsonl: base + ".jsonl", diff: path.join(outDir, "profile-diff-" + TODAY + ".txt") }));
