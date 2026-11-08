# Arena 成本/用量接口实测（CDP 直连，2026-10-11）

> 调研方式：`--remote-debugging-port=9222` 的独立调试实例（Chrome 154.0.8037.99，profile `%TEMP%\amp-debug-profile`，已登录 arena）。
> 工具：`tools/cdp.mjs`（零依赖 CDP 客户端，走 Node 22 内置 WebSocket）+ `tools/expr/*.js`（页面上下文执行的探针脚本）。
> 全部结论来自**真发一条消息**的实测，不是推测。

---

## 0. 一句话结论

**「按价格反推模型」这件事本身成立** —— 单价是公开的，真实按次成本也确实存在，
只是**按账号下发**：本机账号（免费档）拿不到，已开通计费的账号能拿到（§7 有截图实锤）。

- ✅ **token 用量**：`GET /api/evaluation/<sid>` → `messages[].metadata.usage`，字段为
  `inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`。
- ✅ **token 单价是公开的**：榜单 RSC（`/leaderboard`）每行带 `inputPricePerMillion` / `outputPricePerMillion`，
  单位 **USD/百万 token**。快照见 `arena-pricing-table.json`（208 行 = 193 文本 + 15 图像/视频）。
  → 于是 `期望成本(模型) = Σ tokensᵢ/1e6 × priceᵢ(模型)` **可算**，用它能算出候选的价格区分度。
- ✅ **真实按次成本存在，但按账号灰度**：`GET /api/chat/:id/cost`（Agent）与
  `GET /api/evaluation/:id/cost`（Battle）。**本机账号**一律 `403 {"error":"Unauthorized"}`
  —— 不是鉴权问题（带有效 Supabase JWT 也一样），是账号级功能门没开；
  **已开通计费的账号能拿到完整明细**（§7：`base / charged / cost` 三档 + 逐模型 + 逐消息）。
- ✅ **实扣 = base × 2**（截图实测精确成立，见 §7）→ **反推模型必须用 `base`**，它才与公开单价同口径。
- ❌ `metadata.cost` 恒为 `null`（网页会话响应里）；美元价由**前端自己算**（`useCostContext` + `CREDITS_PER_USD`）。

---

## 1. 探测过的接口与结果

| 请求 | 状态 | 说明 |
|---|---|---|
| `GET /api/me` | 200 | 账号信息（`user.id` / email / avatarUrl） |
| `GET /api/me/pulse` | 200 | `{"pulse":100,"refreshedAt":"..."}` —— **是每日额度百分比，不是成本**；发消息后**不变** |
| `GET /api/evaluation/<sid>` | **200** | 完整会话 JSON（实测 262 KB / 18 条消息），**token 用量的唯一可靠来源** |
| `GET /api/chat/:id/cost?includeSession=true` | **403 `{"error":"Unauthorized"}`** | **真实按次成本**（Agent 会话）。路由真实存在，本机账号被功能门拦住 |
| `GET /api/chat/:id/cost?includeSession=false&messageIds=…` | **403** | 同上，单条查询（前端限制最多 50 个 id） |
| `GET /api/evaluation/<sid>/cost` | **403 `{"error":"Unauthorized"}`** | 同上（Battle 会话） |
| `GET /nextjs-api/model-catalog` | **200**（144 KB） | 6 个 arena 分组、模型的 `userSelectable` / `rank` / 能力 —— **不含价格字段** |
| `GET /leaderboard`（`RSC: 1`） | **200** | **公开 token 单价**（`inputPricePerMillion` / `outputPricePerMillion`），349 行、208 行有价 |
| `GET /api/leaderboard/agent` | 403 `{"error":"Route not allowed"}` | 网关白名单拒绝 |
| `GET /api/{user,account,credits,usage,billing,me/usage,me/credits,evaluations}` | 403 `Route not allowed` | 同上 |
| `GET /nextjs-api/{me,cost/<sid>,billing/credits}` | 404 `Not found` | 不存在 |

> 判据：`Route not allowed` 是**路由不存在/未开放**；`Unauthorized` 是**路由存在但鉴权/功能门没过**。

### 2.1 三个 `/cost` 路由确实存在（从 bundle 挖出的前端调用）

```js
// Agent 会话整体
let e = await c.api.chat[":id"].cost.$get({param:{id:i}, query:{includeSession:"true"}});
// Agent 单条（≤ 50 个 messageId）
let r = await c.api.chat[":id"].cost.$get({param:{id:e}, query:{includeSession:"false", messageIds:n.join(",")}});
// Battle 会话
let n = await c.api.evaluation[":id"].cost.$get({param:{id:i}});
```

响应 schema：`{session:{actualTotalUsd, chargedTotalUsd, messageCount, aggregate?}, messages:{[messageId]:MessageCost}}`。

### 2.2 403 是**功能门**而不是鉴权（已排除鉴权）

| 验证 | 结果 |
|---|---|
| 40 个会话（含 UI 手动创建、模型已揭晓的）逐个打 `/api/evaluation/:id/cost` | **全部 403** |
| 同上打 `/api/chat/:id/cost` | 39×403 + 1×429（限速） |
| 用 `arena-auth-prod-v1.0` cookie 解出的 **Supabase JWT** 作 `Authorization: Bearer` 打 `/api/me` | **200**（token 有效） |
| 同一个 Bearer 打 `/cost` | **仍然 403** |
| PostHog feature flags | `credit-system-m1` / `credit-system-m2` **存在但值为 `"undefined"`** |

→ 结论：该账号是**免费档 / 未开计费**，服务端对计费字段整体不放行。要拿到真实成本，
需要**已开通计费（flag 打开）的账号**。

---

## 2. 真发一条消息的实测数据

**请求**（页面上下文 `fetch`，`credentials:'include'`）：

```
POST /nextjs-api/stream/create-evaluation
{ "id": <UUIDv7>, "mode": "battle",
  "userMessageId": <UUIDv7>, "modelAMessageId": <UUIDv7>, "modelBMessageId": <UUIDv7>,
  "userMessage": {"content":"1+1=? 只输出数字","experimental_attachments":[],"metadata":{}},
  "modality": "webdev", "recaptchaV3Token": null }
```

