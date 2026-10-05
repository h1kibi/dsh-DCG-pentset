# dsh-pentest 质量评估与优化方案（2026-10-05 · 独立复核轮）

> **方法**：9 个只读评审切片（host 核心 / 账本不变式 / 执行审计 / 安全边界 / 记忆与技能 / 报告模块 / 控制台与客户端 / 测试与基础设施 / 架构深化），全部要求以**当前代码**为准复读并给出 `file:line`；由本评估亲自复跑全部门禁与全量测试、亲自重算静态度量（TypeScript Compiler API）、并以 Tarjan SCC 复验导入环。对同日的 `docs/quality-review-2026-10-05.md`（另一模型生成、与本轮时间上相邻）：**不复制其结论**，只把它当"待复核断言列表"，逐条独立复核并在 §2 单列修正。
>
> **标记约定**：`【自验】`＝本评估亲自读码/实测；`【切片复核】`＝切片代理读码复核、本评估未逐行重读（已抽查关键行）；`【未实跑】`＝结论依赖运行时环境，本轮未执行该实验。
>
> **环境事实**：Windows / Node 22.20；PG `pgvector/pg17` @ `127.0.0.1:55446`（容器 `dsh-pg-c`）；**本树无 `.git`**（无版本历史，只能评审当前快照）；`src/` 103 文件 / 58,795 行。

---

## 0. 结论摘要

**总体评价：SQL/领域层的工程设计仍显著高于同规模项目；但"账面承诺"与"运行时真实接线"之间的空隙在本轮复核中依然存在，且新增发现集中在三个此前未覆盖的区域：报告模块（4 个 Required）、执行等待窗口（pacing）、以及部署配置面（RLS/密钥/网络叙事）。**

判决：**`conditional_pass`（有条件通过）**——单租户受控实验室继续使用没有问题；但在下述 P0 修复前，不建议在**有真实副作用的目标**上以 auto 档长跑，也不建议任何**共享/多租户数据库**部署（原因见 §3.1）。

| 维度 | 结论 |
|---|---|
| 正确性 | 主链路与门禁实证可用（1594/1594 全绿）；2 个既有 Critical 复核成立（C-1/C-2），另 1 个账本缺陷升级为 Critical（REQ-8b），新增 9 个 Required |
| 可读性 | 优秀：注释解释"为什么/事故出处"；`any`=0、空 catch=0、TODO=0；**修正上一轮**：非空断言实为 31 处（多为越界检查后的索引取值），非 0 |
| 架构 | 良好但巨型函数集中度依旧：≥80 行函数 110 个；Top：`createExecutionService` 1051 行、`compose()` 862、`ConsoleApp` 597、`createWorkerTools` 544、`admit` 478 |
| 安全 | 边界设计（RLS/范围引擎/审批绑定/fail-closed）在 SQL 与 TS 层都扎实；本轮主要失信点=**随附配置下 RLS 不生效（文档已声明）+ 三处零消费者安全语义 + 默认密钥/口令**（§3.1、§3.5） |
| 性能 | 未见热点；规模风险=重建预算截断后不可续跑（REQ-10）、报告版本随面板打开无界增长（§3.4-1） |
| 测试 | 1594/1594、91 suites、121s 全绿；缺口：报告版本时序、账本边合法性、RLS 清扫、代理 403 均无自动化锁；5 个测试文件仍有 77 处清理吞错 |
| 工程实践 | 仅 `tsc` 一道静态门禁；无 lint/format；仓库根有 90MB 活浏览器配置目录与孤儿脚本；无版本控制 |

---

## 1. 门禁与度量（本轮实测，全部由本评估亲自复跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 通过 |
| 构建 | `npm run build` | ✅ 通过（tsc + tsdown + 字体嵌入 + migrations 拷贝） |
| 客户端产物 | `npm run verify:client` | ✅ 37/37 |
| 样式覆盖 | `npm run verify:styles` | ✅ 类名 346/346、令牌 42 引用 / 54 定义 |
| 前向迁移 | `npm run verify:forward-migration`（对 `postgres` 库跑） | ✅ 25 项断言 |
| **全量测试** | `PENTEST_DATABASE_URL=…:55446/pentest npm test` | ✅ **1594/1594 通过，91 suites，121.1s，0 fail/0 skip** |

**静态度量（本评估用 TS Compiler API 全量扫描 `src/` 103 文件 / 58,795 行，方法：AST 节点计数）**

- `any`：**0**；`@ts-ignore`：0；空 `catch {}`：0；TODO/FIXME：0（唯一命中是 `memory/ledger.ts` 注释里"不是待补的 TODO"）。
- **非空断言（`NonNullExpression`）：31 处**——`client/phase-track.ts`、`timeline.ts`、`memory/chunks.ts:394-395`、`compaction.ts`、`indexer.ts`、`ledger.ts`、`pg-lease.ts:414` 等；绝大多数是"越界/形状检查之后"的索引取值（如 `bytes[6]!`）。**修正上一轮"非空断言=0"的结论。**
- 导入环：**0**（Tarjan SCC 全图，独立重算，与上一轮一致）。
- ≥80 行函数：**110 个**；Top10：`execution/service.ts:546`（1051）、`compose.ts:900`（862）、`client/index.ts:343`（597）、`tools/worker.ts:245`（544）、`IntakePrompt.tsx:589`（521）、`SessionChat.tsx:290`（521）、`EngagementWizard.tsx:515`（503）、`execution/service.ts:742`（478）、`workflow/intake.ts:674`（379）、`HandoffEditor.tsx:123`（376）。
- 文件 ≥1000 行：17 个（`contracts.ts` 2313 几乎全是类型；`console/rpc.ts` 2001 主要为 53 条方法表）。

---

## 2. 对上一轮结论的独立复核

