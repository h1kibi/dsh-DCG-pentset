# 沙箱工具规范 v1（2026-10-11）

**为什么要这份规范**：七轮实测反馈（`RUNBOOK.md` §6.5.9–§6.5.13.7，42 条）与 2026-10-11 的质检
（`docs/quality-review-sandbox-tools-2026-10-11.md`，16 条）指向同一件事——**每个动词各自发明自己的
参数读法、输出形状与失败形态**，于是"看起来正常的失败"成了默认结果。本规范把**七条**定下来，
凡是与本规范冲突的既有实现，按本规范改。

适用范围：`docker/tools/pentest-tool`（容器侧动词）、`src/execution/templates.ts`（声明面）、
`src/execution/docker-sandbox.ts`（宿主 argv/结果映射）、`src/tools/worker.ts`（工具面）、
以及一切渲染给模型的文本（简报/参数指南/阶段档案/技能）。

## 1. 参数读取：一处读法，拼错即拒

- 每个动词的每个参数**只经统一助手**读取，助手按类型固定语义：

  | 助手 | 语义 |
  |---|---|
  | `param_required(params, key)` | 缺失/空串 ⇒ rc=2 `usage_error` |
  | `param_optional(params, key)` | 缺失 ⇒ 默认值 |
  | `param_enum(params, key, allowed, default)` | 取值必须在 `allowed`，否则 rc=2 并**列出合法值** |
  | `param_bool(params, key, default)` | 只接受 `true`/`false`（**大小写不敏感地归一，但不接受** `1/0/yes/TRUE ` 这类近义值而未声明） |
  | `param_int(params, key, low, high, default)` | 越界 ⇒ rc=2，消息带范围 |
  | `param_list(params, key, sep=',', low=1, high=N)` | 空项/空列表 ⇒ rc=2（**不允许"空列表 = 0 结果 + rc 0"**） |

- **位置参数**（`target=`/`port=` 这类主目标）必须显式声明键名；不允许靠位置猜。
- **未知键一律拒绝**：`parse_command` 解析完全部键值后，对每个动词取"声明过的键集合"，多出来的键
  ⇒ rc=2，消息列出接受的键。**禁止静默忽略**（历史漂移的主因）。
- 校验失败的消息必须包含三样：**哪个键**、**收到了什么**、**合法取值/范围**。

## 2. 输出形态：每条命令必须自报状态

- 输出的**第一行固定为 `state:`**：`state=ok` / `state=failed` / `state=no_target` /
  `state=aborted` / `state=partial`。
- 其后是 `summary:` 行（机器可读、`key=value` 空格分隔），再后是逐条明细行（`path<TAB>…` 等）。
- **"没扫"与"扫到 0"必须不同形**：
  - 没扫（范围为空、参数为空、被 deadline 提前终止）⇒ `scanned=false` 且给出原因；
  - 扫完是 0 ⇒ `scanned=true` 且计数为 0。
- 任何**阴性结论**（0 命中、0 端口、无记录）必须能回答"你扫了什么、扫了多少"：
  `attempted=` / `total=` 至少给一个。

## 3. 覆盖度：有规模上限就必须自报

凡是有"总量"的动作（字典条数、路径条数、主机数、记录类型、脚本数、结果条数），输出必须给：

| 字段 | 含义 |
|---|---|
| `<x>_total` | 本次任务的总量（字典行数、路径条数…） |
| `<x>_attempted` | 实际尝试数 |
| `<x>_truncated` | 是否被截断（`true`/`false`，**必须显式**，不得靠"数字看起来小"推断） |
| `<x>_remaining` | 还剩多少（可续跑时的续跑依据） |
| `<x>_listed` | **已列出**的条数（当输出有"只列前 N 条"的截断时用它，不必假装是 `_attempted`）——与 `_total`/`_truncated` 配套：`listed < total` 或 `_truncated=true` 就是"没列全" |

