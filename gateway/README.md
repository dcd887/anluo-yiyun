# AI 统一网关（Cloudflare Worker）

把 LLM API Key 藏在服务端，多个网页游戏共用同一套 AI 能力，玩家浏览器永远接触不到你的 Key。

## 架构

```
疑案卷宗 (GitHub Pages)  ─┐
档案隐庐 (GitHub Pages)  ─┼──►  https://你的worker.workers.dev/chat  ──►  SiliconFlow / DeepSeek
其他游戏 (任意静态托管)  ─┘          （Key 在 Worker 环境变量里）
```

## 部署步骤（约 5 分钟，免费）

1. 注册/登录 [Cloudflare](https://dash.cloudflare.com)（免费账号即可）
2. 左侧菜单 **Workers & Pages** → **创建** → **创建 Worker**
3. 名称填 `ai-gateway`（或你喜欢的名字）→ 部署
4. 点 **编辑代码**，把 `worker.js` 全部内容粘贴进去替换默认代码 → **部署**
5. 点 Worker 名 → **设置** → **变量** → 添加：
   - `LLM_API_KEY` = 你的 SiliconFlow API Key（形如 `sk-...`）
   - （可选）`LLM_BASE_URL` = 要改上游接口时才填，默认 SiliconFlow
6. 部署后你的网关地址是：`https://ai-gateway.你的用户名.workers.dev`

## 游戏端接入

把游戏设置面板里的默认值改为：

| 字段 | 原值 | 改为 |
|---|---|---|
| API Base URL | `https://api.siliconflow.cn/v1/chat/completions` | `https://ai-gateway.你的用户名.workers.dev/chat` |
| API Key | 玩家自填真实 Key | **留空即可**（Key 由网关注入） |

以《疑案卷宗》为例：设置面板填了 baseUrl 后，LLM 模式请求会先到网关，网关带上服务端 Key 转发到 SiliconFlow。

## 多游戏共用

所有游戏都填同一个网关地址即可，互不干扰。网关会自动：
- 允许任意前端域名调用（CORS 全开）
- 白名单模型（防别人拿你 Key 乱调）
- 可选按 IP 限流

## 安全说明

- **Key 永不进前端**：网关从环境变量读取，玩家无法通过浏览器调试偷到
- **Model 白名单**：在 `worker.js` 顶部 `MODEL_WHITELIST` 配置，防止他人指定高价模型刷你额度
- **网关密钥（可选）**：设置 `GATEWAY_KEY` 后，前端必须带 `x-gateway-key` 头，双保险

## 测试

部署后浏览器直接访问网关根路径应返回：

```json
{ "ok": true, "service": "ai-gateway", "time": "..." }
```

再用 curl 测试对话：

```bash
curl -X POST https://ai-gateway.你的用户名.workers.dev/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-R1-0528-Qwen3-8B","messages":[{"role":"user","content":"你好"}]}'
```

---

## 实际部署记录（2026-10-08）

- **网关地址**：`https://wispy-rain-f21c.mcjj.workers.dev`
- **Worker 名**：`wispy-rain-f21c`（Cloudflare 自动命名，账户 3510985146@qq.com）
- **状态**：✅ 已部署；`LLM_API_KEY` 环境变量已配置（SiliconFlow Key）；`/health` 已验证返回 `{"ok":true,"service":"ai-gateway"}`
- **游戏端接入**：把《疑案卷宗》设置里的 API Base URL 填 `https://wispy-rain-f21c.mcjj.workers.dev/chat`，API Key 留空

### ⚠️ 国内访问注意

`*.workers.dev` 域名在国内网络**直连常被墙**（实测上海网络访问超时）。影响：
- 国内玩家通过网关调 AI 可能连不上
- 但《疑案卷宗》演示模式（离线预置台词引擎）不受影响，仍完整可玩

**后续可选方案**（任选其一）：
1. **绑自定义域名**（推荐，需先有域名）：Cloudflare → Domains → 添加域名 → Worker 设置里绑定，国内用自定义域名访问
2. **玩家自填 Key 兜底**：游戏 LLM 模式保留"玩家填自己的 SiliconFlow/DeepSeek Key 直连"入口，不依赖网关
3. **换国内可直连的托管**（腾讯云函数 / Vercel 等），代码逻辑不变，改个 baseUrl 即可
