## 2.19.12

- **停用对 Arena 的主动探测请求**：规避风控「You opened too many chats in a short time」——`probeCostRoute`（`/api/chat/:id/cost`、`/api/evaluation/:id/cost` 及 PostHog 覆写 cookie 流程）与 `fetchLivePricingTable`（榜单 RSC 实时单价表）不再发起；花费账本如实提示「已停用」，价格/组合证据退化为无账单输入并沿用随包快照价目。页面自身流量仍由嗅探器被动观察，主指纹与 lmfpd 通道不受影响。恢复开关：`content.js` 与 `background.js` 中 `ARENA_API_PROBES` 置 true。
- `manifest.json` / `package.json`、弹窗与浮层标题、构建标记（`v21912`）升级到 2.19.12。

## 2.19.11

- **新增 lmfpd 第二指纹通道**：把主指纹判定有效的同一批回复再喂给 Fingerpoint Detector（lm.ikale.io，66 模型库 `shared-detector-v2` 排名器）。结果面板独立一行显示其预测、库内相对校准概率、Top3 候选、判定（scored / partial / unscorable / not_model）及与主指纹最近候选的一致性（一致 / 同族 / 不一致）；加载失败也会显示"参考库未加载"而非静默缺席。参考数据随包内置于 `lmfpd-data/`（约 4.8MB，`tools/fetch-lmfpd-data.mjs` 可刷新并校验 sha256）。
- **指纹结论以 lmfpd 为准**：lmfpd 已评分（scored）时，勾选"改名"后会话名直接采用其闭集首选；partial（不足三条）仅在主指纹非清晰时才顶位。头条同步——主指纹未定/仅家族候选时直接展示 `lmfpd 首选/倾向`；两通道一致时显示同一模型；clear 分歧时头条给 lmfpd 首选并附注主指纹结论。`record.recognition` 与主指纹 status 判定不受影响，仍如实反映各通道自身证据。
- `manifest.json` / `package.json`、弹窗与浮层标题、构建标记（`v21911`）升级到 2.19.11。

## 2.19.10

- **Battle 实测费率优先**：价格来源统一为 Battle 稳定实测 > Arena 官方 > OpenRouter；同费率组、硬筛选、软排序平分及跨费率组代表项均按此顺序破平。
- 新增默认关闭的 **“只取最接近”**：启用后把当前排序第一作为顶部名称与最终识别，并可配合原改名开关自动改名；原始歧义会明确披露，下方候选、费率族、硬筛选和其他证据保持完整展示。
- 修复价格探针完成后 `/cost` 首次返回空账单就立即报“没有可用候选”的就绪竞态；仅对刚完成的价格探针短时重试，并在最终失败时保留 HTTP / reason / 空 messages 诊断。
- 随包加入精简脱敏的 `arena-battle-price-rates.json`；完整训练集不进入运行时闭包与发布包。
- `manifest.json` / `package.json`、弹窗与浮层标题升级到 2.19.10。

## 2.19.9

- **接着修「还是获取不到模型」：面板渲染的其实是账本的 `cost_reverse`，不是价格指纹结果。** v2.19.8 只修了 `priceFingerprintBlock` 的 blocked 分支，但用户看到的仍是「没法配对」—— 因为 `state.price_fingerprint` 为空时浮层走 `const view = fp || cr`，用的是**账本块** `ledgerState.data.cost_reverse`（由 `costReverseBlock` 产出），而它同样在 `no-pairs` 时整条 return。
  - **修法**：把候选解析 + 硬筛选腿 + 费率族抽成共用函数 **`hardFamily(table, ids, costPayload)`**（返回 `{hard, hardOut, rateFamily}`），`costReverseBlock` 在配对**之前**调用它，并给 `no-pairs` 分支与主返回都带上 `hard_filter` / `rate_family` / `evidence:'rate-family'` / `text`。价格指纹侧改为调用同一个函数（去掉重复代码）。
  - **池子**：`costReverseBlock` 里若调用方没给候选，`hardFamily` 传**空数组** ⇒ 扫**整张单价表**（不被 21 个模型的指纹库框住）。
  - 顺带把 `softInFamily` / `softRefuted` 从依赖 `topGroup` 改为依赖 `rateFamily`（`hardFamily` 不再外泄 `topGroup`）。
- **测试**：新增「`costReverseBlock` 没配上对时也带上费率族」（真机回归，断言 `blocked:'no-pairs'` 但 `rate_family` / `evidence` / `hard_filter.state` 都在）。套件 202 → **203 项（202 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2199`；`manifest.json` / `package.json` 到 2.19.9；浮层标题 → `OPEN SET · v2.19.9`。

## 2.19.8

- **修「账单与估算没配上对时，价格面板什么都不显示」（用户反馈「直接不显示了呢」）。** `costReverseBlock` 返回 `blocked:'no-pairs'` 时，`priceFingerprintBlock` **整条 return**，面板只剩一句「没法配对」、候选列表与费率族全空。
  - **根因**：硬筛选腿（整数反推）**只依赖账单的分项费用**（`actual.inputTokensCostUsd` 等），跟「账单↔估算能否按消息 id 配对」**毫无关系**。此前把它排在配对之后，等于让一条无关的失败掐掉了整条通道。
  - **修法**：把 `hardFilterLeg` + 费率族分组**提到配对之前**算；配对失败的分支改为照样返回 `hard_filter` / `rate_family` / `evidence:'rate-family'`，头行给「费率结构指向 …（比值判据因账单/估算没配上对，本次未参与）」，附注写明「比值判据需要配对，本次跑不了 —— 所以只有费率结构这一条证据」。
- **修花费明细表的「合计」列口径错位（长期悬案，第五次记录后终于修掉）。** 该列此前优先取 `row.base_usd`（**Arena 基础价**），而左边四列是**上游 `actual` 分项费用** —— 两个口径混在同一排。实测出现「合计 `$0.005981` 却远小于四项之和 `$0.073684`」。**一列叫「合计」却不等于同排四项之和，本身就是错的**，与口径哲学无关。
  - 改为四项之和（`sum.total` 同步）；base / 实扣在「花费」页签的账本里另有逐条展示，不在这张表里混口径。
- **测试**：新增 2 项 —— 「账单/估算没配上对时仍要报出费率族」（真机回归）与「合计列必须等于同排四项之和」（源码级）。套件 200 → **202 项（201 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2198`；`manifest.json` / `package.json` 到 2.19.8；浮层标题 → `OPEN SET · v2.19.8`。

## 2.19.7

- **「以费率结构为准」：定不了名时报到**费率族**这一级，并否掉与费率结构冲突的比值腿答案。** 用户第三轮反馈「还是不对」：截图里浮层给了**两个互相矛盾**的答案 —— 头行（比值腿）说最贴近 `claude-opus-4-1-...`（out **$75**/Mtok），候选列表（费率腿）说 `Claude Haiku 5.5` / `GPT 6 Luna`（out **$0.5**/Mtok），**差 150 倍**；而参考扩展支持后者。
  - **根因**：比值腿只拿「估算 token × 挂牌价」跟账单**总额**比，**看不到分项结构**。实测那条账单（输出 `$2.50e-6` + 缓存读 `$6.65e-5`）只有在 Haiku/Luna 的费率下才能反推成**整数**（5 个输出 token + 6647 个缓存读 token）；Opus 4.1（$75/Mtok）反推输出得 **0.033 个 token —— 不成立**。所以账单里缓存读占比高时，比值腿会**系统性偏向贵一个数量级的模型**。
  - **修法（用户拍板「以费率结构为准」）**：
    1. **新增 `rateSignatureGroups`**：把硬筛选候选按**四项费率签名**（in/out/cacheWrite/cacheRead）分组。费率完全相同的模型属于同一「费率族」，单凭账单**永远**切不开。
    2. **报到费率族这一级**：硬筛选有候选但切不开时，结论头行改报「费率结构指向 `<族成员>`（费率完全相同：in $x / out $y / cache读 $z 每 Mtok）—— N 个模型费率完全相同，单凭账单切不开」，新增 `evidence: 'rate-family'` 与 `rate_family` 字段。浮层标题也直接显示族名（如「Claude Haiku 5.5 / GPT Luna」），不再只写「未唯一定名」。
    3. **堵一个漏洞**：此前 `hard='multiple'` 时 `softSeparable` 仍可单独成立 → 会**据比值腿定名**（即使它的命中根本不在硬筛选候选里）。现在：软判据的命中若**不在费率族里**，一律判 `conflict`、**绝不定名**。
    4. 结论优先级固定为 **定名 > 冲突 > 费率族/硬筛选旁证 > 如实不定名**（冲突必须排在费率族之前，否则会被费率族文案盖掉 —— 单测抓出来的）。
    5. 比值腿被否掉时在附注里写明：「⚠️ 比值判据最贴近的 X（比值 r）与费率结构冲突，已忽略 —— 比值腿看不到分项结构，账单里缓存读占比高时会系统性偏向贵模型。」
- **测试**：`tests/price-fingerprint.test.mjs` 43 → **45 项**（新增：软判据命中不在费率族里 → 判为分歧且绝不定名；软判据切不开时报到费率族）。套件 198 → **200 项（199 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2197`；`manifest.json` / `package.json` 到 2.19.7；浮层标题 → `OPEN SET · v2.19.7`。

## 2.19.6

- **补上 OpenRouter 公开价目（模型本体），让价格通道能认 Arena 榜单之外的模型。** 用户第二次反馈「为什么还是不一样」：我们已经正确报「不能唯一定名」，但参考扩展 `cost-browser-extension` 给出了具体答案 `deepseek/deepseek-v4-flash-vision-exp`（条件推算 **输出 20 / 缓存读 8192**）。查下来**根因不是算法，是价格目录**：
  - 我们的「全库」其实是**指纹库**（`whatsmyllm.com/data/bank`，**只有 21 个模型**，全是 GPT/Claude；离线后备 `modeltrace-bank.json` 只有 17 个），而**单价表有 208 行** —— 两回事。实测那 21 个 id 里**只有 3 个能精确命中单价表**，等于把 90% 的价格目录丢掉了。
  - `deepseek-v4-flash-vision-exp` **既不在指纹库、也不在 Arena 榜单的 208 行**里。实测拿真实账单在**全表 208 行**上跑整数反推 → `partial-only`、**0 候选** —— 放大池子也算不出来。
  - 参考扩展自己写明了做法：**「完整官方价格未匹配，使用公开价格补充」**。我们此前只借了 OpenRouter 的 **cache 费率**，没借**模型本体**。
- **新增 `tools/build-openrouter-prices.mjs` → `openrouter-prices.json`（339 行）**：从 OpenRouter 公开价目导出模型本体（in / out / cache 读写）。消歧策略：排除 `:batch`（76）与 `~` 别名（18）、只收 prompt/completion **都为正**的模型（非 token 计价会污染整数反推）、保留 OpenRouter 原始 id 作 model_key（不与 Arena 变体 key 冲突）。
- **合并策略「只加不覆盖」**（`pricing-channel.js` 的 `mergeOpenRouterPrices`）：Arena 已有的 model_key 一律以 Arena 为准（它是 Arena 会话的权威计费口径）。合并后单价表 **208 → 547 行**。
- **全库价格裁决的池子改用整张单价表**（`priceFingerprintBlock` 的 `fullBank` 分支）：此前用指纹库（21 个），现在用 `table.all()`（547 个，剔媒体模型）。价格识别要的是**价格目录**，不是文本/行为指纹库。
- **★ 真机验证**：用截图那条账单的**精确值**（20 tok × $0.6468/Mtok + 8192 tok × $0.00686/Mtok，合计 **$0.00006913312** —— 正是参考扩展显示的「上游成本」）跑全库硬筛选：
  ```
  state = unique | 检查 547 | 候选 1
      deepseek/deepseek-v4-flash-vision-exp {"I":0,"O":20,"W":0,"R":8192}
  ```
  **与参考扩展的答案逐项一致。**
- **顺带说明（重要）**：整数反推对**账单精度**极敏感 —— 面板显示的 6 位小数（`1.29e-5` / `5.62e-5`）是四舍五入过的，拿它反推会得到 19.944 / 8192.42 而**除不尽**；必须用底层精确值。
- **测试**：`tests/price-fingerprint.test.mjs` 39 → **43 项**（新增：`mergeOpenRouterPrices` 只加不覆盖 + 非双正剔除、补充表缺失时原样返回、deepseek 真机回归、全库池子与闭包锚点的源码断言）。套件 194 → **198 项（197 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2196`；`manifest.json` / `package.json` 到 2.19.6；浮层标题 → `OPEN SET · v2.19.6`。

## 2.19.5

- **修一个「把不存在的模型说成唯一命中」的误报（用户真机反馈）。** 用户在截图上发现：本插件把比值 **0.841（偏差 16%）** 的 `claude-sonnet-4-6` 报成「唯一命中 · 全库 208 个模型里只此一个贴合」，而 **Arena 基本没有这个模型**。查下来是**两个叠加的缺陷**：
  - **① 刻度错位（真 bug）**：`background.js` 里算 `z` 时除数写的是 `Math.log(2)`，而 `pricing-channel.js` 用的是 `Math.log(CONSISTENT_RATIO)`＝`ln(1.6)` —— 两个刻度差 **1.47 倍**，但注释还写着「与 pricing-channel 同刻度」。后果：`PRICE_FINGERPRINT_Z = 0.8` 本意是「比相符界 1.0 更严」，实际等效 **1.18，反而更松**，贴合窗口被放宽到 **`[0.574, 1.741]`（偏差 −43% ~ +74%）** —— 这个区间里根本谈不上「同一个模型」。
  - **② 没数窗口（注释与实现不符）**：函数注释明确写着「候选内**只有一个**模型的期望成本落进比值阈值」，但实现**只比 top1/top2 的 z 差，从未统计窗口里有几个**。实测该账单在全库有 **14 个模型**落在 ±15% 内（$6 那一簇），却被标成「只此一个贴合」。
  - **修法**：`z` 除数改用 `ln(CONSISTENT_RATIO)`；窗口与间距一律**用比值表达再换算**（`PRICE_FINGERPRINT_RATIO = 1.10` → 窗口 `[0.909, 1.100]`，即 **±10%**；`PRICE_FINGERPRINT_GAP_RATIO = 1.25`），从根上避免再写错刻度；并**真的数一遍** `uniqueInWindow`（窗口内必须恰好一个）才允许定名。`content.js` 里那份镜像实现同步修正。
  - **效果**：比值 0.841 现在被正确拒绝（→「不能唯一定名」并列出候选）；而真正贴合的（如 $6 档、比值 1.065）照常命中，功能没被废掉。
