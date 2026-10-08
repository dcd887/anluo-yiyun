# AI 网关 · 安全与控制成本方案（执行手册）

> 场景：多个网页游戏（疑案卷宗 / HerTrees / 档案隐庐等）内置 AI 推理，统一走网关。
> 现状：Cloudflare Worker 网关已部署（`wispy-rain-f21c.mcjj.workers.dev`），国内直连被墙；
> 腾讯云 SCF 版代码已写好并通过本地验证（`gateway/scf-handler.js`），待部署。

---

## 一、安全方案：4 道防线

### 1️⃣ Key 永不进前端（核心）
- 架构：`游戏(GitHub Pages) → 网关 → SiliconFlow`，`LLM_API_KEY` 只存在服务端环境变量。
- 玩家浏览器只能看到网关地址，**用 DevTools 也偷不到 Key**。
- 两个宿主都天然支持环境变量：Cloudflare（已配置）、腾讯云 SCF（部署时配置）。

### 2️⃣ 模型白名单（防别人拿你 Key 调高价模型）
在网关代码顶部配置，只放行游戏用到的模型：

```js
const MODEL_WHITELIST = ["deepseek-ai/DeepSeek-R1-0528-Qwen3-8B"];
```

放行列表之外的模型一律返回 403，**防止有人用你的 Key 去调几百块钱一次的旗舰模型**。

### 3️⃣ 网关访问密钥（推荐开启，挡掉扫接口的人）
```js
const GATEWAY_KEY = "一个随机的长字符串";
```
开启后前端必须带 `x-gateway-key` 头才放行。注意：单页游戏的前端 JS 必然暴露这个 key，它的作用是**挡住"不知道 key 直接 curl 刷你量"的陌生人**，不是防懂行的人。

### 4️⃣ 限流 + CORS 收紧（防刷爆）
- 限流：Cloudflare 版有按 IP 限流（`RATE_LIMIT_PER_MINUTE`，用 Cache API）；SCF 版建议配合**腾讯云 API 网关的限流插件**（SCF 本身无状态，代码级限流只对单实例有效）。
- CORS 收紧：把 `Access-Control-Allow-Origin` 从 `*` 改为你的已知域名列表：
  ```
  https://dcd887.github.io
  ```
  其他域名即使请求也被浏览器拦下（注意：curl 类工具不受 CORS 限制，所以仍靠密钥+限流兜底）。

### 5️⃣ 其他安全细节（已内置在网关代码里）
| 项 | 状态 |
|---|---|
| `max_tokens` 钳制 ≤ 4096 | ✅ 网关代码已做 |
| 请求体字段白名单（只透传 model/messages/temperature/max_tokens） | ✅ 已做 |
| 不打印/不记录 Key 和请求内容 | ✅ 代码无任何日志 |
| 上游 5xx 时返回 502 不泄露内部信息 | ✅ 已做 |

---

## 二、成本控制：3 道闸

### 1️⃣ 免费额度先吃到饱
| 宿主 | 免费额度 | 备注 |
|---|---|---|
| Cloudflare Worker（现网） | 10 万请求/**天** | 当前网关，个人游戏远用不完 |
| 腾讯云 SCF（待部署） | 前 3 个月每月 **100 万次调用 + 100 万 GBs + 2GB 出流量** | 之后 9.9 元/月套餐或按量（几毛钱/月量级） |

### 2️⃣ 模型选便宜的 + 压短输出
- 游戏用 `DeepSeek-R1-0528-Qwen3-8B`（8B 小模型）：比完整 R1（输入 ¥4/M、输出 ¥16/M 量级）便宜一个数量级，估计在输入 ¥0.5-1/M、输出 ¥2-4/M 量级（以 SiliconFlow 控制台实时价格为准）。
- 网关把 `max_tokens` 默认压到 **1024**（审讯回复够用），单次对话成本约 **¥0.001-0.01**。
- 若想再省：把默认模型换成非推理模型（如 DeepSeek-V3 系列）更快更便宜，但推理质量下降——审讯游戏保留 R1 的推理感。

### 3️⃣ 防滥用 + 盯用量
- 白名单（挡住调贵模型）+ 限流（挡住刷量）双保险。
- **用量监控**：
  - SiliconFlow 控制台 → 用量统计，看每日 token 消耗；
  - 腾讯云 → 费用中心/SCF 监控，设**预算告警**（如月 ¥10，超了邮件提醒）。
- 成本预估（量级）：
  - 1 个玩家玩一局 30 分钟，AI 请求约 50-150 次；
  - 100 个玩家 ≈ 1 万次请求 ≈ 1000 万 token ≈ **¥5-20/月**；
  - 正常流量免费额度完全覆盖，只有被恶意刷才需要防线兜底。

---

## 三、回去后的执行清单

### A. 腾讯云 SCF 部署（约 10 分钟，需扫码登录）
1. 打开 `https://console.cloud.tencent.com/scf` → 函数服务 → 新建
2. 创建方式：**Web 函数** | 运行环境：**Nodejs 18.15** | 上传方式：在线编辑
3. 粘贴 `gateway/scf-handler.js` 全文（**已本地验证 /health + /chat 真实调通**）
4. 高级配置：
   - 超时时间：**120 秒**
   - 环境变量：`LLM_API_KEY` = SiliconFlow Key
5. 创建后 → 触发管理 → 复制**函数 URL**（形如 `https://xxx.ap-shanghai.scf.tencentcs.com`）
6. 本地测试：`curl <函数URL>/health` 应返回 `{"ok":true,"service":"ai-gateway"...}`

### B. 网关配置收紧（Cloudflare 现网 + 腾讯云部署时同做）
- [ ] `MODEL_WHITELIST` 填入 `["deepseek-ai/DeepSeek-R1-0528-Qwen3-8B"]`
- [ ] 生成随机 `GATEWAY_KEY` 并填入（`openssl rand -hex 16`）
- [ ] CORS 从 `*` 改为 `https://dcd887.github.io`

### C. 游戏端接入
- 设置面板 baseUrl 改为 `<网关地址>/chat`，API Key 留空（Key 由网关注入）
- 保留"玩家自填 Key 直连"兜底入口（国内网关不通时的备用通道）

### D. 成本护栏
- [ ] 腾讯云费用中心开启预算告警（月 ¥10）
- [ ] SiliconFlow 控制台加用量提醒

---

## 四、当前状态备忘

| 项 | 状态 |
|---|---|
| Cloudflare 网关 `wispy-rain-f21c.mcjj.workers.dev` | ✅ 已部署（代码+LLM_API_KEY），/health 通过；国内被墙 |
| 腾讯云 SCF 代码 `gateway/scf-handler.js` | ✅ 已写好，本地模拟 /health + /chat 真实调通 |
| 腾讯云 SCF 部署 | ⏳ 待用户扫码登录后执行（二维码两次失效，用户决定回去再弄） |
| GitHub Pages 游戏 | ✅ 已上线可玩，双模式（演示离线 + LLM 自填 Key） |
