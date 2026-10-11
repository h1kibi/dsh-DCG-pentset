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