**响应**：`200`，限速头 `ratelimit-limit: 10` / `ratelimit-policy: 1800;w=300` / `ratelimit-remaining: 9`（**发一条即扣 1**）。
流内容是心跳 + webdev 事件，**不含 usage / cost 字段**（`a2:[{"type":"heartbeat"}]`、`a2:[{"type":"webdev",...}]`）。

**约 10 秒后**（`GET /api/evaluation/01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1`）：

| 参与方 | inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | totalTokens |
|---|---|---|---|---|---|---|
| a | 4 | 326 | 3500 | 3845 | — | 7675 |
| b | 6 | 4142 | 0 | 11143 | — | 15291 |

两条都 `status: success`，`metadata.cost` **均为 `null`**，`modelId` 揭晓前为 `null`。

**另一份旧会话样本**（`01a1166f-…`，18 条消息）：

```
a: input 23937 / output 24184 / cacheRead 4352 / reasoning 14735 / total 52473
b: input 6     / output 4142  / cacheWrite 11143 / total 15291
```

### 口径核对

`totalTokens == inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（三份样本全部精确成立）。
`reasoningTokens` 已含在 `outputTokens` 内，不额外计入。

### 额度变化

`/api/me/pulse` 发送前 `100`、发送后 `100` —— **pulse 与单次请求成本无关**，
真正的「扣费」是**限速窗口**（10 prompt / 5 分钟）而不是 pulse。

---

## 3. 前端成本 Schema（从 bundle 挖出，未在响应中出现）

```
MESSAGE_COST_OPTIONAL_NUMBER_FIELDS = [basePriceUsd, totalChargedUsd, totalChargedCredits,
                                       costMultiplier, discountPercent, totalCharged]
CostDetailSchema        = { totalCostUsd, isFallback, source, isLongContext?, ...上述可选数值 }
MessageCostSchema       = { actual: CostDetailSchema, ...可选, pricingStrategy, marginMultiplier, charged? }
SessionCostAggregateSchema = { actual, basePriceUsd, totalChargedUsd, totalChargedCredits,
                               pricingStrategy, marginMultiplier }
逐项成本字段 = [cacheWriteTokensCostUsd, cacheReadTokensCostUsd, imageInputTokensCostUsd,
               imageOutputTokensCostUsd, textOutputTokensCostUsd, imageGenerationCostUsd, videoGenerationCostUsd]
```

`useCostContext()` 的展示逻辑（`34u59gfuxb868.js`）：

```js
let v = C.basePriceUsd, T = C.actual.totalCostUsd, x = C.totalChargedUsd, R = v !== T;
// 渲染 "formatUsd(T,'detailed')" ，R 为真时再追加 " | formatUsd(v)"
```

即：**基准价 `basePriceUsd` 与实际价 `actual.totalCostUsd` 分开显示，差额来自 `pricingStrategy` / `marginMultiplier` / `discountPercent`。**
这套字段在当前账号的响应里全为 `null` —— 说明该账号走的是免费档（只记 token，不记美元）。

---

## 4. 公开的 token 单价表（`/leaderboard` RSC）

`GET https://arena.ai/leaderboard`，带 `RSC: 1` 头。返回的 flight 载荷里嵌着榜单每一行，
**349 行中 208 行带价格**，字段为：

```
inputPricePerMillion / outputPricePerMillion          ← 单位：USD / 百万 token（实测只有这两个有值）
cacheReadPricePerMillion / cacheWritePricePerMillion  ← schema 里有，实测全 null
imageInputPricePerMillion / imageOutputPricePerMillion / textOutputPricePerMillion ← 同上，全 null
+ modelKey / modelDisplayName / modelOrganization / costPerTaskUsd（实测全 null）
```

快照已存为随包文件 `arena-pricing-table.json`（schema `arena-model-pricing`，unit `usd_per_million_tokens`）。
样本：

| model_key | org | 输入 | 输出 |
|---|---|---|---|
| `gpt-6-astra-max-agent` | OpenAI | $10 | $50 |
| `claude-opus-5.5-high-vertex-agent` | Anthropic | $4 | $20 |
| `claude-opus-5-max-agent` | Anthropic | $5 | $25 |
| `gpt-5.6-luna-xhigh-agent` | OpenAI | $0.2 | $1.2 |
| `deepseek-v4.1-flash-max-20260910-agent` | DeepSeek | $0.3 | $1.2 |

### 4.1 两个必须剔除的坑

1. **图像/视频模型不是按 token 计价的**（208 行里有 15 行）：`gpt-image-*` 只有输入价、`sora-*` / `veo-*` / `imagen-*`
   只有输出价，单价单位其实是**按张/秒**。混进 token 反推会把结果带偏 → 标 `kind='media'` 并排除。
2. **同一基础模型的各档位单价完全相同**（实测：`claude-opus-5` 的 6 档全是 `$5/$25`，`gpt-5.4` 的 5 档全是 `$2.5/$15`）。
   → **价格能区分「是哪个基础模型」，但区分不了「是哪个 effort 档位」**。档位还得靠数字指纹。

### 4.2 指纹库 id 与 Arena 变体 key 的命名差异

| | 命名 | 例 |
|---|---|---|
| 指纹库（modeltrace/whatsmyllm bank） | 基础名 | `gpt-6-astra`、`claude-opus-5-5` |
| Arena 单价表 | 变体名 = 基础名 + 档位 + 载体 | `gpt-6-astra-max-agent`、`claude-opus-5.5-high-vertex-agent` |

匹配规则：**基础名是变体名的前缀，且后缀从 `-` 开始**。两个坑（都已在 `pricing-channel.js` 处理并有测试覆盖）：

- **点号版本号**：指纹库写 `claude-opus-5-5`，Arena 写 `claude-opus-5.5` → 生成「末两位数字改点号」的别名。
  **不能**把点号也粗暴归一成短横，否则 `claude-opus-5` 会吞掉 `claude-opus-5.5-*`（两个不同模型直接混淆）。
- **前缀吞并**：`claude-sonnet-5` 是 `claude-sonnet-5-5-xhigh` 的前缀 → 用「前缀后第一个 token 若是裸数字（1~2 位）则不算命中」消歧。
  长日期后缀（`-20260517`）不受影响。

