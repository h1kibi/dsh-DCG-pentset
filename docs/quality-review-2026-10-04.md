# dsh-pentest 质量评估报告（2026-10-04）

> 方法：静态门禁 + 多轴代码审阅 + **活体端到端演练**（真实靶标、真实闸门、真实负向测试）。
> 全部结论都有可复现证据；凡未验证的一律列在 §6，不做推断性结论。

## 0. 结论摘要

**总体评价：这是一个工程质量显著高于同规模项目的系统**（5.5 万行 src + 3.7 万行 test，
无版本控制历史）。体系结构（双层账本、事件链哈希、RLS 强制、能力冻结、五阶段工作流）
是自洽的，注释密度与"为什么"的说明达到少见的水准；人类闸门在活体演练中按设计生效。

**但存在 3 个必修缺陷**，其中 2 个在**记忆面**（人类插话与报告事实不进检索索引），
1 个在**UI 遮挡**（常驻状态条吞掉宿主提问卡按钮的点击）。

| 维度 | 结论 |
|---|---|
| 正确性 | 主链路（范围→闸门→沙箱→代理→靶标→审计）**实证可用**；记忆面有两处静默丢弃（REQ-1/REQ-2） |
| 可读性 | 优秀：注释解释"为什么/边界/出处（§引用）"，命名即文档 |
| 架构 | 优秀：端口/适配器分层清晰，失败一律 fail-closed，降级都带标记（如 `lexical-only`） |
| 安全 | 优秀：三层防御（范围判定 → 沙箱 netns → 出口代理白名单）+ 逐次放行；负向测试通过 |
| 性能 | 未做压测；检索路径当前为 lexical-only（未配嵌入器），索引队列 0 死信 |

## 1. 门禁状态（本评估期间实测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | ✅ 通过（复跑于报告落盘前） |
| 全量测试 `npm test`（concurrency=1，**测试库 `pentest`**，跑前**停常驻服务**） | ✅ **1524/1524 通过**（0 skip）｜末次运行在代码评审两轮修复之后 |
| `verify:client`（客户端 bundle 契约） | ✅ 通过 |
| `verify:styles`（样式令牌覆盖） | ✅ 通过 |
| `verify:forward-migration`（前向迁移） | ✅ 通过 |
| `db:verify`（schema 校验） | ✅ 通过 |
| `build`（tsc build + tsdown + 字体嵌入） | ✅ 通过 |

## 2. 活体端到端演练（本轮新增的最强证据）

在个人档（`personal-lab` 租户、port 55446 的 `dsh-pg-c`）上完整走通一次作业：

```mermaid
flowchart LR
  A[人类确认范围 v1] --> B[情报收集会话 04470b15]
  B --> C[pentest_exec / http_read]
  C --> D[Docker 沙箱 172.29.0.3]
  D --> E[出口代理 pentest-lab-proxy:18080]
  E --> F[靶标 172.17.0.2:8000 → 200 OK]
  B -. 范围外 8001 .-> G[scope_violation 执行前拦截]
```

实测记录（可复现，命令见 §7）：

- **真实动作**：`pentest.tool_runs` 行 `402a6a84…`，`tool_name=pentest_exec`、
  `action_class=passive_read`、`status=completed`、`exit_code=0`；
  `result_json.stdout` 含 `exec_token_present: yes`、`proxy: http://pentest-lab-proxy:18080`、
  `status: 200`、`Server: SimpleHTTP/0.6 Python/3.10.21`、`redirect_hop: 0`。
- **代理层**：`[11:37:44] GET http://172.17.0.2:8000/ from 172.29.0.3 → 172.17.0.2:8000`。
- **审计链**：`human.authorization.confirmed → policy.snapshot.previewed → confirmed → frozen
  → execution.policy.checked → execution.pacing.applied → worker.report → worker.waiting_human`；
  `policy_decision = {plan_hash, policy_epoch: 0, scope_version: 1, approval_required: false}`。
- **负向测试（范围闸门）**：以人类插话指示读取 `http://172.17.0.2:8001/`（授权仅 8000），
  执行层在**动作前**拒绝并记录 `scope.violation {rule: port_not_allowed, rawTarget: http://172.17.0.2:8001/}`；
  代理日志无任何该请求痕迹（拦截发生在插件层，非代理层）；模型未重试、且把拒绝原文写入状态便签。
- **负向测试（出口白名单）**：代理层独立验证 `http://example.com/ → 403 Forbidden: not in EGRESS_ALLOW`；
  `172.17.0.2:8001 → 502`（代理按**主机**白名单放行，端口粒度归插件范围闸门——分层职责清晰）。
- **人机闸门流程**：intake 四问 → 模型发现「端口说明被填进允许动作」并主动追问复述 → 提交
  `scope_intake_proposals`（`pending`，目标 `172.17.0.2:8000/tcp`、`allowed_actions=["passive_read"]`）
  → 控制台预览「服务端将冻结的事实」+ 核对声明 → 人类确认 → 范围 v1 冻结、intake 会话 `closed`、
  情报收集会话创建并运行。
- **降级路径**：未配置嵌入器时 chunk 的 `embedding_revision='lexical-only'`、`embedding IS NULL`、
  `search_vector` 已生成（全文检索可用）——降级明确标注，不静默。

## 3. 必修缺陷（Required）

> **状态：三条均已修复并逐条验证（改动与证据见 §8）。** 以下保留原始描述用于追溯；
> 每条标题后的 ✅ 表示修复已完成、验证已通过。

### ✅ REQ-1 人类插话正文不进入账本 → 记忆面/审计面缺失

**现象**：插话送达模型正常（会话内可见），但账本事件 `human.interjection` 的
`payload_json` 只有 `{"woke":true,"delivered":true}`、`text_projection` 为空。

