# Vodka 内嵌 Buster 人机辅助

Buster 3.4.0 核心已嵌入当前扩展，不需要另装 Buster。仅辅助 Arena / canary Arena 中的 **reCAPTCHA 音频挑战**，不支持 Cloudflare / hCaptcha，不保证通过验证。

## 使用

1. 使用 Chrome 123 或更新版本；重新加载本扩展，并确认新增权限。
2. 右键扩展图标 →「选项」，打开「人机辅助设置」。首次使用本地识别，请手动点击「下载/准备本地 Whisper 模型」，等待准备完成。模型不随扩展打包，需要能访问 Hugging Face。
3. 默认手动：出现 reCAPTCHA 挑战时，点击验证框内的 Buster 按钮。保留真实用户点击检查，不伪造可信事件。可选自动：在选项页开启「自动尝试一次」并保存，仅对可见的 Arena / canary reCAPTCHA，使用已准备的本地模型尝试一次识别、填入、提交；云服务仍需手动点击。
4. 识别任务遇到可见的 reCAPTCHA 会停止。完成验证后手动重新启动探测/抽卡；不会自动续跑。

可选 Google / Azure / IBM / Wit 语音服务需填入自己的密钥；不含 Buster 官方托管服务密钥。云识别会向所选提供商发送挑战音频，可能产生费用。密钥仅存于本机扩展配置，不写入源码。模型识别、价格指纹、弹窗、账单、改名和主题功能的计算逻辑未改动。

### 单次自动的边界

- 默认关闭；同一个挑战框文档的生命周期只发出一次自动识别许可。许可写入独立的扩展 session 存储，服务工作线程重启不会重试；浏览器会话最多 64 个框，超过后交回手动。刷新页面创建新文档属于新的生命周期，不承诺跨刷新保持服务端挑战身份。
- 顶层 Arena 页面确认具体 iframe 可见，挑战框还检查前台及交叉可见性；切到后台、隐藏框、关闭开关或挑战音频更新时停止后续动作，不覆盖已经输入的手动内容。已经开始的本地计算不会强行中断；填入/提交前再次复核状态。
- 无可用音频、模型缓存缺失、正在处理其他语音任务或失败即停止，不排队、不重试、不刷新挑战。识别只读取缓存（local_files_only），模型下载仍只能通过手动准备按钮。
- 「已提交」不等于验证通过；不支持 Cloudflare / hCaptcha，也不会自动恢复探测或抽卡。

## 实现与分发

- 运行文件：`buster/`；配置命名空间：`amp.buster.v1.`。初始化和清理不会清除宿主扩展数据。
- GPL-3.0-only 许可：根 `LICENSE`；原有 ModelTrace MIT 声明保留。
- 适配后的对应上游源码：`vendor/buster/upstream`；构建适配脚本：`tools/integrate-buster.mjs`。
- `tools/package.mjs` 根据 `buster/runtime-files.json` 纳入动态 JS/WASM、选项页、语言目录、许可证和对应源码。模型权重不打包。
- 复现：以脚本指定 commit 克隆上游，使用上游支持的 Node 工具链执行 `npm ci`；在本项目执行 `node tools/integrate-buster.mjs <上游目录> prepare`；在上游目录设置 `ENABLE_CONTRIBUTIONS=false` / `ENABLE_SPONSORS=false`，运行 `npm run build:prod:chrome`；最后回到本项目运行脚本的 `import` 阶段。必须使用干净的上游克隆与不存在的目标集成目录，避免覆盖。`recopy` / `catalog` 仅用于本次导入的恢复，不用于修改其他扩展数据。

本次仅进行了批准的 Buster 依赖安装与必要模块构建，未进行全项目测试、打包发布、真实验证码验收或 Git 提交推送。实际浏览器行为待用户验收。