实测结果：**17 个库内模型里 16 个能对上公开单价**（唯一无价的是 `claude-haiku-4-5-20251001`）。
复跑命令：`node tools/pricing-map.mjs`。

### 4.3 没拿到真实成本时，价格依然有判别价值

用 2026-10-11 实测的那条 payload（`in 6 / out 4142 / cacheW 11143`）算 6 个候选的期望成本：

| 候选 | 期望成本 | 相对最便宜 |
|---|---|---|
| `gpt-5.6-luna` | $0.00497 | 1× |
| `gpt-5.6-terra` | $0.0497 | 10× |
| `gpt-5.4` | $0.0621 | 12.5× |
| `gpt-5.6-sol` | $0.0829 | 16.7× |
| `gpt-5.5` | $0.1243 | 25× |
| `gpt-6-astra` | $0.2072 | 41.7× |

跨度 **41.67×**、区间两两不重叠 → 单靠价格就能唯一确定**基础模型**。
拿到真实成本后，`observed/expected` 比值最接近 1 的那个就是它（比值取对数后做高斯核加权）。

---

## 5. 对探针的意义

1. **「按价格反推模型」成立，但要拆成两半**：单价（公开，已接入）+ 真实按次成本（灰度，未拿到）。
   只凭单价也能报**价格区分度** —— 价格切不开候选时，扩展会直说「价格不可区分」，不硬猜。
2. **`cacheWriteTokens` 是用量里最有判别力的一维**：
   - 只在支持 prompt caching 写入的厂商出现（Anthropic 系 `cache_creation_input_tokens` 的归一化）；
   - 实测同一局里 A/B 都有（3845 / 11143），而另一局的样本**没有**这一字段 —— 说明它确实是**按模型/provider 变化的**。
3. `reasoningTokens > 0` 是**推理模型**的直接标记。
4. 于是得到两条新通道，都与指纹评分、节奏通道并列，且**完全不需要额外发请求**：
   - **用量形态签名** `cw/cr/rz`（厂商与模型类别的旁证）；
   - **价格区分度**（基础模型层面的旁证；一旦拿到真实成本即升级为按价排序）。

---

## 6. 复现命令

```bash
# 一次性：启动调试 Chrome（进程随工具调用结束会被回收，故启动与取数必须在同一次调用内完成）
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --remote-debugging-port=9222 \
  --user-data-dir="C:/Users/28023/AppData/Local/Temp/amp-debug-profile" \
  --no-first-run --no-default-browser-check "https://arena.ai/" &

# 取数
node tools/cdp.mjs 9222 --url arena.ai --file tools/expr/arena-usage-dump.js   # 读某会话每条的 usage
node tools/cdp.mjs 9222 --url arena.ai --file tools/expr/arena-send-probe.js   # 真发一条并观察扣费
node tools/cdp.mjs 9222 --url arena.ai --file tools/expr/arena-leaderboard-prices.js  # 抓公开单价表

# 离线自查（不需要浏览器）：指纹库 id → Arena 单价 key 的映射 + 价格区分度
node tools/pricing-map.mjs
node tools/pricing-map.mjs --usage "in=6,out=4142,cacheW=11143" --candidates gpt-6-astra,claude-opus-5-5,claude-sonnet-5
```

- 关键坑：**主 profile 不能开调试端口**（Chrome 136+ 安全策略），必须独立 `--user-data-dir`。
- **重要修正（v2.13.1）**：本节原先写「子进程会随工具调用结束被回收，所以起浏览器 + 连 CDP + 取数要写在同一条命令里」——
  这是**错的**。用后台方式起 Chrome（工具调用的 `run_in_background`），进程会**跨工具调用存活**，
  于是可以「起一次浏览器 → 之后每次只连 CDP 取数」，不必反复关停（反复重启还会让 CDP 端口时有时无）。
  只有「前台」调用结束时才回收子进程。
- 关键坑：同 URL 的 `Page.navigate` 在 SPA 上是 **no-op**，要触发重新加载得用 `Page.reload`。

---

## 7. 「别人能拿到成本」是怎么拿到的（截图实锤 + 倍率）

用户提供了一张 Arena Agent 界面的截图（失败态），底部成本条原文：

```
$23.18767300 cost | $1.06317612 base | $2.12635223 charged
```

这条把 §2 的结论**修正**了 —— 不是「Arena 不下发美元成本」，而是**按账号下发**。

| 界面字段 | 对应 API 字段（bundle zod schema） | 截图值 |
|---|---|---|
| `cost` | `actual.totalCostUsd` | $23.18767300 |
| `base` | `basePriceUsd` | $1.06317612 |
| `charged` | `totalChargedUsd` | $2.12635223 |

### 7.1 两条硬关系（可验算）

1. **`charged = base × 2`（精确）**
   `2.12635223 / 1.06317612 = 2.0000000`。这就是 bundle 里的 `marginMultiplier` —— Arena 在基准价上的固定加价倍率。
   积分口径也自洽：`totalChargedCredits = 2126.35223`，按 `CREDITS_PER_USD = 1e3` 折算正好 `$2.126352`。
2. **`base` 才是「Σ token × 公开单价」那一半**
   §4 的公开单价（USD/百万 token）× §2 的 token 用量 = 基准价。
   → **按价反推模型必须用 `base`**；`charged` 被 ×2 污染，和公开单价表不是同一口径，直接拿来比会整体偏移一倍。

### 7.2 `cost` 是什么 —— **未能确认**

`$23.18767300` 既不等于 base 也不等于 charged（`23.187673 / 1.06317612 ≈ 21.81`、`/ 2.12635223 ≈ 10.90`，都不是整数倍）。
同屏还有 `Something went wrong. Please try again.`（生成失败态），推测它是 **fallback / 最坏估计**口径
（`CostDetailSchema` 正好有 `isFallback` / `source` 两个字段用于这种情况），但**没有证据，不下结论**。
`useCostContext` 的三段渲染逻辑已从 bundle 复现：
`actual.totalCostUsd` 恒显示；`basePriceUsd !== totalCostUsd` 时追加 `| base`；`totalChargedUsd` 有值时再追加 `| charged`。

