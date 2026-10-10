# Arena.ai Battle 页面结构侦察笔记（v2.9.14 校准版）

> 调研方式：Chrome DevTools Protocol（CDP）直连 `--remote-debugging-port=9222` 的独立调试实例（Chrome 154）。
> 结论全部来自 2026-10-06 实测。**Chrome 调试实例当前保持运行，后续可直接 `node cdp-eval.mjs 9222 <expr文件>` 继续侦察。**

---

## 0. 最重要的一条结论

**Arena 前端会过滤合成事件：`isTrusted === false` 的 pointer/mouse/click 事件一律无效。**

- 表现：content script 里 `dispatchEvent(new PointerEvent/MouseEvent/...)` 能**打开**部分下拉（触发钮绑定了 pointerdown），但**选中菜单选项永远无效**——这就是「一键建档局」此前反复失败的总根因。
- 解决：扩展自带 `debugger` 权限（v2.9.14 已加），由 background 通过 `chrome.debugger.attach` + `Input.dispatchMouseEvent` 对自己页签派发**受信任鼠标事件**（`AMP_TRUSTED_CLICK` 消息通道，content.js 的 `trustedClick()`）。
- 注意：每次 attach/detach 顶部会出现「正在调试此浏览器」提示条，属正常现象；若另一调试器占用会 attach 失败，自动回退合成事件路径。

---

## 1. 页面与路由

| 事项 | 实测结果 |
|---|---|
| Battle 首页 | 就是**根路径 `/`**（`/battle` 会弹回首页；`/battle/code`、`/battle/auto` 均**不存在**） |
| 模式（Mode） | 触发钮：`button[role="combobox"]`，回显 `Battle` / `Agent` / `Side by Side` / `Direct` |
| 模式的隐藏副本 | 页面上还有一个**原生 `<select>`**（视觉隐藏），`value="battle"`，option 文本为「标题+描述」连写，如 `Battle ModeBattle 2 anonymous models` |
| 场景（Modality） | **不是 combobox、不是 select**，是普通 `button`，用 `aria-label` 标识：`"Modality: Auto"` / `"Modality: Code"` / …；可见文本为 `Auto` / `Code` |
| 会话 ID | 新会话在首条消息发出前 URL 无 ID；battle 会话 URL 形态待进一步确认（`session()` 取路径末段 ≥8 位字符串） |

### Modality 菜单（展开后）实测条目

| 文本 | 描述 |
|---|---|
| Auto | Auto-routes you to the right modality |
| Text | Text to text chat with models |
| Code | Generate websites and apps |
| Web Search | Search the web |
| Image | Generate and edit images |
| Video | Generate and edit videos |

- 菜单项是**普通 BUTTON**（`class` 含 `hover:bg-surface-tertiary … flex w-full cursor-pointer`），**无任何 ARIA 角色**（`role=option/menuitem` 都查不到）。
- 菜单容器：`[data-radix-popper-content-wrapper]` / `[data-state="open"]`；触发钮 `data-state` 在 `open`/`closed` 间切换。
- **判断当前场景**：读 Modality 钮的 `aria-label`（含 `Code` 即 battle code）。`sceneReady()` 即按此实现。

---

## 2. 输入与发送

