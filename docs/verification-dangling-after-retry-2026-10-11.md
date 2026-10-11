# 外部缺陷报告核实与修复：重做之后作业悬空、两个修复入口不可达

**被核对象**：别人部署（`E:\0.SeeyonInstall\dsh-DCG-pentset-main`，GitHub 发布版）的控制台缺陷报告
（`缺陷报告-重做后作业悬空与按钮不可达.md`，2026-10-11，作业 `CDUT-known`）。
**核对人**：本仓库工作副本（`bfe5fa4` 之后）。
**方法**：逐条到**我们的**代码/真库/真部署里对证；能跑的一律跑（真 PostgreSQL、真启动对账、组件渲染）。

## 一、核实结论：报告的分析**逐条成立**，缺陷在我们仓库同样存在

| 报告的判断 | 我们的代码 | 判定 |
|---|---|---|
| 两个按钮是纯布尔计算，**状态机没算错** | `src/contracts.ts:134`（`terminal`）、`:140-142`（`canFinishTesting` 要求 `runMarker === 'running'`）、`:147-149`（`canRetryWorker`/`canReopenTechnicalWork`）与我们代码**逐字一致** | ✅ 成立 |
| `worker_running` 的两条出边在悬空态下都不可用 | `src/workflow/phases.ts:486-495`（`worker_running → report_ready`「人类结束技术测试」是 human 边）、`:174-180`（提交报告是 `recorded:false` 的 Agent 边）；前者被 `canFinishTesting` 的 `runMarker` 要求挡住 | ✅ 成立 |
| 启动对账把 `runMarker` 写成 `blocked` 而**不动主状态** | `src/workflow/recovery.ts:523-536`（注释原文：**只改运行标记**，**不动主状态**） | ✅ 成立 |
| **核心**：「重做」不校验会话存活，且失败后**不回滚主状态** | `src/workflow/sessions.ts:178+`（`retryWorker` 只校验主状态与 `active_agent_session_id !== null`）；`src/workflow/core.ts` 的 `createDshSessionOrMarkFailed` 失败时写 `worker_sessions.status='failed'` + `engagements.status='blocked'`，**从不碰 `current_status`** | ✅ 成立（且**第二条成因**：`markDeliveryFailure` 同样只写 blocked ⇒ 复用会话重做失败也进同一悬空态） |
| 附带：`active_agent_session_id` 指向终态会话却不被对账清理 | `src/workflow/intake.ts:272` 的注释**自己承认**了这件事 | ✅ 成立 |

⇒ **不是"只有他们那边有"的问题**：这是一条可复现的状态机缺口（缺"前置条件回滚"+"资源存活"校验+可用性提示）。

## 二、修法（四条，全部落地）

| # | 修 | 落点 |
|---|---|---|
| **F1** | **失败即结算悬空态**：`createDshSessionOrMarkFailed` 的失败分支与 `markDeliveryFailure` 都调用新的 `WorkflowCore.settleDanglingRunning`。规则：只在 `current_status='worker_running'` **且确实没有活会话**时，把主状态**回滚到最后一次转移的 `from_status`**（不猜：重做失败回 `waiting_human_review`、重开回 `report_ready`、切换回 `transition_confirmation`、启动回 `ready`），清空 `active_agent_session_id`，推进一版并写领域事件 `workflow.dangling_running_settled` | 新模块 `src/workflow/dangling.ts`（SQL 单一来源）+ `core.ts` |
| **F2** | **可用性加"活动会话存活"**：`runActionAvailability` 新增可选入参 `activeSessionStatus`（三态：`undefined`＝不知道⇒沿用旧判据、`null`＝没有会话、具体状态），`canRetryWorker` 多一个 `sessionUsable()`；被禁用时**理由指路**（"先「结束技术测试」再「重开技术工作」"） | `src/contracts.ts` + `src/client/views/RunControls.tsx` |
| **F3** | **启动对账结算悬空态**（按**作业**驱动）：`recovery` 新增 `#findDanglingRunning`（守卫与结算 SQL 同形）+ `#settleDanglingCandidates`，在 `recoverAll` 与 `recoverEngagement` 两处接入，结果进 `RecoveryReport.danglingSettled` | `src/workflow/recovery.ts` |
| **F4** | **界面**：① 活动会话徽标**标注会话状态**（`活动会话 482fb2a5（已失败）`，终态用 `attention` 色）；② 自相矛盾态（主状态说在跑 + 会话已终态/不存在）**显式告警并给出路**（"若「结束技术测试」是灰的先点「恢复」→ 结束技术测试 → 重开技术工作；**不要点「终止」**"） | `src/client/views/RunControls.tsx` |

