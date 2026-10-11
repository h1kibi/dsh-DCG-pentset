# 本机实测指南

面向个人使用、非生产。目标：**在你这台机器上把插件跑起来，指向自己的靶场做一次真实渗透动作**。

权威设计文档是 `docs/dsh-pentest-plugin-design.md`；本文件只讲「怎么跑」。

---

## 0. 一句话结论

跑起来需要四样东西：**PostgreSQL**、**工具容器镜像 + 本地 registry**、**一张 Docker 网络**、**模型凭据**。前两样有脚本，第四样用环境变量。第三样没有脚本可抄默认值：**这张网是否 `internal` 决定沙箱能不能出网** —— `internal=true` ⇒ 沙箱只能打到同网成员（等于完全不出网）；非 internal ⇒ 可达范围等于宿主。选定后写进 profile：`runtime.sandbox.internalNetwork`，若非 internal 还需 `sandbox.allowEgress: true`（启动器会要求它，并在每次启动重复一遍代价）。

---

## 1. 前置

| 依赖 | 说明 |
|---|---|
| Node `^22.19.0 \|\| >=24.0.0` | 宿主 `dsh` 与本插件都跑在它上面。**以 `package.json` 的 `engines` 为准**——本插件直接用 `node:sqlite`/`--experimental-strip-types` 这类 22.19 之后才稳定的能力，Node 20 上会以难以归因的方式失败 |
| Docker Desktop | **必须**。沙箱目前只有 Docker 一条执行路径，没有免 Docker 开关 |
| PostgreSQL + pgvector | 迁移要用到 `vector` 扩展 |
| 模型凭据 | `DEEPSEEK_API_KEY` 环境变量，或写进 `$DSH_HOME/.credentials.yaml` |

数据库已有一个可直接用的容器（本机开发用）：

```bash
docker run -d --name dsh-pg-c -p 55446:5432 \
  -e POSTGRES_PASSWORD=check -e POSTGRES_DB=pentest pgvector/pgvector:pg17
```

迁移在插件 `compose()` 时自动跑（到 `src/db/migrations/` 里的最新一版）。

**但个人 profile 显式关掉了它**（`migrateOnStartup: false`，理由写在 profile 里：运行进程不承担 DDL）。因此**升级插件后、启动之前，必须由管理员先跑一次迁移**，否则实例会带着旧表结构起来——新代码读新列时会以 `column ... does not exist` 失败，而日志里只有一个插件装载警告，看起来像“起来了”：

```bash
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest_personal' \
  node --experimental-strip-types -e "const {migrate}=await import('./src/db/migrate.ts');\
console.log((await migrate({connectionString:process.env.PENTEST_DATABASE_URL,log:console.log})).appliedFiles)"

# 已有旧库上前向迁移的完整验收（建临时库、放 legacy 数据、核查回填/RLS/追加写；需要 CREATEDB）：
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/postgres' \
  npm run verify:forward-migration
```

> ⚠️ **三个库不要共用同一个 `PENTEST_DATABASE_URL`**（本轮实测踩到，表现极具误导性）：
>
> | 用途 | 库 | 原因 |
> |---|---|---|
> | `npm test` | **`pentest`** | `test/helpers/tsx-loader.mjs` 有**库名守卫**：指向别的库会**直接拒绝整轮运行**并打印实际库名（不是静默跳过） |
> | `npm run verify:forward-migration` | **`postgres`**（或任一有权建库的角色） | 它要 CREATE DATABASE 建临时库演练 |
> | 个人环境 / 手工迁移 | **`pentest_personal`** | 见上文 profile 配置 |
>
> 把其中任何一个**一次性 export 给整条链**（如 `npm run build && npm run verify && npm test`），
> 会得到「构建通过、门禁全绿、**测试 70 个文件全失败**」的假警报——实际只是库不对。

### 连接角色：开发可以用超级用户，生产**不行**

上面那条连接串用的是 `postgres`——**超级用户始终绕过 RLS**，包括 `FORCE ROW LEVEL SECURITY`。
开发本机图省事可以这么连，但那样跑起来的一切隔离都不成立：`test/` 里绝大多数集成用例也是
这么连的，所以它们证明不了隔离（真正验证隔离的是 `test/rls-isolation.test.ts`，它用
`SET LOCAL ROLE pentest_app`）。

生产必须：

1. 迁移连接用能 `CREATE ROLE` / `SET ROLE pentest_migrator` 的管理员角色；
2. **运行时连接用 `pentest_app`**（`002` 建的是 `NOLOGIN`，需要由部署方 `ALTER ROLE ... LOGIN`
   并配好口令，或经连接池/`SET ROLE` 以它执行）；
3. 每条语句带上事务级上下文 `pentest.set_rls_context(tenant, engagement, worker_session)`
   ——`compose({ rlsContext: { tenantId, engagementId } })` 或经会话反查自动设置；
4. 用非超级用户跑一次 `pnpm test`（含 `test/rls-isolation.test.ts`），确认「同租户的另一个
   engagement 既读不到也改不动」在自己这套配置下真的成立。

未设上下文时策略一律 fail-closed（零行可见），因此「忘了设」的表现是「什么都查不到」，
而不是「查到了别人的」。

---

## 2. 起沙箱基础设施

第一轮只使用书面授权的实验室目标。脚本不再提供公网默认目标；`TARGET`、`PENTEST_RESOLVED_ADDRESSES` 和 `EGRESS_ALLOW` 必须显式填写，且三者应对应同一实验室资产。

```bash
cd /c/Projects/Agent-projects/dsh-DCG-pentest
TARGET=http://lab-web:8000/ \
PENTEST_RESOLVED_ADDRESSES='["172.28.0.10"]' \
EGRESS_ALLOW=172.28.0.10 \
sh scripts/dev-sandbox-up.sh up
```

这一步构建工具镜像、启动本地 registry、创建 `internal=true` 的沙箱网络、启动带显式出口白名单的代理，并打印真实镜像摘要。**注意这张网是 `internal` ⇒ 沙箱没有外网出口**（出网动作只会超时）；要"宿主能访问的沙箱也能"，把网络建成非 internal 并写 `sandbox.allowEgress: true`（见 §0 第三样）。不要把 `example.com` 或任意公网地址作为第一轮目标。

验证出口代理这一步**只对 dev 脚本的场景有意义**（该脚本仍会起代理容器供排障用；**沙箱本身不经过它**——出网与否只看网络形状，见 §0 第三样与 §6.5.9）：

```bash
TARGET=http://lab-web:8000/ \
PENTEST_RESOLVED_ADDRESSES='["172.28.0.10"]' \
EGRESS_ALLOW=172.28.0.10 \
sh scripts/dev-sandbox-up.sh smoke
```

启动器会拒绝或提醒以下状态（2026-10-07 与代码对齐）：网络**不是** `internal=true` 而未显式写 `sandbox.allowEgress: true`（拒绝启动，并给两条路）；写了 `allowEgress` ⇒ 每次启动重复一遍"网络层不再是范围边界"的代价；网络成员不是人类用 `PENTEST_LAB_TARGETS` 显式声明的实验室目标；工具镜像摘要与 profile 不一致。（代理相关的**代码**（白名单同步）已于 `cba7fd1` 删净；启动器里那几条代理检查随后也被降级为**只提示不拦启动**——缺代理不再拒绝启动。）

`direct` 只用于实验室目标的镜像/argv 诊断，不属于正常实战路径，因为它把 argv 直接跑在宿主上而不是沙箱里（与"经不经代理"无关——沙箱本来就不经代理）。

### 2.1 升级工具镜像（改 `docker/tools/` 之后**必读**）

沙箱里有什么工具、有什么限额，**会以提示词的形式进每一个新会话**（`src/agents/sandbox-brief.ts`）。
因此升级镜像不是一个孤立的构建动作，而是**五步**——跳过任何一步，症状都是"Agent 在实战里反复失败"，
而插件本身一切正常：

#### ① 改镜像并构建

```bash
cd /c/Projects/Agent-projects/dsh-DCG-pentest
docker build -t pentest-tools:dev docker/tools      # 上下文就是 docker/tools
```

**构建期网络（2026-10-06 二次实测）**——决定了哪些工具能装、怎么装。
**注意这张表会变**：同一天早上 `github.com` 被拒、下午 200；出网本身也是间歇的（§6.5.9）。
因此安装策略是"**优先走稳定源**（apt/pip/goproxy.cn/jsDelivr），只有 PyPI 没有的才走 GitHub，
且一律钉 commit/tag"：

| 源 | 可达 | 用途 |
|---|---|---|
| `deb.debian.org` | ✓ | apt 包（工具集主体） |
| `pypi.org` | ✓ | python 工具与库（**未钉版本**，见下） |
| `cdn.jsdelivr.net` | ✓ | 字典（逐字镜像 GitHub 内容，**钉 tag**） |
| `goproxy.cn` + `sum.golang.google.cn` | ✓ | Go 工具（**版本钉死**，校验库保留） |
| `rubygems.org` | ✓ | Evil-WinRM（只在 gem 发布；装完卸掉 ruby-dev/build-essential） |
| `codeload.github.com` | ✓（稳定） | **GitHub 仓库归档**：`https://codeload.github.com/<owner>/<repo>/tar.gz/<tag 或 commit>`——源码安装优先走这里 |
| `api.github.com` | ✓ | Release 元数据（assets 本身在 objects.githubusercontent.com，个别下载器能走通） |
| `github.com` | **时通时不通** | `git clone`/网页/Release 直链都打这个域：2026-10-06 当天上午拒绝、下午 200、一小时后超时。**不要把它作为唯一安装路径** |
| `raw.githubusercontent.com` | **✗** | 直接用 raw 链接下脚本/字典不可靠（用 jsDelivr 代替） |
| `proxy.golang.org` | **✗** | 官方 Go 代理（已换 goproxy.cn） |

推论：**"只有 GitHub 有"的工具仍然装得上**——按 commit/tag 从 `codeload.github.com` 取 tar.gz
（`enum4linux-ng` 就是这么装的），比 `git clone` 更稳、且同样钉得住版本。

> **NetExec（`nxc`）不在镜像里，且是有意的**：它的依赖表里有**四个 git URL**
> （certipy-ad / impacket / oscrypto / pynfsclient 各自指向一个 GitHub 仓库），装它必须
> `github.com` 可达——而那个域在本环境**时通时不通**（2026-10-06 一天内翻转三次：拒绝 → 200 → 超时 → 200）。
> 四条替代路都试过并否掉：钉 `dploot<4` 只解决另一个问题（SMB 模块的 dploot 4 API 断档）；
> main 分支同样依赖 git URL；把四个 git 依赖改指 PyPI 能装上、但运行期 `nxc smb` 直接
> `LibraryNotFoundError`（oscrypto 的 OpenSSL 3 检测，上游 pin git 版正是为此）；加重试只是把
> 不确定性搬进构建。**结论**：镜像构建不依赖 flaky 网络；AD 面由 enum4linux-ng + impacket（73 个脚本）
> + smbmap/smbclient/rpcclient + evil-winrm 覆盖。需要 `nxc` 时按 `docker/tools/Dockerfile`
> "有意不装"清单里的那条命令，在 github 可达的机器上装好再导入。

> **已知的复现性缺口**：pip 那段**没有钉版本**（Go 与 GitHub 专供件都钉了）。同一份 Dockerfile 在
> 不同时间构建会装出不同的依赖树。要完全复现，得把 pip 依赖钉到具体 wheel 版本——这是一笔待还的账，
> 不是"设计如此"。

`api.github.com` 可达时有两个后果，都要记住（它不可达时 nuclei 拉不到、也就无所谓）：

1. **我们仍然不装官方模板库**：`/opt/pentest-templates` 里只有 6 份自建、只读形态的模板
   （见下 ③）。官方库里有大量入侵性/破坏性用例，装进来等于把动作边界交给上游。
2. **必须显式关掉 nuclei 的自动更新**，否则它会自己去拉官方库：所有 nuclei 调用都要带
   `-disable-update-check`（`src/agents/sandbox-brief.ts` 里的用法行已写明）。容器是 `--rm`，
   运行期拉下来的模板随容器消失，但**在这一次会话里它已经生效了**——那正是我们要避免的。

#### ② 自检：声明的工具在镜像里**真的存在**

```bash
npm run verify:tool-image -- pentest-tools:dev
```

逐个 `command -v`（含字典、模板目录），缺哪个打印哪个。**全绿再往下走**——这一步挡的是
"包名写错 / pip 包没有 console script / Go 二进制因 CGO 成了坏链接"这类只有真跑才知道的错。

**它第一次运行就抓到 2 处偏差（2026-10-06 实测）**，两处都不是镜像错、而是**我们对镜像的想象错**：

| 声明里写的 | 实际 | 修法 |
|---|---|---|
| `testssl.sh` | Debian 包 `testssl.sh` 的二进制叫 `testssl` | 改声明的**名字**，`from` 仍是包名 |
| `impacket-*` | 在 `/usr/bin`（Debian `python3-impacket`，随 apt 的 smbmap 进来），不在 `/usr/local/bin`；pip 那套是 `secretsdump.py` 这类 `.py` 结尾的 | 改**检查脚本**：两个 bin 目录都查 |

修完 60/60 通过。教训：**声明与镜像之间必须有一台机器来对账**，肉眼核对会漏。

#### ③ 提示词与声明必须同步

工具集在 `src/contracts.ts` 的 `SANDBOX_TOOL_GROUPS` 里声明（分组 + 一句话用法 + 出处），
`test/sandbox-environment.test.ts` 会**逐条回到 Dockerfile 核对出处**：

- 装了新工具 → 加进对应分组（`from` 写 apt 包名 / pip 模块名 / go 模块路径 / COPY 来源）；
- 有意不装 → **不要**写进声明，并在该组 `usage` 里写明"本镜像没有它、改用 X"；
- `test/skill-pack.test.ts` 的 `ABSENT_IN_SANDBOX` 是同一事实的另一面：装了就从名单里删掉。
- **有意不装的整份清单写在 `docker/tools/Dockerfile` 的注释块里**（hashcat / responder / sliver /
  pwncat-cs / exploitdb / feroxbuster / gowitness / 云与 K8s 套件 / Windows 侧工件），每条都带理由；
  要加回某个工具：删掉那条注释、按上面的规则补声明，并跑 ② 的自检。

#### ④ 推 registry + 重钉摘要（**两处，别只改一处**）

```bash
sh scripts/dev-sandbox-up.sh up     # 建网 + 推镜像 + 打印要抄的 digest 行（见 §2 的环境变量要求）
```

- 个人 profile：`~/.dsh/profiles/pentest/cordis.patch.yml` 的 `runtime.sandbox.allowedImages[0].digest`
- 仓库开发补丁层：`harness.dev.patch.yml` 的同字段（它同时是 skill 冒烟摘要的**比对源**）

启动器预检会比对摘要，不一致直接拒绝启动（fail-closed）；代码只认 digest、不认标签。

#### ⑤ 重跑 skill 冒烟证明（25 份）

`skills/*/SKILL.md` 的 `metadata.smoked` 绑的是镜像摘要前 12 位，摘要一换 `test/skill-pack.test.ts` 就红——
**这是刻意的**：逼人重跑命令，而不是让旧背书一直挂着。

**注意顺序**：先**真的重跑**（见下），再改摘要——反了就是拿新摘要包装旧结论。

改摘要这一步是机械的，用脚本（别手工改 25 份）：

```bash
npm run build  # 一次性检查文件没写坏
node scripts/resync-smoke-stamps.mjs <新摘要前 12 位>   # 输出：改了 N 份、M 处，并打印替换前的摘要值
```

**怎么跑才算数（2026-10-06 这一轮踩出来的）**：

1. **跑技能里的原文配方，不要跑"等价命令"**。这一轮的教训是：`asset-graph` 步骤 4 与
   `internal-discovery` 步骤 5 的配方**根本跑不通**（前者 jq 报 `Cannot index array with string "id"`；
   后者有两层错——`<(...)` 在当时的 dash 下语法错，且 `--slurpfile` 本就吃不了非 JSON 行，**换成 bash 也只修掉第一层**），
   而上一版背书里写着做过。**等价命令能跑通，不等于技能交给 Agent 的那一条能跑通。**
2. **先铺输入再跑**：配方读的 `/tmp/*.json` 台账要先按技能正文描述的结构造出来，否则你测的是
   "文件不存在"，不是配方。
3. **占位符要替换成真实靶值**（`<目标>` → 实际地址），故意打不通的域名照原文跑——失败即预期。
4. **自由命令的 shell 是 bash**（`SANDBOX_SHELL`，2026-10-06 起；Debian 的 `/bin/sh` 是 dash，
   技能与 Agent 写的都是 bash 方言）。这条修掉之后，`<(...)`、`[[ ]]` 这类写法才成立。
5. **宿主目录要能读写，必须在 profile 里显式声明挂载**（2026-10-07 起，设计 §10.4）：
   `runtime.sandbox.mounts: [{hostPath: C:/Projects/pentest/cdut, containerPath: /work}]`。
   实测三条行为：容器能读宿主放进去的文件；容器写回的文件**宿主上直接可见**；
   挂载目录是**唯一跨命令存在**的路径（`/tmp` 不跨命令，这正好补上"容器一次性"的那一半）。
   不声明就是零挂载——命令里 `cat /work/x` 只会得到 `No such file or directory`（对照组实测）。
   ⚠ 命令的当前目录是 `/tmp`（模板入口行为，实测 `pwd` = `/tmp`）：引用挂载文件**必须用绝对路径**。
   ⚠ 路径写错（不存在/不是目录/挂盘根）→ **插件启动即失败**（fail-loud，不降级）。
6. **读资料不必跑命令**（2026-10-07 起）：`pentest_workdir`（op=`list`/`read`/`write`，路径相对挂载根，
   也接受 `/work/...` 写法）。它**不经过范围闸门**——因为「读你自己的作业资料」与目标无关。
   实测过的自锁场景：空范围作业（范围版本 0）里 `pentest_exec` 一律 `out_of_scope`，
   于是"要读资产清单才知道范围、要范围才能读资产清单"死锁；`artifact_read` 要 artifact 标识、
   `memory_search` 在全新作业里索引水位为 0——三条通道全断。这个工具就是那条出路：
   intake 会话默认带它，Agent 能直接读你放进去的资产清单/报告，再提范围方案给人确认。
   ⚠ 多根部署下**写新文件必须带容器路径前缀**（如 `/mnt/scratch/x.md`）——否则拒绝，不替模型猜。
   ⚠ 它**不产生证据账本条目**（内容要形成结论请照常写报告/证据）；调用本身在会话工具日志里可见。

**本轮冒烟用的靶标（实验室，可重复起）**：

> **启动前必须声明**：个人启动器（`start-personal.mjs`）的预检要求 `pentest-lab-internal` 上**每个成员**
> 都出现在 `PENTEST_LAB_TARGETS` 里（否则拒绝启动，见 §6.5.x）。2026-10-06 起该网络的成员是：
> `fx-web,fx-tls,fx-api,dns-lab,ad-dc,pivot-host`——**起了新靶标就要同步这个值**，否则启动会被拦
> （实测撞到过：新加的 `dns-lab`/`pivot-host` 未声明，预检直接列出未声明成员并拒绝）。

- **静态 Web**：`fx-web`（`172.29.0.x:8080`，含 `.env`/`.git/HEAD`/`swagger.json`/`robots.txt`/登录表单）
  与 `fx-tls`（自签 TLS）——起法见 `skills/AUTHORING-SPEC.md` §4。
- **API 靶站**：`fx-api`（`docker/lab-api/labapi.py`，单文件、无依赖，含刻意做错的 REST/GraphQL 面：
  未授权列表、BOLA/IDOR、`Allow` 声明与实现不一致、Content-Type 判定、mass assignment、GraphQL introspection、
  verbose 报错与 debug 端点）：

  ```bash
  docker run -d --name fx-api --network pentest-lab-internal \
    -v "$PWD/docker/lab-api:/srv:ro" --entrypoint python3 python:3.10-slim-bookworm /srv/labapi.py 9000
  ```

  地址用 `docker inspect fx-api` 现取（或直接用容器名 `fx-api:9000`，同网容器可解析）。
  `vuln-api-checks` 的 `smoked` 就是对着它跑出来的。
- **跳板拓扑**（`post-lateral-pivot` 的靶场：内网段从沙箱**打不到**，只能经跳板）：

  ```bash
  docker network create --internal pentest-lab-deep
  docker run -d --name deep-svc --network pentest-lab-deep \
    --entrypoint python3 python:3.10-slim-bookworm -m http.server 8080 --bind 0.0.0.0
  # 跳板：同时接两张网。实验室里用**工具镜像**充当"已控跳板"（真实场景是目标主机 + 经放行投放的客户端）
  docker run -d --name pivot-host --network pentest-lab-internal --entrypoint /bin/bash \
    pentest-tools:toolbelt-2026.10.06 -c 'sleep infinity'
  docker network connect pentest-lab-deep pivot-host
  ```

  沙箱直连 `deep-svc` 会超时（它的网段只对跳板可见）；隧道的**方向是沙箱主动连出**
  （沙箱无入站端口）。`post-lateral-pivot` 的 `smoked` 就是在这个拓扑上跑出来的。
