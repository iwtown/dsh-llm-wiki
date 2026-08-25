#!/usr/bin/env node
/**
 * embed-proxy.mjs —— Ollama 兼容 embedding 代理（11434 → SiliconFlow /v1/embeddings）
 *
 * 让 mnemon（只认 127.0.0.1:11434 的 Ollama API）使用云端 embedding，
 * 替代本地 Ollama。零模型下载，网络延迟 ~250ms/批。
 *
 * 端点：
 *   GET  /api/tags          → {"models":[...]}（存活检测，让 mnemon/管线认为 Ollama 可用）
 *   POST /api/embed         → Ollama 格式 {model,input} → SF {data:[{embedding}]} → {embeddings:[[]]}
 *
 * 配置（env）：
 *   EMBED_MODEL      SiliconFlow 模型（默认 BAAI/bge-m3）
 *   EMBED_KEY        API key（默认从 ~/.modlens/config.json 读取）
 *   EMBED_PORT       监听端口（默认 11434）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const PORT = Number(process.env.EMBED_PORT || 11434);
const MODEL = process.env.EMBED_MODEL || "BAAI/bge-m3";
const SF_URL = "https://api.siliconflow.cn/v1/embeddings";

function loadKey() {
  if (process.env.EMBED_KEY) return process.env.EMBED_KEY;
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".modlens/config.json"), "utf8"));
    return c?.providers?.openai?.apiKey || "";
  } catch { return ""; }
}
const KEY = loadKey();

async function sfEmbed(inputs) {
  const res = await fetch(SF_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: MODEL, input: inputs }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("SF " + res.status + ": " + JSON.stringify(j).slice(0, 200));
  return (j.data || []).map(d => d.embedding);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === "GET" && url.pathname === "/api/tags") {
      return send(200, { models: [{ name: MODEL, model: MODEL }] });
    }
    if (req.method === "POST" && url.pathname === "/api/embed") {
      let body = "";
      for await (const ch of req) body += ch;
      const { input } = JSON.parse(body || "{}");
      const list = Array.isArray(input) ? input : [input];
      const embeddings = await sfEmbed(list);
      return send(200, { model: MODEL, embeddings });
    }
    if (req.method === "POST" && url.pathname === "/api/embeddings") {
      let body = "";
      for await (const ch of req) body += ch;
      const { input } = JSON.parse(body || "{}");
      const list = Array.isArray(input) ? input : [input];
      const embeddings = await sfEmbed(list);
      return send(200, { data: embeddings.map((e, i) => ({ embedding: e, index: i, object: "embedding" })), model: MODEL });
    }
    return send(404, { error: "unknown endpoint: " + url.pathname });
  } catch (e) {
    return send(502, { error: "embed proxy error: " + String(e.message || e).slice(0, 200) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("embed-proxy: 11434 -> " + MODEL + " (SF), key=" + (KEY ? "configured" : "MISSING"));
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
