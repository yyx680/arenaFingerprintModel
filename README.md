# Arena Model Probe 2.19.10　·　由 Vodka 制作

独立的 Chrome / Edge Manifest V3 扩展，不依赖 Arena Trace Inspector、Trigger.dev trace 或旧部署 Cookie。它用数字指纹识别 Arena Agent 当前会话背后的模型：可以单轮探测，也可以连续自动抽卡；同时显示 Arena 每日额度剩余。

## 功能

在 `https://arena.ai/agent` 页面中自动完成数字指纹探测：

1. 自动把 ModelTrace 数字提示写入当前 Agent 对话；
2. 自动点击 Arena 的 Send message；
3. 等待回复完成；
4. 识别“此任务成功了吗？”对话框并自动点击“继续工作”；
5. 从本轮新增的对话渲染内容中只提取 `1..355` 数字序列；
6. 在扩展后台本机运行 Hellinger + 有序分块指纹评分；
7. 直接显示最近候选、清晰匹配／同族近似／弱匹配、拟合度、分离度和模型家族权重；
8. 得到候选结果后，通过 Arena 页面自己的菜单把当前会话标签重命名为模型名。

**发送时不再弹出确认。**点击「发送第 N 条」「连续探测至 3 条」或「开始抽卡」本身即视为授权发送。扩展不会在没有点击的情况下后台定时发送。

## 浮层布局（v2.19.1）

浮层**按住标题栏可拖动**（位置会记住，重开仍在原处；始终至少留 40px 在视口内，拖出屏幕也能找回来）。

浮层顶部是**页签**，三个面板共用一块滚动区：

| 页签 | 内容 |
| --- | --- |
| **数字指纹** | 探针进度、数字通道结果、抽卡、额度（原有一切实心功能） |
| **价格指纹** | 价格指纹裁决结果 + **消费级明细表**（数字通道结论一并显示，两者不互相顶替） |
| **花费** | 花费账本（汇总 + 逐条明细） |

页签带「有新结果」小圆点；选择会记住，重开浮层仍停在原页签。

**消费级明细表**（价格指纹面板内，数据来自官方 `/cost` 账单的 `actual` 子对象）六列：`#` / Input / Output / Cache写 / Cache读 / 合计。表尾一行合计，前四格各列为四项分项求和。只有带四项分项的**官方行**进这张表（转录估算行不进，避免两种口径混在一起）；没有分项数据时显示空态提示。

**未唯一定名时会列出候选**（v2.19.3）：报「N 个模型里 M 个能整除」并逐条列候选名与反推 token、软判据最贴近者与第二名、同价等价类、费率不全的变体数 —— 让你看到「切不开」具体卡在哪，而不是只有一句结论。唯一定名时该列表自动收起。

**首次打开不会空白**（v2.19.4）：浮层建好后立即点亮默认页签（数字指纹）。此前只有读到上次选择的页签时才点亮，导致全新安装时三个面板都不显示、只剩一排页签。

**价格指纹只在真正贴合时才定名**（v2.19.5）：贴合窗口是**比值 ±10%**（此前因 z 刻度写错，实际放宽到 −43%~+74%，会把「目录里最接近的」误当成「同一个模型」）。并且会**真的数一遍**窗口里有几个模型 —— 只有恰好一个才允许定名，否则如实说「不能唯一定名」并列出候选。

**价格目录不再只限 Arena 榜单**（v2.19.6）：新增 OpenRouter 公开价目补充表（339 行，模型本体含 in/out/cache），合并后单价表 208 → **547 行**；全库价格裁决的候选池也从「指纹库 21 个模型」改为**整张单价表**。实测能认出 Arena 榜单之外的模型（如 `deepseek/deepseek-v4-flash-vision-exp`）。**只加不覆盖** —— Arena 已有的 model_key 一律以 Arena 为准。

**轨迹直读**不再作为独立卡片展示，已并入「数字指纹」面板底部。

## 识别模式（v2.1.0）

