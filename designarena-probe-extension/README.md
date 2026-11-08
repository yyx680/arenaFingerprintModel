# DesignArena 探针(浏览器扩展)

一个纯本地的 Chrome / Edge(MV3)扩展。**v1.1 起全自动:捕获即触发,不用手动复制、不用点按钮** —
只要在 designarena.ai 里正常操作,扩展后台自动抓取凭据并立刻反查,
打开 popup 直接看结果。

## 安装(30 秒,免编译)

1. 打开 `chrome://extensions`(Edge: `edge://extensions`)
2. 右上角开启「开发人员模式」
3. 点「加载已解压的扩展」→ 选择本目录(`designarena-probe-extension/`)
4. 工具栏出现图标,点开即是探针面板

## 自动流程

| 你做什么 | 扩展自动做什么 |
| --- | --- |
| 打开并登录 designarena.ai | 捕获登录 Bearer(Firebase idToken),脱敏显示 + 有效期倒计时 |
| 发起一次 Agent 生成(`?mode=pro` / agent 入口) | 记录 `session_id` + agent 列表,立刻带 Bearer 打 `agents/{id}/status\|system-prompt\|tools` + `events` 事件流,高亮真实模型名(claude/gpt/gemini/qwen…) |
| 任何响应头带 `public-access-token` | 自动用该 token 探 `api.trigger.dev` 只读端点(run / trace / events) |
| 什么都不做 | 角标显示“已命中线索的会话数”(绿色数字) |

当然保留手动按钮:【↻ 重新反查】【↻ 重新探测】【复制 Bearer/Token】、【导出 JSON】、【清空数据】。

## 与 `designarena-probe.ps1` 的关系

两者独立可用、互补:
- 扩展负责“抓 + 自动初探”
- ps1 负责命令行深挖(infra / api / run / auto / watch)
- 如果想让 ps1 接力,popup 里的【复制】按钮仍然可用:

```powershell
.\designarena-probe.ps1 -Mode auto -BearerToken "<扩展里复制的>"
.\designarena-probe.ps1 -Mode run  -PublicToken "<扩展里复制的>"
```

## 安全说明

- 仅声明 `webRequest` / `storage` 两个权限;请求范围限定在 `designarena.ai` 与 `api.trigger.dev`
- 不上传任何数据:所有捕获与反查结果只写入 `chrome.storage.local`(你的浏览器本地)
- token 在 popup 中默认摰码显示;【清空数据】一键删除

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单(权限 / 注入范围) |
| `page-hook.js` | MAIN 世界钩子,只读包裹 fetch/XHR 捕获头与 JSON 摘要 |
| `content.js` | 隔离世界中转:注入钩子、postMessage → background |
| `background.js` | 捕获存储 + **自动反查调度(防重复/待凭据策选)** + Agon/Trigger API 调用 |
| `popup.html/.js/.css` | 黑色小面板:凭据 / Token / 会话自动结果 / 日志 |

## Changelog

- **1.1.0** 捕获即触发的全自动反查;有线索的会话数作为角标;导出含自动结果
- **1.0.0** 首版:手动触发反查的 MVP