**证据链**：
- 写入侧：`src/workflow/sessions.ts:476` 与 `:542` —— `audit(..., 'human.interjection', { delivered: true [, woke: true] })`，
  **从不携带正文**。
- 分块侧：`src/memory/chunks.ts` 的 `ATOMIC_EVENT_KIND['human.interjection'] = 'human_input'`，
  `chunkAtomic` 只认 `payload.text` / `payload.content` / `text_projection` → 三者皆空。
- 实测：以真实载荷调用 `planChunks`（探针见 §7）→ **0 块**；库中 `memory_chunks` 共 1 行，
  含 "8001" 的块为 **0**（插话提到的端口在检索面完全不可见）。
- 契约不一致：`test/indexer-assets.test.ts:549` 用手工载荷 `{ text: '先停一下', target: … }`
  验证分块器——**测试与生产写入侧对同一事件类型的载荷约定不同**，因此 1511 个测试全绿也抓不到。

**影响面**：当轮送达不受影响；**跨会话/跨阶段检索与审计留痕受影响**——人类的关键指令
（如"跳过那个端口，它属于客户的生产系统"）在后续阶段 Agent 的记忆检索中不存在，审计也
无法逐字还原人类原话。设计 §8.5 明确「人类输入」应为一条事件一个逻辑块，故此为**实现与设计不符**。

**建议修复**：`sessions.ts` 的两处 audit 载荷带上 `text`（及必要的 `runId`/`turn` 元数据）；
补一条**写入侧载荷 → `planChunks` ≥1 块**的契约测试（不要把写入侧的 payload 在测试里手抄一遍）。

### ✅ REQ-2 报告的结构化字段不进记忆（三方漂移 + 工具 schema 无校验）

**现象**：情报收集 Agent 提交的结构化报告，只有 `summary` 进了记忆面；
`facts`（3 条高置信事实）、`hypotheses` 等**一条都没落块**。

**证据链**（`planChunks` 用真实载荷实测）：
```
worker.report payload keys: status,payload,summary,reportId,objective
  planChunks → 1 块：report_summary/summary=已完成单次被动 GET http://172.17.0.2:8000/…
  拆信封后 keys: facts,hypotheses,not_verified,next_steps_suggested → 0 块
  facts[0] 类型: object keys=fact,source,confidence
```
- **信封错配**：写入侧（`src/memory/pg-worker-tools.ts:1390`）写
  `{status, payload: <报告正文>, summary, reportId, objective}`，而分块器
  `chunkReport`（`src/memory/chunks.ts`）在**顶层**读 `summary`/`facts`/…。
- **形状错配**：`chunks.ts` 的 `ReportPayload` 声明 `facts?: readonly string[]`（字符串数组），
  而设计文档（`docs/dsh-pentest-plugin-design.md:1738-1775`）规定的是**对象数组**
  `{statement, confidence, source_refs[]}`；`readStringArray` 遇到对象直接过滤为空。
- **命名错配**：分块器读 `findings`，设计写 `candidate_findings`；模型本次自创了
  `not_verified`/`next_steps_suggested`（因为 **工具 schema 不校验**：
  `src/tools/worker.ts` 的 `pentest_submit_report` 入参是 `payload: { type: 'json' }`，
  描述只有一句"facts / hypotheses / candidate_findings 等"）。
- **违反设计自己的规则**：设计 §1738 后明确写了「校验规则：结构化字段符合 schema；
  所有引用存在且属于当前 engagement；候选结论必须带证据引用或明确标注为待验证」——
  实现里没有任何一层在做这件事，于是"形状错了"表现为**静默丢弃**（分块器返回 `[]`，
  队列任务照样 `done`）。这与仓库自身的纪律（`pg-memory-query.ts` 注释：
  「越界取值一律拒绝，不做静默忽略（§10.2.1）」）相矛盾。

**影响面**：报告事实是后续阶段（威胁建模/漏洞分析）最需要的检索材料；不落块意味着
**证据只能靠会话回放，检索面找不到**。本次演练里"200 OK / Server 指纹 / 目录列表"
这些事实在 `memory_chunks` 中不存在。数据本身没丢（`worker_reports.payload_json` 完整保留），
丢的是检索。

**建议修复**（三选一必须显式对齐，推荐前两项一起做）：
1. `pentest_submit_report` 补真实 schema 校验（对象形 facts/hypotheses + `candidate_findings`
   + `limitations` + `status_note`），非法载荷**拒绝**而非静默接受；
2. `chunkReport` 改为「先拆信封、再按对象渲染」：`fact`/`hypothesis` 拼成
   `陈述（置信度 x；来源: …）` 的文本块，`candidate_findings → finding`；
3. 补**写入侧载荷 → 分块 → 检索命中**的端到端契约测试（断言"报告里的事实可被 `memory_search` 命中"）。

### ✅ REQ-3 常驻状态条遮挡宿主提问卡按钮的点击区

**现象**：自动化点击宿主 `ask_user_question` 卡片的「下一题」按钮时被拦下：
`element is covered by div.pentest-statusbar`——**人类鼠标点击同一位置同样会点不到按钮**
（落在胶囊上，触发的是打开控制台）。

**证据链**：截图（提问卡 1/4 与状态条重叠）+ Puppeteer 遮挡报错；
代码：`src/client/index.ts:1246-1260` 把状态胶囊注册进宿主 **`shell.overlay` 悬浮槽**；
`src/client/styles/shell.ts:255` 胶囊是 `inline-flex` 且 `cursor:pointer`——
宿主弹窗（提问卡）出现时插件不做避让，悬浮层压在按钮命中区上。

**影响面**：问答是 intake 的主路径，卡片的操作按钮就在被遮挡的右下区域；
对鼠标用户表现为"按钮点了没反应"。绕过方式（我要继续自动化时用的）是 JS 直接触发 `click()`，
人类没有这个通道。

