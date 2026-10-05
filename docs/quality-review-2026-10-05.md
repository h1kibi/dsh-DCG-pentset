# dsh-pentest 质量评估与优化方案（2026-10-05）

> 方法：**全量门禁复跑** + **静态度量（TypeScript Compiler API 全量扫描）** + **八轴并行代码评审**（8 个只读评审切片：host 核心 / workflow / memory / execution+tools / console+client / policy+agents+db / tests / infra）+ 对全部 Critical/Required 结论**逐条独立复核**（复核方式：直接读码、跨文件 grep、目录级 RLS 核查、双读对照）。
> 全部结论带 `file:line`；凡未由本评估独立复核的，标注 `[评审报告]`。上一轮报告（`docs/quality-review-2026-10-04.md`）只用于排除已修项，不重复计入。
> 过程说明：评审 agent 的模型通道本轮多次 402（余额）中断，报告由存活切片 + 本评估自身的复核补全；`ConsoleClient`/`TestsQuality`/`InfraScripts` 等切片的**未复核条目**已如实标注。

---

## 0. 结论摘要

**总体评价：工程质量依旧显著高于同规模项目，但“文档承诺的强制点”与“运行时真实接线”之间出现了系统性空隙。** 本轮不去重复上一轮已验证的主链路（范围→闸门→沙箱→代理），而是找到了三类问题：

1. **两处 Critical**：
   - `approved 且未消费` 的放行凭证**在任何一层都无法被撤销**，而 UI 明确提供“撤销”按钮并给出误导性说明；
   - **auto（高权限）档下幂等键每次都变**，模型因超时重发同一条命令会**真的执行两次**（设计明文承诺“同一动作不会执行两次”）。
2. **三处“安全语义有实现、无运行时消费者”**（文档声称已闭合、实际未接线）：
   - `assertAdjudicatedAddress`（DNS 固定）零调用点 → 经代理的域名目标由代理二次解析，重绑定窗口按设计本应闭合而未闭合；
   - `evaluateRedirectChain`（重定向逐跳）零调用点；
   - `executionToken` 生成/注入/非空检查俱全，**但没有任何消费方校验**（代理只查 `EGRESS_ALLOW`，不落库、无共享校验方）。
3. **一组“账本/状态机与数据库真实状态不一致”的缺陷**（transitions 写不合法边、插话唤醒不看真实主状态、交接内容哈希不是哈希、技能冻结只冻名字不冻内容）。这些不直接造成越权，但破坏“一切可回放”的核心不变量，使审计回放与事故定责失真。

### 判决

`approve_with_required_changes` —— **主链路与既有安全边界（RLS、范围引擎、审批绑定、fail-closed）保持高水准，可以继续在受控实验室使用；但上表 Critical/Required 未修复前，不建议在“有真实副作用的目标”上以 auto 档长跑。**

| 维度 | 结论 |
|---|---|
| 正确性 | 主链路实证可用（上轮活体）；本轮发现 2 Critical + 13 Required，集中在**状态机账本一致性**与**安全接线的最后一公里** |
| 可读性 | 优秀：注释解释“为什么/边界/出处”；`any`=0、非空断言=0、无 import 环 |
| 架构 | 良好但**巨型函数集中度过高**：`createExecutionService` 单函数 1051 行/143 决策点、`compose()` 862/109、`ConsoleApp` 597；17 个文件 >1000 行 |
| 安全 | 边界设计优秀（三层防御 + fail-closed + RLS FORCE + 角色分权，目录级核查通过）；**“声称有接线、实际没有”的三处是主要失信点** |
| 性能 | 未见严重热点；索引为任务驱动 + 水位，规模风险在 reindex 预算截断（见 REQ-12）与逐条 enqueue/await 循环 |
| 测试 | 1594/1594 全绿、65 文件；但**清理失败静默吞错仍存在于 7 个文件**、`assertNoResidue` 从未被调用、上轮声称的 REQ-3/R13 锁在树中已不存在 |
| 工程实践 | 仅 `tsc` 一道静态门禁（无 lint/format）；`test:parallel` 与运行纪律相矛盾仍对外暴露 |

---

## 1. 门禁与度量（本轮实测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit，strict + noUncheckedIndexedAccess） | ✅ 通过 |
| `npm run build`（tsc + tsdown + 字体嵌入 + migrations 拷贝） | ✅ 通过（`lib/client.js` 1.16 MB） |
| `verify:client` | ✅ 37/37 |
| `verify:styles` | ✅ 类名 346/346、令牌 42 引用 / 54 定义 |
| `verify:forward-migration` | ✅ 25 项断言 |
| `db:verify`（干净库） | ✅ exit=0；**注意**：指向非空库时会“响亮拒绝”，exit=1（防误跑设计正确，但门禁用法必须指向临时空库；本评估已用 scratch DB 复跑） |
| `npm test`（测试库 `pentest`） | ✅ **1594/1594 通过**（91 suites，73.6s，0 fail/0 skip） |
| RLS 目录级核查（活库 `pg_class`/`pg_policies`/`pg_roles`） | ✅ 除 `schema_migrations`、`skills` 外全部表 `relrowsecurity + relforcerowsecurity` 均开；四个 `pentest_*` 角色均非 superuser/非 BYPASSRLS |

**静态度量（103 个 src 文件 / 58,795 行）**

