# 运营者实测五条：对证、修复与冒烟（2026-10-11，第八轮）

**输入**：一次**真作业**（Next.js SPA 靶站）跑完后，运营者按价值排序提交的五条工具摩擦 +
三条技能质量反馈。按"**先复现、再定性、后修**"处理——每条都先在代码/真容器里对证，不接受"看起来像"。

**结论**：五条**全部成立**（其中 #4 的根因与运营者的猜测不同：不是限速没生效，而是**公式写错**），
已全部修复并有真容器冒烟；三条技能反馈落地为 **1 份新技能 + 4 份技能增补 + 2 处既有内容纠错**。
镜像 `d6de07ed3f5c → 2727852f6c59`（两处重钉、25 份技能戳轮换）。

## 一、五条工具摩擦：对证与修法

### #1 `http_probe collect=endpoints` 无法指定"抓哪个页面"（最大摩擦）
- **对证**：`http_probe` 的页面抓取**硬编码 `/`**（`result = fetch(use_scheme, "/")`），
  `collect=endpoints` 只跟随**被取页面**引用的 chunk；chunk 跟随上限 `CHUNK_FETCH_LIMIT = 8`。
  ⇒ 运营者说的"抽取器只跟被取页面引用的 chunk、上限 8 条、而真正含 API 调用的是每条路由自己的
  chunk（每条 8–11 个）"**逐字成立**。
- **修**：新增 `page=<单一路径>`（默认 `/`）；抽取与 chunk 跟随都以这一页为对象；
  `CHUNK_FETCH_LIMIT` 8 → **24**（字节上限不动 1MiB），**被跳过的 chunk 路径列出来**（截断要看得见）；
  报告里加 `page:` 与 `endpoints_page:` 两行自证抽的是哪一页。
- **冒烟**（夹具 `docker/lab-spa`）：`collect=endpoints page=/admin include_chunks=true`
  → `endpoints_chunks: 引用 11 条，抓取 11 条`、`endpoints_kind_counts: chunk=122, page=11`、
  `endpoint: /api/admin/entry kind=quoted@/static/chunks/admin-1.js hits=2`。
  **14 段手写 bash ⇒ 14 次结构化调用**这件事现在真的成立。

### #2 查询串 GET 没有结构化通道
- **对证**：`PROBE_PATH_RE` 的字符集里没有 `?`，报错文案明写"不得含查询串/片段" ⇒ 一刀拒掉。
  运营者"为安全起见没试"的判断是对的：**递进去会被 exit 2**。
- **修**：接受 `?k=v`（路径部分与查询串部分**分开校验**）。查询串字符集 = 字母数字与
  `. _ ~ % = & : @ / + [ ] -`；**不含** `#`（片段不发给服务端，写进去等于记账与实发不符）、空白、
  以及真正危险的 shell 字面量（`$`、引号、反斜杠、`{ }`、`< >`、`|`、`;`）。
  跨了宿主侧的"防载荷闸门"（它的 shell 元字符规则会拦 `&`）：新增 `TemplateParam.queryCapable`
  ——**放行面只有 `&` 一个字符**，且理由写进契约注释：这条链路没有 shell（argv 单 token 下发），
  容器侧校验器自己拒绝全部真正危险字面量。宿主与容器的字符集**逐字符对拍**（新锁）。
- **冒烟**：`paths=/api/submissions?mine=1` → `200 size=10`，而不带查询串是 `200 size=2`
  （**结论性差异可见**，且两条都进了审计通道）。

### #3 软 404 基准取自根命名空间
- **对证**：基准只有一条（`SOFT404_PATH_PREFIX` + 随机），探 `/api/*` 时用的仍是根命名空间那条。
  运营者的判断（"本次没出事只因为长度恰好不同"）准确。
- **修**：基准**按命名空间各取一条**（命名空间 = 最后一个 `/` 之前的部分，条数上限 6，
  未采样的退回最长匹配前缀）；逐条表格加 `baseline_ns` 列，并对每条路径用**自己命名空间**的基准判定。