结论统计：**确认 14 · 修正 4 · 驳回 0**（"驳回"指完全不存在；"修正"指结论方向成立但机制/范围/取值有误——C-1 与 REQ-13 在确认的同时另带机制/取值级修正）。

| 上一轮结论 | 本轮独立复核 | 判定 |
|---|---|---|
| **C-1** approved 未消费凭证无法撤销，UI 却提供 | **确认。** UI：`ApprovalQueue.tsx:446-459`（`canRevoke:true` + "撤销后凭证立即失效"）、按钮 `:712-716`；服务层先手拒绝 `core.ts:919-923`（`row.decision !== 'pending'`）；SQL `010:79-96` 要求 `decision='pending' AND consumed_at IS NULL`；触发器 `011:7-13` 禁止非 pending 行改 decision；全仓仅 3 个 decision 写入函数（008/010/011），全部 pending-only；`supersede_approval` 同样 pending-only。【自验】 | ✅ 确认 + **修正**：上一轮称 `service.ts:704-707` 的 `revoked` 分支"不可达"不准确——它对 `pending→revoked` 可达；无路径的只是"approved→revoked"这条修复目标 |
| **C-2** auto 档自放行使幂等键每次都变，重试会真执行两次 | **确认。** 键=`sha256(会话‖类别‖目标‖命令‖approvalId)`（`idempotency.ts:56-67`）；自放行每次新建 approval 行（`pg-store.ts:135-147` 无条件 INSERT）并把它带进键（`service.ts:1150-1154`→`:1177-1182`）；重放唯一入口 `findRunByIdempotencyKey`（`service.ts:1289`）按精确键查；`tool_runs UNIQUE(engagement_id, idempotency_key)`（`001_init.sql:326`）因键不同不触发；`direct_command→exploit_validation`（`templates.ts:478-480`）在 auto 档恒自放行（`behavior-profile.ts:412-414`）。【自验】 | ✅ 确认 |
| **REQ-1** `recovery.onStartup:false` 连带关闭心跳/调度/通知 | **确认。** `index.ts:317` 的 `if` 块内含 `:344 heartbeat.start()`、`:347 scheduler.start()`、`:355 notify?.start()`；配置文档 `:105-107` 声称只影响启动对账；`harness.dev.patch.yml` 末尾正是 `onStartup: false`。【自验】 | ✅ 确认 |
| **REQ-2** 心跳 `expireLeases` 在 RLS 下恒 0 行 | **确认。** `heartbeat.ts:212` 不传 `workerSessionId`；`pg-lease.ts:451-457` 源码正则回落→null→静态上下文 `{engagementId:null}`（`compose.ts:1205-1207`）；`session_leases` 仅 engagement 级策略（`002:205-210`；`015:49-51` 已 DROP 租户级策略）；`revokeExpiredLeases` 不查 rowCount 静默返回 `[]`。测试盲区实锤：`pg-lease.test.ts:519` 用**无 rlsContext 的超级用户**跑清扫，恒绿。【切片复核+自验关键行】 | ✅ 确认（补：未配 rlsContext 时也同为 0 行，失效方式不同） |
| **REQ-3** `memory_read` 静默截断 vs 控制面显式拒绝 | **修正。** 工具面 `tools/worker.ts:305-313` 在进服务前已对 `>20` 返回 blocked（字面量 20）；`pg-worker-tools.ts:989` 的 `slice` 当前**不可达**——真实缺陷是"同一上限三份实现（`:90`、`pg-memory-query.ts:111`、`tools/worker.ts:305`）+ 一处潜伏截断 + 审计字段会在截断被触达时对账不一致（`:1083-1089`）"。 | ⚠️ 修正（降级为"潜伏分歧"，仍是 Required 级清理项） |
| **REQ-4** 三处安全语义零消费者 | **确认。** `assertAdjudicatedAddress`（`scope.ts:1489`）、`evaluateRedirectChain`（`scope.ts:1445`）除转发与测试外零调用；`executionToken` 生成/注入/非空检查俱全，容器只打印 `exec_token_present`，代理无 token 消费者。【切片复核】**补**：`docker-sandbox.ts:15-22` 与 `:74-80` 已自述"2026-10-05 起网络不再 internal、网络层不再是范围边界"——承诺与实现的背离主要残留在 `docker-sandbox.ts:34-37`、`pg-policy.ts:651-653` 的注释与设计文档。 | ✅ 确认 |
| **REQ-5** 技能冻结只冻结名字 | **确认 + 升级。** `worker_sessions.skill_ids` 存名字（`core.ts:1219`）；`loadSkill` 取**当前行**（`pg-worker-tools.ts:413-416`，且带 `disabled=false` 过滤）；`updateSkill` 可原地改正文（`pg-skill.ts:233-243/318-325`）。**新增两点**：① 停用技能会**回溯破坏**已冻结会话的加载，错误文案还误报"不在装载集合"；② 正文/描述无长度与控制字符约束，`description` 原样进系统提示（`dsh-session-factory.ts:626-631`）。 | ✅ 确认（升级：跨租户提示注入面 + 契约测试缺失） |
| **REQ-6** 沙箱前缺第二条 `execution.policy.checked` | **确认。** 4 处 `recordPolicyCheck` 全在 `admit`（`service.ts:1029/1054/1125/1203`），payload 无 `toolRunId`；`commitRun(:1390)→sandbox.run(:1521)` 之间仅有条件性 `pacing.applied`（`:1490`）。设计原文要求两次且带同一 tool_run（`design.md:2011`）。 | ✅ 确认 |
| **REQ-7** epoch/scope 的 TOCTOU 窗口 | **确认（窗口更精确）。** 最后复核点 `service.ts:1360-1372` → `commitRun(:1390)` → `inFlight.set(:1453)`；`SQL_COMMIT_RUN`（`pg-store.ts:182-240`）不含 `policy_epoch/scope_version` 条件（只有写进 JSON 的 `$10`）；`abortInFlight` 只遍历 inFlight（`:1585-1597`）。有效窗口=`1360→1453`。【切片复核+自验 SQL 片段】 | ✅ 确认 |
| **REQ-8** 状态机账本三处非法边 | **确认（1 处升级、1 处新增）。** 8a：`report.ts:42-48` 在 `transitionTypes:[]/recorded:false` 的边上写 `type:'complete'`；8b：`sessions.ts:497-531` 硬编码 `fromStatus:'waiting_human_review'` 且不读 `engagement.current_status`，`beginHandoff`（`handoff-flow.ts:88-150`）只动作业不动会话 → interject 把作业推回 `worker_running`，草稿成孤儿（无 confirm/cancel 路径）；8c：`confirmTransition` 不经 `assertPlan`，同阶段确认写图外 `retry` 边，`handoffs.transition_type` 又强写成 `advance`。**新增 AD-2**：`intake.ts:980-986` 每次范围确认都写图外边 `start(auth_pending→worker_running)`——高频路径。【切片复核】 | ✅ 确认；8b 升级为 **Critical**（人工草稿不可恢复）；新增 AD-2 |
| **REQ-9** `content_hash` 不是哈希 | **确认。** `handoff-flow.ts:82/401` 写 `'sha256:'+base64url(prompt).slice(0,43)`——base64url 可逆（实测反解出前 32 字节原文）；真哈希 `computeHandoffHash`（`handoff.ts:371-392`）零生产调用。 | ✅ 确认 |
| **REQ-10** reindex 预算截断报 done | **确认 + 更强。** `dispatcher.ts:317-352`：50×100=5000 事件上限，`lagging` 直落 `done`；周期 drain 只领 pending/过期 leased，`index_event` 不写水位；**新增**：无任何 `reindex_engagement` 生产入队点，且新任务会 `resetWatermark→0` 重扫（`indexer.ts:706-716`）→ **>5000 事件的作业在现有代码下永远建不完**（水位可见，非静默）。 | ✅ 确认（影响升级） |
| **REQ-11** 嵌入版本登记器零调用 | **确认。** `EmbeddingRevisionRegistry` 仅测试构造；`retrieval.ts:555-573` 的版本过滤恒走"无活跃版本"分支；`reindex_engagement` 有消费者无生产者。 | ✅ 确认 |
| **REQ-12** 测试清理吞错（7 文件）与 `assertNoResidue` | **修正。** 上一轮点名的 7 个文件当前 **0 处**；实际是另外 **5 个文件共 77 处**：`compose.test.ts` 46、`recovery.test.ts` 15、`db.test.ts` 9、`pg-lease.test.ts` 5、`pg-workflow.test.ts` 2。`assertNoResidue` 仍零调用（`cleanup.ts:151`）。【切片复核】 | ⚠️ 修正（文件清单过期；缺口仍成立） |
| **REQ-13** 客户端三处静默降级 | **确认（1 处取值修正）。** (a) `parseLimit` 用 `parseInt`：实测 `'1e5'→1`（**不是**上一轮说的 undefined；后果更重：想设 10 万实际按 1 执行），`'abc'/'0'/'-5'`→undefined 且三项预算整体丢弃（`RunControls.tsx:60-63/91-95/250-262`）；(b) `select()` 失败不清 `state/sessions`，`surfaces.tsx:149-172` 用 B 的名字拼 A 的快照，且无请求序号守卫；(c) `ReportReview.tsx:47`/`ReportExport.tsx:36` 值导入 `rpc.ts`→`memory/chunks.ts`→`node:crypto`：产物实测无 `createHash`/`require("node:`（tree-shaking 剔除），但 53 条端点表（19.5KB）留在了浏览器产物里。【切片复核+自验产物断言】 | ✅ 确认（修正 (a) 的取值） |
| **REQ-14** 基础设施漂移 | **确认 + 更细。** smoke 恒假（303+Set-Cookie 握手缺失，`docker/smoke.sh:144-152` 对 3xx 取空 body）；`dev-sandbox-up.sh:65-73` 与生产 `buildDockerArgs` **五处**不一致（无 NET_RAW、多 --read-only、/tmp noexec、限额 1C/1G/256 对 2C/2G/512、smoke 注入代理 env）；模板集文档漂移（默认集只剩 `direct_command`）。【切片复核；303 行为读 `dsh-client-connection` 库源码，**未实跑容器**】 | ✅ 确认 |
| §1 度量"非空断言=0" | **修正：实测 31。** | ⚠️ 修正 |
| §4 强项"RLS 目录级核查通过" | **需加限定。** SQL 层策略/FORCE/角色确实正确（`test/rls-isolation.test.ts` 以 `SET LOCAL ROLE pentest_app` 实测通过）；**但随附配置下 RLS 不生效**，且设计文档自己写明了这一点（`design.md:3086-3089`）。上一轮未记录该限定。 | ⚠️ 修正（见 §3.1） |