- **DNS 权威服务器**：`pentest-dns-lab:lab`（bind9，`docker/dns-lab/`）。刻意配错：`lab-zone.test`
  允许任意主机做区域传送；对照 zone `hardened.test` 拒绝传送——同一台服务器上就能同时验「成功」与「被拒」两个分支：

  ```bash
  docker build -t pentest-dns-lab:lab docker/dns-lab
  docker run -d --name dns-lab --network pentest-lab-internal pentest-dns-lab:lab
  dig +time=5 +tries=1 AXFR lab-zone.test @$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dns-lab)
  ```

  注意：**结构化 DNS 通道（`dns_enum`/`dns_brute`/`dns_axfr`）只支持 system/public 解析器**，
  打不到这个 lab zone（实测 `records=0` / `found=0`）——验它们要用公网域名。
- **AD 域**：`pentest-ad-dc:lab`（Samba AD DC，域 `LAB.LOCAL`，管理员 `Passw0rd!234`）：

  ```bash
  docker build -t pentest-ad-dc:lab docker/ad-dc
  docker run -d --name ad-dc --privileged --network pentest-lab-internal --hostname dc1 \
    --mount type=volume,src=ad-dc-samba,dst=/var/lib/samba pentest-ad-dc:lab
  docker inspect ad-dc --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'   # 地址每次重建都可能变
  ```

  **必须 `--privileged`**：`samba-tool domain provision` 设置 sysvol 的 NT ACL 需要 Docker 默认不授予的能力，
  否则报 `set_nt_acl_... NT_STATUS_ACCESS_DENIED`（换卷/换文件系统都无效，实测）。域数据落在命名卷里，
  容器可反复删建（`provision.sh` 幂等）。域内对象：`svc-sql`（SPN `MSSQLSvc/…`）、`svc-web`（SPN `HTTP/…`）、
  `nopreauth`（不要求预认证）、`Helpdesk` 组。

  **这个夹具的两条已知限制**（写进 `recon-ad-surface` / `vuln-ad-checks` 的常见失败表，别再重新发现一遍）：
  1. **拒绝 NTLM 的 LDAP 绑定**（Samba 策略；smb.conf 里 `ldap server require strong auth = no` 已设，
     SIMPLE 绑定可用，NTLM 仍被掐断）⇒ `ldapdomaindump` 必须 `-at SIMPLE`，`adidnsdump`（只支持 NTLM）走不通；
  2. **Kerberos 校验和互操作**：impacket/certipy 的 Kerberos 路径报 `KRB_AP_ERR_INAPP_CKSUM`（Samba KDC），
     且 Kerberos 要求域控**名字**可解析（容器 DNS 不解析域内名字，需要临时 hosts 条目）。

#### ⑥ 全量回归

```bash
npm run build && npm run verify && npm test
```

> **为什么 14 个结构化动词属于这一类**：`port_scan` / `service_probe` / `nse_run` / `tls_probe` /
> `http_probe` / `content_discover` / `web_crawl` / `dns_enum` / `dns_axfr` / `dns_brute` /
> `whois_query` / `ct_lookup`（`pentest_recon`）与 `http_check` / `exposure_check`（`pentest_scan`）
> 都实现在分发器里、随镜像分发。**镜像不重建，这些 technique 全部以 usage_error 失败**。
> 它们在容器内只打宿主注入的已裁决地址（`PENTEST_RESOLVED_ADDRESSES`），该变量为空时直接拒绝（刻意 fail-closed）。

#### ⑦ 本轮轮换记录（2026-10-11，第七轮）

**轮换依据**：`docker/tools/pentest-tool` 改了（新增 `http_probe paths=` 批量复核、`content_discover entry_range=` 分段 +
覆盖度自报、`http_probe` 容器超时 60s→120s、`content_discover` 去掉 `-s` 改读进度行）。
容器侧改动 ⇒ 必须重建镜像并按 §2.1 的五步走完。

```bash
# ① 构建（只有 COPY pentest-tool 那一层实打实重建，其余层命中缓存）
docker build -t 127.0.0.1:5005/pentest-tools:0.1.0 docker/tools
# ② 推本地 registry + 取摘要
docker push 127.0.0.1:5005/pentest-tools:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' 127.0.0.1:5005/pentest-tools:0.1.0
# ③ 重钉**两处**（摘要前值 → 新值）
#    harness.dev.patch.yml            : c31de6c1070e… → eeaf87926df5…
#    ~/.dsh/profiles/pentest/cordis.patch.yml : 同上（只改 allowedImages[0].digest 一行）
# ④ 轮换 25 份 skill 的冒烟背书（先真跑、后改摘要，见 §2.1⑤）
node scripts/resync-smoke-stamps.mjs eeaf87926df5
```

**原样输出**：

```
# docker inspect --format '{{index .RepoDigests 0}}' 127.0.0.1:5005/pentest-tools:0.1.0
127.0.0.1:5005/pentest-tools@sha256:eeaf87926df50380429b15563ff7cb4d7599db22db7b02a2a8ea3bf0b69fe7db

# node scripts/resync-smoke-stamps.mjs eeaf87926df5
改了 25 份、27 处；替换前的摘要值：c31de6c1070e
```

> 本轮中间还出现过一次摘要 `sha256:4e43bb3ef87b…`——那是**同一个工作副本的上一版**：真跑完之后发现
> `schedulability_note` 的措辞会把"按声明速率算的容量"读成"一定会被截断"（实测那一段并没有被截断），
> 于是改了那一句再重建。**摘要轮换不是"构建一次就完"**：代码改一次，前面那轮的实测背书就作废；
> 最终钉住的 `eeaf87926df5…` 上重跑了 A/B1/B2/B3 四个场景（见 §6.5.13.6 的实测表）。

> **`test/skill-pack.test.ts` 会红**（证明绑定 `c31de6c1070e`，当前镜像 `eeaf87926df5`）——那是设计如此
> （镜像一换、旧背书自动失效），轮换脚本跑完即恢复绿色。

#### ⑧ 本轮轮换记录（2026-10-11，第八轮）：容器侧工具面按《沙箱工具规范 v1》统一

**轮换依据**：`docker/tools/pentest-tool` 大改（同一个镜像摘要一次换完）：

- 四组统一参数助手（`param_required/param_optional/param_enum/param_bool/param_int/param_list` +
  `reject_unknown_keys`）——**所有 20 个动词**的参数读取逐个体换过去；未知键一律 rc=2 并列出接受的键
  （`shell_exec` 按规范 §1 的例外豁免）；
- 四条阻断级缺陷（质检 §2.1）：`icmp_ping` 的两个 ICMP 常量、`http_check` 的链式比较、`restrict_to_scope`/
  `include_chunks` 的静默退化、`run_tool` 超时丢产出；
- **每条命令首行 `state=` + 次行 `summary:`**（规范 §2），"没扫"与"扫到 0"用 `scanned=` 分开；
- 有规模的动词补 `<x>_total/_attempted/_truncated/_remaining`（规范 §3）；
- 截断改走**退出码 3** 通知宿主（规范 §4），`[已截断：` 行保留给人读；
- `dns_enum`/`dns_brute`/`exposure_check`（外加 `web_crawl`/`tls_probe`/`fetch_chunks`）补自持总 deadline。

```bash
# ① 构建（只有 COPY pentest-tool 那一层实打实重建，其余层命中缓存）
docker build -t 127.0.0.1:5005/pentest-tools:0.1.0 docker/tools
# ② 推本地 registry + 取摘要
docker push 127.0.0.1:5005/pentest-tools:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' 127.0.0.1:5005/pentest-tools:0.1.0
# ②.5 声明的工具在镜像里真的存在（81 项；脚本没挂 npm script，直接跑）
node --experimental-strip-types scripts/verify-tool-image.ts <镜像引用>
# ③ 重钉**两处**（摘要前值 → 新值）
#    harness.dev.patch.yml                      : eeaf87926df5… → 3401b215a4ab…
#    ~/.dsh/profiles/pentest/cordis.patch.yml   : 同上（只改 allowedImages[0].digest 一行）
# ④ 轮换 25 份 skill 的冒烟背书（先真跑、后改摘要，见 §2.1⑤）
node scripts/resync-smoke-stamps.mjs 3401b215a4ab
```

**原样输出**：

```
# docker build -t 127.0.0.1:5005/pentest-tools:0.1.0 docker/tools   （尾部）
#19 [stage-1 12/13] COPY pentest-tool /usr/local/bin/pentest-tool
#19 DONE 0.0s
#20 [stage-1 13/13] RUN chmod 0755 /usr/local/bin/pentest-tool
#20 DONE 0.2s
#21 exporting to image
#21 exporting manifest list sha256:3401b215a4ab1c5dd55812ec29ab9c5a006e53980a828ad606eb668a28ad8226 0.0s done
#21 naming to 127.0.0.1:5005/pentest-tools:0.1.0 done

# docker push 127.0.0.1:5005/pentest-tools:0.1.0   （尾部）
0.1.0: digest: sha256:3401b215a4ab1c5dd55812ec29ab9c5a006e53980a828ad606eb668a28ad8226 size: 856

# docker inspect --format '{{index .RepoDigests 0}}' 127.0.0.1:5005/pentest-tools:0.1.0
127.0.0.1:5005/pentest-tools@sha256:3401b215a4ab1c5dd55812ec29ab9c5a006e53980a828ad606eb668a28ad8226

# node --experimental-strip-types scripts/verify-tool-image.ts 127.0.0.1:5005/pentest-tools@sha256:3401…
工具镜像自检通过：81 项（70 个命令 + 1 个通配前缀 + 8 份字典 + 模板目录）

# node scripts/resync-smoke-stamps.mjs 3401b215a4ab
改了 25 份、27 处；替换前的摘要值：29bc65ae9f18
```

> 本轮中间出现过两个**中间摘要**：`29bc65ae9f18…`（第一版）与更早的 `28…`——都是同一个工作副本的
> 前一版：把容器自持 deadline 的裕量从**固定 15s** 改成 `min(15s, 注入值/5)`（固定值会把 30s 的
> `dns_enum` 砍掉一半、把 5s 的 `dns_resolve` 压到 1s 下限），改完再重建。**最终钉住的
> `3401b215a4ab…` 上重跑了全部 12 个真容器场景**（见 §6.5.13.8 的实测表）——摘要轮换不是
>"构建一次就完"。

> **`npm run verify:tool-image` 这个 script 名不存在**（RUNBOOK §2.1② 旧写法）——`scripts/verify-tool-image.ts`
> 在，但没挂到 `package.json` 的 scripts 上。照本文的 `node --experimental-strip-types scripts/verify-tool-image.ts <镜像>`
> 跑，脚本自己会打印用法与结果。

> **第八轮新增的两条部署口径**（宿主侧与容器侧必须一致）：
>
> 1. **容器自持 deadline = 注入值 − `min(15s, 注入值/5)`**（`HOST_KILL_MARGIN_MS` + `host_kill_margin_ms`）。
>    宿主 kill 计时器从 spawn docker CLI 起算、容器内计时从进程启动起算；而第八轮起报告是
>    **先缓冲、收尾时一次写出**（首行必须是 `state=`），所以容器必须**先于** kill 收尾，否则 SIGKILL
>    会让整份报告消失。裕量对长动词封顶 15s、对短动词不超过两成（900s 的 port_scan 丢 1.7%；
>    30s 的 dns_enum 丢 6s 而不是 15s），下限 1s。宿主按 `plan.timeoutMs` 规划时，
>    容器实际可用 ≈ `注入值 × 0.8`（长动词接近 `注入值 − 15s`）。模板 `timeoutMs` 与
>    `DEFAULT_TOOL_TIMEOUT_MS` 的值**都没动**。
> 2. **容器截断 ⇒ exit 3**（`mapOutcome` 映射成 `status: completed` + `truncated: true`，**不是失败**）；
>    动词本身失败时仍是 rc=1，截断只在正文里报。

---

## 3. 配置

开发用补丁层 `harness.dev.patch.yml` 已经填好真实值（真摘要、真网络名）。要改的通常是：

```yaml
        runtime:
          database:
            url: postgresql://postgres:check@127.0.0.1:55446/pentest
          ledgerSecret: <≥32 字节，自己换一个>
          sandbox:
            allowedImages:
              - name: 127.0.0.1:5005/pentest-tools   # 必须写全仓库名，裸名会去 Docker Hub 找
                digest: sha256:<从 dev-sandbox-up.sh up 的输出里抄>
            internalNetwork: pentest-internal
          modelRoute:
            provider: deepseek-official   # 必须是宿主已注册的路由名
            model: deepseek-flash
```

**三个必配项，缺一个就有静默降级**：

- `config.operator` —— 宿主的通道认证只给「已认证」这个二元事实，操作者是谁必须由部署方声明。缺它控制台端点不注册（UI 点不动）。
- `config.runtime` —— 缺它服务面不存在，工具对模型不可见。
- `sandbox.allowedImages` —— 空即 fail-closed。

**`ledgerSecret` 没有默认值（2026-10-05 起）**：仓库里曾内联过可直接使用的密钥，
等于把账本签名密钥公开。现在缺它会在 compose 期直接失败。开发补丁走环境变量
`PENTEST_LEDGER_SECRET`（≥32 字节随机串）；`docker/profile.patch.yml` 同样只认环境变量。

**`modelRoute.provider` 写错的代价**：不会在建会话时报错，而是**第一个回合直接失败**（`no adapter registered for provider ...`）。表现是「Agent 起来了但永远不产出」。宿主已注册的路由名可从日志或 `ctx.agentDefaultModel.currentSelection()` 确认；基础 bundle 的默认是 `deepseek-official`。

---

## 4. 启动

### 4a. 你的个人环境（已配好）

> ⚠️ **改完源码必须先 `npm run build`**：个人 profile 加载的是**构建产物**（`lib/`，经包名解析），
> 不是 `src/`。只改源码不重建的表现是「代码明明改了、接口却 404 / 行为照旧」——
> 实测踩过：新增的端点已进方法表、类型检查通过，线上仍 404，直到重建 `lib/console/typert-face.js` 才好。

```bash
cd /c/Projects/Agent-projects/dsh-DCG-pentest
node start-personal.mjs          # 会检查基础设施、启动、打印带 token 的地址并开浏览器
```

装在哪、为什么这么装：

| 项 | 值 | 说明 |
|---|---|---|
| dsh 配置根 | `C:\Users\Administrator\.dsh` | 你的真实 `DSH_HOME` |
| profile | `profiles/pentest` | **专用 profile**，改坏不影响你日常用的 `web` |
| profile 配置 | `profiles/pentest/cordis.patch.yml` | 带完整注释，改之前先读 |
| 数据库 | `pentest_personal` | **与测试库 `pentest` 分开**——测试套件会清 engagements，共用等于让跑测试删掉战果 |
| 会话工作目录 | `C:/tmp/dsh-pentest-sessions`（**回退值**） | **与沙箱直接相关**：容器里的 `/work` 就是**本会话的工作目录**（実主会话头的 `cwd` 优先，取不到才用这个回退值）——见 §6.5.13.5。2026-10-11 更正：本行此前写“与沙箱无关”，那是错的 |
| 模型 | `deepseek-official/deepseek-v4-pro` | 见下面的坑 |
| API 密钥 | User 级环境变量 `DEEPSEEK_API_KEY` | **不是** `.credentials.yaml`，见下 |

**你这个环境的模型路由有个坑，已经踩过了**：

你 dsh 的默认模型是 `openstarry/deepseek-v4-pro`，但那个 key **没有这个模型**（直连返回 400 `model_price_error`「模型不在该套餐的可用模型列表中」）。实测该 key 可用的 10 个是 `mimo-v2.5-pro` / `qwen3.7-plus` / `qwen3.8-max` / `MiniMax-M2.7(-highspeed)` / `kimi-k2.6` / `kimi-k3` / `mimo-v2.5` / `MiniMax-M3` / `kimi-k2.7-code`——**DeepSeek 两个都不在套餐里**。

所以 profile 里显式写死了 `deepseek-official/deepseek-v4-pro`（官方 key 有它，实测跑通）。

> 路由错的失败形态是**最难查的一种**：会话建起来、库里状态 `active`、然后一直不动，插件日志一个字都没有（dsh 把回合内的错误吞掉，只发会话事件）。排查见 §6。

> 插件默认会**跟随你 dsh 的默认模型**（`ctx.agentDefaultModel`）。所以等你把 dsh 的默认模型改成一个真能用的，删掉 profile 里的 `modelRoute:` 两行即可。

**密钥该放哪**（实测的解析顺序，容易配错）：

```
1. 进程环境变量        ← 最高，且 dsh 无法修改这一层
2. .credentials.yaml  refs 段
3. .env 文件          ← 最低
```

凭据服务 `resolve()` 的实现就是按这个顺序短路返回的。所以**只要进程环境里有
`DEEPSEEK_API_KEY`，写进 `.credentials.yaml` 就完全无效**——那个文件里的值会被环境变量盖掉，
而界面上还会显示「已配置」，看起来一切正常。

本机是本套配置：新密钥写在 **User 级环境变量**里（`[Environment]::SetEnvironmentVariable`）。
注意这只对**在那之后启动的进程**生效，已经开着的终端拿到的还是旧的。

改密钥：

```powershell
[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY','sk-...','User')
```

然后**重开一个终端**再 `node start-personal.mjs`。要立刻生效也可以临时传：

```bash
DEEPSEEK_API_KEY=sk-... node start-personal.mjs
```

### 4b. 生产路径（用 `lib/` 产物）

改完 `src/` 要 `npm run build`。构建现在**先清空 `lib/`**（`build` = `clean && build:host && build:client`）：`lib/` 曾被删除模块留下陈旧产物（`agents/capability.js` 及其 `.d.ts`），会随 `files: ["lib"]` 进 npm 包、随 `docker/Dockerfile` 的 `COPY lib` 进镜像——clean 之后两者都不再带上它们。

```bash
cd /c/Projects/Agent-projects/dsh-DCG-pentest
export DSH_HOME="C:/tmp/dshprobe"          # 必须是 Windows 形式
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile probe --no-open --port 3090
```

profile 的插件行指向本项目（`link:`），所以改代码后**重启**即可生效。

### 4b. 直接跑 harness 源码树（免构建，但有一个已知坑）

```bash
cd /c/Projects/Agent-projects/deepseek-harness
export DSH_HOME="C:/tmp/dshdev"
PENTEST_DATABASE_URL=... PENTEST_LEDGER_SECRET=<≥32 字节随机串> pnpm dsh --profile dev \
  --patch C:/Projects/Agent-projects/dsh-DCG-pentest/harness.dev.patch.yml --no-open --port 3090
```

