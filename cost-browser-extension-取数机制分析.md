# `cost-browser-extension` 取数机制分析（2026-10-12）

> 分析对象：`C:\Users\28023\Desktop\cost-browser-extension`（v0.12.1，他人实现的「Arena 本地费用检测」MV3 扩展）
> 结论先行：**它拿到了官方服务端逐条消息成本接口 `/api/chat/<sid>/cost?includeSession=true`，撬开灰度门禁的办法是写 PostHog feature-flag override cookie `ph-toolbar-overrides={"credit-system-m1":"cost-shown"}`。**

---

## 1. 核心机制：PostHog flag 覆盖 cookie

`cost-panel.js` 第 390–401 行（`readCostSnapshot()`）：

```js
const flag = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('ph-toolbar-overrides='));
let enabled = false;
if (flag) { try { enabled = JSON.parse(decodeURIComponent(flag.slice('ph-toolbar-overrides='.length)))['credit-system-m1'] === 'cost-shown'; } catch {} }
if (flag && !enabled) throw Error('已有其他费用显示设置，未覆盖。请先使用网站费用显示功能，再运行。');
…
if (!enabled) {
  document.cookie = 'ph-toolbar-overrides=' + encodeURIComponent(JSON.stringify({'credit-system-m1':'cost-shown'})) + '; Path=/; Max-Age=60; SameSite=Lax; Secure';
  temporary = true;
}
const response = await fetch('/api/chat/' + encodeURIComponent(ids[0]) + '/cost?includeSession=true',
  {method:'GET', credentials:'same-origin', redirect:'error', signal:AbortSignal.timeout(15000)});
…
} finally {
  if (temporary) { document.cookie = 'ph-toolbar-overrides=; Path=/; Max-Age=0; SameSite=Lax; Secure'; … }
}
```

要点：

| 设计 | 说明 |
|---|---|
| **cookie 名** | `ph-toolbar-overrides` —— PostHog 工具栏的 feature flag 本地覆盖机制（页面自身也带 `ph_phc_…posthog` cookie，证实站点在用 PostHog） |
| **值** | URL 编码的 JSON：`{"credit-system-m1":"cost-shown"}`，即把灰度旗标 `credit-system-m1` 覆写为 `cost-shown` |
| **写入参数** | `Path=/; Max-Age=60; SameSite=Lax; Secure` —— 只活 60 秒，同源 fetch 自动携带 |
| **门禁位置** | **服务端** Next.js API route 读这个 cookie 放行（不是客户端 PostHog SDK 自己玩） |
| **礼貌策略** | 用户已有该 cookie 且值不同 → 不覆盖、报错退出；自己写的临时值，读完必删，删掉还会校验，清理失败就不导出 |
| **入口** | 扩展图标点击 → `chrome.scripting.executeScript(world:'MAIN')` 注入 `cost-panel.js`（影子 DOM UI） |

## 2. `/cost` 接口返回结构（官方逐条计费）

`GET /api/chat/<sid>/cost?includeSession=true` 200 时的 schema：

```
session: { actualTotalUsd, chargedTotalUsd, messageCount,
  aggregate: { actual: {totalCostUsd, inputTokensCostUsd, outputTokensCostUsd,
                        cacheWriteTokensCostUsd, cacheReadTokensCostUsd, isFallback, source, isLongContext},
               basePriceUsd, totalChargedUsd, totalChargedCredits,
               pricingStrategy:'agent_p50', costMultiplier, marginMultiplier } }
messages: { <messageId>: {
    actual:   { totalCostUsd, inputTokensCostUsd, outputTokensCostUsd,
                cacheWriteTokensCostUsd, cacheReadTokensCostUsd,
                isFallback, source:'manual'|'aggregate', isLongContext },
    basePriceUsd, totalChargedUsd, totalChargedCredits,
    costMultiplier, discountPercent, pricingStrategy:'agent_p50', marginMultiplier } }
```

三层语义与 Arena 成本面板 `$23.18767300 cost | $1.06317612 base | $2.12635223 charged` 一一对应：`actual.totalCostUsd`（上游成本）／`basePriceUsd`（Arena 计价）／`totalChargedUsd`（实扣，= base × marginMultiplier），`totalChargedCredits = totalChargedUsd × 1000`。** Agent 模式逐条消息全都有**，不需要估算。

## 3. 其余取数通道（按优先级）

