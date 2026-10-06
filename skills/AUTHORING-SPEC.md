# skill 撰写规格（本目录所有 SKILL.md 必须遵守）

**标杆**：`skills/recon-network-surface/SKILL.md`。先完整读它，再动手；产出必须与它同构、同密度、同口吻
（中文、工程化、无废话、不写营销句）。

## 1. 路径与格式

- 路径：`skills/<skill-name>/SKILL.md`，kebab-case，目录名与 frontmatter 的 `name` 一致。
- 细节多可加同目录 `references/*.md`；但主文件必须自足（不读 references 也能执行）。
- 行尾 **LF**；主文件 **≤300 行**。

frontmatter（字段名严格照抄）：

```yaml
---
name: <kebab-case>
description: <一句话：它做什么>
whenToUse: <什么场景该加载它>
metadata:
  version: 0.1.0
  phase: <intelligence-gathering|threat-modeling|vulnerability-analysis|exploitation|post-exploitation>
  sources: [<出处名>]
---
```

正文小节顺序固定：

`## 适用场景` → `## 前提与边界` → `## 步骤`（每步一个小节：```bash 命令``` + **期望** + **判据**）→
`## 判读与去噪` → `## 常见失败`（表格：现象 | 真实原因 | 处置）→ `## 不做的事` → `## 产出（交给下一步）` → `## 参考`

## 2. 内容纪律

- **必须原创**：可引用方法论名字（PTES 阶段、OWASP WSTG 测试项编号、MITRE ATT&CK 战术、
  HackTricks / PayloadsAllTheThings 的名字），**不得整段照抄**任何来源文本。
- 每条命令都要**真的能在沙箱里跑**，并写清：期望输出形态、命中判据、噪音与假阳性怎么处置。
- 「判据」必须可判定（例如「出现 `Host is up` 才继续」），不写「视情况而定」这种空话。

## 3. 沙箱的真实约束（写技能时必须遵守）

**工具集的权威清单在 `src/contracts.ts` 的 `SANDBOX_TOOL_GROUPS`**（分组 + 一句话用法 + 出处），
`test/sandbox-environment.test.ts` 会逐条回到 `docker/tools/Dockerfile` 核对——**不要在这里抄一份**，
抄一份的结果是两边逐渐不一致（本节原先写着「镜像里装好了 nmap curl wget nc dig openssl jq whois ping ffuf sqlmap」，
而镜像早已多出 nuclei / httpx / katana / subfinder / dnsx / john / hydra / masscan / socat / testssl / smbmap / chisel / iproute2 等几十个工具）。
要确认某个工具在不在：`npm run verify:tool-image -- <镜像引用>` 全量列一遍。

- **shell 是 bash**（2026-10-06 起；此前是 dash）。`$RANDOM`、`<(...)`、`[[ ]]`、数组都能用。
- 容器内是 **root**，有 **NET_RAW**（`nmap -sS` 可用），`/tmp` 可写可执行，根可写，`--rm` 即弃。
- **凭据与范围**：沙箱接的网本部署非 internal ⇒ **可出网**，但出网是**间歇的**（2026-10-06 实测同一天两次结果相反）。
  凡需要公网的步骤（查 CVE、下载模板、外部解析器、外部 whois），必须写清两件事：
  **证据纪律**（外部结果标来源，外部资料不是目标证据）与**取不到时怎么办**（改用人类提供的材料 / 记忆检索 / 由人类在控制台完成）。
- 目标地址用**选择器给的已裁决地址**，不要自己解析域名。
- 宿主按行为预设限速（stealth 1/s、standard 5/s、deep 10/s）。**不要**用 `--min-rate` 之类去顶；
  被排队是预期行为，不是故障，不要重试绕过。
- 越界即中止并请人类修订范围；破坏性 / 持久化 / 数据外传类动作会被上游直接拒——技能里要写明这条边界。

## 4. 允许的验证（每个 pack 至少冒烟一次）

**先起一对实验室靶标**（2026-10-06 起用的就是这一对；比单个静态站更能覆盖技能里的判据：
`.env`/`.git/HEAD`/`swagger.json`/`robots.txt`/登录表单 + 自签 TLS）：

