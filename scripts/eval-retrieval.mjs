#!/usr/bin/env node
// eval-retrieval.mjs — 检索层 fixture 评测（BM25，无网络/无 mnemon）
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RETRIEVAL = path.join(HERE, "wiki-retrieval.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-retrieval-eval-"));
const mk = (rel, title, body) => {
  const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ["---", 'title: "' + title + '"', "tags: [wiki/test]", 'type: "测试"', "created: 2026-10-24", "updated: 2026-10-24", "related: []", "sources: []", 'description: "' + title + '"', "---", "", "# " + title, "", body].join("\n"), "utf8");
};
mk("wiki/决策/麒麟调度.md", "麒麟调度", "麒麟调度负责任务编排与队列优先级，关键词 kylin-scheduler。");
mk("wiki/决策/玄武备份.md", "玄武备份", "玄武备份覆盖每日快照与恢复演练，关键词 xuanwu-backup。");
mk("wiki/决策/朱雀网关.md", "朱雀网关", "朱雀网关处理出入站请求与限流，关键词 zhuque-gateway。");
mk("wiki/概念/青龙索引.md", "青龙索引", "青龙索引维护倒排表与增量更新，关键词 qinglong-index。");
mk("wiki/概念/白虎告警.md", "白虎告警", "白虎告警负责阈值判定与通知路由，关键词 baihu-alert。");
mk("wiki/项目/天狼部署.md", "天狼部署", "天狼部署描述灰度发布与回滚流程，关键词 tianlang-deploy。");
const cases = [
  ["麒麟调度 任务编排 优先级", "麒麟调度"],
  ["玄武 每日快照 恢复", "玄武备份"],
  ["朱雀 限流 出入站", "朱雀网关"],
  ["青龙 倒排表 增量", "青龙索引"],
  ["白虎 阈值 通知", "白虎告警"],
  ["天狼 灰度 回滚", "天狼部署"]
];
const results = [];
for (const [q, want] of cases) {
  let rels = [];
  try {
    const out = execFileSync(process.execPath, [RETRIEVAL, q, "--json", "--limit", "3", "--no-mnemon"], { env: { ...process.env, LLM_WIKI_VAULT: TMP }, encoding: "utf8", timeout: 30000 });
    const i = out.indexOf("{"), j = out.lastIndexOf("}");
    const jj = JSON.parse(out.slice(i, j + 1));
    rels = (jj.results || []).map(r => String(r.rel || ""));
  } catch (e) { rels = ["ERR:" + String(e.message).slice(0, 40)]; }
  const pass = rels.some(r => r.includes(want));
  results.push({ query: q, want, pass, top: rels.slice(0, 3) });
}
fs.rmSync(TMP, { recursive: true, force: true });
const pass = results.filter(r => r.pass).length;
console.log(JSON.stringify({ cases: results.length, pass, rate: Math.round(pass / results.length * 100), details: results }, null, 1));
if (pass !== results.length) process.exitCode = 1;
