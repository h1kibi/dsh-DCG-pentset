# 外部反馈核实：`pentest-10.25.27.206-报告与平台改进建议.md`

**被核对象**：别人在其 GitHub 发布版上跑真作业（目标 `10.25.27.206`，Supermicro IPMI）后提交的 6 条缺陷（D1–D6）+
1 条面向分析者的建议（§2.3）。
**核对人**：本仓库当前工作副本（`ac60e5d` 之后，镜像 `a18f239589fd`）。
**方法**：逐条到**我们的**代码/镜像/活库/现成锁里对证；能跑的一律跑（真容器、真 PostgreSQL、现成回归测试）。

## 核实结论总表

| # | 他们的缺陷 | 我们这里 | 依据（可复核） |
|---|---|---|---|
| **D1** | 控制台阶段卡按 dsh 会话反查不到绑定 ⇒ 阶段推进堵死 | ⚠️ **部分存在**（文案同源；堵死链路仍在，且**文案过度承诺**） | `IntakePrompt.tsx:606/622/871-878`、`intakePromptFacts:226`、`AdvanceAction:479-490`（两个落点都在 `facts !== null` 之后）、`panels.ts`（无推进动作）、`HandoffPanel.tsx` **无人渲染**、`core.ts:1338`（绑定只在创建时写、**无 rebind 路径**） |
| **D2** | `skill_load` 对该会话快照里的 skill 也报"不在装载集合" | ❌ **不存在**（判据与文案同源，且锁钉住） | `pg-worker-tools.ts:402+`（判据读 `worker_sessions.skill_ids`）、`worker.ts:1592-1595`（文案由**同一次返回**的 `loadedNames` 拼）、`test/skill-load.test.ts` 7/7 绿（含"正例：已装载的 skill 返回正文"） |
| **D3** | `memory_search` 报 `column "kind" does not exist` | ❌ **不存在**（已于 2026-10-10 修，且有回归锁） | 活库 `\d pentest.memory_chunks` **无 kind 列**；`chunks.ts:111/650` 记录该纪律；`pg-worker-tools.ts:715-722` 注释点名同一 bug；`test/memory-search-diagnostics.test.ts` 3/3 绿 |
| **D4** | 工具侧挂载根为空但 `/work` 实际可写 ⇒ 证据静默不落盘 | ❌ **不存在**（两侧同源；失败是**结构化开口**） | `session-mounts.ts`（`workdirRootsFor`/`evidenceRootFor`/`writableMountContainerPathsFor` 全部由 `mountsForWorker` 派生）、`test/session-mounts.test.ts` 四视图同源锁、镜像**没有裸 `/work`**（`ls /work` ⇒ No such file）、`worker.ts:1145-1149`（无挂载时 `evidence_failed: true` + 原因） |
| **D5** | 沙箱内无 `ping` | ❌ **不存在** | 镜像实测：`/usr/bin/ping`、`/usr/bin/fping`、`traceroute`、`mtr` 全在；技能也不教裸 `ping`（用 `arp-scan`/`fping`） |
| **D6** | 同一端口两次扫描结论互相矛盾（`664/tcp`） | ⚠️ **部分存在**（我们**没有任何**提示/可信度标注） | `port_scan` 的 summary 只有 `scanned/open_ports/hosts_up/ports_scanned` + "全 down"告警（`pentest-tool:1728`）；全仓无"开了但无版本信息""两次结果不一致"的提示；技能「判读与去噪」只覆盖 `open\|filtered` 与指纹冲突 |
| **§2.3** | 判据建议：开放端口数接近总数 ⇒ 带载荷复核，以"协议级应答"为准 | ⚠️ **部分存在**（同族判据有，这条具体形态没有） | `recon-network-surface` 有**伪影端口**基线探针（25/110/143 对任何地址都握手）⇒ 是同一家族；但**没有**"单目标全开/接近全开 ⇒ 端口状态系统性失真"的判据，也没有"静默端口（connect 后不对载荷应答）"的形态 |

## 逐条说明

### D1（我们这里**仍在**，且是我们最该补的一条）