**建议修复**：悬浮层包裹元素 `pointer-events:none`（仅胶囊本体 `auto`）**并且**在检测到
宿主模态/提问卡（如 `[role=dialog]` 或宿主的问题容器）时收起或上移胶囊；
补一条 UI 冒烟（Playwright）断言"提问卡按钮可被鼠标点击命中"。

## 4. 可选改进（Optional / Nit）

| 编号 | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| OPT-1 | Optional | 注入的 preset 提示词说「**你的第一步是调用 `pentest_bootstrap_intake`**」，但控制台建单的 intake 会话工具面里**没有**它（`tools.restrict` 冻结的 6 个工具不含 bootstrap）。模型在轨迹里自述发现矛盾，靠能力快照自行恢复，**浪费了首轮推理** | `presets/pentest/agent.cordis.yml:57`、`src/agents/dsh-session-factory.ts:616/650`、`src/tools/worker.ts:322/627` + 活体轨迹 | intake 工具面补上 bootstrap（幂等：已绑定会话返回同一作业），或把预设改成"若本会话已由控制台建单则跳过" |
| OPT-2 | Optional | 观测双口径：**事件驱动索引不写 `index_watermarks`**（`dispatcher.ts:298 → indexer.ts:663` 无写水位；只有 drain/reindex 于 `indexer.ts:766/787` 写），控制台按"缺行即 0"渲染 →「索引队列 完成 20」旁边显示「索引水位 链序 0」；而 worker 工具的 `memory_search` 水位用的是 `MAX(chain_seq) JOIN chunks` 另一口径 | 实测 `index_watermarks` 空、chunks 非空；`src/memory/pg-worker-tools.ts:919-929` vs `src/memory/pg-memory-query.ts:966-994` | 统一为一个来源（建议让控制台复用工具口径），缺行时显示"事件驱动索引不维护水位"而不是 0 |
| OPT-3 | Optional | 实验室靶标 `python -m http.server` 的工作目录是容器根 `/`，响应泄漏整份文件系统目录列表（`.dockerenv`、`etc/`、`proc/`…） | 本次 `tool_runs.result_json.stdout.body_preview` | 实验室夹具（非插件）：启动加 `-d /srv/www` + 一个示例 `index.html`；RUNBOOK 同步 |
| NIT-1 | Nit | 提案 `scope_intake_proposals.authorization_note` 为空串（提交时模型未填），授权说明由人类在确认表单里补进 ROE 快照 | DB 实测 + `scope.snapshot.roeSnapshot.authorizationNote` | 可在工具描述里把"授权说明"标为建议字段，或在确认页显示"提交时未提供，已由人类补充" |
| OPT-4 | Optional | **套件与服务共库**：常驻服务运行时跑全量测试，`索引调度器（真实 PostgreSQL）→ drain：反复处理直到队列为空` 会失败（实测两次：`claimed` 期望 5、实际 2——常驻调度器先抢走了其中 3 个 `index_event` 任务并持有租约）；停掉服务后同一套件 **1511/1511 全绿**。规程已写在 RUNBOOK:754（"跑前先停常驻服务"），但该用例对并发领取没有免疫；**失败还会跳过清理**，在库里留下孤儿 `memory_chunks`（本次实测 3 行，其 engagement 已删；已手工清理） | `/tmp/qa-suite.log:3642`（`2 !== 5`）；复跑对照 1511 pass；孤儿行 `select ... where not exists (select 1 from engagements ...)` | 让断言对并发领取免疫（断言"本 engagement 的 5 个任务最终都被处理"而非"本次 drain 领取 5 个"）；清理路径改成失败也执行的钩子（或按 engagement 兜底清孤儿） |
| NIT-2 | Nit | 用户级环境变量 `PENTEST_DATABASE_URL` 指向 `pentest_app`（迁移 002 定义为 **NOLOGIN**）→ `node start-personal.mjs` 预检直接失败："password authentication failed for user \"pentest_app\""。启动器本身要求用**可登录的管理角色**连接、运行期 `SET ROLE` 降权（`start-personal.mjs:182-197` 有详细不变量说明） | 本机 `[Environment]::GetEnvironmentVariable('PENTEST_DATABASE_URL','User')` + 启动器报错原文 | 把该用户级变量改为管理角色连接串（如 `postgresql://postgres:***@127.0.0.1:55446/pentest_personal`），或启动时显式传入；RUNBOOK §4 可加一句这个坑 |
| NIT-3 | Nit | 重启后控制台回到**已确认过范围的** intake 会话时，自动建单被服务端拒绝并渲染红色横幅 `classification_rejected「该客户端任务已离开 intake 阶段，不能重新创建 intake」`——语义正确但呈现成错误噪音（人类此时该做的是从列表选中已有作业） | 实操截图（重启后打开「渗透作业」面板） | 客户端识别该错误码后改为中性提示："本会话的作业已进入下一阶段，请从上方列表选中它" |

> **状态：本表 7 条（OPT-1..4 / NIT-1..3）均已修复并逐条验证，见 §8.2。**

## 5. 已验证的强项（值得保留的设计）

1. **闸门在真实动作路径上生效**，不是文档承诺：范围外端口在执行前被拦，事件、模型行为、
   代理日志三方一致（REQ 之外最有价值的证据）。
2. **审计链与幂等**：`context_events` 逐事件哈希链、`plan_hash`/`policy_epoch`/`scope_version`
   随动作落库，`tool_runs(engagement_id, idempotency_key)` 唯一约束。
3. **fail-closed 贯穿**：`tools.restrict` 对未知工具名抛错并回滚整个会话创建；
   缺 `agentCtx`/`systemPrompt` 宁可创建失败；代理未命中白名单 403。
4. **降级显式**：无嵌入器 → `lexical-only` + tsvector；索引失败 → `lagging/failed` 标记而非阻断；
   outbox 有 `dead` 状态与死信可见（本次 0 死信）。
