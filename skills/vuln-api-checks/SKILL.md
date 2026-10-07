---
name: vuln-api-checks
description: 对 REST/GraphQL 面做可判定的核验：未授权访问、BOLA/IDOR、方法面、Content-Type 混淆、mass assignment、introspection、错误泄露
whenToUse: 漏洞分析阶段；目标暴露了 JSON/GraphQL 端点（/api/、/graphql、swagger/openapi 文档）；需要把「接口看起来能读」变成有证据的判定
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [OWASP API Security Top 10 2023（API1/API3/API5/API6/API8）, OWASP WSTG-APIT, MITRE ATT&CK T1190, swagger/openapi 规范]
  smoked: "沙箱实测@81483611f0a0：对实验室 API 靶站（fx-api，见 docker/lab-api）逐块跑，9 块全部通过——①openapi.json=200 且 paths 列出 5 个端点、swagger.json=404、ffuf+api-endpoints.txt 命中 /graphql ②无凭据 GET 集合=200 且正文是业务数据（含 api_key 字段名）③BOLA：同一凭据取 users/1 与 users/2 都 200，own.id=1/role=user 与 other.id=2/role=admin 是不同主体 ④OPTIONS 的 Allow 声明 GET,HEAD,OPTIONS,POST,PUT,DELETE 而实际 GET=404、PUT=501（Allow 不能当实现证据）⑤Content-Type：json=201 / form=415 ⑥mass assignment：accepted_fields=[is_admin,name,role] ⑦introspection 返回 User(id,email,role) 与 Order(id,total,userId) ⑧403 的 detail 回显判定逻辑、/api/v1/debug=200 回显 cwd ⑨枚举（seq 1 50 | ffuf -w -）得 200/1、200/2、200/3，长度列区分对象大小。两处命令坑已写进文：管道喂 ffuf 漏 -w - 会打印帮助退出、缺 /tmp/api 目录会让 -o 失败"
---

# API 面核验（vuln-api-checks）

## 适用场景
- 漏洞分析阶段，目标有 JSON/GraphQL 接口（常见入口：`/api/v1/…`、`/graphql`、`/openapi.json`、`/swagger.json`）。
- 与 `vuln-web-checks` 的分工：后者管页面与表单（反射、CSRF、安全头），本条管**接口的对象级授权与契约**；
  两者都只做「可判定 + 留证据」，不做利用链。

## 前提与边界
- **能用结构化通道的地方先用它**：`pentest_scan` 的 `http_check`（六项只读核验：方法面、安全头、
  robots、标题等）与 `exposure_check`（规范文件/备份档的存在性，只判形态、不回显内容）类别是
  `active_probing`，**不需要逐条人工放行**。下面手写 curl 的步骤走 `pentest_exec`
  （`active_probing`，**免批**：命令原文不再经人过目）——顺序是先结构化、覆盖不到再手写
  （例如第 3 步 BOLA 需要"两个身份各取一次"，结构化通道没有这个形态）。
- 每条命令经 `pentest_exec`（`direct_command` ⇒ `active_probing`）**免批**（命令原文不再经人过目）；写法上一条命令一个目的。
- **本技能只发只读请求**：`GET`/`HEAD`/`OPTIONS`，以及**一次**带标记的 `POST`（用于验证 mass assignment /
  Content-Type 判定）。任何写库、改状态、删数据的请求不在这里——那属于利用阶段。
- 凭据：需要「特定用户视角」时用人类给的那组凭据；**同一资源至少用两个不同身份各请求一次**才能判 BOLA，
  只有一个身份时结论只能写「未判定」，不要猜。
- 枚举类动作（拿 id 刷接口）属主动发现：限制次数（≤50 次）、间隔 ≥1s，并把范围写进产出
  （免批后**没有人在逐条拦你**，计数与间隔就是唯一约束——写进产出才可复核）。
  没有明确目的就不枚举——`404/403/200` 的差异很诱人，但那是「拿别人的数据」的批量尝试；
  免批把闸门交回给你，判断"该不该做"这一半现在**全靠你**。
- 铁律：**不回显敏感值**。判定「返回了 api_key」时只写字段名与形态（`sk_live_` 前缀 + 长度），
  不把值抄进证据（与 `exploit-evidence` 的脱敏规则一致）。

## 步骤

> **先建输出目录**（后面每步都往 `/tmp/api/` 落证据，缺目录会让工具以 `no such file` 失败——实测踩过）：
> ```bash
> mkdir -p /tmp/api
> ```

