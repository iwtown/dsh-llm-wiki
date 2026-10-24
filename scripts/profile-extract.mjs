#!/usr/bin/env node
// profile-extract.mjs v3 —— 会话 → 偏好证据包（行为事件 + LLM/规则抽取，只读）
// 用法: node profile-extract.mjs [--since 7d] [--out D:/DB/DSH/reports/profile-evidence] [--max 20] [--no-llm]
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const sinceDays = Number(String(arg("since", "7d")).replace(/d$/, "")) || 7;
const outDir = arg("out", "D:/DB/DSH/reports/profile-evidence");
const maxSessions = Number(arg("max", "20")) || 20;
const NO_LLM = args.includes("--no-llm");
const RECAPS = args.includes("--recaps");
const MULTI = !args.includes("--single-angle") && process.env.PROFILE_MULTI !== "0";
const RECAP_DIR = arg("recaps-dir", "D:/DB/Obsidian/LLM-Wiki/raw/sessions/dsh");
const HOME = os.homedir();
const SESSIONS = path.join(HOME, ".dsh", "sessions");
const CACHE = path.join(outDir, ".evidence-cache.json");
const TODAY = new Date().toISOString().slice(0, 10);
const cutoff = Date.now() - sinceDays * 864e5;

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1), "utf8"); };
const sfKey = () => { try { const c = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8"); const m = c.match(/^\s*SF_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, "") : ""; } catch { return ""; } };

function decode(file) {
  const buf = fs.readFileSync(file); const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) starts.push(i);
  let text = "";
  for (let i = 0; i < starts.length; i++) { try { text += zstdDecompressSync(buf.subarray(starts[i], starts[i+1] || buf.length)).toString("utf8"); } catch {} }
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const NOISE = [/^Current runtime context/i, /MNEMON RUNTIME MEMORY SNAPSHOT/, /^Time sampled while preparing/, /dsh-mnemon:delegated/, /^Browser time zone for this request/, /^# LLM-Wiki/, /^\s*<skill/i, /skillhub/i];
const isNoise = t => NOISE.some(re => re.test(t));
const textOf = content => (Array.isArray(content) ? content : []).filter(b => b && b.type === "text").map(b => b.text || "").join(" ").replace(/\s+/g, " ").trim();

const REJECT = /(不对|错了|不是这样|重写|重新|别这样|不要这样|别用|不用|去掉|删掉|太啰嗦|太复杂|不满意)/;
const UNDO = /(回退|撤销|恢复|删掉|删了|撤回)/;
const ACCEPT = /^(好|可以|对|行|继续|就这样|没问题|ok)/i;
const INSTRUCTION = /(以后|下次|默认|必须|禁止|不要|记住|始终|总是|一律|统一|别再)/;

const GENERAL = /(以后|下次|默认|每次|一律|统一|总是|始终|记住|优先|尽量|永远)/;
const CORRECT = /(不要|别(?!的)|禁止|必须|不对|错了|重写|别这样|我希望|我更|我不喜欢|不用|不需要)/;
const PROCESS_STRONG = /(先.{0,10}(再|然后)|(方案|计划).{0,12}审核|先.{0,6}(方案|计划)|拆解|小步|复盘)/;
const TASK_START = /^(把|请|帮我|给我|打开|开启|关闭|删除|安装|运行|执行|检查|看一下|查一下|改一下|处理|解决|接着|按照|顺着|观察|跑通|按)/;
const TASK_OBJ = /https?:|\\\\|\.md\b|\d+\.\d+\.\d+|github|仓库|欠债|巡检|pcie|aspm/i;
// ── 槽位本体 + 引文保真校验 ──
const PROFILE_SCHEMA = (() => { try { return JSON.parse(fs.readFileSync(process.env.PROFILE_SCHEMA || fileURLToPath(new URL("./profile-schema.json", import.meta.url)), "utf8")); } catch { return { slots: [] }; } })();
const SLOTS_DEF = PROFILE_SCHEMA.slots || [];
const normCmp = x => String(x || "").replace(/[\s，。！？、；：""''（）()\[\]<>《》…·,.;:!?"']/g, "").toLowerCase();
function slotOfText(text) {
  const t = normCmp(text); let best = "unclassified", bs = 0;
  for (const s of SLOTS_DEF) {
    let score = 0;
    for (const k of (s.keywords || [])) if (t.includes(normCmp(k))) score += 2;
    if (t.includes(normCmp(s.name))) score += 3;
    if (score > bs) { bs = score; best = s.id; }
  }
  return bs > 0 ? best : "unclassified";
}
function quoteSupported(quote, messages) {
  const q = normCmp(quote);
  if (q.length < 6) return false;
  return messages.some(m => normCmp(m).includes(q));
}

function isObviousNoise(x) {
  const rule = String(x.rule || "");
  if (!rule || rule.length > 60) return true;
  if (/https?:|\\\\|\.md\b|\d+\.\d+\.\d+/.test(rule)) return true;
  if (/(吗|呢)[？?]?$/.test(rule)) return true;
  if (/(如何|怎么|能不能|是否|为什么|要不要)/.test(rule) && rule.length > 12) return true;
  return false;
}

function behaviorOf(userMsgs) {
  const e = { reject: 0, undo: 0, accept: 0, instruction: 0 };
  for (const m of userMsgs) { if (REJECT.test(m)) e.reject++; if (UNDO.test(m)) e.undo++; if (ACCEPT.test(m)) e.accept++; if (INSTRUCTION.test(m)) e.instruction++; }
  return e;
}

function ruleExtract(userMsgs) {
  const out = [];
  for (const m of userMsgs) {
    for (const s of m.split(/[。！？\n]/).map(x => x.trim())) {
      if (s.length < 4 || s.length > 100) continue;
      if (!INSTRUCTION.test(s) && !REJECT.test(s)) continue;
      if (/(吗|呢|\?|？)\s*$/.test(s)) continue;
      out.push({ type: INSTRUCTION.test(s) ? "explicit_instruction" : "explicit_correction", rule: s, quote: s, context: "", polarity: REJECT.test(s) ? "negative" : "positive", scope: "global", confidence: 0.6, reason: "规则抽取（未用 LLM）" });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

const MODELS = (process.env.LLM_WIKI_LLM_MODELS || "glm-4-flash-250414,glm-4.7-flash,THUDM/GLM-4-9B-0414").split(",").map(x => x.trim()).filter(Boolean);
const LLM_TIMEOUT = Number(process.env.LLM_WIKI_LLM_TIMEOUT || 60000);
const LLM_RETRIES = Number(process.env.LLM_WIKI_LLM_RETRIES || 2);

function buildExtractPrompt(pack) {
  const schema = '{"type":"explicit_instruction|explicit_correction|repeated_request|decision_pattern|work_habit|anti_preference","rule":"≤40字可执行规则","quote":"原话","context":"场景≤20字","polarity":"positive|negative","scope":"global|project","confidence":0到1,"reason":"≤20字"}';
  const list = pack.messages.slice(0, 40).map((m, i) => (i + 1) + ". " + m.slice(0, 200)).join("\n");
  return [
    "你是用户画像抽取器。只根据给定引文总结，不得外推或补充未出现的信息。",
    "从下列用户发言中找出【稳定偏好 / 习惯 / 纠正】，输出 JSON 数组（最多3条）；没有就输出 []。",
    "字段：" + schema,
    "先宽后严：宁可多提候选，也不要漏掉可能的稳定偏好；但一次性参数、环境事实、项目决策、纯提问不要提。",
    "行为统计：reject=" + pack.behavior.reject + " undo=" + pack.behavior.undo + " accept=" + pack.behavior.accept + " instruction=" + pack.behavior.instruction,
    "会话项目：" + (pack.project || "-"),
    "用户发言：",
    list,
  ].join("\n");
}

function zaiKey() { try { const c = fs.readFileSync(path.join(HOME, ".dsh", ".credentials.yaml"), "utf8"); const m = c.match(/^\s*ZAI_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, "") : ""; } catch { return ""; } }
async function callSF(model, prompt, maxTokens = 900) {
  const isZai = /^glm-/.test(model);
  const key = isZai ? (process.env.ZAI_API_KEY || zaiKey()) : (process.env.LLM_WIKI_LLM_KEY || sfKey());
  if (!key) throw new Error("no key");
  const ep = isZai
    ? "https://api.z.ai/api/paas/v4/chat/completions"
    : (process.env.LLM_WIKI_LLM_ENDPOINT || "https://api.siliconflow.cn/v1").replace(/\/$/, "") + "/chat/completions";
  const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens };
  if (!isZai) body.enable_thinking = false; else body.thinking = { type: "disabled" };
  const res = await fetch(ep, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  return String(j.choices?.[0]?.message?.content || "");
}

function parseItems(text) {
  const i = text.indexOf("["), k = text.lastIndexOf("]");
  if (i < 0 || k <= i) return null;
  try {
    const arr = JSON.parse(text.slice(i, k + 1));
    if (!Array.isArray(arr)) return null;
    return arr.filter(x => x && x.rule && x.quote).slice(0, 3).map(x => ({
      type: String(x.type || "explicit_instruction"), rule: String(x.rule).slice(0, 60), quote: String(x.quote).slice(0, 120),
      context: String(x.context || "").slice(0, 40), polarity: x.polarity === "negative" ? "negative" : "positive",
      scope: x.scope === "project" ? "project" : "global", confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.6)),
      reason: String(x.reason || "").slice(0, 40) }));
  } catch { return null; }
}

function buildAnglePrompt(pack, angle) {
  const schema = '{"type":"explicit_instruction|explicit_correction|repeated_request|decision_pattern|work_habit|anti_preference","rule":"≤40字可执行规则","quote":"原话","context":"场景≤20字","polarity":"positive|negative","scope":"global|project","confidence":0到1,"reason":"≤20字"}';
  const list = pack.messages.slice(0, 40).map((m, i) => (i + 1) + ". " + m.slice(0, 200)).join("\n");
  const parts = {
    A: "角度A：只找【显式偏好与纠正】——用户明确说以后/默认/每次/一律/不要/必须/别/记住，或明确否定、纠正 agent 的做法。",
    B: "角度B：只找【过程与决策模式】——用户要求的工作方式，如先方案后执行、先核实或实测再结论、按优先级、拆解、复盘、保留可扩展性、先确认现有设计；也包括保留原版、不改默认目录、不要清理某物这类约束。",
    C: "角度C：只找【反偏好与否定】——用户明确不喜欢或否定的做法，如不要啰嗦、别重复造轮子、删掉冗余、不要写免责声明、保留原样（不要动）。"
  };
  return "你是用户画像抽取器。只依据引文，不得外推。输出 JSON 数组（最多3条），没有就输出 []。\n字段：" + schema + "\n" + parts[angle] + "\n一次性参数、环境事实、纯提问不要提。\n会话项目：" + (pack.project || "-") + "\n用户发言：\n" + list;
}

async function llmExtractWithPrompt(pack, prompt) {
  const errors = [];
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= LLM_RETRIES; attempt++) {
      try {
        const text = await callSF(model, prompt);
        const items = parseItems(text);
        if (items) return { items, model };
        errors.push(model + "#" + attempt + ":nojson");
      } catch (e) { errors.push(model + "#" + attempt + ":" + String(e.message).slice(0, 30)); }
    }
  }
  throw new Error(errors.join(" | ").slice(0, 200));
}

async function llmExtract(pack) {
  return llmExtractWithPrompt(pack, buildExtractPrompt(pack));
}

const normKey = x => String(x || "").replace(/\s+/g, "").slice(0, 60);
async function llmExtractMulti(pack) {
  const out = new Map(); const used = {};
  for (const angle of ["A", "B", "C"]) {
    try {
      const r = await llmExtractWithPrompt(pack, buildAnglePrompt(pack, angle));
      for (const it of r.items) {
        const k = normKey(it.rule);
        if (!out.has(k)) out.set(k, { ...it, angle });
        else { const p = out.get(k); p.confidence = Math.max(p.confidence, it.confidence); if (!p.quote) p.quote = it.quote; }
      }
      used[r.model] = (used[r.model] || 0) + 1;
    } catch {}
  }
  return { items: [...out.values()].slice(0, 5), model: Object.keys(used)[0] || "" };
}

const jobs = [];
if (RECAPS) {
  for (const f of fs.readdirSync(RECAP_DIR).filter(x => x.endsWith(".md")).sort()) {
    const p = path.join(RECAP_DIR, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    jobs.push({ kind: "recap", p, mtime: st.mtimeMs, sid: "recap:" + f });
  }
} else {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl.zstd")) { try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs, sid: path.basename(path.dirname(p)) }); } catch {} } } };
  try { walk(SESSIONS); } catch {}
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) jobs.push({ kind: "zstd", ...f });
}

function recapPack(p) {
  const t = fs.readFileSync(p, "utf8");
  const sid = (t.match(/^source:\s*"dsh:session-([0-9a-f-]+)"/m) || [])[1] || "file:" + path.basename(p);
  const created = (t.match(/^created:\s*(\S+)/m) || [])[1] || "";
  const workdir = (t.match(/\*\*工作目录\*\*:\s*(.+)/) || [])[1] || "";
  const project = workdir.trim().split(/[\\/]/).filter(Boolean).pop() || "";
  const users = [...t.matchAll(/### 用户\n\n([\s\S]{4,1500}?)\n\n### /g)].map(m => m[1].replace(/\s+/g, " ").trim())
    .filter(x => x.length >= 3 && !isNoise(x) && !/^The approval policy/i.test(x));
  return { sid, created, project, users };
}

const cache = readJson(RECAPS ? path.join(outDir, MULTI ? ".recap-cache-multi.json" : ".recap-cache.json") : CACHE);
const evidence = [];
const stats = { sessions: 0, cached: 0, llm: 0, rule: 0, failed: 0, filtered: 0, quoteDropped: 0, models: {} };
const retryQueue = [];
const limit = RECAPS ? Math.min(jobs.length, maxSessions > 20 ? maxSessions : 25) : jobs.length;

async function processJob(j) {
  const c = cache[j.sid];
  if (c && c.mtime === j.mtime) { const kept = c.items.filter(x => !isObviousNoise(x)); stats.filtered += c.items.length - kept.length; evidence.push(...kept); stats.cached++; return; }
  let pack = null;
  if (j.kind === "recap") {
    const r = recapPack(j.p);
    if (!r.users.length) return;
    pack = { sid: r.sid, project: r.project, date: r.created || new Date(j.mtime).toISOString().slice(0, 10), messages: r.users, behavior: behaviorOf(r.users) };
  } else {
    let evs = [];
    try { evs = decode(j.p); } catch { stats.failed++; return; }
    const meta = evs.find(e => e.type === "session") || {};
    const project = String((meta.data && meta.data.cwd) || "").split(/[\\/]/).filter(Boolean).pop() || "";
    const users = [];
    for (const e of evs) {
      if (e.type !== "user/message") continue;
      const kind = e.data && e.data.source && e.data.source.kind;
      if (kind && kind !== "user") continue;
      const t = textOf(e.data && e.data.content);
      if (!t || t.length < 3 || t.length > 1500 || isNoise(t)) continue;
      users.push(t);
    }
    if (!users.length) { stats.sessions++; return; }
    pack = { sid: j.sid, project, date: new Date(j.mtime).toISOString().slice(0, 10), messages: users, behavior: behaviorOf(users) };
  }
  let items = [];
  if (!NO_LLM) { try { const r = await (MULTI ? llmExtractMulti(pack) : llmExtract(pack)); items = r.items; if (items.length) { stats.llm++; stats.models[r.model] = (stats.models[r.model] || 0) + 1; } } catch { stats.failed++; } }
  if (!items.length) { retryQueue.push({ sessionId: pack.sid, date: pack.date, project: pack.project }); items = ruleExtract(pack.messages).map(x => ({ ...x, confidence: 0.55 })); if (items.length) stats.rule++; }
  const quoteOk = items.filter(x => quoteSupported(x.quote || "", pack.messages));
  const quoteDropped = items.length - quoteOk.length;
  const enriched = quoteOk.map(x => ({ ...x, slot: slotOfText(x.rule + " " + (x.quote || "")), source: RECAPS ? "recap" : "extract", sessionId: pack.sid, project: pack.project, date: pack.date }));
  cache[j.sid] = { mtime: j.mtime, items: enriched };
  const kept = enriched.filter(x => !isObviousNoise(x));
  stats.filtered += enriched.length - kept.length;
  stats.quoteDropped += quoteDropped;
  evidence.push(...kept);
  stats.sessions++;
}

const queue = jobs.slice(0, RECAPS ? 40 : jobs.length);
const CONC = Number(process.env.PROFILE_CONCURRENCY || 3);
let qidx = 0;
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
  while (qidx < queue.length) { const j = queue[qidx++]; await processJob(j); }
}));

fs.mkdirSync(outDir, { recursive: true });
writeJson(RECAPS ? path.join(outDir, ".recap-cache.json") : CACHE, cache);
const outFile = path.join(outDir, (RECAPS ? "recaps-" : "") + TODAY + ".jsonl");
fs.writeFileSync(outFile, evidence.map(x => JSON.stringify(x)).join("\n") + "\n", "utf8");
const byType = {};
for (const e of evidence) byType[e.type] = (byType[e.type] || 0) + 1;
if (retryQueue.length) writeJson(path.join(outDir, ".retry-queue.json"), { updatedAt: new Date().toISOString(), items: retryQueue });
else { try { fs.rmSync(path.join(outDir, ".retry-queue.json"), { force: true }); } catch {} }
console.log(JSON.stringify({ date: TODAY, mode: RECAPS ? "recaps" : "sessions", sessions: stats.sessions, cached: stats.cached, llm: stats.llm, rule: stats.rule, failed: stats.failed, filtered: stats.filtered, quoteDropped: stats.quoteDropped, models: stats.models, evidence: evidence.length, byType, out: outFile }));
