# 已知问题与发布前待办

这份清单记录 `dsh-buddy-suite` 当前**尚未解决**的问题。按影响面排序：前两类会影响使用者，第三类是发布工作本身。

> 状态说明：✅ 已验证　⚠️ 未验证　❌ 已知缺陷
>
> **主动放弃**的功能不在这份清单里，见 `NON-GOALS.md`——那里记的是"想清楚了不做"，不是"还没做"。

---

## 一、与 dsh-workbuddy-connect 的关系

**这两个插件是互斥替代关系，不是并列共存关系。**

本插件的定位是「一个插件同时提供模型接入与每日签到」，让用户不必分别安装 `dsh-workbuddy-connect`（模型）和 `dsh-buddy-checkin`（签到）。装本插件即替代前两者。

之所以必须替代 `dsh-buddy-checkin`：它在 `0.4.0`（2026-10-10）之后未再更新，peer 上界停在 `0.2.0-rc.2`，在 `0.2.1-rc.2` 内核上会被 DSH 直接拒绝安装。

> 因此「模型选择器出现两个 WorkBuddy 分组」**不是缺陷**：只有同时安装两个插件才会发生，而正确用法是二选一。

### id 已命名空间化 ✅

两侧 id 原本完全相同，同装会互相覆盖。现已全部加上本插件的命名空间，使得「误装两个」时不至于静默替换，而是各自可见：

| 冲突点 | 上游原值 | 本插件现值 |
|---|---|---|
| Cordis 节点 id | `llm-workbuddy` | `llm-workbuddy-suite` |
| provider id | `workbuddy` / `workbuddy-ai` | `workbuddy-suite` / `workbuddy-ai-suite` |
| 浮层 entry id | `workbuddy-update` | `workbuddy-suite-update` |
| 推理控件 entry id | `workbuddy-probe` | `workbuddy-suite-probe` |
| 探测状态文件名 | `.workbuddy-probe.json` | `.buddy-suite-probe.json` |
| 国际版探测状态文件名 | `.workbuddy-ai-probe.json` | `.buddy-suite-ai-probe.json` |

已在真实配置下验证两者可同时运行、无冲突报错。

> **探测状态文件为什么必须分开**：探测记录带 catalog 行指纹，两个插件的 catalog 行只要差一个字段
> （如 `supportsImages`），就互相认不出对方的记录——于是各自丢弃对方**已经付费探测过**的结果，
> 用户被迫重复探测、重复消耗积分（GLM-5.1 一发 `x0.79 credits`，一轮 6~7 发）。
> 旧文件**不迁移、不读取、不改写**：里面的记录混着 connect 的版本号，且可按需重建。
> 本插件自己的旧记录（`kimi-k2.6`@0.1.0、`mimo-v2.6-pro`@0.1.1）如需保留需显式提出。

**但推荐用法仍是只装本插件**，并移除 `dsh-workbuddy-connect`。移除后本插件独占，模型选择器只出现一个 WorkBuddy 分组。

### 与 dsh-buddy-checkin 并存时 ⚠️

两者写同一个状态文件 `$DSH_HOME/.buddy-checkin.json`（同源代码，格式恰好兼容）。若同时安装，任一方的写入会覆盖另一方。同样按「二选一」使用即可规避。

---

## 二、功能与运行环境

### 已修复 ✅