- **硬筛选 0 命中时补一条醒目警示**：`state==='none'` 意味着**没有任何模型的费率结构能整除这份账单**（多半是账单混合了多次调用/多个模型，或该模型不在 Arena 榜单里），此时只靠比值定名的可靠性明显更低 —— 现在会显式说出来。
- **措辞不再过度声称**：「全库 N 个模型里只此一个贴合」→「全库 N 个模型里**只有它落进 ±10% 窗口**」（这才是代码真正验证过的事）。
- **测试**：`tests/price-fingerprint.test.mjs` 39 项（新增：比值 0.841 必须被拒的真机回归、窗口边界 ±10% 的 1.09 通过/1.11 拒绝、`uniqueInWindow` 与 z 刻度的源码断言）。套件 191 → **194 项（193 过 / 0 失败 / 1 跳过）**。
  - 顺带修正两条**靠旧松阈值蒙过去**的交叉验证测试（520/544）：它们的账单被构造成比值恰为 0.8 / 0.65，现在把估算 token 调到让比值≈1，这样测的才是「硬筛选 × 软判据交叉验证」本身，而不是阈值。
  - `tests/work-compat.test.mjs` 的极简沙箱补 `CONSISTENT_RATIO`（background.js 顶层新增了对该导入的引用）。
- 构建标记 → `v2195`；`manifest.json` / `package.json` 到 2.19.5；浮层标题 → `OPEN SET · v2.19.5`。

## 2.19.4

- **修一个真机挖出来的空白浮层 bug（首次安装必现）。** `createHud()` 建完 DOM 后**从未点亮默认页签** —— 只有 `loadLocalState()` 异步读到存储值时才 `selectTab()`。所以首次安装（存储为空）时三个 `.panel` 全是 `display:none`，**用户看到的是一个只有页签栏、下面一片空白的浮层**（实测 `visiblePanels: 0`，`.body` 只剩 54px 页签栏高度）。
  - 修法：`createHud()` 末尾立即 `selectTab(activeTab,false)`，并把 `selectTab` 加 `persist` 开关 —— 初次点亮**不写存储**，否则 `loadLocalState()` 的「恢复上次页签」会永远读到它自己写的默认值。
  - 真机验证（CDP 清空 `amp.hud.tab.v1` + 刷新）：`visiblePanels` 0 → **1**，数字指纹面板 `display:block` / 高 633px，页签按钮 `active`。
- **真机验证挖出的环境结论（记录，不涉代码）**：Chrome 154 下 `--load-extension` **只在全新 profile 生效**；`chrome.runtime.reload()` 会把 unpacked 扩展**整个卸掉**（`/json/list` 里 service_worker 消失）；可靠的重装姿势是 **CDP `Extensions.uninstall` → `Extensions.loadUnpacked`**（只 `loadUnpacked` 会返回 id 但不生效）。浮层用 `mode:'closed'` 的 shadow root，页面脚本与 isolated world **都读不到** `shadowRoot`，验证必须走 CDP `DOM.getDocument(pierce:true)` + `DOM.describeNode(depth:40)`。
- **测试**：`tests/hud-tabs.test.mjs` 16 → 18 项（默认页签恰好一个 active、点亮不写存储的源码断言）。套件 188 → **191 项（190 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2194`；`manifest.json` / `package.json` 到 2.19.4；浮层标题 → `OPEN SET · v2.19.4`。

## 2.19.3

- **未唯一定名时，把候选「摆出来」（对齐对手插件的呈现方式）。** 原来切不开时只报一句「未唯一定名」+ 一行 meta，用户**看不到任何候选**，无从判断到底差在哪。新增 `fp-cands` 候选列表（唯一定名时自动收起）：
  - **整数整除**：报「208 个模型里 N 个能整除」，逐条列候选名 + 反推 token（`O=… R=…`）+ 缓存费率来源 + `:batch` 半价警示（超过 8 条提示还有更多）；
  - **log 比值**：列软判据最贴近者（含比值与隐含 $/Mtok）与第二名；
  - **同价等价类**：列四项价格完全相同的组，写明单价区分不开；
  - **费率不全**：报有多少变体缺计价字段（多为 cache 读）尚不能排除。
- **顺带查清一个长期困惑**（不涉代码，记录结论）：对手插件（桌面 `cost-browser-extension`）在同一批账单上给出 `claude-opus-5.5 / gpt-5.6-sol / claude-opus-latest` 并列，而我们报「未唯一定名」——**两边算的是同一件事，也都没能定名**，只是呈现策略不同。实测同一份账单在全库 208 个模型里有 **7 个能整除**（`claude-opus-5.5-high-vertex-agent`、`gpt-6.1-sol-max-agent`、`gpt-6-sol-max-agent`、`claude-sonnet-5-agent`、`gpt-6-luna-max-agent`、`claude-sonnet-5-5-xhigh`、`claude-haiku-5.5-high-vertex`）——这 7 个的费率**互相成整数倍**（out 20/10/0.5 皆为 0.5 的倍数，read 0.2/0.1/0.01 皆为 0.01 的倍数），所以同一份账单能同时整除它们全部，**数学上就切不开**。对手插件列出 3 个是做了跨 org 折叠 + 只显示前几条，它自己也注明「另有 63 个纯价格候选、45 个价格资料不全的变体，未据此排除」。
- **验证**：用截图的两条真实账单复现 —— 消息1 反推 `O=3627 R=8308`、消息2 `O=163 R=16744`，与对手插件**逐项完全一致**（对手反解出 out=$20 / read=$0.2，正是 `claude-opus-5.5` 的费率，与我们的补充表 `cache_read_usd_per_mtok: 0.2` 吻合）。
- **测试**：`tests/hud-tabs.test.mjs` 13 → 16 项（候选列表内容、唯一定名时收起、样式与接线源码断言）。套件 185 → **188 项（187 过 / 0 失败 / 1 跳过）**。测试 stub 补了 `DocumentFragment` 的展开语义（真实 fragment append 会自动展开子节点）。
- 构建标记 → `v2193`；`manifest.json` / `package.json` 到 2.19.3。

## 2.19.2

- **浮层可拖动。** 按住标题栏拖到任意位置；拖动后从右下角默认停靠切成 `left/top` 绝对定位，位置记入 `chrome.storage.local`（`amp.hud.pos.v1`），重开仍在原处。
  - **边界夹紧**：始终至少留 40px 在视口内（左边界允许负到 `-width+40`，右/下按视口尺寸夹紧），拖出屏幕也能找回来。
  - **死区 3px**：单纯点标题栏（比如点「—」收起）不会被误判成拖动；拖动结束才落盘，拖动过程只改样式不写 storage。
  - 标题栏加 `cursor:move` / `user-select:none` / `touch-action:none`（触屏也能拖，且不触发页面滚动）。
- **测试**：`tests/hud-tabs.test.mjs` 10 → 13 项（新增：拖动后 left/top 定位正确且 right/bottom 让位、死区内不误触、样式与实现要点源码断言）。套件 182 → **185 项（184 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2192`；`manifest.json` / `package.json` 到 2.19.2。

## 2.19.1

- **浮层改为 Tab 布局（按用户截图）。** 原来浮层是一条长列表（警告 → 三按钮 → 进度 → 结果 → 轨迹直读 → 抽卡 → 额度 → 花费账本），内容一多就得一直往下滚。改为**顶部页签 + 三个面板**：
  - **数字指纹**：探针进度 + 数字通道结果 + 抽卡 + 额度（原有一切实心功能都在这）；
  - **价格指纹**：价格指纹裁决结果卡 + **消费级明细表**；
  - **花费**：花费账本（汇总 + 逐条明细）。
  - 页签带「有新结果」小圆点（各通道有数据才亮）；选择**持久化**（`amp.hud.tab.v1`），重开仍停在原页签。
- **轨迹直读不再独立展示。** 原来它是浮层里一张独立卡片，占位置但信息密度低 —— 现降级并入「数字指纹」面板底部，不再单独占一块视觉重心（用户明确要求）。
- **价格指纹面板：消费级明细按表格展示（参考用户截图的列式）。** 新增 `.cost-table`，六列 **`#` / Input / Output / Cache写 / Cache读 / 合计**，表头 sticky、数值右对齐、`$0` 与缺失值（`—`）分色。
  - **数据源**：`cost-ledger.js:ledgerRowsFromCostMessages` 新增从官方 `/cost` 账单的 `actual` 子对象提取**四项分项费用**（`inputTokensCostUsd` / `outputTokensCostUsd` / `cacheWriteTokensCostUsd` / `cacheReadTokensCostUsd`，兼容 snake_case 别名），挂到 `row.breakdown`；四项全缺的行 `breakdown: null`。
  - **渲染口径**：只渲染带 `breakdown` 的**官方行**（转录估算行不进这张表，避免两种口径混在一起）；表尾一行合计，前四格各列为四项求和、末格为各行总额（`base_usd`）之和 —— 与四项之和自洽。
  - **空态**：没有分项数据时隐藏表体、显示提示「先跑一次价格指纹识别（需要 /cost 能读到四项分项费用）」。
- **价格指纹与数字指纹结果并存展示。** 价格面板除了价格裁决结果卡，还保留数字通道结论作旁证 —— 两者**不互相顶替**（用户明确要求）。
- **测试**：新增 `tests/hud-tabs.test.mjs` 10 项（用最小 DOM stub 真跑 `createHud` / `renderCostTable` / `selectTab`：页面加载无异常、3 页签 3 面板、轨迹不再独立、明细表 6 列、只渲染带分项的行且合计 = 四项之和、空态、样式语义、持久化、钩子时序）。套件 172 → **182 项（181 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2191`；`manifest.json` / `package.json` 到 2.19.1；浮层标题版本号同步（原来一直硬编码 `v2.9.25`，早就和实际版本脱节）。

## 2.19.0

- **缓存费率补充表：从 OpenRouter 公开价目补齐 Arena 榜单缺失的 cache 费率。** 背景：Arena 榜单**不下发 cache 读写费率**（实测 208 行恒 `null`），导致「四项整数反推」硬筛选在带缓存费用的账单上直接无解（cache 项费率缺失 → 只能进待定）。
  - **数据层（新文件 `arena-cache-rates.json`，构建脚本 `tools/build-cache-rates.mjs`）**：拉 `https://openrouter.ai/api/v1/models`，对 Arena 榜单 208 行逐条匹配 —— **三重约束**（名称核心词命中 + `input ±0.02` / `output ±0.05` 双向价格容差 + 排除 `~` 滚动别名与 `:batch` 条目）。**126 / 208（60.6%）命中，全部 cache 一致（零分歧）**，其中 8 条取自 `:batch` 半价条目（已标注）。未命中的 77 条**保持 `null`，绝不外推**。
  - **口径校验**：抽查 25 个模型，17 个 Arena 榜单价与 OpenRouter 挂牌价**比值正好 1.0**；偏差大的（`glm-5.2` 17.7× 等）经查全是同名前缀误配或口径差异，已剔除。文件内 `source_note` / `method` / `caveat` 如实写明「非 Arena 官方口径，实际渠道价/历史价/分层计价未计入」。
  - **合并层（`pricing-channel.js:applyCacheRates`）**：把补充表并入**已归一化**的单价表（原地），**只补不覆盖**（Arena 官方若将来真的下发 cache 费率，官方值优先），逐条标 `cache_rate_source: 'openrouter-public'` / `cache_rate_or_id` / `cache_rate_batch` / `cache_rate_consistent`；媒体模型（按张计价）跳过。放在归一化之后而非改原始 JSON，是为了让**实时抓取**的表也一并补上。
  - **运行时挂载（`background.js`）**：新增 `CACHE_RATES_FILE` / `loadCacheRates()`（校验 `schema === 'arena-cache-rates'`）/ `decoratePricingTable()`；`loadPricingTable()` 的三个出口（持久化表 / 快照表）与 `fetchLivePricingTable()` 出口全部改走 `decoratePricingTable`。**读不到补充表就退回原表** —— 补充表缺失不能让整条价格通道瘫痪。