- `any`：**0**；非空断言：**0**；`@ts-ignore`：0；空 `catch {}`：0；TODO/FIXME：0（仅两处注释里的“不是待补的 TODO”说明）。
- import 环：**0**（Tarjan SCC 全图扫描）。
- 90 个函数 ≥80 行；最重的单函数：`createExecutionService` 1051 行/143 决策点、`compose()` 862/109、`ConsoleApp` 597、`createWorkerTools` 544、`IntakePromptBody` 521/82、`ScopeProposalCard` 521/77、`EngagementWizard` 503。
- 文件 >1000 行：17 个（前五：`contracts.ts` 2314（几乎全是类型，maxFn=3）、`console/rpc.ts` 2002、`memory/pg-worker-tools.ts` 1938、`compose.ts` 1785、`execution/service.ts` 1597）。
- 真死导出 21 个（仅声明处出现一次），典型：`agents/capability.ts` 的 `freezeCapabilities`/`checkCapability`、`client/hooks.ts` 的 `useToggle`/`usePolling`、`memory/ledger.ts` 的 `createMemoryLedger`、`tools/guard.ts` 的 `toToolError`；另有 328 个“导出但在自身文件外无引用”的类型/常量。

---

## 2. 必修缺陷

### 2.1 Critical

#### C-1 `approved && 未消费` 的放行凭证无法撤销——UI 却明确提供“撤销”【已独立复核：服务层 + SQL 函数 + 触发器 + UI 四层对照】

- **现象**：`ApprovalQueue` 对 `decision === 'approved'` 的记录给出 `canRevoke: true` 与文案“撤销后凭证立即失效，Agent 的后续调用会被拒”（`src/client/views/ApprovalQueue.tsx:449-459`，按钮调用 `controller.revokeApproval`，`:715`）。但服务层 `resolveApproval` 对任何非 `pending` 行直接拒绝：`if (row.decision !== 'pending') throw new WorkflowRejection('classification_rejected', ...)`（`src/workflow/core.ts:919-923`）；SQL 侧 `pentest.resolve_approval` 的 UPDATE 带 `AND decision = 'pending' AND consumed_at IS NULL`（`src/db/migrations/010_approval_privilege_binding.sql` 的 `resolve_approval` 定义）；触发器 `enforce_approval_update` 又禁止 `OLD.decision <> 'pending'` 后改写 decision（`src/db/migrations/011_approval_supersede.sql:7-14`）。三层一致地拒绝，而 `execution/service.ts:704-707` 却为 `revoked` 状态准备了分支（不可达）。
- **影响**：人类对自己刚批准、Agent 尚未调用的高危凭证**没有任何撤回通道**；唯一补救是终止会话/作业——与设计 §10.3.1“放行队列可撤销”的承诺不符，且撤销通知文案（`core.ts:854`“它手里可能正攥着这张凭证”）正是为这个场景写的。
- **修法**（二选一，推荐前者）：在 `resolveApproval` 允许 `pending→revoked` 之外显式增加 `approved(且未消费)→revoked` 边，并同步 `resolve_approval` SQL 与 011 触发器（新迁移）；或者，若产品决定“批准即不可撤”，删除 UI 按钮与 `core.ts` 的 revoked 通知分支，并在设计文档中改写 §10.3.1。

#### C-2 auto 档自放行使幂等键每次都变——同一命令重试会真实执行两次【已独立复核：键派生 + 自放行路径 + 唯一模板类别 + 重放入口】

- **证据链**：
  - 唯一默认模板 `direct_command` 的类别是 `exploit_validation`（`src/execution/templates.ts:476-480`），它在 `PER_ACTION_APPROVAL_CLASSES` 中（`src/contracts.ts:142-145`），而 auto 档 `shouldSelfApprove(exploit_validation)` **恒为 true**（`src/policy/behavior-profile.ts:412-414`）。
  - `admit` 在自放行时 `approvalId = created.approvalId`（`src/execution/service.ts:1151-1155`），紧接着 `deriveIdempotencyKey({... approvalId: approvalId ?? '' })`（`:1177-1182`）——**每次调用都会新建一条 approval 行**（`SQL_INSERT_SELF_APPROVAL`，`src/execution/pg-store.ts:139-151`），于是同一条 (会话, 类别, 目标, 命令) 的幂等键**每次不同**。
  - 执行侧的唯一重放防线是 `findRunByIdempotencyKey(plan.idempotencyKey)`（`src/execution/service.ts:1249-1259`）；新键不命中 → `commitRun` 以新键登记 → 沙箱再跑一次。
- **影响**：auto 档（恰恰是不经人类逐次确认的档位）下，模型因超时/结果不确定重发同一命令＝目标被同一条命令**打两次**。这正是设计（与 `templates.ts` 头部）承诺“同一动作不会执行两次”的反面。
- **修法**：自铸凭证不参与幂等键（`approvalId: selfApprovedNow ? '' : (approvalId ?? '')`）；或自放行前先用**不含 approvalId** 的键（或 planHash）查一次既有运行并重放。`approvalId` 保持“一次性绑定校验”，不承担幂等身份。

### 2.2 Required

#### REQ-1 `recovery.onStartup:false` 连带关闭心跳/调度/通知——与配置文档直接矛盾，且 dev 补丁正在这么用【已独立复核】