**为什么 F3 不能复用"无主会话"扫描**：报告里那个会话是**终态 `failed`**，不在无主扫描的集合里（那个扫描找"还活着但没人驱动"的）⇒ 按会话驱动会**恰好在要治的场景下不触发**。这条在代码注释里写明了。

## 三、验证（真库 + 真部署 + 组件渲染）

| 证据 | 读数 |
|---|---|
| **真库行为锁**（`test/recovery.test.ts`，正例） | 造出报告现场（`worker_running` + `blocked` + 唯一会话 `failed` + 最后一次转移 `waiting_human_review → worker_running`）⇒ `recoverEngagement` 后：`danglingSettled=[{rolledBackTo:'waiting_human_review'}]`、库里 `current_status` 回滚、`active_agent_session_id IS NULL`、`state_version` +1、`status` 保持 `blocked` |
| **真库行为锁**（反例） | 同样的现场但会话**带有效租约且 active** ⇒ `danglingSettled=[]`、主状态与指针**不动**（第一版夹具栽在"没租约的会话会被对账判为残留"上，注释记了这条） |
| **真部署端到端** | 在个人库造同形作业 → 重启 dsh → 启动对账结算：`worker_running → waiting_human_review`、`state_version 41 → 42`、指针清空、审计事件 `workflow.dangling_running_settled`（`rolledBackTo=waiting_human_review`） |
| **可用性矩阵锁** | 报告 §4 的 7 行表逐行断言（含悬空态 `worker_running/blocked`：`retry=false reopen=false finish=false resume=true`） |
| **存活规则锁** | `failed/closed/superseded` ⇒ 禁用且理由含「重开技术工作」；`null` ⇒ 禁用；`active/waiting_human`/`undefined` ⇒ 照旧可用 |
| **组件渲染锁** | `renderToStaticMarkup(RunControls)` 含「自相矛盾的状态」「先点「恢复」」「重开技术工作」「不要点「终止」」与 `活动会话 w-failed（已失败）` |
| **棘轮** | 结算是一次**转移之外**的版本推进 ⇒ 登记 `NON_TRANSITION_VERSION_BUMPS`（`dangling-running-settle`）+ SQL 里带 `version-bump-registered` tag；赋值点计数自检 7 → **8**（棘轮按设计咬了一次） |
| 门禁 | `build`/`typecheck`/`lint` 0 错 · `verify` 39/39 · **全量 1959/1959** |

## 四、诚实标注

1. **没有可视核验**：本机的 omp 浏览器中继扩展未连接（`browser.open` 报 "extension never connected"）⇒ UI 部分只有**组件渲染测试**，没有真界面截图。服务端侧已 curl 确认控制台可服务（303）。
2. **临时夹具无法完全抹除**（我造在个人库里的那条 `qc-dangling-check`）：`context_events` 是**只追加**的（触发器拒绝 DELETE，§9.5），裸 SQL 删不掉；改走产品自己的路径（`archiveEngagement` → `purgeEngagement`）——内容已清空（`reports_left=0`、各内容表计数 0），按设计**永久保留审计骨架**（2 条事件、1 条转移、2 条决策、1 个会话骨架）与 1 条 `engagement_purges` 销毁记录。它在控制台里会以 `已归档/已清空` 的样子存在。
3. **本修的一个语义取舍**：回滚目标是**最后一次转移的 `from_status`**。对「切换阶段确认」失败的情形，它会回到 `transition_confirmation`（人类可重试确认）——草稿可能已被消费，重试会重新起草。这比把作业留在悬空态好，但不是无懈可击；如果未来要更精确，应按路径显式给回滚目标。
4. **报告 §3.2 的最后一条（放宽 `canFinishTesting`）我没有采纳**：`runMarker` 的要求有它的道理（暂停/阻塞时先恢复或终止，别把"停止工作"混进中间态），而 F4 的告警已把"先点恢复"这条出路显式打出来 ⇒ 保留约束 + 补指引，比放宽约束更保守。
5. `active_agent_session_id` 的清理只覆盖了**结算路径**；`intake` 那条指针（报告 §2.5 的附带缺陷）仍未纳入对账——与"清理终态会话指针"是另一件事，本轮不动（写在这里备查）。
