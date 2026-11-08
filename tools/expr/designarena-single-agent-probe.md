# DesignArena 单 Agent 被动探针

独立单文件版本，不需要先安装通用探针。用于你自己当前页面的一轮单 Agent 会话观察，也可以由具备浏览器页面执行能力的 agent 调用。

**不会替你把网站切换到单 Agent 模式，不会创建任务，不绕过任何登录、付费或揭示机制。** 若网页提供该模式，请自行选择后开始观察。此脚本未对网站私有协议进行现场验证。

## 安装

在自己的 DesignArena 页面，打开 DevTools → Sources → Snippets，粘贴 `designarena-single-agent-probe.js` 的完整内容并运行。

安装时会卸载此前由本项目安装的通用探针，避免重复包装网络方法。不依赖通用版文件，也不会通过网络加载它。

## 一轮操作

1. 切换到你要使用的单 Agent 会话。
2. 开始本轮观察：

```js
__designArenaSingleAgentProbe.begin()
```

3. 在网页里正常提交你自己的任务；探针本身不提交任务。
4. 读取结果，或被动等待明确字段：

```js
__designArenaSingleAgentProbe.snapshot()
await __designArenaSingleAgentProbe.waitForModel({ timeout_ms: 15000 })
```

如果你已从自己的 Network 面板确认端点，可以只观察该路径片段，不需要也不应填写 token 或查询参数：

```js
__designArenaSingleAgentProbe.begin({ endpointIncludes: '/你已确认的路径片段' })
```

此过滤器不发起请求、不猜测端点，仅对之后发生的响应做范围限制。

## 机器可读结果

- `schema`：`designarena-single-agent-probe/v1`
- `observationWindow`：本地观察轮次，与网站会话 ID 无关。
- `summary.status`：
  - `declared`：本轮发现一个明确型号声明；`summary.model` 返回该原始声明。
  - `ambiguous`：出现多个不同型号/提供方声明，不替你选一个。
  - `identifier-only`：只发现内部 ID 或版本，不能当作型号名称。
  - `unknown`：没有明确证据。
- `summary.verified`：始终 `false`。页面返回的声明不是底层执行证明。
- `waitResult`：`observed` / `timeout` / `paused` / `stopped` / `new-window`。
- `observations`：来源、字段路径、脱敏端点、HTTP 状态、时间、次数。

`waitForModel` 最多等待 120 秒，不主动轮询网络；明确字段短暂稳定后返回当时的观察快照，不保证生成任务已经结束。发生新一轮、暂停或卸载时，也会有界返回。

## 与通用版的区别

- 每轮有独立序号，排除上一轮尚在返回的 fetch/XHR 结果。
- 排除模型目录、排行榜、已揭示列表、候选/参与者字段和明确的对战记录。
- 只采纳成功响应中的明确模型字段，不将错误响应作为模型证据。
- 单型号、多型号歧义、内部 ID 和未知分别返回，不按回答风格或价格推测。
- 支持 agent 使用 `begin` → 自己的正常任务 → `waitForModel/snapshot` 的流程。

## 控制

```js
__designArenaSingleAgentProbe.pause()
__designArenaSingleAgentProbe.resume()
__designArenaSingleAgentProbe.export()
__designArenaSingleAgentProbe.stop()
```

刷新页面也会卸载。仅在当前浏览器中保留元数据，不访问 Cookie、浏览器存储或请求体，不记录提示词、正文、推理或令牌。

单个响应限 512 KiB / 90 秒，并发副本限 4 个，最多保留 200 项。支持当前站点 fetch/XHR 的可解析 JSON 与流帧；不覆盖 WebSocket、独立 EventSource、Web Worker、跨站供应商响应或服务器内部调用。后台请求仍可能产生声明；必要时用已经确认的端点片段缩小范围。

未运行任何现场探测或测试。