> **预算耗尽的表达**（2026-10-11 定，与容器侧一致）：动词跑到钱包/时间用尽但**已拿到部分结果** ⇒
> `state=partial` + `<x>_truncated=true` + `rc=0`（结果可用、覆盖不完整）；**一个都没跑** ⇒
> `state=aborted` + `rc=1`。两者都不许写成 `state=ok`。

**分段/续跑**：总量超过单条命令可调度量时，参数面必须提供分段（如 `entry_range=A-B`），且每次返回
自证"从第几条跑到第几条"。**不允许出现"数学上不可调度且不告知"的组合**。

## 4. 退出码：三档，宿主必须消费

| 码 | 含义 | 宿主映射（`mapOutcome`） |
|---|---|---|
| 0 | 成功（**含"扫完是 0"**；截断但跑了也算成功，用 `*_truncated` 表达） | `status: completed` |
| 1 | 运行时失败（工具自身错、目标不可达、内部异常） | `error.code: 'tool_failed'`（**不得记成 completed**） |
| 2 | 用法错误（参数缺失/越界/未知键/非法取值） | `status: blocked` + `code: 'usage_error'`（带 `expected_values`），**不得记成 completed** |
| 3 | 输出被截断（**动词本身成功、只是容器字节预算被截**） | `status: completed` + `truncated: true`（**不是失败**；截了什么由容器侧 `state=`/summary 说明） |

> **容器的实际可用墙钟 = `cap − min(15s, cap/5)`，其中 `cap = min(注入值, 天花板表值)`，下限 1s**
> （2026-10-11 与容器侧约定）。理由：容器把报告改成"先缓冲、末行一次写出"（首行必须是 `state=`），
> 若跑到注入上限才收尾，宿主的 SIGKILL 会让**整份报告**消失，所以容器必须留收尾裕量；但**固定 15s
> 会把短动词砍废**（30s 的 `dns_enum` 只剩一半、5s 的 `dns_resolve` 只能压到 1s 下限），因此按比例取。
> 实测：120s→105s、30s→24s、20s→16s、8s→6.4s、5s→4s。**规划长任务按 `注入值 × 0.8` 估**；
> 模板 `timeoutMs` 与天花板表的值**不动**（对拍锁不受影响）。

- 容器**必须**对 rc=1/2 打印 `state=failed`/`state=no_target`（用法错误由 `parse_command` 直接打印
  `usage_error:` 并以 rc=2 退出）。
- `internal_error:` 前缀**只用于真正的 bug**；出现它即视为 P0 缺陷（应当能被行为锁抓住）。

## 5. 超时/中止：保留已产出的一切

- 子进程超时/被中止时，**必须**返回它已经产出的 stdout/stderr（Python 的 `TimeoutExpired.stdout`），
  并在 `summary` 里标 `aborted=true` 与 `aborted_items=N`（跑到第几条停的）。
- 有总预算的动词必须自持 deadline（`monotonic()`），不得依赖宿主的 SIGKILL。
- 宿主侧：`timed_out`/`cancelled` 的结果**照常落盘为证据**（已有），并标 `partial_output: true`（已有）。

## 6. 拒绝载荷：合法取值必须到模型手里

- 宿主侧的一切拒绝（服务层 `PgWorkerToolRefusal`、宿主准入、限额）必须作为 **`blocked` 载荷**
  交给模型：`{status, code, message, next_action, expected_values?}`；**不得只抛异常**——
  异常的 `message` 里没有 `next_action`，而合法取值恰恰在那里（实测：`kinds` 被拒时模型拿不到
  `CHUNK_KINDS` 列表）。
- 工具层负责把服务层异常**统一转成载荷**（一个 catch 点，而不是每个工具各写一遍）。

## 7. 命名与单一来源

- **容器侧**统计字段：`snake_case`，后缀有固定语义——`*_total` / `*_attempted` / `*_truncated` /
  `*_remaining` / `*_baseline` / `*_source` / `*_kind_counts`。同一含义在不同动词里必须同名。
- **宿主侧** JSON 字段：`snake_case`；标志类用 `<x>_failed: true`；路径类用 `<x>_path`
  （容器路径 `*_container_path`、宿主路径 `*_host_path`）；标识类用 `<x>_id`。