- **快速模式 · 随机 1 题**：从三道数字题里随机抽一道发送，一条回复就出结果。最快，但证据少 —— WhatsMyLLM 方法论指出单条回复偶有例外，官方推荐三条。
- **精准模式 · 3 题全问**：依次问完全部三道题（297 / 315 / 331 个数字），用三条回复一起判定。更稳，耗时更长。
- **再补 1 题**：快速模式出结果后，可以继续把没问过的题目一条一条补齐（最多 3 题），逐步加强证据再判定。
- 三个按钮点击即发送（不再二次确认）；每一条都会自动点“继续工作”、提取数字、本机评分，并在本轮结束后自动重命名当前会话。
- **自动抽卡（v2.0.0 新增）**：按设定轮数循环执行 —— 点击侧栏 New Chat → 确认 Agent Mode → 发送探针 → 等待回复并点“继续工作” → 本机评分 → 把该会话重命名为模型名 → 进入下一轮。
  - 轮数 1–100；「识别模式」决定每轮问几道题（快速=随机 1 题；精准=3 题全问）。
  - 每轮发探针前先随机问一道数学题（`+` / `-` / `×`，crypto 随机、每轮不同）过人机验证；「拦截 thinking」开关（默认关闭）开启后检测到 thinking 立即截断，自动删除该轮对话并进入下一轮。
  - 数字数量一达标即收工：生成结束就立刻评分，仍在生成则点「停止生成」截掉尾巴；「自动补题」（默认开启）在判定不是「清晰匹配」时自动补发剩余探针（最多 3 题），兼顾速度与准确率。
  - thinking 截断后的清理会先等生成停下，再走侧栏菜单「归档（Archive）」；失败只在该轮标注原因，不做后台重试。
  - 多条证据会做「池化评分」：合并成更大的分布再算一次余弦（与逐条平均各占一半），结果里显示证据数字总数与池化标记。
  - 同一轮里连续发送多条探针时仍留在同一个新聊天内（Arena 无法保证新聊天抽到同一匿名模型，多探针只是提高一次识别的证据量）。
  - 每轮结束自动改名；失败轮会被记录并跳过，连续 3 轮失败或遇到致命情况（草稿、离开页面、切换会话、点击停止）立即停止。
  - 设置（轮数、识别模式、额度下限）保存在 `chrome.storage.local` 的 `amp.draw.prefs.v3`，刷新页面后仍生效（自动迁移旧版 v2 设置）。
  - 面板与弹窗都有「自检（只检查，不发送）」：一次性检查页面结构（Agent Mode、输入框、发送键、New Chat 入口、侧栏展开键、当前会话可重命名）与额度接口，**不发消息、不消耗额度**，用于真机排错。

## 每日额度（v2.0.0 新增）

- 读取 `GET https://arena.ai/api/me/pulse`：返回 `{pulse: 剩余百分比, refreshedAt: 下次重置时间}`。
- 后台优先读取；如果后台请求失败，浮层会用页面自身的同源请求兜底。
- 浮层与弹窗都显示剩余百分比，可点「刷新额度」强制重读（正常缓存 60 秒）。
- 「额度下限%」大于 0 时，抽卡会在开始前与每轮之间检查额度，低于阈值就停止（该轮不发送）。
- `pulse` 是百分比而不是 credits，因此不做任何美元换算。

## 价格通道（v2.10.0 新增）

Arena 公开了每个模型的**任务成本**：Agent Pareto 榜（`https://arena.ai/leaderboard/agent/pareto`）给出「近 14 天任务中位成本」`$X.XX/task`，口径见官方博客（真实 Agent Mode 会话的 token 用量 × 模型定价；每会话只统计前 3 个任务）。本扩展把这套数据接进来当**旁证**：

- 随包快照 `arena-cost-table.json`（覆盖指纹库 10 个模型；同一模型的不同 effort 档成本差很大，逐档保留），纯函数模块 `price-channel.js`。
- 识别结果里显示候选的成本档位：`成本 $0.07/task（便宜）`。
- 嗅探器**只读**抓取页面响应里的 `cost` / `total_tokens` / `prompt_tokens` / `completion_tokens` 等字段。
- 自检新增两行：成本表是否加载、页面有没有下发成本/用量字段（不发消息、不耗额度）。

**重要限制（别当成 bug）**：网页版 Agent Mode **不下发每次请求的美元成本**（只有 `/api/me/pulse` 的额度百分比），所以**在网页版无法只靠价格反推模型** —— 成本在这里只是旁证与排序参考，`status`/`nearest` 仍由数字指纹决定。一旦嗅探器抓到现场成本，扩展会自动做「成本一致性核对」（把候选按成本似然重排并与指纹第一名对照）。

### 路线 B：走 API 网关做真·按成本识别

真正能拿到「每次请求成本」的是 Arena 的 API 网关 `https://api.preview.arena.ai`（OpenAI/Anthropic 兼容，请求走官方 billing/logging 管线，router 会隐藏真实模型）。仓库提供 `tools/arena-gateway-cost.mjs`：

```bash
ARENA_API_KEY=<你的 Arena key> node tools/arena-gateway-cost.mjs --list
ARENA_API_KEY=<你的 Arena key> node tools/arena-gateway-cost.mjs --model coding-router-preview
```

它会列模型、发一条探针、读回 `usage`/成本字段，并按 `tools/arena-rate-table.json` 的费率用对数似然反推模型。费率默认留空（需从 dashboard 的 listed rates 抄一次），留空时只打印用量与成本字段。

完整调研（含成本表快照与证据链）见 `Arena价格接口调研.md`。

## 用量通道（v2.11.0 新增）

用 CDP 直连调试实例**真发了一条消息**做了实测（完整证据链见 `Arena成本接口实测.md`），结论很干脆：

- **Arena 会下发 token 用量**：`GET /api/evaluation/<sid>` 的 `messages[].metadata.usage` 带
  `inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`，
  与 `status: success` 同时落地（实测约 10 秒结算），**揭晓前就能拿到**（`modelId` 仍为 `null`）。
- **Arena 不下发美元成本**：`metadata.cost` 恒为 `null`；`/api/evaluation/<sid>/cost` 路由存在但（未过灰度门时）返回 `403 Unauthorized`（v2.16.0 起可经 PostHog 覆写 cookie 放行，见「另一半按账号灰度」节）。
  美元价由前端 `useCostContext` 按「token × 单价」自己算（`basePriceUsd` / `totalChargedUsd` / `CREDITS_PER_USD`）。
