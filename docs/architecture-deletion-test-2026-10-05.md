# dsh-pentest 删除测试（Deletion Test）报告（2026-10-05）

> 方法学：**全量机械度量（108 个模块：导出面 / 具名消费面 / 消费者矩阵 / 分支令牌）** + **四路只读删除测试切片**（客户端层 20 模块、memory/execution 18 模块、workflow 17 模块、契约类型面 6 模块）+ **对全部关键结论的逐条独立复核**（直接读码、跨文件 grep、declaration-emit 实测、npm pack 实测）。
> 术语遵循 `codebase-design`：**module / interface / depth / seam / adapter / leverage / locality**；判定严格按删除测试协议（复杂度**消失→透传**；**分散且调用方变复杂→真封装**；**分散但调用方几乎不变→浅模块**）。
> 本报告**不含任何代码改动**；所有操作待确认后执行。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 项目路径 | `C:/Projects/Agent-projects/dsh-DCG-pentest` |
| 语言 / 框架 | TypeScript（Node 22+，ESM，显式 `.ts` 后缀导入）；host 侧为 cordis 插件（无 Web 框架），client 侧为 React 18（`tsdown` 打成单文件 bundle） |
| 模块组织 | 按领域分目录：`workflow/`(18) `memory/`(12) `client/`(37) `execution/`(8) `console/`(5) `policy/`(5) `report/ skills/ tools/ agents/ db/`；**没有** utils/helpers/common/shared/base 目录 |
| 领域词汇表 / ADR | 无 `GLOSSARY.md`、无 `docs/adr/`（术语以 `docs/dsh-pentest-plugin-design.md` 为准） |
| 规模 | src 108 模块 / 60747 行；test 73 文件 / 4.2 万行；提交 25 次 |
| 扫描到的候选模块总数 | **108**（全量：文件级模块；`src/` 下无目录级 barrel 型封装单元，唯一目录级结构是 `client/styles/` 链，已单独判定） |
| 导出面总量 | 导出符号 **1277** 个 ＝ 具名消费 838 ｜仅在他处出现（签名/注释） 59 ｜**仓库内零引用 380**（占 29.8%） |
| 逐模块判定覆盖 | **62 个模块有完整删除测试推理**（含全部高 in-degree 模块与全部 utils 形态）；其余 46 个在附录给出机械度量与形态分类 |
| 度量口径修正 | 首轮脚本漏计本仓惯例 `export /** jsdoc */\nconst X = ...`（`model.ts` 实测 33 → 误计 16）；已修正并全量重跑（见附录 B）。**契约面切片据此驳回了我初版的零消费计数，驳回成立** |

**本轮之前的深化战役**（提交 `a80383f…3afd7c1`：compose 安装器化、闸门阶段化、intake 双入口收敛、WorkerSessionContext 收拢、删 8 个零消费者导出）已消化上一轮候选；本报告只计现状。

---

## 2. 删除测试结果表

| 模块 | 导出/具名消费 | 消费者(src/test) | 判定 | 删除后复杂度流向 | 建议强度 |
|---|---|---|---|---|---|
| `src/memory/compaction.ts` | 58 / 20 | 0 / 1 | 未接线深模块 | 未分散（零生产调用） | 中（决策依赖，非形态问题） |
| `src/workflow/budget.ts` | 35 / 14 | 2 / 1 | 混合：计量簇深 / 活性簇死 | 唯一活路（未分散） | 强（删除） |
| `src/workflow/lease.ts` | 37 / 21 | 8 / 5 | 混合：操作函数深 / 准入簇死且重复 | 唯一活路（未分散） | 强 |
| `src/workflow/reconcile.ts` | 15 / 11 | 3 / 1 | 深（纯判定）但含假想 seam | 未分散 | 强 |
| `src/workflow/handoff.ts` | 21 / 13 | 1 / 2 | 混合 | 未分散 | 中 |
| `src/compose.ts` | 27 / 8 | 1 / 3 | 深模块（装配根）/ 导出面过宽 | 未分散 | 强 |
| `src/client/styles/index.ts` | 1 / 1 | 1 / 0 | 透传模块 | 消失 | 强 |
| `src/client/styles/tokens.ts` | 2 / 2 | 1 / 0 | 浅模块 | 分散但调用方几乎不变 | 中 |
| `src/client/styles/base.ts` | 1 / 1 | 1 / 0 | 浅（import 接缝）/ DOM 级词汇表 | 未分散 | 中 |
| `src/client/styles/shell.ts` | 1 / 1 | 1 / 0 | 浅（import 接缝）/ DOM 级词汇表 | 未分散 | 中 |
| `src/client/styles/panels.ts` | 1 / 1 | 1 / 0 | 浅（import 接缝）/ DOM 级词汇表（混装） | 未分散 | 强 |
| `src/client/styles/chat.ts` | 1 / 1 | 1 / 0 | 浅（import 接缝）/ DOM 级词汇表 | 未分散 | 中 |
| `src/client/format.ts` | 14 / 14 | 20 / 1 | 深，但接缝切错 | 分散且调用方变复杂 | 强 |
| `src/client/controller.ts` | 5 / 4 | 20 / 13 | 深模块 | 分散且调用方变复杂 | 强 |
| `src/client/ui.tsx` | 12 / 12 | 22 / 0 | 深模块 | 分散且调用方变复杂 | 中 |
| `src/client/timeline.ts` | 11 / 5 | 3 / 1 | 深（纯逻辑）+ 词汇表副本 | 未分散 | 强 |
| `src/client/session-chat.ts` | 14 / 7 | 4 / 1 | 深（含真接缝） | 分散且调用方变复杂 | 中 |
| `src/client/panels.ts` | 5 / 5 | 1 / 1 | 深（含一处透传） | 未分散 | 强 |
| `src/client/surfaces.tsx` | 10 / 7 | 1 / 1 | 深（槽位契约） | 未分散 | 强 |
| `src/client/design.ts` | 14 / 6 | 2 / 1 | 深（令牌单源）+ 死导出 | 未分散 | 强 |
| `src/client/hooks.ts` | 2 / 2 | 2 / 0 | 深（uSES 纪律） | 未分散 | 中 |
| `src/client/log.ts` | 2 / 2 | 2 / 0 | 混合 | 未分散 | 中 |
| `src/client/panel-jump.ts` | 1 / 1 | 1 / 1 | 深（宿主容错接缝） | 分散且调用方变复杂 | 中 |
| `src/client/advance-phase.ts` | 2 / 1 | 1 / 1 | 深（窄化 + 测试接缝） | 分散且调用方变复杂 | 中 |
| `src/client/presets.ts` | 4 / 4 | 5 / 0 | 深（文案表） | 分散且调用方变复杂 | 中 |
| `src/client/styles.ts` | 2 / 2 | 1 / 1 | 深（幂等注入） | 分散且调用方变复杂 | 强 |
| `src/memory/ledger.ts` | 26 / 12 | 21 / 20 | 深 + 真 seam，但端口困在实现里 | 未分散 | 强 |
| `src/contracts.ts` | 189 / 176 | 80 / 41 | 深（跨模块词汇表） | 分散且调用方变复杂 | 强 |
| `src/policy/scope.ts` | 26 / 17 | 4 / 1 | 深（纯引擎） | 未分散 | 中 |
| `src/workflow/pg-workflow.ts` | 1 / 1 | 1 / 1 | 浅装配壳 | 分散但调用方几乎不变 | 强 |
| `src/workflow/core.ts` | 1 / 1 | 8 / 0 | 深模块（本仓最深） | 分散且调用方变复杂 | 强 |
| `src/workflow/session-port.ts` | 6 / 6 | 4 / 3 | 真 seam | 分散且调用方变复杂 | 强 |
| `src/workflow/intake.ts` | 1 / 1 | 1 / 0 | 深文件（真概念）+ 局部重复 | 未分散 | 强 |
| `src/workflow/engagement.ts` | 1 / 1 | 1 / 0 | 深文件（真概念）+ 局部重复 | 未分散 | 强 |
| `src/workflow/scope.ts` | 1 / 1 | 1 / 0 | 深文件（真概念） | 未分散 | 中 |
| `src/workflow/report.ts` | 1 / 1 | 1 / 0 | 深文件（真概念） | 未分散 | 中 |
| `src/workflow/approvals.ts` | 1 / 1 | 1 / 0 | 深文件 + 2 个纯委托方法 | 未分散 | 中 |
| `src/workflow/sessions.ts` | 2 / 2 | 1 / 1 | 深文件 | 未分散 | 中 |
| `src/workflow/handoff-flow.ts` | 2 / 2 | 1 / 1 | 深文件 | 未分散 | 中 |
| `src/workflow/heartbeat.ts` | 7 / 5 | 1 / 1 | 深模块 | 未分散 | 中 |
| `src/workflow/recovery.ts` | 7 / 3 | 1 / 1 | 深模块 | 未分散 | 中 |
| `src/workflow/pg-lease.ts` | 3 / 1 | 1 / 4 | 真适配器 | 未分散 | 中 |
| `src/memory/chunks.ts` | 39 / 19 | 9 / 7 | 深（分块管线）+ 宽接口 | 未分散 | 中 |
| `src/memory/retrieval.ts` | 37 / 19 | 4 / 3 | 深（检索/融合）+ 宽接口 | 未分散 | 中 |
| `src/memory/outbox.ts` | 24 / 11 | 5 / 6 | 深（队列） | 未分散 | 中 |
| `src/memory/hash.ts` | 16 / 11 | 4 / 2 | 深（规范序列化 + 签名） | 未分散 | 中 |
| `src/memory/dispatcher.ts` | 9 / 6 | 2 / 3 | 深（派发） | 未分散 | 中 |
| `src/memory/indexer.ts` | 11 / 7 | 2 / 3 | 深（单事件索引编排） | 未分散 | 中 |
| `src/memory/index-enqueue.ts` | 3 / 3 | 1 / 3 | 真适配器 | 未分散 | 中 |
| `src/memory/scheduler.ts` | 6 / 4 | 2 / 2 | 深模块 | 未分散 | 中 |
| `src/memory/session-context.ts` | 11 / 7 | 2 / 0 | 深 + 真接缝 | 未分散 | 中 |
| `src/memory/embedding.ts` | 18 / 9 | 2 / 3 | 深（三家 provider = 2 adapters） | 未分散 | 中 |
| `src/console/rpc.ts` | 18 / 10 | 6 / 12 | 深（端点面） | 未分散 | 中 |
| `src/console/method-names.ts` | 5 / 5 | 6 / 4 | 深（零依赖端点名清单） | 未分散 | 中 |
| `src/console/diagnostics.ts` | 2 / 2 | 1 / 1 | 深（注入式聚合） | 未分散 | 中 |
| `src/canonical.ts` | 1 / 1 | 2 / 0 | 深（内容哈希的规范 JSON） | 未分散 | 中 |
| `src/execution/idempotency.ts` | 6 / 5 | 4 / 4 | 深（幂等键派生） | 未分散 | 中 |
| `src/execution/templates.ts` | 16 / 11 | 4 / 5 | 深（模板白名单引擎） | 未分散 | 中 |
| `src/execution/gate-failures.ts` | 4 / 1 | 1 / 0 | 真适配器 | 未分散 | 中 |
| `src/execution/service.ts` | 19 / 16 | 7 / 3 | 深模块 | 未分散 | 中 |
| `src/tools/guard.ts` | 12 / 6 | 1 / 1 | 深（工具守卫管线） | 未分散 | 中 |
| `src/agents/dsh-session-factory.ts` | 2 / 1 | 1 / 1 | 真适配器 | 未分散 | 中 |

---

## 3. 逐模块详细分析（透传 / 浅模块 / 未接线 / 强建议）

### `src/memory/compaction.ts`

- **判定**：未接线深模块｜**复杂度流向**：未分散（零生产调用）｜**强度**：中（决策依赖，非形态问题）
- **度量**：导出 58（具名消费 20｜仅外部出现 5｜仓库内零引用 33）｜消费者 1（src 0 / test 1）｜实现 1226 行、分支令牌 194
- **删除测试推理**：58 导出 / 1226 行 / 21 个导出函数全部 0 生产调用点；唯一导入方是 test/compaction.test.ts。设计文档 §2249 自己记着「仅被测试导入」。删除测试下它不是透传（无可内联的调用方），而是一块没有接线（unwired）的能力：删则能力消失，留则整块接口无人验证其接线。
- **推荐操作**：需人工决定：接线（接 history/预算路径）或记 ADR 后删除；无论哪条，先收窄 33 个零引用导出

### `src/workflow/budget.ts`

- **判定**：混合：计量簇深 / 活性簇死｜**复杂度流向**：唯一活路（未分散）｜**强度**：强（删除）
- **度量**：导出 35（具名消费 14｜仅外部出现 0｜仓库内零引用 21）｜消费者 3（src 2 / test 1）｜实现 884 行、分支令牌 88
- **删除测试推理**：BudgetMeter 簇被生产消费（本模块具名消费 14 个）；LivenessMonitor 簇（**连续块 budget.ts:580-884**，含 HEALTH_SIGNAL_KINDS/HealthSignal/LivenessSnapshot/LivenessMonitorInput/LIVENESS_ACTIONS/DEFAULT_CONTEXT_PRESSURE_SECONDS/positive 助手）唯一构造点是 compose.ts:1974 的 createLiveness，全仓唯一调用者是 test/compose.test.ts:584 的形状断言（已复核：src 侧除 compose 外零命中）。**注：该块涉及设计文档 §10.5 承诺，删前需先决策。**
- **推荐操作**：删除 LivenessMonitor 簇（连同 compose 的 createLiveness 暴露），或把它接进心跳；收窄 21 个零引用导出

### `src/workflow/lease.ts`

- **判定**：混合：操作函数深 / 准入簇死且重复｜**复杂度流向**：唯一活路（未分散）｜**强度**：强
- **度量**：导出 37（具名消费 21｜仅外部出现 1｜仓库内零引用 15）｜消费者 13（src 8 / test 5）｜实现 743 行、分支令牌 110
- **删除测试推理**：6 个操作函数有 10+ 调用点（真封装）；**只有两个入口函数可删**：assertLeaseValid(265) / validateLeaseForOperation(722) 零生产调用（imports-matrix 复核），而生产实际走 execution/admission.ts:135 的 leaseViolation（同一拒绝码的第二份实现，:567/:819 在用，**含世代校验** :166/:821）。**不得连带删除** resolveGenerationAdmission（被在用的 renewLease 调用于 :546）、rejectionForLeaseState（其助手）、describeLease（:246/:252/:605 在用）、LeaseProtocolError（被 pg-lease.ts 导入）。收益：约 60-80 行 + 2 个导出（比我初版声称的小）。
- **推荐操作**：删除准入簇（保留端口与操作函数），消除与 admission.ts 的重复实现

### `src/workflow/reconcile.ts`

- **判定**：深（纯判定）但含假想 seam｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 15（具名消费 11｜仅外部出现 0｜仓库内零引用 4）｜消费者 4（src 3 / test 1）｜实现 366 行、分支令牌 19
- **删除测试推理**：reconcile 的判定被 recovery 落库消费（真封装）；ReconciliationSource（reconcile.ts:308）零实现（已复核：全仓除声明外 0 命中）——按「一个 adapter = 假想 seam」，它是从未实现的接缝。
- **推荐操作**：删除 ReconciliationSource；保留判定函数

### `src/workflow/handoff.ts`

- **判定**：混合｜**复杂度流向**：未分散｜**强度**：中
- **度量**：导出 21（具名消费 13｜仅外部出现 0｜仓库内零引用 8）｜消费者 3（src 1 / test 2）｜实现 414 行、分支令牌 46
- **删除测试推理**：宿主侧只用 4 个函数；enrichContextRefs(handoff.ts:77) 全仓零引用（已复核）；21 导出 / 4 具名。
- **推荐操作**：**先决策**：enrichContextRefs 疑似「未接线能力」（doc:1670/1683 要求显示引用来源/可信度），级联 ContextChunkMeta；收窄 8 个零引用导出

### `src/compose.ts`

- **判定**：深模块（装配根）/ 导出面过宽｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 27（具名消费 8｜仅外部出现 1｜仓库内零引用 18）｜消费者 4（src 1 / test 3）｜实现 2043 行、分支令牌 233
- **删除测试推理**：27 导出里 18 个符号在仓库内零引用（已复核：6 个 installX + 6 个 *Installation + TxDbPort/BackgroundScopes/RlsDiagnosis/TxClientHandle/RuntimeRlsContext/LeaseRlsResolver）——安装器只在 compose 内部被调用。真实 interface 只有 8 个名字（compose/inspectRls/createDatabasePool/acquireTxClient/createTxDb/classifyRlsCombination/ComposeConfig/ComposedPlugin；`missingSessionFactory` 只在 :1415 内部使用，属收窄对象）。
- **推荐操作**：收窄导出面（去掉 18 个 export，保留声明）；编译产物层面已验证合法（见附录 B 的 declaration-emit 实测）