- **文本单一来源**：渲染给模型的任何"数字型事实"（超时/限额/速率/档位名/词表）与参数说明，
  必须从代码里的**唯一来源**渲染（注册表/契约常量）；手写第二份即视为缺陷。
- 技能（`skills/**`）只能引用这些来源的**名字**，不得复述数字（避免下一次轮换时全库漂移）。
- **遗留别名（已删除）**：`content_discover` 的 `entries_scanned=`（与 `entries_attempted=` 同值）
  已于 2026-10-11 第八轮镜像变更**删除**——引用计数当时为 0（测试与提示词都改用 `entries_attempted=`）。
  这条留着是给排障用的：旧报告里若出现它，说明那份报告出自更早的镜像。

## 8. 规范的可验证性（锁）

规范不是愿望，每条都要有对应的锁（见 `test/action-templates.test.ts` 与新增的规范锁文件）：

| 规范条 | 锁 |
|---|---|
| §1 参数读取 | 纯函数边界对拍 + "未知键必须 rc=2" + 每个动词声明键集合 vs 读取调用点 |
| §2/§3 输出形态 | 每个动词的 argv 冒烟（断言首行 `state=`、`summary:` 存在、无 `internal_error:`） |
| §4 退出码 | 分发器 rc 约定 ↔ `mapOutcome` 映射锁（0/1/2/3 四档） |
| §5 超时 | 构造"超时且已有 stdout"的场景，断言产出被保留 |
| §6 拒绝载荷 | 工具层 catch 的锁（异常 → blocked 载荷，含 expected_values） |
| §7 命名/单一来源 | 字段名集合对拍 + "提示词里的数字 == 注册表里的数字"锁 |
| 全部 | 静态断言：分发器无 used-but-undefined 名字、无 `is False` 链式比较 |

## 9. 与既有设计的关系

本规范不改变设计文档里的**硬边界**（范围裁决、逐动作放行、一次性容器、证据链）；它约束的是
**工具的接口面**（参数/输出/失败/命名）——即"人与其 Agent 之间那层可判定的契约"。

## 9. 2026-10-11 操作者实测的五条（本轮新增的参数与字段）

本轮反馈来自一次真作业（Next.js SPA 靶站）。五条都按"**改工具，不改口径**"处理：新增的东西只有下面这些，
名字与语义一并登记在这里（`§7 单一来源`：字段名要能被检索到，不能只活在代码里）。

### 9.1 `http_probe page=`（取哪一页）
- 语义：抽取（`collect=endpoints`）与 chunk 跟随都以这一页为对象；空串 = 站点根 `/`。
- **为什么需要**：SPA 上路由**自己的 chunk** 才含 API 调用（实测每条路由自带 8–11 个 chunk），
  而抽取器只跟**被取页面**引用的 chunk ⇒ 不指定页面就永远只看得到 `/` 的（本会话只能退回 14 段手写 bash）。
- 输出：`page: <路径>`（`paths=` 模式下写"本条不生效"）、`endpoints_page: <路径>`。
- chunk 上限从 8 抬到 **24 条**（字节上限不动：每条 256KiB / 合计 1MiB），**被跳过的 chunk 路径列出来**
  （`endpoints_chunks:` 行的尾部，最多 5 条）——截断必须看得见。

### 9.2 `http_probe paths=` 接受查询串（`?k=v`）
- 只读 GET 上 `?k=v` 是表达语义的唯一手段（`/api/submissions?mine=1` 与不带往往是一对判据）。
- 形状（两侧**逐字符同集**，由 `test/sandbox-spec-locks.test.ts` 对拍）：
  - 路径部分：字母数字与 `. _ ~ / ! @ % + = -`，≤300；
  - 查询串部分：字母数字与 `. _ ~ % = & : @ / + [ ] -`，≤200；**不含** `#`、空白、`$`、引号、反斜杠、
    `{ }`、`< >`、`|`、`;`。
