#!/usr/bin/env node
// LLM-Wiki 记忆路由：判断一个问题该走 wiki 检索 / 会话历史 / 项目文档 / 热记忆 / 现场检查
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VAULT = process.env.LLM_WIKI_VAULT || "D:/DB/Obsidian/LLM-Wiki";
const RAW = path.join(VAULT, "raw", "sessions");
const HAN = String.fromCharCode(0x4e00) + "-" + String.fromCharCode(0x9fff);
const CJK = new RegExp("[" + HAN + "]", "g");

const RULES = {
  docs: {
    label: "项目档案",
    kw: ["项目档案", "需求文档", "prd", "方案文档", "会议纪要", "合同", "报价", "交付物", "客户资料", "投标"],
    why: "长文档/项目资料在 mnemon Documents，不在 wiki 知识页",
    action: "mnemon_document_search",
  },
  hot: {
    label: "规则/偏好",
    kw: ["我的偏好", "我的习惯", "约定", "规则是什么", "不能做什么", "必须", "默认不要", "默认用", "禁用", "红线"],
    why: "个人偏好与红线在热记忆（USER.md / MEMORY.md / 规则页）",
    action: "先看热记忆快照；不足再 grep wiki/规则 + wiki/项目/习惯与偏好",
  },
  live: {
    label: "现场检查",
    kw: ["现在", "当前", "此刻", "是否", "有没有", "端口", "进程", "占用", "在跑", "服务状态", "能用吗", "检查一下", "实测", "连着吗"],
    why: "机器当前状态必须实测，检索只会给出过时结论",
    action: "直接执行命令/工具核实（Get-Process、端口探测、bsk status、dsh 状态），不要先查 wiki",
  },
  session: {
    label: "会话历史/操作记忆",
    kw: ["上次", "之前", "刚才", "当时", "曾经", "装过", "改过", "修过", "弄过", "试过", "做到哪", "进度", "没拉起", "拉起", "没起来", "拉不起来", "没反应", "连不上", "用不了", "打不开", "空的", "报错", "挂了", "怎么办", "排掉",  "安装", "装上", "部署", "升级", "回滚", "迁移", "配置过", "踩坑", "记忆库", "查不到", "起不来了", "启动不了", "重装", "重置了", "断连", "老断", "退回", "删掉一个", "清一下", "换成", "体检", "盘一下", "盘点"],
    why: "这类问题答案在过去做过什么，wiki 只是结论页",
    action: "1) raw/sessions 关键词检索；2) mnemon_recall 找当时经验；3) 必要时读 .dsh/sessions",
  },
  wiki: {
    label: "知识/经验检索",
    strong: ["排查", "修复", "定位", "什么是", "区别", "原理", "最佳实践", "架构", "选型", "经验", "总结", "决策", "对比", "概念", "方法", "定义", "机制", "为什么这样", "怎么设计"],
    generic: ["为什么", "如何", "怎么", "是什么", "什么时候", "哪些", "包括", "吗"],
    why: "已编译成知识页，走融合检索最省 token",
    action: 'node "C:/Users/wtown/.dsh/bin/wiki-retrieval.mjs" "<原问题>" --limit 5',
  },
};

const W2 = ["上次", "装过", "修过", "改过", "试过", "没拉起", "拉起", "没反应", "连不上", "用不了", "打不开", "空的", "报错", "挂了", "怎么办", "做到哪", "进度", "安装", "装上", "现在", "当前", "此刻", "是否", "有没有", "端口", "进程", "占用", "在跑", "检查一下"];
const W1 = ["之前", "刚才", "当时", "曾经", "弄过", "配置过", "踩坑", "部署", "升级", "回滚", "迁移", "服务状态", "能用吗", "实测", "连着吗"];