- `src/index.ts:96-107` 的配置文档写“关掉只影响**启动时**的自动对账；控制台仍可随时手动触发”；但 `:317` 的 `if (config.recovery?.onStartup ?? true) {` 块里同时 `own.heartbeat.start()`（`:344`）、`own.scheduler.start()`（`:347`）、`own.notify?.start()`（`:355`）。`harness.dev.patch.yml` 最后一行为 `recovery: {onStartup: false}`——即**文档推荐的 dev 载入方式**。
- **影响**：dev/共享库部署下：① 无租约续期，任何运行超过 TTL（默认 600s）的会话**无法再执行动作**；② 无周期索引排空，`memory_search` 只能等重启；③ 无 NOTIFY 唤醒。全部**静默**（无 warn），与仓库“降级必显式”的纪律相悖。
- **修法**：把三个 `start()` 提到 `if` 之外（只把 `recoverAll()` 留给开关）；或拆出独立开关并修正配置文档。

#### REQ-2 心跳清扫 `expireLeases` 在 RLS 下恒为空操作——过期租约永久占槽【已独立复核：调用点 + 上下文回落 + RLS 语义】

- `heartbeat.ts:211-220` 调用 `expireLeases(this.#leases, { now })`，**不传 `workerSessionId`**；`PgLeaseStore.transaction` 因此退回静态上下文（`pg-lease.ts:447-455`），而 compose 的静态上下文是 `{ tenantId, engagementId: null }`（`compose.ts:1204-1206`）。`session_leases` 的策略要求 `engagement_id = current_engagement_id()` → NULL ⇒ UPDATE 影响 0 行，**静默**。
- 与之对照：同文件 `#activeLeases` 专门逐 engagement 扫描并注释了同类事故（`heartbeat.ts:305-318`）；`pg-lease.ts:449-455` 的注释也自述“源码正则回落”是不可靠的兼容路径。
- **影响**：过期行 `revoked_at IS NULL` 持续占用 `session_leases_one_active` 偏索引；`issueLease` 的恢复指引（`lease.ts:354-356`“先由 expireLeases 清扫释放槽位”）**永远无法执行**，会话重发/重做路径卡死；心跳回报 `sweptExpired: []` 无错误。
- **修法**：按 engagement 逐作用域清扫（复用 `scopes.listEngagementIds()` + `scopes.run`，与 `#activeLeases` 同构）；并删除 `#sessionIdFromWork` 源码正则回落，改为“缺会话标识即响亮失败”。

#### REQ-3 `memory_read` 静默截断引用，与同仓控制面路径的显式拒绝相反【已独立复核】

- Worker 工具：`input.refs.slice(0, MAX_READ_REFS)`（`pg-worker-tools.ts:989`，上限 20）；控制面：`if (refs.length > MAX_READ_REFS) throw MemoryQueryRejection('classification_rejected', ...)`，注释明写“显式拒绝而不是静默截断……调用方无法察觉自己的后半段引用从未被处理”（`pg-memory-query.ts:640-648`）。同一限制、同一仓、相反契约。
- **影响**：模型请求读取 N>20 条引用后只收到前 20 条且无任何信号；审计只记录“实际读到的”，模型却据此认为自己读全了。
- **修法**：抽出共享 `parseReadRefs(refs, max)`（超限抛 `PgWorkerToolRefusal`），两处复用。

#### REQ-4 三处“已实现但零消费者”的安全语义——文档承诺的强制点实际不存在【已独立复核调用图 + 代理/工具源码】

- `assertAdjudicatedAddress`：仅定义（`scope.ts:1489-1511`）、`pg-policy.ts:655-657` 的转发方法、测试；**无运行时调用者**。而 `pg-policy.ts:651-653` 的注释自述“代理在建立连接前调用它……闭合 DNS 重绑定窗口”。实际沙箱工具对域名一律以**主机名**走代理隧道（`docker/tools/pentest-tool:516-519`），由代理自行解析——裁决地址集合（`PENTEST_RESOLVED_ADDRESSES`）只在直连分支使用。
- `evaluateRedirectChain`：同样只有定义 + `pg-policy.ts:629-645` 转发 + 测试；HTTP 路径没有逐跳校验的调用点。
- `executionToken`：`commitRun` 生成且**不落库**（`pg-store.ts:463-470` 自认），`docker-sandbox.ts:408` 只做非空检查，容器工具只输出 `exec_token_present`（`pentest-tool:970`），代理只按 `EGRESS_ALLOW` 判定（`scripts/egress-proxy.py`，全仓 grep 无 token 消费者）。`docker-sandbox.ts:35-37` 却称“容器内的包装器持它向代理证明本次执行已获准入”。
- **影响**：评审与运维会据此认为“连接时刻有二次授权 / 重定向逐跳有校验 / DNS 已固定”；实际只剩插件自身的范围闸门与主机级白名单。这属于**安全叙事与实现的背离**——按仓库自己的标准（“降级都要显式”）必须处置。
- **修法**（删除概念优于搬迁复杂度）：短期——把三处注释/文档改为“规划中/未接线”，并删除 `executionToken` 的生成、注入与非空检查；中期——若要真实接线，选择**唯一**形态：代理端按裁决地址拨号（IP）＋携带 token 调用宿主校验，或由宿主侧完成逐跳与地址固定后再下发命令。

#### REQ-5 技能冻结只冻结“名字”，不冻结内容——会话运行中可被换正文【已独立复核】