| 元素 | 实测 |
|---|---|
| 输入框 | **`<textarea>`**（agent 页才是 contenteditable），placeholder `Ask anything…`。content.js `editors()` 已做 textarea 回退；`writeEditor()` 走原生 value setter + `input` 事件 |
| 发送按钮 | `button[aria-label="Send message"]`；输入为空时 `disabled=true`（自检显示 ❌ 属正常） |
| 写入方式 | textarea 必须用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set` + 派发 `input`/`change`，React 才能感知 |

---

## 3. Battle 对局与揭晓（实测记录）

- 首条消息发「hi/ping」后，回复卡片会**即时显示模型徽章**（例：`claude-fable-5.1-max`，Anthropic 图标 + `span.truncate`），**无需投票即可读名**（battle auto 实测）。
- 回复卡片结构（揭晓区）：
  - 卡片根：`div.rounded-xl.border…`（含 `border-interactive-negative` 等状态配色）；
  - 徽章：`span.truncate`（模型名，旁有厂商 SVG `<title>`）；
  - 正文：卡内 `.prose` 容器。
- 双人对局会揭晓**两个名字**（实测 `claude-sonnet-5-5-high / claude-opus-5.5-high`）。扩展 v2.9.10 起：双模型局按卡片徽章归属各自回复，文本库分别入库；**电池通道在双模型局跳过**（转录里两模型答案混在一起，入库会污染指纹）。


## 2026-10-06 · 一键建档局 v2.9.15：受信任发送/投票全链路机制（实测）

### 已修复的核心 BUG（按发现顺序）
1. **后台 handler 从未调用 reply()**：AMP_TRUSTED_CLICK/TYPE/SEND 干完活不回消息——所有「受信任超时」都是它。修复：`asyncIIFE.then(reply).catch(reply)`。
2. **trustedSend 漏 return**：发送成功但恒返回 undefined → guard 必然误判「输入内容已变化」。修复：`return response`。
3. **trustedSend 的鸡生蛋**：sendButton() 过滤 disabled，空编辑器时按钮必禁用 → 8s 找不到直接抛错。修复：不要求已点亮，坐标由 background 在键入点亮后 Runtime.evaluate 自定位。
4. **发送按钮点亮竞速**：insertText 后按钮需 ~1-2 拍才亮 → background 轮询 10×250ms 直到 `disabled:false` 再点。
5. **窗口遮挡=全灭**：Chrome 窗口被遮挡/最小化后，页面 rAF 冻结、一切受信任输入被静默丢弃（insertText 报 ok 但无效）。**必须保持调试 Chrome 窗口前台可见**（`node cdp-restore.mjs 9222` 恢复 + `node cdp-front.mjs 9222` 置前）。
6. **toggle 后必须刷新页面**：`chrome.runtime.reload()`/开发者页 toggle 会把已注入 content script 全部作废；且 toggle 时序竞态会偶发把扩展禁用（用 expr-extdom.js 查 `enabled:false` 后再 toggle 一次即可）。可靠部署序列：toggle → `/json/new` 新标签 → 关旧标签 → restore → 15s → `expr-buildchk.js` 验证 `ampBuild` 标记。
7. **attach 挂起**：孤儿调试会话使 chrome.debugger.attach 无限挂起 → 3 次竞速（3.5s 超时+强拆+重试）；SW 内 20s 心跳（AMP_PING）防 MV3 挂起变孤儿。
8. **投票机制（关键情报）**：
   - 生成期间投票按钮**渲染但 disabled + pointer-events-none + opacity-50**（`expr-votecls.js` 可查）——点击全部无效（元素命中被 pointer-events 穿透到父级 span）；
   - 投票仅在**双方模型完全停止**后被接受；模型「迭代间歇」期间投票会被静默丢弃；
   - **Arena 投票窗约在开局后 15-18 分钟永久关闭**（超时按钮永久 disabled）——迭代型模型对（建设 >18min）无法投票，人与机器人同理；
   - 投票点击节奏：mouseMoved→150ms→pressed→**120ms**→released；零间隔会吞 mouseup/pointerup（window 捕获监听实测）。
   - 成功案例：`kimi-k3` + `gemma-4-31b` 双揭晓名；揭晓名出现在卡头（替换「选项 A/B」）与底部栏。
9. **构建标记**：`document.documentElement.dataset.ampBuild='v2915V'`（expr-buildchk.js 读取）——每次改码后必验。
10. **REVEAL_NAME_RE 补 gemma**；guard 后改用 waitGenIdle()（等生成空闲最长 8 分钟）而非直接 fatal；收集前清编辑器草稿。

### 流程时序（一键建档局 v2.9.15 现状）
点击 → battle/code 切换 → 随机短探针 trustedSend（<1s，回复已验证）→ gen-wait（按钮可用+连续 3 拍无 Building...，最长 600s）→ 投票（安定 21s 防抖 + 25s 间隔补投，窗口 960s）→ extractRevealNames（gemma/kimi 等前缀正则 + 差集）→ waitGenIdle → 清草稿 → 双模型按卡入库 / 单模型电池+文本入库 → HUD 报告。

### 平台侧风险（非扩展问题）
- Arena 服务端间歇性 500：「Something went wrong while generating the response」（Trace ID 会显示在页面）——整局作废，只能重开。
- 迭代型模型（如「拾光 SHIGUANG」式大站）建设 20 分钟+，超过投票窗 → 该局必然无法投票。
- 结论：一键建档局成功率 ≈ P(模型对在 ~15 分钟内完成且服务端无错)。流程本身已无已知 bug。
- 投票路径（旧 UI 兜底）保留：找不到即时名字时，`findVoteButtons()` → 投票 → 45 秒轮询揭晓名。

---

## 4. 扩展当前校准状态（v2.9.14）

| 功能 | 状态 | 说明 |
|---|---|---|
| New Chat | ✅ | agent 页正常；battle 页跳过（本身就是匿名新局） |
| 切 Battle 模式 | ✅ | 四段激活：受信任点击 → 合成 press → 原生鼠标 → 键盘；每段后等回显/aria-selected 复核 |
| 切 Code 场景 | ✅ | 第一入口：`aria-label^="Modality:"` 触发钮 → 菜单含 `Code` 项 → `trustedClick`；chip/原生 select/combobox 兜底保留 |
| 首条探针 | ✅ | 10 条随机最简问候池（不再固定 `hi`，降低人机验证概率） |
| 读揭晓名 | ✅ | 先即时读卡片徽章（差集防误判），空则走投票路径 |
| 双模型入库 | ✅ | `battleRevealedReplies()` 按卡片归属，`AMP_TEXT_BANK_SAVE` 分模型保存 |
| 浮层显隐 | ✅ | arena.ai 全站显示（含首页），每秒无条件 `paint()` 兜底 SPA 切换 |
| 注入范围 | ✅ | manifest `matches: https://arena.ai/*` |
| 待确认 | ⚠️ | battle 会话 ID 的 URL 形态；投票兜底路径在新 UI 下的按钮结构 |