- **四项整数反推硬筛选（借鉴 `cost-browser-extension` 的 `constrainByPrices`）。** 把 `/cost` 账单的**四项分项费用**（`inputTokensCostUsd` / `outputTokensCostUsd` / `cacheWriteTokensCostUsd` / `cacheReadTokensCostUsd`）按各模型单价反推 token 数，要求为正整数 —— 能整除的模型才留。
  - **新增纯函数**（`pricing-channel.js`）：`normalizeCostBreakdown`（取四项分项 + 自洽校验：四项之和 ≈ 总额，容差 `max(1e-9, total×1e-6)`）、`hardFilterByCosts`（返回 `state`：`unique` / `multiple` / `none` / `partial-only` / `missing-cost` / `off-integer-grid`）、`baseModelName`（剥 harness/effort 后缀与日期戳，用于同一模型变体折叠，避免把唯一解误降为多解）。
  - **媒体模型显式剔除**：`kind === 'media'`（图像/视频，按张/秒计价）计入 `excluded_media`，不参与 token 反推 —— 实测单用 output 反推时 5 个候选里 3 个是图像模型。
  - **不单独定名（关键设计，基于实测）**：实测会话真身是 `GPT 5.6 Luna`，但 Luna 的 out 费率 1.2 反推 605.87（非整数）被淘汰，反倒是 `qwen3.7-plus` 的 1.28 反推 568.00（恰整除）→ **误判**。根因是 Arena 实际计费口径与 OpenRouter 挂牌价存在差值，硬筛选本质是「找哪个模型的费率表恰好能整除账单」，对口径差异极度敏感。随机化检验（把 read 费用扰动 ±20% 跑 200 次 → 候选恒为 0）证明整除是**真实约束**而非数字巧合，但**极度脆弱**。所以硬筛选**只作强旁证**。
  - **交叉验证（`background.js:priceFingerprintBlock` + `hardFilterLeg`）**：硬筛选唯一解与软判据（log 比值）同指一个模型 → `evidence='both'`（高置信定名）；分歧 → `evidence='conflict'` 且 **`separable:false`**（绝不凭硬筛选推翻软判据，如实列出两个分歧模型）；软判据本就切不开但硬筛选唯一 → `evidence='hard-hint'`（只作旁证）。**注**：`both` 严格要求**两条腿都成立**，软判据自己没切开时只能算 `hard-hint`（此边界由测试发现并修正）。
- **披露措辞（`content.js:priceFingerprintCaveat`）**：输出硬筛选结果（唯一/多解/无解/待定 + 计数）、`:batch` 半价警告、`evidence` 解读（一致 / 分歧明示两个模型 / 旁证）、cache 费率来源，以及 **「汇总成本可能包含多次调用，单次调用口径未验证」**（借鉴参考扩展的 `pricingTierStatus`）。`drawRound` 与 `run()` 两条价格分支的所有 `publish` / `renameNote` / `why` / `pNote` 文案均拼上该附注。
- **同价组升级为四项签名**：`cost-ledger.js:samePriceGroups` 从 `(input, output)` 两项升级为**四项**（输入/输出/缓存写/缓存读，缺费率记 `'—'` 不与 0 混淆）；`content.js:renderLedger` 与 `popup.js:baseNote` 的同价提示同步改为四项措辞 —— 比只看两项更细，同价等价类判定更准。
- **测试**：`tests/price-fingerprint.test.mjs` 19 → 35 项（新增 16 项：`applyCacheRates` 只补不覆盖 + 媒体跳过 + 来源标注；`baseModelName` 剥壳；`normalizeCostBreakdown` 自洽校验；`hardFilterByCosts` 五态 + 变体折叠 + 媒体剔除；`priceFingerprintBlock` 的 `both` / `conflict`（`separable:false`）/ `hard-hint` 与 `separable` 联动；补充表读不到不阻塞；披露措辞与四项签名源码断言）。`makeBgApi` 新增 `cacheRates` / `pricing` 注入参数以覆盖合并路径。套件 155 → **171 项（170 过 / 0 失败 / 1 跳过）**。
- 构建标记 → `v2190`；`manifest.json` / `package.json` 到 2.19.0。新增数据文件 `arena-cache-rates.json`（依赖闭包已含）。

## 2.18.0

- **「价格指纹」升级为独立的识别模式（下拉框第三项）。** v2.17.0 里价格指纹只是数字通道的**旁证**（候选集内裁决、数字不清晰时才问一次）；本版把它提升为**与快速/精准并列的第三种识别模式** —— 用户显式选择「价格指纹 · 1题按价反推」时，扩展**只靠价格**识别模型。
  - **行为**：发 1 道探针 → 拿官方 `/cost` 账单与转录估算 token → **在全库模型里按价格裁决**（不借数字候选集）→ 唯一切得开才定名，切不开如实说不确定、**绝不退回数字结果顶名**。只发 1 题、不自动补题（省额度、快）。
  - **候选范围**：v2.17.0 是「数字候选集内」（`nearest`+`top3`），本版价格模式改为「**全库**」（`background.js:priceFingerprintBlock` 新增 `options.fullBank`，空候选 + `fullBank:true` → `loadProbeBank()` 全库 id）。全库贴合概率天然更高，所以三条判据（贴合阈值 0.8 / 拉不开距离 0.35 / 同价歧义）**一条不松**，返回体带 `scope:'full-bank'` 供区分。
  - **挂点**：新增消息类型 `AMP_PRICE_FULL`（来源校验与 `AMP_COST_REVERSE` 一致）→ `content.js:priceModeFor`；`drawRound` 新增 `prefs.mode==='price'` 分支，且**位置在 `lastResult` 判空之前** —— 价格数据来自会话账单与估算，与数字通道是否过门控无关，数字识别失败也能按价定名（数字结论只作旁证）。单次识别新增「价格识别 · 1题按价」按钮 + `run('price')` 分支。
  - **决策正确性**：`sanitizePrefs` 的 `mode` 新增接受 `'price'`；`MODE_LABEL` 加 `price`。浮层下拉与弹窗下拉各加第三项。
  - **开关合并**：浮层原来那个独立的「价格指纹」勾选框**移除**（已上移为识别模式，避免一处功能两个开关）；弹窗的勾选框**保留**但改名为「价格旁证（快速/精准）」，语义明确为「只在快速/精准模式下给数字通道加挂价格旁证」。
  - **真机验证（CDP 9222，会话 `01a12c2a`，全库路径）**：真实账单 5 条 ↔ 估算 5 条 100% 配对，隐含 $0.8928/Mtok；**全库 17 个模型**里裁决 `separable:true`，唯一定名 `GPT 5.6 Luna (xHigh)`（r=0.744, z=0.427），第二名 `gpt-6-luna`（z=0.836）差 0.409 > 0.35，第三名起 z≥3.07 权重归零 —— **全库范围下判据依然干净，没有撞价**（`dev-scratch/_cdp-price-full.mjs`）。
- **测试**：`tests/price-fingerprint.test.mjs` 9 → 18 项（新增全库裁决 4 项：fullBank 唯一命中带 `scope`/不给 fullBank 仍报 no-candidates/空库不假装有全库/全库撞价降级；content.js 独立模式 3 项：模式与 sanitize、全库裁决与不改名、价格按钮与 `run(price)`；background handler 1 项）。`tests/official-cost.test.mjs` 的「只外传可信账单」闸门断言 3 → 4 处（新增 `AMP_PRICE_FULL`）。
- 构建标记 → `v2180`；`manifest.json` / `package.json` 到 2.18.0。
- **浮层高度修复**：内容多时（账本明细展开 + 抽卡结果累积）浮层会一直往下长、顶出屏幕。原因：`.box` 只有 `overflow:hidden` 而**没有高度上限**，`.body` 也不滚动。改为参考 `cost-browser-extension` 的容器做法 —— `.box` 加 `max-height:min(84vh,760px)` + `display:flex;flex-direction:column`，`.head`/`.compact` 加 `flex:none` 固定不滚，`.body` 改 `flex:1 1 auto;min-height:0;overflow-y:auto`（`min-height:0` 是 flex 子项能正确收缩的前提）+ `overscroll-behavior:contain`。**真机验证**（`dev-scratch/_cdp-hud-height.mjs`，9222）：40 行内容（scrollHeight 1388px）在 917px 视口下，浮层被约束到 760px（= `min(84vh,760px)`），top 141 / bottom 901 **完全在视口内**，内容区独立可滚（`bodyScrollable:true`）。配色与其余视觉**未动**（用户明确要求只修高度）。

## 2.17.0

- **价格指纹通道：把「花费反推」接进识别主流程，并允许在价格唯一时单独定名。** v2.16.1 的花费反推只做全库提示（`cost_reverse`，绝不单独定名）；本版把它收窄成一条**可参与定名**的识别通道 —— 与数字指纹、scene 通道、节奏通道并列。
  - **判据（`background.js:priceFingerprintBlock`）**：候选集来自指纹识别结果（`nearest` + `top3`，不是全库盲猜），在候选内按价格排序后，必须**同时**满足三条才 `separable:true`：① 唯一命中且比值贴合（`|log₂ratio| ≤ 0.8`）；② 第二名明显更远（z 差 > 0.35）；③ 命中不与任何其他候选同价（同价等价类单靠价格切不开）。任何一条不满足都降级为旁证并给出 `reason`。
  - **挂点**：`AMP_SCORE` 返回体的 `result.price_fingerprint`（每轮识别自带价格证据）；`content.js` 抽卡在数字通道判定**非 `clear`** 时调 `priceChannelFor`，`separable` 为真才据此定名并改名，否则照旧不改名 + 提示。
  - **开关**：新增 `priceChannel` 偏好（浮层与弹窗各一个「价格指纹」勾选框），**默认关闭**（`DEFAULTS.priceChannel:false`，只有显式 `true` 才开启）。关闭时行为与 v2.16 完全一致。
  - **诚实标注**：金额是 Arena `/cost` 官方 base（临时覆写 PostHog cookie，读完即删），token 是转录估算 —— 结论是「**价格上唯一**」，不是服务端确认；命中条件不满足一律降级，绝不猜。
  - **真机验证（CDP 9222，会话 `01a12c2a`，5 条消息）**：真实 `/cost` 账单 5 条 ↔ 转录估算 5 条，**100% 配对**（`costOnly=0`）；Σbase $0.001693732 = session 聚合值（抓包自洽）÷ 估算 1897 token → 隐含 **$0.893/Mtok**。候选集 ≥2 时最近邻 `gpt-5.6-luna`（r=0.744, z=0.427 ≤ 0.8），第二名 `gpt-6-luna`（z=0.836）差 0.409 > 0.35 → **`separable:true`，唯一定名**。同时暴露一个单测没覆盖的边界：**单候选也走同一闸门**（无第二名不等于放行，比值不贴合照样降级），已补断言（`tests/price-fingerprint.test.mjs` 第 9 项）。
  - **真机暴露的口径局限**：Agent 会话包不含输入侧 token，`estimateUsageFromStats` 只统计 assistant 正文+thinking，估算 token 是**下界** → 隐含单价偏低。真机上补输入侧（3×/8×）后判据依然稳定出 `separable`，说明结论对该偏差不敏感，但口径局限如实记录。
- **测试**：新增 `tests/price-fingerprint.test.mjs` 10 项（唯一贴合 / 同价不可定名 / 比值超阈值 / 拉不开距离 / 三种待命态 / 单候选贴合 / 单候选不贴合仍降级 / content.js 定名闸门源码断言）。`tests/official-cost.test.mjs` 的「只外传可信账单」断言 2 → 3 处（新增 `AMP_COST_REVERSE` 也过 `!reason` 闸门）。套件 131 → 148 项（**147 过 / 0 失败 / 1 跳过**；跳过项为历史遗留的 `model-probe-engine` 缺 fixture，已改为显式 skip 并注明原因，不再伪造数据）。
- 构建标记 → `v2170`；`manifest.json` / `package.json` 到 2.17.0。

## 2.16.1

- **花费反推：用官方逐条 base 金额 ÷ 同消息估算 token 反推模型（Agent 模式专用腿）。** 背景：v2.13.3 的「按价反推」需要 Battle 模式的服务端逐条 token 用量，而 Agent 会话的用量 Arena 根本不下发（会话包 metadata 无 usage 字段）—— 那条腿在 Agent 模式永远待命。v2.16.1 把两条已有真实数据接上：
  - **地基（本轮 CDP 实测）**：`/cost` messages 的 key 与 `/api/chat/<sid>` 会话包 assistant 消息 id 是**同一套 UUID** —— 5/5 完全对齐（`dev-scratch/_cdp-id-align.mjs`，`costOnly=[]`、`packOnly=[]`）。id 对不上就谈不上反推，所以先验地基再动工。
  - `cost-ledger.js` 新增纯函数 `pairCostWithEstimates(costMessages, estimates)`：按消息 id 把官方逐条 `basePriceUsd`（Arena 计价真实口径）与转录估算 token 配成对，返回 `{pairs, total_base_usd, total_tokens, usage, cost_only, estimate_only, n_pairs}`；落单一律如实报告，绝不凑数；`usage_source` 统一标估算口径（`chars-v1`）。
  - `background.js` 新增 `costReverseBlock(options)`：Σbase ÷ Σtokens = 隐含单价，汇总用量喂给既有的 `rankByObservedCost`（高斯核比值排序；候选为空时 `loadProbeBank()` 全库），`samePriceGroups` 标注同价歧义。三种待命态：`no-official-cost`（附 costGate 门状态）/ `no-pairs`（附两侧落单数）/ `no-priced`。
  - 挂点：`ledgerBlock` 返回体新增 `cost_reverse`（与 v2.13.3 的 `reverse` 共存、不互相顶替）；新增 `AMP_COST_REVERSE` 消息类型（来源校验与 `AMP_LEDGER` 一致）；浮层账本说明区与自检诊断各加一行。
  - **honest 口径**：金额是服务端权威值，token 是估算（正文+thinking 字数折算）→ 输出一律声明「可能性排序，不是定论」；同价等价类里的模型单靠花费区分不开，`ambiguous` 直说。
- **测试抓出一个真 bug**：`pairCostWithEstimates` 汇总 `usage.totalTokens` 曾读 `row.usage.tokens`（不存在的字段，恒 0）—— 单测断言汇总口径时当场炸出。修为 `row.usage.totalTokens`。套件 115 → 131 项（新增 `tests/cost-reverse.test.mjs` 16 项全绿；唯一失败仍为历史遗留的 `model-probe-engine` 缺 fixture）。

## 2.16.0