### 1. 先把接口清单拿到手（不需要凭据的三条路）
```bash
curl -sS -D - -o /tmp/api/openapi.json http://<目标>:<端口>/openapi.json
curl -sS -o /tmp/api/swagger.json -w 'swagger=%{http_code}\n' http://<目标>:<端口>/swagger.json
ffuf -u http://<目标>:<端口>/FUZZ -w /usr/share/wordlists/api-endpoints.txt -t 5 -p 0.2 -mc 200,201,204,401,403 -s
```
**期望**：要么直接拿到规范文档（`paths` 里逐个端点），要么从字典命中一批端点（含 401/403——**被拒也是端点存在的证据**）。
**判据**：`200` 且正文含 `"openapi"`/`"swagger"` ⇒ 规范泄露（**这本身是一条发现**：它把攻击面直接交出来）；
`401/403` 的路径进清单；`404` 不进。列出清单后**逐条核验**，不要只报数量。

### 2. 未授权访问：不带任何凭据直接读集合
```bash
curl -sS -o /tmp/api/users.anon -w 'anon=%{http_code} size=%{size_download}\n' http://<目标>:<端口>/api/v1/users
head -c 300 /tmp/api/users.anon
```
**期望**：`anon=401/403`（正常）或 `anon=200` 且正文是**业务数据**（未授权读）。
**判据**：`200` + JSON 数组/对象里出现业务字段 ⇒ 判定「未授权读」成立；若返回的是登录页 HTML，
那是软 200（前面挂的 SPA 兜底），**不算**这条发现——要看 `Content-Type` 与正文形态。

### 3. BOLA/IDOR：对象级授权（API1，最常见也最值钱）
```bash
# 用同一凭据取「自己的」与「别人的」同一类对象各一次
curl -sS -H 'Authorization: Bearer <凭据A>' http://<目标>:<端口>/api/v1/users/<A 的 id> -o /tmp/api/own.json -w 'own=%{http_code}\n'
curl -sS -H 'Authorization: Bearer <凭据A>' http://<目标>:<端口>/api/v1/users/<B 的 id> -o /tmp/api/other.json -w 'other=%{http_code}\n'
diff <(jq -S . /tmp/api/own.json 2>/dev/null) <(jq -S . /tmp/api/other.json 2>/dev/null) | head -20
```
**期望**：取别人的对象应返回 `403/404`；若返回 `200` 且正文是**另一个主体**的数据，即 BOLA 成立。
**判据**：`other=200` 且 `jq '.id'` / `.owner` 指向**另一个 id** ⇒ 成立，证据里写「以 A 的凭据读到 B 的对象」
（**只写对象 id 与字段名，不抄正文值**）。`other=403/404` ⇒ 这条判否；**不要**因为路径存在就写成「可能越权」。

### 4. 方法面：`Allow` 头不是实现证据
```bash
curl -sS -X OPTIONS -D - -o /dev/null http://<目标>:<端口>/api/v1/orders | grep -i '^allow'
curl -sS -X GET -o /dev/null -w 'GET=%{http_code}\n' http://<目标>:<端口>/api/v1/orders
curl -sS -X PUT -o /dev/null -w 'PUT=%{http_code}\n' -H 'Content-Type: application/json' -d '{}' http://<目标>:<端口>/api/v1/orders
```
**期望**：`Allow` 声明的方法集与逐方法实际返回不一致（声明了 `PUT/DELETE` 但返回 404/405/501）。
**判据**：**以逐方法的实际返回为准**；`Allow` 只作线索。PUT/DELETE 这类**写方法只探测一次**，
不做实际写（除了本技能第 5 步那一条标记请求）。

### 5. Content-Type 与解析面（会不会只看 Content-Type 就放行）
```bash
curl -sS -o /tmp/api/post-json.out -w 'json=%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"name":"probe-<本次放行编号>","role":"probe"}' http://<目标>:<端口>/api/v1/orders
curl -sS -o /tmp/api/post-form.out -w 'form=%{http_code}\n' -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'name=probe' http://<目标>:<端口>/api/v1/orders
```
**期望**：两种 Content-Type 的返回不同（如 `415` 对 `201`），或都接受但解析结果不同。
**判据**：**差异本身就是判定依据**——「服务端只按 Content-Type 选解析器」意味着 WAF/校验可能挂在另一条分支上。
若两者都 `201`，检查回显里能否看出**实际落库的字段**（见第 6 步）。

### 6. mass assignment（客户端字段能不能越权写）
```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"name":"probe-<本次放行编号>","role":"admin","is_admin":true}' \
  http://<目标>:<端口>/api/v1/users | tee /tmp/api/mass.out | jq '{created, accepted_fields}' 2>/dev/null || cat /tmp/api/mass.out
```
**期望**：响应里出现「接受/创建」了越权字段（`role`/`is_admin` 原样入库或回显）。
**判据**：**以回显字段为准**（`accepted_fields` 含 `role` 即成立）；若只回显白名单里的字段，
判否并记「服务端做了字段过滤」。这一步是**唯一允许的写方法**，且载荷带本次放行编号以便回滚定位。