- `/api/me/pulse` 是**每日额度百分比**，发消息前后都是 100 —— 与单次成本无关；真正的「扣费」是**限速窗口**（实测 `10 prompt / 5 分钟`，发一条 `remaining` 10 → 9）。

于是新增一条只读证据通道（`usage-channel.js`）：

- 嗅探器把整个 `usage` 对象抽出来（花括号配对解析，含转义/流式兜底；camelCase 与 snake_case 都认）。
- 浮层与自检显示**最近一次 / 累计**用量，以及**形态签名**：
  - `cw` = 有 `cacheWriteTokens`（只在支持 prompt caching 写入的厂商出现，实测同一局 A/B 都有、另一局没有 → 按 provider 变化）；
  - `cr` = 有 `cacheReadTokens`；`rz` = 有 `reasoningTokens`（推理模型直接标记）。
- **只报 token，绝不折算美元** —— 没有单价表就不猜价（`estimateCostUsd` 缺费率时返回 `null`）。

自检里现在是三行：`本账号能否读成本（/cost）`、`页面下发的成本/用量字段`、`页面下发的 token 用量`（发过消息就该有）。

## 单价通道（v2.12.0 新增）—— 「按价格反推模型」到底怎么做

「用价格判断是哪个模型」这个说法是对的，而且方法能拆成两半，**一半已经拿到，另一半卡在账号灰度上**。

### 一半是公开的：token 单价

榜单 RSC（`https://arena.ai/leaderboard`）每行都带 `inputPricePerMillion` / `outputPricePerMillion`，单位是 **USD / 百万 token**。
抓下来存成随包快照 `arena-pricing-table.json`：**208 行**，其中：

- **193 个文本模型**可参与反推；
- **15 个图像/视频模型**（`gpt-image-*` 只有输入价、`sora-*` / `veo-*` / `imagen-*` 只有输出价）单价单位其实是**按张/秒**，
  标为 `kind='media'` 并**排除出反推** —— 混进去会把推理带偏。

于是「期望成本」可算：

```
期望成本(模型) = Σ tokensᵢ / 1e6 × priceᵢ(模型)
```

### 另一半按账号灰度：真实按次成本（v2.13.1 已补全字段 + 实测倍率）

从 bundle 里挖出前端确实在调这三个路由：

```
GET /api/chat/:id/cost?includeSession=true                          # Agent 会话
GET /api/chat/:id/cost?includeSession=false&messageIds=a,b,c        # 单条，≤50 个 id
GET /api/evaluation/:id/cost                                        # Battle 会话
→ {session:{actualTotalUsd, chargedTotalUsd, basePriceUsd, costMultiplier, marginMultiplier, messageCount},
   messages:{[messageId]:{actual:{totalCostUsd, basePriceUsd, ...}}}}
```

**本机账号**（免费档）对全部 40 个会话一律 `403 {"error":"Unauthorized"}`。这不是鉴权问题：该账号的 Supabase JWT Bearer 能正常鉴权 `/api/me`（200），
cost 路由照样 403；根因是账号级功能门（PostHog flag `credit-system-m1` / `credit-system-m2` 存在但值为 `"undefined"`）。
对比错误串就能区分：`Route not allowed` = 路由不存在，`Unauthorized` = 路由存在、门没过。
客户端 flag 覆写无效（`posthog.featureFlags.override(...)` 后仍 403）→ **门在服务端**。

**但 v2.16.0 起，门可以过**：服务端读的是 **PostHog feature-flag override cookie** `ph-toolbar-overrides`——
客户端临时写 `ph-toolbar-overrides=<urlencode({"credit-system-m1":"cost-shown"})>`（`Path=/; Max-Age=60; SameSite=Lax; Secure`）即放行（真机 A/B：无 cookie 403 / 带 cookie **200 完整账单** / 删 cookie 回到 403）。
扩展现在用**礼貌策略**走这条路：用户已有该 cookie 且值不同 → 不覆盖、不发请求（网站自己的设置赢）；值相同 → 直接用、读完不删；原本没有 → 临时写、读完必删并校验，删不掉就把结果标 `cookie-stuck` 当无数据处理。403 分型：24B `Unauthorized` = 门禁未过；78B `User does not own session "<sid>"` = 门过了但会话不归当前账号。

**但已开通计费的账号能拿到**（用户截图实锤，底部成本条原文）：

```
$23.18767300 cost | $1.06317612 base | $2.12635223 charged
```

两条硬关系（可验算）：

| 关系 | 验算 |
|---|---|
| **实扣 = base × 2** | `2.12635223 / 1.06317612 = 2.0000000`（即 bundle 里的 `marginMultiplier`） |
| 积分口径自洽 | `totalChargedCredits = 2126.35223`，`÷ CREDITS_PER_USD(1000) = $2.126352` ✓ |

→ **按价反推必须用 `base`**，它才与「Σ token × 公开单价」同口径；`charged` 被 ×2 污染，直接拿来比会整体偏移一倍。