---

## 3. 新增缺陷（本轮首次发现；按严重度）

> 除标注 `【自验】` 的条目外，本节的证据链来自对应切片代理的读码复核（每条带 `file:line`，完整输出见会话记录 `agent://<切片名>`）；已在关键行由本评估抽查的条目在文中注明。建议对外引用前按行号复核。

### 3.1 部署配置面：RLS 在随附配置下不构成边界（**Required（部署护栏）；文档已声明**）

- **证据**：`harness.dev.patch.yml:32` 与 `docker/profile.patch.yml:22` 默认 `postgresql://postgres:check@…`（超级用户）且**无 `rlsContext`**；`docker/Dockerfile:41` ENV 写死同一串；`compose.ts:905-909`：`rlsContext===undefined → undefined`；`compose.ts:427-429/452`：undefined 时直接 `pool.query`，不调 `set_rls_context`；`002_security.sql:17-18` 把"运行时只授 `pentest_app`"写成部署契约，**代码中没有任何运行时断言**（`grep pentest_app` 在 `src/` 只命中注释）。【自验】
- **这不是隐藏漏洞**：设计文档 §（`design.md:3086-3089`）明确写"`docker/profile.patch.yml` 默认连接使用 `postgres`，没有 `rlsContext`；因此 FORCE RLS 在该连接上不构成实际边界"，并要求"将来扩展到共享数据库前必须完成真实 `pentest_app` 连接与 `test/rls-isolation.test.ts` 验证"。安全切片的"Critical"评级**据此下调**。
- **残留风险**：① 有人把 dev/profile 配置直接用于共享库（文档说"必须"但无任何机器护栏）；② 非超级用户 + 缺 rlsContext 的组合会让所有查询**静默** 0 行（fail-closed 但难排查，`pg-lease.ts:451-457` 已在注释里记录同类事故）。
- **修法**：启动自检——探测 `current_user`/`rolsuper`/`pg_has_role`：超级用户且未配置 `rlsContext` → 打**显著 warn**；配置了 `rlsContext` 但连接是超级用户 → warn"策略未生效"；`rlsContext` 缺失但角色是 `pentest_app` → 拒绝启动（必然全 0 行）。把 `rlsContext.tenantId` 提升为部署核心配置并写进 profile。

