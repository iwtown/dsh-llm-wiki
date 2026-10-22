/**
 * dsh-llm-wiki.mjs —— LLM-Wiki 生命周期插件（P3）
 *
 * profile 本地文件插件（cordis.patch.yml insert name: './dsh-llm-wiki.mjs'）。
 * 零外部依赖（不 import dsh-tools；只用 node 内置 + ctx）。
 *
 * 功能：
 *  1. systemPrompt 注入：schema.md 守则 + 知识预览（index.md，管线产物）
 *  2. session/disposed → 异步触发 P2 管线（防重入 + 冷却）
 *
 * 配置（cordis.patch.yml config）:
 *  vault:        vault 路径（默认按平台：Windows D:\DB\Obsidian\LLM-Wiki，其他 /mnt/d/DB/Obsidian/LLM-Wiki）
 *  previewOrder: 知识预览 section 顺序（默认 138）
 *  rulesOrder:   守则 section 顺序（默认 139）
 *  mainAgentOnly: 只给主 Agent 注入知识库（默认 true；spawn/fork 出来的子代理不加载）
 *
 * 跨平台说明：
 *  - 管线位置由 $DSH_HOME 推导（Windows 桌面版为 C:\Users\<user>\.dsh\bin\llm-wiki-pipeline.mjs），
 *    不再假设 ~/bin（WSL）。
 *  - 子进程用 process.execPath 启动；DSH Host 设置 ELECTRON_RUN_AS_NODE=1，因此 Electron
 *    exe 会以 Node 方式运行 .mjs。若将来该环境变量消失，可改为显式解析内置 node.exe。
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

export const name = "dsh-llm-wiki";
export const inject = ["systemPrompt"];

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), ".dsh");
const DEFAULT_VAULT = process.platform === "win32"
  ? "D:\\DB\\Obsidian\\LLM-Wiki"
  : "/mnt/d/DB/Obsidian/LLM-Wiki";
const PIPELINE = join(DSH_HOME, "bin", "llm-wiki-pipeline.mjs");
const CACHE_TTL = 60_000; // 读文件缓存 60s

function cached(file, ttl = CACHE_TTL) {
  let last = 0, data = "";
  return () => {
    try {
      const st = statSync(file);
      if (Date.now() - last < ttl && data) return data;
      data = readFileSync(file, "utf8");
      last = Date.now();
      return data;
    } catch { return data || ""; }
  };
}

export function apply(ctx, config = {}) {
  const vault = config.vault && String(config.vault).length > 0 ? config.vault : DEFAULT_VAULT;
  const previewOrder = Number.isInteger(config.previewOrder) ? config.previewOrder : 138;
  const rulesOrder = Number.isInteger(config.rulesOrder) ? config.rulesOrder : 139;
  const rulesFile = join(vault, "schema.md");
  const previewFile = join(vault, "wiki", "index.md");
  const readRules = cached(rulesFile);
  const readPreview = cached(previewFile);
  // 只给主 Agent 注入：子代理（记忆任务 Agent 等）不加载 6KB 知识库，
  // 既省 token，也避免守则干扰子代理自己的专用协议。
  // 判定用 agents.roots()（无 owner 的顶层 agent）；取不到服务时退回旧行为。
  const mainAgentOnly = config.mainAgentOnly !== false;
  const isMainAgent = (context) => {
    if (!mainAgentOnly) return true;
    const agent = context && context.agent;
    if (!agent) return true;
    try {
      const agents = ctx.get("agents");
      if (!agents || typeof agents.roots !== "function") return true;
      const roots = agents.roots();
      if (roots.length === 0) return true;
      return roots.some((item) => item.id === agent.id);
    } catch { return true; }
  };
  try { console.log("[dsh-llm-wiki] apply() vault=" + vault + " rules=" + existsSync(rulesFile) + " preview=" + existsSync(previewFile) + " pipeline=" + existsSync(PIPELINE)); } catch {}

  // ── 1) systemPrompt 注入 ──
  // 知识预览（先于守则，order 更低先出现）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:preview",
    order: previewOrder,
    text: (context) => {
      if (!isMainAgent(context)) return "";
      const idx = readPreview();
      if (!idx) return "";
      return "\n---\n# LLM-Wiki 知识库（管线自动维护）\n\n" + idx +
        "\n\n**检索路由**：当天/精确/排错 → wiki-search（grep + read 原文）；跨天/联想/找经验 → mnemon_recall；项目档案 → mnemon_document_search。\n---\n";
    },
  }), "dsh-llm-wiki.prompt.preview");

  // schema 守则
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:rules",
    order: rulesOrder,
    text: (context) => {
      if (!isMainAgent(context)) return "";
      const schema = readRules();
      if (!schema) return "";
      return "\n---\n# LLM-Wiki 知识库运行规则\n\n" + schema + "\n---\n";
    },
  }), "dsh-llm-wiki.prompt.rules");

  // ── 2) session/disposed → 触发管线 ──
  let lastRun = 0;
  let running = false;
  const COOLDOWN_MS = 60_000;

  const runPipeline = () => {
    if (running) return;
    if (!existsSync(PIPELINE)) {
      try { console.log("[dsh-llm-wiki] pipeline not found, skipped: " + PIPELINE); } catch {}
      return;
    }
    const now = Date.now();
    if (now - lastRun < COOLDOWN_MS) return;
    running = true;
    lastRun = now;
    // 会话结束只做增量同步；全量巡检交给每日 10:00 的计划任务
    const child = spawn(process.execPath, [PIPELINE, "--sync"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      // 管线自身的默认 vault 是 WSL 路径，必须显式传入
      env: { ...process.env, LLM_WIKI_VAULT: vault },
    });
    child.on("exit", (code) => {
      running = false;
      try { console.log("[dsh-llm-wiki] pipeline exit code=" + code); } catch {}
    });
    child.on("error", (e) => {
      running = false;
      try { console.log("[dsh-llm-wiki] pipeline spawn error: " + e.message); } catch {}
    });
    child.unref();
  };

  // 子代理（记忆写入/审查等）结束不需要跑整条管线，避免一次写入触发全量 --all。
  const isSubSession = (session) => {
    if (!session || typeof session !== "object") return false;
    const header = session.header || session.meta || session;
    return header.origin === "subagent" || header.parentSession !== undefined;
  };
  ctx.on("session/disposed", (session) => {
    if (isSubSession(session)) return;
    try { runPipeline(); } catch (e) { try { console.log("[dsh-llm-wiki] hook error: " + e.message); } catch {} }
  });
}