### `src/client/styles/index.ts`

- **判定**：透传模块｜**复杂度流向**：消失｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 18 行、分支令牌 0
- **删除测试推理**：纯 barrel：只有 6 个 CSS 常量的 filter+join（18 行），唯一消费者 styles.ts:17。删除后装配 3 行搬进 styles.ts，无任何知识需要重建。
- **推荐操作**：直接删除（装配并入 src/client/styles.ts）

### `src/client/styles/tokens.ts`

- **判定**：浅模块｜**复杂度流向**：分散但调用方几乎不变｜**强度**：中
- **度量**：导出 2（具名消费 2｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 29 行、分支令牌 0
- **删除测试推理**：3 行 glue（@font-face 模板 + design.ts 的 tokenCss()），唯一消费者 styles/index.ts。令牌生成与自引用规避都在 design.ts，本文件不拥有行为。
- **推荐操作**：合并到 src/client/styles.ts（与 index.ts 一起）

### `src/client/styles/base.ts`

- **判定**：浅（import 接缝）/ DOM 级词汇表｜**复杂度流向**：未分散｜**强度**：中
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 55 行、分支令牌 0
- **删除测试推理**：纯 CSS 常量，import 接缝上删除即搬文本；但它承载 ROOTS≠ROOT 的踩坑知识（写错会把 width:10px 落到主面板上），DOM 级消费者是全部令牌根元素，且有测试断言（test/client-surfaces.test.ts:334-345）。
- **推荐操作**：保留但标记（内容切分 + 编辑局部性，非透传）

### `src/client/styles/shell.ts`

- **判定**：浅（import 接缝）/ DOM 级词汇表｜**复杂度流向**：未分散｜**强度**：中
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 276 行、分支令牌 0
- **删除测试推理**：零 import 的纯 CSS 常量（275 行），但真实 interface 是类名词汇表：ui.tsx 的 11 个组件与 15+ 视图按类名消费，靠 scripts/verify-style-coverage.mjs 对账。
- **推荐操作**：保留但标记；最优接缝是与 ui.tsx 共置（组件样式面）

### `src/client/styles/panels.ts`

- **判定**：浅（import 接缝）/ DOM 级词汇表（混装）｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 330 行、分支令牌 0
- **删除测试推理**：330 行 CSS：跨面板共享段（面板根/读数网格）与 10 个单视图专属段混装；DOM 级消费者约 11 个视图（已复核 ApprovalQueue/ReportReview/HandoffEditor/MemoryExplorer 等）。
- **推荐操作**：重新设计接缝：共享段留 styles/，单视图段随视图共置（并改 verify-style-coverage 遍历 views）

### `src/client/styles/chat.ts`

- **判定**：浅（import 接缝）/ DOM 级词汇表｜**复杂度流向**：未分散｜**强度**：中
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 138 行、分支令牌 0
- **删除测试推理**：138 行纯 CSS 常量，DOM 级消费者 3 个视图（SessionChat/IntakePrompt/AgentTrace）。
- **推荐操作**：保留但标记（或按视图共置）

### `src/client/format.ts`

- **判定**：深，但接缝切错｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 14（具名消费 14｜仅外部出现 0｜仓库内零引用 0）｜消费者 21（src 20 / test 1）｜实现 212 行、分支令牌 41
- **删除测试推理**：删除它 → 20 个生产调用方各自内联映射表，复杂度分散且必然不一致。但它把「1 张词汇表」暴露成 14 个符号，且缺 sessionStatus 一档，导致副本长回来（已复核：timeline.ts:122 的 sessionStatusLabelOf 与 AgentTrace.tsx:31 的 SESSION_STATUS_LABELS 措辞不同——active「工作中」vs「运行中」、handoff_drafting「准备交接中」vs「准备交接」、blocked「阻塞」vs「已阻塞」；timeline.ts:242 复制了 sessionStatusTone；phase-track.ts:76 内联复制 phase 标签）。
- **推荐操作**：重新设计接缝：收窄为 label(kind,value) / tone(kind,value) 两个访问器（或保留函数但补齐 sessionStatus 并删 5 处副本）

### `src/client/controller.ts`

- **判定**：深模块｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 5（具名消费 4｜仅外部出现 0｜仓库内零引用 1）｜消费者 33（src 20 / test 13）｜实现 1023 行、分支令牌 91
- **删除测试推理**：5 导出 / 约 45 方法 / 33 消费者。幂等键、乐观锁、stale 重试、写后重读、迟到响应归属、uSES 快照六件事都在内部；删除即分散到 20 个视图。瑕疵：mutate 是公开无类型逃生口，3 个端点没有类型化包装（surfaces.tsx:298、EngagementList.tsx:160/208、RunControls.tsx:209）；Readable<T> 导出但零消费者（已复核）。
- **推荐操作**：保留并深化：补 3 个类型化包装、把 mutate 收为内部；会话级版本语义（state 恒 null）收回控制器

### `src/client/timeline.ts`

- **判定**：深（纯逻辑）+ 词汇表副本｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 11（具名消费 5｜仅外部出现 0｜仓库内零引用 6）｜消费者 4（src 3 / test 1）｜实现 266 行、分支令牌 55
- **删除测试推理**：11 导出中 6 个零引用（OrphanInfo/MinimapBlock/MinimapGroup/TimeTick/phaseOrder 等仅内部使用）；内部 statusTone/sessionStatusLabelOf 是 format.ts 的副本（措辞已漂移）。
- **推荐操作**：收窄导出为 5 个；删除内部副本改调重设后的 format

### `src/client/panels.ts`

- **判定**：深（含一处透传）｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 5（具名消费 5｜仅外部出现 0｜仓库内零引用 0）｜消费者 2（src 1 / test 1）｜实现 405 行、分支令牌 25
- **删除测试推理**：buildPanels 把「空/未读/读失败/未接线」四态分派到 8 个面板（已复核注释与测试 test/client-panels.test.ts:445）；同文件 buildRunControls 是 5 行纯转发（已复核 panels.ts:265-277）。
- **推荐操作**：删除 buildRunControls（index.ts:781 直接 createElement）

### `src/client/surfaces.tsx`

- **判定**：深（槽位契约）｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 10（具名消费 7｜仅外部出现 0｜仓库内零引用 3）｜消费者 2（src 1 / test 1）｜实现 373 行、分支令牌 43
- **删除测试推理**：槽位 id 双向一致、为 fixed 状态条留白的实测数值、statusPillFacts 推导都在内部；2 个零引用类型（HostDomNodeLike/HostDomRootLike，已复核全仓零命中）+ 一处裸 mutate。
- **推荐操作**：删除 2 个死类型（**已复核被取代**：doc:1283 官方 ask_user_question 通道已接线，DOM 探测路线废弃；两类型连本文件内都无使用）；setApprovalMode 换类型化包装

### `src/client/design.ts`

- **判定**：深（令牌单源）+ 死导出｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 14（具名消费 6｜仅外部出现 0｜仓库内零引用 8）｜消费者 3（src 2 / test 1）｜实现 255 行、分支令牌 6
- **删除测试推理**：800+ 行 CSS 与两份门禁的共同上游；TYPE_SCALE / SPACE 零消费者（已复核），但注释写明「样式里直接写数字以免多一层计算」→ **刻意的零消费，不是遗忘**；relativeLuminance 仅内部用；门禁脚本以正则读源文本而非 import definedTokens。
- **推荐操作**：保留 TYPE_SCALE/SPACE（设计系统事实）；如要收窄只去 export 关键字；门禁改 import definedTokens

### `src/client/log.ts`

- **判定**：混合｜**复杂度流向**：未分散｜**强度**：中
- **度量**：导出 2（具名消费 2｜仅外部出现 0｜仓库内零引用 0）｜消费者 2（src 2 / test 0）｜实现 27 行、分支令牌 7
- **删除测试推理**：logWarn 深（6 调用点，编码 cordis logger 形状探测）；describe 是 1 行且全仓 3 份副本（client/log.ts:24、agents/dsh-session-factory.ts:718、workflow/recovery.ts:574）。
- **推荐操作**：保留 logWarn；describe 提取为共享工具或删除

### `src/client/styles.ts`

- **判定**：深（幂等注入）｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 2（具名消费 2｜仅外部出现 0｜仓库内零引用 0）｜消费者 2（src 1 / test 1）｜实现 52 行、分支令牌 2
- **删除测试推理**：marker 幂等、无 document 返回 null、只给自己插入时返回 disposer——apply 是「绝不抛异常」的启动路径。PENTEST_CSS 的再导出售给测试。
- **推荐操作**：保留并深化：吞并 styles/index.ts 的装配

### `src/memory/ledger.ts`

- **判定**：深 + 真 seam，但端口困在实现里｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 26（具名消费 12｜仅外部出现 6｜仓库内零引用 8）｜消费者 41（src 21 / test 20）｜实现 912 行、分支令牌 118
- **删除测试推理**：不是 barrel（26 导出中 25 个是本文件实现）；AnchorSink 有 2 个 adapter（PgAnchorSink/InMemoryAnchorSink）＝ 真 seam。问题：通用端口 DbClient / RlsAwareDbClient / DbTransactionRunner 长在账本模块里，13 个文件 import 它、其中 11 个只为类型（已复核：workflow×7、execution×2、policy/report/skills/compose）；另有死 re-export LedgerError。
- **推荐操作**：重新设计接缝：把 Db* 端口外迁到 db/ 模块（账本只留账本语义）；删除 LedgerError re-export

### `src/contracts.ts`

- **判定**：深（跨模块词汇表）｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 189（具名消费 176｜仅外部出现 3｜仓库内零引用 10）｜消费者 121（src 80 / test 41）｜实现 2343 行、分支令牌 103
- **删除测试推理**：189 导出、121 消费者；删除即 121 个调用方各自声明取值域（漂移）。其中 12 个零消费者：4 个真死重（CONSOLE_ONLY_PHASES / advancesIteration / HandoffDraftRequest / HandoffEdit）、7 个仅内部类型组合、1 个需人工判断（CONTENT_REQUIRED_KEYS）。
- **推荐操作**：拆分为：advancesIteration 可删（规则由 validateGraph/assertGraph 承担，且两者仅测试调用）/ CONSOLE_ONLY_PHASES 保留（Phase 类型已排除两阶段，常量是文档性记录）/ HandoffDraftRequest 与 HandoffEdit 撤回删除（design.md:4162/4198 是 §16 端点签名，改为对账端点清单）；7 个内部组合收回非导出

### `src/workflow/pg-workflow.ts`

- **判定**：浅装配壳｜**复杂度流向**：分散但调用方几乎不变｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 2（src 1 / test 1）｜实现 423 行、分支令牌 1
- **删除测试推理**：39 处 return this.#… 的 1:1 委托（已复核计数），15 个零引用导出，JSDoc 与流程文件重复。删除它＝把 39 行搬回调用方（compose/index），调用方几乎不变——这是「虚假封装」的形态。但它是 40 个服务的唯一组合点，直接删会把组合职责推给装配根。
- **推荐操作**：重新设计接缝：保留组合职责但去掉纯委托与重复 JSDoc（或让流程类直接暴露给装配根）

### `src/workflow/core.ts`

- **判定**：深模块（本仓最深）｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 8（src 8 / test 0）｜实现 1524 行、分支令牌 185
- **删除测试推理**：1 导出 / 1524 行 / 8 消费者：事务+RLS+异步作用域、乐观锁、唯一账本写路径、策略展开、行装载器收在一处。删除即这五类机制分散到 7 个流程类。
- **推荐操作**：保留

### `src/workflow/session-port.ts`

- **判定**：真 seam｜**复杂度流向**：分散且调用方变复杂｜**强度**：强
- **度量**：导出 6（具名消费 6｜仅外部出现 0｜仓库内零引用 0）｜消费者 7（src 4 / test 3）｜实现 205 行、分支令牌 17
- **删除测试推理**：SessionFactory 有 4 个实现（DshSessionFactory / missingSessionFactory / FakeSessionFactory / RecordingSessionFactory）＝ 真 seam（不是假想）。
- **推荐操作**：保留（并注意 interrupt/close 与 SessionFactoryError.retryable 零调用）

### `src/workflow/intake.ts`

- **判定**：深文件（真概念）+ 局部重复｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 1026 行、分支令牌 83
- **删除测试推理**：1026 行 / 1 导出 IntakeFlow：单点 staging 状态机、双入口共用。它真的隐藏过程（本轮质检刚在其中加了「已离开 intake 不得回退」守卫）。重复：insert into pentest.policy_versions 在 intake.ts:822 与 engagement.ts:203/338、scope.ts:155 共 4 份（已复核）。
- **推荐操作**：保留；把「冻结策略版本」收进 core（去 4 份重复）

### `src/workflow/engagement.ts`

- **判定**：深文件（真概念）+ 局部重复｜**复杂度流向**：未分散｜**强度**：强
- **度量**：导出 1（具名消费 1｜仅外部出现 0｜仓库内零引用 0）｜消费者 1（src 1 / test 0）｜实现 1135 行、分支令牌 121
- **删除测试推理**：1135 行 / 1 导出 EngagementFlow / 13 方法；4 份 policy_versions 重复中的 2 份在本文件。
- **推荐操作**：保留；冻结策略版本收进 core


---

## 4. 深模块识别（通过删除测试、真正在封装复杂度的模块）

| 模块 | 隐藏了什么复杂度 | 接缝是否清晰 | 深化空间 |
|---|---|---|---|
| `src/workflow/core.ts` | 事务+RLS+异步作用域传播、乐观锁、唯一账本写路径、策略展开、行装载器（1 导出 / 1524 行 / 8 消费者） | 清晰：流程类只经 core.deps 取端口；**泄漏点**是流程类直接下钻发原生 SQL（4 份 policy_versions INSERT） | 把「冻结策略版本」等重复事务片段收进 core |
| `src/client/controller.ts` | 幂等键/乐观锁/stale 重试/写后重读/迟到响应归属/uSES 快照（5 导出 / 33 消费者） | 大体清晰；mutate 是无类型的公共逃生口，会话级版本语义外泄 | 补类型化包装、收 mutate、把版本语义收回 |
| `src/memory/ledger.ts` | 事件哈希链、锚定、事务运行器（26 导出 / 41 消费者）；AnchorSink 有 2 个 adapter = 真 seam | 不清晰：通用端口 DbClient 长在账本里，11 个无关模块只为该类型 import 账本 | **把 Db* 端口外迁成独立模块**（本报告最强接缝建议） |
| `src/workflow/session-port.ts` | 会话工厂协定（6 导出 / 4 个实现：真实 dsh 工厂、missing 桩、2 个测试替身）= 真 seam | 清晰；零调用的 interrupt/close 是未用能力 | 无（保持） |
| `src/execution/service.ts` | 受理→沙箱→结算的唯一编排（19 导出 / 10 消费者 / 1405 行，热区） | 清晰（审计闸门与 pacing 在内） | 收窄 6 个弱消费导出 |
| `src/workflow/{intake,engagement,sessions,handoff-flow,scope,report}.ts` | 各自一个完整流程概念（单入口、内部事务编排） | 对消费者清晰（pg-workflow 只有一行委托）；流程对 core 直接发 SQL | 重复事务片段收进 core |
| `src/client/{ui.tsx,panels.ts,surfaces.tsx,session-chat.ts,presets.ts,design.ts}` | DOM 原语与类名协议；四态分派；槽位契约；游标发现协议；冻结文案表；令牌单源 + WCAG | 清晰 | ui：prefix 白名单；surfaces：删死类型；session-chat：外提 stripControlSequences |
| `src/memory/{chunks,retrieval,outbox,hash,session-context,embedding}` | 分块管线、检索融合（双消费者）、队列、签名、会话准入合并接缝、三家嵌入 provider | 清晰 | 收窄稀疏边缘（各 3-17 个零引用） |

---

## 5. 行动清单（按优先级）

> ⚠️ **本节是初版清单，已被多轮复核修订**：A 组第 2 / 8 / 10 项撤回或降级、lease 簇收窄、统计口径修正、compaction 处置改为「登记 pending + 指向设计文档 §8.10.0」——**动手前请以《附录 E.5》为准**（它汇集并取代 C.5 / D.5；第五轮补充见 **附录 F**）。