```bash
FIX="$TEMP/dsh-fixture"            # 建好 index.html/page2.html/robots.txt/.env/.git/HEAD/swagger.json
docker run -d --name fx-web --network pentest-lab-internal -v "$FIX:/srv:ro" \
  --entrypoint python3 python:3.10-slim-bookworm -m http.server 8080 --bind 0.0.0.0 --directory /srv
docker run -d --name fx-tls --network pentest-lab-internal python:3.10-slim-bookworm sh -c \
  "openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 1 \
     -subj /CN=smoke.local -addext subjectAltName=DNS:smoke.local >/dev/null 2>&1 && \
   openssl s_server -quiet -accept 8443 -cert /tmp/c.pem -key /tmp/k.pem -www"
```

靶标地址：**fx-web `172.29.0.2:8080`**、**fx-tls `172.29.0.3:8443`**（SNI `smoke.local`）。**别打别的地址。**

需要 API 面时再起一个靶站（`docker/lab-api/labapi.py`，单文件无依赖）：

```bash
docker run -d --name fx-api --network pentest-lab-internal \
  -v "$PWD/docker/lab-api:/srv:ro" --entrypoint python3 python:3.10-slim-bookworm /srv/labapi.py 9000
```

它内置了刻意做错的形态（未授权列表、BOLA、`Allow` 与实现不一致、Content-Type 判定、mass assignment、
GraphQL introspection、verbose 报错），写 API 技能时就拿它当判据来源。

需要 AD 面时再起一个实验室域控（域 `LAB.LOCAL`，构建与限制见 `docker/ad-dc/` 与 RUNBOOK §2.1⑤）：

```bash
docker build -t pentest-ad-dc:lab docker/ad-dc
docker run -d --name ad-dc --privileged --network pentest-lab-internal --hostname dc1 \
  --mount type=volume,src=ad-dc-samba,dst=/var/lib/samba pentest-ad-dc:lab
docker inspect ad-dc --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

写 AD 技能时记住这个夹具的两条限制（它们也是真实目标会遇到的形态，别当成夹具怪癖绕过去）：
LDAP **SIMPLE 绑定可用、NTLM 被拒**（`ldapdomaindump -at SIMPLE`）；**Kerberos 需要域控名字可解析**
且与 Samba KDC 存在 `KRB_AP_ERR_INAPP_CKSUM` 互操作问题。

冒烟就在真实沙箱参数下跑（与宿主侧 `buildDockerArgs` 一致）：

```bash
docker run --rm --network pentest-lab-internal --cap-drop ALL --cap-add NET_RAW \
  --security-opt no-new-privileges --pids-limit 512 --cpus 2.0 --memory 2g \
  --tmpfs /tmp:rw,exec,nosuid,size=512m --entrypoint /bin/bash \
  "$(grep -A1 'name: 127.0.0.1:5005/pentest-tools' harness.dev.patch.yml | grep digest | awk '{print "127.0.0.1:5005/pentest-tools@"$2}')" \
  -c "<你的命令>"
```

**摘要不要抄进本文件**（抄了就会过期——本节原先钉的 `a197af1d36f6` 早就不是当前镜像了）：上面这条从
`harness.dev.patch.yml` 现取，它同时是 `test/skill-pack.test.ts` 比对 skill 冒烟背书的来源。

**冒烟要跑技能里的原文配方**，不要跑"等价命令"：先按正文描述把 `/tmp/*.json` 台账铺好，再把占位符换成靶标真实值。
2026-10-06 那次逐块验证就是这么抓到 9 处配方缺陷的（jq 表达式跑不通、步骤 1 产出的文件喂不动步骤 3、
脱敏只匹配值不匹配键、`dig | head` 吞掉退出码……），而"等价命令"全部跑得过。

## 5. 交付

- 只新增 `skills/**` 下的文件；**不改任何源码**；不跑仓库测试 / lint / build。
- 报告：写了哪些文件；冒烟了哪些命令（贴原样输出）；哪些命令没能验证及原因。