- `worker_sessions.skill_ids` 存名字；`loadSkill` 只校验名字在集合内，然后读**当前行**（`pg-worker-tools.ts:394-416`）；`updateSkill` 可重写 `body`（`pg-skill.ts` 的 update 路径），而 `pg-skill.ts:16-20` 声称“装载在创建会话时冻结……改动只对之后创建的会话生效”。
- **影响**：人类审批/交接时看到的指令文本，可能在人不知情时被替换（skills 表是全局、非租户隔离、运行时角色可写）；反向地，禁用会破坏已冻结会话的加载，错误信息还误报“不在本会话的装载集合里”。
- **修法**：把 `{name, revision, contentHash}` 冻结进会话；`loadSkill` 按冻结 revision 读取，漂移时返回阻塞性错误要求人工重新确认；补一条 `skill.loaded` 账本事件带 revision。

#### REQ-6 沙箱启动前缺少第二条 `execution.policy.checked`，且没有一条带 `tool_run` 关联【已独立复核：设计 §8.2 原文 + 代码调用点】

- 设计（`docs/dsh-pentest-plugin-design.md:2010`）：“`execution.policy.checked` 至少出现两次：动作受理时一次、沙箱/代理启动前一次。两次记录必须带同一 `tool_run`、`plan_hash`……任一次失败都不得启动或继续目标连接。”实现中四处 `recordPolicyCheck` 全在 `admit`（`service.ts:1029/1054/1125/1203`），payload 无 `toolRunId`（`:1227-1272`）；`execute` 中沙箱前只有**条件性**的 `execution.pacing.applied`（`:1490-1522`，且仅在 pacing 需要等待时）。
- **影响**：① 当 `plan.pacing` 为 null 时，`commitRun` 与 `sandbox.run` 之间没有任何审计写入；② 事后无法把策略判定与具体 `tool_run` 对齐回放。
- **修法**：`commitRun` 成功后、`sandbox.run` 前**无条件**写一条带 `toolRunId` 的 `execution.policy.checked`，失败即不启动沙箱。

#### REQ-7 策略 epoch 与运行登记之间的 TOCTOU 窗口【已独立复核：SQL + 登记时序】

- `SQL_COMMIT_RUN` 的 `session_row` 只校验会话/作业状态与租约世代，**不校验 `policy_epoch` / `scope_version`**（`pg-store.ts:182-196`）；`inFlight.set(...)` 在 `commitRun` **之后**才发生（`service.ts:1390 → 1453`）。若 epoch 恰好在该窗口前进，`abortInFlight` 找不到这条在途运行，它仍会以旧 epoch 启动沙箱。
- **修法**：把 `policy_epoch/scope_version` 并进 `SQL_COMMIT_RUN` 的原子条件（不匹配→`stale_state_version`），或在 commit 返回后立即重读 binding 并在不匹配时中止。

#### REQ-8 状态机账本不合法边的写入（三处，同一主题）【已独立复核】

- `finishTechnicalTesting` 写 `type: 'complete'` 于 `waiting_human_review→report_ready` 边（`src/workflow/report.ts:44-48`），而 `STATE_EDGES` 该边 `transitionTypes: []`、`recorded: false`；`complete` 只属于 `report_ready→complete`（`phases.ts:491-505, 517-524`）。→ 账本出现图上不存在的类型；两个语义不同的事件（结束测试 vs 签字导出）在按类型统计时不可区分。
- `interject` 唤醒硬编码 `planTransition({fromStatus:'waiting_human_review'})` 且**不读真实主状态**；当会话处于 `waiting_human` 而作业处于 `transition_confirmation`（交接草稿待确认）时，它会把作业扳成 `worker_running`、**使草稿成为孤儿**，并写一条 `from_status` 与实际不符的迁移（`sessions.ts:503-561`；`handoff-flow.ts` 的 `beginHandoff` 只把作业置为 `transition_confirmation`，会话仍是 `waiting_human`）。
- `confirmTransition` 不经 `planTransition/assertPlan` 直接 `recordTransition({type: move.plan.transitionType})`（`handoff-flow.ts:440`）；同阶段确认会产生 `retry` 类型（`moveKindFor(from===to)==='retry'`，`phases.ts:203-206`），而该边不认 `retry`；同时 `handoffs` 行的 `transition_type` 又把 `retry` 强写成 `advance`（`:351-352`）——同一操作在两处记录不一致。
- **修法**：三处统一走 `assertPlan` + 单一日志写入器；`retry` 场景指向 `retryWorker` 而不是伪装成 `advance`；`interject` 增加对真实主状态的锁定校验。

#### REQ-9 `handoffs.content_hash` 不是哈希；真正的 `computeHandoffHash` 是死代码【已独立复核】

- 写入值是 `'sha256:' + base64url(approvedPrompt).slice(0,43)`（`handoff-flow.ts:82` 与 `:401`）——可逆、只覆盖提示词前缀；而 `handoff.ts:371` 的 `computeHandoffHash`（覆盖 handoff_id/type/phase/prompt/refs/skills/toolFilter/scope version 等，测试断言 64 位十六进制）**全仓无生产调用方**。UI 显示的“内容哈希”因此没有权威来源。
- **修法**：确认路径改调 `computeHandoffHash(handoffPackage, boundScopeVersion)`；草稿路径若暂无正式包，则存显式草稿标记而非伪 `sha256:` 串。

#### REQ-10 重建（reindex）预算截断后报 `done`，尾部无人接手【已独立复核循环与返回值】

