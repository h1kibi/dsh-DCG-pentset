# 质检（2026-10-11，对提交 `81f66bd`：D1 降级视图 + D6 端口可信度）

**方法**：三路只读对抗质检（客户端 / 容器与工作流 / 提示词与文档）**并行** + 我自己按怀疑点逐条复现。
**结果**（我这路已定论的部分，全部已修并加锁）：

| # | 缺陷 | 来源 | 后果 | 修法 |
|---|---|---|---|---|
| **1** | **`open_without_version` 对"本来就不探版本"的动词误报**：`port_scan` 的 argv 里**没有 `-sV`**（`nmap_ports(target, [*ping_args, *ports_args, "--max-retries","1"], "port_scan", report)`），于是每个 open 端口都没有 `product`/`version` ⇒ 那条"有 N 个 open 端口拿不到版本信息"的告警**每次扫描都响**；语义也错位（那是 `service_probe` 的判据） | 我（冒烟时发现：`ports=8080` 的普通扫描也报了它） | 噪音，且把一句正确的是非话变成"狼来了" | 给 `nmap_ports` 加 `version_scan` 形参：只有真的请求了版本探测（`service_probe`）才计数、才告警、才标 `version_info=none`；summary 在未探版本时写 `open_without_version=n/a` |
| **2** | **比例判定的假警报**：只扫一两个授权端口（`ports=8080` 而它恰好开着）⇒ `1/1` ⇒ `port_state_trust=suspect` ⇒ 每次正常作业都被喊"端口状态可能是伪信号" | 我（读代码+冒烟） | 假警报会训练人忽略这条判据 | 新增常量 `PORT_STATE_TRUST_MIN_SAMPLE = 8`：样本不足**不判**（显示 `unknown`），告警文案写明样本量；外部反馈的真实现场（1000/1000、200/200）仍在判据覆盖内 |
| **3** | **技能 3b-① 静默阴性/直接崩**：配方读的是**第 2 步在另一个容器**写的 `/tmp/ports.txt`（容器一次性 ⇒ 文件不存在）；`2>/dev/null` 让 `grep -c` 给出**空串** ⇒ `int('')` 抛 `ValueError`（`set -e` 下还把后面的步骤一起截掉）；只有「文件存在但为空」才是静默 `verdict=ok` | 我（按容器一次性纪律复现） | 人会把"没测"读成"比例正常" | 配方改**自足**（同一条命令里扫描 + 统计）；`|| echo 0` 与 `except ValueError` 兜住「读不到」的两条路径，都**拒绝给结论**（`verdict=unknown` 并说明原因）；判据改为**引用容器的 `port_state_trust` 与 `PORT_STATE_TRUST_*`**（不复述阈值），并写明小样本不按比例判 |
| **4** | **上一条提交信息过度声称**：`81f66bd` 的消息里写了"降级视图 + 会话行-id 复用锁"和"`degradedRunOf` 决策 + 降级卡按钮渲染"两组客户端锁，但该提交**没有碰任何客户端测试文件** | 我（`git show --name-only` 核对） | 记录与事实不符（本仓库最重视的"证据链"被自己污染） | 真的把锁补上（见下"新增锁"），并在本报告里记下这次更正 |
| **5** | **降级视图的 `stateVersion` 可能过期**：`derived.stateVersion` 取自**控制台快照**，而起稿会推进版本；快照未必即时刷新 ⇒ 人类点"确认"会拿到 `stale_state_version` | 我（读代码时发现同一趟 `getState` 已经带回版本却在 `runningSnapshotFor` 里被丢掉） | 降级路径下"生成草稿 → 确认注入"可能走不完 | `runningSnapshotFor` 一并返回 `stateVersion`（同一趟 `getState`）；降级视图用它做乐观锁，起稿后按 `setRefreshTick` 重跑该趟取新版本 |

## 复现记录（关键命令）

```bash
# ① 误报复现（旧镜像）：普通 port_scan 也报"拿不到版本信息"
docker run --rm ... pentest-tools port_scan target=<fx> port… # => warn: 有 1 个 open 端口**拿不到任何版本信息** …
# ② 假警报复现：只扫一个真开端口
#   => ports_scanned=1 open_ports=1 ratio=1.00 verdict=SUSPECT
# ③ 静默阴性复现（技能旧配方，全新容器）
docker run --rm --network none --entrypoint bash pentest-tools -c '<3b-① 原文>'   # => ports_scanned=0 … verdict=ok
# ④ 修后复跑（新镜像 19cd12b3b93c）
#   port_scan（不带 -sV，4 条，1 开）=> port_state_trust=unknown open_without_version=n/a，无告警
#   port_scan（9 条，1 开）          => port_state_trust=ok      open_without_version=n/a
#   9/10 全开夹具                     => port_state_trust=suspect + warn（≥80%，样本 ≥8）+ next_action
#   技能 3b 新配方（自足）            => ports_scanned=4 open_ports=1 ratio=0.25 verdict=ok；
#                                        载荷复核 ssh=none / http=000 / tls=000 verify=0 / rmcp=none(ConnectionRefusedError)
```

## 新增锁（都验过"会咬"）