**坑**：这条路径下工具调用会以 `Cannot read properties of undefined (reading 'prepare')` 失败。原因是 `@deepseek-ai/dsh-tools` 被加载了两份（`src/` + `lib/`），而 `TOOL_RUNTIME_SCHEDULER` 是 `unique symbol`——两份副本的 symbol 不同，`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 取到 undefined。**这是 harness 源码树的问题，不是插件的问题**（摘掉插件的 `tools.restrict` 也一样崩）。要实测就用 4a。

---

## 5. 用起来

控制台地址与 token 在启动日志里（**每次重启 token 都会变**）：

```
dsh web: http://127.0.0.1:3090/?token=...
```

浏览器打开它 → 设置 → 插件 → 渗透测试控制台。主线是：

1. **建 engagement**（授权向导：目标、排除项、**行为预设（必选）**、授权引用、有效期、RoE、时间窗；选 `custom` 时还要写自定义指引）
2. **确认范围**（`previewScope` 先看裁决结果，再 `amendScope` 落库）
3. **启动 Agent**（选阶段 + 写任务提示词；工具面留空即用该阶段默认）
4. **看它干**（会话时间轴显示推理与每次工具调用；Agent 会转 `waiting_human` 等你判断）
5. **放行**（每个作业在建作业/确认范围时必选一档**审批模式**）：
   - `人工审批`：`exploit_validation` / `lateral_movement` 类别的每个动作都必须带 `approval_id`，你来点；
   - `高权限`：放行集合 = **预设启用集合 ∪ {`exploit_validation`}**，再减去默认禁用类别。命令类（`direct_command`）单列，因为本部署**只有这一张动手模板**——严格要求"只在预设内"会让 stealth/standard 下每条命令都算越界，高权限退化成"每条都问人"（2026-10-05 实测如此，人类报"AI 审批没落实"）。`lateral_movement` 与 persistence/destructive/exfiltration **永远**人批（前者跨主机，后者后果不可逆）。
   - **一次只有一条待处理申请**：本会话已有 pending 时再提会被拒（拒绝里附上那条的 id 与命令）——一次串起一串，人类只会批其中一条、其余全悬着。已过期/已撤回的不挡新申请。
   - **放行记录里写了"为什么问你"**（`approvals.risk_summary` 末尾括注：超出行为预设 / 属逐次放行类别）——放行卡直接显示，不用猜是哪条规则拦的。
   ⚠ 高权限档下**没有任何人看过那条命令的内容**——范围闸门只核主机/端口。要用它，先把预设选对（预设决定"什么算越界"）。
   **运行中切换**：两个入口——① 会话上栏的常驻状态条上点「审批：…⇄」（一键切，**不需要理由**）；
   ② 控制台「运行控制」卡的「切换审批模式」（选目标档 + 可选备注）。
   切换 ⇒ 服务端写**新一版策略**并推进 `policy_epoch`，
   于是**旧放行凭证与在途计划当场失效**（切回人工审批立刻生效，不用等凭证过期）；同一档重复切会被拒（不平白推进 epoch）。
   切换落两处痕迹：`human_decisions`（`set_approval_mode`，含 from/to 与理由）与审计 `policy.approval_mode.changed` / `policy.epoch.advanced`。
6. **交接 / 重做 / 收尾报告**

### 清理作业：归档（默认）与清空内容（不可恢复）

个人环境里作业会越攒越多（向导建的、Agent 引导建的「未命名任务 …」、失败的、自检用的）。列表里每个作业行有两个动作：

1. **归档**（`archiveEngagement`）：列表默认隐藏，**一个字节都不删**，勾「显示已归档」即可看到并随时取消归档 ✓。
2. **清空内容**（`purgeEngagement`，两段确认）：先归档，再在确认框里看清「将删多少行 / 保留多少行」，并**原样输入作业名**才能点最终按钮 ✓。有未终结会话或有效租约时**拒绝执行** ✓。清空后作业显示「已清理」，不再有内容可读 ✓。

**为什么不能删干净（§9.5 的硬约束）**：审计账本表**只允许追加**，触发器直接拒 DELETE ——
`context_events` / `human_decisions` / `state_transitions` / `ledger_anchors` / `memory_access_log`，
以及 018 起同样只追加的 `policy_versions`；它们都引用 `engagements`，因此**作业行本身也删不掉**。
所以「清空内容」的真实语义是：**内容清零 + 审计骨架保留 + 一行销毁记录**。

- 空间收益来自可删的大表：`memory_chunks` / `memory_items` / `llm_calls` / `tool_runs` / `artifacts` /
  `approvals` / `scope_versions` / `assets` / `retrieval_*` …（实证：删完这些表该作业 0 行）。
- 保留的是每场作业必然存在、体量很小的骨架（事件链、决策、转移、锚点、策略版本、会话行、交接行）。
- 销毁记录写在 **`pentest.engagement_purges`**（独立于被清空的作业）：作业名 / 操作者 / 时间 /
  `{deleted, retained}` 计数 —— 否则「有人删过它」这条事实会随作业一起消失，审计上等于从未存在。

### 不用界面时的脚本化用法

45 个控制台端点在 `/api/pentest/<method>` 上（workflow 31 / report 7 / memory 3 / skills 4；以 `CONSOLE_RPC_METHODS` 为准）。响应是**两层嵌套**，业务结论在 `result.value`：

```
POST /api/pentest/startWorker
{"type":"client-request","rpcId":"1","method":"pentest/startWorker",
 "payload":{"args":{"request":{
   "method":"startWorker",
   "params":{"engagementId":"...","phase":"intelligence-gathering","taskPrompt":"..."},
   "reason":"为什么这么做",            ← 变更类端点强制要
   "idempotencyKey":"唯一值"          ← 变更类端点强制要
   "expectedStateVersion":0           ← lock=actor 的端点强制要（lock=none 的端点不要求）
 }}}}
```

认证：先 `GET /?token=<t>` 拿 cookie，再带 cookie 调 `/api`。裸 `fetch` 会 401。

`params` 是**闭合**的：未声明的键一律拒绝（不是忽略）。可用 `describeConsoleMethods()` 导出全部方法及其字段、锁定方式、是否需要 reason。

---

## 6. 排查

| 现象 | 先看哪 |
|---|---|
| 点启动就报「未注入会话工厂」 | `config.runtime` 是否配了（本仓库已自动注入工厂，报这个说明配置没进 compose） |
| Agent 起来了但永远不动 | 读会话事件（见下）。多半是 `modelRoute.provider` 名字不对 |
| 动作全被 `classification_rejected`「模板未注册」 | 模型在猜模板名。提示词里的模板清单来自策略服务注册表，配了才会出现 |
| 域名目标一律 `dns_unresolved` | 地址裁决钩子没接（生产路径已接；自己 compose 时记得传 `resolveAddresses`） |
| `spawn run ENOENT` | argv 首元素不是 `docker` |
| 每个工具都 `invalid input syntax for type uuid` | dsh 会话标识被当成 worker 会话标识用了，缺 `resolveWorkerSessionId` 解析 |
| 「本会话不是渗透控制台创建的」 | 你在**聊天界面**（或 `dsh headless`）里开的会话里说话。那种会话没有、也**无法**事后补 engagement 绑定——绑定只由控制台 `startWorker` 创建。去侧栏「渗透作业」→ 选/建 engagement → 运行控制里「启动 Agent」 |
| 工具容器连不上外网 | **先看启动日志里 `[dsh-pentest] 沙箱可达性` 那一行**：`internal` ⇒ 这张网根本没有出口（改网络，见 §0 第三样）；非 `internal` ⇒ 可达范围等于宿主，而出网本身是**间歇**的（§6.5.9，别把一次失败当工具坏了）。`tcp_connect` 之类不吃 `HTTP_PROXY`，这点与网络形状无关 |

**「Agent 不动」怎么读会话事件**（插件日志里是一片空白，因为 dsh 的驱动错误被 `catch` 后只发 `agent/error` 事件）：

```js
// 在 DshSessionFactory.create 里临时加，读 agent.session.eventAt(SessionSeq(i))
// 关注这几类：turn/start、step/start、assistant/message、tool/call、tool/result、turn/end
// turn/end 的 reason.kind === 'error' 就是失败原因
```

会话日志文件在 `$DSH_HOME/sessions/<workspace>/<dshSessionId>/session.v3.jsonl.zstd`（zstd 压缩，`node:zlib` 的 `zstdDecompressSync` 可解）。注意轨迹可能走远端 provider，本地文件未必有完整内容——**内存里的事件才是权威**。

---

## 6.5 「渗透模式」预设

dsh 的预设选择器里现在有 **渗透模式**（与官方「标准模式 / 极简模式 / PDT 模式…」并列）。

它的文件在本仓 `presets/pentest/`，由 profile 的 `agent-presets` 行通过 `roots` 指向：

```yaml
- id: agent-presets
  config:
    default: standard
    roots:
      - path: C:/Projects/Agent-projects/dsh-DCG-pentest/presets
        trust: user
    includeShippedRoot: true
    includeUserRoot: true
```

**预设会挂到控制台启动的 Worker 会话上**（`Worker 会话将挂载预设 pentest`，会话元数据里记 `agentPreset: "pentest"`）。
这一点单独说，因为第一版**只交付了文件没挂载**，而 dsh 的 `agentPreset` 只是元数据——真正挂载要在 `setup(agentCtx)` 里调 `agentPresets.mount()`。当时的实际结果是：**聊天界面开的会话挂上了预设但永远拿不到 engagement 绑定，控制台启动的会话能做却没有预设**。两边各占一半，而用户在预设选择器里选到的正是前者。

**dsh 的预设无法由插件在运行时注册**——`@deepseek-ai/dsh-agent-presets` 的服务面只有
`list`/`resolve`/`mount`/`select`/`copy`/`remove`，没有「新增」；它每次调用都重扫
「内置根 → config.roots → `$DSH_HOME/.agent-presets`」，所以预设只能是**目录**。
把目录随插件发出去、再让 `roots` 指过去，是官方支持且可被 diff 审查的做法。

⚠️ 预设只声明 **agent 平面**的东西（提示词分节、agent 作用域的工具收窄与 skill）。
本插件的**控制台不在这一层**——它是一次注册、跨会话常驻的客户端界面；**状态机也不在**
这一层——权威事实在 PostgreSQL，界面只是它的投影。所以：

> 「渗透模式」= 会话的姿态（模型知道自己在受授权约束的作业里工作）。
> **状态机与各阶段 Agent 在控制台里**，见下一节。

预设里只有**两行**，都是「不在这一层就别无替代」的东西：

| 行 | 为什么必须在预设平面 |
|---|---|
| `persona` | 会话的姿态：让模型不必从零推断自己的边界 |
| `tool-ask-user` | 官方提问工具 `ask_user_question`。官方包的**宿主半是空实现**（包内注释原话：the model-facing tool is composed per preset, not here），交互界面由官方 `@deepseek-ai/dsh-client-ui-user-questions` 接管编辑器（带选项、多选、自定义答案、跳过）——所以「AI 提问、人类点选项」这条通道**只能**由预设挂 |

`anchored-standard` 那种挂了一堆 agent 平面行的预设，随 dsh 升级漂移过两次，而**漂移的代价是会话直接建不起来**。
这两行因此都钉在官方包名上（`@deepseek-ai/dsh-persona`、`@deepseek-ai/dsh-tool-ask-user`），
且 `@deepseek-ai/dsh` 自己就依赖它们——profile 目录解析得到。升级后若解析不到，会话会以
「挂载会话预设失败」**报出来**，而不是静默少一层姿态。

### 6.5.1 提问工具与能力冻结的耦合（改一边就会坏）

`ask_user_question` 同时出现在 `src/workflow/pg-workflow.ts` 的 `intakeTools` 与 `defaultToolAllow` 里。
预设走的是**祖先作用域**，所以 `tools.restrict({ allow })` 照样能把它挡在会话之外——两侧分工：

| 缺哪一侧 | 现象 |
|---|---|
| 预设那一行 | 工具根本没注册：模型问不了，人类收到纯文本问卷，得自己打字回答 |
| 工具面那一行 | 预设提供了工具但被冻结挡掉：人类同样看不到选项 |
| 工具面有、预设没有 | `restrict()` 因**未知工具名**抛错（fail loud），会话直接建不起来 |

最后一种由 `DshSessionFactory` 按事实裁剪兜住：预设没挂上的会话会把它从允许列表里去掉
（`#toolAllowWithPresetFacts`），避免「少一层姿态」升级成「一条会话都建不起来」。

三条断言把它们钉住：`test/pg-workflow.test.ts`（阶段默认工具面 + 预设行）、
`test/open-task.test.ts`（intake 工具面）、`test/dsh-session-factory.test.ts`（裁剪与放行两侧）。

实测闭环（本机，Cyber-Model-1）：会话在「渗透模式」下发一条授权说明 → Agent 调
`pentest_bootstrap_intake` 建作业 → 调 `ask_user_question` 发问（选项带 `(Recommended)`）→
人类在编辑器里点选并提交 → 答案作为工具结果回到 Agent（`{"answers":[{"id":"protocol","selected":["仅 TCP (Recommended)"]}…]}`）→
Agent 继续追问。范围确认本身**仍然**只能在控制台点，提问工具替代不了那个闸门。

### 6.5.2 会话卡片上的人类闸门（范围确认 / 逐动作放行）

同一个落点（`conversation.chat.turnTail`）还承载两个闸门，都在**最新一轮 AI 消息的正下方**：

| 闸门 | 卡片做什么 | 证据从哪来 |
|---|---|---|
| 范围确认（§13.1） | 目标/排除项/允许动作/授权说明 + 勾选 + 确认或驳回 | `getIntakeStatus` 的服务端事实 |
| 已确认之后（状态卡） | 标题按主状态分档（运行中 / 已交报告等你判断）+ 说明 Agent 在**另一个会话**里工作 + 去控制台 | `getState` + `listWorkerSessions` |

**阶段推进跟随会话**：一阶段一会话，因此每次启动或交接后，界面会**自动切到正在工作的 Agent 会话**
（`ctx.uiWorkspace.openSession`），这样才能直接看到思维链与输出。同一段工作只跟随一次——
你手动翻回旧会话时不会被反复拽走；目标会话已结束（closed/failed）时也不跟随。
| 逐动作放行（§10.3.1） | 逐条列出**完整命令**（不截断）+ 目标、类别、上限、影响评估、到期；填理由后批准或驳回 | `listApprovals`（`decisions:['pending']`）；判据复用放行队列的 `approvalGateOf` |

**两条纪律**：

1. **判据与证据只有一份**：卡片与放行队列共用 `approvalItemOf`（映射）与 `approvalGateOf`（闸门）。
   分叉的后果是「队列里能批、聊天里批不了」，或更糟——聊天里批准的不是队列里那条命令。
2. **乐观锁的版本号必须来自服务端刚给的状态**（实测踩过）：会话卡片用的是**会话级**控制器，
   它从未 `select()` 过作业，`mutate()` 会兜底成 `expectedStateVersion: 0`，于是卡片上的确认
   **必然**以 `stale_state_version` 失败（期望 0、实际 1）。现在 `IntakeStatus` 一并下发
   `stateVersion`，卡片用它发确认/驳回；版本真过期时**重读一次再试一次**（复用同一个幂等键）。
   控制台面板的确认同样在提交前先 `refreshState()`（Agent 推进版本而面板不轮询）。

## 6.5.3 实战前必检（四条，都是实测踩过的）

1. ~~**出口白名单必须包含本次要打的已确认目标**：代理容器的 `EGRESS_ALLOW` 是**唯一**出网路径，~~ —— **本节已废弃（2026-10-07）**：沙箱自 2026-10-05 起**直连、不经代理**，`buildDockerArgs` 只透传 `--network`，`proxyHost`/`proxyPort` 与 `egress-allowlist` 那套**已从代码里删净**（`cba7fd1`；启动器里残留的代理检查已于其后降级为"只提示不拦启动"）。出网与否只由 §6.5.9 的口径决定：网络 `internal` ⇒ 没有出口；非 internal ⇒ 与宿主同可达。下面几条关于 403/白名单的描述仅作历史背景保留：
   未列入的目标一律 `403 not in EGRESS_ALLOW`（现象像「工具坏了」——Agent 会把 403 读成
   「服务未识别」，而人类得翻到这里才知道发生了什么）。查看与修改：

   **正常情况下不用手工改**（2026-10-04 起）：范围确认/修订之后，插件会从**已确认范围**
   推导主机集合、把当前白名单并集上它、必要时按**原容器规格**重建代理（镜像/命令/环境变量/
   端口/挂载/网络都照抄，只换 `EGRESS_ALLOW`；只增不减，人类设的基础设施条目不会被删）。
   失败不阻断确认，只在宿主日志里写一行 `[dsh-pentest] 出口白名单未能自动同步（…）`。

   ```bash
   # 看当前值
   docker inspect pentest-lab-proxy --format '{{range .Config.Env}}{{println .}}{{end}}' | grep EGRESS_ALLOW
   # 自动同步失败时的手工兜底（也会被启动器预检拒绝复用旧容器——刻意如此）：
   docker rm -f pentest-lab-proxy
   docker run -d --name pentest-lab-proxy --restart unless-stopped --network bridge \
     -p 127.0.0.1:18080:18080 -e EGRESS_ALLOW=172.17.0.7,<已确认目标地址> \
     -v "$(pwd)/scripts/egress-proxy.py:/proxy/egress-proxy.py:ro" \
     python:3.10-slim-bullseye python3 /proxy/egress-proxy.py --port 18080
   docker network connect pentest-lab-internal pentest-lab-proxy
   ```

2. **靶标必须用 `-d /srv/www` 指到站点根**：`python3 -m http.server` 不带 `-d` 时把**容器根**
   当站点根，被动读取读到的就是整份文件系统目录列表（`.dockerenv`、`etc/`、`proc/`…）——
   2026-10-04 实测踩过，那一轮报告的「证据」因此是一份容器清单而不是页面。内容放宿主目录、
   只读挂载进容器：

   ```bash
   mkdir -p /c/tmp/dcg-lab-target
   printf '<!DOCTYPE html><title>DCG lab</title><h1>lab</h1>\n' > /c/tmp/dcg-lab-target/index.html
   printf 'User-agent: *\nDisallow: /private/\n' > /c/tmp/dcg-lab-target/robots.txt
   docker rm -f pentest-target-http
   docker run -d --name pentest-target-http \
     -v C:/tmp/dcg-lab-target:/srv/www:ro \
     python:3.10-slim-bookworm python3 -m http.server 8000 --bind 0.0.0.0 -d /srv/www
   # 地址必须与上面 EGRESS_ALLOW 里那个一致（bridge 默认按最小空闲地址分配；先删旧容器再建即可拿回同一地址）
   docker inspect pentest-target-http --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
   ```

3. **低风险类别不需要逐次放行**：`perActionApprovalClasses` 只含契约基线与高风险类（§10.3）。
   若你的作业是在**旧版本**上确认的（策略里 `passive_collection` / `active_probing` 以旧名
   `passive_read` / `active_discovery` 出现在放行集合里），**不需要改作业**：读侧会把旧值归一化到新值
   （改名映射见下），策略照常评估、账本照常渲染。

> **类别改名（2026-10-07）**：`passive_read` → `passive_collection`、`active_discovery` → `active_probing`、
> `authenticated_read` → `credentialed_access`（其余五个不变）。**历史行一个字不改**——`tool_runs` /
> `approvals` 上有 `action_class` 不可变触发器，数据库层面禁止原地重写；改名代价全部落在读侧归一化
> （`normalizeActionClass()`，映射表在 `src/contracts.ts` 的 `LEGACY_ACTION_CLASS_ALIASES`）。
> 因此旧账本里的 `action_class` 仍是旧串，**这是预期**，不是脏数据：按显示名读（`Passive Collection`）。
   每个动作都要人点一次——新建作业确认一次即可，或接受逐次放行。

4. **批准后 Agent 会被唤醒送达**（`tool.approval.notified`）：如果你在审计里看到
   `tool.approval.notice_failed`，说明消息没送到（会话可能已关闭）——用「插话」手动唤醒。

## 6.5.4 跟随 Agent 会话：**人类点击已生效**（自动跟随仍默认关）

**2026-10-03 更新（实机验证）**：运行卡的动作入口按真实状态给：

| 卡片状态 | 按钮 | 点击后 |
|---|---|---|
| Agent 已交报告（`waiting_human_review`） | **进入下一阶段：<下一阶段名>** | 请求草稿 → 按推荐路径确认 → **直接切到新会话** |
| Agent 还在跑 | 去看 Agent 的会话：dsh-… | 切到那条会话并停住（实测：卡片消失、统计从「5 次工具调用」变成「14 次工具调用」，4 秒后仍在） |

这张卡**不再提供控制台入口**（侧栏与常驻状态条已有）。

**阶段可见性（同一轮实测）**：活动 Agent 会话里渲染 `PhaseStrip`（`当前阶段 3/5 · 漏洞分析` +
五步轨道 + 状态便签）——此前那一页什么都不画，人类必须进「渗透作业」才知道走到哪一阶段。
控制台时间轴上每条会话带「**进入会话**」（与高亮是两个动作），点击即切到该会话的对话界面；
控制台面板是 root 级槽位，导航用 `ctx.sessions` / `ctx.uiWorkspace` 直连、不做工作区定位，
失败会在面板上方显示 `client/nav_failed` 并提示去左侧栏打开对应工作区。推进链路的组合逻辑在
`src/client/advance-phase.ts`，调用序列与载荷由 `test/client-advance-phase.test.ts` 锁住；
非推荐路径会被拒绝（强制移动要 `forced` + 独立二次确认，那属于交接编辑）。

自动跟随（人没点任何东西就切页面）仍默认关：它与人类正在看的东西可能打架，
开关是 `FOLLOW_ACTIVE_SESSION` → 现在只控制 `autoFollowSession`（**能力与触发分离**）。

**两个实测结论（下一个改这块的人直接用）**：

1. **插件运行在另一个 JS realm**：模块里写的 `window.__x` 在 `page.evaluate` 里读不到，
   但同一个模块写的 `document.documentElement.setAttribute(...)` 读得到。
   定位「页面到底跑的是哪一版代码」时**用 DOM 属性，不要用 window 变量**——否则会得出
   「代码没生效」的错误结论（这一轮就绕了这个弯）。
2. **宿主按 `rev` 缓存插件客户端**：清单里是
   `{"id":"dsh-pentest","url":"/plugins/??dsh-pentest/client.js&rev=<hex>-<n>"}`，
   `rev` **不随仓库里的重新构建而变**。因此「改了客户端代码 → 重启宿主」不一定拿到新包；
   验证时以 `document.documentElement` 上的构建标记为准（本轮用它确认了页面确实是新包）。