- `dispatcher.ts:317-345`：`for (i<50) { runOnce() }`（每次默认 100 事件）耗尽预算仍 `lagging` 时**直接 `return done`**；注释称“剩余部分由下一次 reindex 任务或定期 drain 继续”，但周期 drain 只消费 outbox 任务，旧事件的 `index_event` 任务早已终态。>5000 事件的作业重建中途停止且**终态不可重试**，水位永远 `lagging`。
- **修法**：`lagging` 预算耗尽按失败处理（走重试/死信，与 `failed` 同路径），或用当前水位作 discriminator 自动重新入队 `reindex_engagement`。

#### REQ-11 嵌入版本登记器（`EmbeddingRevisionRegistry`）生产零调用——版本过滤永不生效【已独立复核 grep + compose 接线】

- 类只被测试构造；`compose.ts:1000` 直接把 `config.embeddings` 交给索引器，**从不构造登记器**，生产也没有任何写 `embedding_revisions` 的路径。检索侧的“活跃版本过滤 + `NOT EXISTS` 守卫”（`retrieval.ts:558-573`）因此永远走“无活跃版本→不过滤”分支：**旧/新向量混比**的防护（§9.1）与 `superseded_by_revision` 语义均为死码；同时 `reindex_engagement` 也没有生产内入队点（上一轮为验证曾手工 SQL 入队）。
- **修法**：要么在索引路径/建单路径调用 `ensureRevision/activate` 并暴露重建入口；要么删除登记器与版本过滤，避免“看起来有防护”。

#### REQ-12 测试清理仍在 7 个文件里吞错；`assertNoResidue` 从未被调用；上轮声称的锁在树中不存在【已独立复核 grep + 文件对照】

- `recovery.test.ts:46-65` 等 7 个文件（dispatcher/indexer-assets/open-task/outbox/pg-report/pg-worker-tools）仍有约 35 条 `.catch(() => undefined)` 的 `delete from pentest...`，而 `helpers/cleanup.ts:1-31` 记录“正是这种模式造成普遍静默残留”；`compose.test.ts:1055-1068` 的 finally 同样吞错（同文件其它用例已用 `cleanupEngagements`）。
- `helpers/cleanup.ts:151` 的 `assertNoResidue` 零调用点（注释还自认查不出孤儿 chunks）。
- `docs/quality-review-2026-10-04.md` 的 REQ-3/R13 声称 `hostAskingVisible` / `statusPillShouldYield` 有单测锁；**全仓 grep 0 命中**，当前 `surfaces.tsx` 的常驻胶囊也没有任何“宿主问人时让位”的逻辑。→ 要么是回归，要么是修复记录失真；无论哪种，该行为**现在没有可执行锁**。
- **修法**：7 个文件统一改 `cleanupEngagements`；`assertNoResidue` 扩到 chunks/outbox 并在集成 describe 收尾调用；对“问人让位”恢复一条 SSR/单测锁或更正上轮文档。

#### REQ-13 客户端三处“静默降级”【评审报告 + 已抽查关键文件】

- **预算闸门**：`RunControls` 的 `parseLimit` 对非数字/`1e5` 返回 undefined，`startBlockers` 只数“非空字段个数”，`submitStart` 仅在三值齐备时发送 `budget`（`views/RunControls.tsx:56-58, 74-96, 243-258`）→ 人类填了但解析失败时**三个上限被整体静默丢弃**。
- **选择切换残留**：`controller.select()` 只 emit `selectedEngagementId`，`#read` 失败分支不清 `state/sessions`（`controller.ts:424-433, 735-758`）；`statusPillFacts` 用新作业名拼旧快照 → 展示“B 的名字 + A 的阶段/在跑数”。
- **客户端 bundle 触达 `node:crypto`**：`ReportReview.tsx:47` / `ReportExport.tsx:36` 值导入 `console/rpc.ts`（其链上 `memory/chunks.ts` import `node:crypto`），目前**仅靠 tree-shaking** 侥幸剔除（构建产物实测无 `createHash`，但 53 个端点方法表进了浏览器）。任何一处使该边可达都会让客户端插件加载失败。
- **修法**：预算改为“填写即必须解析成功，否则按钮禁用+说明”；`select` 清空并做响应序号守卫；抽 `console/method-names.ts`（零依赖）供视图导入，并加“产物不得含 `require("node:`”断言。

#### REQ-14 基础设施与文档漂移（烟测不再覆盖真实 argv / 指向已删除模板）【评审报告 + 已对照关键文件】

- `scripts/dev-sandbox-up.sh` 的 smoke argv（read-only、noexec、无 NET_RAW、1C/1G/256pids、注入 HTTP_PROXY）与生产 `buildDockerArgs`（exec /tmp、NET_RAW、2C/2G/512pids、不注入代理 env）**不同**，但脚本头部声称“与 buildDockerArgs 相同”。
- smoke 默认 `COMMAND=http_get ...`，而 `DEFAULT_TEMPLATE_SPECS` 现已只剩 `shell_exec`（`templates.ts:514`）；`docker/tools/Dockerfile:28-32` 与 `docker/tools/pentest-tool:11-24` 仍把 `http_get/tcp_connect/udp_probe/icmp_ping/dns_resolve` 列为默认模板集。
- `docker/smoke.sh:142-152` 对 launch token URL 直接 `curl -fsS` 取 HTML，而该 URL 首访是 303 + Set-Cookie（同文件 §6 有正确握手；`start-personal.mjs:365-378` 明确要求握手）→ 客户端 bundle 两项检查恒 `bad`，健康镜像上 smoke 也会 exit 1 `[评审报告，未实跑]`。
- **修法**：sandbox argv 单一来源（脚本改为调用 TS 构建器/同一 spec）；删除或标注不可达探针；smoke 复制同文件 §6 的 cookie 握手。

