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
| **F1** | **失败即结算悬空态**：`createDshSessionOrMarkFailed` 的失败分支与 `markDeliveryFailure` 都调用新的 `WorkflowCore.settleDanglingRunning`。规则：只在 `current_status='worker_running'`、**运行标记非终态**、且**确实没有活会话**时，把主状态**回滚到"进入 `worker_running` 的那次转移"的 `from_status`**（不猜：重做失败回 `waiting_human_review`、重开回 `report_ready`、切换回 `transition_confirmation`、启动回 `ready`），清空 `active_agent_session_id`，推进一版并写领域事件 `workflow.dangling_running_settled`；**没有这个落点就不结算**（也不写事件） | 新模块 `src/workflow/dangling.ts`（SQL 单一来源）+ `core.ts` |
| **F2** | ~~可用性加"活动会话存活"：不存活时「重做」禁用~~ ⇒ **已被质检轮取代**（见 §五·1）：禁用是治症状，真正的修法是让「重做」在会话不可用时**按需新建会话**；契约层的存活判据已回退，界面按会话状态选请求哪种模式（`unknown` ⇒ 复用请求，服务端按事实降级） | `src/workflow/sessions.ts` + `src/client/views/RunControls.tsx` |
| **F3** | **启动对账结算悬空态**（按**作业**驱动）：`recovery` 新增 `#findDanglingRunning`（守卫与结算 SQL 同形）+ `#settleDanglingCandidates`，在 `recoverAll` 与 `recoverEngagement` 两处接入，结果进 `RecoveryReport.danglingSettled` | `src/workflow/recovery.ts` |
| **F4** | **界面**：① 活动会话徽标**标注会话状态**（`活动会话 482fb2a5（已失败）`，终态用 `attention` 色；查不到那一行时说`（状态未知）`）；② 自相矛盾态（主状态说在跑 + 会话已终态/不存在）**显式告警并给出路**（"启动对账会把它结算回上一状态，之后「重做」照常可用；**不要点「终止」**"） | `src/client/views/RunControls.tsx` |

**为什么 F3 不能复用"无主会话"扫描**：报告里那个会话是**终态 `failed`**，不在无主扫描的集合里（那个扫描找"还活着但没人驱动"的）⇒ 按会话驱动会**恰好在要治的场景下不触发**。这条在代码注释里写明了。

## 二·补、第一版修法的自纠：真库上 8 条作业现场抓到的两条缺陷

第一版把"回滚目标"定成**最后一条转移的 `from_status`**，且结算候选**没看运行标记**。在真部署上重启后，
启动对账对**8 条他本人的作业**写出了结算事件——**而主状态一动没动**（事件 payload 里 `rolledBackTo` 与
作业当前主状态同值，自相矛盾）。原因：

| 缺陷 | 事实 |
|---|---|
| 锚点取错 | 这 8 条的**最后一条转移**是 `worker_running → worker_running`，`transition_type='abort'`——「终止」记的就是这种**同态空转移**（主状态不动、只改运行标记）。照它回滚 = **原地踏步**：`update` 把 `worker_running` 又写成 `worker_running`，于是事件照写、版本照进、作业照旧悬空 |
| 没看运行标记 | 这 8 条的 `status` 都是 `aborted`（**人类自己按的「终止」**）⇒ 它们是"已经结束的作业"，出路是**归档与清空**，根本不该被回滚 |

**修正后（第二轮）**：锚点 = **进入 `worker_running` 的那次转移**（`to_status='worker_running' and from_status<>'worker_running'`）；
候选与结算 SQL 都加 `status not in ('aborted','failed')`；**没有锚点就不结算**（`update` 不命中 ⇒ 零行 ⇒ 连事件都不写）。
四条锁：正例（`blocked` + 有锚点 ⇒ 回滚）、反例（活租约会话 ⇒ 不动）、`aborted` ⇒ 不结算不写事件、无锚点 ⇒ 不结算不写事件。

## 三、验证（真库 + 真部署 + 组件渲染）