### 3.2 报告模块（上一轮自认未覆盖；4 个 Required）

1. **`getReportDraft` 是"读"端点却每次落一版新报告**（`pg-report.ts:844-862`：无条件 `#nextVersion`+`SQL_INSERT_REPORT`；注册为 `kind:'read'` `console/rpc.ts:1009-1016`；客户端每次打开面板都调 `client/index.ts:538-542`）。正文含版本号（`:536`）→ 同一库状态两次调用得到不同 `contentHash` → **任何重读都让已持有的哈希过期，签字必然 `stale_state_version`**；`pentest.reports` 行数随面板打开次数无界增长。【自验】
2. **重读会把人工编辑版挤出最新版**：`updateReport` 落 `edited_content` 版本（`:868-907`），随后 `getReportDraft` 以 `edited_content=null` 落更高版本；`exportReport` 取 `max(version)` 并 `editedContent ?? 机器投影` 静默回退（`:933/1236-1243`）→ 人工修订从正式产物中消失。
3. **签字后仍会生成新版本**：`signReportVersion`（`:997-1013`）只标注当时最新行；之后任何一次面板打开都会产生未签字新版本，导出取 `max(version)` 与签字版不一致——直接违背 `client/index.ts:670-674` 声明的"导出哈希用于核对是不是签字那一版"。
4. **严重度误归因**：`pg-report.ts:491` 对所有分节的结论无条件标"（人工确认值）"，包括 `awaiting_review`/`unverified_candidates`/`assessed_not_confirmed`——与 §8.9"严重度只在人工接受后生效"及本文件 `:458-460` 注释矛盾。
   - 另有 Optional：预览与导出取源不一致（`:912-921` vs `:929-933`）、`updateReport` 无基版本校验（并发编辑互相覆盖）、正文脱敏通道缺失（`applyRedactions` 只清证据元数据，`:606-637`）、布尔解析静默转 false（`:644-652`）、7 个死导出。

### 3.3 执行路径等待窗口与失败处理

- **pacing 等待期间不复核**（Required P2）：`service.ts:1462-1484` 等待 rate/jitter/concurrency 槽位可长达数分钟；期间租约吊销/到期、engagement pause/halt、授权到期都**不会**中断（`abortInFlight` 仅由 epoch 前进触发，`compose.ts:1338-1341`）→ 凭证已消费、动作已登记，仍会启动容器接触目标。修法：`pacingGate.acquire` 返回后、`sandbox.run` 前重读 `sessions.binding` 复跑 `engagementViolation/leaseViolation`。
- **`finishRun` 无 try/catch**（Optional P2）：`service.ts:1541` 抛错则结果丢失、行停在 running；同键重试被 `idempotent_replay` 死锁 16 分钟（`recovery.ts:64` STALE_TOOL_RUN_SECONDS）。
- **timeout/abort 只杀宿主 docker CLI**（Optional）：`docker-sandbox.ts:306-324` 源码自认容器可能存活，无 `docker rm -f` 兜底（容器名确定性，可由 idempotencyKey 重建）。
- **`runtime_error` 分支不截断**（Optional）：`docker-sandbox.ts:476-486` 未应用 `maxOutputBytes`（其余三支有），最大 8MiB 原样进库/回传。

### 3.4 客户端与控制台

- **5 个端点的 `reason` 被静默丢弃**（Optional）：`rpc.ts:1845-1860` 先判 `!spec.reason` 短路，`reasonOptional` 永不生效；受影响 `startWorker/interject/pause/resume/abort`；`controller.ts:811` 给 interject 传的备注实际被丢。
- **`params.expectedStateVersion` 被静默接受**（Optional）：`rpc.ts:1875` 对全表放行但字段循环只用 `spec.fields`；与模块头"一律拒绝"的规则矛盾。
- **`lookupConsoleMethod` 原型链泄漏**（Nit）：`rpc.ts:1277-1281` `METHOD_TABLE[name] ?? null`，`lookup('toString')` 返回函数而 `isConsoleMethod` 返回 false，两 API 结论相反。

### 3.5 安全面（切片复核，已按文档核对降级）