5. **测试夹具不吞错**（`test/helpers/cleanup.ts` 的注释即论证），RLS 强制开启且按角色分离
   （app/worker_ro/auditor）。
6. 注释质量：几乎每处非平凡决策都写了"为什么不那样做"，并引用设计 §。

## 6. 未覆盖（下轮评估建议）

- 放行队列全流程（`pentest_request_action_approval` → 控制台批准 → `approval_id` 复用与幂等）；
- 范围修订 v2 / `policy.epoch` 推进 / 在途动作撤销；
- 暂停·恢复·终止（本轮只实测了插话；终止不可逆未触发）；
- 交接（draft → 人工编辑 → 确认注入下一 Agent）；
- 报告审阅/签署（`reports` 版本化、`signed_by`）、记忆浏览器、公共记忆、Skill 库 UI；
- 阶段推进/回退/强制跳转的守卫；客户端懒加载与卸载降级、双租户隔离压测；
- 检索质量（当前 lexical-only；pgvector 路径需要配嵌入器后再测）；
- 长时运行的租约/心跳/恢复（`lease`/`recovery`/`heartbeat`）在故障注入下的行为；
- **按 `kinds` 精确过滤的集成级断言**（写入报告 → 索引 → `kinds:['fact']` 真取回）：现有锁是
  「共享读取器 + 消费端契约」两级单测，尚未有一条落库级断言（评审建议，见 §8.4）；
- **「令牌根必须出现在实际渲染里」的自动化断言**：`TOKEN_ROOT_SELECTOR` 清单与「CSS 里有令牌块」
  已被测试锁住，但没有任何测试渲染各入口去断言根类真的挂上了（R15 的假绿正是这个缺口），
  需要为每个入口补 SSR 夹具。

## 7. 复现命令（关键证据）

```bash
# 代理层：真实动作与负向
docker logs pentest-lab-proxy 2>&1 | tail
# 账本/执行/报告
docker exec dsh-pg-c psql -U postgres -d pentest_personal -x -c \
  "select tool_name,action_class,target_selector,status,exit_code,left(result_json::text,200) \
     from pentest.tool_runs order by started_at desc limit 1"
docker exec dsh-pg-c psql -U postgres -d pentest_personal -Atc \
  "select event_type, left(payload_json::text,120) from pentest.context_events \
    where event_type in ('scope.violation','human.interjection','worker.report') order by ingested_at desc"
# 记忆面：1 块、无 8001
docker exec dsh-pg-c psql -U postgres -d pentest_personal -Atc \
  "select count(*), count(*) filter (where content like '%8001%') from pentest.memory_chunks"
```

```bash
# 全量套件（正确姿势：① 用测试库 pentest ② 先停常驻服务，RUNBOOK:147/754）
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest' npm test
# 常驻服务（个人档）重启用管理角色连接串——用户级 PENTEST_DATABASE_URL 指向 NOLOGIN 角色会预检失败（NIT-2）
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest_personal' node start-personal.mjs
```

```bash
# 重放索引（活体验证「报告事实落块」；由常驻调度器消费；chunks 是派生数据，可重建）
ENG='91a40b63-0ade-4e2c-b859-0051cf170c67'
docker exec dsh-pg-c psql -U postgres -d pentest_personal -c \
 "insert into pentest.outbox_jobs (engagement_id, job_type, entity_id, idempotency_key, status)
  values ('$ENG','reindex_engagement','$ENG','reindex:manual:'||extract(epoch from now())::text,'pending')"
docker exec dsh-pg-c psql -U postgres -d pentest_personal -Atc \
 "select count(*) filter (where content like '%SimpleHTTP%') from pentest.memory_chunks"
```

**分块器探针**（.ts 文件会进 `tsc` 程序，用完即删；重建要点）：
`new pg.Client({connectionString:'postgres://postgres:check@127.0.0.1:55446/pentest_personal'})`
取 `context_events` 行 → 组装 `ChunkSourceEvent`（`payload: payload_json`）→ 调
`planChunks`（`node --import ./test/helpers/tsx-loader.mjs --experimental-strip-types <file>`）。

---

**环境状态备注**：为跑全量套件，本评估**停止过常驻服务**（`start-personal.mjs` + dsh :3090），
套件跑完后已用管理角色连接串重启并验证：控制台可访问（无 token 时 401，符合预期）、
`worker_sessions` 无孤儿、`memory_chunks` 无孤儿（重建后 2 行，均属现场作业）。
现场作业保留原样：`personal-lab` 租户、范围 v1、情报收集会话 `04470b15`
（engagement 处于 `worker_running`，控制台「渗透作业」可见）。

**本评估留下的两处可见痕迹（均无数据价值，可随时删）**：
- 重启服务后，控制台页面重载时按产品行为**自动建了一份新草稿** `未命名任务 web-17907735`
  （`auth_pending`，1 个 intake 会话，无提案）——这是「打开控制台即建单」的正常行为，
  不是脏数据，但它是本次冒烟的副产物。
- 现场作业的 `memory_chunks` 被**重建过两次**（`reindex_engagement`）：分块是派生数据，
  内容与账本一致（摘要 + 事实块，含置信度/来源注解）。

**工作区**：靶标容器已重建为 `-d /srv/www`（IP 仍是 172.17.0.2，内容挂载自 `C:/tmp/dcg-lab-target`）；
代理白名单未变（含 172.17.0.2）；用户级 `PENTEST_DATABASE_URL` 已清空（**需重启终端/宿主进程才对新进程生效**）。

---

## 8. 修复记录（当日完成，逐条带验证）

### 8.1 必修缺陷

**REQ-1 插话正文进账本**
- 改动：`src/workflow/sessions.ts` —— 新增导出构造器 `interjectionEventPayload({message, woke})`；
  运行中投递与等待人工唤醒两条路径都改用它，载荷含 `text`。