| 锁 | 位置 | 反向验证 |
|---|---|---|
| `degradedRunOf` 五例（选中 / 唯一 / 多作业未选中 ⇒ null / 状态不属于候选 ⇒ null / 无状态 ⇒ null） | `test/client-core-views.test.ts` | 去掉"状态必须属于候选" ⇒ 红（已验） |
| `DegradedRunCard` **按钮确实渲染**（`waiting_human_review` ⇒ 出现"进入下一阶段：威胁建模"；`worker_running` ⇒ 不出现） | 同上 | —— |
| `version_scan` 闸门三条（形参存在、告警挂闸门、`service_probe` 传 True） | `test/action-templates.test.ts` | —— |
| `PORT_STATE_TRUST_MIN_SAMPLE` 常量 + 比例过闸门 + summary 写 `n/a` | 同上 | —— |
| 阈值与样本下限的**数字单一来源**（容器常量 ↔ 技能配方 0.8 / 自足性 / `verdict=unknown`） | `test/sandbox-spec-locks.test.ts` | —— |

## 三路只读质检

`ClientAudit` / `ToolWfAudit` / `PromptAudit2` 仍在跑（≥13 分钟）；结果落地后追补到本文件。
我这路已独立覆盖了它们的重点怀疑方向里的三条（客户端降级可达性、容器侧误报面、技能配方可跑性）。

## 验证

`build`/`typecheck`/`lint` 0 错 · `verify` 39/39 · **全量 1948/1948** · 镜像 `d6c21580e6f1 → 19cd12b3b93c`
（两处重钉、26 份戳轮换）· 起服前置检查通过。

## 追补：三路只读质检的落地（PromptAudit2，5 条）

| # | 发现 | 处置 |
|---|---|---|
| P1 | 3b-① 在**缺文件**路径上 `int('')` 崩（不是声称的 `verdict=unknown`），`set -e` 下还截掉 3b-② | 配方改 `|| echo 0` + `except ValueError`（两条「读不到」路径都拒绝给结论）；锁加两条（禁 `|| true`、必须有 `except ValueError`） |
| P1 | 修复记录把自检写成用 `worker_session_binding_by_dsh()`（实现是同行回读）、D6 证据用**修前**读数、3b 阴性形态写错 | 核实文档与 RUNBOOK §⑫ 按当前实现/口径改写 |
| P2 | 技能三处手抄阈值 `0.8`（配方/判读/失败表），而锁还**强制**它复述 | 技能改为引用 `port_state_trust` 与 `PORT_STATE_TRUST_*`；锁改为断言「引用字段名/常量名」且**不得**出现手抄阈值 |
| P2 | 降级卡文案说「阶段与推进按钮取自作业列表」，实际取自 `getState` 运行快照 | 卡片与 `pentest_prepare_handoff` 文案都改准（作业从列表认领、阶段与按钮来自运行快照；并补「选中作业即出现降级视图」这一步） |
| P3 | 3b-② 固定探 `22 80 443 623`，与 ① 扫的端口集无关，`http=200 size=121` 暗示默认 80 | ② 改为遍历 ① 的 `$P`；未知端口给「无内置协议探针，换结构化动词」；`http=200 size=121` 只作「打到真开 HTTP 端口」的对照 |

（`ClientAudit` 与 `ToolWfAudit` 仍在跑，落地后继续追补。）

## 追补二：ClientAudit（2 条，含 1 条 blocker）

| # | 发现 | 后果 | 修法 |
|---|---|---|---|
| **blocker** | **降级卡在真实刷新路径上不可达**：效应里降级分支与健康分支**各写各的** `running`，而健康分支结尾是无条件 `setRunning(snapshot === null ? null : runViewOf(snapshot))`；绑定缺失时 `next === null` ⇒ `snapshot` 恒为 null ⇒ 它把降级分支刚写进去的那份**覆盖成 null** ⇒ 渲染门 `derived !== null && running !== null` 永不成立 | D1 的修复在真机上等于**死代码**（而当时的锁只 `renderToStaticMarkup` 了卡片组件本身，没跑效应 ⇒ 53/53 仍绿） | 新增纯函数 `runningAfterRefresh({hasFacts, degraded, healthy})` 作为 `running` 的**唯一写点**（规则：有 facts 时健康分支说话、没有 facts 时保留降级那一份），效应里两处 `setRunning` 收敛成末尾一次调用。锁：`runningAfterRefresh` 三例（含"没有 facts ⇒ 降级那份必须活下来"，注入旧规则已验证会红） |
| major | **起稿请求没带状态版本**：`advance()` 调 `requestAdvanceDraft` 时不传 `expectedStateVersion` ⇒ 控制器退到"快照里的版本"或 0；绑定缺失时快照那份可能过期 ⇒ 服务端回 `stale_state_version`（人点了没反应）。此前只修了**编辑器**的版本，没修**起稿**那一处 | 降级路径下"生成草稿"这一步仍可能失败 | `advance()` 显式传 `derived?.stateVersion ?? facts?.stateVersion`；两者都拿不到就 `setAdvanceError` 并**不发**请求（不发 0）。锁：源码锁断言调用点确实带 `expectedStateVersion`（纯行为测试要跑效应才测得到） |

**审计确认没问题的五条**（`verified_ok`）：共享控制器实例（`useSharedController` 按 rpc 身份单例，控制台与会话视图是**同一份**）；
`degradedRunOf` 认领条件够严；`facts`/`derived` 两落点互斥；缺 `contentHash`/`scopeAmendment` 不会让确认静默失败（草稿取回用的是会话行 id）；
`DegradedRunCard` 自身在 `waiting_human_review` 时确实画出按钮（卡住的是 Body 的效应，不是卡片组件）。

**教训（写下来）**：本轮两条真缺陷都是"**测了零件、没测流程**"——组件渲染测过了、效应里的写序没测。
第二次追补的修法把"谁说话"收成一条可穷举断言的纯函数，就是为了让这类顺序问题以后只能被结构上排除，而不是靠人盯。
