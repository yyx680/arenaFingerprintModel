# 模型甄别调研 + 判定核优化（v2.9.21）

日期：2026-10-08　｜　改动：`fingerprint-tests.js`（新增）、`model-probe-engine.js`（接线）、`tests/fingerprint-tests.smoke.mjs`、`tests/fingerprint-stats.diag.mjs`

## 1. 别人怎么甄别模型（文献要点）

| 论文 / 项目 | 做法 | 我们能借什么 |
|---|---|---|
| One Token Is Enough（arXiv 2607.10252，2026-07） | 单 token 答案的**分布**就是指纹；165 模型 × 10 任务 × 4 语言；拆分样本 JSD 验证协议，全电池 EER 7.3%（八格 ≈120 token 时 10.6%）；同模型两半的距离比跨模型小一个数量级 | 核心：用「同一统计量的零分布」做检验 + 留出验证，而不是再挑一个距离阈值 |
| FLIPS（arXiv 2606.03330，ICML 2026） | 二进制伪随机序列的偏置做**实例级**指纹；237 个实例：闭集 96% / 开集 90%（LLMmap 基线 35%） | 实例级（温度/量化/提示）确实可分，但要更多探针或更长序列 —— 单通道 355 值做不到，是扩探针的依据 |
| LLMmap（USENIX Sec 2025，arXiv 2407.15847） | 主动探测；8 条定制查询识别 42 个版本 >95%；开集用对比学习签名，能判「不在库内」 | 开放集的本质是**能拒绝未知**，而不是永远硬指一个最近名字 |
| Invisible Traces（arXiv 2501.18712） | 静/动混合：LLMmap 探针 + 被动 ModernBERT 分类器；86.5%@10 样本 | 被动通道（普通聊天文本）是下一步最有价值的独立信息源 |
| RoFL（arXiv 2505.12682） | 所有者侧指纹（低概率提示 + 稳定回答），抗微调/剪枝/量化 | 属于模型方场景，客户端鉴别用不上；但它的「零假设 = 同源模型仍会复现」思路与自举一致 |
| The Randomness Floor（arXiv 2604.22771） | 熵偏离 ED≈0.30 是权重层结构下界，与提示/温度关系弱 | 「模型 vs 均匀」的偏离可以做显著性检验，是绝对判据的物理基础 |
| MIT《Can LLMs Generate Random Numbers?》 | 采样质量按 error / variance / containment 三轴评估；提示里 few-shot 例子会显著改变诱导分布 | 模板要固定、少样本（我们三条模板同族，符合这条） |
| whatsmyllm 方法页（本仓库判定逻辑的来源） | 6 条输入闸门；fit/sep 判据（sep≥0.08 clear、fit<0.25 weak、家族 0.9 close）；实测 56/69 clear-right、0 clear-wrong、均匀噪声 600/600 weak；明说「一个回答时约 1/100 随机输入会过 fit 门槛」 | 沿用其语义，把两个固定阈值升级成校准检验（本次改动） |

## 2. 诊断（本仓库 17 模型库，离线实测，固定种子）

- **边缘分布卡方检验（第一版方案）失败**：同模型抽样 40 次的最近命中 0%，均匀噪声与真样本的 p 无区别 → 直接弃用。原因：355 格 × 300 数字，单格期望 <1，边缘形状差异被计数噪声淹没。
- **真正有分辨力的统计量就是管线自己的 fit**：单答 315 数字时最近命中 92%（11/12），3 答 5/5。
- **绝对符合性检验的功率随证据量增长**：1 答时弱（均匀噪声仅 3/5 被整体拒绝），3 答时可用（9/12~4/5）。与站点「推荐 3 答」一致。

## 3. 改动清单（最小接线，不动 vendored 核心）

- **新增 `fingerprint-tests.js`**：fit 零分布自举（按模型 / 按证据规模缓存）+ 正态下尾 + Benjamini-Hochberg 校正 → **相容集合**；留出验证；证据同质性；分离度校准检验 `fitGapTest`。
- **`model-probe-engine.js`**：TUNING 增 `statMode / statAlpha / statDraws / statSeed / statSpread / statPromote / verifyAlpha`；`makeVerdict` 增 `fitStatistic`、`signals.tests`、`signals.verification`、`signals.homogeneity`、`signals.separation_test`，以及 4 条**只降级不提升**的融合规则。
- 新 reason 码：`stats_rejected_all_references`、`stats_held_out_failed`、`stats_evidence_heterogeneous`、`stats_unique_compatible`。
- 开关：`statMode='off'` 完全回到旧行为；`'report'` 只记录不干预；`'fusion'`（默认）按统计证据降级；`statPromote=false` 默认不提升。
- **未改**：ModelTrace vendored 核心（保持 “used unmodified”）、输入闸门、既有打分通道；UI 只多出 `signals.*` 字段，status 仍只有 clear/close/weak 三值。

## 4. 实测数字（`node tests/fingerprint-tests.smoke.mjs 12 30`）

| 条件 | 结果 |
|---|---|
| 真样本 1 答 | 最近命中 92% ｜ 真模型在相容集合 92% ｜ 整体拒绝 0% |
| 真样本 3 答 | 留出验证 6/6 ｜ 同质 6/6 ｜ clear 3/6（旧闸门） ｜ 分离度显著 0/6 |
| 均匀噪声 1 答（30 次） | 整体拒绝 7% ｜ weak 63% ｜ clear 0 |
| 均匀噪声 3 答（12 次） | 整体拒绝 9/12 ｜ 分离度显著 0/12 |
| 混源证据（两模型各一答） | 同质性报异 3/8（样本少，方向正确） |
| 耗时 | ~15 ms/次判定（32 次/模型自举，按库缓存后会更快） |

## 5. 解读与建议

1. **「分离度显著 0/6」是个真发现**：3 答规模下，top 与第二名之间的 fit 差通常达不到统计显著 —— 现行的「sep ≥ 0.06 即 clear」是一条偏松的判据（真样本约一半会触发）。要不要收紧，建议在 `statPromote` 场景下用现场数据再定。
2. **绝对零分布有系统性上偏**（自举样本比真实回答「更干净」，与你 v2.9.20 的结论一致）：所以 `statAlpha` 保持 0.05，不要升到 0.1 —— 实测真样本 z 最低到 −1.6，升到 0.1 会误杀。
3. **分辨率的下一个杠杆是探针多样化**（文献共识：多任务、多语言、二值序列）。库里只有 355 值单通道；新批次若加 2–3 个通道（1–100 数字 / 硬币 / 字母），判定核可以按独立证据融合（后续小改即可）。
4. 复现：`node tests/fingerprint-tests.smoke.mjs 12 30`（方向性冒烟）、`node tests/fingerprint-stats.diag.mjs`（4 条件明细）。