| 证据 | 读数 |
|---|---|
| **真库行为锁**（`test/recovery.test.ts`，正例） | 造出报告现场（`worker_running` + `blocked` + 唯一会话 `failed` + 进入 `worker_running` 的那次转移 `waiting_human_review → worker_running`）⇒ `recoverEngagement` 后：`danglingSettled=[{rolledBackTo:'waiting_human_review'}]`、库里 `current_status` 回滚、`active_agent_session_id IS NULL`、`state_version` +1、`status` 保持 `blocked` |
| **真库行为锁**（反例①） | 同样的现场但会话**带有效租约且 active** ⇒ `danglingSettled=[]`、主状态与指针**不动**（第一版夹具栽在"没租约的会话会被对账判为残留"上，注释记了这条） |
| **真库行为锁**（反例②，自纠新增） | 现场 + 运行标记 `aborted` + 最后一条转移是同态空转移（终止）⇒ `danglingSettled=[]`、主状态/版本/指针**全不动**、**账本里一个字都不写** |
| **真库行为锁**（反例③，自纠新增） | 运行标记 `blocked`（非终态）但**没有"进入 worker_running"的转移**（只有终止那种空转移）⇒ 不结算、不写事件（`update` 不命中 ⇒ 零行） |
| **真部署现场（8 条真作业）** | 启动对账在个人库里扫到 8 条 `worker_running` + `aborted`（他自己的作业，最后一条转移都是终止）⇒ **第一版误把它们"结算"成空操作**；修正后候选为空（`aborted` 被排除、无锚点被排除），不再写任何事件 |
| **真部署端到端** | 在个人库造同形作业（`blocked` + 有锚点）→ 重启 dsh → 启动对账结算：`worker_running → waiting_human_review`、`state_version 41 → 42`、指针清空、审计事件 `workflow.dangling_running_settled`（`rolledBackTo=waiting_human_review`） |
| **可用性矩阵锁** | 报告 §4 的 7 行表逐行断言（含悬空态 `worker_running/blocked`：`retry=false reopen=false finish=false resume=true`） |
| **存活规则锁** | ~~`failed/closed/superseded` ⇒ 禁用~~ ⇒ 已被质检轮取代：契约层不再按会话存活禁用；改为锁"请求哪种模式"（`retryReuseSession`：终态 ⇒ 新建、`none` ⇒ 新建、`unknown` ⇒ 复用）+ 服务端降级的真库用例（见 §五） |
| **组件渲染锁** | `renderToStaticMarkup(RunControls)` 含「自相矛盾的状态」「对账会把它结算回上一状态」「会话不可用时会新建会话」「不要点「终止」」与 `活动会话 w-failed（已失败）`；另有"查不到那一行 ⇒ 不报矛盾、徽标写状态未知"与"终止过的作业不报矛盾"两条反例 |
| **棘轮** | 结算是一次**转移之外**的版本推进 ⇒ 登记 `NON_TRANSITION_VERSION_BUMPS`（`dangling-running-settle`）+ SQL 里带 `version-bump-registered` tag；赋值点计数自检 7 → **8**（棘轮按设计咬了一次） |
| 门禁 | `build`/`typecheck`/`lint` 0 错 · `verify` 39/39 · **全量 1967/1967**（含质检轮新增的 6 条） |

## 四、诚实标注

