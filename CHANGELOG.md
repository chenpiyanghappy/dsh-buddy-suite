# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。所有条目按发布顺序倒排。

## 0.1.3-final（未发布）

> 最终版本。本项目已停止维护并归档，见 [`README.md`](./README.md) 顶部公告；支持范围见 [`COMPATIBILITY.md`](./COMPATIBILITY.md)。安装方式止步于本版本，不承诺未来修复。

### 优雅降级与健康检查（T1 / T2）

- **上游调用失败不再拖垮插件注册**：provider 注册回调与上游调用统一包 `safeCall()`，失败时降级为可解释状态，而不是抛错让整块注册逻辑退出。错误归入五类 —— `CREDENTIAL_MISSING` / `CREDENTIAL_DECRYPT_FAILED` / `UPSTREAM_UNREACHABLE` / `UPSTREAM_PROTOCOL_CHANGED` / `RATE_LIMITED`；状态位 `health`（`ok` / `degraded` / `down`）与 `lastError`（失败阶段 + 错误码 + 上游消息）随状态文档对外可见。
- **模型选择器按健康度置灰**：`degraded` / `down` 时对应模型置灰，并用 tooltip 给出短诊断，避免用户误以为「模型不存在」。
- **签到遇到限流 / 协议变更停止重试**：`RATE_LIMITED`、`UPSTREAM_PROTOCOL_CHANGED` 时不再反复请求，直接给出可读提示。
- **健康检查三态**：`status` / `doctor` 输出 `plugin_ok` / `upstream_changed` / `credential_invalid` 三态；`--json` 输出一份无密钥诊断 JSON（强制剥除 `probeKey` 等密钥字段）；插件卡片状态灯随三态变色。

### 更不容易出错

- **修正 pi-ai 版本常量**：`REQUIRED_PI_AI_VERSION` 长期停在 `0.87.1`，而 `package.json` 的 `@earendil-works/pi-ai` 依赖早已是 `1.3.0`，于是**每次正常启动都打印「the wrong copy is being resolved」**，把真正需要被看见的告警淹没在噪音里。现已对齐 `1.3.0`，并由 `tests/pi-ai-guard.spec.ts` 断言该常量与依赖一致——以后升级依赖忘了改常量会直接测试失败。
- **测试从 172 项扩到 431 项**（17 → 33 个文件；其中收尾的 T1/T2/T4 新增 5 个文件、71 项），补齐原本**零覆盖**的模块：`adapter`（模型可见性与档位映射）、`auth`（身份选择 / identity-beats-expiry / 区域不匹配 / refresh 单飞）、`catalog-store`、`visibility-store`、`client-identity`（UA 三段组装与版本回退链）、`app-version`、`state-paths`、`host-heartbeat`、`wsl`、`legacy-settings`、`pi-ai-guard`。其中 `state-paths` 把三个状态文件名写成断言——这是与上游 `dsh-workbuddy-connect` 隔离的红线。不含渲染快照，也不含「调用一下不报错」式用例。
- **Windows「回收 PID」保护恢复生效**：`host-heartbeat.ts` 原先用 `wmic process ... get CreationDate` 读进程启动时间，而 Windows 11 已移除 `wmic`，导致启动时间恒为 `undefined`、存活判断退化成「PID 存在即存活」，宿主机崩溃后 PID 被复用时 `status` 会把 stale heartbeat 误报成「Host running」。现改用 PowerShell `Get-Process .StartTime`，格式化为 CIM_DATETIME 后仍由 `parseWmiCreationDate` 解析；并新增「平台命令可 spawn 时必须返回真实启动时间」用例防回归（受限沙箱禁止 spawn 时按文档退化为 `undefined`，测试跳过该强断言）。

### 工程与文档