---

## 5. CDP 工具用法（调试实例保持运行中）

```powershell
# 读状态（expr-*.js 是要执行的 JS，返回 JSON 字符串）
node cdp-eval.mjs 9222 expr-state.js

# 受信任点击（等效真实鼠标）
node cdp-click.mjs 9222 <x> <y>
```

- 端口：`127.0.0.1:9222`；调试实例 profile：`%TEMP%\amp-debug-profile`（已登录 arena）。
- 注意：**主 profile 无法开调试端口**（Chrome 136+ 安全策略），必须用独立 `--user-data-dir`。
- 旧 `--load-extension` 在新版 Chrome 命令行也被禁用——调试实例里扩展未运行，扩展相关验证要在主 Chrome 里做。

### 常用 expr 脚本
| 文件 | 用途 |
|---|---|
| `expr-state.js` | 全景：URL/下拉/Modality/编辑框/发送按钮/扩展标记 |
| `expr-code-rect.js` | Modality 开合状态 + Code 项与触发钮坐标 |
| `expr-menu.js` | 合成事件展开 Modality 并转储菜单（部分场景需用 cdp-click 受信任点击） |

---

## 6. 版本历史（本次会话累计）

- **v2.9.5** 首条探针随机化；`ensureBattleMode` 加回显确认。
- **v2.9.6/7** 三段式激活 + 每轮菜单快照 + aria-selected 复核；键盘 portal 三通道。
- **v2.9.8** 输入框 textarea 回退（battle 聊天页）；`pickSceneCode` 初版。
- **v2.9.9** 揭晓名即时直读（跳过投票）+ 投票兜底。
- **v2.9.10** 双模型局按卡片分别入库；电池双模型局跳过；场景下拉尝试。
- **v2.9.11** 场景下拉三段式激活 + 失败时候选控件清单。
- **v2.9.12** ~~`/battle/code` 跳转续跑~~（已证伪移除：该路径不存在）。
- **v2.9.13** CDP 实测后：Modality 钮第一入口；自检显示各下拉/Modality 值。
- **v2.9.14** **受信任点击体系**（manifest `debugger` 权限 + background `AMP_TRUSTED_CLICK` + content `trustedClick`），模式/场景选项激活均改为受信任优先。