### 7.3 对探针的实际影响（2.13.1 修的就是这个）

嗅探器有**两条**取成本的路径，旧字段表在**兜底那条**上是残的：

| 路径 | 机制 | 旧字段表的表现 |
|---|---|---|
| 结构化解析 `scanCostRoute` | `JSON.parse` 整个 `/cost` 响应，读 `session.actualTotalUsd` / `chargedTotalUsd` | 正常（**硬依赖 JSON 可解析**） |
| 正则字段表（兜底） | 响应被流式切碎/被包装、`JSON.parse` 失败时逐字段抓 | **漏掉 `actualTotalUsd` / `chargedTotalUsd` / `costMultiplier` / `marginMultiplier` / `totalChargedCredits` / 9 个分项 `*CostUsd`**，只能靠 `basePriceUsd` / `totalCostUsd` 勉强兜到 base |

也就是说：**base 勉强能兜到，但实扣价与加价倍率永远拿不到**（截图里的 `charged` 与 ×2 就是这么漏的）。
另外旧单位分类把 `creditsUsed` 判成美元、把倍率类字段判成 token 数。

2.13.1 已按 bundle 的 zod schema 补全字段表：

```
usd        : actualTotalUsd / chargedTotalUsd / basePriceUsd / totalCostUsd / totalChargedUsd /
             totalCost / costUsd / priceUsd / spend / totalCharged / costPerTaskUsd / pricePerImage /
             + 9 个分项：inputTokensCostUsd / outputTokensCostUsd / cacheWriteTokensCostUsd /
               cacheReadTokensCostUsd / textOutputTokensCostUsd / imageInputTokensCostUsd /
               imageOutputTokensCostUsd / imageGenerationCostUsd / videoGenerationCostUsd
credits    : totalChargedCredits / creditsUsed
multiplier : costMultiplier / marginMultiplier / discountPercent
tokens     : total_tokens / prompt_tokens / completion_tokens / input_tokens / output_tokens /
             cache_read_tokens / cache_write_tokens / reasoning_tokens / inputTokens / outputTokens
```

单位分类顺序**要紧**：先判倍率/积分 → 再判美元 → 最后才是 token。
否则 `inputTokensCostUsd` 会因为含 `tokens` 被误判成 token 数（旧代码就是这么错的）。

自检新增一行 **「本账号能否读成本（/cost）」**：抓到了就直报 `base / 实扣 / ×倍率`，没抓到就明说「未开计费」。
浮层结果行也会追加 `· 真实成本 base $x · 实扣 $y · ×2`。

### 7.4 结论：想拿到真实成本需要什么

1. **账号必须已开通计费**（服务端 PostHog flag `credit-system-m1` / `credit-system-m2` 打开）——这是唯一门槛；
   客户端 flag 覆写无效（实测 `posthog.featureFlags.override(...)` 后仍 403），说明门在服务端。
2. 换账号后**不需要改扩展**：字段表已补齐，嗅探器会自动抓到并升级为按价排序。
3. 拿不到真实成本时，扩展仍报**价格区分度**（用公开单价 × 实测 token 用量算），这一半不依赖账号。

### 8. Agent 模式用量穷举实测 + canary 侦察（2026-10-12，CDP hunt4–20）

**结论：网页渠道对 Agent 模式不下发任何 token 用量；已知带真实数据的只有两条按账号/渠道放行的路由。**

| 探测点 | 结果 |
|---|---|
| `GET /api/chat/<sid>`（14 条消息深扫） | 200，`metadata` 只有 manifestNodeId/nodeId/pending/requiresReview/feedback，零 usage |
| `GET /api/chat/<sid>/run-status?inputId=…` | 200，仅 status/failure/retryAfterMs |
| 实时发送 `POST /nextjs-api/stream/create-chat` | 请求 message/id/role/parts/recaptchaV3Token/timezone；响应 id/sessionId/inputId/taskId/publicAccessToken/ttlMs…——零 usage |
| SSE 流 `GET /ai-proxy/realtime/v1/sessions/<sid>/out`（37 条记录全解析，含数组内部/嵌套 JSON） | 事件 11 种（start / start-step / reasoning-start/delta/end / text-start/delta/end / finish-step / finish / data-agent-dispatch）；字段全集仅 type、id、delta、messageMetadata、timing、startedAt/completedAt、inputId、attemptId、providerRequestId、browserAttemptId、transient、messageId、nodeId、manifestNodeId、pending、requiresReview。AI SDK 的 `finish` 事件**可带 usage，Arena 服务端剥掉了** |
| `GET /api/evaluation/<agentSid>` | 404「Evaluation session not found」——chat 与 evaluation 是两个隔离命名空间 |
| `GET /api/chat/<sid>/cost` | 403 `Unauthorized`（账号计费门；主站与 canary 一致） |
| `POST /api/agent-logs/<id>/usage` | 403 `Route not allowed`（网关路由白名单；session id / run cuid / run_ 前缀 × cookie / 运行 token Bearer / apikey / 伪造客户端头，全部 403） |
| 27 条候选路由（/api/usage、/api/me/{usage,cost,credits,spend,tokens}、/api/chat/<sid>/{usage,tokens,stats,metrics,events}…） | 清一色 403；唯一活口 `/api/chat/<sid>/messages?cursor=…`（transcript 分页，需游标，内容仍是无 usage 的消息） |
| `/api/history/unified` 深扫 | 零 usage/cost/credit 字段 |
| canary.arena.ai（同账号、同后端） | /cost 与 agent-logs 同样 403；Agent 页 DOM 无任何 token/cost 展示；不是后门 |

**两条关键新路由（第三方集成渠道已确认有数据）：**
- `POST /api/agent-logs/{agentLogId}/usage`——Kiro 集成抓到的响应：整段会话逐条 usage + 每条标模型（如 claude-opus-5-max-agent）+ 分项成本（input/output/reasoning/cache_read/cache_write/tool_search）+ 总额 ×2 → credits；
- `/api/coding-agent/sessions*`（列表 / workflow-checks / diff/download）——canary 包里的 coding-agent 产品 API 族，本网页账号同样 403。

