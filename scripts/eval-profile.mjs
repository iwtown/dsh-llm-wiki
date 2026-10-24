#!/usr/bin/env node
// eval-profile.mjs — 决策引擎基线评测：时间更新 / 冲突 / 覆盖 / 弃权 / 新增 / 槽位
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process"; import os from "node:os"; import { fileURLToPath } from "node:url";
const TMP = path.join(os.tmpdir(), "profile-eval");
const DISTILL = fileURLToPath(new URL("./profile-distill.mjs", import.meta.url));
const TODAY = new Date().toISOString().slice(0, 10);
function runCase(c) {
  const dir = path.join(TMP, c.id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "ev"), { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.md"), "---\ntitle: eval\n---\n\n## eval\n\n" + (c.rules || []).map(r => "- " + r + " ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active").join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "USER.md"), (c.rules || []).map(r => r.split(" ｜ ")[0]).join("\n"));
  fs.writeFileSync(path.join(dir, "ev", TODAY + ".jsonl"), (c.evidence || []).map(e => JSON.stringify({ type: e.type || "explicit_correction", rule: e.rule, quote: e.quote || e.rule, polarity: e.polarity || "positive", confidence: 0.9, source: "recap", sessionId: e.sid || "s1", project: "eval", date: TODAY, slot: e.slot })).join("\n") + "\n");
  const out = path.join(dir, "out");
  execFileSync(process.execPath, [DISTILL, "--since", "60d", "--out", out], { env: { ...process.env, PROFILE_PAGE: path.join(dir, "profile.md"), USER_MD: path.join(dir, "USER.md"), PROFILE_EVIDENCE_DIR: path.join(dir, "ev"), PROFILE_REVIEW: "off" }, stdio: "pipe", timeout: 60000 });
  const jl = path.join(out, "profile-candidate-" + TODAY + ".jsonl");
  const cands = fs.existsSync(jl) ? fs.readFileSync(jl, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  return cands;
}
const cases = [
  { id: "temporal-proxy", rules: ["默认不走代理 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "以后默认允许走代理", quote: "以后默认可以走代理", polarity: "positive" }], expect: { decision: "CONFLICT", conflictType: "temporal" } },
  { id: "update-swallow", rules: ["验证只做冒烟 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "以后验证要含回归", quote: "以后验证要含回归", polarity: "positive" }], expect: { decisionIn: ["UPDATE", "CONFLICT"] } },
  { id: "noop-same", rules: ["先给方案再执行 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "先方案后执行", quote: "先方案后执行", polarity: "positive" }], expect: { decision: "NOOP" } },
  { id: "noop-typo", rules: ["先确认现有设计，避免重复造轮子 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "不要重复早轮子", quote: "别重复早轮子", polarity: "negative" }], expect: { decision: "NOOP" } },
  { id: "abstain-noise", rules: [], evidence: [{ type: "explicit_instruction", rule: "帮我搜蓝牙耳机", quote: "帮我搜蓝牙耳机" }, { type: "explicit_instruction", rule: "检查一下端口", quote: "检查一下端口" }], expect: { count: 0 } },
  { id: "conflict-factual", rules: ["模型只用免费 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "必须用付费模型", quote: "必须用付费模型", polarity: "positive" }], expect: { decision: "CONFLICT" } },
  { id: "expire", rules: ["旧规则 ｜ 置信 low ｜ 有效期 2020-01-01 ｜ 状态 active"], evidence: [], expect: { decision: "EXPIRE" } },
  { id: "update-variant", rules: ["先给方案再执行 ｜ 证据 会话 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [{ type: "explicit_correction", rule: "先给方案，审核后再动手", quote: "先给方案审核后再动手", polarity: "positive" }], expect: { decisionIn: ["UPDATE", "ADD"] } },
  { id: "unclassified", rules: [], evidence: [{ type: "explicit_correction", rule: "我喜欢蓝色", quote: "我喜欢蓝色", polarity: "positive" }], expect: { slot: "unclassified" } },
  { id: "orphan", rules: ["无证据规则 ｜ 置信 high ｜ 有效期 2027-01-01 ｜ 状态 active"], evidence: [], expect: { decision: "ORPHAN" } },
  { id: "threshold-single", rules: [], evidence: [{ type: "explicit_instruction", rule: "以后先给结论再解释", quote: "以后先给结论", polarity: "positive" }], expect: { count: 0 } },
  { id: "noise-narrative", rules: [], evidence: [{ type: "explicit_correction", rule: "否定agent行为，要求卸载并改用方案", quote: "卸载 kb-sieve", polarity: "negative" }], expect: { count: 0 } },
  { id: "add-slot", rules: [], evidence: [{ type: "explicit_correction", rule: "先给结论再解释", quote: "以后先给结论", polarity: "positive" }], expect: { decision: "ADD", slot: "comm.answer_first" } }
];
const results = [];
for (const c of cases) {
  const cands = runCase(c);
  const okDec = c.expect.decision ? cands.some(x => x.decision === c.expect.decision) : true;
  const okIn = c.expect.decisionIn ? cands.some(x => c.expect.decisionIn.includes(x.decision)) : true;
  const okCount = c.expect.count !== undefined ? cands.length === c.expect.count : true;
  const okSlot = c.expect.slot ? cands.some(x => x.slot === c.expect.slot) : true;
  const okType = c.expect.conflictType ? cands.some(x => x.conflictType === c.expect.conflictType) : true;
  results.push({ case: c.id, pass: okDec && okIn && okCount && okSlot && okType, decisions: cands.map(x => x.decision + (x.slot ? ":" + x.slot : "") + (x.conflictType ? "/" + x.conflictType : "")), expect: JSON.stringify(c.expect) });
}
const pass = results.filter(r => r.pass).length;
console.log(JSON.stringify({ cases: results.length, pass, rate: Math.round(pass / results.length * 100), details: results }, null, 1));