| 问题 | 表现 | 修复 |
|---|---|---|
| Electron 定位不回退 | 模型 provider 报 `signed-out`，而签到正常 | 平台默认路径改为「候选」，必须验证存在才采用，否则继续走注册表发现 |
| 注册表单步超时过短 | 签到报「auto-location could not complete」，但 App 明明装了 | 单步 3s → 10s（全量枚举注册表在软件较多的机器上会超过 3s） |
| 机制文案缺失 | 徽章显示字面量 `probeDeclaredSuffix` | 补齐中英文案 |
| 重名模型无法区分 | 两个 model id 都叫 `Hy3` | 重名时附加费率：`Hy3 · x0.00` / `Hy3 · x0.05` |
| 有效结果排最底 | 唯一有档位的模型排在 11 行末尾 | 按信息价值排序：有效档位 → 未检测 → 不可调 → 未完成 |
| 按钮不可见 | 降级样式把边框也设成透明，控制消失了 | 保留可见边框，只去掉填充色 |
| 输入框控件无法关闭 | 已装余额插件的用户、多供应商切换的用户会看到重复控件 | 卡片内新增「输入框显示」两个独立开关，按机器保存 |
| 界面显示 key 名 | 关闭 `dsh-workbuddy-connect` 后，卡片所有文案显示成 `title`、`accountHeading` 等标识符 | 换用本插件专属的 locale 命名空间 `settings.buddy-suite`（原与 connect 共用 `settings.workbuddy`，字典被抢）；并加兜底：查不到词条时回退内置中文表，不再回退为 key 名 |
| 签到面板未汉化 | 结果、按钮、错误原因整块是英文，而面板本身是中文 | 面板与宿主侧的用户可见字符串全部改为中文；新增 `tests/localization.spec.ts` 守卫防复发 |
| 探测结果互相作废 | 装了两个插件时，GLM-5.1 永远显示「检测未完成」，但另一插件确实探测过 | 探测状态文件按插件命名空间化（见上），两侧记录互不影响 |
| 兜底目录能力信息失真 | 降级模式下 `glm-5.1` 谎报支持图片、`glm-5.3-flash` 谎报可关思考（上游返回 400） | 兜底目录逐字段对齐上游 `dsh-workbuddy-connect` 的 2026-10-17 快照（CN 19 个 / 国际 20 个模型，零差异） |
| 探测失败原因被丢弃 | 探测失败只显示「检测未完成」，用户无法知道是上游拒绝还是请求根本没发出去 | `reason`（失败阶段 + 上游错误码 + 上游原始错误消息）随记录落盘，并显示在卡片徽章与输入框控件上 |
| 基线请求被模型下限拒绝 | `glm-5.1` 永远「检测未完成」，实测原因是基线请求 `max_tokens: 1` 被拒（400 / `1210`），与推理档位无关 | 基线在 400 时用 `max_tokens: 16` 重试一次（国际版 GPT 系早有同类下限问题）；哨兵与档位探测仍用 1，不增加正常探测成本 |
| 拒绝「缺省档位」的模型判不出来 | `glm-5.1` 收到不带 `reasoning_effort` 的请求直接 400 / `1210`「the reasoning effort value is not supported by the current model」，基线永远失败，模型被误判为不可检测 | 基线改发目录声明的 `defaultEffort`（上游自己说该模型用的档位），不再省略字段；并改为按上游**错误消息**归属 effort 拒绝（CN 端复用泛化码 `1210`，仅凭错误码无法区分） |
| 泛化码认不出 effort 拒绝 | `deepseek-v4-pro` 哨兵被拒（400 / `invalid_parameter_value`「the request parameters were rejected by the model provider」），因码不在识别表被判 `unknown`，一个本可验证的模型无法检测 | CN 端识别表补入 `invalid_parameter_value`；归因依据与上游泛化码一致：基线已用**除 effort 外完全相同**的请求通过，故该字段是拒绝的唯一差异 |
| 失败模型只能逐个重试 | 面板一行一个「重新检测」，多个模型失败时要重复点很多次 | 新增**一键批量探测**：只访问尚未判定完成的候选，串行执行（永不并发，不与真实对话争用），按 5 秒一次的状态刷新显示 `已完成/总数` 进度，账号切换时自动中止；确认框先用最坏情况（每模型 8 次请求）报出上限再扣费 |
| 失败信息看不懂 | 徽章直接贴上游英文原文（如 `sentinel status 400 (invalid_parameter_value): the request parameters were rejected by the model provider`），一个 pill 被撑爆且没有可执行信息 | 新增**错误诊断**：按失败阶段 + 错误码 + 上游消息归类为「请求没送达 / 登录失效 / 限流 / 上游报错 / 模型不存在 / 输出上限过低 / 上游拒绝档位 / 参数被拒」，徽章只显示短诊断，原始记录保留在气泡与状态文件里；未识别的错误不猜，回退原文 |
| 报问题时靠人工翻文件 | 每次都要手动找探测记录、翻日志、截图 | 新增**一键复制诊断信息**：把版本、provider、目录来源、全部探测记录与原始失败原因打包成 JSON 写进剪贴板；打包时**强制剥除 `probeKey`**（进程内授权扣费的密钥），可直接贴给 Agent 或 issue |
| 批量探测不知道要花多少 | 只提示「最多 N×8 次请求」，用户无法换算成积分 | 确认框增加**费用预估**：按目录标价算出「约 X 积分 / 最坏 Y 积分」，并对未标价的模型单独计数（不当作免费） |

### 已验证 ✅

在真实 DSH 进程中（非沙箱）实测：

- 签到状态 `ok`，正确识别「今日已在 App 签到」并跳过重复请求
- 余额读取正常（13486）
- 余额刷新正常（重查后 13408）
- 失败重试接口正常返回
- 输入框开关：关闭单项后 status 文档同步反映、两项互不影响、写入文件、**重启后仍然生效**
- **实际对话可用**：用户已用本插件注册的模型（`workbuddy-suite/hy4-preview`）完成整轮对话，链路全程工作
- **界面文案正常**：用户亲眼确认卡片与输入框显示中文，不再出现 key 名（此前关闭 connect 时会）