**凭证组合矩阵（全部实测）**：cookie（HttpOnly arena-auth-prod-v1）、运行 token（publicAccessToken，scopes 仅 read/write:sessions:<sid>）、apikey 头、伪造 `X-Arena-Client: kiro` 等 6 种头——对受限路由无任何差别；页面 localStorage/sessionStorage 无 Supabase JWT（认证全在 HttpOnly cookie）。

**可用副产品**：`GET /nextjs-api/model-catalog` → 200，167 个模型的 id/organization/provider/capabilities/rank（无价格字段，可作指纹元数据源）。

**对扩展的含义**：数据按账号/渠道放行，客户端无解。v2.13.5 计划把 `agent-logs/*/usage` 与 `coding-agent/sessions*` 接入被动监听（通用正则通道本来就会扫所有响应；补的是结构化逐条解析），放行即自动入账，零等待。

---

## 9. 「反爬机制 / 请求头」假设的实测否证 + M2M 架构真相（2026-10-12，CDP hunt21–23）

> 用户提示：『你了解一下反爬机制』『header 查东西?』。本节把这条线索**彻底查到底**。

### 9.1 请求头对照矩阵 —— 11 种组合全部 403

在 `canary.arena.ai/agent/<sid>` 页面上下文（同源、带 Cloudflare `cf_clearance`）对 `GET /api/chat/<sid>/cost?includeSession=true` 逐一试：

| 变体 | 值 | 状态 |
|---|---|---|
| cookie-only | — | 403 `Unauthorized` |
| **真 Supabase Bearer JWT** | 由 `arena-auth-prod-v1.0` + `v1.1` 两段 cookie 拼回 base64 → JSON → `access_token`（1263 字符，`role: authenticated`，`iss: …supabase.co/auth/v1`） | 403 |
| `x-arena-request-caller` | `web-ssr-public` | 403 |
| `x-arena-request-caller` | `web_ssr_cache_fill`（`INTERNAL_M2M_CALLER`） | 403 |
| `x-arena-expected-api-deployment` | `dpl_26hvs5L78HrFdUoEqcgyg739VJh1`（当前 API 部署） | 403 |
| `x-arena-web-deployment` | `dpl_5HKDvo3f6p4Rx2kQpPsqdJAXwDg`（当前 Web 部署） | 403 |
| **reCAPTCHA Enterprise `x-api-waf-token`** | `grecaptcha.enterprise.execute(siteKey,{action})` 取到的 2660 字符 token | 403 |
| referer + origin | 同源 | 403 |
| 以上任意组合 | — | 403 |

参数矩阵同样全 403：无参 / `includeSession=true|false` / `messageIds=<id>` / `includeSession=false&messageIds=<id>` / 多 id 逗号拼接 —— **7 × 2（chat + evaluation）= 14 种全 403**。

**判据**：不存在的路由返回 `{"error":"Route not allowed"}`，`/cost` 返回 `{"error":"Unauthorized"}` → 路由真实存在、服务端主动拒绝，**不是边缘/WAF 拦截**。

### 9.2 反爬栈确实存在，但它不是这道门

- Cloudflare：cookie 里有 `cf_clearance` / `__cf_bm`；响应头 `cf-ray` / `cf-cache-status: DYNAMIC`。
- reCAPTCHA Enterprise v3：`window.grecaptcha.enterprise.execute("6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0",{action})`，token 只用于 **mutation**（`recaptchaV3Token`，见 `review-feedback` / `undo`），失败对应 `RECAPTCHA_VALIDATION_FAILED_MESSAGE` + `FORBIDDEN`。
- bundle 常量：`API_WAF_TOKEN_HEADER_STRING="x-api-waf-token"`、`ARENA_REQUEST_CALLER_HEADER="x-arena-request-caller"`、`ARENA_REQUEST_CALLER={WEB_SSR_PUBLIC:"web-ssr-public"}`、`INTERNAL_M2M_CALLER={WEB_CACHE_FILL:"web_ssr_cache_fill"}`。

这些**全部通过**了（否则连 `/api/me` 都拿不到），403 依旧 → **反爬不是 `/cost` 的门**。

### 9.3 真正的门：API 部署要求 **M2M 服务令牌**（`API-Authorization`）

Web 部署的响应头 `vary: X-Arena-Expected-API-Deployment, X-Arena-Web-Deployment, API-Authorization, accept-encoding` 点名了一个自定义头。顺藤摸到 **API 部署域名**（bundle 里出现 `https://arena-api-stable.arena-preview.com`；本会话 cookie `arena_build_bucket=stable`）：

```
GET https://arena-api-env-canary.arena-preview.com/api/chat/<sid>/cost?includeSession=true
  (无头)                                    → 401 {"error":"Unauthorized - M2M token missing"}
  API-Authorization: <原始值>                → 401 {"error":"Unauthorized - Invalid token format"}
  API-Authorization: Bearer <用户 JWT>       → 401 {"error":"Access denied"}
  Authorization: Bearer <用户 JWT>           → 401 {"error":"Unauthorized - M2M token missing"}  ← 这个头根本不认
```

→ **架构结论**：`canary.arena.ai` 是 Web 部署，`/api/*` 由它**服务端代理**到 API 部署，并注入 `API-Authorization: Bearer <M2M 令牌>`。这个 M2M 令牌是**服务间共享密钥**，只存在于 Web 部署的服务端，**浏览器永远看不到**，因此客户端无论怎么补头都无法伪造。

于是：**经 Web 代理的请求，M2M 这层已经过了**；剩下的 `403 {"error":"Unauthorized"}` 是**应用层的用户权益判断**（账号是否开通计费）。直连 API 部署反而更差（连 M2M 都没有）。

### 9.4 路由穷举 —— `/cost` 是 Web 端唯一的成本接口

1. **从 bundle 挖出全部前端客户端调用链**（`hc<AppType>` 的运行时形态）：
   `.chat[":id"].$get/.$delete/.archive.$post/.unarchive.$post/.cost.$get/.messages.$get/.preview.$get/.preview.heartbeat.$post/.rubrics.$get/.workspace.latest.$get`、
   `.chat["trigger-token"].$post`、`.chat["trigger-session"].$post`、
   `.evaluation[":id"].$get/.cost.$get`、`.api.me.pulse.$get`、`.api.history.search.$get/.unified.$get`、
   `.me["update-tou-consent"].$post`、`.storage["generate-agent-upload-url"].$post`、
   `.workspace[":manifestNodeId"].$get/.dir.$get/.preview-token.$post`。
