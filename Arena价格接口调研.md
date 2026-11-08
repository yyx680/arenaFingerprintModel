# Arena「价格接口」调研（2026-10-11）

> 结论先行：**Arena 确实公开了「每个模型的成本」数据，但网页版 Agent Mode 只回传额度百分比、不回传美元成本。**
> 所以「按每次请求的价格反推模型」这件事，**在网页版做不到**；要么把价格当**旁证/先验**，要么改走 **Arena API 网关**（那里才有真正的每次请求成本）。

---

## 1. 价格数据确实存在：Agent Pareto 榜

- 页面：`https://arena.ai/leaderboard/agent/pareto`（无需登录，服务端渲染）
- 榜单维度：**Median cost per task (last 14 days)** —— 每个模型的「近 14 天任务中位成本」，单位 `$X.XX/task`
- 可选分位：**p25 / p50 / p95**；可切换维度「Cost ↔ Output Tokens」
- 分类：Overall / Code / Chat / Work；许可：Proprietary / Open Source
- 规模：52 个模型，2,378,129 sessions（2026-10-08 快照）

### 口径（官方博客 `arena.ai/blog/agent-categories-and-cost`，2026-08-14）
- 成本 = **真实 Agent Mode 会话的 token 用量 × 模型定价**（Arena 自己算的，来自 170 万+ 真实会话）
- 一个「任务」= 会话里一段来回交互；**每个会话只统计前 3 个任务**，以抵消上下文累积导致的成本虚高
- 同时公布：**output tokens per task**、**cost per million tokens**
- 明确说明：这是 in-situ 实测，不是受控基准

### 已抓到的成本表（p50，USD/task，2026-10-11）
| 模型 | $/task | | 模型 | $/task |
|---|---|---|---|---|
| Claude Fable 5.1 (Max) | 6.54 | | GPT 5.5 (xHigh) | 1.14 |
| Claude Opus 5 (Max) | 5.22 | | Claude Sonnet 5 (High) | 0.98 |
| GPT 6 Astra (Max) | 3.47 | | GPT 6 Sol (Max) | 0.78 |
| Claude Sonnet 5.5 (Max) | 3.01 | | Gemini 4 Argon (High) | 0.67 |
| Claude Opus 5 (High) | 2.97 | | GPT 6.1 Sol (Max) | 0.58 |
| Claude Fable 5 (High) | 2.69 | | Muse Spark 1.3 (Max) | 0.51 |
| Claude Opus 5.5 (High) | 1.79 | | Deepseek V4.1 Flash (Max) | 0.12 |
| Claude Opus 4.8 (High) | 1.37 | | MiMo V2.6 Pro | 0.10 |
| GPT 5.6 Sol (xHigh) | 1.30 | | GPT 6 Luna (Max) | 0.07 |
| | | | MiMo V2.6 Flash / Solar Pro 4 | 0.05 / 0.04 |

> 注意：**同一家族内部成本差异极大** —— GPT-6 家族 Astra `$3.47` / Sol `$0.78` / Luna `$0.07`。
> 而指纹通道恰恰在家族内部最容易混（luna/sol/astra 互串）。**成本本来是能切开这一刀的强特征** —— 前提是能拿到「这次请求的成本」。

---

## 2. 但「每次请求的价格」在网页版拿不到

| 检查项 | 结果 |
|---|---|
| 官方公开 API | **没有**。`GET https://arena.ai/api/leaderboard/agent` → `{"error":"Route not allowed"}` |
| 网页版额度接口 | 只有 `GET /api/me/pulse` → `{pulse: 剩余百分比, refreshedAt}`，**是百分比不是 credits/美元**（本仓库 `billing.js` 已注明「不做任何 USD 换算」） |
| 会话数据 | `GET /c/<sid>`（RSC）里是 `messages[]`(content/modelId/status) 与 `revealedModels[]`(publicName/organization/provider)，**没有 usage / cost 字段**（见 `Arena-Battle-Recon-Notes.md`） |
| 聊天流 | `a0:/b0:` 文本增量 + `bd finishReason`，无 usage |
| 第三方镜像 | `github.com/oolong-tea-2026/arena-ai-leaderboards` 明确写着「**Arena AI doesn't provide a public API**」，靠每日爬 SSR 快照；其 REST 中转 `api.wulong.dev` 目前被限流 |