> 读服务的两个方向见 §6.5.7：**声明过**的服务用属性访问（`ctx.get` 会拿到 inert 实例，本条讲的就是这个坑）；
> **未声明**的可选服务反过来，只有 `ctx.get` 生效（属性访问是 inert stub）。两者都实测过。

期望行为：每次启动/交接后，界面自动切到正在工作的 Agent 会话（思维链与输出都在那一侧）。

**现状（实测，探针已移除；结论在第二轮深挖后更正）**：

| 观测（仪器） | 结果 |
|---|---|
| 跟随决策（探针） | ✅ 每次页面加载触发一次（`markSessionFollowed` 去重），目标选对 |
| 导航调用是否生效（**渲染器**的 `useSessions` 钩子 = 与侧栏同一个 store） | ✅ **确实改了活 store**——上一轮「实例没接线」的判断**已被推翻**（`sessions.list.getSnapshot()` 那个读法本来就不可靠） |
| 同一窗口后续 | ❌ ~1 秒后被切回旧会话；重开者也走 `UiWorkspaceService.openSession`（正规路径），**调用者未定位** |
| 已排除 | layout 服务没有会话选择 API（只有 `selectPanel`）；右侧栏的 `actions.open` 是**面板**动作而非导航；`ctx.get` vs 属性访问、`inject` 声明、先 `connectWorkspace`、`ctx.sessions.open` vs `uiWorkspace.openSession` —— 结果全部一致 |
| 社区/官方 | `ui-workflow-run`（`ctx.sessions.open`）与 `@kt11/dsh-session-manager`（`sessions.open`）是同一调用，无新招 |

**已加的保护（可测）**：`followUntilSettled`——打开目标后用**渲染器报告的当前会话**核对是否落定；
被切回就再试，最多 3 次、间隔 700ms，落定即停手（`test/client-intake-prompt.test.ts` 四条断言：
一次即落定 / 被切回一次 / 一直不落定也有限 / `attempts=1` 不成死循环）。
**线上效果尚未验证**：深挖后期已无法稳定复现「当前会话 = 本作业 intake」这一条件
（点击落点漂移、注入 `dsh.sessions.current` 不被接受、重载会落到空白会话），故这一步只到「机制已测」。

**兜底（已交付）**：控制台 → 选中作业 → 总览里「运行控制」下方就是 **「当前 Agent 轨迹（阶段）」**：
它走 dsh 自己的 `session/page` 端点（只依赖服务端，必定可用）读**当前活动 Worker 会话**的事件流，
把**思考、工具调用（含参数）、工具结果、回复**原样铺开，运行中每 5 秒自动刷新；状态便签与结论也在那里。
单条文本展示上限 600 字符（完整内容仍在会话事件里），工具调用与结果各只画一次。

**手动看完整会话**：侧栏里那几个 `dsh-pentest-sessions` 就是各阶段的 Agent 会话，点进去即是完整轨迹
（含用量与全部历史）。

## 6.5.5 UI 视觉自检（可复跑的检查）

**静态覆盖自检（先跑这个）**：插件历史上出过「组件只带类名、样式从未交付」的缺陷
（阶段轨道因此退化成文字列表）。现在它是**一条命令**，进构建闸门：

```bash
npm run verify:styles
# 期望：类名 346/346、无字面颜色、令牌全部已定义

# 一次跑完全部门禁（样式 / 承诺接线 / 端点面一致性 / 客户端产物 / 前向迁移）：
# 前置：先把 `lib/` 构建出来（verify:client 读 `lib/client.js`，没构建会失败）——
#       即 `npm run build && npm run verify`；数据库口径见 §1 的警告（测试与迁移演练分库）。
npm run verify
```

它检查三件事：每个 `pentest-*` 类名都有规则；组件样式里零字面颜色（颜色只在
`src/client/design.ts` 定义一次）；每个 `var(--pt-*)` 都有定义（写错的令牌不会报错，
只会静默变透明）。设计系统本身另有 `test/client-surfaces.test.ts` 锁着：令牌块挂在
每个渲染入口、深色单主题的对比度达标、字体随包内联、根元素清单不得被当选择器前缀用
（那次把主面板压成 35px 的就是这个）。

**运行期自检（静态扫描看不见的那一半）**：tone 修饰词是运行时拼的
（`toneClass('pentest-statusbar', tone)`），静态 grep 抓不到。打开控制台并在浏览器控制台执行：

```js
(() => {
  const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  const styled = new Set((css.match(/\.pentest-[a-z0-9_-]+/gi) ?? []).map((c) => c.slice(1).toLowerCase()));
  const used = new Set();
  for (const el of document.querySelectorAll('[class]'))
    for (const name of el.classList) if (name.startsWith('pentest-')) used.add(name);
  return [...used].filter((n) => !styled.has(n));   // 期望：空数组
})()
```

遍历八个面板（总览与时间轴 / 报告审阅 / 记忆浏览器 / 放行队列 / 交接编辑 / Skill 库 / 范围管理 / 公共记忆）
各跑一次。**当前基线：8/8 面板 0 个未上样式的类**（2026-10-04 深色 CRT 重设计后复测：
运行期 47 个类全部有规则；`--neutral` 这类运行时 tone 是靠这一步才发现并补上的）。

**视觉方向与令牌（2026-10-04 人类决定）**：深色单主题、**天蓝强调**的 CRT 仪表盘（第一版是磷光绿，
实机看过后判定「墨绿和 dsh 不太配」，改为与 dsh 主调同源的天蓝），不再跟随宿主
`--dsw-alias-*` 令牌。颜色/字体/间距/动效的唯一来源是 `src/client/design.ts`；样式按域拆在
`src/client/styles/{tokens,base,shell,panels,chat}.ts`。字体是随包的 Cascadia Mono（OFL，
`assets/fonts/CascadiaMono.ttf` → `node scripts/embed-font.mjs` 生成 `src/client/fontAssets.ts`，
`prebuild:client` 会自动跑）；它内联进 `lib/client.js`，因此客户端产物从 547KB 涨到 1.10MB
（本地加载，一次性）。

**溢出判据要排除「刻意横向滚动」的容器**：`.pentest-track`（阶段轨道，5×168px）本就带
`overflow-x:auto`，把它算成溢出是假阳性。判定用
`getComputedStyle(el).overflowX === 'visible'` 再比 `scrollWidth > clientWidth + 4`。

**常驻的 pg 弃用警告（已归因，属升级风险而非现网故障）**：日志里偶发
`Calling client.query() when the client is already executing a query`（重启 4 次出现 1 次）。
机制：`compose.ts` 的 `txDb` 是**单条写连接**（事务由 `#tx` 队列串行化），但账本 outbox 的
drain 等常驻路径会在事务之外用同一条连接——pg@8 会把语句排队（所以数据不会错），pg@9 将移除该行为。
升级 pg 前必须把这些路径也纳入队列（或用独立连接）。抓栈：`NODE_OPTIONS=--trace-deprecation` 重启。

**宿主重启后的会话边界（实测，2026-10-03）**：`DshSessionFactory` 的会话表是**进程内**的
（`#live`）。重启宿主后，旧进程创建的 dsh 会话一律取不到 → 任何「续跑该会话」的动作
（交接草稿 `requestHandoffDraft` 是其一）都会抛
`SessionFactoryError: 会话不存在（本进程未创建过它）`。
因此**开发期频繁重启**会让界面上一切「接着上次的会话继续」的动作失败；正常长跑不会。
出路：在当前阶段用「重做」（`retryWorker`）开一个新会话，那个会话属于当前进程，后续动作就正常了。
这类失败已翻译成 `lease_revoked` + 可行动文案，不再折成 `console/internal`。

**内部错误必须落 stdout**：`ConsoleRpc` 的 `onInternalError` 此前**从未接线**（响应里那句
「原始细节见宿主日志」当时是假的）。现已接到 `console.error`（含方法名与栈）。
排查同类问题：直接读 `proc://dsh-console-dev` 的服务日志。

## 6.5.9 沙箱出网的事实与三个坑（本轮实跑踩出来）

**事实**（2026-10-05 起，已改写）：沙箱**可出网**——操作者把沙箱网络 `pentest-lab-internal` 由
`--internal` 改成普通 bridge（同网段 172.29.0.0/16、靶标 IP 不变），profile 写 `sandbox.allowEgress: true`。
含义：
  - **可达范围 = 宿主可达范围**（公网、局域网、宿主已发布端口都通），**外部 DNS 也通**；
  - **网络层不再是范围边界**——admit 的范围裁决 + 逐次人工放行是仅剩的两道闸门；
  - 「打不通」的归因因此要重新学：`ENETUNREACH` 不再是默认答案，先分清是目标侧过滤、DNS、限速还是服务没起；
  - 授权目标与沙箱仍应同网（直连、不经代理）；目标没接进网络就是超时（见坑 6）；
  - 回退到封闭动作集：网络重建为 `--internal`（同网段）并删掉 `allowEgress`（预检据此拒绝非 internal 网络）。

**但它是间歇的（2026-10-06 实测，同一天两次结果相反）**：同一条命令上午 `curl -m 8 http://example.com/` = 200、
`nvd=200 osv=200`，下午同一批请求变成 `curl: (7) ... after 4201 ms` 全超时、`Could not resolve host: api.osv.dev`。
所以：

- **不要把「有出网」当作可靠前提**：任何依赖外网的步骤（`vuln-intel` 查 NVD/OSV/CISA、给 nuclei 拉模板……
  ）都必须有**离线退化分支**，而且要把失败形态原样记进证据——「解析不了 / 超时」本身就是要写进报告的事实。
- `vuln-intel` 的正文把「外部线索不可用」写成兜底分支，实际用下来它是**常态路径**，不要把它当异常。
- 归因顺序也要跟着改：先看是不是网络抖（重试一次、看 `%{http_code}` 是不是 000），再怀疑目标。
代理容器仍在，但只服务「经代理出网」的部署形态——它**不是**沙箱的出口边界，
白名单同步（`EGRESS_ALLOW`）也只维护代理自己。探测任意**授权端口**：端口写在 `target` 里
（`http://host:3002/`、`https://host:3002/` 都行，**不限于 80/443**）。

**坑 1：两套网络/代理并存，改错等于没改。**

| 用途 | 网络 | 代理 | 端口 |
|---|---|---|---|
| **profile（实际运行）** | `pentest-lab-internal` | `pentest-lab-proxy` | `18080` |
| 仓库 dev overlay 默认 | `pentest-internal` | `pentest-proxy` | `8080` |

改代理白名单前先 `grep -n 'internalNetwork\|proxyHost' ~/.dsh/profiles/<profile>/cordis.patch.yml`
确认真身。`start-personal.mjs` 的前置检查原先只看环境默认值（会报「pentest-proxy 通过」而运行期
走另一条链路）——现已改为**以 profile 为准**。

**坑 2：`docker/tools/pentest-tool` 必须是 LF 行尾。** 它以 shebang 在 Linux 里执行，
CRLF 会让容器报 `/usr/bin/env: 'python3\r': No such file or directory`（本轮被冒烟测试抓到）。
用脚本改这个文件时注意别把行尾写成 CRLF。**用 Python 改它必须 `newline=''`**：Windows 上默认会把
`\n` 翻成 `\r\n`，本轮就是这么把镜像构建坏的（冒烟立刻报 `/usr/bin/env: 'python3\r'`）。

**坑 5：新增工具命令要在 `DEFAULT_TOOL_TIMEOUT_MS` 里登记。** `budget_ms(tool)` 直接索引那张表——
漏登记不是「取默认值」而是 `KeyError`（本轮 `shell_exec` 第一次冒烟就撞上；命令回显先于异常写出，
所以报告里看得到原始命令）。凡在 `TOOLS` 里加命令，同步加超时项。

**坑 6：沙箱直连后，靶标必须接进 `internalNetwork`。** 放开前目标在 bridge、沙箱走代理也能到；
放开后沙箱直连，必须 `docker network connect pentest-lab-internal <靶标容器>`（本轮就是这么修的）。2026-10-05 起该网络非 internal、沙箱可出网：靶标仍要接进来才可达，但「接进来」不再是范围的唯一保证——范围由闸门裁决。
症状：`nmap` / `curl` 一律超时，而代理日志里什么都没有——因为这次根本没走代理。

**坑 7：NET_RAW 只有 root 拿得到（本轮子代理实测）。** 给非 root 用户 `--cap-add NET_RAW` 时，
`CapEff=0`（能力只在 bounding set 里），`nmap -sS` 直接报 "requires root privileges"；
改成容器内 root 后 `CapEff=…2000`、SYN 扫描正常。要验证就进容器看
`grep CapEff /proc/self/status`，不要只看 `docker inspect` 的 CapAdd。

**坑 3：改完镜像要同步摘要。** `sh scripts/dev-sandbox-up.sh up` 会打印新摘要，必须写回
**profile 与 `harness.dev.patch.yml` 两处**（启动器的预检会核对 RepoDigest）。

**坑 4：`PENTEST_DATABASE_URL` 不要留成 `pentest_app`。** 迁移 002 把 `pentest_app` 建为
**NOLOGIN**（RLS 测试断言它保持如此），启动器用「可登录的管理角色连接 + 运行期 `SET ROLE` 降权」
的方式工作。把一个 `postgresql://pentest_app:…@…` 写进**用户级**环境变量，后果是
`node start-personal.mjs` 的预检直接失败：

```
个人数据库连接失败：pentest_personal（127.0.0.1:55446）——password authentication failed for user "pentest_app"
```

处理：删掉该变量（启动器自带正确默认）或在命令上显式传管理角色连接串。本轮重启 harness 时又撞了一次
（用户级变量被写成 `pentest_app`），已改回 `postgresql://postgres:<密码>@127.0.0.1:55446/pentest_personal`；
**进程重启会带走环境**，凭据要么落在用户级变量里、要么显式传给启动命令。
另外**测试库是 `pentest`、不是 `pentest_personal`**（§4 的表）：测试套件会按 engagement 清理数据，
拿个人库跑测试是在拿战果冒险。跑测试的完整姿势见 §7 已知边界里的「全量测试」一条。

## 6.5.10 沙箱权限（2026-10-04 放开）：真工具、直连内网、预设只做提示词

**三件事变了**（旧版「只有五个模板可用 + 只能走 HTTP 代理 + 模式硬闸」的说法已作废）：

1. **镜像装真工具**：`nmap`、`curl`、`wget`、`nc`、`dig`、`openssl`、`jq`、`whois`、`ping`、`ffuf`、
   `sqlmap`（外加 python3 与 `requests` / `dnspython` / `beautifulsoup4`、`/usr/share/wordlists` 下的字典）。
   构建期需要网络——旧注释里的「零网络依赖」不再成立。工具清单在 `SANDBOX_TOOLBELT`（它进提示词，
   **改镜像必须同步这一行**，否则提示词会撒谎）。
2. **argv 放开**：`--cap-drop ALL` + **仅** `--cap-add NET_RAW`（真 SYN 扫描需要；多一个 cap 就多一分
   逃逸面）；去掉只读根；`/tmp` 改 `rw,exec,size=512m`；限额提到 2 CPU / 2G / 512 pids。
   **不再注入 `HTTP_PROXY`/`HTTPS_PROXY`**——真工具穿不过 HTTP 代理。
   **容器内以 root 运行**（镜像不再切 `USER pentest`）：NET_RAW 只对 root 生效，非 root 进程
   拿不到 `--cap-add` 的能力（Docker 不放 ambient set）。边界不靠容器内的用户——靠一个 cap、
   无特权、无宿主挂载/套接字、限额、`--rm` 即弃。
3. **出口边界**（2026-10-05 改写）：~~容器只接入 `internalNetwork`（无外网路由），该网络的成员集合就是可达集合~~
   **该网络已改为非 internal、沙箱可出网**（见 §6.5.9）⇒ 网络层不再是范围边界，仅剩 admit 范围裁决
   + 逐次人工放行两道闸门。仍然成立的一条：⚠️ **别把非授权目标接进这个网络**——沙箱（有 `NET_RAW`）
   与同网成员同处一个二层域，多一个成员就多一个可攻击的邻居。
   **代理容器已从该网络断开**（2026-10-04）：直连部署不需要它，而它留在上面等于给沙箱
   （有 `NET_RAW`、同处一个二层域）多一个可攻击的邻居；断开后这个二层域里只剩沙箱与授权靶标，
   正好是设计文档 §10.4 要求的「独立二层域」缓解。启动器不再要求代理接入该网络：接上了会打一行
   **提醒**（旧形态），不拦启动。
   预检把这条边界做成了硬闸：网络成员除代理外必须在 **`PENTEST_LAB_TARGETS`**（逗号分隔的容器名）
   里显式声明，否则 `node start-personal.mjs` 拒绝启动（已写进用户级环境变量：
   `PENTEST_LAB_TARGETS=pentest-target-http`）。换靶标/加靶标时同步改它——它就是「我授权哪些目标
   与沙箱同网」的声明。

**行为预设改成提示词、且成了必选项**（2026-10-04 改提示词；2026-10-05 起必选 + 场景化）：
四档=四种作业场景——`stealth`（红队隐蔽）、`standard`（已通知授权）、`deep`（高许可穷尽）、`custom`（人类写指引）。

| 预设 | 场景 | 注入指引的骨架 | 默认节奏 | 默认启用类别 |
|---|---|---|---|---|
| `stealth` | 红队 · 隐蔽测试（被看见即失败） | 允许被动/低噪声；不做全端口与爆破；留痕与外传禁止 | 1/s·并发1 | passive_collection、active_probing |
| `standard` | 已通知的授权渗透测试 | 常规识别+最小化验证；失败也要记录 | 5/s·并发2（**仅结构化动作**） | + credentialed_access |
| `deep` | 高许可 · 穷尽利用尝试 | 全端口/爆破/多路径利用；**穷尽=尝试并记录**，不是必须打进去 | 10/s·并发4 | + exploit_validation |
| `custom` | 自定义（人类写指引） | 逐字注入人类写的 `customGuidance`（≤2000 字），冲突时优先 | 同 stealth | 同 stealth |

> **「默认节奏」只约束结构化动作**（`pentest_recon` 的模板：命令形态由服务端固定）。
> 自由命令 `pentest_exec`（`direct_command`）**不经过这套限速**——它的实际速率取决于命令自身。
> 另外它的**审批口径按阶段**（2026-10-09 裁定）：①②③ 免批、④⑤ 逐条人批（类别分别记成
> `exploit_validation` / `lateral_movement`）。2026-10-08 操作者实测：nmap 在网段上的实测约
> **ICMP 60 目标/秒、TCP 90–400 探测/秒**，远高于表里的 5/s；按 5/s 估算会得到
> 「/16 普查要 3.6 小时、不可行」这种**错误结论**（实际是 10 分钟量级）。
> 要限速就自己在命令里给 `--max-rate`。

> **墙钟上限 = 模板声明与沙箱上限取较小者**（`min(plan.timeoutMs, DEFAULT_SANDBOX_LIMITS.maxWallClockMs)`）。
> 出厂两张命令模板的 `timeoutMs` 都是 **300 秒** ⇒ **自由命令 `pentest_exec` 实际是 5 分钟**；
> 沙箱上限（当前 15 分钟）只是**上限**，不是默认。结构化模板各自声明，`recon_port_scan`/
> `recon_service_probe` 同样是 300s。会话简报里会写出实际生效的 `wall_clock` 分钟数——以那行为准。
>
> ⚠ 本条曾在本文件里被写错成"自由命令 15 分钟"（我按 `pentest_exec.timeoutMs` 推断，
> 漏了模板声明会取小）——**以 `sandbox-brief.ts` 下发给模型的那一行为准**，那是唯一经过
> 同一份常量算出来的地方。

**必选**：建作业向导、会话内的范围确认卡、控制台的范围确认卡三处都要求**显式选择**（服务端 `createEngagement`/`confirmScopeProposal` 的 `behaviorProfile` 是必填参数；缺了报 `console/argument-invalid`）。agent 引导路径建作业时预设是数据库兜底值——**确认范围那一刻就是人类决定档位的时刻**，所以卡片不给预选。

**自定义指引**：只有 `custom` 接受 `customGuidance`；它逐字注入该作业下每一次会话，并随策略快照冻结、进哈希（改它等于改策略，旧放行凭证失效）。给非 custom 档位传指引会被**拒绝**而不是忽略。

改预设/改指引=改策略。原有的提示词逻辑：`stealth` / `standard` / `deep` / `custom` 各自渲染一段行为指引
（`src/policy/behavior-prompts.ts`）注入会话提示词，说明要多安静、覆盖到什么程度、宿主给的速率上限。
**超出预设的动作不再被拒**：`service.ts` 记 `beyond_behavior_preset` 并**强制走人工放行**
（`requiresApproval = beyondPreset || perActionApprovalClasses.includes(actionClass)`）——
拒绝只会让 Agent 反复试探或放弃合理动作，把人留在回路里才是边界。