---

## 3. 可选改进（Optional / Nit）

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| O-1 | Optional | `harness.dev.patch.yml` 内联回退：`PENTEST_LEDGER_SECRET` 默认值与可用 DB 口令（文件同时声称“可以进版本库而不含密钥”） | `harness.dev.patch.yml` 末段 | 去掉 secret 回退（缺失即抛）；口令移入 git-ignored 本地覆盖层 |
| O-2 | Optional | `runtime.database.url` 形态非法时静默跳过迁移并回落 libpq 环境变量 | `index.ts:523-531`、`compose.ts:901` | compose 入口校验非空并抛 `PentestBootError`；不要用“narrow→undefined”表达“禁用” |
| O-3 | Optional | 资产裁决键映射缺 `service`/`cidr` 等 kind：这类行的 `pending/excluded` 裁决在判定时被静默忽略（`decisionCandidates` 只产出裸 host/`kind:host`/`url:`/`domain:*.parent` 四种形态） | `pg-policy.ts:400-421`、`scope.ts:1225-1240` | 把裁决值结构化为 `{kind,host,port,cidr}`，用与范围条目相同的 `hostMatches/cidrContains/portCovered` 求值；注：`assets` 目前**无生产写入方**，风险取决于外部数据 |
| O-4 | Optional | `@constructor`/`__proto__` 资产标签会经原型链取值 → `normalizeScopeEntry` 迭代时 TypeError，而非稳定拒绝码 | `scope.ts:679-686`、`pg-policy.ts:432` | 用 `Object.hasOwn`/`Object.create(null)`/Map，未知标签返回既有 `malformed_target` |
| O-5 | Optional | 通配 URL 目标静默退化为 apex；`parseUrlSelector` 的 `allowWildcard` 参数无效果 | `scope.ts:496-505, 621-624, 770-774` | 动作目标显式拒绝 `*`，或把 wildcard 标志带入 `NormalizedTarget` |
| O-6 | Optional | skill 的 `description` 原样插进断言“工具面/放行类别”的 system prompt 段；名称/描述/正文均无长度上限，且 skills 表全局非租户隔离 | `dsh-session-factory.ts:629-631`、`pg-skill.ts:175-190, 88-96` | 写入时拒绝 CR/LF/控制字符并限长；列表端点改摘要投影 |
| O-7 | Optional | `migrate()` 无 advisory lock、无内容校验和：并发迁移会半途撞 DDL；已应用的迁移被改内容也无人发现 | `migrate.ts:305-345, 44-47` | 全流程 `pg_advisory_lock`；记录 `sha256(file)` 并拒绝漂移 |
| O-8 | Optional | `extendBudget` 接受负增量/全零增量（有 `budget_max_tokens = coalesce(...)+coalesce($2,0)` 直写），与 `BudgetMeter.extend` 的守卫相反 | `sessions.ts:592-601`、`budget.ts` | 复用同一拒绝文案与判据 |
| O-9 | Optional | `confirmScopeProposal` 的 transitions 直插硬编码 `from_status='auth_pending'`，而其闸门还接受 `waiting_human_review` 的历史形态 | `intake.ts:977-986`、`core.ts` intake 闸门 | 从锁定行推导 from_status，统一走 `recordTransition` |
| O-10 | Optional | `pg-lease` 用**闭包源码正则**解析会话标识作为兼容回落 | `pg-lease.ts:474-477` | 删除该回落，缺标识即响亮失败（与 REQ-2 一并） |
| O-11 | Optional | “一次只提一条 pending 申请”只实现于 tool 适配器；`pentest_exec` 走服务内 `admit` 可绕过，同会话可堆多条 | `pg-worker-tools.ts:1806-1830`、`service.ts:1125-1140` | 下沉到 `admit`/`requestApproval`（单语句 `not exists (pending)`） |
| O-12 | Optional | 工具参数 schema 未设 `additionalProperties:false`（仅报告 payload 设了）：`approvalId` 拼错会被静默忽略 | `tools/worker.ts:693-716, 625-655` | 所有 worker 工具参数对象补 `additionalProperties:false` |
| O-13 | Optional | 模板字符串参数未禁空白，容器侧 `split()` 分词，注册面无 pattern 时命令语义可被静默重构 | `templates.ts:367-385`、`pentest-tool:945-955` | `buildNormalizedCommand` 对替换值断言无空白（或统一走 base64 通道） |
| O-14 | Optional | 出口白名单“只增不减”，与“白名单跟着排除项走”的声明不符；重建回滚 rename 失败不校验却回报“已回滚” | `egress-allowlist.ts:60-68, 254-257, 262-302` | 明确“只增”语义并告警 exclusion；回滚失败要显式标注代理不可用 |
| O-15 | Optional | 死代码/过度导出：21 个真死导出（含 `agents/capability.ts` 整模块——它暗示“工具面冻结”的所有者，实际由 session-factory 内联字符串生成）+ 328 个仅本文件使用的导出 | 见 §1 度量 | 删 `capability.ts` 导出或让 session-factory 真正消费；清理其余真死导出 |
| O-16 | Optional | 无 lint/format 门禁（仅 tsc）；`test:parallel` 与“不可并发跑共享库”的纪律矛盾仍暴露 | `package.json:49`、RUNBOOK:795 | 引入 typescript-eslint（`no-floating-promises`/`no-misused-promises`）；删除或加保险丝 `test:parallel` |
| O-17 | Optional | 大型函数/文件集中：17 文件 >1000 行；`createExecutionService` 1051 行/143 决策点 | §1 度量 | 见 §5 架构深化 |
| O-18 | Optional | 测试时钟余量薄（25/200/250ms 真实等待）、`openTask`/`bootstrapIntake` 双份状态机、`hash.test.ts:157` 同义反复断言、`workflow/core.ts` 无直接测试、egress 代理 403 无自动化负向测试、`AgentTrace` 视图无测试 | 各切片报告 | 见 §5 工程实践 |
| O-19 | Nit | `scope.ts:939-945` 冗余条件；资产裁决多键命中按数组顺序而非特异性取胜 | 评审报告 | 折叠条件；结构化后按特异性排序 |