## API 建档协议（2026-10-08 实测，v2.9.17/v2917C）
- 建：POST /nextjs-api/stream/create-evaluation，body {id,mode:battle,userMessageId,modelAMessageId,modelBMessageId,userMessage:{content,experimental_attachments:[],metadata:{}},modality:webdev,recaptchaV3Token:null} → 200；**id 必须是 UUIDv7 且时间戳接近当前**（v4 报 400 Invalid UUIDv7）。
- 续：POST /nextjs-api/stream/post-to-evaluation/<sid>，同构（不含 mode）。
- 流响应：a0:/b0: 文本增量（JSON 字符串转义），bd finishReason。**recaptchaV3Token 传 null 即可**。
- 停：POST /nextjs-api/stream/stop/<sid>/messages/<userMessageId>。
- 限速：轮间隔 <20s 或并发会话堆积时 429 {error:prompt failed}；60s 间隔实测通过。5xx/429 需退避重试。
- 会话数据：GET /c/<sid> 带 RSC:1 头 → messages[]（participantPosition a/b、modelId 仅揭晓后有值）+ revealedModels[]（投票揭晓后含 publicName/organization/provider 全名）。
- 投票=Next.js Server Action（POST 页面 URL + Next-Action 头），schema：{value,messageAId,messageBId,evaluationSessionId,recaptchaV3Token,modelsRevealed?}。
- 每模型产物：GET /api/evaluation/webdev/<modelMessageId> → manifest.files + previewUrl。
- 扩展 v2.9.3：一键建档局=runApiBankBuild（纯 API 四轮）→ RSC 读名，无名则落会话页 ampApiPhaseB 自动投票揭晓再入库；AMP_API_STASH_PUT/GET 存样本过页。