1. **`live-evidence.js`（0.11.0 起，document_start、MAIN world）**：patch 全局 `fetch`，只盯同源 `text/event-stream`、路径匹配 `/(?:sessions|chat)/<uuid>` 的响应；clone body 解析 SSE 帧，只保留 ID 类字段（`id/messageId/toolCallId/tool_use_id/providerRequestId/requestId`）和 20+ 种 token 计数字段（`input_tokens/output_tokens/prompt_tokens/completion_tokens/cached_tokens/reasoning_tokens/...`）；仅靠 `type:'start'|'message-start'` 带 `messageId` 的事件关联助手消息。上限：单流 512 KB、并发 4 条、内存 400 事件、每消息 40 条、单事件 8 KB。**不留正文、不发外部**。
2. **`/api/chat/<sid>` 历史读取**（`historySnapshot()`，同源 GET、≤2 MB、≤2000 条）：抽 `metadata.usage / totalUsage / metadata.providerMetadata` 里的显式 usage 字段（`extractReportedUsage`），以及**工具 ID 格式线索**（判断 OpenAI / Anthropic 厂商族的"工作假设"依据）。
3. **官方榜单**：`GET /leaderboard/agent` 拉 HTML，`arena-catalog-parser.js` 解析出输入/输出单价（OpenRouter 口径，缓存价是借用近似），内置 `OFFICIAL_SNAPSHOT` 快照兜底，localStorage 缓存。
4. **无 `/cost` 时的兜底**（`CONFIG`）：用截图公式（`scale:1e10`、`{input:2156,output:6468,write:2695,read:100}` 等假设）对 `basePriceUsd` 做**整数方程求解** token 数；再与公开单价表交叉筛候选。
5. **模型识别（另一个大模块）**：22 MB `fingerprint-bundle.js`（lm-detector 58 模型库 + ModelTrace/WhatsMyLLM 参考排名），由 background 在收到 `arena-cost-load-fingerprint` 消息后按需注入 MAIN world；「验证当前对话 / 抽卡」会真的往对话里发 1–10 条数字题探针（`1+1=? 只输出数字` 这种），本地评分只进内存。**这是它最重的部分，但与取成本数据无直接关系。**

自动节奏：空闲且页面可见时每分钟至多读一次 `/cost`；回复结束（busy→idle）后提早到 2 秒再读。

## 4. 我方实测复现（Chrome 154 + CDP，canary.arena.ai）

账号 `yangyaxin0604@gmail.com`，会话 `01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b`（Agent 模式，5 条消息）：

| 请求 | 结果 |
|---|---|
| 无 cookie | `403 {"error":"Unauthorized"}` |
| 带 `ph-toolbar-overrides={"credit-system-m1":"cost-shown"}` | **`200`，2794 B 完整账单** |

```json
"session": {"actualTotalUsd":0.004122368,"chargedTotalUsd":0.0033874648,"messageCount":5,
 "aggregate":{"actual":{"totalCostUsd":0.004122368,"isFallback":false,"source":"aggregate","isLongContext":false,
   "inputTokensCostUsd":0,"outputTokensCostUsd":0.00210304,"cacheWriteTokensCostUsd":0,"cacheReadTokensCostUsd":0.002019328},
   "basePriceUsd":0.0016937324,"totalChargedUsd":0.0033874648,"totalChargedCredits":3.3874648,
   "pricingStrategy":"agent_p50","costMultiplier":1,"marginMultiplier":2}}}
```

逐条 `messages.<id>`：`actual.totalCostUsd / outputTokensCostUsd / cacheReadTokensCostUsd / basePriceUsd / totalChargedUsd / totalChargedCredits / marginMultiplier:2 / pricingStrategy:'agent_p50' / discountPercent:0` 全有。

数值自洽校验（复现两次均稳定）：

- `totalChargedUsd = basePriceUsd × 2`（0.0007117024 × 2 = 0.0014234048 ✓）
- `totalChargedCredits = totalChargedUsd × 1000`（与本项目此前实测的 `CREDITS_PER_USD=1000` 一致）
- 写 cookie → 200、删 cookie → 403，闭环；60 秒 Max-Age 到期自动失效，无持久副作用
- `document.cookie` 在本页可正常写读（顺手验证过 `amp_probe_test` 对照）

**另有一个归属坑**：cookie 生效后若会话不属于当前账号，返回 `403 {"error":"User does not own session \"<sid>\""}`（78 B）——与无 cookie 的 24 B `Unauthorized` 是两种不同错误，可用来区分"门禁没过"和"会话不归你"。

## 5. 与此前结论的对照

| 此前的判断 | 实际 |
|---|---|
| `/cost` 403 = PostHog 灰度没放量 ⇒ **此路不通** | ❌ 判断下错。门禁有客户端可撬的官方机制（flag override cookie），本项目环境实测可稳定复现 |
| Agent 模式「无法拿到逐条成本，只能转录估算」 | ❌ 同上。官方逐条计费接口在 Agent 模式可用 |
| `charged = base × 2`、`credits = charged × 1000`、`pricingStrategy:'agent_p50'` | ✅ 与本次返回体完全吻合 |

## 6. 接入建议（本项目 Arena Model Probe）

1. **新增 `official-cost` 摄入通道**（替代估算成为首选口径）：content script 同源 fetch 前写 `ph-toolbar-overrides`（ISOLATED world 写 `document.cookie` 与 MAIN world 共用同一 cookie jar，完全有效），读完按「临时写必删、已有值不覆盖」的礼貌策略还原；只在 Agent 页 `/api/chat/<sid>` 主动取转录的同一时机触发（消息发出、回复结束时）。
2. **ledger 双口径并列**：有 `official` 时显示 `actual.base/charged/credits`（精确），无则退回转录估算，UI 明确标注口径来源。
3. **403 差异化处理**：`Unauthorized`(24B) → 记「门禁未过」；`User does not own session`(78B) → 记「会话不归当前账号」，避免误判成接口不存在。
4. cookie 写删要包 try/finally，失败不清缓存、保留旧数据（学它的"清理失败就不导出"）。
5. 不必抄它的指纹/抽卡/归档重模块——那部分与本项目已有的指纹识别重叠。

---

*证据文件：`dev-scratch/amp_livecost3.json`（A/B 完整返回体）、`dev-scratch/_cdp-costcookie.mjs`、`dev-scratch/_cdp-livecost3.mjs`、`dev-scratch/_cookieprobe.mjs`。*