结论：Arena 把成本**算在服务端**（否则发不了 Pareto 榜），但**不下发到网页版客户端**。所以网页版探针拿不到「这次请求花了多少钱」。

---

## 3. 真正有「每次请求成本」的地方：Arena API 网关

- 文档：`https://portal.api.preview.arena.ai/docs`（preview）
- 网关根：`https://api.preview.arena.ai`，OpenAI/Anthropic 兼容
  - OpenAI 兼容：`https://api.preview.arena.ai/v1`，走 `/v1/chat/completions`
  - Anthropic 兼容：`ANTHROPIC_BASE_URL=https://api.preview.arena.ai`，走 `/v1/messages`
- 官方原文：*"route every `/v1/...` call through Arena's **billing, logging, and rate-limit pipeline**"*、*"Usage and spend show up in your **dashboard**"*
- 有 **router**：`coding-router-preview`（隐藏真实模型）；也有 direct model（需组织授权）
- 模型清单：`GET https://api.preview.arena.ai/v1/models`（需 key）—— 已确认含 `gpt-6-astra`、`claude-opus-5-5`、`gpt-6-luna` 等 90+ 个 ID
- 计费：*"direct-model requests are **billed at the listed rates**"*

**这才是「价格接口 + 每次请求」能自洽的地方**：网关按真实模型计费 → 你在 dashboard 看到每次请求的 usage/spend → 对照各模型费率 → 反推 router 选了哪个模型。

---

## 4. 两条可行路线

### 路线 A —— 留在网页版：价格当「旁证 / 先验」（可做，但不是识别主力）
1. 接入 Agent Pareto 成本表（每模型 cost/task p25-p50-p95 + output tokens/task）
2. 在结果里标注候选的成本档位；对「指纹判定 + 成本档位」做一致性检查
3. 嗅探器加抓 `usage`/`cost`/`total_tokens` 等字段 —— **一旦 Arena 哪天开始下发成本，通道自动升级为真·成本识别**
- 价值：中等。**拿不到现场成本时，它只是旁证，不能单独定模型。**
- 风险：低（纯增量，不改现有评分）。

### 路线 B —— 转 API 网关：真·按价格识别（要 Arena API key）
1. 用 `api.preview.arena.ai` 发探针（或直接跑任务）
2. 从 usage/spend 拿每次请求的 token 与成本
3. 用「成本 ÷ 费率表」反推模型（并可与数字指纹交叉验证）
- 价值：高（这是唯一能按价格真正识别模型的路径）。
- 前提：**需要你在 Arena 开通 API key / 组织授权**，且是另一套产品，不是现在的网页版探针。

---

## 5. 需要你确认的两件事

1. **你听到的「价格接口」指的是哪个？**
   - 网页版榜单上的 cost/task 数据 → 走路线 A
   - Arena API 网关的 usage/spend → 走路线 B
2. **网页版到底会不会下发成本？**（30 秒可验证）
   在 arena.ai 打开 DevTools → Network → 发一条消息，然后在请求/响应里搜这几个词：
   `usage`、`cost`、`totalCost`、`priceUsd`、`prompt_tokens`、`completion_tokens`、`credits`
   - 搜不到 → 路线 A 只能当旁证（现状）
   - 搜得到 → 立刻就能做真·成本识别，我可以把字段接进探针

---

### 参考
- Pareto 榜：https://arena.ai/leaderboard/agent/pareto
- 方法论博客：https://arena.ai/blog/agent-categories-and-cost
- API 网关文档：https://portal.api.preview.arena.ai/docs
- 第三方镜像：https://github.com/oolong-tea-2026/arena-ai-leaderboards