**没变的硬边**：默认禁用类别（persistence / destructive / exfiltration，未双确认时仍硬拒）、
逐次放行下限 `PER_ACTION_APPROVAL_CLASSES`（`actionPolicyFromSnapshot` 里写死 `[...基线, ...extra]`，
任何覆盖都摘不掉）、范围闸门、幂等键、全量证据（命令 + stdout/stderr + 退出码落 `tool_runs`）。

**没锁住的三件事（免得误判）**：① **端口粒度**——网络是主机级的，容器可打该网段内任意主机的任意端口；
② **参数黑名单对直连命令不生效**（`allowFreeForm`），人类审批档下放行卡是唯一内容闸门——**放行前真的读那条命令**；
③ **审批模式为「高权限」时连这道闸门也没有**（预设内的动作由服务端自行放行）：此时"命令内容"在人类看到之前就已经跑了，兜底只剩范围闸门（主机/端口）与审计账本。**高权限档必须配合选对的预设**，否则"预设内"就是一条无限宽的许可。

**回归锁**：`test/docker-sandbox.test.ts`（argv 不变量：恰好一个 cap、无代理变量、无特权/宿主挂载）、
`test/policy-profiles.test.ts`（四档预设各有姿态、都写明升级规则、上限进提示词）。

**`tcp_connect` / 工具直连与 banner 判读**：沙箱现在直连内网目标，`port_state: open` 后报告会带对端
banner；**TLS 端口的服务不主动发 banner 属正常**，报告如实写「对端未主动发送」，不要当成故障。
旧的「经代理隧道（`egress: proxy …`）」结论作废——那条路径已不再使用。

**「进入下一阶段」是状态机的事，不是人类要回答的问题**（人类报障，2026-10-03）：
Agent 曾在被要求「进入下一阶段」时反问「哪个阶段」。每个阶段都是预设状态机里的一格，
下一阶段由当前阶段唯一确定——反问等于把状态机的事实推回给人。根因是**能力缺口**：Worker
工具面里没有任何准备交接的入口。现在 `pentest_prepare_handoff` 的 `suggestedToPhase` 可省略，
服务端按 `RECOMMENDED_MOVES` 的 advance 项解析目标阶段；只有回补/回滚/跳级才显式给 `to_phase`
（强制移动），非法阶段就地拒绝。**人类闸门不变**：该工具只产出草稿，切换仍由人类确认。

## 6.5.11 各阶段 Agent 的 skill 装备（知识与工具面一起放开）

- **源文件**在仓库 `skills/<name>/SKILL.md`（格式与撰写规格见 `skills/README.md` 与
  `skills/AUTHORING-SPEC.md`）；**运行时**在 `pentest.skills` 表。
- **播种**：`PENTEST_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:55446/pentest_personal \
  node --import ./test/helpers/tsx-loader.mjs scripts/seed-skills.ts`（幂等：内容没变跳过；
  改动则 revision+1 留痕）。当前库里 **25 条**：情报 **5**、威胁建模 5、漏洞分析 **6**、利用验证 5、后渗透 **4**
  （2026-10-06 起新增 `recon-ad-surface` / `vuln-ad-checks` / `vuln-api-checks` / `post-lateral-pivot`；
  权威清单是 `src/skills/skill-pack.ts` 的 `SKILL_PACKS`，这里只是快照）。
- **怎么到 Agent 手上**：会话创建时能力快照列出「已装载 skill：名字（一句话描述）」；
  正文用 **`skill_load`** 按需取——**只有该会话装载的名字取得到**（装载在创建时冻结，
  库里的其它 skill 对它不可见，这是 `PgWorkerTools.loadSkill` 的第一道判断）。
- **改了 skills/** 之后必须播种（否则库里的旧版本继续被装载——2026-10-06 实测：库里还是 21 条、
  而仓库已有 25 条，新增的 AD/API/跳板技能在会话里根本看不到）。播种后核对一行：

  ```bash
  docker exec <pg 容器> psql -U postgres -d pentest_personal -t -c 'select count(*) from pentest.skills'
  # 期望 = `ls -d skills/*/ | wc -l`（当前 25）
  ```
- **默认装载**写在 `src/skills/skill-pack.ts` 的 `SKILL_PACKS`；人类在控制台仍可改勾选。
- 正文是**会被模型当指令执行的内容**：新增/修改走服务层（哈希 + 审计），别直接改库。
  未配 `skillAuditEngagementId` 时启动日志会明确警告「skill 增删改不写审计」——这是已知缺口。
- **空库必播种**（2026-10-10 操作者踩到）：新库/换库后 `pentest.skills` 是 0 行，
  而会话的 `skill_ids` 照样冻结着 5 个名字——`skill_load` 于是**全部拒绝**，
  消息里还会把请求的名字列进"已装载"清单（旧版本把"库里没有"误报成"不在装载集合"，
  那一处措辞已在 2026-10-10 的 P0 修复里改准确）。核对一行即可确认：

  ```bash
  node -e "const{Client}=require('pg');const c=new Client({connectionString:process.env.PENTEST_DATABASE_URL});c.connect().then(()=>c.query('select count(*) from pentest.skills')).then(r=>{console.log('skills =',r.rows[0].count);return c.end();})"
  # 期望 25；为 0 就按本节开头的播种命令跑一次
  ```

## 6.5.12 dsh 升级（0.1.5-rc.2 → 0.2.0-rc.2）：现状与解锁条件（2026-10-06 实测）

**结论：本插件侧已就绪，但升级被生态阻塞——现在不能升。**

实测过程（在真宿主上跑，不是读文档）：

| 项 | 结果 |
|---|---|
| 宿主从哪来 | 本仓库的 `node_modules/@deepseek-ai/dsh`（`start-personal.mjs` 直接 spawn 它）⇒ 升依赖就等于升宿主 |
| 本插件在 0.2.0-rc.2 上 | `typecheck` / `lint` / `build` 全绿，**1787 项测试全过**（含客户端产物与 typert 端点面） |
| 启动预检 | 通过（Docker、网络、代理、镜像摘要、个人库；迁移已是最新 26 项），本插件的启动自检也照常打印 |
| **阻塞 1：生态插件** | `dsh-budget` / `dsh-permission-rules` / `dsh-defend` / `dsh-mask` / `dsh-observe` 的**最新版本**仍把 peer 钉在 `@deepseek-ai/dsh-llm: >=0.1.2-rc.1 <0.2.0`（**明确排除 0.2**）。实测启动直接失败：`startup failed: 2 required plugins did not activate`，其中 `typert-loader` 报 `dsh-budget#budget/status parameter codec has no create() factory`（0.2 的 typert 校验更严，旧版清单不合规） |
| 阻塞 2（环境，与版本无关） | 起不来时先查端口：`PENTEST_PORT=3092` → `listen EACCES 127.0.0.1:3092`；**3090 同样不可绑定**（本机落在 Windows 保留段里——`netstat` 显示"空闲"不代表能 bind）。**已修**：`start-personal.mjs` 现在先探测端口，绑不上就退回 `0`（系统分配）并打印提醒——症状从"60 秒后说没拿到可用页面"变成一行明确的提醒 |
| 副作用（回退时必做） | 0.2 的 `dsh-settings` 会把 `~/.dsh/settings.yaml` **改名为 `settings.yaml.imported`**（日志里体现为 `settings: section … was not imported into entry …` 警告）。回退到 0.1.5 后宿主找不到 settings 会**静默挂住**（不报错、不打 URL）。修法：`cp -n ~/.dsh/settings.yaml.imported ~/.dsh/settings.yaml`，**并检查 `agent-presets:` 一节还在不在**——它在文件里时默认模式才是「渗透模式」（2026-10-06 实测：恢复出来的旧备份少了这一节，默认模式悄悄回落到 `standard`） |
| 插件配置层级 | `recovery` 是**顶层键**（与 `runtime` 并列）；写进 `runtime` 里会被静默忽略（启动告警原话：「请把它移出 runtime」）。个人 profile 里那一处已改正（2026-10-06） |

**解锁条件**：那 5 个生态插件发布 `dsh-llm`/`dsh-tools` peer 放开到 0.2 的版本。届时按这个顺序升：

```bash
# 1 升依赖（11 个 @deepseek-ai 包 = 0.2.0-rc.2，cordis → ~4.0.4），再装
pnpm install --no-frozen-lockfile
# 2 三件套 + 五道门
npm run typecheck && npm run lint && npm test && npm run verify
# 3 重跑设计文档 §21 的 API 校准（0.2 已知差异：KNOWN_SESSION_EVENT_TYPES 56 → 59 项，
#   新增 developer/message、image/offload、workspace/changes；cordis 两参调用点未变；
#   dsh-session 新增 ./fork 子路径；dsh-client-connection 新增 ./client 子路径）
# 4 真启动验收（不是只跑测试）：PENTEST_PORT=3090 node start-personal.mjs，看
#   "前置检查通过" + 无 failed plugins + 控制台能开（视图→端点那条链必须真走一遍）
# 5 同步 docker/package.json 的四个版本钉 + 设计文档 §21 的版本标签
```

> **为什么第 4 步不能省**：测试覆盖的是我们自己的代码；宿主装载失败（比如上面那个 typert codec）
> 只在真启动时才现形。本次就是靠真启动才发现"插件全绿、profile 起不来"。

## 6.5.13 2026-10-10 操作者实测的四处阻碍与修复

一次 11 分钟的实弹测绘（主通道跑完 55 条路径、零审批摩擦）之外暴露的四个硬阻塞，全部已修：

| 阻碍 | 根因 | 修复 |
|---|---|---|
| `port_scan` / `service_probe` 传 `ports="3002"` 被以「端口 80\|443 未授权」拒绝 | 多端口动作在 `portSource` 里声明 `none`，范围闸门把"无端口维度"回落成默认 web 端口，**显式端口只进了命令、没进闸门** | 新增 `ScopePorts`（none / web-default / ranges / unbounded）与 `portSource.kind='ports-param'`：闸门解析端口表达式与档位，**每个端口**都必须被条目覆盖；`top100/top1000` 不可枚举 ⇒ 需全 TCP 授权（`scope.ts` / `port-expr.ts` / `templates.ts` / `admission.ts` / `compose.ts`） |
| `content_discover` 无法枚举 `/api/` 下的路由（`wordlist=api_endpoints` 被参数校验拒） | 镜像里早就装了 `api-endpoints.txt`/`quickhits.txt`，参数面只有三档；且 URL 固定为 `/FUZZ`，**没有基准路径** | 字典档位扩到 `common_dirs/raft_small/api_endpoints/quickhits`（每动词一张允许表 `WORDLIST_ALLOWED`），新增 `path` 基准前缀（空串=站点根，`..`/查询串拒绝）；宿主枚举与容器允许表由 `test/action-templates.test.ts` 逐字对拍 |
| `skill_load` 拒绝 `recon-network-surface`，而拒绝消息同时把它列为已装载 | ①`pentest.skills` 为 **0 行**（技能库从未播种）——任何名字都取不到；②旧消息把"库里没有"误报成"不在装载集合"；③`insertWorkerSession` 的 VALUES 把 `skill_freeze` 与 `model_route` **写反**，内容冻结保护静默失效 | ①已播种 25 条（本节上方命令）；②拒绝消息区分"库里不存在/被删/被禁用/不在装载集合"（P0-1）；③修 INSERT 参数对齐并加回读回归锁（`test/skill-load.test.ts` 走**生产** `insertWorkerSession`） |
| `memory_search` 五次全报 `column "kind" does not exist` | 零命中诊断查询里 `kind` 未限定别名（该列在 `memory_items`，`memory_chunks` 没有），且 `JOIN context_events` 是 INNER JOIN、会丢掉"条目来源"的分块 ⇒ **每次零命中都抛错**（新作业的常态） | 诊断查询改用 `mc.engagement_id` 直连 + `LEFT JOIN memory_items mi`；回归锁 `test/memory-search-diagnostics.test.ts`（零命中必须返回带诊断的 note，且条目来源分块计入计数） |

**已存会话的影响**：修复前创建的会话里，`skill_freeze` 存的是模型路由（冻结三元组的保护对它们**
不生效**，退回"只按启用状态可读"）；`model_route` 存的是冻结数组（交接压缩读 `.model` 读不到 ⇒ 模型
选择退化为默认）。这两处对**新会话**已修正；旧会话不必重建——播种后 `skill_load` 即可用，
冻结保护从下一个会话起生效。

### 6.5.13.1 同日第二轮实测（7 条）的修复

第二轮反馈里有 4 条是**部署副本没换**（§6.5.15）导致的假象，另外几条是真缺陷：

| 现象 | 根因 | 修复 |
|---|---|---|
| `verify_tls: false` 却记成 `verify_tls=true`（自签目标连得上、账本写"已校验"） | `buildStructuredIntent` 用 `String(value)` 校验枚举，却把**原始布尔**存进参数；模板枚举只认字符串 `'true'/'false'` ⇒ 布尔在下一道被拒/回退成默认。LLM 看到 `enum:['true','false']` 就传布尔，是常态 | 枚举参数**归一化为字符串**再落参数（`techniques.ts`）；回归锁三条（布尔→字符串、非枚举保型、转换后可过模板校验） |
| `pentest_workdir` 报错三处说法互相打架（描述说相对路径／message 要容器前缀／next_action 说只用相对路径） | 多根部署写新文件的 `next_action` 与 `WorkdirError.message` 各写一半；示例路径 `/mnt/engagement` 是**硬编码**，与会话里实际挂载根无关 | 统一措辞：**多根 + 新文件必须带容器前缀**，单根/已存文件两种都行；`op=list` 返回值新增 `roots`（容器路径 + 只读标记）让模型自查；描述里删掉硬编码示例、改为"可用根见 `roots`" |
| 提示词用整节介绍 `pentest_vuln_check`（三个 technique 的完整参数表），但**能力快照里没有这个工具** | 工具真名是 `pentest_scan`；指南/提示词里写的是早期的占位名 | 全量改名 → `pentest_scan`；`exposure_check` 的 `paths` 语义改对（是**项名** `git,env,swagger`，不是路径字面量）；补上第 4 个 technique `nse_handshake`；提示词引导与参数指南的开关都按真实工具名判定 |
| 参数指南里 `content_discover` 仍只有两档字典、没有 `path` | 指南（`technique-params-guide.ts`）与工具枚举是两份手抄，第一轮只改了工具侧 | 指南补齐 `api_endpoints`/`quickhits` 与 `path`（含"条目自带 `api/` 前缀、在站点根用"的分辨点） |
| `whois 47.109.76.66` **完全无输出**（rDNS 也空），归属无法确证 | 客户端 5.5.17 的默认路径先问 IANA 取转介，**IANA 把 47/8 转介给 `whois.arin.net`**，而该主机在**本沙箱不可达**（`:43` 连不上；实测宿主可通、沙箱内 43 端口对其他 whois 主机是通的）⇒ 默认路径既不换家也不报错，只留 0 字节 | `whois_query` 改为**显式转介链 + 兜底**：IANA → 它指的那家 → 答不出记录则按 `apnic/ripe/lacnic/afrinic/arin` 顺序再试，取第一条含记录字段（`inetnum:/netrange:/orgname:` …）的答复；每跳独立超时且总时长受本次预算约束。实测该目标 8 秒内给出 `inetnum 47.104.0.0-47.111.255.255 / netname ALISOFT / descr Aliyun Computing Co., LTD / abuse didong.jc@alibaba-inc.com` 一类可引用字段 |
| `pentest_exec` 超时口径读起来自相矛盾（"5 分钟，不是 15 分钟"＋"15 分钟是上限"） | 两句话分散在三行里，且没说清"上限按动作定" | 合成一段：**15 分钟是沙箱天花板、不是任何动作的默认**；自由命令 5 分钟、结构化动作更小；按 5 分钟切段 |
| `port_scan` 批次扫描：宿主按 15 分钟规划，容器 5 分钟就砍 | 容器 `DEFAULT_TOOL_TIMEOUT_MS["port_scan"]` 是 300s（其余 13 个动词都与模板一致，**只此一处**），而 `budget_ms` 取 `min(注入值, 本表)` ⇒ 本表就是天花板 | 容器侧抬到 900_000 与模板对齐；新增**超时对拍回归锁**（`test/action-templates.test.ts` 解析分发器表，逐动词与宿主模板比对） |
| 情报阶段看不到 `pentest_scan`（含 `exposure_check`），"配置暴露核查"只能手搓 `curl` | 该工具只发给漏洞分析阶段；2026-10-07 撤下逐项编辑器后没有人类入口能加工具 ⇒ 能力边界只由 Profile 与阶段默认决定 | 把 `pentest_scan` 加入情报收集默认工具面（见下方裁定说明）；提示词改为**按在场工具分节**渲染参数指南 + 一致性锁；`recon-web-surface` 补第 8/9 行 |
| **`exposure_check` 只要命中候选就崩**：`internal_error: TypeError: 'in <string>' requires string as left operand, not bytes` | `classify_exposure` 写成 `signature.lower() in body.decode(...)`，而 `EXPOSURE_SIGNATURES` 是 **bytes** 字面量（`b"ref:"` / `b'"swagger"'`）⇒ `bytes in str` 必崩；它只在"真的命中候选"时走到，更早的冒烟全落在"与对照同形"分支，**且该纯函数从无单测**（注释里"可无 socket 单测"的意图从未落地） | 改为 **bytes 对 bytes**（`signature.lower() in body.lower()`，不解码）；加文本锁钉住"签名表是 bytes 且比对不得 decode"；实测（自建夹具、只读 GET）：`.git/HEAD`/`.env` → `looks_like=true`、`swagger.json` → `control=same` 判为软 404、**不回显正文** |

### 6.5.13.4 第五轮实测（2026-10-11）：幂等键、chunk 路由、以及"同形字段"的收尾

| 现象 | 根因 | 修复 |
|---|---|---|
| `tls_inspect` 之后调 `tls_weakness`（参数相同）被拒 `idempotent_replay`「幂等键命中已有运行但计划摘要不同」 | **幂等键不含 `templateId`**，而两个模板的 `commandTemplate` **逐字相同**（都下发 `tls_probe …`）⇒ 键相撞、摘要不同（摘要含模板）。操作者只能给 `sni` 塞个等价取值换个键 | 键纳入 `templateId`（键的语义是「同一个**受审动作**」，动作身份由（模板，参数）决定，不是命令文本）+ 撞键回归锁；四处重算键的测试夹具同步补 `templateId` |
| `collect=endpoints` 只解析 HTML：首页 20 条，而**真正的路由只在 chunk 里**（自测：`/_next/static/chunks/*.js` 另有 11 条 `/api/*`，含核心发现；三份字典全都没命中） | 抽取器只读本次响应的字节，不跟随引用 | 新增 `include_chunks`（默认 **true**）：跟随**同主机**的 `.js` 引用再抽一遍（跨主机一律跳过，与重定向同一纪律），上限 8 条 / 每条 256KiB / 合计 1MiB；命中带来源 `kind=quoted@<chunk 路径>` 供复核；三处枚举加锁 |
| `restrict_to_scope` 的文档与人实际行为矛盾：参数表暗示"不给 true 就会被闸门拒"，而显式 `ports=` 本来就合法 | 文案把"**只想扫授权端口**"与"**要保留档位口径**"两种意图写成了一条 | 三处（schema / carries / 指南）改写成**三条路**：① 只给 `ports` ⇒ 就扫这几个端口（不需开关）；② 只给档位 ⇒ 授权不全时被拒；③ 开关 + `ports` ⇒ 扫交集 |
| 空交集时 `summary` 与「扫了但全关」**同形**（`open_ports=0 hosts_up=0`） | 复用同一个字段名表达"没扫"与"扫了是 0" | 加**判别字段** `scanned=true/false`；空交集写 `scanned=false open_ports=not_scanned hosts_up=n/a`；全 down 写 `scanned=false open_ports=0`（并已有 `warn:`） |
| `content_discover` 只回 `hits=N autocalibration=…`，分不清"跑完干净"与"跑一半报一堆错" | summary 不含覆盖依据 | summary 补齐 `entries_scanned / wordlist_lines / ext_multiplier / duration_ms / ffuf_exit / stderr_lines / stderr_errorish`；有错误迹象时显式 `warn:` + stderr 头部 |
| `workdir` 多根部署写新文件必被拒（`/work` 读写 + `/mnt/engagement` 只读） | 旧规则"多根 + 新文件必须带前缀"没区分**可写根是否唯一** | 唯一可写根时**相对路径直接落它**（回报实际落点）；只有多个**可写**根才要求前缀（错误消息也改成"多个可写根"） |
| `exposure_check` 的 `bytes=4096 declared_length=8596` 并排像"大小对不上=可疑" | 名字没说清"读进来算哈希的截断量" vs "目标自报长度" | 改名 `hashed_bytes` / `content_length`（含 control 行），旧名加锁消失 |
| `collect=robots` 报 `status: 200` 同时 `robots: missing`（200 是主页面的） | robots 自己的状态没自陈 | 补 `robots_status` / `sitemap_status`（404 就写 404） |
| `tls_inspect` 的 `cert_subject` 是空的，看着像解析器没带出来 | ACME 给 IP 签的证书常见**空 DN**（身份只在 SAN）；openssl 输出就是 `subject=` | 空值时写 `cert_subject: （空 DN）` + 说明"身份在 SAN 里"（issuer 同理）；实测空 DN 证书确认 SAN 行照常给出 |