- **冒烟**（夹具刻意做成"两个命名空间 + 一个 200 兜底命名空间"）：
  三条基准 `ns=/api/ status=404 size=22 json`、`ns=/lists/ status=200 size=1241 html`、`ns=/ status=404 size=8522 html`；
  `/lists/xyz` → `soft404`（用 `/lists/` 自己的基准 —— **只用根基准会误判为 ok**）；
  `/lists/mine` → `ok`（长度与兜底差 200B）。这条正是"若某 API 前缀有返回 200 固定体的兜底路由，这个基准抓不到"的正解。

### #4 速率上限与实测不符（声明 5/s，自报 22/s）——**根因与猜测不同**
- **对证（真容器对拍）**：ffuf 的 `-p` 是**每线程**请求间隔。旧公式 `delay = 1/rate` 配 `-t rate`
  实际打出 **`rate²`**：实测 `-t 5 -p 0.20` → **25 req/sec**、`-t 5 -p 1.00` → **5 req/sec**、
  `-t 1 -p 1.00` → **1 req/sec**。⇒ 不是"限速没生效"，而是**声明与实现用了两套模型**；
  stealth 预设的承诺本身没错，错在容器把这个承诺翻译成了 `rate²`。
- **修**：`threads = min(10, max(1, rate))`、`delay = threads / rate`（t 个线程各每 t/rate 秒发一次
  ⇒ 合计 rate）；并把对账写进每一轮：`rate_check: declared_rps=… observed_rps=… threads=… verdict=ok|over`
  （`observed > declared × 1.5` ⇒ `over` + 一句"按声明排的预算偏乐观"）。
- **冒烟**：`content_discover rate=5 entry_range=1-60` → `observed_rps=5.0 verdict=ok`（60 请求 12.0s）。
- **技能侧同时纠错**：`recon-web-surface` 原先只写"限速只能用 `-t` 与 `-p`"，没写 `-p` 是每线程间隔
  ——运营者正是按旧心智模型排的预算。现在写了三种等价比与实测数字。

### #5 证据落盘产出两份近重复文件
- **对证**：文件名**本来就是从 `purpose` 派生**的（`evidence/<目标>/<UTC>-<purpose slug>.txt`），
  运营者以为是从命令前 N 字符派生——那条路不存在；真正的重复源是**命令自己写了 `/work/…`**、
  宿主侧 `save_stdout_as_evidence` 又落一份。
- **修**：新增 `writesIntoMount()`（只看**最后一段**简单命令：`> /work/…` / `>> /work/…` / `tee /work/…`）
  ⇒ 命中时不重复落盘，返回 `evidence_skipped: command_wrote_mount` + 一句说明（**不写路径字段**，
  避免造出不存在的路径）。中间步骤写临时文件、最后一段不是写入 ⇒ **照旧落盘**（安全网的场景正是"模型忘了写"）。
  工具描述同时点明"**文件名由 purpose 派生**——想让文件名好读就把 purpose 写成短语"（运营者的原诉求）。
- **冒烟**（单测 12 例）：`curl … > /work/evidence/a.txt` ⇒ 抑制；`grep … | head -5` ⇒ 不抑制。

## 二、三条技能反馈

| 反馈 | 落地 |
|---|---|
| Next.js/SPA 上字典枚举近乎无效，要从 chunk 收 API 路径，**且必须逐路由** | `recon-web-surface` 新增**第 7d 步**（含可跑配方 + `page=` 结构化调用 + "38/38 全部存在"式判据）；表格与 `paths=` 分工写清（`page=` 发现、`paths=` 复核）；`web_crawl` 只跟 `<a href>` 不抽 JS 这件事在"同类工具取舍"里点明 |
| 405 的 `Allow` 头未鉴权泄露完整方法表（零写请求清点写端点），技能里没有 | 新增**第 2c 步**（`probe_options=true` / `http_check check=http_verbs` 两条通道 + curl 原文）；**工具侧顺带把 `Allow` 做成 `paths=` 的第 7 列**（GET 的 405 响应就带它，零额外请求） |
| 没有任何技能讲"怎么消费既有作业档案" | 新增 **`skills/engagement-archive`**（信息收集阶段 pack）：第 1–6 步 = 确认根 → 按 mtime 倒序 → 四段关键词检索 → 抽结论/排除段 → **时效核验**（证书/范围版本）→ 写回台账；并在另外四份技能里各加一段"档案先读"（`asset-graph` / `vuln-triage` / `exploit-safety` / `post-loop-handoff`） |