export function route(query) {
  const q = String(query || "").toLowerCase().trim();
  const hasUrl = /https?:\/\/|github\.com|gitee\.com/.test(q);
  const scores = {}, matched = {};
  const add = (route, kw, w) => { scores[route] = (scores[route] || 0) + w; matched[route] = [...(matched[route] || []), kw]; };
  for (const key of ["docs", "hot", "live", "session"]) {
    const r = RULES[key];
    for (const kw of r.kw) {
      if (!q.includes(kw.toLowerCase())) continue;
      const w = W2.includes(kw) ? 2 : W1.includes(kw) ? 1 : 2;
      add(key, kw, w);
    }
  }
  if (hasUrl) add("session", "URL", 2);
  const w = RULES.wiki;
  for (const kw of w.strong) if (q.includes(kw)) add("wiki", kw, 2);
  for (const kw of w.generic) if (q.includes(kw)) add("wiki", kw, 1), matched.wiki = [...new Set(matched.wiki || [])];

  const order = ["docs", "hot", "live", "session", "wiki"];
  let ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a] || order.indexOf(a) - order.indexOf(b));
  // 修正规则：弱会话信号（<2）不压过知识检索
  if (ranked[0] && (ranked[0] === "session" || ranked[0] === "live") && scores[ranked[0]] < 2 && (scores.wiki || 0) >= 1) {
    ranked = ["wiki", ...ranked.filter(k => k !== "wiki")];
  }
  if (!ranked.length) {
    return { route: "wiki", label: RULES.wiki.label, score: 0, matched: [], confidence: "low",
      why: "无明确信号，兜底走知识检索；若答非所问，改走会话历史", action: RULES.wiki.action, alternatives: [] };
  }
  const top = ranked[0], second = ranked[1];
  const confidence = !second ? (scores[top] >= 2 ? "high" : "low") : scores[top] >= scores[second] * 2 ? "medium" : "low";
  return { route: top, label: RULES[top].label, score: scores[top], matched: matched[top] || [],
    confidence, why: RULES[top].why, action: RULES[top].action,
    alternatives: ranked.slice(1, 3).map(k => ({ route: k, score: scores[k], matched: matched[k] || [] })) };
}

const SESSION_DIR = path.join(VAULT, "raw", "sessions", "dsh");
const QSTOP = new Set(["上次", "之前", "刚才", "现在", "怎么", "什么", "为什么", "是不是", "有没有", "可以", "需要", "一下", "这个", "那个", "我们", "我的", "时候", "还是", "然后", "就是", "的话"]);