### 6.5.13.5 第六轮实测（2026-10-11）：同一份事实被解析了四遍——"证据不存在"

| 现象 | 根因 | 修复 |
|---|---|---|
| 工具里"证据文件不存在"：容器写进 `/work` 的 `.xml`/`.json` 找不到，只看得到自己手写的 `.txt` | **同一份事实被解析了四遍**。2026-10-08 引入「按会话 cwd 覆盖 `/work`」（操作者要求："我 dsh 会话在哪个目录，AI 就默认在哪个目录操作"），只改到了容器 argv 与提示词简报；`pentest_workdir` 的读写根与宿主侧证据落盘**仍读配置目录** ⇒ 容器写会话目录、工具读配置目录，两个目录各有一半产物 | 抽出**唯一来源** `src/execution/session-mounts.ts`：规则 `sessionMountsForCwd`（会话 cwd 覆盖 `/work`、其余保留）+ 视图工厂 `sessionMountViews`（容器 argv / 工具读写根 / 证据落盘根 / 简报 **同一个对象**）。`compose` 的四个消费点全改读它；跨切缝锁 `test/session-mounts.test.ts` 在一个断言里对齐 argv 的 `-v` ↔ workdir 根 ↔ 证据根 |
| 配置里的 `/mnt/engagement`（只读锚点，交付物自校验通道）在容器里**不存在**，简报也不再提它 | 同一处覆盖把**整份配置挂载**都换成了"单个会话根"（旧 `mountRootFor` 只接受一个路径）⇒ `/mnt` 下的锚点静默消失 | 钩子由"单个根"改为"整份列表"（`DockerSandboxDeps.mountsFor`）：`/work` 被会话 cwd 覆盖，**其余容器路径原样保留**（含 `:ro`）。实跑确认 `-v <会话目录>:/work -v C:/Projects/pentest/cdut:/mnt/engagement:ro` |

**可复现的判定（跑之前先问"部署里是哪一份"）**：

```bash
P="C:/Users/Administrator/.dsh/profiles/pentest/node_modules/dsh-pentest"
# 部署是软链（构建即生效）还是副本（必须重装）——见 §6.5.15
ls -ld "$P"                      # lrwxrwxrwx … -> …/dsh-DCG-pentest  ⇒ 软链
grep -c "sessionMountsForCwd" "$P/lib/execution/session-mounts.js"   # ≥1 ⇒ 本次修复已在部署里
```

**部署纪律（照 §6.5.15）**：软链形态下 `npm run build` + **重启 dsh 进程**即可；副本形态必须重装。

**验证（本轮实跑，非推断）**：拿 `lib/` 产物（= 部署里那一份）构造生产 argv，再用同一个 argv
起真容器（只把入口换成 `bash -lc`，挂载/限额/cap 全部原样）：

| 方向 | 做法 | 结果 |
|---|---|---|
| 容器写 → 宿主读 | 容器内 `echo … > /work/evidence/from-container.txt` | 落在**会话目录**（`%TEMP%\smoke-session-*`），非 `cdut` |
| 宿主写 → 容器读 | 宿主侧 `writeWorkdir(rootsFor(会话), '/work/evidence/from-tool.txt')` | 容器 `cat /work/evidence/from-tool.txt` 读到 `tool-wrote-this` |
| 只读锚点 | 容器内 `touch /mnt/engagement/should-not-exist` | `Read-only file system`（`cdut` 未被污染） |
| 四个视图 | argv 的 `-v` ↔ `rootsFor` ↔ `evidenceRootFor` | 三处同值（`/work` = 会话目录） |

**附带修掉的一处不一致**：零挂载部署（profile 没写 `sandbox.mounts`）下，容器照样按会话 cwd 得到
`/work`、证据也写到那儿，但 `pentest_workdir` 因"配置无挂载"而**不安装** ⇒ 证据写得回、读不回来。
门控改为「配置声明了挂载 **或** 存在会话 cwd 来源」，且删掉被 `evidenceRootFor` 取代的静态
`evidenceRoot`（死配置）。

### 6.5.13.6 会话简报如实说明记忆索引状态（2026-10-11）：别让模型先撞一次墙

**现象**：作业刚开始时 Agent 调 `memory_search` 查历史结论，拿到

```json
{ "hits": [], "indexWatermark": 0,
  "note": "本作业记忆索引为空（0 个分块）：这不是\"没找到\"，是\"库里还没有可检索的内容\"。作业资料请用 pentest_workdir 读 —— 它读的是人类挂进来的作业目录，不经过索引" }
```

它按"正常流程"重试/换词，白撞一次墙；真正救回信息的是 `pentest_workdir op=search`——
在作业目录的 254 个文件里正则命中原始行（那是人类挂进来的材料，**从来不在记忆索引里**）。
note 本身是对的，但**要等第一次检索失败才读得到**。

**根因（语义与作用域）**：

| 项 | 事实（代码位置） |
|---|---|
| `indexWatermark` | 「**已落成分块**的事件里最大的**账本链序号**」（`context_events ⋈ memory_chunks`，`src/memory/pg-worker-tools.ts` 的 `#indexWatermark`）。**是链序号，不是时间**；`0` = 本作业还没有任何事件落成分块。phase profile 的指南此前写成「`indexWatermark < 当前时间` ⇒ 索引滞后」——拿链序号比时间，已改口径 |
| 「水位」是**两份东西** | 显示/简报里的水位 = 上面那个**由分块派生**的值（`memoryWatermark` 与新加的 `memoryIndexFacts` 同一口径）；而 `index_watermarks` **表**是**重建进度**，只有 `reindex_engagement` 写它、事件驱动的索引**不写**——拿它当显示值会出现「索引队列完成 20 / 水位 0」并列（QA 2026-10-04 实测）。简报里的「水位链序 N」指的是前者 |
| 「0 分块」 | `count(*) from pentest.memory_chunks where engagement_id = …`（`#diagnoseZeroHits`）——**按作业**。不是按租户 |
| 谁写 `memory_chunks` | 账本追加（`ledger.appendEvent`）**同事务入队**（`src/memory/index-enqueue.ts`）→ 调度器/索引器（`dispatcher.ts` / `indexer.ts`）按 `index_event` 任务落块。**嵌入提供方不可用只降级为词法索引（分块照落）**，所以它不会造成「0 分块」 |
| 「0 分块」的两个来源 | ① 作业还没有可索引内容（新作业）；② 账本已有可索引事件、**索引器还没追上**（`outbox_jobs` 有待办）。两者的处置不同，简报分开说 |
| 作用域 | `memory_chunks` / `index_watermarks` 都是 **FORCE RLS**（005/006/015）：**租户级查询静默返回零行** → 会把「有内容」误报成「0 分块」。任何读它的路径都必须先进作业作用域（`composed.rls.run({ engagementId }, …)`） |
| 跨作业材料 | `memory_search` **只覆盖本作业**：检索层丢掉 `engagementId !== 本会话作业` 的候选（`src/memory/retrieval.ts:426`），而 Worker 工具**没有** `engagement_id` 参数（`src/tools/worker.ts` 的 `memory_search`，归属由服务端按会话推导）。这是 §9.4 的隔离，**是设计不是缺陷**：别的作业/人类带来的材料本来就不在本作业记忆里，通道是 `pentest_workdir`（挂进来的目录，不经过索引）。phase profile 里两处「可跨 engagement 检索（去掉 engagement_id）」的说法已改——它描述的是控制台面，Worker 面做不到 |

**处置**：

- 会话简报（`pentest:capability-freeze` 分节，紧跟「记忆检索通道」）在**创建那一刻**写一行
  「记忆索引状态」，由注入端口 `DshSessionFactoryDeps.memoryIndex` 提供事实
  （装配处 `src/index.ts` 用 `composed.memoryQuery.memoryIndexFacts` + `composed.rls.run` 接线）：
  `可用（已索引 N 个分块，水位链序 M）` / `本作业记忆索引为空（0 个分块）…` / `未知（创建会话时查询失败）`。
- **空与未知都把历史材料指向 `pentest_workdir`**（`op=list` 列目录、`op=search` 在目录内递归检索正则），
  并明说这是「库里还没有可检索内容」而不是「没找到」。不承诺索引一定会有内容。
- 探针**绝不阻断会话创建**：抛错/超时（2s）只降级成「未知」；未注入探针时不写这一行（不知道就不编）。
- `phase-profiles.ts` 的 `memory_search 使用指南` 同步改口径（链序号 vs 时间；索引状态已在简报里）。

**可复跑命令**（测试库，勿指向 `pentest_personal`）：

```bash
# 1) 三条渲染路径 + 抛错/超时降级 + 「未注入就不写」：不联网不连库（注入假端口）
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest' \
  node --import ./test/helpers/tsx-loader.mjs --test --experimental-strip-types --test-timeout=40000 \
  test/dsh-session-factory.test.ts

# 2) 事实口径（真库）：0 分块 → 待索引事件 → 落块后水位/滞后；含「条目来源分块必须计入」
PENTEST_DATABASE_URL='postgresql://postgres:check@127.0.0.1:55446/pentest' \
  node --import ./test/helpers/tsx-loader.mjs --test --experimental-strip-types --test-timeout=40000 \
  test/pg-memory-query.test.ts

# 3) 直接看某个作业现在有几个可检索分块（= 简报 / memory_search 零命中诊断同一口径）
#    以 app 角色查时要先进作用域，否则 RLS 让它**静默返回 0**（假「空作业」）
docker exec dsh-pg-c psql -U postgres -d pentest -c \
  "select count(*) as chunks,
          (select coalesce(max(e.chain_seq),0) from pentest.context_events e
             join pentest.memory_chunks mc2 on mc2.source_event_id = e.event_id
            where e.engagement_id = '<engagement-id>') as watermark
     from pentest.memory_chunks where engagement_id = '<engagement-id>'"
```

### 6.5.13.7 第七轮实测（2026-10-11）：证据静默不落盘、报告载荷校验的代价、证据链缺一条腿

| 现象 | 根因 | 修复 |
|---|---|---|
| `save_stdout_as_evidence` **静默不落盘**。报错原文：`证据落盘失败：The "path" argument must be of type string. Received an instance of Promise`。操作者那次 `tool_run:42436eb9`（27 条路径的状态码复核）的 `evidence/` 目录里**没有对应文件** | 装配层的**会话作用域包装器**把 `WorkerToolDeps` 里**每个函数依赖**都包成 `async`。而那里除了"工具方法"还有**解析器**（`evidenceRootFor(会话)`：入参是字符串、返回值是路径）——被 async 化后返回值变 Promise，下游 `writeEvidence(root, …)` 拿到 Promise 当路径 ⇒ 抛错；而 `writeEvidence` 的纪律是"绝不把已执行完的动作变成失败"，于是只剩一行说明 | 包装器改为**按入参形状判别**：入参带 `{workerSessionId}` = 工具方法（进作用域）；否则 = 解析器，**原样透传、不得 async 化**（`scopeWorkerToolsBySession` 已导出，锁在 `test/session-scope-wrapper.test.ts`）。同时把落盘结果结构化：成功给 `evidence` / `evidence_container_path` / `evidence_host_path`，**失败给 `evidence_failed: true` + 原因**（不再与成功同形） |
| "超时/中止也会落盘"这句话不可信（操作者的怀疑） | 与成功路径**同一个函数**，但从未被单独验证过 | 单测逐条锁：超时（`result.status='timed_out'` + 半截 stdout）**真的落盘**；无挂载根时明确说"输出只在返回值与 tool_run 里"；按会话解析优先于静态配置。`test/worker.test.ts` 四例 |
| `pentest_submit_report` 传 `payload.engagement_id: null` 被拒（`"payload.engagement_id" must be a string`），而字段说明写"不必填也不被采信"；一份 payload 几 KB，改一个错就得整份重发 | 那些"只接收不采信"的字段被声明成 `type: 'string'`，而 dsh 的参数 DSL **不支持联合类型**（`type arrays are not supported`）⇒ 唯一能表达"任意值"的形状是 `type: 'json'`（编译成 annotation-only，接受 null/字符串/数字/数组/对象） | 11 个不采信字段改 `type: 'json'`；可选**标量** `status_note` / `mode` 用 `oneOf: [<类型>, {type:'null'}]` 容忍 null；**`payload` 刻意不包 oneOf**——实测 `oneOf` 会把 payload 内部的**细分违规**塌成一条 `must match exactly one oneOf branch`，而那正是下一条要修的东西 |
| "校验一次只报一个错，按错一个改一次的节奏重发大对象" | **不是**宿主的行为：`validateJsonSchemaValue` 返回**全部**违规，运行时把它们用 `"; "` 连成一条消息（`ToolArgsError`）。操作者那次只有一个违规 | 无需改代码；补一条锁：一个含 ≥4 处错误的载荷必须**一次**给出 ≥4 条信息（含 `facts[0]`/`facts[1]` 两条），防止将来退化成"只报第一条"。仍无法一次改完的根因是"整份重发"这件事本身 ⇒ 见下一条 |
| 补几条事实/候选要重发整份几 KB 的 payload | 只有"整份替换"一种模式（`worker_reports` 的取代语义） | 新增 `mode: 'append'`：在**本会话本次尝试的当前报告载荷**上合并（数组**追加并按深等值去重**、对象递归合并、其余由新值覆盖）；返回 `merged.{baseReportId,sections}`；账本事件的 `payload` 记**合并后的有效载荷**并带 `mergedFrom`；没有基底时**明确拒绝**（不静默当替换——那会丢掉模型没重发的部分）。纯函数 `src/memory/report-payload-merge.ts`，锁见 `test/report-payload-merge.test.ts` 与 `test/pg-worker-tools.test.ts` |
| 报告的证据链只有 `tool_run:<uuid>` 一条腿：`source_refs` 认 `artifact:<uuid>`，但模型**从来拿不到任何 artifact id** | `pentest.artifacts` 在**全仓没有任何 INSERT**（与"findings 全仓没有写入方"同一类缺口，外部审计抓到过前者）⇒ 表是空的，`artifact_read` 只能读测试塞的行 | 证据落盘成功后自动登记一行 artifact（`kind=evidence_stdout`、`storage_kind=file`、`encrypted=false`、`source_ref=容器路径`），返回值新增 `artifact_id` / `artifact_ref`；登记失败**开口**（`evidence_artifact_error`）但**不影响落盘**。资产归属按 `assets.canonical_target` **精确等值**解析（绝不自动创建资产、绝不模糊匹配），解析不到时 `asset_ids='{}'` 且在 `metadata.assetResolution` 如实记 `no_match`/`no_target` |

**由此产生的两条行为（不是 bug，但要知道）**：

- **登记了资产的证据受范围闸门约束**：填了 `asset_ids` 就等于把证据挂到 §8.6 的可见性公式上——
  "登记成功但读不回来"（`scope_violation`）在资产未纳入范围时是**正确行为**。这条锁在
  `test/pg-worker-tools.test.ts`（纳入之后即可按 id 读回，`storageRef` 给宿主路径）。
- **`payload: null` 仍会被拒**（普通对象分支的代价换取内部细分错误）。空载荷请**省略该字段**。

**顺带强化（操作者建议）**：`pentest_workdir op=search` 现在多返回一份**命中文件清单**
`files`（路径 + 修改时间 + 命中行数，**新的在前**）——他正是靠在 254 个文件里正则考古
才把丢失的信息捞回来的；清单让"先看最近动过的那几份"成为默认入口。

### 6.5.13.8 提示词教了会被拒的词表、算错的墙钟（2026-10-11）：与词表不同源的第二份副本

**现象**：阶段档案教模型发出的**第一次**强制检索**必被拒**（`classification_rejected`）——因为档案里的
`memory_search` `kinds` 是十个"业务分类"（`asset`/`service_fingerprint`/`dns_record`/`web_surface`/`attack_path`/…），
而代码里的 `CHUNK_KINDS` 只有 14 个**来源/形态**类名，两者只有 `finding` 一个交集 ⇒ **九个不存在**。
同一条线上还有两处：`trust_level` 教的是 `confirmed/likely/speculative` 与 `high/medium/low`（两套虚构档位，
一套可信度、一套严重度，彼此还矛盾），而 `TrustLevel` 是**来源**语义；`exploitation` 的档案还写"可跨 engagement
检索（去掉 engagement_id）"——参数面根本没有 `engagement_id`（服务端按会话绑定本作业，§9.4）。

**根因**：**提示词里的词表与代码里的词表不同源**——`phase-profiles.ts` 的 `kinds`/`trustLevels` 是手写的第二份
（类型还写成 `readonly string[]`，所以编译器也拦不住）。同一类病在数字上有三处：简报把**端口扫描**写成
"5 分钟"（真值 900s），`internal-discovery` 按 `maxWallClockMs`（沙箱天花板 900s）估**自由命令**的规模
（真限 300s；该技能自己记的"必被杀"实测来自 2493s 的命令，真正杀它的那一刀在 300s），
`recon-web-surface` 写 `maxtime 上限 295s`；五份技能 + `AUTHORING-SPEC.md` 还写着**不存在**的档位名 `deep 10/s`。

**处置**（六条，全部落在"删掉手写副本、改从来源渲染"这一条纪律上）：

| # | 位置 | 改法 | 锁 |
|---|---|---|---|
| 1 | `phase-profiles.ts` 的 `kinds`/`trustLevels` | 换成 `CHUNK_KINDS`（14 个）/`TrustLevel`（五档）；类型收紧到 `ChunkKind`/`TrustLevel`——**编一个不存在的类名过不了编译**；每个阶段的档案末尾**从词表渲染**合法取值（规范 §6：拒信里的合法值经常拿不到，那就提前给），并写明"要'已确认'就同时过滤 `human_decision` + `tool_observation`" | `test/prompt-facts.test.ts`：渲染产物必须列出全部合法取值，且十个旧分类与两套旧档位**一个都不许再出现** |
| 2 | `phase-profiles.ts:342`（exploitation） | 删掉"可跨 engagement 检索（去掉 engagement_id）"，改写成"**不能**跨作业：`memory_search` 按会话绑定本作业（参数面没有 `engagement_id`，§9.4）" | 同上：`去掉 engagement_id` 字样在所有阶段档案里为 0 |
| 3 | 墙钟数字 | **只从模板注册表渲染**：简报渲染自由命令上限（`direct_command` 的 `timeoutMs`）+ 天花板（`maxWallClockMs`），参数指南在**每个 technique 的标题行**渲染 `<family>_<technique>` 的 `timeoutMs`；技能正文改写成"见能力快照/模板声明"，`295s` 与"按 900s 估规模"删掉 | `test/prompt-facts.test.ts` **双向**对拍："指南里出现的每个超时数字都必须是注册表里某个模板的值"，且每个 technique 都渲染出了它的值 |
| 4 | 速率档位名 | `deep 10/s` → `fast 10/s`（合法枚举 `stealth/standard/fast/custom`）；简报的速率行改成从 `PROFILE_DEFAULTS` 渲染 | 锁扫 `SKILL.md` **与** `AUTHORING-SPEC.md`/`README.md`：速率位置的档位名必须 ∈ `BEHAVIOR_PROFILES`（旧锁只扫 `SKILL.md` 且正则里没有 `deep`，所以它放过了这条漂移） |
| 5 | 技能里的 technique 名与参数派属 | `recon-dns-cert`：`concurrency`/`wildcard_check` 归 `dns_brute`（不是 `ct_subdomains`）、`include_wildcards` 归 `ct_subdomains`，并写明"两套参数不通用"；`whois_query`（dispatcher 动词名）→ technique 真名 `whois` | 沿用 `test/action-templates.test.ts` 的 technique↔模板对拍 |
| 6 | 参数指南缺 6 个条目 | 补 `nse_safe`/`web_crawl`/`dns_brute`/`whois`/`ct_subdomains`/`dns_axfr`（参数、**默认值逐条回 `techniques.ts` 核对**、判据）；`TechniqueGuide` 新增 `judgement` 字段并由渲染器输出"**判据**："一行 | `test/prompt-facts.test.ts`：指南与 `STRUCTURED_TECHNIQUES` **双向**对齐（少一个 = 模型靠猜；多一个 = 模型照调必被拒） |

**顺带补齐的两处**（同一份"模型必须知道"的事实，此前只写在代码里）：