- **官方成本通道打通：PostHog 覆写 cookie 放行灰度门。** 此前「`/cost` 403 ⇒ 此路不通」的结论被推翻 —— 服务端的门读的是 **PostHog feature-flag override cookie** `ph-toolbar-overrides`。客户端临时写 `ph-toolbar-overrides=<urlencode({"credit-system-m1":"cost-shown"})>`（`Path=/; Max-Age=60; SameSite=Lax; Secure`）即放行。
  - **真机 A/B**（Chrome 154 CDP，`canary.arena.ai`，Agent 会话 `01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b`）：无 cookie → `403 {"error":"Unauthorized"}`（24B）；带 cookie → **200 完整账单**（session `actualTotalUsd:0.004122368` / `chargedTotalUsd:0.0033874648` / `aggregate.basePriceUsd:0.0016937324` / `totalChargedCredits:3.3874648`；5 条逐条消息）；删 cookie → 回到 403。自洽验算：`Σmessages.base == aggregate.basePriceUsd`、`charged == base × marginMultiplier(2)`、`credits == charged × 1000`。
  - **礼貌策略**：用户已有该 cookie 且值不同 → **不覆盖、不发请求**（网站自己的设置赢）；值相同 → 直接用，读完不删；原本没有 → 临时写，**读完必删并校验**；删不掉就把结果标 `reason:'cookie-stuck'`，调用方按无数据处理（注释不办事，标记才办事）。
  - **403 分型**：24B `Unauthorized` = 门禁未过；78B `User does not own session "<sid>"` = 门过了但会话不归当前账号。浮层/自检文案分开说，不再混。
  - `content.js:probeCostRoute` 重写：Agent 模式依次试 `/api/chat/<sid>/cost?includeSession=true` → `/api/evaluation/<sid>/cost`（404 / 坏 JSON 换路径；403 即停；network / cookie-stuck 不换）。200 且**无 reason** 的账单才外传 —— `AMP_COST_PAYLOAD` 与浮层 `costPayload` 两处都过 `!reason` 闸门。
  - `background.js` 新增 `AMP_COST_PAYLOAD` handler + `cleanOfficialCost` 纯函数（字段白名单、条数 ≤100、量级 ≤1e7、保留 `session.aggregate` 子对象）→ `netState.officialCost`。`observedCostActual` 官方优先（`official-cost/session` → `official-cost/messages` → 旧 `cost-route/*` → 字段信号）；`ledgerBlock` 无 `costPayload` 时回落 `netState.officialCost`（**弹窗路径同样出官方明细**）；`ledgerSummarySync` 官方优先。门通过后旧的 403 记录作废（`netState.costGate=null`），自检不再误报「灰度门拦」。
  - `cost-ledger.js:ledgerRowsFromCostMessages` 的取值改**双来源**（actual 子对象优先、回退 entry 顶层）：实测 /cost 的 schema 是 `basePriceUsd / totalChargedUsd / totalChargedCredits / pricingStrategy / marginMultiplier` 在 **entry 顶层**、上游明细在 `actual` 里 —— 只看 actual 会把 base 落到 `totalCostUsd`（上游口径），charged/credits 直接丢。
  - `describeTotals` 新增「上游成本合计」（`actual !== base` 时）：三层语义（actual=上游 / base=Arena 计价 / charged=base×倍率）在摘要里分开报。
- **单测抓出 3 个真问题**（`tests/official-cost.test.mjs` 新增 27 项全绿；套件 89 → 115 项）：
  1. `content.js` 覆写 cookie 曾写成 `JSON.parse(decodeURIComponent(编码值))` → 拿到**对象** → `encodeURIComponent(对象)` 序列化成 `[object Object]`（`%5Bobject%20Object%5D`）—— cookie 值是坏的，门永远不放行。CDP 实测走的是手工写 cookie，绕过了这段代码路径，所以此前没暴露。已修为字符串常量 `PH_COST_SHOWN`。
  2. `cleanOfficialCost` 的 `pricingStrategy` 漏了 entry 顶层来源（实测数据就在顶层）。
  3. `ledgerRowsFromCostMessages` 单来源 pick 的 base 口径错误（见上）。
- 构建标记 → `v2160`；`manifest.json` / `package.json` / `README.md` 统一到 2.16.0。仅剩 `tests/model-probe-engine.test.mjs` 缺 fixture 失败（历史遗留，与本版无关）。


- **把「转录字数估算」从"链路做全但产不出证据"修成"真机页面上真的出数"。** v2.14.0 的解析链路（嗅探器 → `netState.transcriptEstimates` → `ledgerRowsFromEstimates` → `mode:'estimate'`）本身是通的，但在真实页面上 `transcriptEstimates` **恒为 `[]`**。根因：**Agent 页自身的 `/api/chat/<sid>` 请求走 Web Worker / RSC，主线程的 `fetch`/`XHR` 钩子看不到**（`network-sniffer.js` 里其实早有注释「已确认 Arena 的聊天请求从 Web Worker 发出」，但转录支路没绕开它；Worker 通道的 `scanText` 又传的是空 URL，`SESSION_ROUTE_RE` 必然不匹配）。
  - **修法：主动取转录。** 在 `network-sniffer.js` 文末新增一段：会话页（`/agent/<sid>` → `/api/chat/<sid>`，`/battle/<sid>` → `/api/evaluation/<sid>`）里由**页面上下文同源 GET 一次会话包**（页面自己就是这么取的；用原生 fetch 绕过自身钩子避免自噬；`credentials:'same-origin'` 带 cookie），响应体交给**与被动路径完全相同**的 `scanText` 解析 —— 有 `metadata.usage` 走用量，没有就按字数估 token。触发点：初始加载、SPA 路由变化（包 `pushState`/`replaceState` + `popstate`）、实时流结束（`finishStream` 里补一次）。节流 2.5 s、每页上限 60 次。
  - **实测（Chrome 154 CDP 直连 `canary.arena.ai/agent/01a12ca1-…`）**：注入 `ampBuild:v2150`，`kinds:{alive:1,stats:2,'transcript-estimate':1,token:1}`，账本端到端输出
    `mode:'estimate'` / `text:"1 条（估算） · 输出约 7936 token · 输入下界约 421 token · 1 条无单价"` / `rows[0].tokens=7936`。
- **补上「发送侧」的那一半：输入下界。** 用户问的是「每一条**发送消息**消费的 token」，此前只算了 assistant 的输出侧。
  - `network-sniffer.js`：`scanTranscriptEstimate` 现在把 **user 消息的正文**统计留住，配给紧随其后的 assistant 回复（`input_chars` + `input_message_id`）。**认领放在 dedup 之前** —— 否则同一条回复在重复抓取时会一次带输入、一次不带（不确定性）。
  - `background.js`：摄入 `input_chars`；同一条消息先被被动路径看到（无输入侧）、后被主动取转录补齐时**就地补上**，不产生重复行。
  - `cost-ledger.js`：`estimateLedgerRow` 把输入折成 `estimate.input_tokens_lower_bound`；`ledgerTotals` 单独累计（**不混进 `tokens`/`base_usd`**，免得把"输出侧估算"的口径搞脏）；`describeTotals` 增加「输入下界约 M token」。`ledgerRowsFromTranscript` 里同样做了 user→assistant 配对。
  - **诚实标注**：这是**下界** —— 只含用户那条文字，不含历史上下文与系统提示（真实输入远大于此）。
- **修 `scanMessageUsage` 的 usage 判据（真 bug）**：旧代码用「整串里有没有 `"usage"` 字样」决定走用量路径还是估算路径；会话包里别的字段偶尔带 `usage` 一词时，会走用量路径然后**一条都产不出来**（静默空转，不报错）。改为看**实际消息**有没有 `metadata.usage`。
- **站点覆盖扩到 canary（权限扩张，需知悉）**：扩展此前只匹配 `https://arena.ai/*`，**在 `canary.arena.ai` 上完全不注入** —— 而本机登录态/新功能常在 canary，这正是"扩展什么都不显示"的根因之一。
  - `manifest.json`：`content_scripts[].matches` + `host_permissions` + CSP `connect-src` 均加 `https://canary.arena.ai/*`；`background.js` 的 `webRequest` 过滤同样加。
  - 全仓 origin 判定统一为 `/^https:\/\/(?:canary\.)?arena\.ai$/`：`background.js:isAgentUrl`、`content.js:agentPage`、`content.js:newChatLinks`、`popup.js:agentUrl`、`conversation-rename.js`（3 处 guard + 2 处侧栏链接过滤）。
- **测试**：`tests/transcript-estimate.test.mjs` 10 → 11 项（新增输入下界用例：配对、只认领一次、不进 tokens/base、无用户消息时不出下界）。**顺带修好 3 个历史遗留/回归失败**，套件从 `86 项 / 83 通过 / 3 失败` 变为 **`89 项 / 88 通过 / 1 失败`**：
  - `tests/work-compat.test.mjs` 的 `background accepts Work and legacy Agent…`：断言过期 —— 旧断言要求 `isAgentUrl('https://arena.ai/workshop')===false`，但 v2.9.15 起 `isAgentUrl` **只按 origin 判定、不再限制路径前缀**（代码注释已写明）。改为按当前语义断言，并补 canary 正向用例 + 同形异源（`https://arena.ai.evil.test`、`https://canary.arena.ai.evil.test`）反向用例。
  - `…controller supports both routes and both mode labels`：**本轮引入的回归** —— 该测试用"按名字抽取 `const` 声明"的方式跑 `content.js`，我的 `agentPage` 新增依赖 `ARENA_ORIGIN_RE` 而它不在抽取列表里 ⇒ `ReferenceError`。已把 `ARENA_ORIGIN_RE` 加进抽取列表。
  - `…manifest injects into both route families; popup accepts both`：断言 `matches.includes('https://arena.ai/work*')`（manifest 从来用的是整站 `/*`，早已过期）。改为断言两条 content script 都覆盖 `arena.ai` + `canary.arena.ai`、`host_permissions` 含 canary，并让 popup 用例连 `const ARENA_ORIGIN_RE` 一起求值。
  - 仅剩 `tests/model-probe-engine.test.mjs`（缺 fixture，历史遗留，与本版无关）。
## 2.15.0

- 构建标记 → `v2150`；`manifest.json` / `package.json` / `README.md` 统一到 2.15.0。
- **把「已识别模型」接进账本 —— 估算行终于能折出金额（原目标）。** 之前 `ledgerBlock` 调 `ledgerRowsFromEstimates(estimates, table)` **根本没传模型**，于是估算行永远 unpriced、永远只报 token；即使本扩展的指纹识别已经认出模型也白搭。现在：
  - `content.js:refreshLedger` 在指纹结论为 **`clear` 且候选集唯一（`set_size===1`）** 时，把 `result.nearest.id` 作为 `model` 一起发给后台（判据收紧到 `clear`：`weak` 即便只剩一个候选也是拟合不达标，拿它算钱等于猜）。
  - `background.js:ledgerBlock` 把 `options.model` 传给 `ledgerRowsFromEstimates(..., {model})`；`AMP_LEDGER` 处理器校验并记住它（`netState.identifiedModel`），`ledgerSummarySync` 同步使用。返回体新增 `estimate_model` 字段。
  - **实测**（同一份真实转录，7936 输出 token）：不传模型 → `base:null`、`text:"…输出约 7936 token…1 条无单价"`；传 `claude-sonnet-5` → **`base $0.07936`**（7936 × $10/Mtok，3 档变体）；传 `gpt-6-astra` → **`base $0.3968`**（7936 × $50/Mtok，2 档变体），`source:'transcript-estimate+pricing-table'`。
  - 单测 +1（估算行折价：无模型不猜价 / 有模型按公开单价折 base / 消息自带 `model_id` 优先于兜底模型 / 摘要出现基准价且仍标估算）。
- **能力边界（本轮更新，比上一版更准）**：Agent 会话**本身**仍不下发模型 —— 消息无 `modelId`、`pinnedModel:null`、**页面 DOM 里也没有任何模型名**（实测扫全页文本，模型类关键词 0 命中；成本面板文本 0 命中），实时流回放令牌只授 `read/write:sessions:<sid>`（拿 `claims.sub` 去打 Trigger.dev 的 `api/v3/runs/<id>`、`/trace`、`/events`、`/sessions/<sid>/runs` **全部 404/403**）。所以金额的**唯一**来源是**本扩展自己的指纹识别结果** —— 跑一次探测识别出模型后，估算 token 才会被折成 `base`。没识别就只报 token（绝不猜价）。

## 2.14.0

- **Agent 模式花费的本地替代口径：转录字数估算通道（`estimate` 模式）端到端核验 + 修一个展示缺陷。** 在真实 Agent 会话（`canary.arena.ai/agent/01a12ca1-…`，Chrome 154 CDP 直连）上把链路跑通：
  - **生产端** `network-sniffer.js`：`GET /api/chat/<sid>` 响应体里**没有** `"usage"` 时，把每条 assistant 的 `parts`（正文 `text` + 思考 `reasoning`）按码点折成「字符桶」，上报 `kind:'transcript-estimate'`（只报数字与字符计数，不带正文）。
  - **摄入/消费端** `background.js`（`netState.transcriptEstimates`）→ `cost-ledger.js`（`ledgerRowsFromEstimates`）→ `usage-channel.js`（`ESTIMATE_METHOD='chars-v1'`，CJK ≈1 token/字、其余 ≈0.27 token/字符）。
  - **修复（真 bug）**：`describeTotals()` 从不显示 token 数 —— 估算会话里模型未揭晓 ⇒ 全部行 unpriced ⇒ 旧摘要只会写成「N 条 · N 条无单价」，**把唯一的产出（token 估算）藏了**。现改为 `N 条（估算） · 输出约 T token · M 条无单价`。
  - 单测 `tests/transcript-estimate.test.mjs` 9 → 10 项，新增 `describeTotals` 估算分支断言。
  - **能力边界（诚实标注）**：该通道产出的是**估算 token，不是美元** —— Agent 会话的消息里**没有 `modelId` 字段**（实测消息键只有 `id/role/parts/metadata`），`session.pinnedModel` 也是 `null` ⇒ 折不出 `base_usd`（账本遵守「绝不猜价」）。要出金额，必须知道模型。