---

## 4. 已验证的强项（值得保留）

1. **fail-closed 是底色，不是口号**：`tsconfig` strict + `noUncheckedIndexedAccess`；`any`=0、非空断言=0；`002_security.sql` 对“迁移连接不是 migrator 成员/角色带 superuser”直接 RAISE；RLS 目录级核查通过（FORCE 全开、角色分权、无 BYPASSRLS）。
2. **范围引擎的严谨度罕见**：自实现 punycode（版本写死不随 ICU 漂移）、非规范 IP 字面量拒绝、控制字符拒绝、排除项优先、资产 `pending` 短路、地址固定与拨号复核——上一轮还修过“pending 被宽 CIDR 绕过”的真实缺陷（`scope.ts:1187-1196` 有事故注释）。
3. **审批绑定的原子性**：`SQL_COMMIT_RUN` 用定向 CTE 把“消费凭证 + 登记运行”做成单语句互锁（`pg-store.ts:174-215`），失败不留半完成态；`approvalViolation` 对会话/类别/planHash/租约世代/时效逐项复核。
4. **审计不可用即停止动作**：`admit` 第 0 步查审计探针（`service.ts` 顶部），且不按“只停高风险”挑拣——与 §15.1 一致。
5. **降级显式**：无嵌入器 → `lexical-only`；索引滞后/失败可见；outbox 死信可见；重建“卡在坏事件”必失败而不是报 done（`dispatcher.ts` 的 `failed` 分支）。
6. **测试与夹具纪律**：1594 用例全绿；`tsx-loader.mjs:99-118` 拒绝把测试跑在非 `pentest` 库上；`cleanup.ts` 曾系统性治过“静默残留”（本轮发现 7 个文件又退回去了，见 REQ-12）。
7. **注释质量**：关键判断几乎都写了“为什么不那样做 + 事故出处（§/日期）”，例如 `pg-lease.ts` 对源码正则回落的坦白、`surfaces.tsx` 对 96px 留白的实测记录。

---

## 5. 优化方案

### 5.1 P0：先修“承诺与实现不符”（1–2 天量级）

按 §2 的修法顺序处理：C-1、C-2、REQ-1、REQ-2、REQ-5、REQ-6、REQ-7、REQ-11。共同点都是**小改动、可测试、直接消除“以为有、实际没有”**。

1. **C-1 撤销通道**：service + SQL + trigger + 迁移，补 1 条集成测试（approved→revoked→execution 被拒）。
2. **C-2 幂等**：键派生排除自铸凭证；补“同命令连续两次调用，第二次返回首条结果”的执行级测试（auto 档）。
3. **REQ-1**：三个 `start()` 移出开关块；dev 补丁下跑一条 >TTL 的活体冒烟。
4. **REQ-2**：清扫逐 engagement；补“过期租约清扫后 `reissueLease` 可用”的 pg 集成测试。
5. **REQ-5**：会话冻结 `{name, revision, contentHash}`；补“改正文不影响已冻结会话 / 会话读到旧 revision”契约测试。
6. **REQ-6/7**：commit 后无条件策略审计 + commit 原子校验 epoch；各补一条故障注入测试。
7. **REQ-11**：接线或删除二选一，并让 `verify` 脚本能发现“登记器无调用方”。

### 5.2 P1：账本一致性与安全叙事（3–5 天）

- 统一状态迁移写入器：`interject`/`confirmTransition`/`finishTechnicalTesting`/`confirmScopeProposal` 全部经 `assertPlan + recordTransition`；为“同阶段确认”指向 `retryWorker`。用 `validateGraph(edges)` 生成运行时自检（已有 `unrecordedEdges/derivedEdges` 产物，把它接进启动日志/控制台诊断）。
- `computeHandoffHash` 接上生产路径（顺带消除死码）。
- reindex 预算耗尽改为失败+自动续跑。
- 三处安全语义（地址固定/逐跳/令牌）按“删除或真实接线”收敛；建议先删 token、保留地址固定作为代理侧 TODO 并在文档中降级表述。
- 客户端三修（预算解析、选择切换清空+序号守卫、抽 `method-names.ts` 并加产物断言）。

### 5.3 P2：架构深化（按 `codebase-design` 词汇：深模块 / 缝 / 局部性）

> 度量支撑：90 个 ≥80 行函数、17 个 >1000 行文件、单函数最大 1051 行/143 决策点。目标不是“拆小”本身，而是让**变更/缺陷集中在一处**（locality）且**接口更小**（depth）。