- **零命中的两种语义**现在**五个阶段都有**：`hits.length === 0 && note 含"索引为空"` → 去 `pentest_workdir`
  读作业目录；`note 含"没有命中"` → 换查询词。此前只有情报/威胁建模写了，而"上游刚交报告、索引器还没跑"
  恰恰最容易发生在漏洞分析/利用验证/后渗透三阶段。
- **输出怎么读**写进了参数指南的开头（规范 §2/§3）：首行固定是 `state=`（`ok`/`failed`/`no_target`/`aborted`/`partial`，
  其中 `ok` **包含"扫完是 0"**）、其后是机器可读的 `summary:` 行、「没扫」与「扫到 0」不同形
  （`scanned=false` vs `scanned=true` 且计数 0）、覆盖度四字段 `*_total`/`*_attempted`/`*_truncated`/`*_remaining`
  怎么读（`*_truncated=true` 时命中只能当下界读；`*_remaining>0` 时用 `entry_range=` 续跑）。

**方法论**：这六条都不是措辞问题，而是"**模型照做就会失败**"。所以修法只有一条：
**能从注册表/契约渲染的一律改渲染、删掉手写副本；渲染不了的用测试对拍锁住**——
否则下一次轮换（改一个 `timeoutMs`、改一个枚举成员）会在同一处再漂一次，而漂移方向不可预测。

### 6.5.13.3 同日第四轮实测（3 条）的修复：静默失败的三张脸

| 现象 | 根因 | 修复 |
|---|---|---|
| `grep -oE '[a-zA-Z0-9_\-/]{3,}'` 报 `Invalid range end`，**stdout 为空**、看起来像"页面里确实没有路由/API 路径" | ERE 的字符类里**反斜杠不是转义符**：`\`→`/` 成了**倒置区间**（rc=2）；而命令写成 `… \| grep … \| head -30` 时**管道末尾把 rc 掩成 0** ⇒ 失败与"干净的阴性结果"同形 | ① `pentest_exec`/`pentest_recon`/`pentest_scan` 的返回值在 **stderr 非空时自己开口**：`stderr_nonempty: true` + `stderr` + `stderr_warning`（写明"管道会吃掉退出码"这条机制与排查方向）；② 新增结构化取证通道 `http_probe collect=endpoints` |
| 路由/端点只能手写 `curl \| grep`（"避免手写正则"） | 没有服务端固定形态的抽取器 | `collect=endpoints`：**固定三种形态**（属性 href/src/action、引号内绝对路径、fetch/axios 第一实参），每条短行带 `hits`；**空结果会自我解释**（"这不等于页面里没有端点" + 下一步）；三处枚举（模板/technique/容器）由锁对拍 |
| `curl … \| head -30` 输出里塞进几百行（响应体是**一整行**的 RSC/JSON，`head` 按行截断 ⇒ 一条都不切） | `head` 的语义是"行"，对单行内容失效 | 抽端点走 `collect=endpoints`（输出天然短行）；手工场景按**字节**截（`cut -c1-400` / `fold -w 200`）——写进 `recon-web-surface` 常见失败表 |
| `verify_tls` 指引过度泛化：形成"IP 目标 → 传 false"的条件反射，报告里堆无谓的"未校验证书"免责声明 | 五处措辞（`templates.ts` 的 carries、两处 scheme、`worker.ts` 两处 schema、参数指南四处）都写成"自签/纯 IP 目标必须 false" | 统一改成**"能用默认就用默认"**：证书有效时（含 SAN 覆盖该 IP 的正经证书）默认即可连通；**只有校验真的失败**才 false，并写明"报告里堆免责声明会稀释结论"。五处同句，避免再次漂移 |

**这轮的方法论**：三条现象都是"**看起来正常的失败**"——空 stdout、rc=0、条数少。修法遵循同一条纪律：
**让工具自己开口**（stderr 标记、空结果自我解释、`scaninfo/hosts_up` 这类可分辨计数），而不是指望
人（或模型）去留意沉默。

### 6.5.13.2 同日第三轮实测（4 条）的修复：零命中的可分辨性 + 档位交集

| 现象 | 根因 | 修复 |
|---|---|---|
| **`port_scan` 扫 33 个端口报 `open_ports=0`，而 3002 实际开放**（差点写进"未开放"） | `ping=syn` ⇒ `-sS -PS`：`-PS` 是**主机发现**探 80，目标丢弃探针被判 down ⇒ **一个端口都没扫**。输出形态（rc=0、有 summary）与"全关"**同形** | 全 down 时给 `warn:` 分支（明说"端口从未被扫"）+ 可执行下一步（换 `ping=skip`）；`summary` 补 `hosts_up/hosts_total/ports_scanned`；`ping` 的语义在 schema 与指南里改写成"**主机存活判定**（不是扫描类型）" |
| 同样场景下**没有原始件可复核**：只有解析后的摘要 | 动词只回摘要，且 `nmap` 的 `-oX` 输出直接进 stdout 做解析，不落盘 | nmap 族（`port_scan`/`service_probe`/`nse_run`）与 `content_discover` 把原始件写进 `/work/evidence/<目标>/<UTC>-<动词>.{xml,json}`，报告给 `raw_evidence:` 路径；**没有挂载根时回显受限 `raw_head` 并说明**（不让证据随容器消失）。另补 `scaninfo:`（nmap 自报 numservices/services）与 `nmap_done:`（stderr 尾行） |
| `scope=top100` 被范围闸门拒（"端口集不可枚举"），而沙箱里**查不到 top-N 清单** ⇒ 只能靠记忆列端口（漏了就是静默漏报） | 档位在宿主侧确实不可枚举；但"算交集"的成本被推给模型，而模型手上没有可靠来源（`nmap-service-probes` 是错的文件） | 新增 `restrict_to_scope=true`：容器算 `top-N ∩ ports` 并回报 `used_ports:`；N 取自镜像 `/usr/share/nmap/nmap-services` 频率列（**实测：推出的 top-100 与 `nmap --top-ports 100` 自报的 `services=` 展开逐位相同**）；空交集明确报 `scope_intersection: empty` 且不扫描。闸门口径不变（`ports` 是宿主核验过的授权集合，交集是其子集） |
| `grep -oE '[一-龥]+'` → `Invalid collation character`（rc=2，管道里像"没命中"） | **不是 locale 缺失**（容器 `LANG` 本就是 `C.UTF-8`）：GNU grep 3.8 对**多字节字符区间**一律拒绝。`LC_ALL=C` 能让它"过"，但那只是退化成字节匹配 | locale 显式钉成 `LANG/LC_ALL=C.UTF-8`（防上游漂移，**不解决**该区间问题）；正确写法是 `grep -oP '\p{Han}+'` 或 python3 `re`（两者实测可用），已写进 `recon-web-surface` 的常见失败表 |
| 多根部署：写新文件要求带容器路径前缀，但"是哪几个根"要先 `op=list` 才知道 | 工具描述里的挂载根是通用说明，没内联本部署的实际值 | `pentest_workdir` 的描述在装配期内联**实际挂载根**（容器路径 + 读写/只读；无挂载根时明说） |

**顺带澄清（不是缺陷）**：`ffuf 1.1.0` **有**跳过证书校验的开关，且 `content_discover` 在
`verify_tls=false` + https 时已经传 `-k`（实测 `ffuf -k -h` 正常解析，说明该版本接受 `-k`）。
「ffuf 不能打自签目标」这条**不成立**，可放心用结构化通道做自签/IP 目标的目录枚举。

**情报阶段现在也有只读核验面**（2026-10-10 操作者裁定，设计文档同轮记录）：操作者任务要求
「配置暴露核查」，而当时 `pentest_scan`（含 `exposure_check`）只发给漏洞分析阶段，且撤下逐项
编辑器后**没有人类入口**能为情报会话加工具 ⇒ 只能手搓 `curl`，代价是"把 `/lists/config` 正文
写进证据"，而结构化通道在同一件事上**从不回显正文**。因此把 `pentest_scan` 加入情报收集的
默认工具面；两个阶段的**判据差异不变**（情报记录事实、漏洞分析判定候选）。三件配套：

- 提示词**按在场的工具分节渲染**参数指南（此前只要有一个结构化工具就整篇渲染，于是没有
  `pentest_scan` 的阶段也会被介绍它的参数表——模型照着去调，得到"没这个工具"）；
- `recon-web-surface` 技能补第 8/9 行：配置面暴露 → `exposure_check`（项名 `git,env,swagger,…`，
  ≤10，**不是路径**）、基线核验 → `http_check`；
- **已有会话不受影响**：能力快照在创建时冻结，要用新面请**新建会话**（或用同阶段重做）。

### 6.5.13.6 第七轮实测（2026-10-11）：可审计的复核通道 + 可分辨、可续跑的字典扫描

操作者给了两条"退回手写才能干活"的诉求，都不是新功能，而是**已有能力缺了可分辨性/可核账性**：

| 现象 | 根因 | 修复 |
|---|---|---|
| 60 条路径只能退回 `pentest_exec` 手写 `for p in …; do curl …; done` 逐条确认「哪些是真端点、哪些只是兜底路由」 | 结构化通道里**没有批量复核动作**：`http_probe` 一次只采一个面（`collect=`），`exposure_check` 的 `paths` 是**固定项名**（10 个配置面），都不能表达"我这份 60 条路径清单" | `http_probe paths=/a,/b,…`（≤60 条，逗号分隔）：只发 **GET**，逐条回 `path<TAB>status<TAB>size<TAB>content_type<TAB>note`，**先用一条随机路径取软 404 基准**（同状态码同长度 ⇒ `note=soft404`＝兜底路由，不是端点），汇总 `paths_summary: paths=N ok=M no_response=K`；含 scheme/主机/空白/`..`/查询串一律 **exit 2** 拒绝（那是把"路径"当"目标"用，会让范围记账失效）。模板 / technique / 分发器三处由 `test/action-templates.test.ts` 对拍 |
| `content_discover` 跑大字典"看起来跑完了"：`common_dirs` 4723 条按声明节奏 5 req/s 需 ~945s，而单条命令上限 5 分钟 ⇒ **数学上不可调度**，且旧 summary 里**看不见被截断**（上游 JSON 有 `maxtime:295`、命中停在 `position:4313`） | ①返回里没有任何覆盖度字段（`hits=N` 与"全跑完、干净"同形）；②`-s` 把 ffuf 的进度行整条吞掉，连"跑到第几条"都拿不到；③没有分段手段，模型只能自己截断字典（`head -n 2000`）——截了多少、剩多少全靠自觉 | ①新增 `entry_range=A-B`（1 基双闭区间；空=整本）：把本段字典落盘再喂 ffuf，多次调用可拼完并**每次自证"从第几条跑到第几条"**；②去掉 `-s`、解析 stderr 进度行 → `coverage: wordlist_entries=… entry_range=… requested=… attempted=… truncated=… position=… remaining=…`（外加 `position_max_hit=`，即旧版只能去 JSON 里翻的那个数）；③`truncated=true` 时给 `coverage_note:` 明说"被截断 + 下一次的 entry_range"；④条目数/声明速率超单条上限时**直接写出"需要分 N 段"与各段区间**（这是数学，不是判断） |

**实测（真容器、实验室夹具，非推断）**：

```bash
# 夹具：单文件 python 服务，未知路径一律回 200 + 固定 64 字节正文（软 404 形态），
#       另有 /hang 故意 sleep 30s 触发逐条超时
docker run -d --name fx-probe --network pentest-lab-internal -v <夹具>:/srv:ro \
  --entrypoint python3 python:3.10-slim-bookworm /srv/fixture.py 8080     # 172.29.0.2:8080
```

| 场景 | 命令 | 原样结论（节选） |
|---|---|---|
| A 批量复核（6 条：3 真端点 + 2 兜底 + 1 不通） | `http_probe … paths=/,/api/users,/api/orders,/does-not-exist,/admin/config,/hang` | `paths_soft404_baseline: status=200 size=64`；`/`·`/api/users`·`/api/orders` 三条 `candidate_endpoint:`（size 41/71/24）；`/does-not-exist`·`/admin/config` → `note=soft404`；`/hang` → `no_response`；`paths_summary: paths=6 ok=5 no_response=1` |
| B1 小字典全跑 | `content_discover … wordlist=api_endpoints rate=5` | `attempted=268 truncated=false position=268 remaining=0`，`hits=3`（`/api/auth` 301、`/api/graphql`、`/graphql`），`position_max_hit=199` |
| B2 大字典一段 | `… wordlist=common_dirs entry_range=1-200` | `coverage: wordlist_entries=4723 entry_range=1-200 requested=200 attempted=200 truncated=false position=200 remaining=4523`；`schedulability: …需要分 4 段（每段约 1475 条）：1-1475 / 1476-2950 / 2951-4425 / 4426-4723` |
| B3 大字典**被截断** | `… wordlist=common_dirs rate=2`（无 `entry_range`） | `attempted=1179 truncated=true position=1179 remaining=3544 position_max_hit=659`，`hits=1`；`coverage_note: …**被截断**（ffuf 到达 maxtime=295s 自行停止）；整本字典还剩 3544 条没跑 ⇒ 下一次 entry_range=1180-1769`；`schedulability: …需要分 9 段（每段约 590 条）`。**同一份输出在旧版里就只有 `hits=1`**——这正是"跑一半被读成跑完了"的形态 |
| B4 分段拼完（3 次调用） | `entry_range` = `1-1600` / `1601-3200` / `3201-4723` | 三次分别 `attempted=1600/1600/1523`、`position=1600/3200/4723`、`remaining=3123/1523/0`；命中并集 `{/api, /robots.txt}`。合计 4723 次请求 = `wordlist_entries`，整本字典确实拼完了 |

**一条要记住的读数纪律**：`schedulability:` 是按**声明速率**算的（宿主按它节流），而容器内 ffuf 的实际节奏是
`-t/-p` 的组合 ⇒ 实验室 LAN 上实测 `observed_rps` 达 22–25（声明 5），同一台机器上 B4 反而没被截断。
所以那一行是**规划依据**（保守），不是预测；`summary` 里同时给了 `observed_rps`，两者并排看。
操作者当年那台目标上实测是 4313 次/295s ≈ 14.6 req/s——落在两者之间，于是"跑不完"确实发生了。

**结论**：两条诉求都不是"加一个功能"，而是把**已经有的事实**（这条路径是端点吗 / 这次跑到哪了）
从"人得自己看出来"变成"工具自己说出来"，并且让复核动作留在可审计的结构化通道里。

### 6.5.13.8 第八轮实测（2026-10-11）：容器侧工具面按《沙箱工具规范 v1》统一

**现象**：2026-10-11 质检（`docs/quality-review-sandbox-tools-2026-10-11.md` §二）在**分发器运行时行为**
这一层找到 10 条缺陷（4 条阻断级），既有的锁（对拍模板/technique/动词三处**字符串**）一条都抓不住。

| 现象 | 根因 | 处置 |
|---|---|---|
| `icmp_ping` 先打印 `resolved:`/`icmp_socket:` 再 `internal_error: NameError`，零产出且与"目标不回 ICMP"同形 | 两个 ICMP 类型常量**只被用、从未被定义** | 补常量 + **静态断言**（AST：无 used-but-undefined 名字）。本轮静态锁在**旧版**源码上跑出来的就是 `['ICMP_ECHO_REPLY','ICMP_ECHO_REQUEST']`（失败-先、通过-后都有据） |
| 真 XST 反射与安全目标同形（`echo_risk` 恒 false） | `"<" not in body is False` 是 Python **链式比较** ⇒ `("<" not in body) and (body is False)`，而 body 是 str ⇒ 恒假 | 改成 `"<" in trace_text`；**AST 断言禁止把 `is`/`is not` 与其它比较混用成链式比较** |
| 拼错键名（`restrict_to_scop`）→ 完整 top-100 SYN 扫描照跑、rc=0 无提示；`include_chunks=TRUE` 静默当 false | 每个动词自己 `params.get(...) == "true"`，**没有未知键拒绝** | 四组统一助手（`param_required/param_optional/param_enum/param_bool/param_int/param_list`）+ `reject_unknown_keys`：未知键 **rc=2 并列出接受的键**；`restrict_to_scope`/`include_chunks` 改用 `param_bool`（严格读取）。键集合的**唯一声明**是 `TOOL_PARAMS`，由静态锁对拍"声明 == 实际读取" |
| 超时把**已产出的 stdout** 丢掉（ffuf 进度、whois 的 inetnum、nse 的部分输出全消失） | `run_tool` 超时分支 `return 124, "", …` | 用 `TimeoutExpired.stdout/stderr`；`shell_exec` 同一处理，并把 `aborted=true aborted_items=N` 写进 `summary`（规范 §5） |
| 容器截断**常不置位**宿主 `truncated`（宿主判据是字节数，而容器按行截断后可能仍小于上限） | 截断只体现为一行人类可读文本 | 截断走**退出码 3**（宿主按码置 `truncated: true`）；`[已截断：…]` 行保留给人读，但**不承重** |
| 空列表参数（`record_types=,` / `paths=,`）⇒ `records=0`、rc=0：**"一个都没查"与"查过确实没有"同形** | 只判空字符串 | `param_list` 对**空项/空列表**一律 rc=2；阴性结论必须自带 `attempted/total` |
| 列表/记录切片**不报被省略**（`ct_lookup [:500]`、`web_crawl [:100]`、`dns_axfr [:400]`） | 切片是静默的 | `<x>_total / <x>_listed / <x>_truncated / <x>_remaining` 自报（切片上限收成常量 `CT_LISTED_LIMIT`/`AXFR_LISTED_LIMIT`） |
| `dns_enum`/`dns_brute`/`exposure_check` **没有总预算 deadline**：名义 30/120s，实际按解析器/逐项累加可数倍超支 ⇒ 宿主 SIGKILL | 逐项各拿满 `timeout_s` | 三个动词 + `web_crawl`/`tls_probe`/`fetch_chunks` 全部自持 `monotonic()` deadline（`deadline_for`/`remaining_s`） |
| 每条命令**只报自己的字段**，没有统一状态；"没扫"与"扫到 0"靠散文区分 | 规范 §2 缺位 | 每个动词输出**首行 `state=ok|failed|no_target|partial|aborted`、次行 `summary: k=v …`**；`scanned=false`（没扫 + 原因）与 `scanned=true`（扫到 0）分开；**"一条都没跑"一律 `aborted`+rc=1**（细节见下） |
| 行为层没有锁（质检 §2.3「未锁」1–6） | 只锁字符串 | 新增 `test/pentest-tool-static.test.ts`（AST：未定义名 / 链式比较 / 键集合对拍 / 每个动词必达 `report.finish` / 状态名域 / 截断信号 / **输出上限跨层对拍**（容器默认 256KiB < 宿主兜底 8MiB，且每张模板 ≤ 宿主兜底）/ **孤儿动词双向差集**）与 `test/pentest-tool-behavior.test.ts`（逐动词 argv 冒烟 + 本机可跑动词形态 + 助手/纯函数边界 + `run_tool` 超时保产出） |

**"没扫"与"跑了一部分"的分界（本轮定下的读法）**：`probed/attempted == 0` ⇒ `state=aborted` + rc=1
（这次什么都没查，报告里别写阴性结论）；`0 < attempted < total` ⇒ `state=partial` + rc=0（数据可用但不完整，
`*_truncated=true`/`*_remaining=N` 已自报）；全部尝试完 ⇒ `ok`（**哪怕命中是 0**）。

**实测（真容器 = 本轮新镜像，实验室夹具，非推断）**：夹具是 `python3 -m http.server`（线程版，另有 `/hang`），
网络用**本轮临时创建的 `pentest-toolstd-lab`**（不占 `pentest-lab-internal`），跑完即删。

```bash
IMG='127.0.0.1:5005/pentest-tools@sha256:3401b215a4ab…'
NET=pentest-toolstd-lab
ENV='-e PENTEST_RESOLVED_ADDRESSES=["192.168.0.2"] -e PENTEST_TIMEOUT_MS=60000 -e PENTEST_MAX_OUTPUT_BYTES=262144'
docker run --rm --network $NET $ENV $IMG "<命令行>"
```

| # | 命令（节选） | 原样结论（节选） |
|---|---|---|
| ① | `http_get target=http://192.168.0.2:8080/ method=GET path=/ follow_redirects=false` | 首行 `state=ok`；`summary: scanned=true status=200 method=GET url=… body_bytes=987 redirect_hops=0 verify_tls=true`；rc=0 |
| ② | `port_scan … scope=top100 ports=1 ping=connect restrict_to_scope=true`（空交集） | 首行 `state=no_target`；`summary: scanned=false open_ports=not_scanned hosts_up=n/a ports_scanned=0 label=port_scan reason=empty_scope_intersection`；`scope_resolution: … = 0 个`；rc=0（**"没扫"不再与"扫了全关"同形**） |
| ③ | `port_scan … restrict_to_scop=true`（键名拼错） | stderr 首行 + stdout：`usage_error: port_scan 不认识参数 restrict_to_scop；接受的键：ping, ports, restrict_to_scope, scope, target`；stdout 另有 `accepted_keys: …`；**rc=2** |
| ③b | `http_probe … include_chunks=yes` | `usage_error: include_chunks 只接受 true/false（大小写不敏感），收到 'yes'`；**rc=2**（旧版静默当 false） |
| ④ | `http_probe … collect=headers paths=/,/nope-a,/nope-b,/hang` | 首行 `state=ok`；`paths_soft404_baseline: status=404 size=469`；`/` → `candidate_endpoint:`；两个 `nope-*` → `note=soft404`；`/hang` → `no_response`；`paths_summary: paths=4 ok=3 no_response=1`；`paths_coverage: paths_total=4 paths_attempted=4 paths_truncated=false paths_remaining=0`；rc=0 |
| ⑤ | `content_discover … wordlist=common_dirs entry_range=1-20` | 首行 `state=ok`；`coverage: wordlist_entries=4723 entries_total=4723 entry_range=1-20 requested=20 entries_attempted=20 entries_truncated=false entries_remaining=4703 position=20 reason=completed`；`schedulability: … 需要分 10 段（每段约 500 条）：1-500 / …`；rc=0 |
| ⑥ | `exposure_check … paths=env,git,phpinfo` | 首行 `state=ok`；三条 `control=same looks_like=n/a（与随机对照同形…）`；`paths_coverage: paths_total=3 paths_attempted=3 paths_truncated=false paths_remaining=0`（**阴性结论也回答"扫了什么"**）；rc=0 |
| ⑦ | `shell_exec command_b64=<echo EARLY_LINE_1; sleep 40>`（注入 8s ⇒ 预算 6.4s） | 首行 `state=aborted`；`summary: … timeout_ms=6400 duration_ms=6408.9 aborted=true aborted_items=1 stdout_bytes=13`；`stdout_partial:` 下**保留了 `EARLY_LINE_1`**；rc=1 |
| ⑧ | `icmp_ping target=192.168.0.2 count=2 size=32` | 首行 `state=ok`；`icmp_socket: unprivileged_dgram`；`reply: seq=1 … seq=2`；`summary: … packets_sent=2 packets_received=2 loss_pct=0 rtt_avg_ms=0.8`；rc=0（0-1 的端到端回归位） |
| ⑨ | `http_check … check=security_headers` | 首行 `state=ok`；`summary: … checks_done=1 headers_total=6 headers_present=0 verify_tls=true`；rc=0 |
| ⑩ | `port_scan … scope=top100 ports=8080 ping=connect restrict_to_scope=true` | 首行 `state=ok`；`summary: scanned=true open_ports=1 hosts_up=1 hosts_total=1 ports_scanned=1 label=port_scan`；`used_ports: 8080`；`port: port=8080 proto=tcp state=open reason=syn-ack`；rc=0（**"扫到 1"**） |
| ⑪ | `tcp_connect target=192.168.0.2 port=8080` | 首行 `state=ok`；`port_state: open`（旧版这句写的是 `state: open`，与新的首行撞名）；`summary: … port=8080 port_state=open connect_ms=0.2 banner_bytes=0 egress=direct`；rc=0 |
| ⑫ | `shell_exec command_b64=<seq 1 500>` + `PENTEST_MAX_OUTPUT_BYTES=2048` | 输出被容器自己截断：尾行 `[已截断：输出超过 PENTEST_MAX_OUTPUT_BYTES=2048 字节，本次由容器自行截断；宿主按 exit 3 识别]`；**rc=3** |