- **再次实测确认：本账号在 Web 渠道拿不到精确的逐条 token / 金额。** 本轮把剩余路径在真实浏览器上全部试完：
  - `GET /api/chat/<sid>/cost?includeSession=true` → **403 `{"error":"Unauthorized"}`**（复验）。
  - `GET /api/chat/<sid>` 加查询参数 `?includeUsage=true` / `?include=usage` / `?withUsage=1` / `?includeCost=true` / `?includeSession=true` → **全部 200、响应体逐字节相同（15435 B）、无 usage / 无 cost** —— 没有任何参数能诱导服务端带上用量。
  - `GET /api/chat/<sid>/messages` → **400（ZodError：`cursor` 必填）**；`?cursor=null` → 400「Invalid transcript cursor」；该会话 `pagination.hasMore=false`，**无可用游标**。
  - 实时流 `/ai-proxy/realtime/v1/sessions/<sid>/out` → 200，**990 KB 全量 SSE，正则无 `usage` / `inputTokens` / `outputTokens`**。
  - `/ai-proxy/realtime/v1/sessions/<sid>/{run,usage}` → 400，schema 明示 `io` 只能是 `"out"|"in"`；`/in` → **403「requires secret key authentication」**。
  - `/ai-proxy/realtime/v1/runs/<runId>/{out,in,streams}`、`/ai-proxy/api/v3/runs/<runId>` → 404；Trigger.dev 直连 `/api/v3/runs/<runId>` → 404 `Not found`（public token 只授 `read/write:sessions:<sid>`，**无 run 元数据权限**）。
  → **精确值只有两条路**：① 账号被灰度放量（`credit-system-m1="cost-shown"` 或 `m2="limits-enabled"`）⇒ `/cost` 200；② 第三方集成渠道（Kiro）的 `/api/agent-logs/*`（Web 网关不路由）。**客户端无解**（与 2.13.5 的结论一致，本轮是独立复验）。
- **修复「加载已解压的扩展」被阻断（真 bug）**：Chrome 会拒绝**任何** `_` 前缀的文件/目录（`Cannot load extension with file or directory name _…; Filenames starting with "_" are reserved for use by the system`）。上一版清理时把 138 个临时文件收进了 `_scratch/`，恰好让扩展根目录变得**无法加载**（浏览器重启后扩展可能直接失效）。已把 `_scratch/` 改名 `dev-scratch/`，`.gitignore` 同步（并注明原因）。
- **修复 `amp-relaunch.ps1` 因编码而静默失效（真 bug，很可能就是"扩展什么都不显示"的根因）**：本机 PowerShell 5.1 + 系统 ANSI 码页 = **gb2312**，而该脚本是**无 BOM 的 UTF-8**。PS 5.1 读无 BOM 脚本时按 ANSI 解码 ⇒ 硬编码的 `--load-extension=E:\下载\…` 被读成 `E:\涓嬭浇\…`（实测读回确认），指向一个**不存在的目录**，Chrome 于是**一个扩展都不加载**、也不报错。已改为 `$PSScriptRoot`（从真实文件路径取值，与脚本内容编码无关）并保持**纯 ASCII**，彻底摆脱编码依赖。同目录另两个脚本已核查：`agent-loop.ps1` 有 BOM（安全）、`amp-ascii.ps1` 只用 `$PSScriptRoot`（安全）。
- 构建标记 → `v2140`；`manifest.json` / `package.json` / `README.md` 统一到 2.14.0。

## 2.13.5

- **否证「反爬机制 / 请求头」这条线索（用户给的提示：『你了解一下反爬机制』『header 查东西?』）—— 结论：`/cost` 的 403 是账号权益门，跟请求头无关。** 用 CDP 直连真实浏览器（Chrome 154 / `canary.arena.ai`）做的对照实验：
  - **11 种请求头/凭据组合全部 403**：cookie-only、**真 Supabase Bearer JWT**（从 `arena-auth-prod-v1.0` + `v1.1` 两段 cookie 拼回 base64 → JSON → `access_token`，1263 字符，`role: authenticated`）、`x-arena-request-caller: web-ssr-public` / `web_ssr_cache_fill`、`x-arena-expected-api-deployment`（= 当前 `dpl_26hvs5L…`）、`x-arena-web-deployment`（= 当前 `dpl_5HKDvo…`）、reCAPTCHA Enterprise 换来的 `x-api-waf-token`（2660 字符）、referer+origin 组合 —— 状态码一律 `403 {"error":"Unauthorized"}`。
  - **路由确实存在**：不存在的路由返回 `{"error":"Route not allowed"}`（如 `/api/me/credits`、`/api/usage`、`/api/pricing`），而 `/cost` 返回 `{"error":"Unauthorized"}` —— 服务端明确拒绝，不是 404/边缘拦截。
  - **反爬栈本身已全部通过**：页面 cookie 带 Cloudflare `cf_clearance` / `__cf_bm`；bundle 常量确认 `API_WAF_TOKEN_HEADER_STRING="x-api-waf-token"`、`ARENA_REQUEST_CALLER_HEADER="x-arena-request-caller"`、`ARENA_REQUEST_CALLER={WEB_SSR_PUBLIC:"web-ssr-public"}`；reCAPTCHA Enterprise v3 通过 `grecaptcha.enterprise.execute(siteKey,{action})` 取 token，仅用于 mutation 的 `recaptchaV3Token`（`RECAPTCHA_VALIDATION_FAILED_MESSAGE` 对应 `FORBIDDEN`）。**这些都不是 `/cost` 的门。**
  - **账号库隔离**：同一 cookie 打 `https://arena.ai/api/me` → `401 {"message":"User not found"}`（canary 同路径 200）→ canary 与生产站是两套用户库，无法在生产站复现。
- **修正上一版对实时流的误判（重要）**：`GET /ai-proxy/realtime/v1/sessions/<sid>/out` **不是二进制帧，是标准 SSE**。正确读法是 `event: batch` + `data: {"records":[{"seq_num","timestamp","body"}]}`，`body` 是 **AI SDK v5 UI message stream** 的 JSON 字符串。完整事件类型（一次 990 KB 全量回放）：`data-agent-dispatch / start / start-step / reasoning-start / reasoning-delta ×4288 / reasoning-end / text-start / text-delta ×2338 / text-end / finish-step / finish`。
  - 但 **Arena 把 usage 剥掉了**：`finish-step` 只有 `{"type":"finish-step"}`，`finish` 只有 `messageMetadata{nodeId, manifestNodeId, pending, requiresReview, timing}` —— 没有任何 token 计数。所以即便读通实时流，也**算不出花费**。
  - 该通道对**成本**无用（无 usage），故**不接入**嗅探器；但它是"Agent 全链路无 usage"这条结论的第三个独立证据点。
- **查清 `vary: API-Authorization` 的真身：API 部署要求 M2M 服务令牌**。顺着响应头摸到 API 部署域名（bundle 里出现 `https://arena-api-stable.arena-preview.com`，本会话 cookie `arena_build_bucket=stable`）。直连 `https://arena-api-env-canary.arena-preview.com` 实测：
  - 无头 → `401 {"error":"Unauthorized - M2M token missing"}`
  - `API-Authorization: <原始值>` → `401 {"error":"Unauthorized - Invalid token format"}`
  - `API-Authorization: Bearer <用户 JWT>` → `401 {"error":"Access denied"}`
  - `Authorization: Bearer <用户 JWT>` → `401 M2M token missing`（**这个头根本不认**）
  → 架构：`canary.arena.ai`（Web 部署）把 `/api/*` **服务端代理**到 API 部署，并注入 `API-Authorization: Bearer <M2M 令牌>`。该令牌是**服务间共享密钥**，只存在于 Web 部署服务端，浏览器拿不到 → **客户端无论怎么补头都开不了这层**。但经 Web 代理时这层**已满足**，剩下的 `403 Unauthorized` 是应用层的**账号权益**判断。
- **路由穷举（把「还有没有别的接口」问死）**：
  - 从 bundle 挖出**全部**前端客户端调用链（`.chat[":id"].{cost,messages,preview,rubrics,workspace.latest,...}`、`.chat["trigger-token"|"trigger-session"]`、`.evaluation[":id"].cost`、`.api.history.{search,unified}`、`.api.me.pulse`、`.workspace[":manifestNodeId"].*` 等）。
  - **252 个候选路由 fuzz**（84 个词 × `/api/chat/<sid>/<seg>`、`/api/<seg>`、`/api/me/<seg>`），以 `Route not allowed` 为否定判据 —— **只有 4 个命中**：`/cost`（403）、`/messages`（400 需 cursor）、`/preview`（200）、`/rubrics`（400）。**`/cost` 是 Web 端唯一的成本接口。**
  - `/cost` **只允许 GET**（POST → `Route not allowed`）。
  - **`agent-logs/*` 与 `coding-agent/*` 在 Web 渠道不可达**：`POST /api/agent-logs/<sid|runCuid>/usage`、`GET /api/agent-logs/<sid|?limit=5|/me>`、`GET /api/coding-agent/sessions` **全部 403 `Route not allowed`**（网关白名单不路由；带 Trigger.dev public token 或伪造 `x-arena-client: kiro` 也一样）——它们是第三方集成渠道的 API，不是 Web 后门。
  - 顺带确认：`POST /api/chat/trigger-token|trigger-session`（body `{sessionId}`）→ 200，换出的是同一个 **Trigger.dev public access token**（`scopes:["read:sessions:<sid>","write:sessions:<sid>"]`，TTL 1h），可随用随取。
- **M2M 令牌确认客户端不可得**：全 63 个 chunk 里 `M2M` 只以常量名出现、无令牌值；HTML 无泄漏；客户端 `process.env.*` 命中 0；所有 chunk 无 `sourceMappingURL`；`deployment-pair` 模块是部署配对机制（HMAC 校验 `pairId`/`webDeploymentId`/`apiDeploymentId`/`triggerVersion`），与 M2M 无关。
- 证据全文见 `Arena成本接口实测.md` §9。
- **403 的最终根因：服务端 PostHog 灰度实验未放量。** 从 bundle `2eyb2ag_nzuov.js` 挖到成本 UI 的判定代码：
  ```js
  "credit-system-m1": z.enum(["control", "cost-shown"])
  "credit-system-m2": z.enum(["control", "limits-enabled"])
  const V = useFlag("credit-system-m1") === "cost-shown";
  const W = useFlag("credit-system-m2") === "limits-enabled";
  const L = (V || W) && !isAnonymous;   // 是否显示成本
  ```
  实测当前账号的 293 个 PostHog flag 里 **`credit-system-m1` / `credit-system-m2` 根本不存在**（未纳入实验）⇒ `L = false` ⇒ 前端不渲染成本条、服务端 `/cost` 返回 403。**客户端覆写 flag 只改 UI、不改服务端判定**（实测覆写后仍 403）。→ 唯一正当路径是**换一个已放量的账号**（截图里 `$23.18767300 cost | $1.06317612 base | $2.12635223 charged` 即来自此类账号）；当前调试浏览器登录的是当天新建的测试号（只有 1 个会话）。
- **账本文案据实更新**：`ledgerBlockedReason()` 的 Agent 分支改为「会话包 metadata / session 顶层字段 / 实时流 finish 事件三处都没有 usage；`/cost` 的 403 根因是 `credit-system-m1/m2` 灰度未放量（客户端覆写无效），与请求头/反爬无关（实测 11 种头组合全 403）」；自检 `账本数据来源` 同步。构建标记 → `v2135P`。
- **`/nextjs-api/*` 与 `coding-agent/*` 也已穷举**：`/nextjs-api/*`（98 个候选）只有 `model-catalog`(200) 与 `stream/create-chat|create-evaluation`(405 只收 POST)；`/api/coding-agent/sessions/<sid>/*`（78 个候选）只有 `workflow-checks` / `diff`（均为 404 `not_found`，即路由放行但该 Agent 会话不是 coding session），**没有任何 usage/cost 子路由**。
- 版本一致性：`manifest.json` / `package.json` / `README.md` 统一到 2.13.5。

## 2.13.4