- **凭据解密模块隔离（T4，纯重构）**：把 `src/auth.ts`（`WorkBuddyCredentialStore`）与 `src/desktop-credential-protection.ts`（`WorkBuddyAtRestKeyProvider`）共用的「at-rest 解密 + key 解析 + Electron 发现」抽进新目录 `src/credential/`（`types` / `decrypt` / `discover` / 统一出口），`desktop-credential-protection.ts` 退化为 re-export 薄壳，`auth.ts` 改为从新模块 import。行为不变，原单测兜底。新增脱敏 fixture 单测覆盖明文 / at-rest 解密 / 目录缺失 / 密钥不匹配 / 多账号枚举五类路径；fixture 全部合成，不含真实凭证、不联网、不需要真实 WorkBuddy 安装。
- **新增 [`COMPATIBILITY.md`](./COMPATIBILITY.md)（T3）**：DSH / Node / WorkBuddy / 操作系统的支持范围矩阵，区分「已验证」「声称支持」「不支持」，并声明它是 `0.1.3-final` 的静态记录、不承诺未来可用性。
- **停更公告（T5）**：README 顶部（中英文）加中性并诚实的归档 banner，对齐上游 `dsh-workbuddy-connect` 的《停止维护公告》——停更定性（经真机实测非官方客户端接入已不可行、走到生命末尾、不声称可用、不推荐沿用、如需接入请用官方客户端）、背景（WorkBuddy 自 2026-10-20 起限制非官方客户端，上游已停维并计划 2026-10-22 下线）、边界（不再适配 WB 私有协议）、历史记录（上游 issue #199 / #186 / #96 / #181 / #168 / #183 / #165 / #180 等与本版 T1/T2/T4，仅作历史交代、非能力承诺）与致谢；插件卡片内加停更公告位；`NON-GOALS` / `KNOWN-ISSUES` / `COMPATIBILITY` 同步到归档状态。
- **新增 GitHub Actions CI**（`.github/workflows/check.yml`）：`main` 每次推送、所有 PR 与手动触发都会在 **Ubuntu + Windows 双平台**（Node 22、pnpm 9、`--frozen-lockfile`）跑一遍 `pnpm run check`（typecheck + 测试 + 构建 + 三项自检），失败上传日志，重复推送自动取消上一轮。
- **新增 [`NON-GOALS.md`](./NON-GOALS.md)**：8 条主动放弃的功能及理由——薅积分自动化、接管登录 / refresh、并发探测、为双装做兼容增强、改 provider 后缀、国际版签到、逐请求积分明细、界面花活，每条都附推翻条件。
- **README 补「运行环境」**：明确 `node: ^22.19.0 || >=24.0.0`、Node 18 / 20 不在支持范围、`EBADENGINE` 警告不要忽略。此前只有一句「CI 用 Node 22」（写给贡献者的），使用者无从判断自己的环境够不够。
- `KNOWN-ISSUES` 清掉三项已完成的「发布前待办」，并改正 `dsh-buddy-checkin` 的兼容性表述（其 v0.4.1 已适配 `0.2.1-rc.2`，此前"会被拒绝安装"的说法已过时）。

## 0.1.2 — 2026-10-20

### 新功能

- **一键批量探测未完成模型**：卡片上「一键探测未完成（N 个）」一次跑完还没探测过的模型；串行执行、带进度显示，切换账号时自动停下。
- **批量探测费用预估**：确认框按目录标价换算成「约 X 积分 / 最坏 Y 积分」；**没有标价的模型单独计数，不当作免费**。
- **一键复制诊断信息**：把版本、provider、目录来源、全部探测记录与原始失败原因打包复制，可直接贴给 Agent 或 issue；打包时**强制剥除 `probeKey`**（进程内授权扣费的密钥）。

### 更不容易出错

- **错误诊断**：探测失败时不再把上游英文原文直接糊在徽章上，而是按「失败阶段 + 错误码 + 上游消息」归类为八类中文短句——请求没送达 / 登录失效 / 限流 / 上游报错 / 模型不存在 / 输出上限过低 / 上游拒绝档位 / 参数被拒。**未识别的错误不猜**，回退显示原文。
- **探测修复收尾**：CN 端点对 GLM-5.1 等模型「不带 `reasoning_effort` 的请求本身即回 400/1210」，导致基线请求失败、整轮检测未完成；现改为基线带目录声明的最低档位重试，并对点名 `reasoning_effort` 的 1210 按消息归因。GLM-5.1 与 DeepSeek-V4-Pro 现在都能正常检测。
- **探测状态与 `dsh-workbuddy-connect` 隔离**：探测与签到状态改用独立文件（`.buddy-suite-probe.json` / `.buddy-checkin.json`）。此前两个插件共用一份探测文件，而模型目录行存在字段差异，导致彼此的探测记录指纹不匹配、**已付费的结果被对方丢弃**、界面恒显示「检测未完成」。
- **兜底目录对齐上游**：修正 `glm-5.1`/`glm-5.2` 的 `supportsImages`、`glm-5.3` 与 `deepseek-v4.1-flash` 的 `supportedEfforts`、`glm-5.3-flash` 的 `canDisableThinking`；补入 `step-5-preview` / `space-bunny` / `glm-5.3-flashx`。
- 测试从 120 项增加到 **172 项**（17 个文件）。

### 文档与分发

- 补上 `dsh plugin --profile web add dsh-buddy-suite` 安装命令与插件市场徽章，README 截图段扩为 9 张实机截图；新增本更新日志。
- 已向 DSH 插件市场（dsh-plugin.org）提交收录申请。

### 已知未验证项

- 受限沙箱环境下的签到（环境限制，非代码缺陷）；
- macOS / Linux 真机未验证（仅 Windows 实测）；
- 国际版 WorkBuddy AI 未完整跑通（仅 signed-out 状态验证）。

## 0.1.1 — 2026-10-18

- 首个完整发布：模型接入 + 每日签到合成一个插件。
- 全中文界面；输入框积分徽标与推理档位显示可分别关闭。
- 与 `dsh-workbuddy-connect` 的命名空间隔离（provider / 节点 id / locale 命名空间），两个插件同装不互相覆盖。
- 适配 DSH 0.2.1-rc.2（同款适配已由维护者 PR #156 合入上游 `dsh-workbuddy-connect` v0.7.8）。