> 夹具注意：`/hang` 那条用例要求夹具**多线程**——单线程 `socketserver.TCPServer` 会被一个 sleep 60 的
> 请求卡住，后续请求全部排队超时（本轮实测踩到，表现为 ffuf 的 autocalibration 超时退出、
> `error: ffuf_output_missing`）。这是设施问题，不是分发器问题。

---

## 6.5.14 本机跑测试需要独立的 `pentest` 测试库（2026-10-10 补）

`npm test` 的加载器**拒绝**把测试跑在 `pentest_personal` 上（按作业清理会吃掉真实战果）。
本机若只有个人库，先建测试库并迁移再跑（迁移器是 `src/db/migrate.ts`，幂等）：

```bash
node -e "const{Client}=require('pg');const c=new Client({connectionString:process.env.PENTEST_DATABASE_URL.replace(/\/[^/]+$/,'/postgres')});c.connect().then(()=>c.query(\"create database pentest\")).then(()=>c.end())"
node --experimental-strip-types -e "import('./src/db/migrate.ts').then(m=>m.migrate({connectionString:process.env.PENTEST_DATABASE_URL.replace(/\/[^/]+$/,'/pentest'),log:console.log}))"
PENTEST_DATABASE_URL="$(node -e "console.log(process.env.PENTEST_DATABASE_URL.replace(/\/[^/]+$/,'/pentest'))")" npm test
```

## 6.5.15 **构建了不等于部署了**：profile 里装的是插件副本（2026-10-10 排查 4 小时的真凶）

**症状**：代码改对、`npm run build` 通过、进程重启过，可操作者复测仍报同一批错
（`ports="3002"` 被判成 80|443；`content_discover` 参数面里没有 `path`/`api_endpoints`；
参数指南里还在介绍一个不存在的 `pentest_vuln_check`）。

**根因**：`start-personal.mjs` 启动的是 `dsh --profile pentest`，而 profile 的
`node_modules/dsh-pentest` 是**安装时复制进去的产物**（只含 `lib/` + `cordis.patch.yml`），
**不是本仓的软链**。于是「改 src → 构建 lib → 重启进程」这条链**根本没碰到部署**：
运行的还是 08:20 那份副本，而全部修复都是 10:57 之后提交的。

**判定方法（三条全中即为此坑）**：

```bash
P="C:/Users/Administrator/.dsh/profiles/pentest/node_modules/dsh-pentest"
ls "$P"                                   # 没有 src/ ⇒ 是打包副本，不是软链
stat -c '%y' "$P/lib/execution/templates.js"   # 时间早于你的构建 ⇒ 副本是旧的
grep -c "ports-param" "$P/lib/execution/templates.js"   # 0 ⇒ 部署里没有 P0 修复
```

**修法**（重装即刷新；装完 profile 里会变成**指向本仓的软链**，此后构建即生效）：

```bash
cd C:/Projects/Agent-projects/dsh-DCG-pentest
npm run build
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile pentest add "C:/Projects/Agent-projects/dsh-DCG-pentest"
# 复核：grep 到了修复标记，再重启
grep -c "ports-param" "C:/Users/Administrator/.dsh/profiles/pentest/node_modules/dsh-pentest/lib/execution/templates.js"
```

**下一次改动的纪律**：凡改 `src/**` 或 `docker/tools/**`，**先问一句"部署里跑的是哪一份"**。
副本形态下必须重装；软链形态下 `npm run build` + 重启即可。`docker/tools/pentest-tool`
还要单独处理——它**烤在镜像里**（见 §2.1 的镜像重建流程），改它必须重建并重新钉摘要。

**为什么 `(3) skill_load` 与 `(4) memory_search` 当时"看起来好了"**：那两处的修复分别是
**数据**（技能播种）与**未走到坏分支**（有命中时不进零命中诊断），与代码版本无关——
所以它们给了"新代码已生效"的错觉。**别用"某功能好了"推断部署版本**，用上一条的 grep。

### 6.5.15.1 本轮镜像轮换（2026-10-10）：证据与流程

容器侧改了两处（`whois_query` 的显式转介链、`port_scan` 默认超时 300s→900s），
因此必须重建镜像并重新钉摘要——**改了 `docker/tools/**` 却不重建，等于没改**：

| 步骤 | 命令 | 本轮结果 |
|---|---|---|
| 构建 | `docker build -t 127.0.0.1:5005/pentest-tools:0.1.0 docker/tools` | 全缓存命中，18 秒 |
| 推送取摘要 | `docker push …` 后 `docker inspect … --format '{{index .RepoDigests 0}}'` | `sha256:7548dbc3a2ae…`（前值 `5ee07609c870`） |
| 更新钉死值 | `profiles/pentest/cordis.patch.yml` 与 `harness.dev.patch.yml` 的 `allowedImages[0].digest` | 两处 |
| 摘要轮换背书 | `node scripts/resync-smoke-stamps.mjs 7548dbc3a2ae` | 25 份、27 处（含两份早先钉在 `81483611f0a0` 上的） |
| 实跑验证 | 三条 `whois_query`（公网 IP / 域名 / 内网 IP）+ `port_scan` 超时表 | 见 6.5.13.1 末两行 |

**轮换背书的依据（不是"顺手改绿"）**：新旧镜像做了**文件级对拍**——`/usr/local/bin/pentest-tool`
之外的全部代表性文件（nmap/ffuf/whois/gobuster/dig 的 md5、nuclei 模板数、字典数）逐一相同，
即本次重建**只换了分发器脚本**；唯一语义变化的动词（`whois_query`）已在新摘要下实跑三条路径。

**流程纪律**：`scripts/dev-sandbox-up.sh up` 带出口白名单闸门（`EGRESS_ALLOW` 为空即拒绝启动），
只做构建/推送时用 `docker build` + `docker push` + `docker inspect` 三步即可，不要为了绕过闸门
去编一个 `EGRESS_ALLOW` 值——那是授权声明，不是开关。

**第三轮（同日，2026-10-10）再换钉一次**：分发器又改了三处（原始件落盘 / `restrict_to_scope` 交集 /
`scaninfo`+`nmap_done`+全 down 告警），流程同上；摘要 `5ee07609c870 → 7548dbc3a2ae → a95b0affb2cd → 266173b38d52`，
25 份技能戳每次都跟着轮换。

**踩过一次的坑（记下来省时间）**：往 Dockerfile **中段**加 `ENV`（locale 那次）会让其后每一个 `RUN` 层失效——
本地实测一次重建把整层 apt 又跑了一遍，**1200 秒都没装完**。运行时环境变量放**末尾**（`ENTRYPOINT` 之前）
表达同一件事，且不砸缓存：改完只有最后几层重建，2 秒完成。

## 6.6 建作业只需两件事；公共记忆进每一次会话

**新建 engagement 的必填只有**：名称 + 至少一个授权目标。

其余（授权依据引用、授权到期、排除项、规则、时间窗、紧急停止）都在向导的
**「高级选项」折叠区**里，**都可留空**：

| 字段 | 留空意味着 |
|---|---|
| 授权依据引用 | 只进档案与审计；范围判定不读它。**本部署不要求授权凭据**（授权主体即部署方），范围确认与范围修订都不因它为空而阻断 |
| 授权到期时间 | **未声明到期 = 永不过期**。填了才构成硬边（到期后新动作被拒） |
| 排除项 | 不排除任何东西 |
| 规则/时间窗 | 存档而已（当前代码没有读取方） |

**公共记忆**（控制台 → 公共记忆面板，或建作业时直接填）：

写在这里的规则会注入本作业下**每一次新建会话**的系统提示词——包括重做与阶段切换，
不只是下一个新会话。适合写：这个作业的通用规矩、客户的硬性限制、已经确认过的共识
（例如「只做被动读取」「不要碰生产网段」「报告一律用中文」）。

- **上限 8000 字符**：它挤占每一次请求的上下文，过长会吃掉任务本身需要的空间。
- **改动要写理由**（内容真改过时才要求）：它改变整个作业的行为边界，因此走「人类决策」
  那条路径，与切换阶段同级。
- 它与「记忆浏览器」是两回事：那边是 Agent 产出的事实（只追加、可检索），
  这边是人写的指令（唯一当前版本、无条件注入）。

## 6.7 界面上的实际路径（实测走通的）

**四个入口**（都指向同一个控制台；现在不止设置页那一个）：

| 入口 | 位置 |
|---|---|
| 侧栏「渗透作业」 | 左侧导航栏，一键进入**全高主面板**（推荐） |
| 常驻状态条 | 页面**下方居中**：显示作业名 / 阶段 / 「N 在跑」/「N 待你判断」，点击进入主面板 |
| 设置 → 插件 → 渗透作业 | 原有入口（弹窗形式） |
| 预设选择器 | 选「**渗透模式**」让会话带上渗透姿态 |

```
打开 URL（带 token）
  → 侧栏点「渗透作业」（或点下方状态条）
  → 新建 engagement → 填名称 + 目标（可选：公共记忆）→ 校验范围 → 勾选确认 → 确认并建立
  → 选中列表里的 engagement
  → 运行控制：选阶段（横排五个）+ 填任务提示词 + 填启动理由 → 启动 Agent
  → 等它跑完（它自己会转 waiting_human，状态条会亮起「1 待你判断」）
```

**主面板里能看到什么**（这一屏才是「状态机展现在面前」）：

- **阶段轨道**：五个阶段**横向**排列，节点之间画边（虚线=时间顺序，实线+彩色=交接/重做/
  有证据的关系），回环发生时另画一条折回的弧线。节点上是状态色、会话数、重做次数与最新便签。
- **运行控制**：启动 / 暂停 / 恢复 / 插话 / 终止 / **结束技术测试**（生成报告草稿，进入报告阶段），每个禁用都写明确原因。
- **会话时间轴**：每个会话一行，带阶段、状态、时间与便签。
- **八个面板**：总览与时间轴 / 报告审阅 / 记忆浏览器 / 放行队列 / 交接编辑 / Skill 库 / 范围管理 / **公共记忆**。

三个容易卡住的地方，都是**故意的闸门**而不是故障：

1. **「确认并建立 engagement」一开始是灰的**，鼠标悬停会显示还缺哪几项（要一项项补齐）。顺序上最容易漏的是「校验范围」与最底部的勾选框——后者要等范围校验通过才有意义。
2. **「启动 Agent」也是灰的**，而且提示是**逐项**出现的：先提示缺任务提示词，填完才提示缺启动理由。不是点不动，是还没填完两项。
3. **控制台整个在设置弹窗里**，高度有限，「运行控制」在总览下方，需要往下滚一点才能看到按钮。

界面上一切正常但 Agent 不动时，看两处：**模型**（落地上如果显示的不是你配的模型，路由就是错的）和 **`~/.dsh/settings.yaml` 的 `agent-presets`**（preset 装载失败会让**任何**新会话都建不起来，见 §7）。

## 7. 已知边界

- **「结束技术测试」会被在途动作或未处置的放行凭证拦住**（§13.8 第二步，拒绝文案会写明是哪一类）：
  放行凭证在放行队列里处置或撤销即可；工具执行要**等它结束**。例外是**孤儿执行**——宿主在它运行
  中途重启、而心跳仍在为那条会话续租时，它既等不到结束，也进不了对账的结算集合（对账只结算
  超过 16 分钟的执行，且要求该作业进入扫描范围）。此时受支持的出口是**终止该作业**（放弃报告）。
  待决凭证只统计**未过期**的：过期的谁也处置不了，不计入（否则永久结束不了技术测试）。

- **`agent-presets` 坏掉会让整个 dsh（不只是本插件）用不了**。本机踩过**两处同类漂移**，都在 `~/.dsh/.agent-presets/anchored-standard/`：
  1. `agent.cordis.yml` 的 `persona` 段写 `text:`，而插件 schema 是 `prefix:`（`z.string().required()`）→ **任何新会话都建不起来**（落地上「选择工作区」失败）；错误只在浏览器 console 里以 `warning` 出现（`agent-preset/invalid`）。
  2. `tool-bootstrap.mjs` 读了 `agent.session.events.some(...)`，而 dsh 0.1.5-rc.2 的 `Session` **没有 `events` 成员**（只有 `id` / `seq` / `eventAt()` / `surface`）→ 该句抛 `Cannot read properties of undefined (reading 'some')`。它位于 `system-prompt/assemble` 里、**第一次请求的装配路径**上，所以会话能建、但**第一个回合必然失败**（`turn/end` 报 `UNKNOWN`，模型一次都没被调用）；界面上表现为聊天里一行「**本轮运行失败**」。

  **怎么查**：`本轮运行失败` 是 dsh 聊天视图的文案（`message.turnError`），不是本插件的。会话日志里有确切原因——按 `28 B5 2F FD` 魔数逐帧解 zstd 后找 `turn/end` 的 `reason.error`（多帧压缩，直接整文件解会中途失败）。
  **怎么改**：把字段名/API 改对。两处原文件都已备份为 `.bak`。
- **沙箱不经代理，且可出网**（2026-10-05）：容器直连目标，`docker-sandbox` 的 argv 里没有代理变量（回归锁在 `test/docker-sandbox.test.ts`）。同日操作者决定「沙箱可达范围 = 宿主可达范围」：沙箱网络 `pentest-lab-internal` 改为**非 internal**（同网段 172.29.0.0/16、靶标 IP 不变），profile 写 `sandbox.allowEgress: true`（缺它预检直接拒绝启动）。**后果：网络层不再是范围边界**——仅剩 admit 的范围裁决（选择器解析 → 地址固定 → 范围快照比对）与逐次人工放行；残留代价：端口粒度不可强制、命令可达任意主机（公网、局域网、宿主已发布端口），外传通道客观存在（见 `skills/exploit-safety`）。**回退**：把网络重建为 `--internal` 并删掉 `allowEgress`。
  （历史：第一轮曾用透传代理做出口，空白名单按拒绝所有目标处理；该模式及其 `EGRESS_ALLOW` 变量已不在当前部署路径上。）
  进生产前仍必须换成在连接时刻做范围/地址/鉴权/审计裁决的通道。
- **Docker 网络拓扑由个人启动器做运行时检查**（2026-10-07 与代码对齐）：网络必须存在；网络**非** `internal=true` 时必须显式 `sandbox.allowEgress: true`（否则拒绝启动，并给出两条路）；网络成员必须是 `PENTEST_LAB_TARGETS` 声明的实验室目标（代理豁免）。**代理已不在出网路径上**：它不存在**不拦启动**（此前会拦——按 §0 四样东西搭的合法部署因此被拒），存在时只提示它接在哪些网络上。`DockerSandbox` 本身只接收配置，不在每个容器启动前 `docker inspect`；它在启动时做一次**非阻塞**的可达性自检并印出实况。
- **宿主侧输出缓冲有上限（8 MiB），超限丢弃尾部并在 stderr 标注**。这是独立于容器内 `PENTEST_MAX_OUTPUT_BYTES` 的兜底：后者只约束守规矩的 Reporter，前者防容器失控刷爆宿主内存。取消与超时都会杀**整个进程组**（POSIX `detached` + `kill(-pid)`），不再只杀直接子进程。
- **记忆与证据的范围过滤依赖写入侧填资产归属**。`memory_chunks` / `memory_items` / `artifacts` 三张表的 `asset_ids` 是 §8.6 谓词的唯一输入；能确定目标却留空的写入必须被拒绝，否则「不标资产」就是绕过范围的路子。空数组仍然放行（思考链、人工决策、压缩摘要本就无归属）。
- **控制台读取与 Worker 读取走同一份范围谓词，且都要求租约有效**。控制台按当前范围版本，Worker 按会话冻结的范围版本；`readMemory` 在无可见分块时拒绝，不回退返回原始 payload。
- **可观测性未实现**（§14）：15 项指标零发射、四种回放全缺。要判断「Agent 到底做了什么」目前靠会话事件与数据库。
- 证据仓库（`artifacts`）**只读不写**：`artifact_read` 读的是既有行，当前没有写入产线。
- **实测规模与耗时**（2026-10-05 复核）：`npm test` → **1663 用例 / 0 失败 / ≈2 分钟**（`--test-concurrency=1` 串行跑，带真实 PostgreSQL 的 test 库）。别被"集成测试"四个字吓住，它比一场代码审查还快。
- 全量测试**不可并发跑**（共享同一个 PG，且**测试库是 `pentest`、不是 `pentest_personal`**）；跑前先停常驻服务，否则调度器会与测试抢同一批表。
  - 指向个人库会被 `test/helpers/tsx-loader.mjs` 的守卫**直接拒绝**（§6.5.12）——这条纪律已经不用靠人记。
  - 若常驻服务用的是**另一个库**（个人库）而测试用 `pentest`，两者不共享表，可同时跑；上面这条停服务的建议针对的是「同库」场景。实测的失败形状：`索引调度器 → drain：反复处理直到队列为空` 期望领 5 个任务、实际领到 2 个（另 3 个被常驻调度器先领走），且**失败会跳过清理**、在库里留下孤儿 `memory_chunks`。该用例已改为断言**最终状态**（任务都 done、事件都落块、无 pending/dead），对并发领取免疫；清理夹具也补了第二轮迟到写入扫描。规程不变：跑前停服务——其它用例未必都免疫。
- **开发数据库连超级用户 = 隔离不成立**，见 §1「连接角色」。`test/` 里绝大多数集成用例也是超级用户连接，因此它们只证明数据装配，不证明隔离；隔离的回归锁是 `test/rls-isolation.test.ts`（`SET LOCAL ROLE pentest_app`）。
