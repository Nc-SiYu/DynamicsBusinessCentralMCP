# CSY Agent — BC MCP Alpha

[中文](#中文) | [English](#english)

## 中文

CSY Agent 用于通过本机 Gateway，将 DeepSeek Harness Web 连接到 Microsoft Dynamics 365 Business Central 原生 MCP，供学习、测试与演示使用。

**这是 Windows x64 测试程序候选包，不是稳定版，也不是完整源码开源发布。仅面向 BC On-Prem 测试环境；当前不支持 BC Online。**

需要 Windows 10/11、支持原生 MCP 的 BC On-Prem 环境、有效且受信任的 HTTPS 证书、DSH 0.1.2-alpha.1 / Cordis 4.0.1、Node.js 24、Python 3.12+ 和 x64 PowerShell 7。

1. 获取提供者发布的完整 ZIP，解压到可写目录，保留全部文件。
2. 按[中文指南](docs/使用说明-中文版.md)配置 BC，打开 `CSY.exe` 并保存连接。
3. 运行 `connect.cmd`，配置模型，新建会话并选择 **CSY Agent**。
4. 先使用指南中的只读查询验证连接。日常启动使用 `CSY.exe` → `Start-Harness.cmd`。

绑定失效时按指南运行 `connect.cmd --refresh-binding`。`Already configured` 仅表示已有配置，不证明绑定有效或 BC 可访问。

尚未完成干净电脑和当前候选包的完整 BC/Harness 端到端验收；多 Agent 并发未验收。程序未签名。BC 中开放的工具可能修改业务数据，请勿连接生产环境。

本包不包含个人连接资料；使用后生成的 `data/` 不应分享或提交。项目暂不授予开源许可，见[分发说明](DISTRIBUTION-NOTICE.md)；第三方许可见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。

## English

CSY Agent connects DeepSeek Harness Web to native Microsoft Dynamics 365 Business Central MCP through a local Gateway for learning, testing and demonstrations.

**This is a Windows x64 Alpha test candidate, not a stable release or a complete open-source release. It targets BC On-Prem test environments; BC Online is not supported.**

Requirements: Windows 10/11, BC On-Prem with native MCP, valid trusted HTTPS, DSH 0.1.2-alpha.1 / Cordis 4.0.1, Node.js 24, Python 3.12+ and x64 PowerShell 7.

1. Obtain the provider's complete ZIP and extract it to a writable folder. Keep all files together.
2. Follow the [English guide](docs/User-Guide-English.md), open `CSY.exe` and save the BC connection.
3. Run `connect.cmd`, configure a model, create a session and select **CSY Agent**.
4. Verify with the guide's read-only query. For later starts use `CSY.exe` → `Start-Harness.cmd`.

For an invalid binding, follow the guide and run `connect.cmd --refresh-binding`. `Already configured` confirms installation state only, not binding validity or BC access.

Clean-machine testing and full BC/Harness end-to-end acceptance of this candidate remain pending. Concurrent multi-agent use is unverified. The application is unsigned. Enabled BC tools may modify business data; do not connect to production.

No personal connection state is included. Never share or commit the generated `data/` folder. No open-source license is granted for this project; see the [distribution notice](DISTRIBUTION-NOTICE.md). Third-party terms remain in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