- **文案同源**：`IntakePrompt.tsx:871-878` 就是他们引用的那句话（同一份实现），说明这张卡片的"读不到"分支是我们有意做的（外部审计 P0-4：把"读不到"与"没有待办"分开）。
- **堵死链路在**：`intakePromptFacts(status)` 在 `status.engagementId === null` 时返回 `null` ⇒ 组件走早退分支（只画说明卡）⇒
  **两个** `AdvanceAction` 落点（`IntakePrompt.tsx:570` 运行卡、`:943` Agent 会话里）都不会渲染；
  `HandoffPanel.tsx` 虽是"人类显式请求草稿"的专门面板，但**没有任何地方渲染它**（`panels.ts` 的注释也写明"交接编辑 → 已删除"）；
  作业列表面板（`EngagementList`）只有查看/筛选，没有推进动作。
  ⇒ 一旦进入该状态，人类**在界面上没有**推进阶段的入口；而 Agent 侧 `pentest_prepare_handoff` 的拒绝文案
  （`worker.ts:997`）又把人指回"点『进入下一阶段』"——**指向一个此刻不存在的按钮**。
- **触发条件（我们这里）比他们窄**：绑定是在创建会话时按 `dsh-<workerSessionId>` **确定性派生**并写库的（`core.ts:1338` + `dsh-session-factory.ts:320`），
  且全仓**没有** `update … set dsh_session_id`（无重绑路径）。所以我们这边出现"查不到绑定"基本只可能是：
  ① 库里的行由**别的版本**写出（格式/约定不同）；② 手工改库；③ 作业是在插件升级前后跨版本接力。
  他们那条是发布版部署，属于①的可能最大。
- **他们给的 4 条建议，我们一条都没实现**：① 启动时幂等对账并补绑定（没有）；② 卡片降级到作业的 `current_phase` 并保留按钮（没有，我们选择画说明卡）；
  ③ 拒绝文案给"绑定缺失"分支（没有）；④ 徽标与卡片同源（没有，我们只是在卡片上**说明**了两者不同源）。
- **最小可落地修法（建议顺序）**：
  1. **卡片降级**（改动最小、收益最大）：`engagementId === null` 时用**作业列表**里的当前作业渲染 `PhaseStrip` + 保留 `AdvanceAction`（`currentPhase`/`mainStatus` 从作业摘要取），把绑定异常降级成一条警告；
  2. **拒绝文案分叉**：`pentest_prepare_handoff` 的 next_action 里给出"若『进入下一阶段』按钮不可见：说明绑定缺失，请人类在控制台…（或先修绑定）"；
  3. **启动对账**：在既有 `reconcile` 里加一条"按 `dsh-<id>` 校验/补写绑定"的幂等步骤（它已经有 starting 行的对账框架）。

### D2（不存在，且是**结构上不可能**）

- 判据与文案读的是**同一次返回里的同一个数组**：`loadSkill` 先读 `pentest.worker_sessions.skill_ids`（会话创建时冻结），
  `loadedNames.includes(skillName)` 不通过才拒绝；工具层拼的"本会话装载的是：…"用的就是那个 `loadedNames`。
  ⇒ **"被拒的 skill 名出现在自报装载列表里"在我们这里不成立**。
- 现成锁（我刚跑过，全绿）：`test/skill-load.test.ts` 7 例，含
  "正例：已装载的 skill 返回正文，body/contentHash/revision 与库一致"、"反例：库里有但本会话未装载 → null，且不泄漏未装载项"、
  "冻结后被删除/被替换 → 拒绝并说明原因"。

### D3（不存在：已修 + 有回归锁）

- 活库实测：`pentest.memory_chunks` **20 列，无 `kind`**（kind 在 `memory_items` 上）。
- 代码注释直接点名这个 bug 形态（`pg-worker-tools.ts:715-722`："`kind` 在 `memory_items` 上（chunks 没有这一列）⇒ **每次零命中搜索都炸**"），
  修法与锁：`test/memory-search-diagnostics.test.ts` 3 例全绿（"零命中：返回带诊断的 note，而不是抛 column "kind" does not exist"）。
- 他们那条的**附带价值**我们也有：零命中返回**可执行诊断**（不是空结果）。

### D4（不存在：两侧同源；且失败会"开口"）