- 验证：
  - 契约测试 `test/memory-write-contract.test.ts`：构造器输出 → `planChunks` 恰好 1 块、
    `kind=human_input`、含原文。
  - 集成测试 `test/pg-workflow.test.ts`「插话唤醒」（**49/49**）：走真实 `service.interject()`，
    读**账本里的那一行**断言 `payload.text`，再把同一载荷喂 `planChunks` 断言落成块——
    这条链正是此前断裂的地方。
  - 实机观察：重启后旧 dsh 会话不再存在于新进程，插话被 `lease_revoked` 拒绝且**不落账本**
    （投递失败不写事件是设计使然）；因此 UI 级插话留待**新会话**验证，见 §8.3。

**REQ-2 报告结构化字段进记忆**
- 改动：
  - `src/memory/chunks.ts`：`chunkReport` 会**拆信封**（`{reportId,status,objective,summary,payload}`）、
    按对象渲染条目（`statement（置信度 x；来源: …）`）、接受 `candidate_findings` 别名，
    并兼容历史形状（`fact`/单数 `source`/字符串置信度）。
  - `src/tools/worker.ts`：`pentest_submit_report.payload` 从自由 JSON 换成设计 §13.4 的 schema
    （对象数组、`statement`/`title` 必填、`additionalProperties:false`）。
  - `src/memory/pg-worker-tools.ts`：写出账本载荷的代码抽成导出函数 `workerReportEventPayload`
    （写入侧与契约测试共用同一份，杜绝手抄形状）。
- 验证：
  - 契约测试：设计形状的五类分段各自成块，置信度/来源/严重度都在文本里；历史形状仍落块。
  - **活体**：对现场作业入队 `reindex_engagement`（常驻调度器消费，`done`）→
    历史报告（真实存量数据、旧形状）从「只有摘要 1 块」变成「摘要 + 事实块」。
    末次复核（清掉派生分块后重建）：事实块内容为
    `…返回状态码 200…（置信度 high；来源: pentest_exec http_read 直接观察，redirect_hop=0）`
    ——三条事实各自带出来了置信度与来源。

**REQ-3 状态条不再遮挡宿主按钮**
- 改动：`src/client/surfaces.tsx` —— 新增纯函数 `hostAskingVisible`
  （`[role=dialog|alertdialog]`、`button[role=radio|checkbox]`、自家 `.pentest-proposal__ack`）
  ＋ MutationObserver 钩子；问人期间 `pointer-events:none` + `opacity .4` + `tabIndex -1`
  （视觉仍在，点击穿到宿主卡片）。
- 验证：
  - 单测：谓词对 5 种选择器 × 可见/不可见；让位态渲染含 `pointer-events:none` 且仍显示作业名。
  - **活体**（真实页面）：无提问控件时 `pointer-events:auto` → 注入 `button[role=radio]` 后
    变 `none` → 移除后恢复 `auto`。

### 8.2 可选与 Nit

| 编号 | 改动 | 验证 |
|---|---|---|
| OPT-1 | `presets/pentest/agent.cordis.yml`：bootstrap 写成**条件步骤**（工具面里没有它 = 已由控制台建单 → 直接开始） | 静态文本；能力快照与提示词不再互相矛盾 |
| OPT-2 | `src/memory/pg-memory-query.ts`：`memoryWatermark` 改与 worker 工具同口径（`context_events ⋈ memory_chunks`），`occurredAt` 同源 | `test/pg-memory-query.test.ts` 两情形：未索引 → 滞后 3；已索引 → 滞后 0 |
| OPT-3 | 靶标重建为 `-d /srv/www` + 宿主目录只读挂载（index/robots/evidence）；RUNBOOK §6.5.3 从 3 条增为 4 条 | 直连与经代理均 200，**不再是目录列表**；代理日志留痕 |
| OPT-4 | `test/dispatcher.test.ts` 断言改「最终状态」+ `waitFor`；`test/helpers/cleanup.ts` 补第二轮迟到写入扫描 | **服务运行中**跑该文件 16/16（改前同条件必红）；RUNBOOK §7 记录失败形状与孤儿残留 |
| NIT-1 | `src/client/views/SessionChat.tsx`：授权说明为空时提示出处（Agent 只提交目标与动作范围） | 客户端 SSR 测试集合通过 |
| NIT-2 | 删除用户级 `PENTEST_DATABASE_URL`（指向 NOLOGIN 角色）；RUNBOOK 增「坑 4」 | 变量已清（User 级读回为空）；服务用显式管理连接串重启成功。**注**：已运行的宿主进程仍持有旧值，重启终端/宿主后生效 |
| NIT-3 | `src/client/controller.ts`：`draftRejectionMessage` 把「已离开 intake」的拒绝译成中性提示，其它码原样透出 | 单测 1 条（译法 + 三个不译反例） |

### 8.3 复核与边界

- `npm run typecheck` ✅ ｜ `npm run build` ✅（个人档加载 `lib/`，必须重建）｜
  全量套件（**测试库 `pentest`**、跑前停服务）**1524/1524 通过**（exit=0）。
- 新增/扩展的测试：`test/memory-write-contract.test.ts`（新文件，5 条契约）、
  `test/pg-workflow.test.ts` 插话用例扩展、`test/dispatcher.test.ts` 断言改造、
  `test/client-surfaces.test.ts`（+2）、`test/client-controller-params.test.ts`（+1）、
  `test/pg-memory-query.test.ts` 水位用例重写。
- **仍未做**：UI 级（模型在环）插话与新 schema 的实机验证——需要一条**本进程内**的活会话；
  服务重启后旧会话必然失效，而启动新会话要走交接/向导（会烧模型额度）。服务侧已有
  集成测试覆盖同一段代码路径（§8.1 REQ-1），报告如实记录这一边界。
- 一次性脚手架（`.qa-*` 探针脚本）未留在仓库；活体冒烟用到的重放索引入口见 §7。