- **默认密钥/口令可用**（Required）：`harness.dev.patch.yml:33`、`docker/profile.patch.yml:23` 内联 ledger secret 回退；`hash.ts:328-339` 不校验强度；`docker/Dockerfile:41`、profile 默认口令 `check`。示例文件自称"可进版本库而不含密钥"，实际可直接用于签名。
- **出口代理无鉴权 + 端口不限**（Required，但代理头部自述"开发用、不做鉴权、生产应换成裁决型代理"，`egress-proxy.py:16-17`）：`host_allowed` 纯主机后缀匹配（`:67-70`）；`CONNECT` 端口不参与白名单、非数字静默回落 443（`:175-176`）；监听 `0.0.0.0`（`:247`）。作为 RUNBOOK 部署路径的一部分，建议至少加 token 与端口限定。
- **skills 全局可写且无租户隔离**（与 REQ-5 同源）：`002:741-745` 对 `pentest_app` 授 INSERT/UPDATE；`002:132-134` 明确 skills 无 RLS。
- **RESTRICTIVE 租户策略只授 `pentest_app`**（Optional）：`015:72-101` 的 `tenant_boundary` 不覆盖 `worker_ro/auditor`；当前无生产调用点。
- **资产标签原型键**（Nit）：`pg-policy.ts:432` 普通对象 + `scope.ts:679-687` 取值 → `@constructor`/`__proto__` 路径可能 TypeError 而非稳定拒绝码。

### 3.6 测试与基础设施

- **5 文件 77 处清理吞错**（Required，见 §2 REQ-12 修正）；`assertNoResidue` 零调用。
- **仓库根 90MB 活 Chrome 配置目录 `.tmp-chrome-live/`**（Required 卫生）：含 `Login Data`/`History`/`Web Data`，仍在写入（属活会话，**不要贸然删除**）；`.gitignore`（只有 node_modules/lib）与 `.dockerignore`（`*.tmp.*` 不匹配）均未覆盖，而 docker 构建上下文是仓库根【自验：`du -sh` = 90M，`.dockerignore` 内容已读】。另有 `scripts/__pycache__`、`docker/tools/__pycache__`。
- **`.qa-hardening.ts` 孤儿脚本**（Optional）：全仓零引用，且不在 tsconfig include 内（`tsconfig.json:22`）——"技能自足性自动检查"的错觉。【自验】
- **`test:parallel` 与共享库串行纪律冲突**（Optional）：`package.json:49` 暴露且无保险丝；RUNBOOK:795 明说不允许。
- **无 lint/format 门禁**（Optional）：只有 tsc；本次 77 处吞错正是"无 lint 的人肉审查"的例证。
- **`hash.test.ts:157` 同义反复断言**（Nit）：`bytes.toString('utf8') === bytes.toString()` 恒真。
- **模板集/容器边界文档漂移**（Nit）：`docker/tools/Dockerfile:28-37`、`pentest-tool:15-28` 仍宣称五个探测模板属于 `DEFAULT_TEMPLATE_SPECS`（实际只剩 `direct_command`）；`pentest-tool` 头部对 `/tmp noexec`、非特权用户的描述与 `buildDockerArgs` 相反。

### 3.7 新增账本缺陷（切片复核）

- **AD-1 `reopenTechnicalWork` 死路**（Required）：`report.ts:162-215` 置 `worker_running` 但不清/不写 `active_agent_session_id`（`finishTechnicalTesting` 已清空它，`:64`）；此后 `startWorker/retryWorker/beginHandoff/finishTechnicalTesting/confirmTransition` 的闸门全部不满足 → 承诺的"补充技术动作"永远无法开始。
- **AD-2 intake 确认写图外边**（Required）：`intake.ts:980-986` 写 `type:'start', auth_pending→worker_running`，图上 `auth_pending→ready` 是 `recorded:false` 边、`start` 只属于 `ready→worker_running`——**每次范围确认都写**。
- **AD-3 `session_reused` 手写布尔**（Optional）：`planTransition` 已算出权威值（`transition-table.ts:401-402`），7 处调用点手写 `true`；无读取方，仅账本事实错误。

---

## 4. 项目评估

### 4.1 值得保留的强项（复核后依然成立）

1. **SQL/领域层的严谨度罕见**：自实现 punycode、非规范 IP 字面量拒绝、排除项优先、审批绑定的定向 CTE 互锁（`pg-store.ts:174-240`）、`FORCE ROW LEVEL SECURITY` + 角色分权 + `test/rls-isolation.test.ts` 以真实角色实测；触发器把不可变见证写进数据库而不是只靠代码。
2. **fail-closed 是底色**：`tsconfig` strict + `noUncheckedIndexedAccess`；`any`=0、非空断言基本可再生（31 处均为有据索引）；审计不可写即拒绝动作。
3. **降级显式化**：无嵌入器→lexical-only；索引滞后/死信可见；重建遇坏事件必 failed 而非 done。
4. **注释的反事故质量**：关键决策处几乎都写了"为什么不那样做 + 事故出处"（如 `pg-lease.ts:440-444` 对源码正则回落的自我否定、`surfaces.tsx` 对 96px 留白的实测记录、`compose.ts` 对池上下文的解释）。这一项对 AI 可导航性价值极高，应保持。
5. **测试基建**：`tsx-loader.mjs` 拒绝把测试跑在非 `pentest` 库上（事故驱动）；91 个 suite 121 秒跑完、全绿。

### 4.2 系统性问题（比单个 bug 更值得处理）

1. **"文档承诺的强制点"存在最后一公里缺失**：三处零消费者安全语义（REQ-4）、沙箱前第二次策略审计（REQ-6）、技能正文冻结（REQ-5）、嵌入版本登记器（REQ-11）、报告写读端点（§3.2-1）。共同模式：**机制被实现、被注释、被文档承诺，但没有被任何运行时路径消费**。建议把"每个安全承诺必须有运行时消费者或显式标注未接线"写成一次全仓审计 + 一个 `verify:` 脚本。
2. **账本一致性靠约定而非单点强制**：状态迁移有 4 条写入路径手写 `from_status/type/session_reused`（REQ-8/AD-2/AD-3）。建议统一走 `planTransition + assertPlan + recordTransition`，并把 `isLegalStatusEdge` 做成写入侧运行时校验（或 CI 断言），让非法边根本无法落库。
3. **巨函数集中度**：`createExecutionService` 1051 行/143 决策点、`compose()` 862、`PgWorkerTools` 1937 行——安全规则与装配细节交织，新增闸门必须手工对齐多处。见 §5.3 的深化方案。