- 我们的挂载事实有**单一来源**（`mountsForWorker`）：容器 argv、`pentest_workdir` 的 roots、证据落盘根、抑制判据四处全部由它派生
  （`test/session-mounts.test.ts` 有"四视图同源"的跨切缝锁）。
- 镜像里**没有**裸 `/work`（不挂载时 `ls /work` ⇒ No such file）⇒ 不存在"目录在、登记不在"的伪装。
- `save_stdout_as_evidence` 在无挂载时回的是**结构化失败**：`evidence_failed: true` + 原因（`worker.ts:1145-1149`），不是"只在末尾一行提示"。
- 他们建议的"回落到会话级默认产出目录"我们**没做**（也不打算做：默认落盘目录会让"证据落在宿主哪里"变得不可预期）——这一条我建议保持现状并在文档里写明。

### D5（不存在）

- 镜像实测：`ping`、`fping`、`traceroute`、`mtr`、`nmap`、`nc` 都在（只有 `arping` 缺）。
- 技能侧的排查第一步用的是 `arp-scan`/`fping`（同网段二层，绕开 ICMP 过滤），不是裸 `ping`。

### D6 + §2.3（部分存在：这是**技能/工具的真缺口**）

- 我们有同族判据：`recon-network-surface` 要求先跑**基线探针**取三条环境属性（伪影端口 / NAT 源地址 / 出网），
  伪影端口那条正是在防"不存在的服务被写成资产"。
- 但**缺**他们这条更狠的形态：**单个目标**上"开放端口数 ≈ 扫描总数"（他们实测 1000/1000、200/200），
  以及"TCP 握手成功但不对任何载荷应答（不 banner、不关闭、只回数据）"——这两条都让**端口状态**这一维度整体失效。
  我们现在的技能会把 `open` 正常入账，`port_scan` 的 summary 也没有任何"比例异常"提示。
- 建议（低成本、与我们既有纪律同构）：
  1. 技能里加一条判据：`open_ports / ports_scanned` 超过阈值（如 ≥0.8）或出现"全开"时，**禁止**直接入账，先做带载荷的定向探测，
     以"**协议级应答**"（有 banner / 有协议回包 / 有 HTTP 状态行）作为真实服务面的判据，并把端口状态降级为"不可信维度"；
  2. 工具侧给一个**可判定的告警**（与既有 `warn: 没有任何主机被判为 up` 同一形制）：`warn: open_ports 占已扫端口 100%（1000/1000）——端口状态可能是伪信号，先做载荷复核`；
  3. 「常见失败」加一行：`同一端口两次扫描结论相反` ⇒ 记两条 + 标"端口维度不可信"，不要选择性引用其中一条。

## 附：本次核实用到的命令/证据（可复跑）

```bash
# D3：活库无 kind 列
docker exec dsh-pg-c psql -U postgres -d pentest -c "\d pentest.memory_chunks"
# D2/D3：现成的回归锁
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest' node --import ./test/helpers/tsx-loader.mjs \
  --test --test-concurrency=1 --experimental-strip-types --test-timeout=60000 \
  test/skill-load.test.ts test/memory-search-diagnostics.test.ts     # => 10/10 通过
# D5：镜像里的排查工具
docker run --rm --entrypoint bash 127.0.0.1:5005/pentest-tools:0.1.0 -c \
  'for b in ping fping traceroute mtr nmap nc; do printf "%-10s %s\n" "$b" "$(command -v $b || echo MISSING)"; done'
# D4：镜像里没有裸 /work
docker run --rm --network none --entrypoint bash 127.0.0.1:5005/pentest-tools:0.1.0 -c 'test -d /work && echo yes || echo no'
```

## 一句话结论

**D2/D3/D4/D5 在我们这里已经不存在**（其中 D3/D4 是过去几轮修过并有锁的），
**D1 与 D6/§2.3 仍然存在**：D1 是"绑定缺失时没有推进入口 + 文案过度承诺"的**流程缺口**（触发条件比他们窄，但缺的是同一套兜底），
D6/§2.3 是"端口状态这一维度整体失真时，我们没有判据也没有告警"的**技能/工具缺口**。两条都给了最小修法。