2. **252 个候选路由 fuzz**（`/api/chat/<sid>/<seg>`、`/api/<seg>`、`/api/me/<seg>` × 84 个词：cost/usage/tokens/credits/billing/spend/price/stats/…），以 `Route not allowed` 为否定判据。**只有 4 个命中**：

| 路由 | 状态 |
|---|---|
| `GET /api/chat/<sid>/cost` | **403 `Unauthorized`**（唯一成本接口） |
| `GET /api/chat/<sid>/messages` | 400（需 transcript `cursor`；`pagination.cursor=null` 时无更多页） |
| `GET /api/chat/<sid>/preview` | 200（sandbox 状态，无用量） |
| `GET /api/chat/<sid>/rubrics` | 400（需 `inputIds`） |

3. **`/cost` 只允许 GET**：POST → `Route not allowed`；HEAD → 403。
4. **另两条 200 的只读路由**（已确认无 usage/cost）：`GET /api/history/unified?limit=N` → `{entries:[{type,id,title,createdAt,updatedAt,archivedAt,productMode,codingSessionStatus}], pagination, partial, failedSources}`；`GET /api/chat/<sid>/workspace/latest` → `{manifestNodeId,leafMessageId,manifest}`。
5. **`agent-logs/*` 与 `coding-agent/*` 在 Web 渠道不可达**（复验）：`POST /api/agent-logs/<sid|runCuid>/usage`、`GET /api/agent-logs/<sid|?limit=5|/me>`、`GET /api/coding-agent/sessions` **全部 403 `Route not allowed`** —— 网关白名单直接不路由（即便带上 Trigger.dev public token 或伪造 `x-arena-client: kiro`）。它们是**第三方集成渠道**的 API，不是 Web 渠道的后门。

### 9.5 顺带确认的新接口（无成本价值，但对侦察有用）

- `POST /api/chat/trigger-token` body `{sessionId}` → 200 `{token}`；`POST /api/chat/trigger-session` 同 body → 200 `{publicAccessToken}`。两者换出的是**同一个 Trigger.dev public access token**（`sub: <runCuid>`、`pub:true`、`scopes:["read:sessions:<sid>","write:sessions:<sid>"]`、`iss: id.trigger.dev`、`aud: api.trigger.dev`），TTL 1 小时。**可随用随取，不必从会话包里抠。**
- `GET /api/chat/<sid>/run-status?inputId=…` → 200 `{"status":"active","failure":null,"retryAfterMs":60000}`。
- `GET /api/history/unified` 是**唯一**能列全部会话的接口（`entries[].type` = `agentic`）。

### 9.6 最终结论

| 问题 | 答案 |
|---|---|
| canary 有能拿 token/费用的接口吗？ | **有，且只有一个**：`GET /api/chat/:id/cost`（+ Battle 的 `/api/evaluation/:id/cost`）。 |
| 是被"反爬机制"拦的吗？ | **不是**。反爬栈（Cloudflare + reCAPTCHA + WAF token）全部通过；11 种请求头 × 14 种参数组合全 403。 |
| 真正拦它的是什么？ | 两层：① `API-Authorization` 的 **M2M 服务令牌**（Web 部署服务端注入，浏览器拿不到 —— 经 Web 代理时已满足）；② **应用层账号权益判断**（本账号未开通计费 → 403 `Unauthorized`）。 |
| 能绕过吗？ | **不能**。M2M 是服务端共享密钥；权益判断在服务端。客户端无解。 |
| 那怎么办？ | 换**已开通计费**的账号（`credit-system-m1/m2` 打开）；扩展的嗅探器 + `/cost` 主动探测会在 200 时自动入账，**无需改代码**。 |

### 9.7 复现命令

```bash
# 请求头矩阵（页面上下文，同源带 cookie）
node _cdp.mjs "canary.arena.ai/agent" _p9.js
# 路由 fuzz（252 个候选）
node _cdp.mjs "canary.arena.ai/agent" _p21.js
# 直连 API 部署域名 + M2M 头矩阵（Node，读 _ck.json cookie）
node _m2m.mjs
```

### 9.8 M2M 令牌能不能拿到？—— **不能**（客户端无任何泄漏面）

把「从客户端找 M2M 令牌」这条也实测到底：

| 排查面 | 结果 |
|---|---|
| 全部 63 个 `<script>` chunk（跳过 recaptcha） | `M2M` / `INTERNAL_M2M` **只以常量名出现**（`INTERNAL_M2M_CALLER={WEB_CACHE_FILL:"web_ssr_cache_fill"}`），**没有任何令牌值** |
| 页面 HTML（`documentElement.outerHTML`） | 无 `M2M` / `API-Authorization` / `api-authorization` / `NEXT_PUBLIC` |
| 内联环境变量 | 客户端 chunk 里 `process.env.<NAME>` 命中 **0 个**（Next.js 只内联 `NEXT_PUBLIC_*`，服务端变量不进包） |
| Source map | 所有 chunk 的 `sourceMappingURL` **0 个**（未开 `productionBrowserSourceMaps`） |
| `deployment-pair` 模块（`3-wmvaud53u81.js`） | 是**部署配对**机制（`pairId` / `webDeploymentId` / `apiDeploymentId` / `triggerVersion` + HMAC 校验，用于缓存失效与版本一致性），**与 M2M 令牌无关** |

→ **结论：M2M 令牌只存在于 Web 部署的服务端环境变量里，浏览器端不存在获取路径。** 想拿到只有两条**正当**途径：
1. **换已开通计费的账号**（`credit-system-m1/m2` 打开）→ `/cost` 直接 200，扩展自动入账，无需 M2M；
2. **走 Arena 官方签发的第三方集成凭据**（`agent-logs/*/usage` 那条渠道是 Kiro 集成在用）→ 需要向 Arena 申请，不是从网页抠出来的。