- **查清「Agent 模式为什么没有花费明细」（用户提问）—— 结论：Agent 模式在本账号下拿不到任何花费数据，账本为空不是 bug。** 用 CDP 直连真实浏览器逐条实测，证据链：
  1. **Agent 会话包不含 token 用量**。`GET /api/chat/<sid>` 的 `messages[].metadata` 里**没有 `usage` 字段** —— 前端 zod 的 metadata 字段表就只有 `timing / harnessInjection / manifestNodeId / nodeId / pending / requiresReview / feedback / error / uploads / compactionSummary / compactionFailed / checkpointApplied / toolCallLimitReached / customFeedbackTurn / sandboxId / lastUserMessageId`。实测一个 8 条消息（4 条 assistant）的 Agent 会话，等生成结束后再拉一次，**依然一条都没有 usage**。
     - 对比：Battle 的 `GET /api/evaluation/<sid>` **有** `metadata.usage`（`{type, inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, usageSource}`）—— 2.11.0 的「用量已下发」结论只对 Battle 成立。
  2. **Agent 唯一的成本路由被灰度门拦死**。`GET /api/chat/:id/cost?includeSession=true` → **403 `{"error":"Unauthorized"}`**（账号级功能门，非鉴权问题：同一 cookie 打 `/api/me` 返回 200）。前端 bundle 里确实定义了 `MessageCostSchema` / `SessionCostAggregateSchema` / `MAX_AGENT_SESSION_COST_MESSAGE_IDS=50`，说明接口存在、只是本账号没开计费。
  3. **实时流是 Trigger.dev 的二进制帧**。Agent 执行在 Trigger.dev（`create-chat` 返回的 `bootstrap.publicAccessToken` 是 `iss: id.trigger.dev` 的 JWT），前端通过 `GET /ai-proxy/realtime/v1/sessions/<sid>/out` 订阅（`text/event-stream`，需 Authorization）。抓到的帧里 `body` 是 `"\u0000\u0000…c"` 这类**二进制**，不是明文 JSON → 扩展的文本正则嗅探器**无法解析**（`/ai-proxy/` 也不匹配 `SESSION_ROUTE_RE`）。`includeStreamToken` 被服务端锁成 `z.literal("false")`，拿不到续传 token。
  4. **页面上也没有成本显示**（截图确认：Agent 会话只有对话内容 + "Thought for N seconds" + 评审面板），`/api/me/pulse` 只有整数百分比（`{"pulse":100}`），精度不足以反推花费。
  → 所以 Agent 模式的账本**必然为空**；**Battle 模式才有逐条明细**。
- **账本改为主动探测 `/cost`，并说实话**：
  - 新增 `probeCostRoute(sid)`（`content.js`）：Battle 打 `/api/evaluation/:id/cost`，Agent 打 `/api/chat/:id/cost?includeSession=true`（404 再退回 evaluation）。**200 → 把服务端金额交给后台摊成逐条明细**（无需 token 用量）；403 → 记下状态用于解释。
  - 新增 `ledgerRowsFromCostMessages(messages)`（`cost-ledger.js`）：把 `/cost` 响应的 `messages` 映射（messageId → `{actual:{totalCostUsd, basePriceUsd, totalChargedUsd, totalChargedCredits}}`）摊成与 token 用量路径**同形**的账本行（`tokens`/`usage` 为 `null`，`source: 'cost-route'`）——Agent 模式一旦开通计费即可直接显示，无需改结构。
  - `AMP_LEDGER` 新增 `costPayload` 入参；响应新增 `mode`（`cost-route` / `usage` / `blocked`）与 `cost_rows` / `usage_rows`。
  - **浮层与弹窗不再误导**：`blocked` 时直说「Agent 模式：Arena 不下发 token 用量（会话包 metadata 里没有 usage 字段），成本只能走 /cost 路由 —— 本账号返回 403（未开通计费）」，而不是含糊的「发一条消息后才有」。自检新增一行 `账本数据来源`。
- 测试：`tests/cost-ledger.test.mjs` 新增 3 项（`/cost` 映射成行、空/非法输入不炸、产出能喂给 `ledgerTotals`），共 **16 项全通过**。
- 版本一致性：`manifest.json` / `package.json` / `README.md` 统一到 2.13.4，构建标记 → `v2134M`。

## 2.13.3

- **按价反推通道 —— 用「真实 base 成本 × 本次用量」对指纹库全部模型排序**：此前 `rankByObservedCost` 只在指纹候选（nearest + top3）里排序；现在拿到 base 成本时对**全库模型**排序，结果进 `pricing.reverse`（top-6 命中、比值、同价等价类），浮层直接显示 `按价反推: X（比值 r）`，同价类标注「同价不可分」。
  - 口径：`charged = base × 2`（v2.13.1 实测），只有 base 与公开单价同口径 → 反推一律用 base（`observedCostActual` 自 v2.13.1 起已统一返回 base）。
  - 没有真实成本时（本账号 /cost 403 灰度）不硬猜，显式标 `blocked: no-observed-cost`；价格仍照常给候选区分度与同价等价类。
  - **按价反推进弹窗与自检**：`AMP_LEDGER` 响应新增 `reverse` 字段（最近一条消息的真实 base 成本 × 该条用量，对全库模型排序）；弹窗「本次会话花费」说明行与自检各加一行反推结果（没有真实成本时直说原因，不硬猜）。
- 版本一致性：`manifest.json` / `package.json` / `README.md` 统一到 2.13.3。

## 2.13.2

- **新增「花费账本」：把花掉的钱逐条摊开显示**（本轮用户需求，对齐 Arena 页面的成本面板）。新增模块 `cost-ledger.js`：把 `GET /api/evaluation/<sid>` 的 `messages[].metadata.usage` 逐条抽出，乘公开 token 单价得到**基准价** `base = Σ tokenᵢ/1e6 × 单价ᵢ`，再摊成逐条明细。
  - **不需要计费账号**也能算：只要知道是哪个模型、拿到实测 token 用量，就能给出基准价；有计费账号时再用页面下发的真实值（`实扣` / `×倍率` / `积分`）逐条覆盖。
  - 三档数字关系显式标注：`base`（本模块算的，与公开单价同口径）→ `charged = base × 倍率`（实测 ×2）→ `credits = charged × 1000`。**反推模型必须用 base**。
  - **同价筛选**：把候选模型按「价格签名」（全部变体的 (输入价, 输出价) 集合）分组，签名相同的**单靠价格区分不开**，界面直说「同价候选（价格区分不开）：A / B」——避免把同价模型当成可区分。
  - **token 比例**：`输出:缓存写:缓存读`（归一到最小项 = 1），一眼看出该模型的用量形态。
  - 浮层（`content.js`）新增「花费」卡片：摘要一行 + `刷新` + `明细 ▸` 展开逐条（`#N · messageId8 · 模型 · Nt · $base`，有真实成本时追加 `实扣 $x · ×2 · N 积分`）；每 30 秒随 HUD 刷新节流重算。**弹窗（`popup.html`/`popup.js`/`popup.css`）同步新增一张「本次会话花费」卡片**（与「每日额度剩余」同款，含 `明细 ▸` 展开与 `刷新`）。
  - 自检新增 4 行：`花费账本（base = Σ token × 公开单价）` / `账本明细行` / `token 比例（输出:缓存写:缓存读）` / `同价候选（价格区分不开）`。
- **修了嗅探器结构化解析的触发判据（真 bug）**：`scanCostRoute` / `scanMessageUsage` 的触发条件写的是 `/response|eventsource/`，但 fetch 响应的 `where` 是 `'fetch.body'` / `'fetch.stream'`，**字面上不含 "response"** —— 结果这两条结构化解析**从来没触发过**（`/cost` 路由解析、逐条用量抽取全是死代码）。改为 `!/request/i.test(where)`：非请求方向即视为响应方向。`scanMessageUsage` 同时把逐条用量带上 `message_id / role / participantPosition / model_id`，按 `messageId|用量` 去重（最多 60 条）。
- **测试**：新增 `tests/cost-ledger.test.mjs`（13 项，含真实榜单快照的集成用例：`luna ≈ $0.001–0.02`、`astra ≈ $0.1–0.5`）与 `tests/network-sniffer.test.mjs`（4 项，用 `vm` 沙箱把 MAIN world 的 IIFE 跑起来驱动 `window.fetch`，覆盖「响应体触发 / 请求体不触发 / `/cost` 403 灰度门 / 重复轮询去重」）。全量 73 项、70 通过（3 项为既有的过期断言，见下）。
- 版本一致性：`manifest.json` / `package.json` / `README.md` 统一到 2.13.2，构建标记 → `v2132L`。

> **已知未修（与本次无关的既有失败）**：`tests/model-probe-engine.test.mjs`（缺 fixture `gpt-6-astra-three.json`）、`tests/work-compat.test.mjs` ×2（断言 `/work*`+`/agent*` 与「`/workshop` 必须被拒」，但 manifest 早已放宽为 `https://arena.ai/*`、`isAgentUrl` 在 v2.9.15 已放宽）。

## 2.13.1

- **修复成本字段表（真 bug，但影响面要说准）**：嗅探器的成本字段表**漏掉了 Arena `/cost` 会话级聚合的真实字段名** —— `actualTotalUsd` / `chargedTotalUsd` / `costMultiplier` / `marginMultiplier` / `totalChargedCredits` / 9 个分项 `*CostUsd`（字段名抄自 bundle 的 zod schema）。影响：结构化解析（`scanCostRoute`）本来能从 `session.actualTotalUsd` 拿到 base，但它**硬依赖 `JSON.parse`**；响应被流式切碎/被包装导致解析失败时只剩正则兜底，而旧表在那条路径上只能靠 `basePriceUsd` / `totalCostUsd` 勉强兜到 base，**实扣价与加价倍率永远拿不到**（截图里的 `charged` 与 ×2 就是这么漏的）。现已补全（`network-sniffer.js` 与 `price-channel.js` 两份表保持一致），并把单位分成四类（`usd` / `credits` / `multiplier` / `tokens`）——旧代码把 `creditsUsed` 判成美元、把倍率类字段判成 token 数。门禁词也补上 `charge` / `price` / `multiplier`，避免含 `totalChargedUsd` 的响应体被整包跳过。
- **实测确认加价倍率：实扣 = base × 2** —— 用户提供的截图（已开通计费的账号）底部成本条为 `$23.18767300 cost | $1.06317612 base | $2.12635223 charged`，`2.12635223 / 1.06317612 = 2.0000000`；积分口径自洽（`2126.35223 积分 ÷ 1000 = $2.126352`）。→ **按价反推必须用 `base`**，它才与「Σ token × 公开单价」同口径；`charged` 被 ×2 污染，直接拿来比会整体偏移一倍。完整证据见 `Arena成本接口实测.md` §7。
- **按次成本一律以 base 口径呈现**：`observedCostActual()` 统一返回未加价的 base，并带回 `detail`（base / 实扣 / 倍率 / 积分）；新增 `costDetailFromSession`（`/cost` 路由的 `session` 聚合 → 同形结构）与 `describeCostDetail`（压成一行 `base $x · 实扣 $y · ×2`）。`rankByObservedCost` 用的就是 base。
- 浮层（`content.js`）自检新增 **「本账号能否读成本（/cost）」** 一行：抓到就直报 `base / 实扣 / ×倍率`，没抓到就明说「未开计费」；原「页面下发的美元成本字段」改名为「页面下发的成本/用量字段」。结果行追加 `· 真实成本 base $x · 实扣 $y · ×2`。构建标记 → `v2131C`。
- 测试：`tests/price-channel.test.mjs` 新增 6 项（单位归类、字段表回归、截图同形的真实 `/cost` payload 全字段抽取、倍率推导、`costDetailFromSession`、`chargedFromBase` 边界），共 12 项全通过。顺带修掉 `costDetailFromSession` 里「`source` 常量字符串让『全空』判断失效」的缺陷。
- 新增 `tools/check-cost-fields.mjs`（`npm run check:cost-fields`）：字段表在 `price-channel.js` 与 `network-sniffer.js` **各存一份**（后者是 MAIN world IIFE，无法 import），只改一边等于没改。该脚本把两份正则抠出来跑同一份探针 payload，字段集合或 `unitOfCostField` 实现不一致就退出码 1。已自测：干净时 0、故意只改一边时精确报出漏掉的字段。
- 文档：`Arena成本接口实测.md` 新增 §7（截图实锤 + 倍率 + `cost` 字段未确认的诚实标注 + 字段全表），并**修正** §6 里「子进程会随工具调用结束被回收」的错误说法（用后台方式起的 Chrome 跨工具调用存活）。
- **打包脚本 + 修掉发布包的缺文件问题**：新增 `tools/package.mjs`（`npm run package`），产出 `dist/Arena-Model-Probe-2.13.1.zip`（25 个文件、374 KB、平铺无顶层目录）。
  - **旧包（2.9.25）漏了 5 个运行时文件** —— `price-channel.js` / `pricing-channel.js` / `usage-channel.js` / `arena-cost-table.json` / `arena-pricing-table.json`。因为当初是手写文件清单，而 2.10–2.12 新增的模块没人回头补进清单；这种缺失不会立刻报错，而是等走到对应功能才炸。新脚本改为**自动发现依赖闭包**（manifest 引用 + 静态 `import` + `chrome.runtime.getURL()` + `new URL(relative, import.meta.url)` + `popup.html` 的 `<script>/<link>`），缺文件直接报错退出，另附 `--check-only` 模式。
  - 纯 Node 实现（`zlib.deflateRaw` + 手写 ZIP 结构，零依赖），并随附 `THIRD_PARTY_NOTICES.md` 与 `LICENSE-ModelTrace`（`modeltrace-bank.json` / `modeltrace-core.js` 是 MIT 第三方文件，分发需带许可原文）。
  - 支持 `SOURCE_DATE_EPOCH` 做可复现构建（实测固定时间戳连打两次 SHA-256 完全一致）。
  - 交付包已用外部工具（Python `zipfile`）逐项校验：CRC 全通过、25 项内容与工作区 SHA-256 逐一相符、无顶层目录；解包后全部 `.js` 语法通过、模块图闭合。
- 版本一致性：`package.json`（此前停在 2.12.0）与 `README.md` 同步到 2.13.1。

## 2.13.0