### 8.4 代码评审轮（对 §8.1/8.2 改动的对抗性审查）

独立评审（只读 subagent，按 code-review-and-quality 的五轴口径）给出 verdict
**`approve_with_required_changes`**，共 9 条发现；逐条修复后由同一评审复核（第二轮 9/10 通过，
唯一未通过的一条给出更精确机制后已闭环）：

| # | 级别 | 发现 | 修法 |
|---|---|---|---|
| R1 | **Critical** | 检索侧「按内容回推分块种类」（`deriveChunkKind`）自带一份私有读取器：只读顶层、只认字符串条目、不认别名 → 信封+对象形状的报告全部回退成父种类 `report_summary`；而 `kinds` 是精确过滤，**刚修好的事实块按 kind 取不到** | `chunks.ts` 导出唯一读取器 `reportSectionTexts`；两份私有副本删除、两个消费端改为导入；补一条**消费端锁**（吃账本原样信封，逐分段还原成自己的种类） |
| R2 | Required | `lagEvents` 用「事件类型在不在可分块集合里」近似「确实会落块」→ `handoff.*` 类型在集合里却无正文、永不落块 → 控制台永久 attention「滞后 N 条」 | 判据改为**规划器**（`planChunks`，与索引器同一份）：扫水位之后的尾部、数「能落块却没落块」的事件；并补上交接事件的 `text`（§8.5 把「交接」列为记忆来源，此前从不进检索面——`retrieval.test.ts:662` 早就假设它带 `text`）。测试补 (c) 控制面事件、(d) 可分块类型但空载荷两例 |
| R3 | Required | payload schema 仍缺设计 §7.1 的 `engagement_id/agent_session_id/phase`（`additionalProperties:false` 下照抄示例会被整份拒绝）；**我的守护测试手抄了不完整示例**（假绿） | 补齐三字段；守护测试改为**从设计文档 §7.1 的 json 代码块解析**示例并断言「示例每个键都在属性表里」 |
| R4 | Required | `useHostAsking` 的 rAF 合并 ≈60 次/秒全文档查询（token 流热路径）；卸载后仍可能 setState | 改 200ms leading+trailing 节流 + cleanup 取消挂起定时器 |
| R5 | Optional | 选择器会命中**自家** `RunControls` 的 `role=radio` 阶段按钮（打开控制台就让位） | `button[role=radio/checkbox]` 分支排除自家 UI 根；对话框与自家确认卡仍让位 |
| R6 | Optional | 无可识别正文的对象条目静默丢弃，与「不静默丢弃」的注释矛盾 | 保留行为但注释澄清为有意取舍（账本原文仍在、schema 先拒、这里兜历史事件） |
| R7 | Optional | `affected_assets` 收进 schema 却不进分块文本 | 补 `受影响: …` 注解（`reproduction_plan` 不进文本属有意裁剪） |
| R8 | Optional | 拆信封「全有或全无」，与 summary 的跨层回退不一致 | 改为**逐分段回退**（嵌套优先、空则顶层） |
| R9 | Optional/Nit | 拒绝改写匹配过宽；hint 绑定 props 导致非空分支不可达 | 匹配收紧为「intake + 离开」两个记号同时命中（补反例）；hint 改用本地输入状态 |
| R10 | Nit | 两份 `deriveChunkKind` 仍是复制粘贴 | 抽成 `chunks.ts` 的单一导出实现，两处导入（逆索引、分段匹配、兜底一并共享） |
| R11 | **Critical**（评审轮活体检查新发现） | **lexical-only 部署的记忆检索恒 0 命中**：没有嵌入器时索引把分块写成 `embedding_revision='lexical-only'` 且**不登记** `embedding_revisions` 行；检索的活跃版本过滤写作 `mc.embedding_revision = (SELECT revision … WHERE is_active)` —— 右侧为 NULL、恒不相等，于是**每一次检索都返回 0 条**，而索引、水位、队列全部显示正常（个人档活体：记忆浏览器查 `SimpleHTTP` 0 命中，而分块就在库里；`pg-memory-query.test.ts` 种子注释「否则分块一条都查不到」正是长期绕开它的痕迹） | 过滤条件加 `NOT EXISTS(活跃版本行)` 守卫：没有活跃版本就不过滤（没有「旧版本」可谈）；登记后照原样生效（新版本激活后旧的 lexical-only 分块被挡住，与 §9.1「不原地解释旧向量」一致）。新增用例锁住两态（无版本→可见；有版本→旧版本不可见），活体复核：同一查询命中事实块 |
| R12 | **Required**（人类在实机使用中报障） | 授权会话的输入区用 `position:sticky;bottom:0`，而它的**最近滚动祖先是外层主面板**（记录流 `.pentest-session-chat` 是它的兄弟、不是祖先）→ 输入框脱离原位、悬在面板底部，**随面板滚动在会话记录之间穿梭** | 去掉吸附（回到正常文档流）：记录流自己滚（`max-height` + `overflow-y:auto` 本来就有），输入区作为其后的兄弟原地不动。锁两条：CSS 规则不得含 `sticky/fixed/absolute`；DOM 上输入区必须在记录流**闭合标签之后**（按 div 深度扫描断言，防「把输入框塞回记录流」）。**活体量测**：滚动记录流时位移 **0px**、滚动面板时位移 −200px（正常随动）、计算样式 `position: static` |
| R13 | Optional（R12 同屏的连带问题） | 面板打开时，常驻状态胶囊 `fixed` 在屏幕下方居中，**压住面板内容**（实测压住授权会话输入框的首行），而此刻它本就冗余（唯一的动作就是打开面板） | 让位判据扩展为「宿主在问人 **或** 主面板已打开」（`statusPillShouldYield`），面板打开时胶囊 `pointer-events:none` + 变暗；补三态断言 |
| R14 | **Critical**（人类实机事故：`lease_revoked: intake 会话或租约已不可用`） | **聊天路径的 intake 会话没有被能力冻结**：插件只能在自己创建的会话上 `tools.restrict`，而 bootstrap/聊天路径接管的是**人类已有的 dsh 会话**——实测该会话自报工具面 = 全部 7 个 `pentest_*` 工具（含 `submit_report`/`exec`）。于是模型「顺手收尾」调用了 `pentest_submit_report`，而**服务端没有 intake 闸门**：报告被接受 → engagement 离开 `auth_pending`（变 `waiting_human_review`）、会话离开 `active`（变 `waiting_human`）→ intake 的唯一出口 `request_scope_confirmation` 的三条前置（`auth_pending` + `active/paused` + 租约未过期）全部不再成立 → 人类既改不了口径也确认不了旧方案（10 分钟 TTL 到期只是压垮它的最后一根稻草：人类思考时间不受 TTL 约束） | ①`submitReport` 增 **intake 闸门**（`classification_rejected` + 指向 `pentest_request_scope_confirmation`），即使宿主工具面没收窄也不可能再发生；②`requestScopeConfirmation` 的判据对齐 intake 的真实状态集（`auth_pending`/`waiting_human_review` × `active`/`paused`/`waiting_human`）并对**过期**租约豁免（只要求租约存在）；③`confirmScopeProposal` 同样只把「从未签发/被吊销」当拒绝，**过期**放行（人类闸门才是控制，租约在 intake 只作登记证据）；④`pentest_submit_report` 描述写明「仅阶段会话」。新增 2 条服务级回归锁（intake 提交报告被拒且零报告行；卡死形态下提案仍可提交、而阶段会话的过期租约照旧拒绝） |
| R15 | **Required**（人类实机反馈：「太难看了」；真因是 bug 不是审美） | 聊天里的范围方案卡**从来没有令牌根**：`.pentest-chat-card` 只存在于 `TOKEN_ROOT_SELECTOR` 清单与「令牌块挂在每个渲染入口上」的断言里，**没有任何组件挂这个类**（`grep` 全仓只在 `design.ts` 出现）。没有根就没有 `--pt-*` ⇒ 卡片上每个 `var()` 都落空 ⇒ 边框、底色、配色、勾选行的 amber wash 全部消失，看起来像没上样式的裸 HTML（人类截图即此）。**既有的守护测试是假绿**：它只断言「清单里含该根」+「CSS 里有令牌块」，没有断言**渲染出的入口真的带着这个类**。 | ①聊天入口（`IntakePrompt`）的返回包一层 `.pentest-chat-card`；②动作胶囊底色改 `--pt-bg-well` 以提高在模块面上的对比；③活体验证机制：把同一标记注入真实页面、加上根类后 `--pt-line` 立即解析为 `#16222F`、胶囊拿到边框与底色（反向证明「缺根 ⇒ 无样式」）；④**遗留**：仍没有自动化断言「每个令牌根都出现在实际渲染里」（需要渲染各入口的 SSR 夹具），已登记进 §6 |
| R16 | **Required**（实机，直接卡住当前作业） | **代理白名单不含本次目标**：`EGRESS_ALLOW=172.17.0.7,172.17.0.2`，作业目标是 `47.109.76.66`；代理日志实测 `403 Forbidden: 47.109.76.66 not in EGRESS_ALLOW` ⇒ **任何**探针都到不了目标，而 Agent 会把 403 误读成「服务未识别/目标不可达」。RUNBOOK §6.5.3 第 1 条已有处置规程（改白名单并重建代理），但**确认范围时没有任何校验**——人类点确认时没人告诉他这个目标根本出不去 | 环境侧按 RUNBOOK 重建代理并把目标加进白名单；**产品侧建议**：确认预览里对每个目标做一次「在 `EGRESS_ALLOW` 内吗」的提示（启动器已有同类预检，确认路径缺） |
| R17 | **Required** | `pentest_request_action_approval` 的工具描述写着「裸 TCP 类模板（`tcp_connect`）连不到任何目标」——**过时且错误**：工具脚本的 `open_tunnel` 会经代理建 CONNECT 隧道并读 banner（可用）。实测后果：Agent 据此宣称「TCP 在本部署不可用，只能用 HTTP 做服务识别」，把能力说小、方案被迫降级 | 改写描述：`tcp_connect` **可用**（经代理隧道 + 读 banner）；真正不可用的是 `udp_probe`/`icmp_ping`（代理只隧 TCP） |
| R18 | **Required**（安全相关的表述） | 预设在收集「允许动作」时没给动作类别的**真实含义**，于是模型把 `passive_read` 复述成「不向目标发流量」（实机原话），而 `http_read` 模板（一次真实 HTTP GET 到目标）正是 `passive_read`——人类可能在「以为没有流量」的前提下批准会到达生产服务的请求 | 预设补一节「问允许动作必须按真实含义说」：`passive_read`＝只读请求（HTTP GET/DNS），**流量会到达目标**、只是不改远端状态；`active_discovery`＝端口/服务识别；复述时要写清「发多少、什么样的请求」 |
| R19 | Optional（人类实机：复制出的消息夹着 `[13;28;13;1;0;1_`） | 账本里查不到这些序列（`context_events` 0 行）⇒ 不是领域事件带出来的；形状像宿主的内联进度/锚点标记混进了消息文本。我们的会话记录投影此前**原样透出**，于是控制台也会显示并复制出这些垃圾 | `session-chat.ts` 的唯一文本出口加 `stripControlSequences`（CSI、其它 ESC、丢了 ESC 的裸坐标标记、其余 C0；保留 `\n\t`），并有「不误伤 `[1]`/`[2026-10-04]`/`[note]`」的测试 |
| R20 | **Required**（人类反馈：「怎么还要手动加白名单，这不麻烦吗」） | 出口白名单此前**只能人工维护**（自己 `docker inspect` 看值 + `docker rm -f` 重建），可它是「已确认范围」的**机械投影**——忘了同步的代价是所有探针 403（R16 实机踩到）。设计文档 §6.5.3 本身也把静态白名单列为第一轮权宜（「进生产前仍必须换成在连接时刻做范围/地址/鉴权/审计裁决的代理」） | 新增 `src/execution/egress-allowlist.ts`：`egressHostsForScope()`（范围→主机，纯函数：URL 取 hostname、`asset-label` 跳过、排除项优先、端口不进白名单）+ `syncEgressAllowlist()`（读现有容器规格 → **只换 `EGRESS_ALLOW`** 重建 → 把 `--internal` 网络接回；**只增不减**，人类设的基础设施条目不许被删；读不到容器就明确失败并指向 RUNBOOK，不静默）。`compose.ts` 接线：`confirmScopeProposal` / `amendScope` 成功后自动同步；失败不阻断确认，日志写清后果。测试 5 条（假 runner，断言发出的 docker 命令与「只换一个变量」） |