1. **没有可视核验**：本机的 omp 浏览器中继扩展未连接（`browser.open` 报 "extension never connected"）⇒ UI 部分只有**组件渲染测试**，没有真界面截图。服务端侧已 curl 确认控制台可服务（303）。
2. **临时夹具无法完全抹除**（我造在个人库里的那条 `qc-dangling-check`）：`context_events` 是**只追加**的（触发器拒绝 DELETE，§9.5），裸 SQL 删不掉；改走产品自己的路径（`archiveEngagement` → `purgeEngagement`）——内容已清空（`reports_left=0`、各内容表计数 0），按设计**永久保留审计骨架**（2 条事件、1 条转移、2 条决策、1 个会话骨架）与 1 条 `engagement_purges` 销毁记录。它在控制台里会以 `已归档/已清空` 的样子存在。
3. **本修的一个语义取舍**：回滚目标是**进入 `worker_running` 的那次转移的 `from_status`**。对「切换阶段确认」失败的情形，它会回到 `transition_confirmation`（人类可重试确认）——草稿可能已被消费，重试会重新起草。这比把作业留在悬空态好，但不是无懈可击；如果未来要更精确，应按路径显式给回滚目标。
4. **报告 §3.2 的最后一条（放宽 `canFinishTesting`）我没有采纳**：`runMarker` 的要求有它的道理（暂停/阻塞时先恢复或终止，别把"停止工作"混进中间态）⇒ 保留约束，出路由「重做」（会话不可用时按需新建）与 F4 的告警承担。
5. `active_agent_session_id` 的清理只覆盖了**结算路径**；`intake` 那条指针（报告 §2.5 的附带缺陷）仍未纳入对账——与"清理终态会话指针"是另一件事，本轮不动（写在这里备查）。
6. **个人库里留下的 8 条错误结算记录（我造成的，如实记账）**：第一版规则在真部署上对 8 条 `aborted` 作业写了 `workflow.dangling_running_settled`（`rolledBackTo` 与当前主状态同值 ⇒ payload **自证**是空操作），同时清空了它们**已失效的** `active_agent_session_id` 并把 `state_version` 推了一格。主状态、运行标记、会话、租约**都没动**（这 8 条的按钮可用性本来全 false，指针早已无路可走）。为什么不直接删/改那 8 条事件：`context_events` 是**只追加**的（触发器拒绝 DELETE，§9.5），而"追加一条引用被取代条目的更正事件"这条产品纪律**没有任何受支持的写入通道**（没有 `recordCorrection` 之类的 API，手写 `insert` 会绕过账本哈希链 ⇒ 更糟）。⇒ 记为**产品缺口**（建议补一个更正/取代通道），本轮不动他的账本；需要复核时按 `event_type='workflow.dangling_running_settled' and payload_json->>'rolledBackTo' = current_status` 就能一眼挑出这几条。

## 五、质检轮（2026-10-11 第二段）：四路独立复核的处置

完整的发现清单、逐条证据与驳回理由见 [quality-review-2026-10-11-dangling-fix.md](quality-review-2026-10-11-dangling-fix.md)。摘要：

1. **F2 的方向是错的，已回退**：把「重做」在会话不可用时禁用只是治症状——真正的病是那条路走不通。现在服务端在会话**已终结或指针为空**时**按需新建会话**（决策记 `new_session`、转移记 `session_reused=false`，血缘与技能面继承自「最后一次会话」，没有就退回阶段默认）；控制台按会话状态选请求哪种模式。**结算之后作业的出路因此是一条可用的「重做」**，而不是"先结束测试再重开"那套（那条路只在还有非终态会话可挂回时可用——顺手把它在文档里的假话改掉了）。
2. **三条"在受支持部署形态下不生效"的缺陷已修**：RLS 生效时候选恒空（候选不该读 `state_transitions`）、未配 `rlsContext` 时 `recoverAll` 提前返回从不结算、结算与审计分属两个事务。
3. **界面误报已修**：会话列表未加载/被 200 条上限截断时，"查不到那一行"曾被当成"明确没有会话"⇒ 现在是不参与判定的 `unknown`。
4. **四条断言/锁的缺陷已改**（两条恒真/只锁排版的伪锁、两条"声称已锁却无行为锁"），并补上正例的**事件写入**断言与两条真库反例（主状态守卫、`recoverAll` 的补扫与候选守卫）。
5. **真部署端到端补验了"出路"**：结算之后以**请求复用**调真实 `retryWorker` ⇒ 按需新建、作业回 `worker_running` 且指针指向新会话（该轮读数：全量 **1967/1967**）。
