# DesignArena Probe

在 [designarena.ai](https://www.designarena.ai) 的**新对话**里自动发探针、采集模型回复、提取风格特征。

> 这是一个**独立扩展**，和 Arena 那套（`Arena Model Probe`）互不干扰 —— 两个站点 DOM 完全不同。

---

## 它做什么

1. 在输入框里填入一条探针（默认 4 条轮流用，都是「先不要写代码，只用一两句话回答」的短题）
2. 点发送
3. 等回复稳定后，用「发送前后 innerText 差分」抽出**模型自己的那段话**
4. 存进 `chrome.storage.local`，并提取一组风格特征（长度、中英文标点比例、句子长度、列表/代码块、引号习惯…）
5. 「连发 3 轮」= 每轮回到首页开一个全新对话，继续发
6. 「导出」把全部记录存成 JSON

---

## 它刻意**不做**什么

| 不做 | 原因 |
|---|---|
| 自动投票（Option A / B） | **制造假票**，会污染 designarena 的 Elo 榜单。盲测是它的根基 |
| 调 `/api/voteNew/tournament/<id>/reveal` 提前看模型 | 同上，破坏盲测 |
| 自动新建 A/B 项目 | 同上 |

所以本扩展**只在「新对话」阶段工作**：那里没有待投票的 A/B，输入框是可用的。

---

## 实测确认过的（2026-10-19，Chrome 155）

| 项 | 结论 |
|---|---|
| 输入框 | `div[role="textbox"]` 内是 Lexical 编辑器（`<p>` 里带 `data-lexical-text` 的 span） |
| 写入方式 | **只有 `focus()` + `document.execCommand('insertText', …)` 有效**；`Input.insertText`、合成 `beforeinput`、合成 `keydown` **全部无效** |
| 发送按钮 | `button[aria-label="Submit prompt"]` |
| 发送后 | URL 变为 `/chat/<uuid>` |
| 回复 | 纯文本，DOM **没有稳定 class**（全是无 class 的 div），所以用 innerText 差分而不是选择器 |
| 会话页的输入框 | 有**待投票的 A/B** 时被置为 `contenteditable="false"`，占位符写「请先为上方设计投票…」⇒ 不可用 |
| 模型身份 | **客户端完全没有**（DOM 里 Claude/GPT/Grok… 全部 0 命中）⇒ 只能靠探针反推 |

---

## 未验证 / 已知局限

- **指纹能力有限**：designarena 有 558 个模型（`/api/registry` 公开），但我们**没有任何带标签的样本**。
  所以扩展现在只**采集 + 提取特征**，不做定名。等你用「标定」给若干条记录打上模型名之后，
  才谈得上最近邻匹配（这部分还没实现）。
- **连发 3 轮**依赖页面重载后自动续跑；这一版只做到「发完一轮 → 回首页」，续跑逻辑尚未接上
  （`pending` 字段已预留）。
- 探针刻意避开建站任务，但 designarena 的 agent 仍可能自行开始生成产物 —— 那样单轮耗时会很长。

---

## 安装

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选本目录（`designarena-probe/`）
4. 打开 `https://www.designarena.ai/`（**首页 / 新对话**，不要用已有会话页）

右下角会出现 `DesignArena Probe` 面板。

---

## 用法

| 按钮 | 作用 |
|---|---|
| **发 1 条** | 发一条探针，采集一条回复 |
| **连发 3 轮** | 每轮回首页开新对话，连发 3 条 |
| **停** | 停止循环 |
| **导出** | 把记录导成 JSON |
| **标定** | 给最后一条记录填上模型名（为将来的指纹匹配积累标签） |

---

## 记录格式

```json
{
  "at": "2026-10-19T07:55:00.000Z",
  "probe": "先不要写代码，也不要创建项目。只用两句话回答：你会用什么思路做一个设置图标？",
  "reply": "我会结合直观的符号和简洁的设计元素，突出“设置”功能。可以用齿轮或扳手图形，配以简洁的线条和中性色彩。",
  "features": { "len": 52, "cjk_ratio": 0.9, "punct_ratio": 0.06, "sentences": 2, "avg_sentence_len": 26, "ends_with_period": true },
  "url": "https://www.designarena.ai/chat/...",
  "label": null
}
```