### 8.5 第二轮代码评审（对出口白名单自动同步 / intake 闸门 / 卡片修复）

先自审一遍、再由独立评审复核（verdict 仍是 `approve_with_required_changes`）。**自审抓到 1 条
Critical，评审抓到 4 条 Required + 6 条 Optional/Nit**，全部已修：

| # | 级别 | 发现（谁抓到） | 修法 |
|---|---|---|---|
| S1 | **Critical**（自审） | `withEgressSync` 用 `{...inner, …}` 包装**类实例**：对象展开只复制**自有可枚举属性**，而方法在原型上 ⇒ 除两个包装方法外，控制台**所有** `workflow` RPC 在运行期变成 `undefined`（TS 的展开类型是乐观的，编译期看不见） | 改 **Proxy + `bind(target)`**（`this` 正确、私有字段可访问），方法身份缓存；把包装器抽到模块里**可测**，加四条断言：原型方法可用 / 私有字段可达 / 方法身份稳定 / 原实现抛错时**不同步** |
| S2 | **Required**（评审） | intake 的**过期租约豁免只覆盖「未清扫」那一态**：心跳 `expireLeases` 一旦写 `revoked_at=now(), revoked_reason='expired'`，`#session` 的第二段（`revoked_reason !== null`）与 `requestScopeConfirmation` 的 LATERAL（`revoked_at is null`）双双拒绝 ⇒ **差一个心跳 tick 又卡死**（正是本次要修的事故）；而测试夹具只造未清扫形态（假绿） | 两处改成同一条三态判定（先算 `expired`，非到期吊销才拒；LATERAL 不过滤 `revoked_at`）；测试补**清扫形态**（删旧行→插已过期→标记清扫）后再提交提案的用例 |
| S3 | **Required**（评审） | 令牌根只包住「有方案」一条 return，其余四条 early return（放行卡 / 阶段条 / 运行卡 / 放行读不到）仍是无令牌裸块 | 根提到组件最外层（`IntakePrompt` 变薄包装，原体改名 `IntakePromptBody`）；加「首帧没有数据时根仍在」的渲染断言（证明根与分支无关） |
| S4 | **Required**（评审） | 重建代理只复制 7 类字段却宣称「只改一个变量」：`--cap-drop` / `--security-opt` / `--read-only` / `--user` / `--tmpfs` / `--dns` / `--add-host` / `--device` 会被**静默丢掉**——安全边界被放宽 | 这些字段按 inspect 原样复制（含 `Tmpfs` 的 map 形态）；剩余不支持的项在**重建前**列名告警；测试断言 cap-drop/security-opt/read-only/tmpfs 出现在命令里、`PidsLimit` 出现在告警里 |
| S5 | Optional×3（评审） | ① `target[name]?.()` 把装配错位变成「静默成功 + 结果 undefined」；② 非默认拓扑（容器没连 `bridge`）会把内网 `connect` 两次而每次失败回滚；③ `traceTranscript` 是**第二条文本出口**且不过滤控制序列 | ①缺方法即**抛装配错误**（有测试）；②`reattach` 排掉 primary（有测试）；③`clip()` 先剥控制序列再截断（先剥后截，避免半条序列留下） |
| S6 | Nit×3（评审） | cidr 注释与实现相反；预设把 `active_discovery` 说成含 UDP/ICMP（与 `worker.ts` 矛盾）；白名单条目不做大小写归一（语义未变也触发一次重建） | 三处都改；**网段条目**在 compose 钩子里显式 `console.warn`（代理表达不了网段，别等人踩 403 才发现） |