### 遗留问题 ⚠️

- **本插件自带的 provider id 仍带 `-suite` 后缀**（`workbuddy-suite`）。既然它与 connect 是互斥替代关系，本可用 `workbuddy`；但改动涉及代码与测试，为不影响即将进行的提交而暂未调整，建议后续版本统一。

- **沙箱环境无法运行签到**。签到需要 spawn 子进程（`reg.exe` 查注册表、启动 WorkBuddy 的 Electron 取密钥），而受限环境（如本开发沙箱）会以 `EPERM` 拒绝。**这是环境限制，不是代码缺陷**，普通 DSH 运行不受影响。诊断信息会如实显示为「could not complete」而非误报「未安装」。

- **未在 Linux / macOS 真机验证**。Electron 定位实现了 macOS 默认路径与 Windows 注册表发现，Linux 需要显式指定 `WORKBUDDY_ELECTRON_BIN`。只有 Windows 实测过。

- **国际版（WorkBuddy AI）未验证**。本机未安装国际版 App，相关路径（`workbuddy-ai-suite` provider、`/ai/status` 路由）只做了「无凭据时返回 signed-out」的验证，没有真实账号跑通过。

- **签到仅国内版**。国际版 token 调国内签到端点返回 401，这是上游限制。

- **Windows 上「回收 PID」保护失效**。`host-heartbeat.ts` 用 `wmic process ... get CreationDate` 读进程启动时间，但 Windows 11 当前版本**已移除 `wmic`**（本机实测 `wmic` 不存在），于是 `processStartTimeMs()` 恒为 `undefined`，`isHeartbeatProcessAlive()` 退化成「PID 存在即存活」。后果：宿主机崩溃后若该 PID 被无关进程复用，CLI 的 `status` 会把 stale heartbeat 误报成「Host running」。不影响插件运行与模型接入。
  - 建议改法：Windows 分支改用 `powershell -NoProfile -Command "(Get-Process -Id <pid>).StartTime"`（或 CIM `Win32_Process.CreationDate`），保留 `parseWmiCreationDate` 作为解析器；两者输出都能落到现有的 CIM_DATETIME / 本地时间解析路径。
  - 现状由 `tests/host-heartbeat.spec.ts` 的「degrade to PID liveness」用例如实记录，不假装强保护仍生效。

---

## 三、发布与验证

### 已完成 ✅（本节旧版曾把它们误列为待办）

| 项 | 现状 |
|---|---|
| `repository` 字段 | 已补 `git+https://github.com/chenpiyanghappy/dsh-buddy-suite.git`。`homepage` / `bugs` 建议后续一并补，让 npm 页面有跳转，不阻塞发布 |
| `bin` 声明 | 已声明 `dsh-buddy-suite -> lib/bin.js` |
| `files` 漏英文 README | 已含 `README.md`、`README.en.md`、`KNOWN-ISSUES.md`、`LICENSE` |

### 版本兼容性 ⚠️

peerDependencies 精确锁定 `0.2.1-rc.2`。这是**刻意**的：内核 API 在 rc 之间有变动，锁死可以避免装上后崩溃。但代价是**内核升级就需要同步发版**。

另外，`dsh-buddy-checkin` 的 `0.4.0` 曾因 peer 范围不含 `0.2.1-rc.2` 被 DSH 拒绝安装——该问题已随其 **v0.4.1（2026-10-19）** 修复，现在两个插件都能装。它仍在正常维护（5 周内 8 个版本），只是功能与本插件重复，仍按二选一使用。

### 本地安装使用绝对路径 ⚠️

`dsh plugin add <路径>` 会写入 `link:D:/AI Agent/...` 这样的绝对路径，**只在本机有效**。发布版使用者走 npm 装，不受影响；但如果文档里写「本地开发安装」，需要说明这一点。

### 未在干净环境验证安装 ❌

当前所有验证都是 `link:` 到源码目录。**没有测试过** `npm pack` 后从 tarball 安装的完整流程（包括 `lib/` 是否自包含、peer 是否满足）。

---

## 四、文档待补

- 两个 WorkBuddy 分区出现时，如何选择、能否只装签到
- 沙箱/受限环境下的已知限制
- 未验证平台（Linux / macOS / 国际版）的说明

---

## 附：修复这些问题的验证方式

```sh
# 类型检查 + 测试 + 构建 + 三项自检
pnpm run check

# 受限环境（沙箱禁止 spawn）下跑测试
pnpm run check:offline
```

当前状态：typecheck 通过，359 个测试通过（28 个文件），三项自检通过。