### 7. GraphQL：introspection 与查询面
```bash
curl -sS -G --data-urlencode 'query={__schema{queryType{name} types{name fields{name}}}}' \
  http://<目标>:<端口>/graphql -o /tmp/api/gql.json -w 'schema=%{http_code}\n'
jq -r '.data.__schema.types[]? | "\(.name)\t\([.fields[]?.name]|join(","))"' /tmp/api/gql.json | head -10
```
**期望**：返回完整 `__schema`（introspection 开启）或明确的错误（关闭）。
**判据**：拿到 type/field 清单 ⇒ introspection **开启**，把它作为攻击面写进产出（后续查询面分析属本阶段的
候选项，实际构造查询按第 6 步的「一次标记请求」纪律做）。

### 8. 错误信息泄露（verbose 报错把判定逻辑说出来）
```bash
curl -sS -H 'X-Role: user' -o /tmp/api/403.json -w 'admin=%{http_code}\n' http://<目标>:<端口>/api/v1/admin
jq -r '.detail? // .error? // empty' /tmp/api/403.json | head -3
curl -sS -o /tmp/api/debug.out -w 'debug=%{http_code}\n' http://<目标>:<端口>/api/v1/debug
```
**期望**：403 的正文里出现**实现细节**（要求的头名、大小写、判定顺序），或存在 `/debug` 一类端点回显内部路径。
**判据**：`detail` 提到具体头/参数名 ⇒ 判定「verbose 错误泄露」成立（它把暴力猜测的成本降到一次）；
`debug=200` 且回显服务端路径/版本 ⇒ 单独一条发现。

### 9. 枚举面（**限次、限速，且只在有明确目的时做**）
```bash
seq 1 50 | ffuf -u http://<目标>:<端口>/api/v1/users/FUZZ -w - -mc 200 -t 2 -p 1 -s -o /tmp/api/enum.json -of json
jq -r '.results[]? | "\(.status) \(.input.FUZZ) \(.length)"' /tmp/api/enum.json | head -20
```
**期望**：`200` 与 `404` 形成清晰边界（`200` 的就是可读对象），长度列常能区分「对象大小不同」（实测：
2 号对象因多一个敏感字段而明显更大）。
**判据**：**只统计、不取正文**；把「可读 id 的数量与区间」写进产出。
> 用管道喂输入时 **必须写 `-w -`**（显式声明"字典来自 stdin"）；漏了它会打印帮助并退出（实测踩过）。

## 判读与去噪
- **软 200**：SPA 兜底会让任意路径返回 `200` + HTML。先看 `Content-Type`（`application/json` 才算接口响应），
  再比对同路径的 `size`——长度相同就是兜底页，不是接口。
- **`401` vs `403`**：`401` 是「没给凭据」、`403` 是「给了但不够」；两者都要分别测，混着测会得出错结论。
- **`405` 与 `404`**：前者说明路径存在但方法不对，后者才是没有；别把 `405` 记成「不存在」。
- **回显 ≠ 落库**：mass assignment 的判定优先看**服务端接受的字段列表**；只有回显没有落库证据时，
  结论写「接受了该字段（未验证持久化）」。
- **本文不判定 GraphQL 的查询深度/批量攻击**，也不构造注入载荷——那些归利用阶段。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 任意路径都 `200` | SPA 兜底/反向代理 | 用 `Content-Type` 与 `size` 比对识别软 200，改用字典里命中 `401/403` 的路径 |
| `curl` 拿不到正文但状态码是 200 | 响应是流式/分了块，或需要 `Accept` 头 | 加 `-H 'Accept: application/json'` 重发一次；仍为空则记「未取得正文」 |
| GraphQL introspection 报语法错 | 端点是 POST-only | 改 `-X POST -H 'Content-Type: application/json' -d '{"query":"{__schema{types{name}}}"}'` |
| 拿到 `api_key`/令牌字段 | 服务端把敏感字段放进列表响应 | **只记字段名与形态**，不抄值；这条本身就是发现（过度暴露） |
| 枚举跑到一半被限速/封 IP | 触发了速率限制 | 停手，把「第 N 次开始被限」写进产出；不要换 IP/换路径绕过 |

## 不做的事
- 不做写操作（除第 6 步**一次**带编号的标记请求），不删改目标数据。
- 不构造注入/反序列化/越权利用链——判定「成立」就停，利用交 `exploit-*`。
- 不批量抓取业务数据（枚举只统计状态码与长度）。
- 不在产出里回显凭据、令牌、个人数据原文。

## 产出（交给下一步）
- **接口清单**：路径 + 方法 + 是否需要凭据（含被拒的端点，它们同样在攻击面上）。
- **判定表**：`端点 | 判定（未授权读 / BOLA / 方法面 / Content-Type / mass assignment / introspection / 错误泄露） | 证据引用 | 建议动作类别`。
- **未判定项**：只有一个身份可用而无法判 BOLA 的端点，逐条写清原因。

## 参考
- OWASP API Security Top 10 2023：API1（BOLA）、API3（对象属性级授权）、API5（功能级授权）、API6（无限制访问敏感流）、API8（配置错误）。
- OWASP WSTG：APIT（API Testing）章节；swagger/openapi 3.0 规范（`paths` 的语义）。