**为什么档案技能只放进一个 pack**：`phase` 必须与 pack 一致（`test/skill-pack.test.ts` 钉死），
一份技能不能同时属于五个阶段；因此深配方放在**信息收集阶段**（作业的首个会话所在），
其余四个阶段各用**自足的一段**接上（不写跨阶段引用——那是死链）。

## 三、顺手清掉的债

- **遗留别名 `entries_scanned=` 按规范期限删除**（引用计数已为 0）：`docs/sandbox-tool-spec.md` §7、
  `RUNBOOK.md`、测试注释同步改为"已于第八轮删除"。
- **规范文档新增 §9**：把本轮新增的参数/字段/语义（`page`、查询串字符集、`queryCapable` 的 `&` 放行、
  分命名空间基准、`allow`/`method_table`、`rate_check`、`evidence_skipped`）登记在案——
  §7 的"单一来源"要求字段名能被检索到，不能只活在代码里。

## 四、验证矩阵

| 项 | 证据 |
|---|---|
| 真容器冒烟 #1（逐路由 chunk） | 11/11 chunk 跟随、`chunk=122, page=11`、带 `@<chunk 路径>` 来源 |
| 真容器冒烟 #2（查询串 + 分命名空间 + 方法表） | 见 §一 #2/#3/#4 的读数；`method_tables=3 baselines=3 verbs_probed=7` |
| 真容器冒烟 #3（速率对账） | `declared_rps=5 observed_rps=5.0 verdict=ok` |
| 真容器冒烟 #4（单页 OPTIONS） | `options_status: 405` + `options_allow: GET, POST, PUT, DELETE` |
| 档案技能冒烟（夹具 `docker/lab-archive`） | 六步原文配方在 `--network none` + 只读 `/mnt/engagement` + 可写 `/work` 上跑通（戳里有读数） |
| 镜像与工作副本同源 | 容器内 `/usr/local/bin/pentest-tool` 与 `docker/tools/pentest-tool` sha256 相同（`fba63eb8ff99…`） |
| 锁 | 新增：查询串字符集宿主↔容器**逐字符对拍**（注入漂移 ⇒ 红，已验）；`action-templates` 三处对拍扩到 `page`/`probe_options`/查询串；行为锁 `parse_probe_paths`/`parse_page_path` 改按新语义（48/48）；`writesIntoMount` 12 例 |
| 全量 | `build`/`typecheck`/`lint` 0 错、`npm run verify` 五门全过、**全量 1937 通过** |

## 五、残留与未做（写明）

1. **`probe_options=true` 会让请求数翻倍**：`paths=` 模式下每条多一次 OPTIONS。预算按
   `条数 × (2|1) + 基准数` 摊（已改），但**60 条 × 2 + 6 条基准**在 120s 预算下每条只有 ~0.9s ⇒
   大清单建议拆批或不开 OPTIONS（GET 的 405 往往已带 `Allow`）。
2. **档案技能只做"读"**：写入侧（四段纪律）靠 `post-loop-handoff` 的增补段与人类审阅；
   没有做"档案 schema 校验"（档案是自由文本，这是设计选择，不是缺口）。
3. **`pentest_workdir` 的宿主侧通道本轮未实跑**：需要活会话；技能里每一步都给了沙箱侧等价命令
   （已实跑），宿主侧 op 的语义按工具描述与既有测试为准。
4. **`http_check check=http_verbs` 仍是根路径**：逐端点的方法表由 `paths=`/`probe_options` 承担；
   没有给 `http_check` 加 `paths=`（那会与 `http_probe paths=` 重复两套实现）。
5. **没有改变"`page=` 只在单页模式生效"**：`paths=` 模式下它明确不生效（报告里写出来）。