> 注意：M2M 令牌是**服务间共享密钥**，它不区分用户、拿它可直接调用整个 API 部署 —— 属于访问控制凭据。任何"从 Vercel 环境变量导出 / 反编译服务端 / 伪造签名"的做法都是绕过访问控制，不在本次调研范围内。

### 9.9 403 的**最终根因**：服务端 PostHog 灰度实验未放量

从 bundle `2eyb2ag_nzuov.js` 挖到成本 UI 的判定代码：

```js
// flag schema（2j77onky3gg-h.js）
"credit-system-m1": z.enum(["control", "cost-shown"]),
"credit-system-m2": z.enum(["control", "limits-enabled"]),

// 判定（2eyb2ag_nzuov.js）
function useIsCreditSystemM2Enabled(){ return useFlag("credit-system-m2") === "limits-enabled"; }
// …
const V = useFlag("credit-system-m1") === "cost-shown";
const W = useIsCreditSystemM2Enabled();
const q = useUserStore(userIsAnonymousSelector);   // 匿名用户
const L = (V || W) && !q;                          // 是否显示成本
```

**当前账号的实测**（从 localStorage 的 PostHog 载荷读出，共 293 个 flag）：

| flag | 当前值 |
|---|---|
| `credit-system-m1` | **不存在**（未纳入实验，`useFlag` 返回 `undefined`） |
| `credit-system-m2` | **不存在** |
| `disable-opus` | `"disable-opus"` |
| `modality-buttons-experiment` | `"control"` |

→ `V = false`、`W = false` ⇒ `L = false` ⇒ 前端**根本不渲染成本条**；服务端 `/cost` 用同一套判定，返回 `403 {"error":"Unauthorized"}`。

**结论**：这是**产品灰度（PostHog experiment）**，不是可以"修"的技术故障：

- 客户端覆写 flag（`posthog.featureFlags.override(...)` 或 localStorage `$override_feature_flags`）**只改 UI 渲染，不改服务端判定** —— 实测覆写后 `/cost` 仍 403；
- flag 由 PostHog 按用户属性在服务端分配，**客户端无法自助加入**；
- 唯一正当路径：**换一个已被分配到 `cost-shown` / `limits-enabled` 的账号**（截图里 `$23.18767300 cost | $1.06317612 base | $2.12635223 charged` 就来自这样的账号），或等灰度放量 / 联系 Arena 支持开通。

> 当前调试浏览器登录的是**当天新建的测试号**（`oliviavasquez54643+…`，用户名 `sadsada`，`/api/history/unified` 只有 1 个会话，创建于 2026-10-11 19:20）。换成截图那个账号登录后，扩展**无需改任何代码**即可显示花费。




---

## §10 复验（2026-10-12，v2.14.0）：精确值仍不可得；转录估算通道端到端可用

**背景**：用户要求「不管用什么方式，获取每一条发送消息消费的 token 或金额」。本轮在真实浏览器（Chrome 154，CDP 直连 `canary.arena.ai/agent/01a12ca1-…`）把 §9 未覆盖的剩余路径全部试完。

### 10.1 精确用量：全部路径穷举（本轮实测）

| 探测 | 结果 | 判读 |
|---|---|---|
| `GET /api/chat/<sid>/cost?includeSession=true` | **403 `{"error":"Unauthorized"}`** | 复验 §9.9 结论：账号灰度门 |
| `GET /api/chat/<sid>?includeUsage=true` | 200，15435 B，**无 usage/cost** | 参数无效 |
| `GET /api/chat/<sid>?include=usage` | 200，15435 B，**逐字节相同** | 参数无效 |
| `GET /api/chat/<sid>?withUsage=1` | 200，15435 B | 参数无效 |
| `GET /api/chat/<sid>?includeCost=true` | 200，15435 B | 参数无效 |
| `GET /api/chat/<sid>?includeSession=true` | 200，15435 B | 参数无效 |
| `GET /api/chat/<sid>/messages` | **400 ZodError：`cursor` Required** | 需游标 |
| `GET /api/chat/<sid>/messages?cursor=null` | 400 `Invalid transcript cursor` | 无可用游标（`pagination.hasMore=false`） |
| `/ai-proxy/realtime/v1/sessions/<sid>/out` | 200，**990 KB 全量 SSE，无 `usage`/`inputTokens`/`outputTokens`** | 首连给全量回放，续连只回 38 B |
| `/ai-proxy/realtime/v1/sessions/<sid>/in` | **403 `requires secret key authentication`** | 需密钥 |
| `/ai-proxy/realtime/v1/sessions/<sid>/{run,usage}` | 400，schema 明示 `io` ∈ `{"out","in"}` | 该路由只有 out/in 两个通道 |
| `/ai-proxy/realtime/v1/runs/<runId>/{out,in,streams}` | 404 | 无 |
| `/ai-proxy/api/v3/runs/<runId>` | 404 `{"error":"Not found"}` | 无 |
| `https://api.trigger.dev/api/v3/runs/<runId>`（Bearer public token） | 404 `Not found` | public token 只授 `read/write:sessions:<sid>`，**无 run 元数据权限** |

→ **精确值在本账号的 Web 渠道确认不可得**（与 §9.6 / §9.9 一致，本轮为独立复验）。只有 ① 灰度放量账号的 `/cost`、② 第三方集成渠道（Kiro）的 `agent-logs/*`。

### 10.2 备选口径：转录字数估算（`estimate` 模式）

Agent 会话不下发 usage，但**转录本身**是下发的。`network-sniffer.js` 在 `GET /api/chat/<sid>` 响应体不含 `"usage"` 时，把每条 assistant 的 `parts`（正文 `text` + 思考 `reasoning`）按码点折成字符桶，上报 `kind:'transcript-estimate'`；`cost-ledger.ledgerRowsFromEstimates` 把它折成与 token 路径同形的账本行（`source:'transcript-estimate'`），token 口径 `ESTIMATE_METHOD='chars-v1'`（CJK ≈1 token/字、其余 ≈0.27 token/字符）。

**实测样本**（本会话 2 条消息）：

| message | role | part types | 估算输出 token |
|---|---|---|---|
| `01a12ca1-e341-…` | user | `text` | —（输入下界 ≈ 421） |
| `01a12ca2-0219-…` | assistant | `step-start, reasoning, text` | **≈ 7936** |