> ⚠️ v2.13.1 修了一个真 bug（影响面要说准）：嗅探器的成本字段表**漏掉了会话级聚合的真实字段名**
> （`actualTotalUsd` / `chargedTotalUsd` / `costMultiplier` / `marginMultiplier` / `totalChargedCredits` / 9 个分项 `*CostUsd`）。
> 结构化解析路径本来能从 `session.actualTotalUsd` 拿到 base，但它**硬依赖 `JSON.parse`**；
> 响应被流式切碎/被包装导致解析失败时只剩正则兜底 —— 而旧表在那条路径上只能兜到 base，
> **实扣价与加价倍率永远拿不到**。现已按 bundle 的 zod schema 补全。

### 拿到真实成本之后怎么反推

`observed / expected` 比值最接近 1 的模型就是它（比值取对数后做高斯核加权）。候选可以是指纹库基础 id，
也可以是 Arena 变体 key —— 两边命名不一样，扩展会自动归一化：

- 指纹库用基础名 `gpt-6-astra`，Arena 用变体名 `gpt-6-astra-max-agent`；规则是「基础名是变体名的前缀且后缀从 `-` 开始」。
- **点号版本号**：指纹库 `claude-opus-5-5` ↔ Arena `claude-opus-5.5`。**不能**把点号也粗暴换成短横，否则 `claude-opus-5` 会吞掉 `claude-opus-5.5-*`。
- **前缀吞并**：`claude-sonnet-5` 是 `claude-sonnet-5-5-xhigh` 的前缀 → 用「前缀后第一个 token 是裸数字则不算命中」消歧（`-20260517` 这类日期后缀不受影响）。

### 没拿到真实成本时也有用

浮层会报**价格区分度**：候选的期望成本区间跨度，以及 `separable`（所有候选区间两两不重叠时，单靠价格才能唯一确定模型）。
切不开就直说「价格不可区分」，不硬猜。

自检里新增 `单价通道（token 单价表）` 与 `指纹库 id → Arena 变体 key` 两行。

### 花费账本：不需要计费账号也能算（v2.13.2）

**问题**：网页版对多数账号不下发真实成本（`/cost` 403；v2.16.0 起可经覆写 cookie 放行灰度门），「这次花了多少钱」看起来无解。

**答案**：`base` 是可算的。每条消息的真实 token 用量是**下发**的（`GET /api/evaluation/<sid>` 的 `messages[].metadata.usage`），
公开 token 单价也是**下发**的（榜单页）——两者相乘就是基准价，与 Arena 界面上的 `base` 同口径：

```
base(消息) = Σ tokensᵢ / 1e6 × 单价ᵢ(模型)      ← cost-ledger.js
```

新增模块 `cost-ledger.js` 把它摊成逐条明细（`buildLedger` / `buildLedgerRow` / `ledgerTotals`），
浮层与弹窗各渲染一张「花费」卡片：摘要一行 + `明细 ▸` 展开逐条（`#N · messageId8 · 模型 · Nt · $base`）。
有计费账号时用页面下发的 `实扣 / ×倍率 / 积分` 逐条覆盖。

两个附带的判断辅助：

- **同价筛选** `samePriceGroups(ids, table)` —— 按「价格签名」（全部变体的 (输入价, 输出价) 集合）分组；签名相同的候选**单靠价格区分不开**，界面直说「同价候选（价格区分不开）：A / B」，提示必须靠指纹或人工消歧。
- **token 比例** `tokenRatioText(usage)` —— `输出:缓存写:缓存读`（归一到最小项 = 1），快速看出该模型的用量形态。

> 这一版还修了一个真 bug：`scanCostRoute` / `scanMessageUsage` 的触发判据写成 `/response|eventsource/`，
> 而 fetch 响应的 `where` 是 `'fetch.body'` / `'fetch.stream'`（**不含 "response"**）→ 结构化解析**从未触发过**。
> 已改为 `!/request/i.test(where)`。

#### ⚠️ Agent 模式拿不到花费（v2.13.5 实测结论）

账本对 **Battle** 有效，对 **Agent 必然为空** —— 这不是 bug，是平台不给数据。CDP 实测证据：