---

## 5. 优化方案

### 5.1 P0：先修"承诺与实现不符"（1–2 天量级；每条都可写回归测试）

| # | 动作 | 关键文件 | 验收实验 |
|---|---|---|---|
| 1 | C-1：允许 `approved(未消费)→revoked`（service+SQL+011 触发器+新迁移），或删 UI 按钮并改写 §10.3.1 | `core.ts`、`010/011`、`ApprovalQueue.tsx` | 集成用例：批准→撤销→携旧凭证执行被拒（`approval_revoked`） |
| 2 | C-2：自铸凭证不进幂等键（`approvalId: selfApprovedNow ? '' : (approvalId ?? '')`），或先按无凭证键查询重放 | `service.ts:1177` | auto 档同命令连发两次 → 第二次返回首条结果、`tool_runs` 仅 1 行 |
| 3 | REQ-8b：interject 读真实 `engagement.current_status`；`handoff_drafting/transition_confirmation/auth_pending` 一律拒绝 | `sessions.ts:497-549` | beginHandoff 后 interject 被拒、草稿仍可确认/取消、无新迁移行 |
| 4 | REQ-1：三个 `start()` 移出 `onStartup` 块（或拆独立开关并改文档） | `index.ts:317-358` | dev 补丁下 >TTL 会话仍可执行 |
| 5 | REQ-2：清扫逐 engagement（复用 `scopes.listEngagementIds()`）；删源码正则回落 | `heartbeat.ts:212`、`pg-lease.ts:440-467` | 非超级用户下"清扫后 `reissueLease` 可用" |
| 6 | REQ-5：冻结 `{name,revision,contentHash}`；`loadSkill` 校验漂移并阻塞；正文限长/拒控制字符 | `core.ts:1219`、`pg-worker-tools.ts:384-431`、`pg-skill.ts` | 改正文/停用后旧会话加载失败而非读到新文 |
| 7 | REQ-6/REQ-7：`commitRun` 后**无条件**写带 `toolRunId` 的 `execution.policy.checked`；把 `policy_epoch/scope_version` 并进 `SQL_COMMIT_RUN` 原子条件 | `service.ts:1390-1521`、`pg-store.ts:182-240` | 故障注入：epoch 在 commit 后前进 → 沙箱不启动 |
| 8 | REQ-11：接线或删除（推荐删除登记器+版本过滤谓词，停止"看起来有防护"） | `embedding.ts:655+`、`retrieval.ts:555-577` | 删除后 `verify:*` 仍绿；接线则补端到端用例 |
| 9 | §3.1：启动自检 RLS 组合（超级用户/未配 rlsContext/`pentest_app`） | `compose.ts`、`index.ts` | 三种组合各自的 warn/refuse 单测 |
| 10 | §3.5：移除两处默认 ledger secret 与默认口令，未设置即拒绝启动 | 两个 patch.yml、`Dockerfile`、`hash.ts:328-339` | 缺 env 启动失败且提示可执行 |

### 5.2 P1：账本一致性、报告、客户端、执行窗口（3–5 天）