function qTokens(str) {
  const out = [];
  const lower = String(str).toLowerCase();
  for (const w of lower.match(/[a-z0-9_@.#\/-]{2,}/g) || []) out.push(w);
  const cjk = lower.replace(new RegExp("[^" + HAN + "]", "g"), "");
  for (let i = 0; i < cjk.length - 1; i++) {
    const bg = cjk.slice(i, i + 2);
    if (!QSTOP.has(bg)) out.push(bg);
  }
  return out;
}

/** 读会话复盘：一个复盘文件 = 一次会话，带日期/项目/正文 */
function loadSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  const rows = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith(".md")).map(f => {
    const text = fs.readFileSync(path.join(SESSION_DIR, f), "utf8");
    const sid = (text.match(/^source:\s*"dsh:session-([0-9a-f-]+)"/m) || [])[1] || "file:" + f;
    const created = (text.match(/^created:\s*(\S+)/m) || [])[1] || "";
    const workdir = (text.match(/\*\*工作目录\*\*:\s*(.+)/) || [])[1] || "";
    const project = workdir.trim().split(/[\\/]/).pop() || "";
    const qs = [...text.matchAll(/### 用户\n\n([\s\S]{4,300}?)\n\n### /g)].map(m => m[1].replace(/\s+/g, " ").trim());
    const firstQ = (qs[0] || "").slice(0, 120);
    return { file: "raw/sessions/dsh/" + f, base: f, text, sid, created, project, firstQ, qn: qs.length, qs };
  });
  // 同一 session 可能被多次导出：按 session id 去重，保留提问最多、其次导出文件最新的那份
  const best = new Map();
  for (const r of rows) {
    const prev = best.get(r.sid);
    if (!prev || r.qn > prev.qn || (r.qn === prev.qn && r.base > prev.base)) best.set(r.sid, r);
  }
  return [...best.values()];
}

// ── 语义索引：会话"逐问题"向量（multi-vector max-sim）──
const SESSION_VEC = path.join(SESSION_DIR, ".embeddings-v6.json");
const SUMMARY_FILE = path.join(SESSION_DIR, ".summaries.json");
function sfKey() {
  try {
    const cred = fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", ".credentials.yaml"), "utf8");
    const m = cred.match(/^\s*SF_API_KEY:\s*(\S+)/m);
    return m ? m[1].replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
async function embedTexts(texts) {
  const key = process.env.LLM_WIKI_EMBED_KEY || sfKey();
  if (!key) throw new Error("no embedding key");
  const ep = (process.env.LLM_WIKI_EMBED_ENDPOINT || "https://api.siliconflow.cn/v1").replace(/\/$/, "") + "/embeddings";
  const model = process.env.LLM_WIKI_EMBED_MODEL || "BAAI/bge-m3";
  const res = await fetch(ep, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error("embed HTTP " + res.status + " " + String(await res.text()).slice(0, 100));
  const j = await res.json();
  return (j.data || []).map(d => d.embedding);
}
async function callChat(prompt, maxTokens = 120) {
  const key = process.env.LLM_WIKI_LLM_KEY || sfKey();
  if (!key) throw new Error("no llm key");
  const ep = (process.env.LLM_WIKI_LLM_ENDPOINT || "https://api.siliconflow.cn/v1").replace(/\/$/, "") + "/chat/completions";
  const model = process.env.LLM_WIKI_LLM_MODEL || "Qwen/Qwen3.5-4B";
  const res = await fetch(ep, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, enable_thinking: false }),
    signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("chat HTTP " + res.status);
  const j = await res.json();
  return String(j.choices?.[0]?.message?.content || "").trim();
}
async function ensureSummaries(docs) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8")); } catch {}
  const missing = docs.filter(d => !cache[d.sid]);
  for (const d of missing) {
    const qs = d.qs.slice(0, 10).map(q => q.slice(0, 80)).join(" / ");
    try {
      const out = await callChat("下面是用户与 AI 助手一次会话里的用户发言。请用一句不超过40字的中文概括这次会话在做什么，只输出这句话：\n" + qs);
      cache[d.sid] = out.replace(/\s+/g, " ").slice(0, 90) || d.firstQ.slice(0, 60);
    } catch { cache[d.sid] = d.firstQ.slice(0, 60); }
  }
  try { fs.writeFileSync(SUMMARY_FILE, JSON.stringify(cache), "utf8"); } catch {}
  return cache;
}
const cosine = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
async function ensureSessionIndex(docs) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(SESSION_VEC, "utf8")); } catch {}
  const missing = docs.filter(d => !cache[d.sid] || cache[d.sid].mtime !== d.mtime);
  if (missing.length) {
    for (const d of missing) {
      const qs = d.qs.slice(0, 20).map(q => q.slice(0, 200));
      let vecs = [];
      for (let i = 0; i < qs.length; i += 16) vecs.push(...(await embedTexts(qs.slice(i, i + 16))));
      cache[d.sid] = { mtime: d.mtime, v: vecs };
    }
    try { fs.writeFileSync(SESSION_VEC, JSON.stringify(cache), "utf8"); } catch {}
  }
  return cache;
}
/** 会话语义检索：逐问题 max-sim + 摘要相似 + 近期/项目加成 */
export async function sessionRecallSemantic(query, opts = {}) {
  const limit = opts.limit || 5;
  let docs = loadSessions().map(d => ({ ...d, mtime: fs.statSync(path.join(SESSION_DIR, d.base)).mtimeMs }));
  if (!docs.length) return [];
  let cache, sumCache = {};
  try { cache = await ensureSessionIndex(docs); } catch { return sessionRecall(query, opts); }
  try { sumCache = await ensureSummaries(docs); } catch {}
  const [qv] = await embedTexts([query.slice(0, 300)]);
  const kw = sessionRecall(query, { limit: docs.length });
  const kwRank = new Map(kw.map((r, i) => [r.file, 1 / (i + 1)]));
  const now = Date.now();
  return docs.map(d => {
    const entry = cache[d.sid];
    let best = 0;
    if (entry && Array.isArray(entry.v)) for (const v of entry.v) { const c = cosine(qv, v); if (c > best) best = c; }
    const days = d.created ? Math.round((now - new Date(d.created).getTime()) / 864e5) : 999;
    const rec = Math.exp(-Math.max(0, days) / 120);
    let score = best * 0.88 + (kwRank.get(d.file) || 0) * 0.07 + rec * 0.05;
    const why = [];
    if (best > 0.5) why.push("语义" + best.toFixed(2));
    if (kwRank.has(d.file)) why.push("关键词");
    if (rec > 0.5) why.push("近期");
    return { file: d.file, base: d.base, sid: d.sid, score: +score.toFixed(3), created: d.created, project: d.project,
      summary: sumCache[d.sid] || "", firstQ: d.firstQ.slice(0, 80), why };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 会话检索：BM25 + 时间衰减 + 项目匹配 + 显式日期加成 */
export function sessionRecall(query, opts = {}) {
  const limit = opts.limit || 5;
  const docs = loadSessions();
  if (!docs.length) return [];
  const qs = qTokens(query);
  const tf = docs.map(d => {
    const counts = Object.create(null);
    for (const t of qTokens(d.text)) counts[t] = (counts[t] || 0) + 1;
    return { d, counts, len: Object.values(counts).reduce((a, b) => a + b, 0) || 1 };
  });
  const avg = tf.reduce((a, x) => a + x.len, 0) / tf.length;
  const df = Object.create(null);
  for (const x of tf) for (const t of Object.keys(x.counts)) df[t] = (df[t] || 0) + 1;
  const N = tf.length, k1 = 1.2, b = 0.75;
  const now = Date.now();
  const dateMatch = query.match(/(\d{4})-(\d{2})-(\d{2})/) || query.match(/(\d{1,2})月(\d{1,2})日/);
  let targetTs = null;
  if (dateMatch) {
    if (dateMatch[0].includes("-")) targetTs = new Date(dateMatch[0]).getTime();
    else {
      const y = new Date().getFullYear();
      targetTs = new Date(y + "-" + String(dateMatch[1]).padStart(2, "0") + "-" + String(dateMatch[2]).padStart(2, "0")).getTime();
    }
  }
  return tf.map(x => {
    let score = 0;
    for (const t of new Set(qs)) {
      const f = x.counts[t]; if (!f) continue;
      const idf = Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * x.len / avg));
    }
    const why = [];
    const days = x.d.created ? Math.round((now - new Date(x.d.created).getTime()) / 864e5) : null;
    if (days !== null && days >= 0) { const rec = Math.exp(-days / 45); if (rec > 0.01) { score *= 1 + 0.4 * rec; why.push("近期" + days + "d"); } }
    if (x.d.project) {
      const p = x.d.project.toLowerCase();
      if (query.toLowerCase().includes(p) || qs.some(t => p.includes(t) && t.length >= 3)) { score *= 1.3; why.push("项目:" + x.d.project); }
    }
    if (targetTs && x.d.created) {
      const delta = Math.abs(new Date(x.d.created).getTime() - targetTs) / 864e5;
      if (delta <= 2) { score *= 1.5; why.push("日期命中"); }
    }
    return { file: x.d.file, base: x.d.base, sid: x.d.sid, score: +score.toFixed(3), created: x.d.created, project: x.d.project, firstQ: x.d.firstQ.slice(0, 80), why };
  }).filter(r => r.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

export function grepSessions(query, limit = 5) {
  const words = (String(query).match(new RegExp("[" + HAN + "]{2,4}", "g")) || []).filter(w => !/^(怎么|什么|上次|之前|现在|一下)$/.test(w)).slice(0, 6);
  const out = [];
  if (!fs.existsSync(RAW)) return out;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".md") ? [path.join(d, e.name)] : []));
  for (const f of walk(RAW)) {
    const t = fs.readFileSync(f, "utf8");
    let score = 0;
    for (const w of words) if (t.includes(w)) score++;
    if (score >= Math.max(2, words.length - 2)) out.push({ file: path.relative(VAULT, f).replace(/\\/g, "/"), score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function recallSessions(query, limit = 5) {
  try {
    const raw = execFileSync("mnemon", ["recall", query, "--limit", String(limit), "--brief", "--excerpt-chars", "600"], { encoding: "utf8", shell: true, timeout: 30000 });
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return (j.results || []).map(r => ({ excerpt: String(r.excerpt || "").slice(0, 160) }));
  } catch { return []; }
}

if (process.argv[1] && process.argv[1].endsWith("wiki-router.mjs")) {
  const args = process.argv.slice(2);
  const q = args.find(a => !a.startsWith("--"));
  if (!q) { console.error('用法: node wiki-router.mjs "<query>" [--json] [--exec]'); process.exit(2); }
  const r = route(q);
  const payload = { query: q, ...r };
  if (args.includes("--exec")) {
    if (r.route === "wiki") {
      try {
        const out = execFileSync("node", [path.join(path.dirname(process.argv[1]), "wiki-retrieval.mjs"), q, "--limit", "5"], { encoding: "utf8", timeout: 120000 });
        payload.results = out;
      } catch (e) { payload.error = String(e.message).slice(0, 120); }
    } else if (r.route === "session") {
      payload.sessionFiles = await sessionRecallSemantic(q, { limit: 5 });
      payload.recall = recallSessions(q);
    }
  }
  if (args.includes("--json")) console.log(JSON.stringify(payload, null, 1));
  else {
    console.log("# 路由：" + r.route + "（" + r.label + "，置信 " + r.confidence + "，score=" + r.score + "）");
    if (r.matched.length) console.log("命中信号：" + r.matched.join("、"));
    console.log("为什么：" + r.why);
    console.log("下一步：" + r.action);
    if (r.alternatives && r.alternatives.length) console.log("备选：" + r.alternatives.map(a => a.route + "(" + a.score + ")").join("、"));
  }
}