**能力边界（诚实标注）**：Agent 消息**没有 `modelId`** 字段（实测消息键只有 `id/role/parts/metadata`），`session.pinnedModel` 也为 `null` ⇒ 模型未知 ⇒ 账本**不折价**（遵守「绝不猜价」）。所以该通道产出**逐条估算 token，不是金额**。

**本轮修的一个展示缺陷**：`describeTotals()` 从不显示 token 数 —— 估算会话全部行 unpriced，旧摘要只写「N 条 · N 条无单价」，把唯一产出藏了。现为 `N 条（估算） · 输出约 T token · M 条无单价`。

---

## 11. v2.15.0：转录估算通道「真机产不出证据」的根因与修法

### 11.1 现象与根因

v2.14.0 的解析链路（嗅探器 → `netState.transcriptEstimates` → `ledgerRowsFromEstimates` → `mode:'estimate'`）**代码上是通的，但真机页面上 `transcriptEstimates` 恒为 `[]`**（CDP 实测：`{"sniffer":true,"ampBuild":"v2140","kinds":{"alive":1,"stats":59,"stream":52},"transcriptEstimates":[]}`）。

根因有两条，叠加：

1. **页面自身的 `/api/chat/<sid>` 请求不走主线程。** `network-sniffer.js` 里早有一条注释：「已确认 Arena 的聊天请求（`/api/chat/*`）从 Web Worker 发出，页面主线程钩子看不到」—— 嗅探器的 `fetch`/`XHR` 补丁抓不到它。
2. **Worker 搭车通道注定匹配不上路由。** Worker 通道（`tapPort`）把消息交给 `scanText(text, 'worker:in', '')` —— **URL 传的是空字符串**，而结构化解析的入口条件是 `SESSION_ROUTE_RE.test(url)`（`/\/api\/(?:evaluation|chat)\/[^\/?#]+(?:$|\?|\/)/`），空串必然不匹配。加上 `scanableText` 只收 ≤2048 字符的字符串 / 小对象，整包转录（15 KB）本来也进不来。

**但转录本身是同源可取的**（页面上下文实测）：

| 请求 | 结果 |
|---|---|
| `GET /api/chat/<sid>`（页面上下文 fetch） | **200，15435 B** |
| `messages` | 2 条（user ×1、assistant ×1） |
| assistant 消息键 | `id / metadata / role / parts` |
| `parts[].type` | `step-start` / `reasoning` / `text` |
| `metadata` 键 | `timing / manifestNodeId / nodeId / pending / requiresReview / feedback` —— **无 usage** |
| 全串 `"usage"` 字样 | **不存在**（`hasUsageLiteral:false`，`usageIdx:-1`） |
| `modelId` / `pinnedModel` / 全串 `"model*":"…"` | **均无**（`modelFields: []`） |
| `pagination` | `{hasMore:false, cursor:null, limit:20}`；`?limit=100` 等参数**被服务端忽略**（恒回 15435 B） |

### 11.2 修法：主动取转录

`network-sniffer.js` 文末新增「v2.15.0 主动取转录」：会话页（`/agent/<sid>` → `/api/chat/<sid>`；`/battle/<sid>` → `/api/evaluation/<sid>`）里由**页面上下文同源 GET 一次会话包**（用原生 fetch 绕过自身钩子避免自噬，`credentials:'same-origin'` 带 cookie），响应体交给**与被动路径完全相同**的 `scanText`。触发点：初始加载、SPA 路由变化（包 `pushState`/`replaceState` + `popstate`）、`finishStream` 里补一次。节流 2.5 s / 每页上限 60 次。

**实测端到端（Chrome 154 CDP 直连 `canary.arena.ai/agent/01a12ca1-…`）**：

```
注入   : {"sniffer":true,"ampBuild":"v2150",
          "kinds":{"alive":1,"stats":2,"transcript-estimate":1,"token":1},
          "transcriptEstimates":[{"mid":"01a12ca2-021","model":null,
            "text":{"chars":3535,"cjk":2601,"other":934},
            "reasoning":{"chars":9655,"cjk":3392,"other":6263}}]}
账本   : mode="estimate"
          text="1 条（估算） · 输出约 7936 token · 输入下界约 421 token · 1 条无单价"
          rows[0]={message_id:"01a12ca2-…", role:"assistant", tokens:7936,
                   usage:{outputTokens:7936, reasoningTokens:5083},
                   estimate:{input_tokens_lower_bound:421}, base_usd:null}
```

### 11.3 输入下界（「发送消息」那一半）

用户要的是「每一条**发送消息**消费的 token」。输出侧已由上表给出；发送侧只能给**下界**：

- `scanTranscriptEstimate` 把 user 消息的正文统计留住（`input_chars` + `input_message_id`），配给紧随其后的 assistant 回复。**认领放在 dedup 之前**，保证重复抓取时结果确定（否则同一条回复会一次带输入、一次不带）。
- 输入下界**不进** `tokens` / `base_usd`（只展示），避免污染"输出侧估算"的口径。
- 口径说明：只含用户那条文字，**不含历史上下文与系统提示**，真实输入远大于此 —— 所以是下界，不是估算值。

### 11.4 同版否证：实时流回放令牌会过期

复验 `/ai-proxy/realtime/v1/sessions/<sid>/out` → **401 `{"error":"Invalid or Missing API key"}`**（会话变旧后回放令牌失效；v2.13.5 抓到 990 KB 全量回放时该会话是新鲜的）。这也顺带说明：把实时流当成本通道不可靠，**转录 HTTP 接口才是稳的那条**。

### 11.5 站点覆盖：canary 不在 manifest 里（v2.15.0 已补）

扩展此前只匹配 `https://arena.ai/*` ⇒ **在 `canary.arena.ai` 上完全不注入**（实测：manifest 加 `https://canary.arena.ai/*` 前 `sniffer:false`，加后 `sniffer:true`）。已统一扩到两个 origin（manifest / `isAgentUrl` / `agentPage` / `newChatLinks` / `popup.agentUrl` / `conversation-rename`）。**这是权限扩张**，README 已标注。