- **防载荷闸门的放行面只有一个字符 `&`**：`TemplateParam.queryCapable`（只授 `paths`/`page`）在跑
  受限载荷检查前把 `&` 换成 `=`（边界符、非受限字符 ⇒ 不漏判也不误判）。它的安全前提是这条链路上
  **没有 shell**：取值以 argv 单个 token 下发，容器侧 `split_probe_path` 自己拒绝全部真正的危险字面量。

### 9.3 软 404 基准**按命名空间各取一条**
- 命名空间 = 路径最后一个 `/` 之前的部分（`/admin` → `/`、`/api/submissions` → `/api/`），
  条数上限 `SOFT404_MAX_BASELINES = 6`；未采样的命名空间退回**最长匹配的已采样前缀**（最终退到根）。
- 输出：每个采样命名空间一条 `paths_soft404_baseline: ns=<前缀> status=… size=… content_type=… path=<随机路径>`；
  逐条表格多一列 `baseline_ns`（该条用的是哪条基准），汇总加 `baselines=<条数>`。
  **汇总字段的含义**（避免读错）：`responded=`＝**拿到响应**的条数（含随后被判 `soft404`/`size>=cap` 的行）、
  `candidates=`＝判成候选的条数（＝ `note` 为 `ok`/`size>=cap` 的行）、`no_response=`＝没打通的条数、
  `no_baseline=`＝**不可判定**的条数（连祖先基准都没采到，见 §9.3.1）；`method_tables=`＝拿到 `Allow` 的条数。

### 9.4 未鉴权方法表：`allow` 列与 `probe_options=true`
- **405 与 OPTIONS 的 `Allow` 头在未鉴权下就给出完整方法表**（实测：零写请求拿到 20 条写端点）。
- `paths=` 的第 7 列固定为 `allow`（GET 响应自带的 `Allow` / `Access-Control-Allow-Methods` 就收）；
  `probe_options=true` 时对每条**额外**发一次只读 `OPTIONS` 并合并取值（两边不同则 `A|B`）。
- 输出：`method_table: <路径> allow=…`（有 Allow 才算一条）+ 汇总 `method_tables=<条数>`；
  单页模式给 `options_status:` / `options_allow:` / `options_note:`。
- 纪律：**只记录，不发写方法**（`PUT`/`DELETE` 属利用类动作，要向人类逐条申请）。

### 9.5 速率：声明值 = 实测值（`rate_check`）
- 根因：ffuf 的 **`-p` 是每线程间隔**，旧公式 `delay = 1/rate` 配 `-t rate` 实际打出 `rate²`
  （真容器对拍：`-t 5 -p 0.20` → 25 req/s；`-t 5 -p 1.00` → 5 req/s；`-t 1 -p 1.00` → 1 req/s）。
  实测反馈即为"声明 5/s、自报 22/s"。
- 修法：`threads = min(10, max(1, rate))`、`delay = threads / rate`（t 个线程各每 t/rate 秒发一次 ⇒ 合计 rate）。
- 输出：`rate_check: declared_rps=<rate> observed_rps=<ffuf 自报> threads=<t> per_thread_delay_s=<d> verdict=ok|over`
  （`observed > declared × 1.5` ⇒ `over` 并给一句"按声明排的预算偏乐观"）。

### 9.6 证据落盘不重复（`evidence_skipped`）
- 命令**最后一段简单命令**里已有 `> /work/…`、`>> /work/…` 或 `tee /work/…` ⇒ 宿主侧不再落第二份
  （实测：同一件事产出两份近重复文件，派生那份名字是用途 slug 的截断，可读性更差）。
- 输出：`evidence: <说明>` + `evidence_skipped: command_wrote_mount`（**不写路径字段**，避免造出不存在的路径）；
  中间步骤写临时文件、最后一段不是写入 ⇒ 照旧落盘（安全网的场景正是"模型忘了写"）。
- 文件名规则不变：`evidence/<目标>/<UTC时间>-<purpose slug>.txt` ⇒ **想让文件名好读就把 `purpose` 写成短语**。
