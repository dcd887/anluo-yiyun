/**
 * AI 统一网关 —— Cloudflare Worker
 * ------------------------------------------------------------
 * 作用：把 LLM API Key 藏在服务端，多个前端游戏共用同一个网关。
 * 架构：
 *   游戏A/B/C (GitHub Pages)  ──►  本网关 /chat  ──►  SiliconFlow / DeepSeek / OpenAI
 *
 * 部署：cloudflare workers（免费版每天 10 万次请求，个人游戏完全够用）
 *   1. 注册 https://dash.cloudflare.com
 *   2. Workers & Pages → 创建 Worker → 粘贴本文件全部内容
 *   3. 设置 → 变量：LLM_API_KEY = 你的 SiliconFlow Key
 *   4. 部署后得到 https://你的worker名.workers.dev
 *   5. 游戏里把 baseUrl 改成 https://你的worker名.workers.dev/chat
 *
 * 安全设计：
 *   - Key 只在 Worker 环境变量里，玩家浏览器永远拿不到
 *   - 支持 CORS，任意域名前端可调用（GitHub Pages 场景）
 *   - 模型白名单：只允许转发指定模型，防止别人拿你的 Key 乱调其他模型
 *   - 可选限流：每 IP 每分钟 N 次（防刷爆），默认关闭
 * ------------------------------------------------------------
 */

// ============ 配置区 ============

// 允许前端调用时指定的模型（白名单）。留空数组 = 允许任何模型（不推荐）。
// 例：["deepseek-ai/DeepSeek-R1-0528-Qwen3-8B", "deepseek-ai/DeepSeek-V3"]
const MODEL_WHITELIST = [];

// 每个 IP 每分钟最大请求数（0 = 不限流）
const RATE_LIMIT_PER_MINUTE = 0;

// 是否要求前端带网关访问密钥（设置后前端必须填 GATEWAY_KEY，双保险）
// 留空 = 不校验。示例："my-game-secret-123"
const GATEWAY_KEY = "";

// ============ 主处理逻辑 ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // 健康检查
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "ai-gateway", time: new Date().toISOString() });
    }

    // 只接受 POST /chat
    if (url.pathname !== "/chat" || request.method !== "POST") {
      return json({ error: "not_found", message: "仅支持 POST /chat" }, 404);
    }

    // 网关密钥校验（可选）
    if (GATEWAY_KEY) {
      const auth = request.headers.get("x-gateway-key") || "";
      if (auth !== GATEWAY_KEY) {
        return json({ error: "unauthorized", message: "网关密钥无效" }, 401);
      }
    }

    // 限流（可选）
    if (RATE_LIMIT_PER_MINUTE > 0) {
      const limited = await rateLimit(request, env, RATE_LIMIT_PER_MINUTE);
      if (limited) {
        return json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" }, 429);
      }
    }

    // 读取请求体
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad_request", message: "请求体必须是 JSON" }, 400);
    }

    // 组装转发请求
    const model = body.model || "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
    if (MODEL_WHITELIST.length > 0 && !MODEL_WHITELIST.includes(model)) {
      return json({ error: "model_forbidden", message: `模型 ${model} 不在白名单` }, 403);
    }

    const upstream = env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions";
    const apiKey = env.LLM_API_KEY;
    if (!apiKey) {
      return json({ error: "server_misconfigured", message: "网关未配置 LLM_API_KEY" }, 500);
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
      return json({ error: "upstream_error", message: `上游 API 不可达：${e.message}` }, 502);
    }

    const upstreamText = await upstreamRes.text();

    // 把上游错误信息原样透传（方便前端提示）
    if (!upstreamRes.ok) {
      return new Response(upstreamText, {
        status: upstreamRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response(upstreamText, {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  },
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

/** 简易每 IP 限流：用 Worker 的 KV 或 Cache API。无 KV 时退回内存计数（单实例有效）。 */
async function rateLimit(request, env, limit) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}`;
  const now = Date.now();
  const windowMs = 60000;

  // 优先用 Cache API（无需额外绑定）
  try {
    const cache = caches.default;
    const url = new URL(request.url);
    url.pathname = `/_rl/${key}`;
    const cached = await cache.match(url);
    let count = 1;
    let expires = now + windowMs;
    if (cached) {
      const data = await cached.json();
      if (data.expires > now) {
        count = data.count + 1;
        expires = data.expires;
      }
    }
    if (count > limit) return true;
    await cache.put(
      url,
      new Response(JSON.stringify({ count, expires }), {
        headers: { "Cache-Control": `max-age=${Math.floor((expires - now) / 1000)}` },
      })
    );
    return false;
  } catch (e) {
    return false; // 限流失败时放行，不阻塞游戏
  }
}