| # | 事实 | 证据 |
|---|---|---|
| 1 | Agent 会话包**没有 usage 字段** | `GET /api/chat/<sid>` 的 `messages[].metadata` 只有 `manifestNodeId / nodeId / pending / requiresReview / feedback`；session 顶层 14 个字段（`id / taskId / triggerAddress / messages / pagination / publicAccessToken / lastEventId / productMode / feedbackType / customFeedbackArm / connectorsEnabled / arenaFeedbackEnabled / rubricsEnabled / pinnedModel`）也没有 usage / cost |
| 2 | Battle **有** usage | `GET /api/evaluation/<sid>` 的 `messages[].metadata.usage` = `{inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, usageSource}` |
| 3 | Agent 的成本路由是**账号权益门**，不是鉴权/请求头问题 | `GET /api/chat/:id/cost?includeSession=true` → **403 `{"error":"Unauthorized"}`**；而**不存在**的路由返回 `{"error":"Route not allowed"}`（→ 路由确实存在，服务端主动拒）。**与请求头无关**：11 种组合（cookie-only / 真 Supabase Bearer JWT / `x-arena-request-caller: web-ssr-public` / `x-arena-expected-api-deployment` / `x-arena-web-deployment` / reCAPTCHA 换来的 `x-api-waf-token` / referer+origin）**全部 403** |
| 4 | 实时流是**明文 SSE**，但**不含 usage** | `/ai-proxy/realtime/v1/sessions/<sid>/out` 其实是标准 SSE（`event: batch` + `data: {"records":[{seq_num, timestamp, body}]}`），`body` 是 **AI SDK v5 UI 事件**的 JSON 字符串。完整事件类型：`start / start-step / reasoning-start / reasoning-delta ×N / reasoning-end / text-start / text-delta ×N / text-end / finish-step / finish`；但 `finish-step` = `{"type":"finish-step"}`、`finish` 只有 `messageMetadata{nodeId,…,timing}` —— **Arena 把 AI SDK 的 usage 剥掉了**（此前误判为"二进制帧"，实为读取姿势不对） |
| 5 | 反爬栈存在，但**不拦 `/cost`** | Cloudflare（`cf_clearance` / `__cf_bm`）+ reCAPTCHA Enterprise v3（`grecaptcha.enterprise.execute` → `recaptchaV3Token`，用于 mutation）+ 常量 `x-api-waf-token` / `x-arena-request-caller` / `x-arena-*-deployment`。这些**都过了**，403 依旧 → 「反爬机制」不是这条门的原因 |
| 6 | canary 与 prod 是**两套账号库** | 同一 cookie 打 `https://arena.ai/api/me` → **401 `{"message":"User not found"}`**（canary 同路径是 200），所以无法在生产站复现 |

→ 所以 `2.13.4` 起账本**主动探测 `/cost`**，`2.13.5` 把「靠请求头/绕过反爬能开」这条假设实测否证：一旦账号开通计费，`200` 的响应会被直接摊成逐条明细（`ledgerRowsFromCostMessages`，无需 token 用量）；`403` 时浮层/弹窗直说原因，不再写「发一条消息后才有」这种误导文案。
→ `2.16.0` 更新：403 **不是终局**——灰度门可经 PostHog 覆写 cookie 放行（见上一节）。拿到 `200` 后，账单经 `cleanOfficialCost` 白名单清洗进 `netState.officialCost`：`observedCostActual` 官方优先、`ledgerBlock` 弹窗路径回落官方明细、`ledgerSummarySync` 官方优先，返回体带 `official:{at,path,messages}` 标记来源。三层语义分开报：`actual`（上游） / `base`（Arena 计价） / `charged`（= base × `marginMultiplier`，实测 2），`describeTotals` 在 actual ≠ base 时增报「上游成本合计」。

#### 备选口径：转录字数估算（v2.14.0 起，v2.15.0 真正跑通）

精确金额拿不到时，账本退到**唯一不依赖任何特权的口径**：把转录里 assistant 生成的文字（正文 + 思考）数字符，按字形系数折成 token 估算（`ESTIMATE_METHOD='chars-v1'`：CJK ≈1 token/字、其余 ≈0.27 token/字符），行标 `source:'transcript-estimate'`。

- **能给你**：逐条消息的**估算输出 token**（实测一条 assistant 约 7936 token）、用户那条消息的**输入下界**（只含用户文字，不含历史上下文与系统提示），以及 —— **一旦指纹识别出唯一模型 —— 由「估算 token × 该模型公开单价」折出的基准价金额**。
- **金额从哪来**：Agent 会话本身**不下发模型**（消息无 `modelId`、`pinnedModel:null`、**页面 DOM 里也没有任何模型名**）。所以金额的唯一来源是**本扩展自己的指纹识别结果**：识别结论为 `clear` 且候选集唯一时，`result.nearest.id` 会被带进账本折价。**没识别出模型就只报 token，绝不猜价。**
  - 实测（同一份真实转录，7936 输出 token）：不传模型 → `base: null`，摘要为 `1 条（估算） · 输出约 7936 token · 输入下界约 421 token · 1 条无单价`；识别为 `claude-sonnet-5` → **`base $0.07936`**；识别为 `gpt-6-astra` → **`base $0.3968`**。

**v2.15.0 的关键修复：让这条通道在真实页面上真的产出证据。** v2.14.0 虽然把解析链路做全了，但在真机页面上 `transcriptEstimates` 恒为 `[]` —— 因为 **Agent 页自身的 `/api/chat/<sid>` 请求走 Web Worker / RSC，主线程的 `fetch`/`XHR` 钩子看不到**（嗅探器旧注释里其实早就写了「已确认 Arena 的聊天请求从 Web Worker 发出」，但转录这条支路没绕开它）。

修法是**主动取转录**（`network-sniffer.js` 文末）：会话页（`/agent/<sid>`、`/battle/<sid>`）里由页面上下文**同源 GET 一次 `/api/chat/<sid>`**（页面自己就是这么取的，只读、不改任何东西），拿到的响应体交给与被动路径**完全相同**的解析函数 —— 有 `metadata.usage` 就用用量，没有就按字数估 token。触发点：初始加载、SPA 路由变化（包 `pushState`/`replaceState` + `popstate`）、实时流结束（新回复落库后）。节流 2.5 s、每页上限 60 次。