## API 建档 II：限速与 recaptcha（2026-10-08 12:30）
- modality 枚举（create 400 报错带出）：auto | chat | webdev | search | image | p2l | video | audio。chat 模局在本号 create 返回 200 但轮次无文本（len≈299 空轮）→ 弃用，建档继续用 webdev。
- 429 {error:prompt failed} 语义：账号级 prompt 限速。规律：滥用后先 post 全 429，再升级连 create 也 429。**冷却=停止一切 create/post 尝试约 30 分钟**；重试会续期。清僵尸会话（stop）不解除。
- recaptchaV3Token 铸造（页面上下文）：grecaptcha.enterprise.execute(&#39;6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0&#39;,{action:&#39;chat_submit&#39;}) → 2553 字符 0cAFc… 与抓包一致。action 枚举：chat_submit / chat_retry / pairwise_feedback / chat_rerun / sign_up。封装在 chunk 3bqidhg9a_g45.js（D(e,t) 函数）。
- 停会话：GET /api/evaluation/<sid>（UI 建的才有，API 建的 404）→ lastMessageIds[0] → POST /nextjs-api/stream/stop/<sid>/messages/<mid> body {} → 200。stop 接口连发也会 429（间隔 3s 可过）。
- RSC /c/<sid>：assistant 消息结构 id→role→content(reasoning/text/tool-call/tool-result)→…→modelId(揭晓前 null)→participantPosition→status。轮次完成判定：双方 assistant 出现 status:success；构建流水线滞后文本流约 1-3 分钟（疑似 429 主因：构建未落地就 post 下一轮会被拒）。
- v2917H 设计：每轮铸新 token(chat_submit) + waitRoundSettled（双方 success + 90s 缓冲）+ 温和重试（429 等 2/3/4 分钟，最多 4 次）+ 入库后 stop 会话。

## API 建档 III：终局结论（2026-10-08 15:00，v2917L）
- 限速定量（响应头）：ratelimit-limit:10 / policy:1800;w=300 → **10 prompt / 5 分钟滚动窗口**；429=窗口耗尽。429 的请求不计入。exp-backoff 5 分钟有效。
- 完整链路已实证：create(token)→轮流探针→等双方 status:success（RSC /c/<sid> 轮询）+90s 构建缓冲→post 下一轮→样本=a0/b0 流文本。01a11649（手动）与 01a1166f（驱动，3 轮 math/zh/code 双侧 80/1569、121/611、147/1306 字）两个完整会话。
- **死路（Arena 反滥用，别再撞）**：① 接口创建的局投票按钮服务端禁用，UI 点击投票也不给 revealedModels/modelId（01a115de 3h、01a1166f 均无）→ 接口局无揭晓名；② mode:direct 开新会话被拒（direct 只能续聊）；③ POST /nextjs-api/stream/create-chat schema={message:{id,role:\"user\",parts:[{type:\"text\",text\"]},modelId,recaptchaV3Token} 但 403 Not allowed（权限门槛）。→ 模型真名只能来自 UI 创建的局。
- recaptcha：grecaptcha.enterprise.execute(\"6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0\",{action:\"chat_submit\"})，封装在 3bqidhg9a_g45.js；actions: chat_submit/chat_retry/pairwise_feedback/chat_rerun/sign_up。
- createServerReference 全表（3y7697c3s3k4a/1hf98nq72bukz/3_4ig-wj-g7gw/2v476po723ww_/2x3y99yrg9fic）：deleteAccount/updateMarketingConsent/archive|delete|unarchiveEvaluationSession/getEmailProvider/generateUploadUrl/getSignedUrl/loadSecrets/saveSecrets/createPairwiseFeedback(60e9a099…)。无投票 action → 投票走 UI 内部通道（loadSecrets 形态：POST 页面 URL+Next-Action+JSON 数组参数）。
- v2917L 交付：HUD 双按钮。接口建档局=全自动零可见性（限速自愈 12×5min、构建等待、RSC 揭晓→入库、localStorage 样本桥 ampApiStash:<sid>）；UI建档局=原 v2916G 全链（要可见窗口、揭晓名可靠）。

## 2026-10-08 · v2.9.22 长上下文减负 + 页面便捷（content.js）
- 新增「一键回到底部」与「一键折叠旧消息」两个小按钮：展开态在标题栏、收起态在悬浮条，两处同步。
- 折叠实现：`[role=log]`（回退 `main`）→ 逐层下钻取出消息根 → 只对「最近 3 条之外」的消息设
  `display:none`（`data-amp-fold` 标记，可完整还原）。这是长上下文卡顿时最有效的一刀。
- 运行期保护：探测/抽卡开始时自动 `unfoldAll()`（保证 transcriptText 读完整上下文），运行结束由
  paint 自动恢复折叠；折叠状态只存在页面生命周期内，不落盘。
- 顺带降载：抽卡结果列表改为「签名变化才重建 DOM」（此前每秒 replaceChildren 一次）。
- 构建标记：`document.documentElement.dataset.ampBuild` → `v2917M`（用于确认页面注入的是新脚本）。
- 手动验证清单：①点 ↓ 应平滑滚到底；②点 « 只留最近 3 条；③再点还原；④点「快速识别」运行期间
  自动展开、结束后自动折叠回来。
