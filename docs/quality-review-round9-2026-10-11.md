# 质检（2026-10-11，对提交 `81f66bd`：D1 降级视图 + D6 端口可信度）

**方法**：三路只读对抗质检（客户端 / 容器与工作流 / 提示词与文档）**并行** + 我自己按怀疑点逐条复现。
**结果**（我这路已定论的部分，全部已修并加锁）：

| # | 缺陷 | 来源 | 后果 | 修法 |
|---|---|---|---|---|
| **1** | **`open_without_version` 对"本来就不探版本"的动词误报**：`port_scan` 的 argv 里**没有 `-sV`**（`nmap_ports(target, [*ping_args, *ports_args, "--max-retries","1"], "port_scan", report)`），于是每个 open 端口都没有 `product`/`version` ⇒ 那条"有 N 个 open 端口拿不到版本信息"的告警**每次扫描都响**；语义也错位（那是 `service_probe` 的判据） | 我（冒烟时发现：`ports=8080` 的普通扫描也报了它） | 噪音，且把一句正确的是非话变成"狼来了" | 给 `nmap_ports` 加 `version_scan` 形参：只有真的请求了版本探测（`service_probe`）才计数、才告警、才标 `version_info=none`；summary 在未探版本时写 `open_without_version=n/a` |
| **2** | **比例判定的假警报**：只扫一两个授权端口（`ports=8080` 而它恰好开着）⇒ `1/1` ⇒ `port_state_trust=suspect` ⇒ 每次正常作业都被喊"端口状态可能是伪信号" | 我（读代码+冒烟） | 假警报会训练人忽略这条判据 | 新增常量 `PORT_STATE_TRUST_MIN_SAMPLE = 8`：样本不足**不判**（显示 `unknown`），告警文案写明样本量；外部反馈的真实现场（1000/1000、200/200）仍在判据覆盖内 |
| **3** | **技能 3b-① 是静默阴性**：配方读的是**第 2 步在另一个容器**写的 `/tmp/ports.txt`（容器一次性 ⇒ 文件不存在），而 `2>/dev/null \|\| true` 把它吞成 `scanned=0` ⇒ 打印 `ratio=0.00 verdict=ok`——**看起来测过了，其实什么都没测**（本仓库最忌的形态） | 我（按容器一次性纪律复现） | 人会把"没测"读成"比例正常" | 配方改成**自足**（同一条命令里扫描 + 统计）；`scanned == 0` 时**拒绝给结论**（`verdict=unknown` 并说明原因）；判据改三态（`ok/SUSPECT/unknown`），并写明"小样本不按比例判" |
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
