#!/usr/bin/env node
// pipeline-health.mjs — 每日健康快照（CSV）+ 召回探针
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const VAULT = process.env.LLM_WIKI_VAULT || "D:/DB/Obsidian/LLM-Wiki";
const OUT = process.env.LLM_WIKI_HEALTH_DIR || "D:/DB/DSH/reports/health";
const STATE = process.env.LLM_WIKI_STATE || path.join(process.env.USERPROFILE || "", ".dsh", "llm-wiki", "pipeline-state.json");
const USERMD = process.env.USER_MD || path.join(process.env.USERPROFILE || "", ".mnemon", "runtime", "USER.md");
const BIN = process.env.LLM_WIKI_BIN || path.join(process.env.USERPROFILE || "", ".dsh", "bin");
const TODAY = new Date().toISOString().slice(0,10);
const read = p => { try { return fs.readFileSync(p,"utf8"); } catch { return ""; } };
const pages=[]; const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){walk(p);continue;}if(!e.name.endsWith(".md")||e.name==="index.md")continue;pages.push({rel:path.relative(VAULT,p).replace(/\\/g,"/"),text:read(p)});}}; walk(path.join(VAULT,"wiki"));
const archived=pages.filter(p=>/status:\s*archived/.test(p.text.slice(0,1500))).length;
const rawDir=path.join(VAULT,"raw/sessions/dsh"); const raws=fs.existsSync(rawDir)?fs.readdirSync(rawDir).filter(f=>f.endsWith(".md")):[];
const allText=pages.map(p=>p.text).join("\n");
let compiled=0; for(const f of raws){ const short=(f.match(/([0-9a-f]{8})\.md$/)||[])[1]||""; if((short&&allText.includes(short))||allText.includes(f)) compiled++; }
const stale=pages.filter(p=>{ if(/status:\s*archived/.test(p.text.slice(0,1500))) return false; const m=p.text.slice(0,1500).match(/^updated:\s*(\S+)/m)||p.text.slice(0,1500).match(/^created:\s*(\S+)/m); if(!m) return false; return (Date.now()-new Date(m[1]).getTime())/864e5>90; }).length;
const logTxt=read(path.join(VAULT,"log.md")); const mlog=[...logTxt.matchAll(/lint:(\d+)问题/g)]; const lintIssues=mlog.length?Number(mlog[0][1]):-1;
let syncPages=0, syncChunks=0; try{ const st=JSON.parse(read(STATE)); for(const k of Object.keys(st)) if(k.startsWith("wiki")){ syncPages++; syncChunks+=(st[k].chunks||[]).length; } }catch{}
const userMd=read(USERMD); const userEntries=(userMd.match(/\n§\n/g)||[]).length+(userMd.trim()?1:0); const userBytes=Buffer.byteLength(userMd,"utf8");
const REPORTS = process.env.LLM_WIKI_REPORTS || "D:/DB/DSH/reports";
const candFile=path.join(REPORTS,"profile-candidate-"+TODAY+".jsonl"); const candCount=fs.existsSync(candFile)?read(candFile).trim().split(/\r?\n/).filter(Boolean).length:0;
const probes=[["mnemon 备份策略","Mnemon 记忆栈运维"],["LLM-Wiki 记忆层改造","记忆层改造方案"],["wsl2 wezterm 配置","wsl2-wezterm"],["taobao native 路径","taobao-native"],["画像 预算 2KB","习惯与偏好"],["obsidian-git 双远端","Obsidian"]];
let hit=0; for(const pr of probes){ try{ const out=execFileSync("node",[path.join(BIN,"wiki-retrieval.mjs"),pr[0],"--json","--limit","3","--no-mnemon"],{encoding:"utf8",timeout:30000}); const j=JSON.parse(out); const ok=(j.results||[]).slice(0,3).some(r=>String((r.rel||"")+(r.title||"")).toLowerCase().includes(String(pr[1]).toLowerCase())); if(ok) hit++; }catch{} }
const row=[TODAY,pages.length,archived,raws.length,compiled,raws.length?Math.round(compiled/raws.length*100):0,stale,lintIssues,syncPages,syncChunks,pages.length?Math.round(syncPages/pages.length*100):0,userEntries,userBytes,candCount,hit+"/"+probes.length].join(",");
fs.mkdirSync(OUT,{recursive:true}); const csv=path.join(OUT,"health-"+TODAY.slice(0,7)+".csv");
const header="date,pages,archived,rawSessions,compiled,compileRatePct,stale,lintIssues,syncPages,syncChunks,coveragePct,userEntries,userBytes,profileCandidates,probeHit";
if(!fs.existsSync(csv)) fs.writeFileSync(csv,header+"\n"+row+"\n","utf8"); else { const lines=read(csv).trim().split(/\r?\n/); const rest=lines.slice(1).filter(l=>!l.startsWith(TODAY+",")); fs.writeFileSync(csv,[header,...rest,row].join("\n")+"\n","utf8"); }
try {
  const lines=read(csv).trim().split(/\r?\n/); const head=lines[0].split(","); const rows=lines.slice(1).map(l=>l.split(","));
  if(rows.length){
    const first=rows[0], last=rows[rows.length-1];
    const md=["# 健康月报 "+TODAY.slice(0,7),"","> 数据来源: "+csv,"","| 指标 | 月初 | 最新 | 变化 |","|---|---|---|---|"];
    const cols={pages:"页面",archived:"归档",compiled:"已编译",stale:"stale",lintIssues:"lint问题",syncPages:"同步页",syncChunks:"同步块",coveragePct:"覆盖%",userEntries:"USER条目",profileCandidates:"画像候选",probeHit:"探针"};
    for(const [k,name] of Object.entries(cols)){ const i=head.indexOf(k); if(i<0) continue; const a=first[i], b=last[i]; const d=(Number(b)-Number(a)); md.push("| "+name+" | "+a+" | "+b+" | "+(isNaN(d)?(a===b?"-":"变化"):(d>0?"+"+d:String(d)))+" |"); }
    fs.writeFileSync(path.join(OUT,"health-"+TODAY.slice(0,7)+".md"),md.join("\n")+"\n","utf8");
  }
} catch {}
console.log(JSON.stringify({date:TODAY,pages:pages.length,archived,compiled,rawSessions:raws.length,stale,syncPages,syncChunks,userEntries,userBytes,candCount,probeHit:hit+"/"+probes.length,csv}));