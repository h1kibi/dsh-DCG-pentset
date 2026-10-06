# 本机实测指南

面向个人使用、非生产。目标：**在你这台机器上把插件跑起来，指向自己的靶场做一次真实渗透动作**。

权威设计文档是 `docs/dsh-pentest-plugin-design.md`；本文件只讲「怎么跑」。

---

## 0. 一句话结论

跑起来需要四样东西：**PostgreSQL**、**工具容器镜像 + 本地 registry**、**internal 网络 + 出口代理**、**模型凭据**。前两样有脚本，第三样一条命令，第四样用环境变量。

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

这一步构建工具镜像、启动本地 registry、创建 `internal=true` 的沙箱网络、启动带显式出口白名单的代理，并打印真实镜像摘要。不要把 `example.com` 或任意公网地址作为第一轮目标。

验证代理路径：

```bash
TARGET=http://lab-web:8000/ \
PENTEST_RESOLVED_ADDRESSES='["172.28.0.10"]' \
EGRESS_ALLOW=172.28.0.10 \
sh scripts/dev-sandbox-up.sh smoke
```

启动器还会拒绝以下状态：网络不是 `internal=true`；internal 网络成员不是唯一代理；代理连接了除 `bridge` 与 internal 网络外的其它网络；代理缺少 `EGRESS_ALLOW`；工具镜像摘要与 profile 不一致。

`direct` 只用于实验室目标的镜像/argv 诊断，不属于正常实战路径，因为它绕过代理。

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

**本轮冒烟用的靶标（实验室，可重复起）**：

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
            proxyHost: pentest-proxy
            proxyPort: 8080
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
| 会话工作目录 | `C:/tmp/dsh-pentest-sessions` | 只影响会话自己的临时文件，与沙箱无关 |
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
| 工具容器连不上外网 | `pentest-proxy` 起没起；`tcp_connect` 之类不吃 `HTTP_PROXY`，在 internal 网络上只能打到网内容器 |

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

1. **出口白名单必须包含本次要打的已确认目标**：代理容器的 `EGRESS_ALLOW` 是**唯一**出网路径，
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
   若你的作业是在**旧版本**上确认的（策略里 `passive_read`/`active_discovery` 也在放行集合里），
   每个动作都要人点一次——新建作业确认一次即可，或接受逐次放行。

4. **批准后 Agent 会被唤醒送达**（`tool.approval.notified`）：如果你在审计里看到
   `tool.approval.notice_failed`，说明消息没送到（会话可能已关闭）——用「插话」手动唤醒。

## 6.5.4 跟随 Agent 会话：**人类点击已生效**（自动跟随仍默认关）

**2026-10-03 更新（实机验证）**：运行卡的动作入口按真实状态给：

| 卡片状态 | 按钮 | 点击后 |
|---|---|---|
| Agent 已交报告（`waiting_human_review`） | **进入下一阶段（<下一阶段名>）** | 请求草稿 → 按推荐路径确认 → **直接切到新会话** |
| Agent 还在跑 | 去看 Agent 的会话（dsh-…） | 切到那条会话并停住（实测：卡片消失、统计从「5 次工具调用」变成「14 次工具调用」，4 秒后仍在） |

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
| `stealth` | 红队 · 隐蔽测试（被看见即失败） | 允许被动/低噪声；不做全端口与爆破；留痕与外传禁止 | 1/s·并发1 | passive_read、active_discovery |
| `standard` | 已通知的授权渗透测试 | 常规识别+最小化验证；失败也要记录 | 5/s·并发2 | + authenticated_read |
| `deep` | 高许可 · 穷尽利用尝试 | 全端口/爆破/多路径利用；**穷尽=尝试并记录**，不是必须打进去 | 10/s·并发4 | + exploit_validation |
| `custom` | 自定义（人类写指引） | 逐字注入人类写的 `customGuidance`（≤2000 字），冲突时优先 | 同 stealth | 同 stealth |

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

**`tcp_connect` / 工具直连与 banner 判读**：沙箱现在直连内网目标，`state: open` 后报告会带对端
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
  改动则 revision+1 留痕）。当前库里 **21 条**：情报 4、威胁建模 5、漏洞分析 4、利用验证 5、后渗透 3。
- **怎么到 Agent 手上**：会话创建时能力快照列出「已装载 skill：名字（一句话描述）」；
  正文用 **`skill_load`** 按需取——**只有该会话装载的名字取得到**（装载在创建时冻结，
  库里的其它 skill 对它不可见，这是 `PgWorkerTools.loadSkill` 的第一道判断）。
- **默认装载**写在 `src/skills/skill-pack.ts` 的 `SKILL_PACKS`；人类在控制台仍可改勾选。
- 正文是**会被模型当指令执行的内容**：新增/修改走服务层（哈希 + 审计），别直接改库。
  未配 `skillAuditEngagementId` 时启动日志会明确警告「skill 增删改不写审计」——这是已知缺口。

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
- **Docker 网络拓扑已由个人启动器做运行时检查**：必须 `internal=true`、internal 网络唯一成员为代理、代理只能连接 `bridge` 与 internal 网络。`DockerSandbox` 本身仍只接收配置，不在每个容器启动前执行 `docker inspect`；绕过个人启动器的部署必须自行实现同等 preflight。
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
