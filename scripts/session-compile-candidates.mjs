#!/usr/bin/env node
// session-compile-candidates.mjs —— 找出未编译的会话导出，判定是否值得编译（只产清单，不写 wiki）
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const args = process.argv.slice(2);
const arg = (n,d)=>{const i=args.indexOf("--"+n);return i>=0&&args[i+1]?args[i+1]:d;};
const VAULT = process.env.LLM_WIKI_VAULT || "D:/DB/Obsidian/LLM-Wiki";
const RAW = path.join(VAULT,"raw/sessions/dsh");
const OUT = arg("out","D:/DB/DSH/reports");
const TODAY = new Date().toISOString().slice(0,10);
const HOME = os.homedir();
const read = p => { try { return fs.readFileSync(p,"utf8"); } catch { return ""; } };
const sfKey = n => { const c=read(path.join(HOME,".dsh",".credentials.yaml")); const m=c.match(new RegExp("^\\s*"+n+":\\s*(\\S+)","m")); return m?m[1].replace(/^["']|["']$/g,""):""; };
function walk(d,out){ for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p,out); else if(e.name.endsWith(".md"))out.push(p);} }
const wikiFiles=[]; walk(path.join(VAULT,"wiki"),wikiFiles);
const wikiText = wikiFiles.map(f=>read(f)).join("\n");
const cachePath = path.join(OUT,".compile-cache.json");
let cache={}; try{cache=JSON.parse(read(cachePath)||"{}");}catch{}
const rows=[];
for(const f of fs.readdirSync(RAW).filter(x=>x.endsWith(".md"))){
  const p=path.join(RAW,f); const t=read(p); const short=(f.match(/([0-9a-f]{8})\.md$/)||[])[1]||"";
  const compiled = (short && wikiText.includes(short)) || wikiText.includes(f);
  if(compiled) continue;
  const qs=[...t.matchAll(/### 用户\n\n([\s\S]{4,300}?)\n\n### /g)].map(m=>m[1].replace(/\s+/g," ").trim()).filter(q=>q.length>=8&&!/^The approval policy/i.test(q));
  if(!qs.length) continue;
  const key=f+"|"+qs.length;
  if(!cache[key]){
    const prompt = "判断这次会话是否值得编译成知识页。只输出 JSON：{\"worthy\":true|false,\"type\":\"决策|发现|概念|流程|项目\",\"title\":\"≤20字标题\",\"summary\":\"≤40字摘要\",\"reason\":\"≤20字\"}。\n判定：有明确决策、排错过程、可复用结论/命令/配置才 worthy=true；纯闲聊、纯执行、一次性问答 false。\n用户发言：\n" + qs.slice(0,10).map((q,i)=>(i+1)+". "+q.slice(0,120)).join("\n");
    try{
      const res = await fetch("https://api.z.ai/api/paas/v4/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+sfKey("ZAI_API_KEY")},body:JSON.stringify({model:"glm-4-flash-250414",messages:[{role:"user",content:prompt}],temperature:0,max_tokens:300,thinking:{type:"disabled"}}),signal:AbortSignal.timeout(60000)});
      const j=await res.json(); const txt=String(j.choices?.[0]?.message?.content||"");
      const a=txt.indexOf("{"),b=txt.lastIndexOf("}"); cache[key]= a>=0&&b>a ? JSON.parse(txt.slice(a,b+1)) : {worthy:false,reason:"parse"};
    }catch(e){ cache[key]={worthy:false,reason:"fail"}; }
  }
  if(cache[key] && cache[key].worthy) rows.push({file:f,date:f.slice(0,10),...cache[key],first:qs[0].slice(0,60)});
}
fs.mkdirSync(OUT,{recursive:true}); fs.writeFileSync(cachePath,JSON.stringify(cache),"utf8");
const md=["# 待编译会话候选 "+TODAY,"","> 只读清单：需在会话中人工确认后用 wiki-write 落页。","", `未编译且有价值: ${rows.length}`, ""];
for(const r of rows) md.push("- ["+r.type+"] "+r.title+" — "+r.summary+"\n  - 来源: raw/sessions/dsh/"+r.file+"（首问: "+r.first+"…）");
const outFile=path.join(OUT,"compile-candidates-"+TODAY+".md"); fs.writeFileSync(outFile,md.join("\n")+"\n","utf8");
console.log(JSON.stringify({date:TODAY,uncompiledWorthy:rows.length,out:outFile}));
