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
  try { console.log("[dsh-llm-wiki] apply() vault=" + vault + " rules=" + existsSync(rulesFile) + " preview=" + existsSync(previewFile) + " pipeline=" + existsSync(PIPELINE)); } catch {}

  // ── 1) systemPrompt 注入 ──
  // 知识预览（先于守则，order 更低先出现）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:preview",
    order: previewOrder,
    text: () => {
      const idx = readPreview();
      if (!idx) return "";
      return "\n---\n# LLM-Wiki 知识库（管线自动维护）\n\n" + idx + "\n---\n";
    },
  }), "dsh-llm-wiki.prompt.preview");

  // schema 守则
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:rules",
    order: rulesOrder,
    text: () => {
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
    const child = spawn(process.execPath, [PIPELINE, "--all"], {
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

  ctx.on("session/disposed", () => {
    try { runPipeline(); } catch (e) { try { console.log("[dsh-llm-wiki] hook error: " + e.message); } catch {} }
  });
}