### A. 立即删除（强建议；删除后项目更简洁，风险低）

1. `src/client/styles/index.ts` —— 纯 barrel（6 常量 join），装配并入 `styles.ts`。
2. `src/workflow/budget.ts` 的 LivenessMonitor 簇（约 310 行）+ compose 的 createLiveness 暴露 —— 生产零消费者，唯一调用者是形状断言。
3. `src/workflow/lease.ts` 的准入簇（assertLeaseValid / validateLeaseForOperation）—— 生产走 `execution/admission.ts:135` 的第二份实现，重复且零调用。
4. `src/workflow/reconcile.ts` 的 ReconciliationSource —— 零实现（假想 seam）。
5. `src/workflow/handoff.ts` 的 enrichContextRefs —— 全仓零引用。
6. `src/client/surfaces.tsx` 的 HostDomNodeLike / HostDomRootLike —— 零引用残留。
7. `src/memory/ledger.ts` 的 `export { LedgerError } from './hash.ts'` —— 死 re-export。
8. `src/client/design.ts` 的 TYPE_SCALE / SPACE（零消费）与 relativeLuminance 的导出。
9. `src/client/panels.ts` 的 buildRunControls —— 5 行纯转发。
10. `src/contracts.ts` 的 4 个真死导出：CONSOLE_ONLY_PHASES / advancesIteration / HandoffDraftRequest / HandoffEdit。
11. **构建产物清理**：`lib/agents/capability.js` + `lib/types/agents/capability.d.ts` 是已删除模块的陈旧产物且**进入发布包**（已用 `npm pack --dry-run` 实测）—— 需要 build 前 clean（或收紧 files）。

### B. 合并重构（中建议）

12. `src/client/styles/tokens.ts` 并入 `styles.ts`（3 行 glue）。
13. describe 三份副本（`client/log.ts:24`、`agents/dsh-session-factory.ts:718`、`workflow/recovery.ts:574`）提取为单源。
14. `'index_event'` 字面量三处（`outbox.ts:53`、`dispatcher.ts:50`、`index-enqueue.ts:23`）收敛为单一声明。
15. RUNTIME_MARKER_TYPES(`transition-table.ts:191`) ≡ RUNTIME_MARKER_TRANSITION_TYPES(`phases.ts:529`) 同值双导出，留一份。

### C. 重新设计接缝（中建议）

16. **DbClient 外迁**：把 DbClient / RlsAwareDbClient / DbTransactionRunner 从 `memory/ledger.ts` 提到 `db/` 下的端口模块，解开 11 个模块对账本模块的类型依赖（本报告最强接缝建议）。
17. **format.ts 词汇表**：14 个符号 → 收窄为 label(kind,value) / tone(kind,value)；随后删 5 处副本（`phase-track.ts:76`、`timeline.ts:122/242`、`AgentTrace.tsx:31`、`MemoryExplorer.tsx:347`）。现状已实证「同一状态两种措辞」。
18. **pg-workflow.ts 浅装配壳**：39 处 1:1 委托 + 重复 JSDoc；保留组合职责、去掉纯委托与重复文档（或让流程类直接暴露给装配根）。
19. **styles/panels.ts 按视图共置**：10 个单视图专属段随视图走，共享段留装配层；`verify-style-coverage.mjs` 改为遍历 views。
20. **「冻结策略版本」收进 core**：policy_versions INSERT 现有 4 份（`engagement.ts:203/338`、`intake.ts:822`、`scope.ts:155`）。
21. `controller.mutate` 逃生口：补 setApprovalMode / archiveEngagement / purgeEngagement 三个类型化包装后收为内部。

### D. 保留观察（弱建议）

22. **memory/compaction.ts（需人工决定，非形态问题）**：1226 行 / 58 导出 / 21 个函数**全部零生产调用**（唯一导入方是测试；设计文档 §2249 自认）。选项：**(a)** 接线到 history/预算路径（它产出的 CompactionPayload 正是账本 context.compacted 事件的预期负载）；**(b)** 记 ADR 后删除该模块与测试，明确压缩由 harness 侧承担。无论哪条，先收窄 33 个零引用导出。
23. 宽接口模块的**非导出化**（不动行为、只收 interface）：compose.ts(18)、workflow/phases.ts(18)、lease.ts(15)、chunks.ts(17)、retrieval.ts(12)、contracts.ts(7 内部组合)、policy/scope.ts(9)、outbox.ts(9)、handoff.ts(8)、console/rpc.ts(8)、db/migrate.ts(6)、tools/guard.ts(6)、视图文件（SkillLibrary 8、MemoryExplorer 7、ReportReview/ReportExport 各 5）等 —— 全仓合计 **380 个零引用导出**（29.8%），其中 **74.2% 是 interface/type 声明**。已实测：非导出类型出现在导出签名中，`tsc --declaration` 合法（附录 B）。
24. `styles/{base,shell,panels,chat}.ts`：import 接缝上是浅的（删除=搬文本），但真实 interface 是 DOM 级类名词汇表（3–15+ 视图消费）→ 保留；若要动，走第 19 条的按视图共置。
25. session-port 的 interrupt/close、SessionFactoryError.retryable：零调用但属端口完整性的一部分，标记即可。
26. 包级：`package.json` 的 `exports["./src/*"]` 指向**未发布**的目录（files 只有 lib + cordis.patch.yml）——死映射，可删或改为指向 lib 的对应物。

---

## 附录 A：全量机械度量（108 个模块）

> 列义：**导出**＝模块 interface 的宽度（符号数）；**具名消费**＝被其他文件以 `import { … }` 真名导入的导出数；**仅出现**＝在他处出现但未被具名导入（签名/注释）；**零引用**＝本文件之外**任何位置**都不出现；**实现行数 / 分支令牌 / 函数数**＝implementation 的体量代理。
> 判定按删除测试协议：零引用高 + 消费低 = 收窄候选；具名消费高 = 真 interface。