实测（Chrome 154 CDP 直连 `canary.arena.ai/agent/…`）端到端输出：

```
mode : estimate
text : 1 条（估算） · 输出约 7936 token · 输入下界约 421 token · 1 条无单价
rows : #1 01a12ca2 role=assistant tokens=7936 est.input_lower=421
```

同版另修两处：① `scanMessageUsage` 的 usage 判据从「整串含 `"usage"` 字样」改成「**实际消息**有 `metadata.usage`」（会话包里别的字段带 usage 一词时会走错分支、静默产不出东西）；② 摘要里补上「输入下界约 M token」。

> ⚠️ 该通道会向 Arena 发起一次同源 GET（会话包，约 15 KB）。这是**主动请求**，与扩展其余部分的纯被动嗅探不同；若你不希望它发请求，删掉 `network-sniffer.js` 文末的「v2.15.0 主动取转录」整段即可（此时退回 v2.14.0 的被动行为：Agent 页面产不出证据）。

#### 用花费反推模型（v2.16.1，Agent 模式专用腿）

按价反推（v2.13.3）需要 Battle 模式的服务端逐条 token 用量；Agent 会话没有用量，那条腿在 Agent 模式永远待命。v2.16.1 把**两条已经到手的真实数据**接上：官方逐条 `base` 金额（v2.16.0 的 `/cost` 通道）× **同一条消息**的转录估算 token。

- **地基（CDP 实测）**：`/cost` messages 的 key 与 `/api/chat/<sid>` 会话包 assistant 消息 id 是**同一套 UUID** —— 5/5 完全对齐（`dev-scratch/_cdp-id-align.mjs`）。id 对不上就不开工。
- **算法**：每条消息的隐含单价 = 官方 `basePriceUsd` ÷ 该消息估算 token；汇总 Σbase 与 Σtokens 喂给既有的 `rankByObservedCost`（比值取对数高斯核）对指纹库**全量**排序。`cost-ledger.js:pairCostWithEstimates` 负责配对（落单如实报告），`background.js:costReverseBlock` 出排序与同价歧义标注。
- **入口**：`ledgerBlock` 返回体新增 `cost_reverse`；另有 `AMP_COST_REVERSE` 消息类型可直接拉取。
- **待命三态**：`no-official-cost`（门没过 / 没账单，附 costGate 状态）→ `no-pairs`（账单与估算不是同一会话，附两侧落单数）→ `no-priced`（候选没有公开单价）。
- **honest 口径**：金额是服务端权威值，token 是估算 —— 输出一律声明「可能性排序，不是定论」；同价等价类直说 `ambiguous`。**本通道绝不单独定名**（要定名见下一节的价格指纹）。

#### 价格指纹：识别模式里的第三项（v2.18.0）

**价格指纹**是本扩展的第三种识别模式（与「快速 / 精准」并列）：**只靠价格**识别模型。发 1 道探针 → 拿官方 `/cost` 账单与转录估算 token → 在**全库**模型里按价格裁决 → 唯一切得开才定名，切不开如实说不确定。

- **怎么用**：浮层/弹窗的「识别模式」下拉选「价格指纹 · 1题按价反推」，或点浮层的「价格识别 · 1题按价」按钮。只发 1 题、不自动补题（省额度、快）。
- **全库裁决（v2.18.0 与 v2.17.0 的关键区别）**：v2.17.0 是「数字候选集内」裁决（`nearest`+`top3`，候选少但可能一起错）；本版价格模式**不借数字候选集**，直接在全部指纹库模型里比价（`background.js:priceFingerprintBlock` 的 `options.fullBank`，返回体带 `scope:'full-bank'`）。
- **定名判据（三条同时满足才允许，全库路径同样不松）**：① 唯一命中且比值贴合（`|log₂ratio| ≤ 0.8`）；② 第二名明显更远（z 差 > 0.35）；③ 命中**不与任何其他候选同价**。任何一条不满足都 `separable:false` + `reason` 说明卡在哪。
- **绝不退回数字结果顶名**：价格模式下定名只看价格；价格切不开时**不改名**并如实说明（数字识别的结论只作旁证记录）。价格分支**不依赖数字打分**（位置在 `lastResult` 判空之前）——数字通道没过门控也能按价定名，因为价格数据来自会话账单而非数字结果。
- **诚实边界**：金额是 Arena `/cost` 官方 base（临时覆写 PostHog cookie，读完即删），token 是转录估算 —— 所以结论是「**价格上唯一**」，不是服务端确认。全库贴合概率更高，所以门槛刻意从严：宁可不定名，也不猜。
- **两种入口的分工**：① **价格指纹模式**（本版新增）= 全库裁决、可单独定名；② 弹窗里的「**价格旁证（快速/精准）**」勾选框（v2.17.0 的旁证通道保留）= 只在快速/精准模式下、数字判定不清晰时按候选集加挂价格证据。浮层原来那个独立勾选框已移除（上移为识别模式，避免一处功能两个开关）。
- **真机实测（CDP 9222，会话 `01a12c2a`，5 条消息）**：真实账单 5 条 ↔ 转录估算 5 条 100% 配对（`costOnly=0`），Σbase $0.001693732 = session 聚合值；隐含 **$0.893/Mtok**。候选 ≥2 时最近邻 `gpt-5.6-luna`（z=0.427）与第二名 `gpt-6-luna`（z=0.836）差 0.409 > 0.35 → 稳定出 `separable`。
- **单候选也走同一闸门**：只有一个候选时**没有第二名**，但判据不放行 —— 比值不贴合照样降级。这是真机暴露、单测补上的边界（避免「只有一个候选」变成伪置信）。
- **口径局限（如实记录）**：Agent 会话包不含输入侧 token，估算只覆盖 assistant 正文+thinking → 估算 token 是**下界**，隐含单价偏低。补输入侧（3×/8×）后判据结论不变，说明对该偏差不敏感；但偏差本身存在，不假装没有。

