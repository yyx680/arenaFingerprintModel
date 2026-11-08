# DesignArena 被动模型元数据探针

用于观察你自己的 DesignArena 浏览器会话里，服务端已经正常下发的模型相关字段。不会发送额外请求、猜测接口、重放消息或绕过登录、投票揭示与 Cloudflare。

## 使用

1. 打开你自己的 DesignArena 页面。
2. 在浏览器开发者工具的 **Sources → Snippets** 中新建一个片段。
3. 将 `designarena-probe.js` 的完整内容粘贴进去并运行。
4. 正常操作页面。右下角观察器仅展示之后出现的明确模型/提供方字段。
5. 点击 **导出 JSON** 保存观察报告，点击 **卸载** 还原探针安装的网络方法。刷新页面也会移除探针。

无需在终端运行脚本，不需要 Node.js、浏览器插件或外部依赖。脚本只能在 `designarena.ai` 及其子域名运行。

## 控制台 API

```js
__designArenaProbe.snapshot() // 获取仅含元数据的报告
__designArenaProbe.export()   // 下载 JSON
__designArenaProbe.pause()    // 暂停观察
__designArenaProbe.resume()   // 恢复观察；不会重放已发生的请求
__designArenaProbe.clear()    // 清空本次记录
__designArenaProbe.stop()     // 卸载；保留只读报告 API
```

## 证据含义

- `response-declaration`：正常响应中出现的明确字段或白名单响应头。只是响应声明，不证明底层实际执行的模型。
- `catalog-metadata`：模型目录、排行榜、模型候选列表或已揭示模型信息，不等于当前生成任务实际使用的模型。
- `error-response`：错误响应里出现的标识，不应当视为成功调用证据。
- 未出现字段：**未知**。不会根据回答风格、价格或文本内容猜测型号。

记录包括字段名、值、来源类型、脱敏后的端点路径、JSON 字段路径、响应状态、时间和出现次数。URL 查询参数、哈希、常见路径标识符会被丢弃或遮盖。

## 隐私与边界

不访问 Cookie、localStorage、sessionStorage；不读取请求体或认证头；不存储或导出提示词、回答正文、推理内容与访问令牌。为提取字段，会在内存中短暂解析浏览器已收到的 JSON/流帧，解析后只保留白名单标识。

支持页面中的 fetch 与 XMLHttpRequest，以及它们收到的 JSON、SSE、NDJSON 和可解析的 RSC/JSON 行。**不覆盖**已经完成的请求、WebSocket、独立 EventSource、Web Worker、跨站供应商请求或服务器内部调用。

每个响应最多观察 512 KiB / 90 秒，同时最多读取 4 个副本，最多保留 200 条去重观测。超限即停止读取该副本，不取消页面原请求。只读观察仍可能带来少量内存与解析开销；暂停或卸载后不再处理新数据。

未运行现场探测、测试或主动请求。是否能看到模型信息，取决于网站实际返回的数据；这是基于常见元数据字段的观察器，不宣称已经验证 DesignArena 的私有协议。