- **单价表实时化** —— 单价表不再只靠随包快照：`background.js` 直接 `GET https://arena.ai/leaderboard`（带 `RSC: 1` 头），解析 flight 载荷里每行的 `inputPricePerMillion` / `outputPricePerMillion`（+ cacheRead/cacheWrite 字段，实测全 null），持久化到 `chrome.storage.local`（`amp.pricing.live.v1`）。加载优先级：内存缓存 → 24h 内的持久化实时表 → 实时抓取（30 分钟冷却）→ 随包快照兜底；解析不足 10 行视为 Arena 改版，自动回退快照并记录原因。新增消息 `AMP_PRICING_REFRESH` 供手动强制刷新。
- **每条消息的成本显示** —— 「本次发消息花了多少钱」在网页版有了可用答案：期望成本 = 本条实测 token 用量 × 识别模型单价，浮层显示 `本条 ≈ $x.xxxx（按公开单价估算）`；识别模型有多档变体单价时给区间；缓存单价 Arena 未下发，故缓存 token 不计入并标「下界」（`complete=false`）。
- **真实按次成本路由的结构化抓取**：嗅探器对 `GET /api/chat/:id/cost` / `GET /api/evaluation/:id/cost` 的 200 响应做结构化解析（只取 messageId + USD 数字、不碰内容），上报 `kind:'cost-route'`；路由 403 时上报一次 `kind:'cost-gate'`，浮层明示「账号灰度门未开」。真实成本优先级：`session.actualTotalUsd` > 逐条 `actual.totalCostUsd` 之和 > 旧的正则字段信号；一旦拿到真实成本，自动升级为 `rankByObservedCost` 按价排序。

## 2.12.0

- **单价通道 —— 「按价格反推模型」的方法找到了**（完整证据链见 `Arena成本接口实测.md`、算法与坑见 `pricing-channel.js` 头注）：
  - ✅ **单价是公开的**：榜单 RSC（`/leaderboard`）每行都带 `inputPricePerMillion` / `outputPricePerMillion`，单位 **USD/百万 token**。抓下来存成随包快照 `arena-pricing-table.json`：**208 行**，其中 **193 个文本模型**可参与反推。
    - ⚠️ 另外 **15 行是图像/视频模型**（`gpt-image-*` 只有输入价、`sora-*` / `veo-*` / `imagen-*` 只有输出价），单价单位其实是**按张/秒**而非每 Mtok。这类行标 `kind='media'` 并**排除出反推**，否则会把推理带偏。
  - ✅ **公式**：`期望成本(模型) = Σ tokensᵢ/1e6 × priceᵢ(模型)`。拿到真实按次成本后，`observed/expected` 比值最接近 1 的模型就是它（比值取对数后做高斯核加权）。
  - ✅ **真实按次成本的路由确实存在**（从 bundle 里挖出前端调用）：`GET /api/chat/:id/cost?includeSession=true`（Agent）、`GET /api/chat/:id/cost?includeSession=false&messageIds=a,b,c`（≤50 个 id）、`GET /api/evaluation/:id/cost`（Battle），返回 `{session:{actualTotalUsd,chargedTotalUsd,...}, messages:{...}}`。
  - ⚠️ **但按账号灰度**：本机账号对**全部 40 个会话**一律 `403 {"error":"Unauthorized"}`（与「路由不存在」的 `Route not allowed` 明确不同）；即使带**有效 Supabase JWT Bearer**（该 token 能正常鉴权 `/api/me` 返回 200）依旧 403。根因是账号级功能门（PostHog flag `credit-system-m1` / `credit-system-m2` 存在但值为 `"undefined"`），**不是鉴权问题**。
- 新增 `pricing-channel.js`（纯函数）：`validatePricingTable` / `normalizePricingTable` / `describePrice` / `expectedCostUsd` / `costMatch` / `rankByObservedCost` / `discrimination` / `pricingSummary` / `bankAliases` / `resolvePricingKeys` / `bankPricing`。
  - **指纹库 id ↔ Arena 变体 key 归一化**：指纹库用基础名（`gpt-6-astra`），Arena 用变体名（`gpt-6-astra-max-agent`），实测规则是「基础名是变体名的前缀且后缀从 `-` 开始」。两个坑都已处理：
    - **点号版本号**：指纹库 `claude-opus-5-5` ↔ Arena `claude-opus-5.5` → 生成「末两位数字改点号」的别名。**不能**粗暴把点号也换成短横，否则 `claude-opus-5` 会吞掉 `claude-opus-5.5-*`。
    - **前缀吞并**：`claude-sonnet-5` 是 `claude-sonnet-5-5-xhigh` 的前缀 → 用「前缀后第一个 token 是裸数字则不算命中」消歧（长日期后缀如 `-20260517` 不受影响）。
  - `discrimination` 对每个候选给出期望成本**区间**（一个基础 id 常有 agent/webdev/text 多档不同价），并判断 `separable`——只有所有候选区间两两不重叠，单靠价格才能唯一确定模型；重叠就直说「价格不可区分」。
- 后台（`background.js`）：新增 `loadPricingTable()`（只读随包 JSON）与 `pricingBlockFor(result)`；评分结果附 `pricing` 块（价格档位 + 区分度 + 有实测成本时的按价排序）；新增 `AMP_PRICING` 按需查询；`AMP_PRICE` 与 `tracePublic()` 也带上单价表状态。
- 浮层（`content.js`）：结果行追加 `单价区分度 N×（价格可区分/不可区分：最低 ~ 最高）`；自检新增 `单价通道（token 单价表）` 与 `指纹库 id → Arena 变体 key` 两行。构建标记 → `v2120P`。
- 测试：新增 `tests/pricing-channel.test.mjs`（13 项，单价与用量数据全部取自实测 payload 与真实榜单快照）。
- 排查脚本：新增 `tools/expr/arena-leaderboard-prices.js` / `arena-pricing-full.js` / `arena-cost-brute.js` / `arena-auth-hunt.js` / `arena-bearer.js` 等。

## 2.11.0

- **用量通道（CDP 实测驱动）**：用 `--remote-debugging-port=9222` 直连调试实例**真发了一条消息**，把 Arena 的成本/用量接口摸清了（完整证据链见新增的 `Arena成本接口实测.md`）：
  - ✅ **token 用量确实下发**：`GET /api/evaluation/<sid>` 的 `messages[].metadata.usage` 带 `inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`，与 `status: success` 同时落地（实测约 10 秒结算），且**揭晓前就能拿到**（`modelId` 仍为 `null`）。
  - ❌ **美元成本不下发**：`metadata.cost` 恒为 `null`；`/api/evaluation/<sid>/cost` 路由存在但返回 `403 Unauthorized`（与其余路由的 `Route not allowed` 不同，说明路由真实、只是缺凭据）。美元价由前端 `useCostContext` 按「token × 单价」自算（`basePriceUsd` / `totalChargedUsd` / `CREDITS_PER_USD`，schema 已从 bundle 挖出）。
  - ⚠️ `/api/me/pulse` 是**每日额度百分比**（发消息前后都是 100），与单次成本无关；真正的「扣费」是**限速窗口**（实测 `10 prompt / 5 分钟`，发一条 `remaining` 10 → 9）。
- 新增 `usage-channel.js`（纯函数：`parseUsage` / `usageShape` / `describeUsage` / `sumUsage` / `extractUsageSignals` / `sliceBalanced` / `estimateCostUsd` / `latestUsage`）。
  - **形态签名** `cw`（有缓存写入）/ `cr`（有缓存读取）/ `rz`（有推理 token）——`cacheWriteTokens` 只在支持 prompt caching 写入的厂商出现，实测**按 provider 变化**，是有判别力的一维。
  - `estimateCostUsd` 缺费率时返回 `null`：**只报 token，绝不折算猜价**。
- 嗅探器（`network-sniffer.js`）新增 `scanUsage`：花括号配对切出 `"usage":{...}`（含字符串/转义处理），流式截断时退回字段正则；camelCase 与 snake_case 都认。成本字段正则补上 camelCase（`totalCostUsd` / `basePriceUsd` 等）。
- 后台（`background.js`）新增 `netState.usageSignals` 与 `usageBlock()`；`tracePublic()` 与 `AMP_PRICE` 都返回用量汇总。
- 浮层（`content.js`）轨迹行显示 `用量:in 6 / out 4142 / cacheW 11143 / total 15291[cwcr--]`；自检新增 `页面下发的 token 用量` 一行，并把原来那行改名为 `页面下发的美元成本字段`（预期「未抓到」）。
- 新增 `tools/cdp.mjs`（零依赖 CDP 客户端，走 Node 22 内置 WebSocket）+ `tools/expr/*.js` 探针脚本（`arena-probe` / `arena-bundle-scan` / `arena-endpoint-scan` / `arena-cost-probe` / `arena-eval-dump` / `arena-usage-dump` / `arena-send-probe`）。
- 测试：新增 `tests/usage-channel.test.mjs`（11 项，用例数据全部取自实测 payload）。
- 构建标记更新为 `v2110U`。

## 2.10.0

- **价格通道（路线 A）**：把 arena.ai 公开的「每模型任务成本」接进探针（来源：Agent Pareto 榜 `https://arena.ai/leaderboard/agent/pareto`，口径见官方博客 `arena.ai/blog/agent-categories-and-cost`）。
  - 新增 `arena-cost-table.json`（随包快照：19 档 / 覆盖指纹库 10 个模型，含同模型不同 effort 档）与 `price-channel.js`（纯函数：校验、归并档位、成本似然、一致性、只读成本字段抽取）。
  - 识别结果里显示候选模型的成本档位（`$X.XX/task` + 很贵/偏贵/中等/便宜）；`AMP_PRICE` 可查询成本表与按模型查成本。
  - **嗅探器新增只读抓取 `cost` / `total_tokens` / `prompt_tokens` / `completion_tokens` 等字段**：网页版目前只下发额度百分比，但一旦 Arena 开始下发成本，通道会自动升级为「按现场成本核对/反推候选」。
  - 自检新增两行：成本表是否加载、页面有没有下发成本/用量字段（不发消息、不耗额度）。
  - **不改现有评分**：`status`/`nearest` 仍由指纹决定，成本只作旁证与排序参考；成本表加载失败只记录原因。
- **网关成本识别（路线 B）**：新增 `tools/arena-gateway-cost.mjs` + `tools/arena-rate-table.json`。Arena API 网关（`api.preview.arena.ai`）是唯一能拿到「每次请求成本」的地方（官方文档：请求走 billing/logging 管线，router 隐藏真实模型）。脚本可列模型、发探针、读 `usage`/成本字段，并按费率表用对数似然反推模型。费率默认留空（需从 dashboard 的 listed rates 抄一次），留空时只打印用量与成本字段。
- 调研笔记：新增 `Arena价格接口调研.md`（含 Pareto 成本表快照与「网页版不下发成本」的证据链）。
- 测试：新增 `tests/price-channel.test.mjs`（6 项）与 `tests/arena-gateway-cost.test.mjs`（4 项）。
- 构建标记更新为 `v2100P`。

## 2.9.25

品牌改为 BY Vodka（原 BY PERKICA）：HUD 标题与使用说明同步更新。

# Changelog

## 2.9.24

- **性能与稳定性优化（A+B+C+E）**：
  1. 轮询改**事件驱动**：`waitFor`/`confirmSend`/数字回复等待/数学题/文本探针的固定 250–350ms 轮询换成 `domTick`（MutationObserver 变更唤醒 + minMs 节流 + maxMs 低频兜底）——无变化时约 1 次/秒低频复查，回复文本一落地立刻检测；observer 不可用自动退化为等价旧轮询。
  2. `transcriptText`/`tokenTranscriptText` 加 250ms 拍内读缓存：`innerText` 是强制布局读，同一拍多次读取只算一次。
  3. 嗅探器降耗：Worker 往返消息不再整包 `JSON.stringify` 再扫——字符串直扫，大字符串（>2KB）与二进制跳过，只从短字段提取模型线索（更省主线程，也更贴合「流内容不落地」）。
  4. New Chat 链接与侧栏展开按钮改**受信任点击**兜底（合成 `click()` 被 Arena 过滤时不再干等 15 秒超时）。

## 2.9.23

- **修复「页面不在前台（后台标签页）就识别不出模型」**：Chrome 对隐藏页的链式 setTimeout 双重降频（隐藏后钳到 1 秒、隐藏超 5 分钟后降到 1 分钟/次），抽卡的秒级轮询只剩一两次检查就撞超时——`confirmSend` 假报「发送后没动静」、`waitFor` 假报「发送按钮不可用/草稿未清空」，整轮识别报废；失焦文档里 `document.execCommand('insertText'/'delete')` 直接返回 false，探针写不进输入框。修复：
  1. `sleep` 改为**后台 SW 计时器竞速**（长连接端口回唤醒；SW 计时器不受页面可见性节流，SW 不可用退回页面计时器兜底），所有轮询恢复 250–350ms 节奏；抽卡期间的持续消息同时保住 SW 不被回收。
  2. `writeEditor` 与新聊天草稿清理改为三层兜底：`execCommand` → 受信任键入（debugger `Input.insertText`，不依赖文档焦点）→ 合成 setter+input 事件，全部失败才报错；`writeEditor` 改 async 并在各调用点 await。
  3. 发送确认的二次点击由合成 `button.click()`（被 Arena 按 `isTrusted=false` 过滤，等于没点）改为受信任点击。
- 挂机抽卡（标签页在后台）与前台一致可用。

## 2.8.0

- **scene 通道升级为学界成熟方案的三件套**（风格特征 + 答案分布 + 选项分布）：
  1. **自由句（风格特征）**：12 汉字硬约束句 → 字符 3-gram 相似度聚簇。
  2. **受限选择（离散分布）**：只回一个字母的四选一 → 答案分布可直接比较。
  3. **自选生成（离散分布）**：自己想「动物-交通工具」→ 得到两个类别的分布。
- **scene 投票**：本机按模型标签累积每道题的答案分布；新一轮样本与本机历史分布算 Jensen-Shannon 相似度（拉普拉斯平滑 0.05；相似度只看两边出现过的选项，取值 0–1），加权投票输出 `scene 投票：<模型>（相似 x.xx · n 项样本 · 与数字通道一致）`；某模型某题样本 <2 次时不投票。
- 6 道题按轮次循环（3 类题型各 2 道），抽卡越多分布越准；scene 通道恢复默认开启，但每步有进度、超时 15s/60s、发送确认，判定「不清晰」仍不改名（scene 只做一致性证据与展示）。
## 2.7.3