#### 硬筛选 + 缓存费率补充（v2.19.0）

价格指纹在 v2.19.0 加了一条**硬筛选腿**，并补齐了它需要的 cache 费率。

- **缓存费率补充表（`arena-cache-rates.json`）**：Arena 榜单**不下发 cache 读写费率**（208 行实测恒 `null`）。本版从 **OpenRouter 公开价目**（`https://openrouter.ai/api/v1/models`）逐条匹配补齐：**三重约束**（名称核心词 + `input ±0.02`/`output ±0.05` 价格容差 + 排除 `~` 别名）→ **126 / 208（60.6%）命中，全部 cache 一致（零分歧）**，其中 8 条取自 `:batch` 半价条目（已标注）。**未命中的保持 `null`，绝不外推。** 抽查 25 个模型，17 个 Arena 榜单价与 OpenRouter 挂牌价比值正好 1.0。
  - 合并层 `applyCacheRates`（`pricing-channel.js`）**只补不覆盖**（官方优先），逐条标 `cache_rate_source`；读不到补充表就退回原表，**不让整条价格通道瘫痪**（`background.js:loadCacheRates`）。
- **四项整数反推硬筛选**：把 `/cost` 账单的四项分项费用（input/output/cacheWrite/cacheRead）按各模型单价反推 token 数，**要求正整数** —— 能整除的模型才留（借鉴参考扩展 `cost-browser-extension` 的 `constrainByPrices`）。函数 `hardFilterByCosts` 返回五态：`unique` / `multiple` / `none` / `partial-only`（费率不全）/ `off-integer-grid`（账单不自洽）。媒体模型（按张计价）显式剔除。
- **硬筛选不能单独定名（关键设计）**：实测会话真身是 `GPT 5.6 Luna`，但它的 out 费率 1.2 反推 605.87（非整数）被淘汰，反而是 `qwen3.7-plus` 的 1.28 反推 568.00（恰整除）→ **误判**。根因：Arena 实际计费口径与 OpenRouter 挂牌价存在差值，硬筛选本质是「找哪个模型的费率表恰好能整除账单」。随机化检验（扰动 read 费用 ±20% 跑 200 次 → 候选恒为 0）证明整除是**真实约束**但**极度脆弱**。
- **交叉验证（`evidence`）**：硬筛选与软判据（log 比值）**都成立且同指一个模型** → `both`（高置信定名）；**分歧** → `conflict` + **`separable:false`**（绝不凭硬筛选推翻软判据，如实列出两个分歧模型）；软判据切不开但硬筛选唯一 → `hard-hint`（仅旁证）。原价格模式的三条判据**一条不松**。
- **披露**：浮层附注输出硬筛选结果、`:batch` 警告、`evidence` 解读、cache 费率来源，以及「**汇总成本可能包含多次调用，单次调用口径未验证**」。
- **同价组升级为四项签名**：`samePriceGroups` 从 `(input, output)` 升级为四项（缓存写/读也纳入），缺费率记 `'—'` 不与 0 混淆 —— 同价等价类判定更准。


### 站点覆盖：生产 + canary（v2.15.0）

扩展此前只匹配 `https://arena.ai/*`，导致在 **`canary.arena.ai`（预发布域，登录态/新功能常先在那边）上完全不注入**。2.15.0 起 manifest、后台来源校验（`isAgentUrl`）、`content.js` 的 `agentPage()`、`popup.js`、`conversation-rename.js` 全部改为接受 `https://arena.ai` 与 `https://canary.arena.ai` 两个 origin（统一用 `/^https:\/\/(?:canary\.)?arena\.ai$/`）。**这是一次权限扩张**：扩展现在也会在 canary 域注入。

## 回复结束与自动重命名

