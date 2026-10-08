/**
 * AI 统一网关 —— 腾讯云 SCF Web 函数版
 * ------------------------------------------------------------
 * 与 gateway/worker.js（Cloudflare 版）同一套逻辑，仅入口格式不同：
 *   Cloudflare: export default { async fetch(request, env, ctx) {...} }
 *   腾讯云 SCF: exports.main_handler = async (event, context) => {...}
 *
 * 为什么有这份：Cloudflare workers.dev 域名国内直连被墙，
 * 腾讯云 SCF 默认域名国内直连快，且无需备案。
 *
 * 部署（控制台约 5 分钟）：
 *   1. https://console.cloud.tencent.com/scf → 函数服务 → 新建
 *   2. 创建方式：Web 函数 | 运行环境：Nodejs 18.15 | 上传方式：在线编辑
 *   3. 粘贴本文件全部内容 → 高级配置里设置：
 *        - 超时时间：120 秒（R1 类慢推理模型需要）
 *        - 环境变量：LLM_API_KEY = 你的 SiliconFlow Key
 *   4. 创建后 → 触发管理 → 复制"函数 URL"（形如
 *      https://xxx.ap-shanghai.scf.tencentcs.com）
 *   5. 游戏里把 baseUrl 改成  <函数URL>/chat
 *
 * 安全设计：
 *   - Key 只在环境变量里，玩家浏览器永远拿不到
 *   - CORS 全开，任意域名前端可调用（GitHub Pages 场景）
 *   - 模型白名单：只允许转发指定模型（默认全部放行）
 *   - 可选 GATEWAY_KEY：前端必须带 x-gateway-key 头（默认不校验）
 * ------------------------------------------------------------
 */

// ============ 配置区 ============

// 允许前端调用时指定的模型（白名单）。留空数组 = 允许任何模型。
// 例：["deepseek-ai/DeepSeek-R1-0528-Qwen3-8B", "deepseek-ai/DeepSeek-V3"]
const MODEL_WHITELIST = [];

// 是否要求前端带网关访问密钥（设置后前端必须填 GATEWAY_KEY，双保险）
// 留空 = 不校验。示例："my-game-secret-123"
const GATEWAY_KEY = "";

// ============ SCF Web 函数入口 ============

exports.main_handler = async (event, context) => {
  const method = event.httpMethod || "GET";
  const path = event.path || "/";

  // CORS 预检
  if (method === "OPTIONS") {
    return respond(204, "");
  }

  // 健康检查
  if (path === "/" || path === "/health") {
    return respond(200, JSON.stringify({ ok: true, service: "ai-gateway", time: new Date().toISOString() }));
  }

  // 只接受 POST /chat
  if (path !== "/chat" || method !== "POST") {
    return respond(404, JSON.stringify({ error: "not_found", message: "仅支持 POST /chat" }));
  }

  // 网关密钥校验（可选）
  if (GATEWAY_KEY) {
    const auth = (event.headers && (event.headers["x-gateway-key"] || "")) || "";
    if (auth !== GATEWAY_KEY) {
      return respond(401, JSON.stringify({ error: "unauthorized", message: "网关密钥无效" }));
    }
  }

  // 读取请求体（SCF 可能把 body 做 base64 编码）
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf-8");
  }
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch (e) {
    return respond(400, JSON.stringify({ error: "bad_request", message: "请求体必须是 JSON" }));
  }

  // 组装转发请求
  const model = body.model || "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
  if (MODEL_WHITELIST.length > 0 && !MODEL_WHITELIST.includes(model)) {
    return respond(403, JSON.stringify({ error: "model_forbidden", message: `模型 ${model} 不在白名单` }));
  }

  const upstream = process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions";
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return respond(500, JSON.stringify({ error: "server_misconfigured", message: "网关未配置 LLM_API_KEY" }));
  }

  // 透传 OpenAI 兼容请求体（白名单关键字段，防止传多余参数）
  const payload = {
    model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
    max_tokens: typeof body.max_tokens === "number" ? Math.min(body.max_tokens || 1024, 4096) : 1024,
    stream: false,
  };

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return respond(502, JSON.stringify({ error: "upstream_error", message: `上游 API 不可达：${e.message}` }));
  }

  const upstreamText = await upstreamRes.text();

  // 把上游错误信息原样透传（方便前端提示）
  if (!upstreamRes.ok) {
    return {
      statusCode: upstreamRes.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: upstreamText,
      isBase64Encoded: false,
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: upstreamText,
    isBase64Encoded: false,
  };
};

// ============ 工具函数 ============

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-gateway-key",
    "Access-Control-Max-Age": "86400",
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body,
    isBase64Encoded: false,
  };
}