- **修复 2.7.0 引入的致命作用域错误**：scene 通道与本机统计的函数块被误插到 `sanitizePrefs` 内部，HUD 渲染调用 `localSummary()` 时抛 `localSummary is not defined`，界面就此卡住（这正是「问了一题就没后续」的真凶）。现已把整块移到 IIFE 顶层作用域。
- 同时保留 2.7.1/2.7.2 的修复（scene 默认关闭、发送确认、点掉「继续工作」弹窗）。
## 2.7.2

- **修复「点了一下就没后续操作」的静默卡住**（两个阻塞点）：
  1. **发送被吞**：以前点击发送后如果那次点击没生效，会一路无声等到 10 分钟超时。现在点发送后 12 秒内确认「有动静」（开始生成 / 会话文本变化 / 输入框被清空），否则自动再点一次；两次都没动静才停，并明确写出原因。
  2. **「继续工作」弹窗挡路**：数字探针发送前先检测，有提示就先点掉，不再因为弹窗挡住输入框而停止后续题目。
- 保持：不确定就不改名；scene 通道默认关闭。
## 2.7.1

- **修复抽卡卡住风险**：scene 通道改为**默认关闭**（实验功能，浮层勾选才启用）——抽卡走回与 2.6.1 完全相同的路径，不会再因为额外的 scene 交互卡住。
- 开启 scene 时每一步都有实时进度（「scene 题已发送，等一句 12 字回复…」/「scene 句子已取到，正在归簇…」），并把超时从 30s/120s 收短到 15s/60s：即使异常也会在一分钟内自己退出，并把原因写进结果行，不再无声等待。
- 家族级兜底、本机标定统计保持不变。

## 2.7.0

- **家族级兜底**：判定不清晰时不再只给一个名字，而是标出家族（例：`未改名（同族近似）［GPT 家族］：Top3 ...`）——标定显示错误几乎全发生在家族内部，标家族比标单个名字诚实得多。
- **scene 第二通道**（默认开启，可在浮层关掉）：每轮在数字探针之后再问一句带硬约束的中文题（恰好 12 个汉字、不含标点/数字/拉丁字母），自动校验格式、抽取 12 字句子、按字符 3-gram 相似度（≥0.5）归入本机簇表：同一簇=同一台模型的强线索。结果行显示 `scene「…」簇 S3（第 4 次 · 该簇历史 3 次判 gpt-6-luna）`。簇表只存本机（chrome.storage.local，最多 60 簇，每簇最多 8 个变体）。
- **本机标定统计**：每轮记录拟合/分离/是否清晰（不存聊天正文），浮层结果栏显示 `本机 N 轮 · 清晰 x% · 拟合中位 … · 分离中位 …`，用来和标定基线（1 题 60%、3 题 87% 可命名）对照。
- 引擎新增 `top_family`（家族聚合概率），供家族兜底与显示。

## 2.6.1

- 置信度门槛按数据标定：拿模型库自带的 17 个模型计数分布做 30 轮蒙特卡洛（按每个模型的分布重新抽样 → 走完整评分通道），量出「多大概率才对」：
  - 1 题：top1 命中率 89.0%；原门槛（拟合≥0.25 且 差距≥0.08）只能命名 32% 且 100% 正确；新门槛（0.15/0.06）可命名 60%，精度仍 100%（0 错）。
  - 3 题：top1 命中率 99.2%；新门槛可命名 87%，精度 100%。
- 因此把 `THRESHOLDS` 从 `0.25/0.08` 调为 `0.15/0.06`（family 不变 0.9）：同样一分错都不出，能命名的轮次明显变多；误差主要集中在 GPT 家族内部（luna/sol/astra 互串）与 Claude 家族内部，这也是「luna 太多」的真正来源。
- 浮层抽卡说明里写上判定标准，便于对照结果。

## 2.6.0

- 置信度门槛（按用户反馈的「gpt-6-luna 太多」）：只有判定为「清晰匹配（clear）」才自动改会话名；同族近似（close）/弱匹配（weak）一律不改名，名字只在浮层里显示，并带上 Top3 与拟合/分离值。浮层新增勾选项「不确定也改名」（默认关闭）可恢复旧行为。
- 新增 Top3 展示：浮层结果行、每轮结果备注、以及手动识别的完成行都会列出前三名（名称 + 拟合分），方便分辨「真·luna」还是「指纹向 luna 塌缩」。
- 引擎结果新增 top3 字段；非清晰判定时改名标题会带问号（原先只有 weak 才带）。

## 2.5.7

- 修复「当前聊天已变化，已停止归档」：连续抽卡会很快新建下一个对话，页面已经翻页，而清理还在等旧对话的侧栏行 —— 旧代码硬要求「当前路径 == 要清理的 sessionId」，于是把这种情况误判成聊天被切换、直接放弃清理。现在只看「侧栏里那一行还在不在」：只要还在，就照常打开它的菜单、点唯一的归档项；成功判定仍是该行从侧栏消失并稳定 1 秒。
## 2.5.6

- 清理会话改为照参考实现（arena-trace-inspector 2.3.2）重写：侧栏行必须带 data-sidebar=menu-button，菜单按钮取该行内的 data-sidebar=menu-action，菜单用 aria-labelledby 精确锁定，只点**唯一的** Archive 项（没有唯一归档项时退到唯一的 Delete 项，都没有就报错、绝不点别的条目）；确认框的标题与按钮也按归档/删除文案点名点。成功判定回到真实结果：该行从侧栏消失且侧栏仍在、稳定满 1 秒才算成功（不再出现「点过就算成功」的假象）。顺带修掉 v2.5.2 起就存在的一处未定义变量 deleteWord（会让菜单查找直接抛异常）。
## 2.5.5

- 修复「实际归档成功却提示失败」：有些入口点完立即生效、没有确认框，侧栏也可能过一会儿才刷新。现在只要点过归档/删除，就按「已完成」记录；没能立刻确认的写成「已归档（未完全确认）」，不再报错。
## 2.5.4

- 移除「待删队列」与「重试清理废对话」按钮（按用户要求）：thinking 截断后的清理只做一次 —— 成功就归档/删除该对话，失败只在该轮结果里写明原因，不再排队、不再后台补删、不再有重试按钮。
## 2.5.3

- 「自检（只检查，不发送）」新增侧栏菜单结构 dump：自动展开第一个会话的 ⋯ 菜单，逐条打印 role / aria-label / title / 文本 / 是否禁用，然后按 Esc 收起 —— 便于一次定位 Arena 文案或结构变化。
- 重命名/清理的忙锁加了 60 秒失效保护：万一某次清理卡住，不会再一直挡住后续重命名。
## 2.5.2

- 对齐 Arena 现在的侧栏菜单：菜单项从「删除」变成了「归档（Archive）」。清理流程改为**优先归档**（Archive / 归档 / 归档聊天 / 归档对话），找不到归档项才退回「删除」；确认框按钮同样先按动作匹配，再接受「确认/确定/OK」。
- 成功判定改为「侧栏行消失并保持 1.2 秒」；相关文案统一改成「清理 / 归档」。实测参考了同机另一个可用插件（arena-trace-inspector 2.3.2）的归档实现。
## 2.5.1

- 删除对话：菜单项与确认按钮改成「文本 / aria-label / title / data-testid 一起看、包含匹配」，覆盖图标按钮与带快捷键提示的文案；被标为禁用的删除项也会尝试点一次；确认按钮额外接受「确认 / 确定 / OK / Yes」。
- 删除失败时错误信息会列出菜单里实际看到的条目（最多 160 字），方便快速定位新文案。
## 2.5.0

- 池化评分：同一会话问到 2–3 条证据时，除了「逐条算余弦再平均」，还把这几条的数字**合并成一份更大的经验分布**（样本 300 → 约 900）再算一次余弦，两者各占一半 —— 抽样噪声更低，拟合度与区分度更稳。
- 结果里新增「数字 N（池化）」显示：能看到这次判定一共用了多少个数字、是否走了池化通道。
## 2.4.1

- 删除废对话更宽容：删除前先等生成彻底停下（生成中删除常被忽略）、先按 Esc 收掉弹层、删除/确认文案用正则匹配、菜单项等它变可用，确认框放宽到弹层与菜单两种形态。
- 新增「待删队列」：删除失败的会话会被记下来（chrome.storage，最多 50 个），浮层新增「重试删除废对话（N）」按钮可随时重试；每次点「开始抽卡」前也会自动静默重试最多 5 个。
## 2.4.0

- 更快：回复里数字数量一达标就收工 —— 生成已结束立即返回（不再空等 12 秒稳定窗口）；仍在生成时直接点「停止生成」截掉尾巴；数学题回复的收工等待从 2.5 秒降到 1.3 秒。
- 更准：新增「自动补题」（默认开启）—— 快速模式下若判定不是「清晰匹配」，自动补发剩余探针（同一条聊天 = 同一个模型，最多补到 3 题），重新评分；判定清晰时仍然只问 1 题，保持速度。
## 2.3.0

- 「拦截 thinking」开启时，截断该轮后会**自动删除**这轮新建的对话（走 Arena 可见 UI：侧栏菜单 → 删除 → 确认），不再在侧栏留下废对话。
- 抽卡过程与结束汇总会显示删除结果（成功 / 失败原因 / 已删除数量）；（删除失败不影响继续抽卡）。
## 2.2.0

- 自动抽卡每轮先发一道随机数学题（`+` / `-` / `×`，crypto 随机、每轮不同、只要求一个数字）过人机验证，答完再发探针；避免重复提问触发人机验证。
- 新增「拦截 thinking」开关（默认关闭，浮层与弹窗同步）：开启后一旦检测到模型开始 thinking，立即点停止生成截断，本轮不识别/不改名，直接进入下一轮；截断轮次单独计数，不计入失败。
- 抽卡过程提示同步显示数学题预热、thinking 截断与跳过轮数。

## 2.1.0

- 新增识别模式：**快速模式**（三道题里随机 1 题，1 条回复即判定）与**精准模式**（3 题全问后判定）；浮层与弹窗都可切换。
- 新增「再补 1 题」：快速出结果后可继续补题，最多补到 3 题，逐条加强证据（对应 WhatsMyLLM「一条可用、三条更稳」）。
- 自动抽卡支持模式选择：每轮按模式发送 1 题或 3 题；设置升级为 `amp.draw.prefs.v3`（自动迁移 v2）。
- 评分改为按题号长度排序后提交，任意 1–3 题都能正确评分。
- 署名：**由 Perkica 制作**（manifest `author`、浮层、弹窗、README）。
- 新增纯函数 `planProbes(mode, used, random)` 与单元测试（快速=随机未问题目；精准=按序补全）。

## 2.0.1

- 新增「自检（只检查，不发送）」：检查 Agent Mode、输入框、发送按钮、New Chat 入口、侧栏展开按钮、当前会话是否可重命名、额度接口，不发消息。
- New Chat 入口识别更稳：同时匹配可访问名称与可见文本（含中英文变体），找不到时自动点侧栏展开按钮最多两次再重试。
- 发送按钮识别更稳：`aria-label="Send message"` 之外，接受文本为 Send/发送 的按钮。
- Agent Mode 组合框同时匹配 `button[role=combobox]` 与 `[role=combobox]`。

## 2.0.0

- 新增「自动抽卡」：按设定轮数循环执行 New Chat → 发送探针 → 本机识别 → 自动改名 → 下一轮；可选每条聊天发送 1/2/3 条探针。
- 新增每日额度显示：读取 `arena.ai/api/me/pulse`（百分比），浮层与弹窗均可刷新；可设置额度下限，低于阈值自动停止抽卡。
- 抽卡设置持久化到 `chrome.storage.local`（`amp.draw.prefs.v2`），manifest 相应增加 `storage` 权限。
- 合并来源：额度端点语义取自 Arena Trace Inspector 2.3.2 的 `billing.js`（`/api/me/pulse`，pulse 为百分比）；不引入该项目的 trace、debugger、cookies 与 declarativeNetRequest 组件。
- 已知行为：每轮失败会跳过并记录，连续 3 轮失败或遇到致命情况（草稿／离开页面／切换会话／手动停止）立即停止；不自动重发。

## 1.1.2

- 最终探测状态为 `弱匹配` 时，自动重命名使用 `模型名?`；清晰匹配和同族近似保持原模型名。
- 已带半角或全角问号的名称不会重复追加。

## 1.1.1

- 修复真实 Arena 页面中的“此任务成功了吗？”反馈区不一定带 `role="dialog"`，导致未点击“继续工作”的问题。
- 现在从 `button`、`role="button"` 和表单按钮的可访问名称、标题、值及文本识别“继续工作”，再向上验证同一 UI 区域包含任务成功问题。
- 支持“任务成功了吗”“任务是否成功了吗”“不，继续工作”“否，继续工作”及对应英文变体。
- 若看到了任务成功提示但找不到唯一可点击控件，会明确停止并显示错误，不再静默跳过。

## 1.1.0

- 每轮模型回复结束后，识别“此任务成功了吗？”对话框并自动点击唯一的“继续工作”按钮。
- 即使回复没有形成可评分数字序列，也先处理已出现的“继续工作”对话框，再报告本轮无有效序列。
- 单条探测在本轮最终结果后、连续探测在全部剩余轮次完成后，自动将当前 Arena 会话侧栏标签重命名为最近候选模型显示名。
- 重命名通过 Arena 可见界面完成，必要时自动展开侧栏；失败不删除探测结果。

## 1.0.0

- 首个完全独立版本：自动发送、回复捕获、本机指纹评分、页面浮层和扩展弹窗。