- **账本**：统一迁移写入器（`assertPlan + recordTransition`）；`finishTechnicalTesting` 改只写领域事件；`confirmTransition` 补 `assertPlan` 并禁止同阶段 `retry` 伪装 `advance`；AD-2 改为"授权边不记账 + `ready→worker_running` 记 `start`"；AD-1 修复 `reopen` 的会话指针；`computeHandoffHash` 接上生产路径（`handoff-flow.ts:82/401`）；reindex 预算耗尽改失败路径或自动续跑（并修复 `resetWatermark→0` 导致的大作业永不完工）。
- **报告模块**：按 §3.2 四项修复（幂等取草稿、编辑版优先、签字版优先导出、严重度按分节标注），并补"连续两次 `getReportDraft` 哈希不变""编辑→重读→导出一致""签字后再取草稿不被覆盖"三条集成测试。
- **客户端**：预算严格解析 + 非可解析即禁用（`RunControls.tsx`）；`select` 失败清 state/sessions + 请求序号守卫（`controller.ts`）；抽零依赖 `console/method-names.ts` 供视图导入，并在 `verify-client-bundle.ts` 加"产物不得含 `require("node:`/`createHash`"断言 + `stubRequire` 收紧为 fail-closed。
- **执行窗口**：pacing 返回后复核 binding；`finishRun` 有限重试 + 结构化 blocked；超时/中止时 `docker rm -f <确定性容器名>`；`runtime_error` 分支截断。
- **叙事统一**：模板/worker 的"本部署可出网"文案与 `harness.dev.patch.yml:48-50`、RUNBOOK §2、`start-personal.mjs:109-147` 的事实统一（先 `docker network inspect` 实跑确认）；`egress-proxy` 至少加 token + 端口限定，或在 RUNBOOK 中明确降级表述。
- **基础设施单一来源**：sandbox argv、模板集、smoke 命令从 TS 导出供脚本消费；`smoke.sh` 补 303 握手（否则该门恒假，等于没有）。

### 5.3 P2：架构深化（按 `codebase-design` 词汇；删除测试已逐一评估）

| 候选 | 深层模块 | 缝 | 收益 | 强度 |
|---|---|---|---|---|
| C1 `createExecutionService`（1051 行） | `AdmissionPipeline`：有序只读阶段数组 `{name, check(ctx)}`，`admit` 短路于 rejected/needs_approval/admitted；`execute` 复用"重新裁决"子集 | 阶段顺序 + 审计记账 + 拒绝码生成 | 新增闸门=新增具名阶段；单阶段可独立测试；`execution.test.ts` 零改动 | **Strong** |
| C3 `PgWorkerTools`（1937 行） | `WorkerSessionContext.enter(sessionId,{allowExpiredLease})` → `{engagementId, session, scopeSets, tx}`；族拆文件，`PgWorkerTools` 退化为 facade | 会话准入 + 范围集合 + 拒绝载荷 + 事务 | 租约/RLS 语义单点修改；消除与 `pg-memory-query.ts:462-497` 的第二份范围解析 | **Strong** |
| C5 `openTask`/`bootstrapIntake` 双份状态机 | 私有 `stageIntake({clientSessionKey,dshSessionId,name,reuse})` | 幂等收敛与复用判定 | 已分叉（`intake.ts:145` vs `381-387`，openTask 可能复用已关闭会话）→ 单点修复 | **Strong** |
| C2 `compose()`（862 行） | `installDatabase/Memory/Execution/Workflow/Console` 安装器表，组合根≈200 行编排 | 安装器输入/输出类型 | 接线改动局部化；启动失败定位 | Worth exploring |
| C4 客户端闸门 | 纯展示 `GateCard/GateList({blockers,label,classPrefix})`（判定仍留各视图纯函数） | blocker 类型 | 3 种数据形状/7 份 CSS 收敛为 1；三个单体（ConsoleApp 597/IntakePrompt 521/EngagementWizard 503）按区块拆 | Worth exploring / Speculative |
| C6 死码清理 | 删 `freezeCapabilities/checkCapability`、`useToggle/usePolling`、`createMemoryLedger`、`toToolError`、`describeComposition`（**不要删 `consumeApproval`**，它是契约面且被测试直接引用） | — | 零行为变化，消除"被误接线的错误信号" | **Strong（零风险）** |
| C7 `typert-face.ts`（~750 行机械转发） | 由方法表生成 `@Remote` 转发（或生成文件+校验脚本） | 方法表即唯一事实源 | 端点增删一处完成；先验证 cordis `@Remote` 的注册机制是否允许生成 | **Speculative** |

不建议动 `contracts.ts`（2313 行、几乎纯类型、无长函数）：拆分只增加 import 噪声。

### 5.4 P3：护栏（把"人肉审查"变成门禁）

1. **加 lint**：typescript-eslint（`no-floating-promises`、`no-empty`(allowEmptyCatch:false)、`no-explicit-any`、`import/no-cycle`）与 `prettier --check`；先对 `test/` 跑基线，正好暴露 77 处吞错。
2. **把文档承诺变成可执行锁**：`verify-client-bundle.ts` 加 node: 前缀断言（§5.2）；新增 `verify:capabilities`（每个安全承诺必须有调用方——先覆盖 `EmbeddingRevisionRegistry`、`assertAdjudicatedAddress`、`evaluateRedirectChain`、`executionToken`）；`assertNoResidue` 扩到 chunks/outbox 并在集成套件收尾调用。
3. **单一来源**：sandbox argv/模板集/冒烟命令从 TS 导出；`.gitignore`/`.dockerignore` 加 `.tmp-chrome-live/`、`__pycache__/`、`*.pyc`。
4. **测试纪律**：5 个文件迁 `cleanupEngagements`；`test:parallel` 删除或加保险丝；新增 `test/workflow-ledger-consistency.test.ts`（对每个工作流操作断言 `isLegalStatusEdge`）+ 报告时序用例 + 代理 403 进程级用例。
5. **仓库卫生**：处理 `.tmp-chrome-live/`（活会话，先确认再删；至少移出仓库/加 ignore）、删除或迁移 `.qa-hardening.ts`；**强烈建议 `git init` 并首次提交**——现在没有任何版本历史，回滚与"改动前后对照"都不可行（这也是本轮只能做快照评审的原因）。

### 5.5 建议推进顺序（一页）

```
P0  C-1 → C-2 → REQ-8b → REQ-1 → REQ-2 → REQ-5 → REQ-6/7 → REQ-11 → RLS 自检 → 密钥默认值
P1  账本统一写入器(8a/8c/AD-1/AD-2) → 报告四修 → 客户端三修 + 产物断言 → pacing 复核 → reindex 续跑 → 叙事统一/smoke/argv
P2  C1 阶段管线 → C3 WorkerSessionContext → C5 intake staging → C2 安装器表 → C4 GateCard → C6 死码 → C7（先验证机制）
P3  lint/CI → verify 脚本族 → 单一来源 → 测试纪律 → git init + 卫生
```

---

## 6. 未覆盖与边界（如实声明）

- **无 `.git`**：无法做 diff 审查、历史对比或"上一轮修复是否回退"的判定；所有结论仅为当前快照。
- **未做性能压测**：重建 >5000 事件、N 条引用读取、控制台冷启动均无基准；REQ-10 的规模结论来自代码路径而非实测。
- **未实跑的运行时验证**：`docker/smoke.sh` 恒假结论、`dev-sandbox-up.sh` 与生产 argv 差异、代理 403 行为——均为读码 + 读依赖库源码，**未起容器验证**；`docker network inspect` 的 internal 事实未查。
- **未复核的切片结论**：报告模块（§3.2）、部分账本项（AD-1/AD-2）、`pg-lease` 清扫细节未逐行由本评估重读（已抽查关键行：`getReportDraft` 写读、`resolve_approval`、`session_releases` 策略、`checkCapability` 死导出）；标注为【切片复核】的条目请按对应 `file:line` 复核后再对外引用。
- 上一轮提及的"UI 级（模型在环）活体验证"（撤销按钮、auto 幂等、DNS 固定代理路径）仍未做；建议 P0 修复后按 RUNBOOK 固定演练清单逐条脚本化。

---

## 附：本轮方法与证据链

- 门禁与测试：本评估亲自执行（`npm run typecheck/build/verify:client/verify:styles/verify:forward-migration` + `npm test`）。
- 静态度量/导入环：本评估自写脚本（TS Compiler API AST 计数；Tarjan SCC），命令与输出保留在会话记录中。
- 逐条自验清单：C-1（UI→core→SQL→触发器→唯一写入函数枚举）、C-2（键派生→自放行插入→重放入口→唯一约束）、REQ-1、REQ-2 关键行、REQ-6/REQ-7 关键行、报告写读端点、RLS 配置面、代理白名单、`.tmp-chrome-live`/`.qa-hardening.ts`/`.dockerignore`、`test/rls-isolation.test.ts` 机制。
- 9 个切片代理的完整输出保存在会话记录中（`agent://<切片名>`），每条结论均带 `file:line`。

