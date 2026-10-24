#!/usr/bin/env node
// weekly-summary.mjs — 每周一页：任务结果 / 健康变化 / 待你处理的清单
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const REPORTS = process.env.LLM_WIKI_REPORTS || "D:/DB/DSH/reports";
const HEALTH = path.join(REPORTS, "health");
const OUT = path.join(REPORTS, "weekly");
const TODAY = new Date().toISOString().slice(0, 10);
const read = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const tasks = ["LLM-Wiki Pipeline", "Profile Distill", "LLM-Wiki Compile Candidates", "LLM-Wiki Stale Review"];
function taskInfo(name) {
  try {
    const out = execFileSync("schtasks", ["/Query", "/TN", name, "/V", "/FO", "LIST"], { encoding: "utf8", timeout: 15000 });
    const t = (out.match(/Last Run Time:\s*(.+)/) || [])[1] || "-";
    const r = (out.match(/Last Result:\s*(\d+)/) || [])[1] || "-";
    return { t: t.trim(), r };
  } catch { return { t: "未安装", r: "-" }; }
}
const month = TODAY.slice(0, 7);
const csv = path.join(HEALTH, "health-" + month + ".csv");
const lines = read(csv).trim().split(/\r?\n/);
const head = (lines[0] || "").split(",");
const rows = lines.slice(1).map(l => l.split(","));
const last7 = rows.slice(-7);
const first = last7[0] || [], last = last7[last7.length - 1] || [];
const col = k => { const i = head.indexOf(k); return i < 0 ? "-" : (first[i] + " → " + last[i]); };
const latest = prefix => { try { const xs = fs.readdirSync(REPORTS).filter(f => f.startsWith(prefix) && f.endsWith(".md")).sort(); return xs.length ? path.join(REPORTS, xs[xs.length - 1]) : ""; } catch { return ""; } };
const cand = latest("profile-candidate-");
const stale = latest("stale-review-");
const compile = latest("compile-candidates-");
const num = (file, re) => { const m = read(file).match(re); return m ? m[1] : "?"; };
const md = ["# 周报 " + TODAY, "", "> 自动生成；处理入口见文末。", "", "## 任务结果", "", "| 任务 | 上次运行 | 结果 |", "|---|---|---|"];
for (const t of tasks) { const i = taskInfo(t); md.push("| " + t + " | " + i.t + " | " + (i.r === "0" ? "✅ 0" : "⚠️ " + i.r) + " |"); }
md.push("", "## 健康变化（最近 7 条）", "", "| 指标 | 变化 |", "|---|---|");
for (const k of ["pages", "syncPages", "syncChunks", "stale", "lintIssues", "probeHit", "compiled"]) md.push("| " + k + " | " + col(k) + " |");
md.push("", "## 待你处理", "");
md.push("- 画像候选 " + num(cand, /候选\s*(\d+)/) + " 条 → " + (cand || "（无）"));
md.push("- stale 复核 " + num(stale, /本批:\s*(\d+)/) + " 条 → " + (stale || "（无）"));
md.push("- 编译候选 " + num(compile, /有价值:\s*(\d+)/) + " 条 → " + (compile || "（无）"));
const alert = path.join(HEALTH, "ALERT.md");
if (fs.existsSync(alert)) md.push("- ⚠️ 有未处理告警 → " + alert);
md.push("", "## 操作提示", "", "- 应用画像：在会话里说「应用候选」，由 mnemon_runtime_memory 写入 USER.md。", "- 归档/更新 stale：按清单里的 --rate 命令执行。", "- 编译候选：在会话里说「编译第 N 条」，用 wiki-write 落页。", "");
fs.mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, "weekly-" + TODAY + ".md");
fs.writeFileSync(out, md.join("\n"), "utf8");
fs.writeFileSync(path.join(OUT, "LATEST.md"), md.join("\n"), "utf8");
console.log(JSON.stringify({ date: TODAY, out }));