| 模块 | 导出 | 具名消费 | 仅出现 | 零引用 | 消费者 | src | test | 实现行数 | 分支令牌 | 函数数 |
|---|---|---|---|---|---|---|---|---|---|---|
| `src/memory/compaction.ts` | 58 | 20 | 5 | 33 | 1 | 0 | 1 | 1226 | 194 | 34 |
| `src/workflow/budget.ts` | 35 | 14 | 0 | 21 | 3 | 2 | 1 | 884 | 88 | 8 |
| `src/workflow/phases.ts` | 36 | 18 | 0 | 18 | 9 | 7 | 2 | 817 | 55 | 15 |
| `src/compose.ts` | 27 | 8 | 1 | 18 | 4 | 1 | 3 | 2043 | 233 | 63 |
| `src/memory/chunks.ts` | 39 | 19 | 3 | 17 | 16 | 9 | 7 | 956 | 202 | 30 |
| `src/workflow/lease.ts` | 37 | 21 | 1 | 15 | 13 | 8 | 5 | 743 | 110 | 25 |
| `src/execution/admission.ts` | 40 | 23 | 5 | 12 | 2 | 1 | 1 | 888 | 65 | 8 |
| `src/memory/retrieval.ts` | 37 | 19 | 6 | 12 | 7 | 4 | 3 | 663 | 132 | 19 |
| `src/contracts.ts` | 189 | 176 | 3 | 10 | 121 | 80 | 41 | 2343 | 103 | 2 |
| `src/policy/scope.ts` | 26 | 17 | 0 | 9 | 5 | 4 | 1 | 1515 | 423 | 52 |
| `src/memory/outbox.ts` | 24 | 11 | 4 | 9 | 11 | 5 | 6 | 782 | 90 | 19 |
| `src/memory/ledger.ts` | 26 | 12 | 6 | 8 | 41 | 21 | 20 | 912 | 118 | 12 |
| `src/workflow/handoff.ts` | 21 | 13 | 0 | 8 | 3 | 1 | 2 | 414 | 46 | 13 |
| `src/client/views/SkillLibrary.tsx` | 19 | 11 | 0 | 8 | 3 | 2 | 1 | 604 | 70 | 22 |
| `src/console/rpc.ts` | 18 | 10 | 0 | 8 | 18 | 6 | 12 | 1990 | 185 | 26 |
| `src/client/design.ts` | 14 | 6 | 0 | 8 | 3 | 2 | 1 | 255 | 6 | 6 |
| `src/client/views/MemoryExplorer.tsx` | 24 | 17 | 0 | 7 | 3 | 2 | 1 | 913 | 116 | 39 |
| `src/report/pg-report.ts` | 16 | 9 | 0 | 7 | 3 | 1 | 2 | 1362 | 151 | 36 |
| `src/db/migrate.ts` | 18 | 12 | 0 | 6 | 4 | 1 | 1 | 398 | 74 | 15 |
| `src/memory/embedding.ts` | 18 | 9 | 3 | 6 | 5 | 2 | 3 | 773 | 92 | 14 |
| `src/client/session-chat.ts` | 14 | 7 | 1 | 6 | 5 | 4 | 1 | 647 | 123 | 16 |
| `src/client/timeline.ts` | 11 | 5 | 0 | 6 | 4 | 3 | 1 | 266 | 55 | 10 |
| `src/client/views/IntakePrompt.tsx` | 20 | 13 | 2 | 5 | 4 | 2 | 2 | 1125 | 186 | 52 |
| `src/policy/behavior-profile.ts` | 18 | 11 | 2 | 5 | 10 | 7 | 3 | 598 | 187 | 27 |
| `src/execution/templates.ts` | 16 | 11 | 0 | 5 | 9 | 4 | 5 | 525 | 108 | 11 |
| `src/workflow/transition-table.ts` | 15 | 10 | 0 | 5 | 6 | 5 | 1 | 406 | 29 | 4 |
| `src/client/views/ReportExport.tsx` | 14 | 8 | 1 | 5 | 3 | 2 | 1 | 432 | 55 | 12 |
| `src/client/views/ReportReview.tsx` | 14 | 9 | 0 | 5 | 3 | 2 | 1 | 632 | 87 | 21 |
| `src/tools/guard.ts` | 12 | 6 | 1 | 5 | 2 | 1 | 1 | 249 | 14 | 8 |
| `src/workflow/model.ts` | 33 | 29 | 0 | 4 | 14 | 10 | 4 | 565 | 71 | 21 |
| `src/memory/hash.ts` | 16 | 11 | 1 | 4 | 6 | 4 | 2 | 428 | 66 | 14 |
| `src/workflow/reconcile.ts` | 15 | 11 | 0 | 4 | 4 | 3 | 1 | 366 | 19 | 6 |
| `src/memory/indexer.ts` | 11 | 7 | 0 | 4 | 5 | 2 | 3 | 1003 | 115 | 13 |
| `src/execution/egress-allowlist.ts` | 10 | 5 | 1 | 4 | 2 | 1 | 1 | 490 | 92 | 18 |
| `src/client/views/ScopeManager.tsx` | 9 | 5 | 0 | 4 | 2 | 1 | 1 | 511 | 53 | 16 |
| `src/workflow/recovery.ts` | 7 | 3 | 0 | 4 | 2 | 1 | 1 | 577 | 35 | 2 |
| `src/client/surfaces.tsx` | 10 | 7 | 0 | 3 | 2 | 1 | 1 | 373 | 43 | 15 |
| `src/client/views/ApprovalQueue.tsx` | 9 | 6 | 0 | 3 | 3 | 2 | 1 | 772 | 92 | 26 |
| `src/memory/dispatcher.ts` | 9 | 6 | 0 | 3 | 5 | 2 | 3 | 451 | 48 | 0 |
| `src/client/views/RunControls.tsx` | 7 | 4 | 0 | 3 | 2 | 1 | 1 | 508 | 88 | 34 |
| `src/client/views/EngagementWizard.tsx` | 4 | 1 | 0 | 3 | 2 | 1 | 1 | 1278 | 172 | 83 |
| `src/client/views/HandoffEditor.tsx` | 4 | 1 | 0 | 3 | 3 | 2 | 1 | 468 | 58 | 27 |
| `src/client/index.ts` | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 1370 | 138 | 73 |
| `src/execution/docker-sandbox.ts` | 15 | 13 | 0 | 2 | 5 | 2 | 3 | 539 | 49 | 17 |
| `src/memory/session-context.ts` | 11 | 7 | 2 | 2 | 2 | 2 | 0 | 434 | 36 | 13 |
| `src/memory/notify-listener.ts` | 9 | 7 | 0 | 2 | 3 | 2 | 1 | 532 | 45 | 20 |
| `src/tools/worker.ts` | 9 | 7 | 0 | 2 | 7 | 3 | 4 | 876 | 39 | 7 |
| `src/workflow/heartbeat.ts` | 7 | 5 | 0 | 2 | 2 | 1 | 1 | 387 | 50 | 5 |
| `src/memory/scheduler.ts` | 6 | 4 | 0 | 2 | 4 | 2 | 2 | 233 | 28 | 3 |
| `src/policy/scope-snapshot.ts` | 5 | 3 | 0 | 2 | 7 | 5 | 2 | 148 | 17 | 9 |
| `src/skills/pg-skill.ts` | 5 | 3 | 0 | 2 | 4 | 1 | 2 | 601 | 68 | 12 |
| `src/client/views/EngagementList.tsx` | 4 | 2 | 0 | 2 | 2 | 1 | 1 | 428 | 63 | 26 |
| `src/console/typert-face.ts` | 4 | 2 | 0 | 2 | 2 | 1 | 1 | 817 | 2 | 0 |
| `src/memory/pg-memory-query.ts` | 4 | 2 | 0 | 2 | 2 | 1 | 1 | 979 | 85 | 12 |
| `src/workflow/pg-lease.ts` | 3 | 1 | 0 | 2 | 5 | 1 | 4 | 499 | 56 | 9 |
| `src/execution/service.ts` | 19 | 16 | 2 | 1 | 10 | 7 | 3 | 1405 | 171 | 17 |
| `src/index.ts` | 12 | 8 | 3 | 1 | 3 | 0 | 3 | 882 | 181 | 28 |
| `src/client/phase-track.ts` | 7 | 5 | 1 | 1 | 2 | 1 | 1 | 260 | 43 | 9 |
| `src/execution/idempotency.ts` | 6 | 5 | 0 | 1 | 8 | 4 | 4 | 131 | 7 | 6 |
| `src/client/controller.ts` | 5 | 4 | 0 | 1 | 33 | 20 | 13 | 1023 | 91 | 13 |
| `src/policy/pg-policy.ts` | 5 | 4 | 0 | 1 | 6 | 4 | 2 | 1058 | 155 | 24 |
| `src/skills/skill-pack.ts` | 5 | 3 | 1 | 1 | 5 | 2 | 1 | 130 | 30 | 4 |
| `src/client/views/GateList.tsx` | 4 | 2 | 1 | 1 | 6 | 5 | 1 | 95 | 9 | 2 |
| `src/client/views/PublicMemoryPanel.tsx` | 4 | 3 | 0 | 1 | 2 | 1 | 1 | 232 | 30 | 9 |
| `src/execution/gate-failures.ts` | 4 | 1 | 2 | 1 | 1 | 1 | 0 | 144 | 7 | 2 |
| `src/memory/pg-worker-tools.ts` | 4 | 3 | 0 | 1 | 4 | 1 | 3 | 1848 | 193 | 15 |
| `src/client/views/HandoffPanel.tsx` | 3 | 2 | 0 | 1 | 2 | 1 | 1 | 199 | 34 | 11 |
| `src/policy/behavior-prompts.ts` | 3 | 2 | 0 | 1 | 3 | 2 | 1 | 112 | 12 | 1 |
| `src/client/advance-phase.ts` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 78 | 24 | 3 |
| `src/client/views/AgentTrace.tsx` | 2 | 1 | 0 | 1 | 1 | 1 | 0 | 157 | 17 | 11 |
| `src/client/views/DiagnosticsCard.tsx` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 123 | 20 | 2 |
| `src/client/views/PhaseTrack.tsx` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 221 | 32 | 8 |
| `src/client/views/RunHeader.tsx` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 175 | 34 | 3 |
| `src/client/views/SessionChat.tsx` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 811 | 131 | 45 |
| `src/client/views/SessionTimeline.tsx` | 2 | 1 | 0 | 1 | 2 | 1 | 1 | 243 | 38 | 10 |
| `src/client/format.ts` | 14 | 14 | 0 | 0 | 21 | 20 | 1 | 212 | 41 | 15 |
| `src/client/ui.tsx` | 12 | 12 | 0 | 0 | 22 | 22 | 0 | 223 | 31 | 14 |
| `src/console/client.ts` | 10 | 10 | 0 | 0 | 3 | 2 | 1 | 368 | 31 | 8 |
| `src/workflow/session-port.ts` | 6 | 6 | 0 | 0 | 7 | 4 | 3 | 205 | 17 | 1 |
| `src/client/panels.ts` | 5 | 5 | 0 | 0 | 2 | 1 | 1 | 405 | 25 | 10 |
| `src/console/method-names.ts` | 5 | 5 | 0 | 0 | 11 | 6 | 4 | 106 | 0 | 1 |
| `src/client/presets.ts` | 4 | 4 | 0 | 0 | 5 | 5 | 0 | 50 | 0 | 0 |
| `src/client/views/ConsoleShell.tsx` | 4 | 4 | 0 | 0 | 3 | 2 | 1 | 312 | 67 | 6 |
| `src/client/fontAssets.ts` | 3 | 3 | 0 | 0 | 2 | 1 | 1 | 16 | 0 | 0 |
| `src/memory/index-enqueue.ts` | 3 | 3 | 0 | 0 | 4 | 1 | 3 | 71 | 2 | 1 |
| `src/agents/dsh-session-factory.ts` | 2 | 1 | 1 | 0 | 2 | 1 | 1 | 721 | 67 | 10 |
| `src/client/hooks.ts` | 2 | 2 | 0 | 0 | 2 | 2 | 0 | 65 | 4 | 6 |
| `src/client/log.ts` | 2 | 2 | 0 | 0 | 2 | 2 | 0 | 27 | 7 | 2 |
| `src/client/styles/tokens.ts` | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 29 | 0 | 0 |
| `src/client/styles.ts` | 2 | 2 | 0 | 0 | 2 | 1 | 1 | 52 | 2 | 2 |
| `src/console/diagnostics.ts` | 2 | 2 | 0 | 0 | 2 | 1 | 1 | 80 | 9 | 1 |
| `src/workflow/handoff-flow.ts` | 2 | 2 | 0 | 0 | 2 | 1 | 1 | 663 | 53 | 6 |
| `src/workflow/sessions.ts` | 2 | 2 | 0 | 0 | 2 | 1 | 1 | 644 | 36 | 7 |
| `src/canonical.ts` | 1 | 1 | 0 | 0 | 2 | 2 | 0 | 49 | 6 | 2 |
| `src/client/panel-jump.ts` | 1 | 1 | 0 | 0 | 2 | 1 | 1 | 46 | 6 | 1 |
| `src/client/styles/base.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 55 | 0 | 0 |
| `src/client/styles/chat.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 138 | 0 | 0 |
| `src/client/styles/index.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 18 | 0 | 0 |
| `src/client/styles/panels.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 330 | 0 | 0 |
| `src/client/styles/shell.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 276 | 0 | 0 |
| `src/execution/pg-store.ts` | 1 | 1 | 0 | 0 | 3 | 1 | 2 | 571 | 48 | 4 |
| `src/workflow/approvals.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 123 | 8 | 1 |
| `src/workflow/core.ts` | 1 | 1 | 0 | 0 | 8 | 8 | 0 | 1524 | 185 | 7 |
| `src/workflow/engagement.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 1135 | 121 | 9 |
| `src/workflow/intake.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 1026 | 83 | 5 |
| `src/workflow/pg-workflow.ts` | 1 | 1 | 0 | 0 | 2 | 1 | 1 | 423 | 1 | 0 |
| `src/workflow/report.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 208 | 9 | 3 |
| `src/workflow/scope.ts` | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 255 | 17 | 1 |

## 附录 B：方法与可复现性（含一次自我纠错）

1. **机械度量脚本**：单遍词法扫描（导出解析 / 具名导入归因 / 消费者矩阵 / 分支令牌）。**纠错记录**：首版导出解析要求 export 与声明同行，漏计本仓惯例 export+jsdoc+声明（model.ts 33 → 误计 16）；被契约面切片驳回后修正并全量重跑（导出总量 1257 → 1277）。切片同时驳回了「零消费者」的初版口径（初版工具在多条 import 语句指向同一目标时放弃归因，导致高估），现口径为「具名消费 / 仅现 / 零引用」三分，且**零引用是保守下界**（注释与字符串中的同名出现也算「出现」）。
2. **declaration-emit 实测**（决定收窄建议是否成立的先决条件）：离仓 scratch 目录 + 本仓 TypeScript 5.7，非导出 interface 出现在导出函数签名中 → tsc --declaration --emitDeclarationOnly **退出码 0**，产物以非导出形式包含该类型（interface Hidden 保留、export declare function make(): Hidden、export {}）。
3. **发布面实测**：npm pack --dry-run → 159 文件 / 1.1 MB（含陈旧产物 lib/agents/capability.js 与 lib/types/agents/capability.d.ts）；grep 确认无产物 import 该模块。
4. **切片与复核**：四路只读切片共 19 分钟；本报告对其 12 条关键结论做了独立复核（DbClient 的 11 个 type-only 消费者、LivenessMonitor 零生产调用、assertLeaseValid 零调用与 admission.ts:135 重复、ReconciliationSource 零实现、enrichContextRefs 零引用、policy_versions 四处 INSERT、pg-workflow 39 处委托、format 词汇表措辞差异、buildRunControls 5 行转发、HostDomNodeLike/HostDomRootLike/TYPE_SCALE/SPACE 零引用、styles.ts 的 PENTEST_CSS 再导出零消费者）。**两处驳回成立并已修正**（见第 1 条）。
5. **未做**：未执行任何删除/重构；未跑 build/lint/test（本任务不涉及运行时行为）；lib/ 为构建产物，未纳入模块统计。

---

## 附录 C：反证核实与修正（第二轮，2026-10-05 晚）

> 目的：**在动手删除之前，专门去找「我可能漏掉的消费者」**。四条反证路线：
> ① **引用面**：把候选符号在全仓**所有文件类型**（yml / json / md / Dockerfile / sql / mjs / sh）+ **仓外**（`../deepseek-harness/dsh-pentest.patch.yml`、`~/.dsh/profiles/pentest/cordis.patch.yml`）扫一遍；
> ② **动态面**：字符串表 / `ctx.get('…')` / `Object.entries` / `Reflect` / 动态 `import()` / 装饰器按名反射；
> ③ **契约面**：设计文档（spec）是否把该符号/能力当承诺；
> ④ **级联面**：删掉它会让**别的**符号失去唯一消费者吗。

### C.1 修正表（supersedes §2 / §3 / §5 的对应条目）

| 原建议 | 反证结果 | **修正后结论** |
|---|---|---|
| A-2 删除 `LivenessMonitor` 簇 + `createLiveness`（原判「强（删除）」） | 设计文档 **§10.5 明文要求进度活性**（doc:3529「运行时要求周期性检查点，并观察若干健康信号」、doc:4373 验收「健康信号不触发自动终止」、doc:4712 待办含「预算与进度活性检测（§10.5）」）；doc:3750 的配置示例有 `liveness:` 段，而**代码里没有这个配置键**；`createLiveness` 是 `ComposedPlugin` 成员（内部接口，宿主拿不到，见 C.2） | **撤回「删除」**。这是与 `compaction.ts` 同类的**「已实现、未接线」**：应先决策「接线」或「显式降级（改 spec + ADR）」。**不要把它当死代码删掉。** |
| A-5 删除 `enrichContextRefs` | doc:1670 要求交接 UI「显示每条引用的摘要、**来源**、所属阶段、资产和证据关系」，doc:1683 要求「增加或替换上下文引用」；该函数正是「把 chunk 的 `classification/trust_level/provisional` 补回引用」的纯函数，且注释写了不变量（不猜、不填默认值）；`ContextChunkMeta` 只出现在它的签名里；活路径（`handoff-flow` / `rpc` 读端点）未发现等价的 kind/trust 填充 | **降级为「疑似未接线能力」**：先确认控制台交接视图是否真的显示来源/可信度——若显示，则本函数是缺接口；若不显示，则是未接线特性。**需人工判断后再决定**。 |
| A-8 删除 `TYPE_SCALE` / `SPACE` / `relativeLuminance` 的导出 | 外部零引用确认（我直接复核：门禁脚本只按文本抓 `--pt-*` 令牌与色板，**不读**这三个符号；切片报告中「被门禁脚本文本读取」的措辞不适用于它们）；但 `design.ts:104/114` 的注释**明确写着**「样式里直接写数字以免多一层计算」——零消费是**刻意的** | **降级为「保留（或被门禁消费）」**：它们是设计系统的事实记录（字号阶/间距阶）。若坚持收窄，只删 `export` 关键字、保留常量与文档，风险才真正为零。 |
| A-10 删除 contracts 的 4 个「真死」导出 | ① `HandoffDraftRequest` / `HandoffEdit`：**design.md 命中两处**——doc:4162 `editHandoff(input: HandoffEdit): Promise<HandoffRevision>`、doc:4198 其 UPDATE 列语义。它们是 **§16 明文端点的签名残留**；② `CONSOLE_ONLY_PHASES`：`Phase` 类型联合已排除 `pre-engagement`/`reporting`（contracts.ts:20-28），**规则由类型保证**，常量只是把 PTES 分区写进代码；③ `advancesIteration`：规则在活跃校验里重复实现（`transition-table.ts:229` 硬编码 `key === 'loop'`） | **拆分为**：`advancesIteration` —— **确认可删**（或改用单源）；`CONSOLE_ONLY_PHASES` —— **保留**（文档性词汇表，删了不省事）；`HandoffDraftRequest`/`HandoffEdit` —— **撤回删除**，改为「与 §16 端点清单对账：补端点，或在契约中显式标注未实现并同步 spec」。 |
| A-3 删除 `lease.ts` 准入簇 | 生产路径 `admission.ts:135 leaseViolation` 覆盖 terminal / null / revoked / expired **以及世代校验**（:166，调用点 :821 传 `state.plan.leaseGeneration`），与未使用簇的判定语义等价或更强；`LEASE_REQUIRED_OPERATIONS` 清单**不参与生产判定**（生产对无租约会话无条件 `lease_required`，更严）；文档未把「租约必需操作清单」当契约 | **确认删除**，但必须**连带处理级联**（见 C.3）：`LeaseRequiredOperation`、`LEASE_REQUIRED_OPERATIONS` 会变成新孤儿；`test/lease.test.ts` 需同步改。 |
| A-11 构建产物清理 | `lib/agents/capability.js` + `lib/types/agents/capability.d.ts` 零引用（连 `lib/` 内部也没有），但经 `files:["lib"]` 进 npm 包、经 `docker/Dockerfile:100-101`（`COPY lib ./lib`）**进 Docker 镜像**；`RUNBOOK.md` **没有发布/打包章节**（只有「改完 src 必须 npm run build」），`package.json` 无 `clean` 脚本 | **确认并强化**：加 `clean` 到 build 前置；顺带删 `package.json:18` 的死映射 `exports["./src/*"]`（指向未发布目录）；清理两处引用已删除模块的注释（`src/canonical.ts`、`src/workflow/session-port.ts` 提到 `capability.ts`）。 |

### C.2 外部消费者：可静态排除（证据）

- 包入口 `package.json exports["."] → lib/index.js`（源自 `src/index.ts`）对外只暴露 `name / inject / apply / applyPentest / PENTEST_HOST_SERVICES(= 'pentestHostServices')` 等；**宿主拿到的是 `hostServices = { workerTools, consoleRpc }`**（`index.ts:561` 的 `config.onComposed?.(composed.hostServices)`），`compose()` 的 `ComposedPlugin`（含 `createLiveness` / `reconcile` / `outbox` / `heartbeat` …）**只在本插件内部流转**。
- 运行时的按名契约是**控制台端点面**：`CONSOLE_METHOD_NAMES`（54 项字符串清单）↔ `rpc.ts` 的 `METHOD_TABLE`（`call('face','method')` 描述符）↔ `typert-face.ts` 的 `@Remote` 方法 ↔ `scripts/verify-typert-face.ts` 的源码正则比对（进 `npm run verify` 链）。**A/B 组候选符号在这张反射表里零命中**（唯二的 `this.name` 自标识是错误类自身）。
- 仓外检查：`C:/Projects/Agent-projects/deepseek-harness/dsh-pentest.patch.yml` 与 `~/.dsh/profiles/pentest/cordis.patch.yml` 均只有 `id: pentest` + 配置数据键，**无任何内部符号依赖**。
- 唯一理论窄路径：`exports["./src/*"]` 深导入（未发布 + 无消费者）——建议直接删掉该映射。

### C.3 级联清单（删除前必须一起处理，否则「删了 A 孤立 B」）

| 若删除 | 将失去唯一消费者的他处符号 | 需要同步改的测试 |
|---|---|---|
| `lease.ts` 准入簇（`assertLeaseValid` / `validateLeaseForOperation` / `rejectionForLeaseState` / `LeaseAdmissionOptions` / `LeaseProtocolError` 等） | `LeaseRequiredOperation`（contracts.ts）、`LEASE_REQUIRED_OPERATIONS`（contracts.ts，仅剩 `test/lease.test.ts:264` 引用） | `test/lease.test.ts`（:25 的 import、:264-266、:271 相关断言） |
| `budget.ts` 的 LivenessMonitor 簇（`LivenessMonitor` / `LivenessMonitorInput` / `HealthSignal` / `HealthSignalKind` / `HEALTH_SIGNAL_KINDS` / `LivenessAction` / `LIVENESS_ACTIONS` / `LivenessSnapshot` / `DEFAULT_CONTEXT_PRESSURE_SECONDS` / `BudgetPauseRequest`…） | `compose.ts` 的 `createLiveness` + `ComposedPlugin.createLiveness` 成员（**改契约前先做 §10.5 决策**） | `test/budget.test.ts`、`test/compose.test.ts:584-586` |
| `reconcile.ts` 的 `ReconciliationSource` | 无（零实现、零引用） | 无 |
| `handoff.ts` 的 `enrichContextRefs`（若最终决定删） | `ContextChunkMeta`（handoff.ts，仅出现在该签名） | 无（测试未引用） |
| `client/styles/index.ts` | 无（装配 3 行搬入 `styles.ts`；`PENTEST_CSS` 由 `test/client-surfaces.test.ts:26` 从 `styles.ts` 导入，**合并后无需改测试**；`verify-style-coverage` 按目录遍历 + 单列 `styles.ts`，合并后覆盖不变；“CSS 模板不得含反引号”的检查只覆盖 `styles/` 目录，而 CSS 正文仍在其中，不受影响） | 无 |

### C.4 残余风险（无法静态排除的部分）

1. **`lib/types/**` 的对外类型面**：非导出化（A 组的第 23 条建议）会改变发布包的 `.d.ts` 可达名字。已实测 `tsc --declaration` 合法，且**仓内与仓外（harness/profile）都无命名依赖**；但若有第三方按 `dsh-pentest/lib/types/...` 名字导入类型，会在编译期报「无法命名」。缓解：把「非导出化」按**次要版本**发布并在 CHANGELOG 记录；或先只做「删真死符号」，把「非导出化」留到下次合并窗口。
2. **`SPACE` 这类泛名的误报**：本轮的「零引用」判定对 `SPACE` 用了人工排除（只认 `design.ts` 语义相关命中）；这类名字的结论比其余符号弱一档。
3. **测试承载的契约**：`test/lease.test.ts`、`test/budget.test.ts`、`test/compose.test.ts` 直接断言了部分「未接线」件（如 `liveness.observe/checkpoint` 的形状）。**删测试 = 删掉能力存在过的唯一证据**——这也是 A-2/A-5 必须先决策再动手的原因。

### C.5 修订后的行动清单（第二轮版本；**已被附录 E.5 取代**）

**可以立即做（证据充分、行为不变）**
1. `client/styles/index.ts` 合并进 `styles.ts`（+ `styles/tokens.ts` 的 3 行 glue）。
2. `client/panels.ts` 的 `buildRunControls`（5 行转发）——唯一调用点 `index.ts:781`。
3. `client/surfaces.tsx` 的 `HostDomNodeLike` / `HostDomRootLike`（官方 `ask_user_question` 路线已取代 DOM 探测，doc:1283）。
4. `memory/ledger.ts:57` 的 `LedgerError` re-export（两处测试都从 `hash.ts` 导入）。
5. `contracts.ts` 的 `advancesIteration`（规则由 `transition-table.ts:229` 的活跃校验承担；建议改用单源而非删除）。
6. `db/migrate.ts:97` 的 `CountRow`（连本文件都未使用）。
7. **构建清洁**（⚠️ 附录 E.2 修正：`exports["./src/*"]` 属 dev 源码加载口子，**暂缓删除**）：`clean` 前置 + 清理两处提到已删除模块的 `capability.ts` 注释（陈旧产物同时进 npm 包与 Docker 镜像）。
8. `lease.ts` 准入簇 + 级联的 `LeaseRequiredOperation` / `LEASE_REQUIRED_OPERATIONS`（同步改 `test/lease.test.ts`）。

**先决策、后动手（不要先删）**
9. `LivenessMonitor` / `createLiveness`（§10.5）：接线 or 显式降级（改 spec + ADR + 删测试）。
10. `memory/compaction.ts`（§8.10）：同上。
11. `enrichContextRefs`（交接引用来源/可信度）：先确认控制台是否显示该信息。
12. `HandoffDraftRequest` / `HandoffEdit`（§16 端点签名）：补端点 or 在 spec 里标注未实现。
13. `CONSOLE_ONLY_PHASES`：保留（或让某个校验显式使用）。
14. `TYPE_SCALE` / `SPACE` / `relativeLuminance`：保留（设计系统事实）；如要收窄，仅去 `export`。

**方法论修正（写进流程）**
15. 删除建议的**前置条件**从「零引用」升级为「零引用 **+ 无 spec 承诺** + 级联已列 + 测试承载已确认」。本轮 11 项「立即删除」中，**3 项因 spec 承诺被撤回或降级**（LivenessMonitor、HandoffEdit/HandoffDraftRequest、enrichContextRefs），**2 项因「刻意零消费」被降级**（TYPE_SCALE/SPACE、CONSOLE_ONLY_PHASES）。

---

## 附录 D：第三轮复核（数字修正 · 簇边界定界 · 新发现）

> 主题：**再查一遍我自己的数字与结论**。本轮不以「找新候选」为目标，而是验证「上一轮确认要删的东西，删的到底是哪几行、会不会连累在用代码」，并重算受解析器缺陷影响的统计。

### D.1 统计修正（影响 §1 概览与附录 A 的「具名消费」列）

| 统计 | 旧口径 | **修正后** | 原因 |
|---|---|---|---|
| 具名消费 | 569 | **838** | 旧归因规则在「同一目标出现多条 import 语句」时**整组放弃归因**，系统性低估 |
| 仅在他处出现（签名/注释） | 328 | **59** | 差额是被漏计的具名消费 |
| 仓库内零引用 | 380（29.8%） | **380（29.8%）**（不变） | 零引用来自标识符出现性，不依赖归因规则 |
| 零引用中 type/interface 占比 | 75% | **74.2%**（282/380） | 用 v4 解析器重算；实质不变 |

受影响的具体行（示例，附录 A 已按新口径给出）：`compose.ts` 具名消费 1 → **8**（我人工审计的真实值 9）、`client/format.ts` 12 → **14**（14 个导出**全部**被具名消费）、`workflow/budget.ts` 1 → **14**、`client/panel-jump.ts` 1 → 1（不变）。
**方向性说明（仍保守）**：`具名消费` 还是**下界**（`export { X } from '…'` 形式的再导出不计入消费者）；`零引用` 仍是**上界安全侧**（注释/字符串里出现同名即算「出现过」，因此真实零引用只会 ≥ 380）。

### D.2 簇边界精确定界（回答「到底删哪几行」）

| 簇 | **可删集合（精确）** | **必须保留的相邻件（本轮复核发现）** |
|---|---|---|
| `lease.ts` 准入簇 | `assertLeaseValid`(265)、`validateLeaseForOperation`(722)、`isLeaseRequiredOperation`(189)、专属类型（`LeaseAdmissionOptions`/`LeaseAdmissionInput`/`LeaseResult`/`LeaseViolationContext`）——合计约 **60-80 行 + 2-4 个导出** | ⚠️ **`resolveGenerationAdmission`(301) 被在用的 `renewLease` 调用于 :546**；`rejectionForLeaseState`(230) 是它的助手（:310/:324）；`describeLease`(42) 在 :246/:252/:605 在用；`LeaseProtocolError`(59) 被 `pg-lease.ts` 导入。**上轮把它们列进级联表是错的，已撤回** |
| `budget.ts` 活性簇 | **连续块 580-884**：`HEALTH_SIGNAL_KINDS`(580) → `HealthSignalKind`/`LivenessAction`/`HealthSignal`/`LivenessSnapshot`/`LivenessMonitorInput`/`LivenessMonitor`(662) + 私有 `positive`(880) | `BudgetPauseRequest`(171) 属 `BudgetReading`(192)→`projectionOf`(566) 的计量面，**保留**；`BudgetMeter` 段（211-565）与活性段零交叉（已核） |
| `handoff.ts` | `enrichContextRefs`(77) + `ContextChunkMeta`(64)（后者**仅**出现在前者签名） | 其余导出被 `handoff-flow` 与测试消费 |
| `reconcile.ts` | `ReconciliationSource`(308)（零实现、零引用） | 其余被 compose / admission / recovery 消费 |
| `client/surfaces.tsx` | `HostDomNodeLike`(273) / `HostDomRootLike`(278) | 连本文件内都无使用（已核） |
| `client/panels.ts` | `buildRunControls`(265) | 唯一调用点 `index.ts:781`；**无任何测试引用**（已核） |
| `client/styles/index.ts` + `styles/tokens.ts` | 全部（18 + 28 行） | `PENTEST_CSS` 由 `test/client-surfaces.test.ts:26` 经 `styles.ts` 导入 → 合并后**无需改测试**；样式门禁按目录遍历 + 单列 `styles.ts` |

### D.3 逐消费者导入矩阵（源证据，`imports-matrix` 输出）

```
═══ src/workflow/lease.ts ═══   （消费者 13 = 8 src + 5 test）
  src/workflow/core.ts: applySessionStatusChange
  src/workflow/handoff-flow.ts: issueLease, revokeLease
  src/workflow/heartbeat.ts: ExpiredLeaseRef, LeaseStore, expireLeases, renewLease
  src/workflow/intake.ts: issueLease, revokeLease
  src/workflow/model.ts: LeaseStore
  src/workflow/pg-lease.ts: LeaseLifecycleEvent, LeaseProtocolError, isLeaseRevocationReason,
                            ExpiredLeaseRef, LeaseStore, LeaseTransactionScope, LeaseTx,
                            NewLeaseRow, RevokeActiveLeasesInput, WorkerSessionRow
  src/workflow/recovery.ts: LeaseStore, revokeLease
  src/workflow/sessions.ts: issueLease, reissueLease, revokeLease

═══ src/workflow/budget.ts ═══  （消费者 3）
  src/compose.ts: BudgetMeter, LivenessMonitor, projectionOf, DshBudgetPort
  src/index.ts: DshBudgetPort
  test/budget.test.ts: （13 个符号，含 LivenessMonitor 与活性常量）

═══ src/workflow/handoff.ts ═══ （消费者 3）
  src/workflow/handoff-flow.ts: capContextRefs, computeDraftHash, computeHandoffHash, validateHandoff
  test/*: （14 个符号；**无 enrichContextRefs**）

═══ src/workflow/reconcile.ts ═══（消费者 4）
  src/compose.ts: collectReconciliationInputs, reconcileEngagement, SessionReconciliationInput, EngagementReconciliation
  src/execution/admission.ts: executionGateForAudit
  src/workflow/recovery.ts: SessionReconciliationInput, SessionReconciliation, reconcileSession, isHighRiskPhase
  test/reconcile.test.ts: （9 个符号）
```

### D.4 本轮新发现

1. **第三处「未接线断言」**：`assertGraph`（`phases.ts:782`）注释自称「启动自检」，但 **src 内除定义外无任何调用**（仅 `test/phases.test.ts:629/751`）。即状态图合法性（含「只有回环递增迭代」）在**运行期没有被校验**，只有测试期校验。
2. `CountRow`（`db/migrate.ts:97`）：**全仓唯一出现即声明**（连本文件都不使用）→ 确认可删。
3. `LeaseProtocolError` 被 `pg-lease.ts` 导入 → **撤回**附录 C.3 把它列入级联的写法。
4. 上轮「确认删除」的 lease 项**收益被高估**：真实可删集合只有 2 个入口函数（+1 判别函数 + 专属类型），约 60-80 行；`rejectionForLeaseState`/`resolveGenerationAdmission`/`describeLease`/`LeaseProtocolError` 全部保留。

### D.5 结论变更汇总（三轮累计；**已被附录 E.5 取代**）

| 项 | 变化 |
|---|---|
| `LivenessMonitor` / `createLiveness` | 初版「强（删除）」→ **撤回**（设计文档 §10.5 承诺，未接线） |
| `HandoffEdit` / `HandoffDraftRequest` | 初版「直接删除」→ **撤回**（§16 端点签名残留，改为对账端点清单） |
| `enrichContextRefs` | 初版「直接删除」→ **降级**（doc:1670/1683 的显示/补充引用能力，疑似未接线） |
| `TYPE_SCALE` / `SPACE` | 初版「删」→ **降级为保留**（注释说明零消费是刻意的） |
| `CONSOLE_ONLY_PHASES` | 初版「删」→ **降级为保留**（规则已由 `Phase` 类型保证） |
| `lease.ts` 准入簇 | 第二轮「确认删除 + 5 项级联」→ **第三轮收窄**：2 入口 + 1 判别 + 专属类型，4 个相邻件保留（`renewLease` 依赖） |
| 具名消费统计 | 569 → **838**（附录 A 全表已重算） |
| 零引用类型占比 | 75% → **74.2%** |
| `advancesIteration` 的规则承担者 | 「transition-table 的活跃校验」→ `validateGraph`（仅测试调用）+ 新发现的 `assertGraph` 未接线 |
| 新增可删项 | `CountRow`；新增待决策项：`assertGraph` 是否接入启动自检 |

**经过三轮，仍可立即执行且证据充分的删除只剩 7 项**（styles 合并 / `buildRunControls` / `HostDom*` / `LedgerError` re-export / `advancesIteration` / `CountRow` / 构建清洁），另加 1 项收窄后的删除（lease 两入口，收益 60-80 行）；其余 5 项全部转入「先决策」。

---

## 附录 E：第四轮复核（处置方式升级 · 精度修正）

> 主题：**验证「删除」之外的可能性**——本轮查的是我尚未触及的三类面：开发模式加载路径、门禁/测试对文件清单的枚举、构建与镜像链的成文核对；并复核此前从未独立验证的几条切片结论。

### E.1 处置方式升级：这 4 处不该删，应登记进项目**已有的**未接线门禁

仓库里**已经有一套「承诺接线」门禁**（`scripts/verify-promises.ts`，2026-10-05 引入，进 `npm run verify` 链），它就是为「机制已实现、被注释、被文档承诺，但没有任何运行时消费者」这一类问题建的：

- 每个承诺登记 `{ symbol, file, status: wired|pending, note, forwarders[] }`；
- `consumersOutside()` **只数 `src/` 里的调用点**（`symbol(` 形式），**去注释**、**测试不计入消费者**、`forwarders` 里的「转发者」也不算（正是 REQ-4 的两处被误判为已接线的成因）；
- `wired` + 0 调用点 = **失败（阻塞）**；`pending` + 0 = 告警；`pending` + >0 = 提示「可移出 PENDING」。

**因此本轮的四项发现（我前两轮建议「删除」或「降级」的对象）有更好的处置：登记为 `pending`**，并且 `wired` 与 `pending` 的语义差正好提供了未来的棘轮（哪天决定要接线，把 `status` 改成 `wired` 即可强制）。

建议新增的条目（字段值可直接落地）：

| symbol | file | status | forwarders | note（要点） |
|---|---|---|---|---|
| `LivenessMonitor` | `src/workflow/budget.ts` | `pending` | `['src/compose.ts']` | 设计文档 §10.5 承诺的进度活性已实现（检查点/连续工具失败/上下文压力），唯一构造点是 `compose.ts:1974` 的 `createLiveness`；doc:3750 的 `liveness:` 配置段在代码中不存在 |
| `planCompaction` | `src/memory/compaction.ts` | `pending` | `[]` | 设计文档 §8.10 的压缩算法（1226 行）仅被 `test/compaction.test.ts` 消费；其 `CompactionPayload` 正是账本 `context.compacted` 事件的预期负载 |
| `enrichContextRefs` | `src/workflow/handoff.ts` | `pending` | `[]` | doc:1670/1683 要求交接视图显示引用**来源/可信度**并允许人工补充；该函数零调用，级联 `ContextChunkMeta` |
| `assertGraph` | `src/workflow/phases.ts` | `pending` | `[]` | 注释自称「启动自检」，但 `src` 内无调用（仅 `test/phases.test.ts:629/751`）→ 状态图合法性（含「只有回环递增迭代」）运行期不校验 |

加上现有 2 项 REQ-4 pending，门禁输出将从「3 项（2 告警）」变为「7 项（6 告警，0 失败）」——**仍然通过**，且这四处未接线从此有登记、有出处、有处置方向，不会再被下一轮评审当成「死代码」误删。

> **已模拟验证**（不改仓库：把 4 条加进 `verify-promises.ts` 的临时副本、以仓库根为 cwd 运行）：输出 `7 项（6 项告警，0 项失败）`，四条新条目全部被识别为 `[待处置]`，note 原样打印。

### E.2 降级：`exports["./src/*"]` 不是死映射

`harness.dev.patch.yml:25` 用 **`name: './src/index.ts'`** 按**源码路径**加载插件（文件头解释了为什么：与生产路径 `link:` 到 `lib/` 互不干扰、可随时对比）。相对 specifier 本身不经过 `exports`，但这说明**「按源码深导入」是本仓刻意的开发能力**——`exports["./src/*"]` 很可能就是为这类用法留的口子。

修正：从「死映射，可删」→ **「确认无 dev/源码消费后再删」**。连带修正一个更重要的口径：**「外部消费者可静态排除」只对运行时与配置引用成立**（本次已扫全仓 + 仓外 harness/profile）；对 `src/**` 的深导入是设计允许的，所以**「收窄导出」优先于「删除符号」**这一取向在本仓更稳。

### E.3 精度修正（三条表述 + 两条新增）

| 项 | 我此前的表述 | 事实 |
|---|---|---|
| 反引号守卫覆盖面 | 「CSS 正文仍在 `styles/` 目录内，不受影响」 | 方向对但表述不精确：守卫的多行形态规则（`^export const X = \`$`）本就**不覆盖** `tokens.ts`——它用的是**单行内联**模板；合并**不会**造成覆盖损失。但若合并后有人在 `styles.ts` 里写多行模板，则不受守卫（`walk(stylesDir)` 不含 styles.ts）→ 建议顺手把 `styles.ts` 加入该守卫的文件集 |
| `PUBLIC_MEMORY_MAX_CHARS` 漂移 | 未收录（切片提过，我未核） | 服务端是 **`src/workflow/model.ts:23` 的私有常量 8000**（非导出）；客户端 `PublicMemoryPanel.tsx` 另有一份导出；`test/client-public-memory.test.ts:91` 断言的**是字面量 8000**、并非与服务端比对 → 漂移风险真实存在，**新增为合并建议**（服务端导出该常量，测试改为与服务端比对） |
| `docker/package.json` 的核对说明 | 引用「见 docker/README」 | **`docker/README` 不存在**（悬空引用）。我按其写的方法实跑核对：lib 的外部 import 共 6 个包（`pg`、`@deepseek-ai/dsh-session`、`dsh-tools`、`dsh-typert-protocol`、`dsh-util-values`，以及**仅出现在浏览器 bundle 的 `react`**）——清单全中；`@deepseek-ai/cordis` 声明但 lib 未 import（宿主自带）。说明文字「必须覆盖 lib/ 全部外部 import」应收窄为「覆盖 lib 的**非浏览器**产物」，否则后来者会照字面把 `react` 加进镜像清单 |
| `SessionFactory` 实现数 | 「4 个实现」 | 精确为 **2 生产（`DshSessionFactory` 真实 + `missingSessionFactory` 缺省桩）+ 2 测试替身**（`FakeSessionFactory`/`RecordingSessionFactory`）——真 seam 结论不变 |
| `RUNTIME_MARKER_TYPES` 同值双导出 | 切片提出，我未核 | **确认**：`transition-table.ts:191` 与 `phases.ts:529` 都是 `['pause','resume','abort']` |

另核实（对既有建议无影响）：`tsconfig.build.json` **排除 `src/client`**（由 `tsdown` 单独出单文件 bundle，注释说明了避免双份客户端产物）且**无 `tsbuildinfo`** → 清理 `lib/` 不影响构建正确性；`test/db.test.ts:61` 枚举的只是 `src/db/migrations` 目录（与本次删除项无关）。

### E.4 第四轮结论汇总

- **新增可删项：0。** 本轮没有发现新的「透传/浅模块」；发现的是**更好的处置方式**（E.1）。
- **降级 1 项**：`exports["./src/*"]`（E.2）。
- **新增建议 2 项**：4 处未接线登记 `pending`（E.1）；`PUBLIC_MEMORY_MAX_CHARS` 单源化（E.3）。
- **精度修正 3 项**：反引号守卫覆盖面、`docker/package.json` 说明收窄、`SessionFactory` 计数。

### E.5 最终清单（三轮复核后的权威版本，supersedes C.5 / D.5）

**A. 可立即执行（证据充分、行为不变；7 项）**
1. `client/styles/index.ts` 合并进 `styles.ts`（连带 `styles/tokens.ts`）——测试与门禁均已核实无需改动；顺手把 `styles.ts` 加入反引号守卫。
2. `client/panels.ts` 的 `buildRunControls`（唯一调用 `index.ts:781`，无测试引用）。
3. `client/surfaces.tsx` 的 `HostDomNodeLike`/`HostDomRootLike`。
4. `memory/ledger.ts:57` 的 `LedgerError` re-export。
5. `contracts.ts` 的 `advancesIteration`。
6. `db/migrate.ts:97` 的 `CountRow`。
7. **构建清洁**：`clean` 前置（`lib/` 无 tsbuildinfo，安全）+ 清两处 `capability.ts` 注释；`exports["./src/*"]` **暂缓**（见 E.2）。

**B. 收窄后执行（1 项）**
8. `lease.ts` 两入口（`assertLeaseValid` / `validateLeaseForOperation`）+ `isLeaseRequiredOperation` + 专属类型，约 60-80 行；⚠️ **保留** `resolveGenerationAdmission`（被 `renewLease` 用）、`rejectionForLeaseState`、`describeLease`、`LeaseProtocolError`。

**C. 登记（不删；4 项）**——按 E.1 加入 `verify-promises` 的 `pending`：`LivenessMonitor`、`planCompaction`、`enrichContextRefs`、`assertGraph`。

**D. 合并/单源（3 项）**
`describe` 三份副本 · `'index_event'` 三处字面量 · `RUNTIME_MARKER_TYPES` ≡ `RUNTIME_MARKER_TRANSITION_TYPES` · `PUBLIC_MEMORY_MAX_CHARS` 服务端单源（新增）。

**E. 保留（3 项）**：`TYPE_SCALE`/`SPACE`（刻意零消费）、`CONSOLE_ONLY_PHASES`（类型已保证）、`HandoffEdit`/`HandoffDraftRequest`（改为与 §16 端点清单对账）。

---

## 附录 F：第五轮复核（未读过的门禁 · 文档自带的登记 · 数字精修）

> 主题：**去读我从没读过的东西**——五道 `verify:*` 里我只看过三道；以及仓库里从未检查过的数据目录（`presets/`、`skills/`）与脚本（`embed-font.mjs`、`qa-hardening.ts`、`verify-schema.ts`）。

### F.1 口径修正：compaction 的处置应**对齐设计文档自带的登记**，而不是「接线 or 删除」

设计文档里早已有**专门的未接线登记段**：**§8.10.0「接线现状（2026-10-05 核实，未接线）」**（doc:2243-2262），它不仅记录状态，还写清了**阻塞项**与**最小接线路径**：

| 该段已写明的内容 | 要点 |
|---|---|
| 已就绪 | 压缩算法本体（1225 行）、触发参数、`worker_sessions.compacted_through_turn` 列、`chunks.ts` 的 `context.compacted` → `compaction_summary` 消费 |
| **未接（阻塞项）** | ① 缺**宿主在回合边界暴露的 effect 点**（设计明确「不在工具执行中途」；插件当前只用了 `tools/pre-execute` 一个接缝）② **无模型客户端**（摘要生成是模型调用，插件侧没有任何 `llm_calls` 写入方，必须走宿主的模型服务）③ **`SessionPort` 端口不足**（现只有 `create`/`deliver`，需追加「向会话追加带 `replace` 意图的事件」） |
| 警告 | 「四步都做完才算压缩生效——**只做 ④ 是假接线**（写摘要但不缩上下文）」 |

→ 因此**「接线」不是本仓能独立完成的事**（缺宿主能力）。修正后的处置：**登记进 `verify-promises` 为 `pending`，并在 note 里指回 §8.10.0**，而不是我前两轮写的「接线 or 记 ADR 删除」二选一。同理，本轮也确认文档没有为 §10.5（活性）与交接引用来源写这样的段落 → `LivenessMonitor` 与 `enrichContextRefs` 是**真正未被登记**的两处（登记建议见附录 E.1）。

### F.2 补记：门禁面共 6 道，聚合 `verify` 只跑 5 道

`scripts/` 下实为 **6 个**验收脚本；我此前只盘点了 5 个并被聚合命令覆盖：

| 脚本 | 聚合链 | 说明 |
|---|---|---|
| `verify-style-coverage.mjs` / `verify-promises.ts` / `verify-typert-face.ts` / `verify-client-bundle.ts` / `verify-forward-migration.ts` | ✅ 在 `npm run verify` | 前四者本报告已读；`forward-migration` 本轮读过（它从 `src/db/migrate.ts` 导入 `ensureMigrationsTable/loadMigrations/migrate/recordAppliedMigration/splitSqlStatements`——**与删除清单无交集** ✓） |
| **`verify-schema.ts`（`npm run db:verify`）** | ❌ **不在聚合链** | 前置条件：真实 PostgreSQL **含 `pgvector` + `pg_trgm`**、默认在事务内执行并回滚、目标库已有 `pentest` 对象时响亮拒绝 → 单列有其理由，但「聚合命令 = 全部门禁」的说法不成立，报告 §5 的表述按此修正 |

另：`verify-client-bundle.ts` 会在 Node VM 里 materialize `lib/client.js` 并断言 `apply` **真的注册了槽位** → 这是 A 组「styles 合并」的**行为级验证路径**（合并后跑它即可证明注入没坏）；`prebuild:client` 的 `embed-font.mjs` 只写 `src/client/fontAssets.ts`、**不触碰 `styles/tokens.ts`** → 合并安全（与附录 E.3 的结论一致）。

### F.3 数字与表述精修（三处）

| 项 | 我此前的表述 | 实测 |
|---|---|---|
| preset ↔ 代码的 `ask_user_question` 耦合 | 「双侧耦合且**无任何门禁**」 | **收回**。代码侧有 **3 个测试**断言（`test/dsh-session-factory.test.ts:353-376`、`test/open-task.test.ts:210-212`、`test/pg-workflow.test.ts:400-407`），且 `model.ts:360`（五阶段允许列表）与 `intake.ts:172` 都已含 `HUMAN_QUESTION_TOOL`；preset 侧（挂载行 `tool-ask-user`）无测试，由 `src/index.ts:596-649` 的运行时告警 + 文档保护；`REQUIRED_ECOSYSTEM_PLUGINS` 只含五个硬边界插件，不含该提问包 |
| `styles/shell.ts` 的 DOM 级消费者 | 「15+ 视图」 | 精确：**143 个类名中 91 个被引用，分布在 15 个文件**（12 个 `views/*.tsx` + `ui.tsx`/`surfaces.tsx`/`index.ts`/`design.ts`）→ 结论（保留：真实 interface 是类名词汇表）不变，数字改为「12 个视图 + 3 个 client 文件」 |
| `controller.mutate` 逃生口 | 「4 处视图调用」 | **确认 4 处**：`views/EngagementList.tsx:160`（archiveEngagement）、`:208`（purgeEngagement）、`views/RunControls.tsx:209` 与 `surfaces.tsx:298`（setApprovalMode），**全部无类型化包装** ✓ 与建议一致 |

另：`scripts/qa-hardening.ts` 读 `skills/*/SKILL.md`（`skill-pack.ts` 的 `SKILL_PACKS`/`parseSkillFile` 消费者）——解释了 `src/skills/skill-pack.ts` 的 scripts 侧消费者计数 ✓，与删除清单无交集。

### F.4 第五轮结论汇总

- **新增可删项：0**；**新增保留/登记项：0**（登记建议已在附录 E.1 给出）。
- **口径修正 1 项**：compaction 的处置改为「登记 pending + 指向 §8.10.0」（其阻塞项在宿主侧，本仓无法单独接线）。
- **补记 1 项**：门禁共 6 道、聚合只跑 5 道（`db:verify` 单列及其前置条件）。
- **数字精修 3 项**：`ask_user_question` 耦合（有测试）、`shell.ts` 消费者（91/143 类名 · 15 文件）、`mutate` 4 处（确认）。
- **仍未验证（如实登记）**：① `skills/**` 与 `presets/**` 的**内容质量**（本报告只做「代码模块」的删除测试，未评估技能库与预设文案）；② `verify:client`/`verify:forward-migration` 的**行为**未在真实浏览器/真实旧库上复跑（本轮只读了它们的前置与断言范围）；③ 表格化数据（`AGENTS.md`/`GLOSSARY.md` 不存在，术语以设计文档为准）未做逐条对账。

---

## 附录 G：执行记录（2026-10-05 晚，A 组 + C 组落地）

> 依据：附录 E.5 的权威清单（用户确认「开工」）。执行原则与复核一致——**先核对再动手**，任何一条在动手前发现反证就撤回并改为登记。

### G.1 已执行（7 项，行为不变）

| # | 项 | 实际改动 | 备注 |
|---|---|---|---|
| A1 | styles 链合并 | 删除 `src/client/styles/index.ts`（18 行）+ `styles/tokens.ts`（28 行），令牌层（`FONT_FACE_CSS`/`TOKENS_CSS`）与装配（`PENTEST_CSS`）并入 `src/client/styles.ts`；`scripts/verify-style-coverage.mjs` 的反引号守卫把 `styles.ts` 纳入扫描面 | 测试**无需改动**（`PENTEST_CSS` 仍从 `styles.ts` 导出，`test/client-surfaces.test.ts:26` 不变）；装配顺序、幂等注入、disposer 语义逐字保留 |
| A2 | 删 `buildRunControls` | `src/client/panels.ts` 删函数（5 行转发）与随之无用的 `RunControls` 导入；`src/client/index.ts:782` 直接 `createElement(RunControls, …)` | 唯一调用点 + 无测试引用（复核结论） |
| A3 | 删 `HostDomNodeLike`/`HostDomRootLike` | `src/client/surfaces.tsx` 删两类型（9 行） | 已被官方 `ask_user_question` 通道取代（doc:1283） |
| A4 | 删 `LedgerError` re-export | `src/memory/ledger.ts` 删一行 `export { LedgerError } from './hash.ts'` | 类本体保留（本文件仍在 throw 它） |
| A5 | `advancesIteration` **单源化**（不是删除） | `src/workflow/transition-table.ts` 的校验器改为 `advances !== advancesIteration(row.type)`（原为硬编码 `key === 'loop'`）；`src/contracts.ts` 的 jsdoc 标注它是规则单源 | 比删除更好：规则留在契约层，校验器消费它 |
| A6 | 删 `CountRow` | `src/db/migrate.ts` 删 4 行（连本文件都未使用） |  |
| A7 | 构建清洁 | `package.json` 新增 `clean` 脚本，`build` 改为 `clean && build:host && build:client`；清理两处引用已删除模块的注释（`src/canonical.ts` 标注 `capability.ts` 已删除；`src/workflow/session-port.ts` 的过时「与 `CapabilitySnapshot` 对齐」改为指向 `workflow/model.ts` 的 `ResolvedCapabilities`） | `lib/agents/capability.*` 与 `lib/types/agents/capability.d.ts` 随首次 `clean` 消失（见 G.3 实测） |

### G.2 已登记（C 组：6 条 `pending`，**不是删除**）

向 `scripts/verify-promises.ts` 的 `PROMISES` 登记（门禁语义：`pending` + 0 调用点 = 告警；`wired` = 失败）：

| symbol | file | note 要点 |
|---|---|---|
| `LivenessMonitor` | `workflow/budget.ts` | §10.5 进度活性未接线（forwarders: `compose.ts`） |
| `planCompaction` | `memory/compaction.ts` | §8.10 压缩算法未接线；阻塞在宿主能力，指向 §8.10.0 |
| `enrichContextRefs` | `workflow/handoff.ts` | doc:1670/1683 的引用来源/可信度显示未接线 |
| `assertGraph` | `workflow/phases.ts` | 自称「启动自检」但 src 内无调用 |
| **`assertLeaseValid`** | `workflow/lease.ts` | **见 G.4：跨任务提权检查的唯一实现** |
| **`validateLeaseForOperation`** | `workflow/lease.ts` | 同上（提交准入路径） |

### G.3 验证（本次改动，实测输出）

命令链：`npm run lint && npm run typecheck && npm test && npm run build && npm run verify`（含新 `clean`）→ **EXIT=0**。

| 验证 | 结果 |
|---|---|
| 全量测试 | **1663 / 1663 通过**（0 失败） |
| `verify:styles` | 类名 使用 346 / 声明 346；令牌 引用 42 / 定义 54 ✓（合并后覆盖不变） |
| `verify:promises` | **9 项（8 告警，0 失败）** ✓ 与预测一致（新登记的 6 条全部以 `[待处置]` 打印，note 原样输出） |
| `verify:typert-face` | 门面 53 个 `@Remote` 方法 / 清单 53 个端点 ✓ |
| `verify:client` | 22 项断言全过——它在 Node VM 里 materialize `lib/client.js`、注册槽位并**渲染真实 HTML**（`<div class="pentest-console"><section class="pentest-card"><h3 class="pentest-card__title">…`）→ **styles 合并的行为级证明**（类名与样式装配未坏） |
| `verify:forward-migration` | 25 项断言 ✓（与本次改动无交集） |
| 陈旧产物 | `lib/agents/` 只剩 `dsh-session-factory.js`；`npm pack --dry-run` 里 `capability` 命中 **0**（此前 2）→ **不再进 npm 包，也不再进 Docker 镜像的 `COPY lib`** |
| 构建产物 | `lib/index.js`、`lib/client.js`、`lib/db/migrations`（26 个 SQL）齐备 ✓ |

### G.4 本轮最重要的发现：**B1 在执行前撤回**——一处文档承诺的安全规则没有执行点

原计划（E.5-A/B）包含「删除 `lease.ts` 的两个准入入口」。**动手前逐符号核对**发现它们不是「重复实现」：

1. `assertLeaseValid` / `validateLeaseForOperation` 里的 `rejectionForLeaseState`（`lease.ts:248`）实现了**跨任务提权防护**：
   `if (taskRef !== null && lease.taskRef !== null && lease.taskRef !== taskRef) → 'lease_required'`（「租约绑定任务 A，不能用于任务 B」）。
2. **生产的三条租约判定路径都不做这个比对**（逐条验证）：
   - `execution/admission.ts:135` `leaseViolation`：查终态 / 无租约 / 吊销 / 到期 / **世代**，**不查任务绑定**；
   - `execution/pg-store.ts:505-520` 的 SQL 级判定：同样只有 `lease_required`/`lease_generation_stale`/`lease_revoked`/`lease_expired`；
   - `workflow/lease.ts:546` 的 `renewLease` 调用 `resolveGenerationAdmission` 时**显式传 `taskRef = null`**。
   全仓 `\.taskRef\b` 的属性读取只有 `lease.ts:248` 一处（`policy/pg-policy.ts:309` 只做行→结构的字段映射）。
3. 而设计文档**把这条规则写成承诺**：doc:3607「绑定到任务 A 的会话不能提交任务 B 的结果」、doc:4374 验收标准「会话租约：……**跨任务提交被拒**」。
4. 因此删除该簇等于**删掉这条规则的唯一实现与 20 个测试**——不是「删除死代码」，而是「抹掉一个已知缺口」。**改为登记 pending**（G.2 最后两条）。
5. 登记 note 里写明了接线前提：**先定义「提交所属任务」的来源**——当前 `ExecutionPlan` 与审批记录都不携带任务标识，所以这条规则今天无法在提交路径上执行（这也解释了它为何未接线）。

> 这条发现是四轮复核最实质的产出：删除测试的正向用法是「删掉没价值的代码」，而它同时能反向定位「**文档说要有、运行时其实没有**」的缺口。

### G.5 未执行（保持原状，理由）

- **`exports["./src/*"]` 未删**（附录 E.2：dev 源码加载口子）；
- **D 组合并项未做**（`describe` 三副本、`'index_event'` 三处、`RUNTIME_MARKER_*` 同值双导出、`PUBLIC_MEMORY_MAX_CHARS` 单源）：不在本次授权的 A/C 清单内，且都是**跨模块**改动，建议单独一批；
- **保留 3 项**（`TYPE_SCALE`/`SPACE`、`CONSOLE_ONLY_PHASES`、`HandoffEdit`/`HandoffDraftRequest`）按附录 E.5-E 不动；
- **`lib/types/**` 非导出化**（E.5 之外的大面积收窄）未做：需按次要版本发布 + CHANGELOG 记录，建议单独决策。

---

## 附录 H：对本次执行（提交 493b034 / d299b18）的质检

> 对象：A 组 7 项 + C 组 6 条登记。方法与前几轮一致——**先去证伪，再下结论**。

### H.1 检验项与结果

| 检验 | 方法 | 结果 |
|---|---|---|
| **悬空引用（非代码面）** | 对 `buildRunControls` / `HostDomNodeLike` / `HostDomRootLike` / `CountRow` / `styles/index.ts` / `styles/tokens.ts` / `capability.ts|.js` 扫 `docs/`（含设计文档）、`RUNBOOK.md`、`presets/`、`skills/`、`docker/`、根 `*.md` | **设计文档 0、RUNBOOK 0、presets 0、skills 0、docker 0**（仅 `docker/tools/Dockerfile` 两处 Linux capability 注释，与已删模块无关）；`src/test/scripts` 内亦为 **0** |
| **迁移代码逐字等价** | `git show HEAD~1:` 取旧 `styles/tokens.ts` / `styles/index.ts`，与新 `styles.ts` 的对应片段逐字比对 | `FONT_FACE_CSS` ✓ `TOKENS_CSS` ✓ `PENTEST_CSS` 装配式 ✓ **三者全部 `true`** |
| **守卫扩展的红/绿变异** | 向 `styles.ts` 注入一个多行模板 + 注释里的反引号，跑 `verify:styles`；再 `git checkout` 还原后重跑 | 注入 → **exit 1**，报 `src\client\styles.ts:81 CSS 模板里出现反引号：…`；还原 → **exit 0**；还原后逐字一致（差异仅 CRLF/LF，归一化后 `true`） |
| **定向验证** | `lint` / `typecheck` / `verify:styles` / `verify:promises` / 三个客户端相关测试文件 | 全绿：退出码 0 / 0 / 0；承诺检查 9 项（8 告警，0 失败）；测试 **61/61** |
| **A5 语义等价（`key` → `row.type`）** | 读校验器：`type_field_mismatch`（key≠type 已报错）先于迭代检查；规则测试在 `test/phases.test.ts:540` | 良构表行为不变；畸变表两处都会报；规则测试在全量套件中通过 ✓ |

### H.2 发现并修复的两处「合并自伤」

1. **新孤儿导出**：合并后 `FONT_FACE_CSS` / `TOKENS_CSS` 变成 **0 处外部消费**（唯一消费者是刚被删的 `styles/index.ts`）。若不处理，它们会成为报告里被批评的那类零引用导出。→ **去掉 `export`**（提交 `d299b18`）。
2. **知识丢失**：旧 `styles/index.ts` 头注释解释了**为什么按样式域拆分**（「变更半径」：改放行队列排版不该碰到阶段轨道、也不该两人同编一份 700 行字符串）。合并时未迁移 → **已恢复到新 `styles.ts` 头部**（提交 `d299b18`）。

> 第二处正是本报告反复强调的那类问题：删除测试关心的是**代码行为**，而「为什么这么写」的知识只活在注释里——合并文件时必须把它一起搬走，否则下一次评审就会看到一段无从解释的拆分。

### H.3 未发现问题的项（确认）

- **`verify:client` 的行为级证明**：在 Node VM 里 materialize 新 bundle 并渲染出真实 HTML（`<section class="pentest-card">…`）→ styles 链合并未破坏类名/装配；
- **陈旧产物**：`lib/agents/` 只剩 `dsh-session-factory.js`；`npm pack` 中 `capability` 命中 0；
- **登记质量**：6 条 `pending` 的 note 均带出处（doc 行号 / 符号 / 文件行）与接线形态，门禁输出与预期一致（9 项 / 8 告警 / 0 失败）。

---

## 附录 I：第六轮复核（产物面与契约路径的质检）

> 主题：**执行之后的产物面**——干净构建是否完整、`clean` 是否安全、包契约的每条路径是否都指向真实存在的文件、以及撤回项是否真的没动。

### I.1 `clean` 的安全性与完整性（实测）

| 检验 | 结果 |
|---|---|
| 干净构建后的产物集合 | `lib/` 共 **155** 个 js/d.ts/sql 文件，**陈旧 0**（按 toSrc 映射逐一核对，含 `lib/client.js` 与 `lib/db/migrations/*.sql` 两个特例映射） |
| 有无「被 clean 掉但不再生成」的东西 | **没有**：`npm pack` 由 clean 前 **159** → 现 **157 = 159 − 2**，差额恰是两个 capability 陈旧产物（若丢了别的文件，数目对不上） |
| 关键产物 | `lib/index.js` ✓ `lib/client.js` ✓ `lib/types/index.d.ts` ✓ `lib/db/migrations/`（26 个 SQL）✓ |
| 与 tsdown 的交互 | `tsdown.config.ts` 明写 `clean: false`（理由：tsdown 默认清理会擦掉 tsc 产出的 43 个 JS 与迁移 SQL）——新的 `npm run clean` 在两个构建器**之前**运行，与它不冲突 ✓ |

### I.2 新发现（**既有缺陷**，被 clean 暴露）：`exports["./client"].types` 指向不存在的文件

- `package.json`：`"./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }`；
- 实测：该文件**不存在**，且 `tsdown.config.ts` 写死 **`dts: false`** → 构建**永远不会**生成它；
- **排除「我引入的回归」**：`npm pack` 现为 157 = clean 前 159 − 2（陈旧产物），说明该文件在 clean **之前**就不存在 ✓；旁证：`.dockerignore` 的注释宣称「package.json 的 exports 里**三个** types 路径指向 lib/types」，而实际只有两个 `types` 条件、其中这个悬空——注释与事实都需要修；
- 影响：`import … from 'dsh-pentest/client'` 的**类型解析**会失败；运行期不受影响（宿主按 `lib/client.js` 的模块加载器加载，不走 Node 解析）。它与 `exports["./src/*"]` 同属「死契约路径」家族；
- 修法（二选一，待授权）：**(a)** `tsdown` 开 `dts: true` 并确认落点是 `lib/types/client/index.d.ts`；**(b)** 删掉 `./client` 的 `types` 条件让契约诚实，同时修正 `.dockerignore` 注释。

### I.3 包契约路径全量核对

`main`、`exports["."]`（types + default）、`exports["./cordis.patch.yml"]`、`exports["./package.json"]`、`dsh.bundle.patch`、`files[]` —— **全部指向存在的文件** ✓。悬空的只有：`exports["./client"].types`（I.2）与 `exports["./src/*"]`（刻意保留的 dev 口子，但 `files` 不含 `src` → 对**已发布包**是悬空的；建议在那行附近注明「仅源码检出处可用」）。

### I.4 其它面

- **`docker/tools/Dockerfile`（沙箱工具镜像）不依赖 `lib/`**（只 `COPY pentest-tool`）✓；`docker/Dockerfile` 依赖宿主构建的 `lib/` ✓ 行为不变；
- **`presets/` 不在发布面**（`files: ["lib","cordis.patch.yml"]`），而预设是「会话能看见 `ask_user_question`」的必要条件（`presets/pentest/agent.cordis.yml` 的注释）→ 发布包用户需在 profile 里自行配置 `agent-presets` 的 roots；`src/index.ts:596-649` 已有运行时告警、RUNBOOK 有指引 → **已知且已处理的产品约束**，此处仅登记；
- **`LedgerError` 删再导出后公开声明面未变**：它只出现在 `throw new LedgerError(…)` 的语句体（无导出签名引用）✓；
- **B1 撤回的完整性**：`git diff 22da7d7..HEAD -- src/workflow/lease.ts` = **空**（lease.ts 一字未动）✓；同期只有 `contracts.ts`（±1 行 jsdoc）与 `db/migrate.ts`（−4 行 `CountRow`）。

### I.5 本轮引入的**流程教训**（建议写进 RUNBOOK）

验证链的环境变量**不能共用同一个 `PENTEST_DATABASE_URL`**：
- `npm test` 需要 **`.../pentest`**（库里有 schema）；
- `verify:forward-migration` 需要**可建库的角色**（RUNBOOK 用 `.../postgres`）。

本轮我把 `.../postgres` 一次性 export 给整条链，得到「build ✓ verify 五道 ✓ 但 **70 个测试文件全失败**」的假警报——看上去像全线崩，实际只是库不对。RUNBOOK 第 36 / 41 行已有两处正确用法，建议追加一句显式警告：**「测试与迁移演练用不同的库，勿复用同一个 export」**。
（旁证：整套测试在库不对时会**响亮失败**而不是静默跳过——这正是想要的行为。）

### I.6 复核结论

- **执行面**：干净构建完整、`clean` 无损、撤回项未动、公开声明面未变 → **本次执行无回归**；
- **新发现**：1 条既有契约缺陷（`./client` 的 types 悬空）+ 2 处注释与事实不符（`.dockerignore` 的「三个 types 路径」、`exports["./src/*"]` 的发布语义）；
- **未做**（待授权）：I.2 的修法选择、RUNBOOK 的 URL 警告、`exports["./src/*"]` 的注释澄清。

---

## 附录 J：三项收尾的落地（对附录 I 发现的处置）

| I 的发现 | 处置 | 证据 |
|---|---|---|
| `exports["./client"].types` 指向**永不生成**的文件（tsdown `dts: false`） | 采用**修法 (b)：删除该 `types` 条件**并让契约诚实——修法 (a)（tsdown 开 dts、把落点做成 `lib/types/client/index.d.ts`）与「客户端产物是宿主模块加载器的自定义包装格式」的既定设计相悖，且要改构建配置与落点，风险高于收益。同时给 `package.json` 加 `"//exports"` 说明两条契约（沿用 `docker/package.json` 的 `"//"` 注释惯例） | `require('./package.json')` 解析 ✓；`npm pack --dry-run` 仍 **157** 文件（删条件不改变发布内容）；`grep` 确认仓内**零**处按名字依赖 `dsh-pentest/client` 的类型 |
| `.dockerignore` 注释宣称「exports 里**三个** types 路径指向 lib/types」 | 改为事实描述：只有 `exports["."]` 的 `types` 指向 `lib/types`；并注明 `./client` 不产类型及其原因 | `.dockerignore:21-25` |
| RUNBOOK 缺「**三个库不要共用同一个 `PENTEST_DATABASE_URL`**」的警告（本轮假警报的根因） | 在 §1 迁移命令后加警告块：三库对照表（`pentest` 测试 / `postgres` 迁移演练需 CREATEDB / `pentest_personal` 个人），并写明假警报的**形状**（「构建通过、门禁全绿、测试 70 个文件全失败」）；引用 `test/helpers/tsx-loader.mjs` 的库名守卫 | `RUNBOOK.md:45-54` |
| RUNBOOK 的过时数字 | 类名期望 `310/310` → **346/346**；`npm test` 规模 `1587 用例 / ≈60 秒` → **1663 用例 / ≈2 分钟**（本轮实测） | `RUNBOOK.md:529` / `:814` |
| RUNBOOK 未写「`verify` 需要先 `build`」 | 在 §6.5.5 的门禁命令块加前置说明（`verify:client` 读 `lib/client.js`，未构建会失败） | `RUNBOOK.md:531-534` |
| RUNBOOK 未写 `build` 现在会先 clean | §4b 的生产路径说明改为：`build = clean && build:host && build:client`，并说明陈旧产物曾随 `files` 进 npm 包、随 `COPY lib` 进镜像 | `RUNBOOK.md:206` |

**验证**：`typecheck` 退出码 0；`lint` / `verify:styles` / `verify:promises`（9 项 8 告警 0 失败）；`npm pack` 文件数保持 157；`package.json` 可解析且 `exports` 键集合不变（`.` `./client` `./cordis.patch.yml` `./src/*` `./package.json`）。

---

## 附录 K：第七轮改进（未接线闭合 + 四处单源化）

> 依据「持续改进」：挑**零风险、收益确定**的项，且每一项都用编译期 + 测试双重验证。

### K.1 唯一能自行闭合的「未接线」：`assertGraph` 接入启动自检

- 改动：`src/index.ts` 的 `applyPentest` 在 `assertSessionVocabularyClean()` 之后调用 `assertGraph()`（状态图/分派表是**静态**数据，坏一行在运行期的表现是「状态机走上设计外路径」，此前只有测试会拦）。
- 门禁闭环：`verify-promises` 里该条由 `pending` 翻为 **`wired`** —— 从此谁删掉这次调用，门禁**失败**（新的棘轮）。实测：告警数 8 → **7**。
- 验证：`boot` / `phases` / `assemble` 61 个用例通过；全量 1663/1663 ✅。

### K.2 四处单源化（消除「同一事实两处写」）

| 项 | 处置 | 为什么这样选 |
|---|---|---|
| `describe(error)` **三份逐字相同**的私有副本（`client/log.ts`、`agents/dsh-session-factory.ts`、`workflow/recovery.ts`） | 收敛为 `contracts.ts` 的 **`describeError`**；三处删除本地实现，调用点（含 `client/index.ts` 两处、`panel-jump.ts`）改指契约层 | 放契约层是因为 **host 与 client 两侧都要用**，而它只依赖 `Error`/`String`（无平台依赖）。改名而非沿用 `describe`：避免与 `node:test` 的 `describe` 混淆 |
| `'index_event'` 字面量**三处**（`outbox.ts` 取值表、`dispatcher.ts`、`index-enqueue.ts`） | `outbox.ts` 导出三个具名常量（`satisfies OutboxJobType` 让「写错即编译失败」）；两处改为 import；两处测试同步改导入源 | 取值表自称「新增类型时只改这里」——那就让这条真的成立；`satisfies` 保证常量仍在表内 |
| `RUNTIME_MARKER_TYPES` ≡ `RUNTIME_MARKER_TRANSITION_TYPES`（同值双导出） | 保留 `phases.ts` 的 `RUNTIME_MARKER_TRANSITION_TYPES`，`transition-table.ts` 与 `core.ts` 改消费它 | `phases.ts` 是既有测试的导入源，且它**不被** `transition-table` 反向依赖（无环）；反向保留会在两个模块间造出循环 |
| `PUBLIC_MEMORY_MAX_CHARS` 两侧各一份（服务端私有 + 客户端导出） | 单源到 `contracts.ts`；`workflow/model.ts` 删私有副本、`client/views/PublicMemoryPanel.tsx` 删重复导出；测试改为钉住**契约值** | 客户端要在提交前拦、服务端要在创建/更新两入口拦，两侧必须同数；`contracts.ts` 是两侧都已有的 import（进浏览器包不引入服务端依赖） |

### K.3 过程中的自纠（记一笔）

`edit` 的 `replace_all` 只匹配「上下文完全相同」的行，因此我漏了 **3 处**同类调用点：
`client/index.ts:899`（`describe(cause)`，变量名不同）、`workflow/recovery.ts:406`（对象字面量里带 `row.engagement_id`）、`test/index-enqueue.test.ts:223`（`job` vs `row`）。
它们是**被验证链抓出来的**：`typecheck` 报 3 个 TS 错误、定向测试报 2 个失败（`index-enqueue`/`recovery`）→ 修好后 typecheck 0 错、定向 102/102。
**教训**：批量替换后必须用「编译 + 测试」而不是肉眼看 diff 来确认完备性（这也正是本仓把 `typecheck` 与 1663 个用例放在同一条链上的价值）。

### K.4 验证（全量链，按 RUNBOOK 新写的分库口径）

| 步骤 | 结果 |
|---|---|
| `lint` / `typecheck` | 退出码 0 |
| `npm test`（库 `pentest`） | **1663 / 1663** |
| `npm run build`（含 `clean`） | ✓ |
| `npm run verify`（五道；迁移演练用可建库角色） | 全过：样式 346/346 · **承诺接线 9 项（7 告警，0 失败）** · 端点面 53/53 · 客户端产物 22 项 · 前向迁移 25 项 |

### K.5 仍未做（保持登记/待决策）

- `taskRef` **跨任务提权检查**的接线：生产三条路径都不比对任务绑定（doc:3607/4374 的验收标准），登记在 `verify-promises` 的 `pending` 里；接线前提是**先定义「提交所属任务」的来源**（`ExecutionPlan` 与审批都不携带任务标识）——属产品决策，未擅自改工具面；
- `LivenessMonitor`（§10.5）与 `planCompaction`（§8.10）：阻塞在宿主能力（回合边界 effect 点、模型客户端、`SessionPort` 的 `replace` 追加写），已登记并指向设计文档 §8.10.0；
- `enrichContextRefs`（交接视图的引用来源/可信度）：待确认控制台是否显示该信息后再定接线或删除。

---

## 附录 L：持续改进（Stage 3–6：接缝外迁 · 词汇单源 · 类型化写入 · 接口收窄）

> 依据「持续进行项目的改进，完成后自行推进到下一阶段」。四个阶段都遵守同一纪律：
> **先量化、再改、由编译期与测试判定**。全量验证（lint / typecheck / 1663 用例 / build / verify 五道）见 L.5。

### L.1 Stage 3：`DbClient` 端口外迁（seam 归位）

- **问题**（第六轮报告的最强接缝建议）：通用端口 `DbClient` / `RlsAwareDbClient` / `DbRlsContext` / `DbResult`
  长在 `memory/ledger.ts` 里，13 个模块 import 账本只为拿一个类型（其中 11 个是纯类型依赖）。
- **改动**：新建 **`src/db/port.ts`**（逐字搬迁，不 import 任何东西）；事务调度器
  （`DbTransactionRunner` / `transactionRunnerFor`）**留在账本**——它编码的是「共享独占写连接 + RLS + 审计」的账本语义。
  39 个文件改指新模块（13 src + 26 test/scripts），混合导入拆成两条语句。
- **过程自纠**：脚本 v1 有两处判断错误——① 只认「带 `memory/` 的路径」，漏掉同目录的 `'./ledger.ts'`
  （`dispatcher.ts` / `embedding.ts` 因此残留成 TS2459）；② 语句级 `type` 关键字的判断漏了空格，
  把 34 处写成值导入（触发 `verbatimModuleSyntax` 的 TS1484）。v2 改为「解析后是否等于 ledger.ts」判定
  并统一输出 `import type`（端口四个符号全是 interface）→ typecheck 归零。
- **验证**：typecheck 0 错（纯类型层迁移，运行时行为不变）。

### L.2 Stage 2：format 词汇表去漂移（修的是**已发生的**缺陷）

- **问题（实测证据）**：同一会话状态在不同页面显示成不同词——
  `active`：时间轴 '工作中' vs AgentTrace '运行中'；`blocked`：'阻塞' vs '已阻塞'；
  `transition_confirmation`：'等待确认交接' vs '等待阶段确认'；`handoff_drafting`：'准备交接中' vs '准备交接'；
  `trustTone` 在 `MemoryExplorer` 自建；`phaseLabel` 在 `phase-track` 内联（注释声称「避免循环依赖」，
  但 `format.ts` 只依赖契约层，循环并不存在）。
- **改动**：`format.ts` 新增 **`sessionStatusLabel`** 与会话状态表、迁入 **`trustTone`**（与 `trustLabel` 同处）；
  五处副本删除（timeline ×2、AgentTrace、phase-track、MemoryExplorer）；`MinimapBlock.tone` 由手抄联合类型改为 `Tone`。
- **文案怎么定的（不是口味问题）**：以设计文档用词为准（doc 里「运行中」出现 **24 次**、「工作中」**0 次**），
  并与 `runMarkerLabel` 的 house style 对齐（存活态「…中/准备…」、终态「已…」）。
- **验证**：typecheck 0、lint 0、受影响测试 196/196。

### L.3 Stage 5：类型化写入包装（补上「类型化表面的缺口」）

- **问题**：`mutate(method, params: Record<string, unknown>, …)` 是公开的通用入口，
  4 处视图直接调它（`setApprovalMode` ×2、`archiveEngagement`、`purgeEngagement`）——
  字段名写错只会在运行时被服务端以「信封不允许键」含糊拒绝。
- **改动**：补 **`setApprovalMode` / `archiveEngagement` / `purgeEngagement`** 三个类型化包装
  （用契约输入类型 + `Omit<…, 'operatorId' | 'expectedStateVersion'>`，与既有包装同形）；
  四处视图迁移；`mutate` 的文档明确「**视图不得直接调用**——每个端点都应有类型化动作」。
- **行为等价**：原调用传 `reason=''`、不传 `expectedStateVersion`（由控制器取快照版本）；
  包装内部 `reason ?? ''` 且不传 options → 与原先**逐字等价**。
- **验证**：视图层 `mutate` 调用 **0 处**；typecheck 0、lint 0。

### L.4 Stage 4：装配壳文档去重

- **量化**：`pg-workflow.ts` 的 110 行 JSDoc 中 **102 行与流程文件逐字重复**（21 个块完全重复、1 个部分、1 个独有）。
- **改动**：按「块内所有有效行都能在流程文件里找到」的判据删除 21 个块，保留 2 个；
  头部说明「**方法级文档在流程文件里**」并写明此前两处各一份会漂移。**423 → 261 行**。
- **验证**：typecheck 0、lint 0（含 `pg-workflow` 相关测试）。

### L.5 Stage 6：零引用导出收窄（本批最大的量化改进）

- **规则（保守）**：只处理 `export <decl>` 声明形式；符号名在**其它文件**（src/test/scripts 全部）零出现；
  且在本文件内至少出现 2 次（声明 + 使用）→ 去掉 `export` 不会有 lint 未使用错误、也不删任何东西。
  **排除插件入口**（`src/index.ts`、`src/client/index.ts`：它们的导出是宿主运行期契约，静态扫描看不见）。
- **结果**：**收窄 349 个导出（72 个文件）**；另删除报告已决定删除的两个符号
  （`ReconciliationSource`——零实现零引用的假想 seam；`phaseOrder`）。
- **lint 抓到的边界情况（值得记）**：9 个常量形如 `const X = [...] as const; type Y = (typeof X)[number]`——
  值只被**自身的 `typeof` 类型**引用，去掉 `export` 后按 eslint 语义算「未使用」。
  它们是**取值域词汇表**（`CONSOLE_ERROR_CODES` / `SESSION_KINDS` / `SCOPE_REJECTION_CODES` / `CHUNK_PARTS` /
  `HISTORY_ENTRY_KINDS` / `PINNED_ENTRY_KINDS` / `TOOL_OUTPUT_ENTRY_KINDS` / `COMPACTION_VIOLATION_CODES` /
  `BUDGET_DIMENSIONS`），删常量会破坏「改数组即改类型」的单源关系 → **回补导出**（脚本化）。
- **量化结果**：导出面 **1277 → 925（−27.6%）**；**零引用导出 380 → 34（−91%）**；
  剩余 34 个是**刻意保留**的：入口导出（3）、领域词汇常量（12，见报告 §5-E）、
  以及「仅在别处注释里被提到」的保守保留项（脚本把注释出现也算引用）。
- **验证**：typecheck 0、lint 0、全量测试与门禁见下。

---

## 附录 M：真机实测记录（2026-10-05 晚，改进后首次端到端）

> 目的：改进（Stage 1–6）之后，用**真实 harness + 真实浏览器 + 真实数据库**走一遍，而不是只看测试与门禁。
> 环境：`node start-personal.mjs`（profile `pentest`、端口 3090、库 `pentest_personal`）；前置检查全过
> （Docker 29.2.1、工具镜像摘要、`pentest-lab-internal`、`pentest-lab-proxy`）。

### M.1 启动与加载（真实进程）

- 插件加载成功；`compose()` 期自检与**本轮新接线的 `assertGraph()` 启动自检都没有抛**（坏图会在 apply 期即失败）。
- 插件日志（真实输出）：
  - `RLS 自检（当前角色 postgres）：连接角色是超级用户/BYPASSRLS：RLS 策略不生效…`（部署事实，非缺陷）
  - `未配置 skillAuditEngagementId：skill 增删改不会写入审计账本`
  - **`config.runtime.recovery 不生效：recovery 是插件配置的顶层字段（与 runtime 并列），请把它移出 runtime`** ← 见 M.4 的发现
- 浏览器（真实 Chromium）加载 `http://127.0.0.1:3090/?token=…`：标题 `DeepSeek Harness`，**无页面错误**（`errors.entries = []`）。

### M.2 控制台渲染（读路径 · 覆盖 Stage 3/6）

| 检查 | 结果 |
|---|---|
| 侧栏/标签 | 「渗透作业」入口存在 ✓ |
| **合并后的样式链** | `<style>` 中出现 `.pentest-*` 规则（`pentestStyleInjected: true`）→ **Stage 2 的 styles 合并 + Stage 6 的收窄在真实浏览器成立** |
| 控制台外壳 | `.pentest-console` 在场；该帧内 **63 个** `pentest-*` 元素 |
| 卡片 | 「Engagement 列表」「运行总览」「授权范围 intake」✓；8 个面板标签全部渲染（总览/报告审阅/记忆浏览器/放行队列/交接编辑/Skill 库/范围管理/公共记忆） |
| **真实数据（读）** | 「**共 23 个**」「显示已归档（21）」、6 行作业表格；诊断卡：连接池 总 3 / 空闲 0、审计写入 可写、索引队列 待办 5 → **全部经 Stage 3 外迁后的 `DbClient` 端口** |
| 词汇表（Stage 2） | 作业行显示「运行中 / Agent 工作中 / 漏洞分析」✓（主状态与阶段的新单源表）。**说明**：`sessionStatusLabel`（会话级状态）需要真实 Worker 会话才会出现在界面上，本轮一次性作业没有会话，故该表仅由单测覆盖。 |

### M.3 写路径（覆盖 Stage 5 的两个新包装）

净零冒烟：新建一次性作业 → 归档 → 彻底清空（全部走 UI，真实点击；`smoke-live-069717`）。

| 步骤 | 前端证据 | **数据库证据（权威）** |
|---|---|---|
| 建作业（范围 `smoke.invalid`、预设「已通知的授权渗透测试」、审批「人工审批」） | 「校验范围」由服务端裁定后提交按钮解禁 → 列表 **23 → 共 24 个** | 作业行写入（`current_status=ready`）+ **2 条 human_decisions** |
| **归档**（新包装 `archiveEngagement`） | 该行从默认视图消失 | `archived_at = 2026-10-05T16:36:41Z` ✓（human_decisions 增至 2 条） |
| **彻底清空**（新包装 `purgeEngagement`；先经 `previewEngagementPurge`） | 弹窗显示服务端预览：「将删除 7 行（outbox_jobs 6、scope_versions 1）」「审计账本 15 行保留」→ 输入作业名确认 → 行显示「已清理」 | 逐项对上：`scope_versions 0`、`outbox_jobs 0`（已删）；`context_events 6`、`ledger_anchors 6`、`human_decisions 2`、`policy_versions 1`（**保留**，§9.5 只追加）；作业行保留且 `purged_at` 已写 ✓ |

未做（有意）：`setApprovalMode` 包装未在真机点（它会在**真实作业**上推进 policy epoch 并作废放行凭证，属不可逆的副作用）——该包装与其余两个同形，且已有单测与 UI 渲染覆盖。

### M.4 实测发现（1 条，属**部署配置**而非代码）

- **个人 profile 把 `recovery` 写在了 `runtime` 下面** → 插件在启动时明确告警「`config.runtime.recovery` 不生效：recovery 是插件配置的顶层字段」，即**启动对账（§15.2）在生产/个人环境里被静默关掉**。
  修法：把 profile 里的 `recovery:` 段从 `runtime:` 下提到顶层（与 `runtime` 并列）。
- 另两条日志（RLS 超级用户、skillAuditEngagementId 缺失）是**已知部署事实**（RUNBOOK §1 与设计文档有说明），非缺陷。

### M.5 结论

- 六个改进阶段（端口外迁 / 词汇单源 / 类型化包装 / 文档去重 / 导出收窄 / 接线）在**真机**上没有引入可观察回归：
  加载、渲染、读、写（建/归档/清空）与审计留痕全部正常。
- 留痕：一次性作业 `smoke-live-069717`（已归档 + 已清空，审计 15 行保留）留在个人库中——按设计，purge **不删**账本行与作业行；如需彻底移除需人工处理（不在代码路径内）。

---

## 附录 N：事故与修复（2026-10-05 晚）——「渗透通道被后端 schema 错误堵死」

> 用户报障（原文）：**「渗透通道当前被后端 schema 错误堵死（`worker_sessions.skill_freeze` 列不存在），我无法建立作业、也无法做任何目标动作。」**

### N.1 根因（已定位，非代码缺陷）

- 仓库里**有**迁移 `026_skill_freeze.sql`，代码也如期读写 `worker_sessions.skill_freeze`
  （读：`memory/pg-worker-tools.ts:392`；写：`workflow/core.ts:1288`）；
- 但**个人库 `pentest_personal` 落后 2 个迁移**：`025_approval_revocable.sql`、`026_skill_freeze.sql`（实测：`schema_migrations` 24/26）；
- 个人 profile 刻意设 `migrateOnStartup: false`（「运行进程不承担 DDL」）→ RUNBOOK §1 要求**升级插件后由管理员先跑一次迁移**，这一步被漏掉；
- 表现即用户看到的那句：前置检查全过、服务正常起来，直到某个动作读到新列才炸。

**放大原因**：`start-personal.mjs` 的 `checkDatabaseSchema` 只检查**表/扩展是否存在**，不检查**迁移新鲜度** → 所以预检说「通过」而运行期报错。

### N.2 修复（当场）

1. 按 RUNBOOK §1 的管理员命令把两个迁移应用到 `pentest_personal`：
   `appliedFiles: ["025_approval_revocable.sql","026_skill_freeze.sql"]`；`schema_migrations` → **26/26**；
2. `skill_freeze` 列已存在（`jsonb NOT NULL DEFAULT '[]'`），**用户报错时的那条查询已能跑通**（返回真实会话行）；
3. 重启 harness。

### N.3 预防（代码改动，`start-personal.mjs`）

新增 `applyPendingMigrations(database)` 并接进预检链（在 `checkDatabaseSchema` 之后）：
比对 `src/db/migrations/*.sql` 与 `pentest.schema_migrations`，**发现未应用即按 RUNBOOK §1 的同一条命令自动应用**
（本脚本是管理员工具，DDL 放这里正合 profile 的立场），失败则以明确错误中止启动。
重启实测输出：**`数据库迁移已是最新（26 个）`** → `前置检查通过` ✓。

> 这条预防直接消灭了「忘记跑迁移」这一整类故障：以后升级插件后直接 `node start-personal.mjs` 即可，
> 不会再出现「预检通过、运行期 `column ... does not exist`」。

### N.4 真机验证（修复后，只读 + 一条自发的真实写入）

| 检查 | 证据 |
|---|---|
| 列/迁移 | `worker_sessions.skill_freeze` 存在 ✓；`schema_migrations` 26/26 ✓；报错时的 select 成功 ✓ |
| 控制台功能 | 打开渗透作业面板：**无 schema 错误**（`does not exist` 零命中）✓ |
| **真实写入**（关键） | 打开控制台时插件按「会话即 intake」自动建立草稿作业（`未命名任务 web-17910066`，16:45:52）→ DB 里该作业**有 1 行 `worker_sessions`**（kind=intake、status=active），其 **`skill_freeze = {"model":"deepseek-flash","provider":"deepseek-official","reasoningEffort":"high"}`** ✓✓ ——**正是报错时失败的那条写路径** |

### N.5 两个待用户确认的旁证（不是本次修复的一部分）

1. **归档数变化**：列表现在是「共 25 个 / 显示已归档（24）」，而我两次会话之间归档数由 **21 → 24**。
   其中 1 个是我的一次性作业（`smoke-live-069717`）；**另外 2 个不是我操作的**（我唯一一次「归档」点击是
   精确匹配 `smoke-live-` 行的按钮）。请确认是否为你自己的操作。
2. **profile 配置**：插件启动仍告警 `config.runtime.recovery 不生效：recovery 是插件配置的顶层字段`
   → 个人环境里的**启动对账（§15.2）被静默关掉**。修法：把 profile 的 `recovery:` 段从 `runtime:` 下提到顶层
   （属你的部署文件，未擅自改）。