1. **`createExecutionService` → 受理管线模块**（最高杠杆）。
   现状：1051 行闭包内联了模板解析、参数白名单、目的校验、类别复算、会话绑定、租约、凭证、范围、策略、pacing、审计等 143 个决策点——安全规则与装配细节交织，测试只能整体穿过 `admit()`。
   方案：把“**准入 = 一串有序的判定阶段**”显式化：`AdmissionPipeline`（阶段数组，每阶段返回 `ok | reject(code,detail,nextAction) | needApproval`），闭包只保留 pacing/沙箱/在途登记。接口仍是 `admit(intent)`/`execute(plan)` 两个方法（小接口），但每个阶段可独立测试、顺序可断言、审计点集中。删除测试面：`execution.test.ts` 直接驱动管线，故障注入不再要伪造整个服务。
2. **`compose()` → 安装器表**。862 行/109 决策点的单函数拆为 `installDatabase / installWorkflow / installExecution / installMemory / installConsole / installClient`，组合根只剩“读配置→校验→按表安装→暴露 dispose”。收益：启动失败定位、装配顺序与 RLS 上下文这类横切规则各自成篇。
3. **`pg-worker-tools.ts`（1938 行）→ 按工具族拆分**：`search/read/write/report/approval/skill`，共享的内部缝是“RLS 上下文 + 会话解析 + 拒绝构造器”三件套（先抽内部 helper，再搬实现）。REQ-3 的截断不一致正是这个巨类里两套私有约定的直接产物。
4. **客户端单体组件拆分**：`ConsoleApp`(597)/`IntakePromptBody`(521)/`ScopeProposalCard`(521)/`EngagementWizard`(503) 抽“数据 hook + 纯展示子组件”；`ApprovalQueue/ScopeManager/ReportReview/ReportExport` 的 `GateBlocker/GateInput` 形态明显同构，抽一个 `GateCard`（删除测试：删掉它会把这些概念散回 4 个文件 → 保留）。
5. **`openTask` / `bootstrapIntake` 双份状态机 → 一个 `stageIntakeSession`**（两处复用谓词已经漂移，正是“一个概念两处实现”的教科书案例）。
6. **不建议动 `contracts.ts`（2314 行、maxFn=3）**：它是纯契约面，拆分只会增加 import 噪声；若确要动，按命名空间分目录 + index 重导出，属最低优先级。
7. **死码清理**（删除测试全部通过）：`agents/capability.ts` 的未接线导出、`useToggle/usePolling`、`createMemoryLedger`、`toToolError`、`consumeApproval`（生产走 CTE）、`describeComposition` 等；顺手把 21 个真死导出清零。

### 5.4 P3：工程实践与护栏

1. **加一道 lint**：typescript-eslint 建议规则集（`no-floating-promises`、`no-misused-promises`、`no-explicit-any`、`import/no-cycle`、`no-unused-vars`），CI 与 `npm test` 并列；这也是本项目最缺的一类护栏（现在只能靠人肉审查发现“声明与实现不符”）。
2. **把“文档声称的验证”变成可执行锁**：REQ-12 的三处（清理吞错、残留断言、问人让位）全部恢复为会红的测试；并给 `verify-client-bundle.ts` 增加“产物不得含 `require("node:`”与“端点方法表不得整表进包”的断言。
3. **单一来源**：sandbox argv、模板集、冒烟命令从 TS 模块导出，脚本消费而不是手抄（REQ-14 的根因就是手抄）。
4. **测试纪律收口**：7 个文件迁到 `cleanupEngagements`；`assertNoResidue` 扩到 chunks/outbox 并在集成收尾调用；能注入时钟的测试不用真实 sleep；`test:parallel` 删除或加保险丝。
5. **活体验收补充**（延续上轮方法）：auto 档重复命令的幂等、撤销按钮、过期租约清扫、技能换正文、DNS 固定的代理路径——五条均可脚本化，建议进 RUNBOOK 的固定演练清单。

### 5.5 建议的推进顺序（一页）

```
P0（正确性，先做）  C-1 C-2 REQ-1 REQ-2 REQ-5 REQ-6 REQ-7 REQ-11
P1（不变量与叙事）  REQ-8 REQ-9 REQ-10 REQ-12 REQ-13 REQ-14 + 三处安全缝收敛
P2（架构）          执行受理管线 → 安装器表 → pg-worker-tools 拆分 → 客户端拆分 → 死码清理
P3（护栏）          lint/CI → 文档断言回归 → 单一来源 → 测试纪律 → 活体清单
```

---

## 6. 未覆盖与边界

- `src/report/pg-report.ts`（1294 行）本轮无切片评审覆盖（`PolicyAgentsData` 的该子 scout 因 402 未返回），仅由我的度量与 §2/§3 交叉引用覆盖；建议下轮专项。
- DNS 固定/重定向链路“经代理实际会被代理再解析”的最终影响，取决于 `pentest-proxy` 的实现（本仓外）；本评估确认的是**宿主侧永不调用**，代理侧行为标 `[INFERENCE]`。
- `docker/smoke.sh` 恒失败的结论未实跑容器验证（依赖 launch URL 的 303 行为），标 `[评审报告]`。
- 性能未做压测；建议下轮对 >5000 事件的重建、N 条引用读取、控制台冷启动做基准。
- 上轮报告中“UI 级（模型在环）插话/新 schema 实机验证”仍未做（需要活会话），本轮未改变该边界。