- 每条数字回复结束后，扩展会识别可见的“此任务成功了吗？”反馈区域；它兼容真正的 `dialog` / `alertdialog`，也兼容 Arena 当前使用的普通页面卡片。扩展只点击与该问题位于同一 UI 区域、且可访问名称或文本匹配“继续工作”的唯一控件；问题存在但按钮不明确时停止后续探针。
- 单条模式在本次评分完成后重命名；连续模式在全部剩余探针完成并得到最终结果后重命名；抽卡在每一轮识别完成后立刻重命名该轮会话。
- `清晰匹配` 和 `同族近似` 使用模型显示名；如果最终状态是 `弱匹配`，会在会话名末尾追加一个 ASCII 问号，例如 `GPT-6 Astra?`，用于提示身份不确定。
- 重命名只操作当前会话对应的 Arena 侧栏标签。扩展会按需展开侧栏，通过 Arena 的可见菜单选择“重命名”，填写模型显示名并等待页面确认。
- 重命名失败不会丢失已经得到的探测结果，浮层会显示具体失败原因。

## 安装

1. 解压发布包（或直接使用本文件夹）。
2. 打开 `edge://extensions` 或 `chrome://extensions`。
3. 开启「开发人员模式」。
4. 点击「加载解压缩的扩展」，选择直接包含 `manifest.json` 的 `arena-model-probe-standalone` 文件夹。
5. 刷新已打开的 Arena Agent 页面。

页面右下角会出现独立浮层；工具栏弹窗也有相同控制按钮。

> 升级提示：从 1.1.2 升级只需覆盖文件后在扩展页点「重新加载」。原 1.1.2 文件已备份在 `_backup-1.1.2/`，确认新版可用后可以删除。

## 自动停止条件

下列情况不会发送，或会停止后续探针：

- 当前不是 Agent Mode；
- 输入框已有未发送草稿；
- Arena 正在生成另一条回复（抽卡会先等待，最多 240 秒）；
- 用户切换了聊天或离开 Agent 页面；
- 找不到输入框、发送按钮、New Chat 入口或完整数字回复；
- 抽卡时额度低于设定阈值，或连续 3 轮失败；
- 用户点击「停止」。

失败后不会自动重发同一条。已经成功发送的消息不会撤回，并会正常消耗 Arena 额度、保留在聊天记录中。单条最长等待 10 分钟。

## 评分方法

- 数字范围：`1..355`。
- 提示长度：297、315、331。
- 特征：355 维平滑 Hellinger 分布、四段有序 16 档直方图、末位数字分布、环境干扰方向投影。
- 输入门控：空／常量、九成同向排序、半数固定步长、不同值不足 5%、长度不足请求量 55% 的回复不计分。
- 开放集判断（v2.9.19+ 按每个模型自举标定）：拟合门槛取该模型自举样本的拟合分位（默认 0.15，上限 0.18，硬下限 0.04），低于门槛为弱匹配；分离度 `>= 0.06` 为清晰匹配；分离不足但家族权重 `>= 90%` 时为同族近似。

最近候选不是模型身份证明；未收录模型会被归到最相似候选，库内权重也不是真实身份概率。

## 指纹库与隐私

- 首选读取固定的 WhatsMyLLM `v2026.09.5` 21 模型数据文件并校验 SHA-256。
- 网络或完整性检查失败时，使用扩展内置的 ModelTrace `d4131b3` MIT 17 模型后备库。
- 远程请求只下载指纹 JSON，不上传回复、数字、Cookie、凭据或 referrer。
- 价格表 `arena-cost-table.json` 随包内置、**不联网**；成本信号只从页面自身响应里只读抽取字段名与数值，不落地正文。
- 内容脚本只把提取后的数字数组发给扩展后台，不发送完整聊天正文。
- 数字、评分结果和聊天 ID 只保存在页面／后台内存，刷新后清除；唯一写入磁盘的是自动抽卡的三个设置项（`chrome.storage.local`）。
- 额度读取只携带 arena.ai 自己的登录 Cookie 访问 arena.ai 的接口，不经过任何第三方。

## 权限

- `activeTab`：让工具栏弹窗控制当前 Agent 标签页。
- `storage`：只保存自动抽卡设置（轮数、每条探针数、额度下限）。
- `https://arena.ai/*`：注入页面浮层、自动操作当前 Agent 输入框，并读取 `/api/me/pulse` 额度。

- 可选 `debugger`（v2.9.14+ 受信任点击/键入用，绕过 Arena 对合成事件的过滤）：首次由工具栏弹窗按钮触发授权，未授权时自动退回合成事件。仍**不需要** `cookies` 或 `declarativeNetRequest` 权限。

## 开发验证

```bash
npm test
```

测试覆盖提示一致性、对话数字提取、旧序列排除、输入门控、API 回复解析、重复回复、指纹库结构和 GPT-6 Astra 三回复回归识别。

## 制作与归属

- 本扩展由 **Vodka** 制作（署名同时出现在 `manifest.json` 的 `author`、页面浮层与工具栏弹窗）。
- 指纹题库与判定协议来自 WhatsMyLLM / ModelTrace（见下），本扩展只负责自动化流程与结果展示。

## 第三方来源

ModelTrace 评分核心、提示、内置后备库和测试样本来自 xqy2006/ModelTrace，MIT 许可。额度端点（`/api/me/pulse`）的字段语义与错误处理参考本机 Arena Trace Inspector 2.3.2 的 `billing.js`。详见 `LICENSE-ModelTrace` 与 `THIRD_PARTY_NOTICES.md`。