评审复核确认无问题的点（记录以备复查）：`submitReport` 的 intake 闸门与租约豁免**不外溢**到目标动作
（`pentest_exec` 走执行服务，不经 `#session`；`allowExpiredLease` 默认 false）；`confirmScopeProposal`
冻结范围用的是 `input.targets/exclusions`，与确认钩子推导白名单同一份入参 ⇒ 白名单与库里的范围版本不会分叉。

评审确认修好但**未做**的一项：两条读路径的**集成级**断言（写入报告→索引→`kinds:['fact']` 真取回）
没有加；现有锁是「共享实现 + 消费端契约」两级单测。已在 §6 未覆盖清单里登记——
**但 R11 的活体复核顺带覆盖了它的一半**：修复 lexical-only 过滤后，在真实控制台里用
「记忆类型 = fact + 查询 `SimpleHTTP`」检索**命中 1 条**，类型标注为「观测事实」（= `fact`，
修复前这条会落到「报告摘要」），内容即现场作业的事实块（含「置信度 high；来源: …」）；
同屏索引诊断显示 `链序 15 / 滞后量 已追平 / 状态 就绪`。这一屏同时证明了 R1（回推吃信封）、
R2（滞后归零）与 R11（lexical-only 可检索）三条修复在**真实部署**上生效。
