#!/usr/bin/env node
// stale-review.mjs — 每周 stale 复核清单（只读）
import fs from "node:fs"; import path from "node:path";
const VAULT = process.env.LLM_WIKI_VAULT || "D:/DB/Obsidian/LLM-Wiki";
const OUT = (process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out")+1] : "D:/DB/DSH/reports");
const LIMIT = Number(process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit")+1] : 20);
const TODAY = new Date().toISOString().slice(0,10);
const read = p => { try { return fs.readFileSync(p,"utf8"); } catch { return ""; } };
const pages=[]; const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){walk(p);continue;}if(!e.name.endsWith(".md")||e.name==="index.md")continue;pages.push({rel:path.relative(VAULT,p).replace(/\\/g,"/"),text:read(p)});}}; walk(path.join(VAULT,"wiki"));
const allText = pages.map(p=>p.text).join("\n");
const now=Date.now(); const items=[];
for(const p of pages){
  if(/status:\s*archived/.test(p.text.slice(0,1500))) continue;
  const m=p.text.slice(0,1500).match(/^updated:\s*(\S+)/m)||p.text.slice(0,1500).match(/^created:\s*(\S+)/m);
  if(!m) continue;
  const days=Math.round((now-new Date(m[1]).getTime())/864e5);
  if(!(days>90)) continue;
  const title=(p.text.match(/^title:\s*"?([^"\n]+)/m)||[])[1]||path.basename(p.rel);
  const q=Number((p.text.match(/^quality_score:\s*(\d)/m)||[])[1]||3);
  const base=path.basename(p.rel,".md");
  const inbound=(allText.match(new RegExp("\\[\\[[^\\]]*"+base.replace(/[.*+?^$()|[\]\\]/g,"\\$&")+"[^\\]]*\\]\\]","g"))||[]).length;
  items.push({rel:p.rel,title,days,q,inbound});
}
items.sort((a,b)=> a.q-b.q || b.days-a.days || b.inbound-a.inbound);
const top=items.slice(0,LIMIT);
const md=["# stale 复核清单 "+TODAY,"", "stale 总数: "+items.length+"；本批: "+top.length+"（按质量低/最久未更新/被引用多排序）","","> 只读：在会话中逐页决定 保留/更新/归档，再执行。","","| # | 页面 | 质量 | 未更新 | 被引用 | 建议 |","|---|---|---|---|---|---|"];
top.forEach((it,i)=>md.push("| "+(i+1)+" | "+it.title+"（"+it.rel+"） | "+it.q+" | "+it.days+"d | "+it.inbound+" | "+(it.q<=2?"归档":"更新或保留")+" |"));
md.push("","## 可直接执行的命令","");
for(const it of top) md.push('node "C:\\Users\\wtown\\.dsh\\bin\\llm-wiki-pipeline.mjs" --rate "'+it.rel+'" --rating outdated');
const outFile=path.join(OUT,"stale-review-"+TODAY+".md"); fs.mkdirSync(OUT,{recursive:true}); fs.writeFileSync(outFile,md.join("\n")+"\n","utf8");
console.log(JSON.stringify({date:TODAY,total:items.length,listed:top.length,out:outFile}));