---

## 附二：P0 实施记录（2026-10-05，同日晚）

> 只记录**已落地并有测试锁**的事实；未落地的单列。全量门禁复跑：`npm test` **1606/1606**
> （92 suites，113s，0 fail/0 skip，较修复前 +12 用例）；`typecheck`、`build`、
> `verify:client 37/37`、`verify:styles`、`verify:forward-migration 25 断言` 全部通过。

| 项 | 落地内容 | 文件 | 回归锁 |
|---|---|---|---|
| C-1 | 新增受保护边 `approved(未消费)→revoked`：迁移 025 替换 `resolve_approval` 与 `enforce_approval_update`，`core.ts` 放行该边 | `db/migrations/025_approval_revocable.sql`、`workflow/core.ts` | `pg-workflow.test.ts` 新用例（批准→撤销落库、已消费不可撤销、终态不可反复）。**红/绿验证**：回退 TS 守卫 → 用例以「该放行已被处理过（approved）」失败 |
| C-2 | 自铸凭证不参与幂等键（`approvalId: selfApprovedNow ? '' : …`） | `execution/service.ts`、`execution/idempotency.ts` 注释 | `execution.test.ts`「同命令重发同键同结果、沙箱只跑一次」。**红/绿验证**：回退后失败 |
| REQ-1 | 三个 `start()` 与对账开关解耦；`runtime.recovery` 放错层时显式告警；dev 补丁与测试配置移到顶层 `recovery`；`ApplyResult` 增加 `backgroundLoops` 观测 | `index.ts`、`harness.dev.patch.yml`、`compose.test.ts` | 启动重扫/心跳两用例新增断言：`onStartup:false` 下心跳与调度照常启动 |
| REQ-2 | 到期清扫逐作业执行（`expireLeases` 增加 `engagementId` 作用域；`PgLeaseStore.transaction` 接受作用域对象）；删除闭包源码正则回落，配了逐会话解析却缺作用域**响亮失败** | `workflow/lease.ts`、`pg-lease.ts`、`heartbeat.ts` | `heartbeat.test.ts` 逐作业断言；`pg-lease.test.ts` 作用域解析用例（含响亮失败） |
| REQ-5 | 会话创建时冻结技能内容 `{name,revision,contentHash}`（迁移 026 新增 `skill_freeze`）；`loadSkill` 检测删除/停用/正文漂移并给出准确拒绝；旧会话回退既有语义 | `026_skill_freeze.sql`、`workflow/core.ts`、`memory/pg-worker-tools.ts`、`tools/worker.ts`、`contracts.ts` | `skill-load.test.ts` 6 用例（正文替换、删除、停用、旧会话回退），并重写了锁定旧语义的停用用例 |
| REQ-6 | 沙箱启动前**无条件**写第二条 `execution.policy.checked`（带 `toolRunId`）；写不进去则 `finishRun(blocked)` 且不启动沙箱 | `execution/service.ts` | `execution.test.ts` 成功/失败两条断言 |
| REQ-7 | `policy_epoch`/`scope_version` 并进 `SQL_COMMIT_RUN` 原子条件；新增 `stale_state_version` 结果与诊断 | `execution/pg-store.ts`、`execution/service.ts` | `pg-execution-store.test.ts`（窗口内推进 epoch → stale，不登记、不烧凭证；恢复后同凭证可提交） |
| REQ-11 | 首次索引登记嵌入版本（`ensureEmbeddingRevision` 端口 + compose 接线），检索侧「只取活跃版本」过滤真正生效 | `memory/indexer.ts`、`compose.ts` | `indexer.test.ts`：登记一次、每作业去重、词法部署不登记 |
| RLS 自检 | 启动探测连接角色（`rolsuper/rolbypassrls`）与 `rlsContext` 组合：非超级用户缺上下文→**拒绝启动**；超级用户→显式告警 | `compose.ts`（`inspectRls`/`classifyRlsCombination`）、`index.ts` | `compose.test.ts` 组合分类断言 + 真实库探测 |
| 密钥 | 移除两处内联 ledger secret 默认值；缺它在 compose 期直接失败 | `harness.dev.patch.yml`、`docker/profile.patch.yml`、`compose.ts`、`RUNBOOK.md` | `compose.test.ts`「拒绝缺失账本密钥」 |

**本轮未落地（如实声明）**：

- REQ-11 后半：`reindex_engagement` 仍无生产入队点（「切换版本后触发全量重建」的运维入口未接）。
- 容器 profile 的数据库口令仍是 `check`（镜像内本地 PG 的 bootstrap 依赖它）；保留并在 RUNBOOK 说明。
- RLS 自检对超级用户只告警不拒绝（单租户是当前合法形态）；共享库前必须先换 `pentest_app` 连接。
- `skill_freeze` 的写入侧（`WorkflowCore.#freezeSkills`）由既有会话创建路径间接覆盖，未单独加断言；读取侧 6 条用例覆盖。
- 实施中发现并修正的测试夹具问题：`pg-execution-store.test.ts` 的种子行从未与 `PLAN_INPUT` 的 epoch/scope 对齐（原子条件生效前不可见），已补齐 `policy_epoch=7` / `scope_version=3`；`compose.test.ts` 两处把 `recovery` 放进 `runtime`（不生效），已移到顶层并改为真实关闭对账。
