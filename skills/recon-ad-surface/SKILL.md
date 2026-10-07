---
name: recon-ad-surface
description: 在 Active Directory 环境里做可复核的域面清点：域画像、对象清单、SPN/委派/ADCS 候选，全部只读
whenToUse: 情报收集阶段；目标内出现域控或域成员（88/389/445/636 端口、SMB 返回域信息）；已拿到或尚未拿到一组域凭据
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, MITRE ATT&CK T1087.002 / T1069.002 / T1482 / T1201 / T1649, Microsoft AD 架构文档, Samba 官方文档]
  smoked: "沙箱实测@b9d9011f8331：对实验室 Samba AD DC（域 LAB.LOCAL）逐块跑：①enum4linux-ng -A 通过（SMB 445/139 可达、Domain/NetBIOS 段、SMB1=false）②LDAP 根 DSE 通过（namingContexts=DC=lab,DC=local）③ldapdomaindump **必须加 -at SIMPLE**——默认 NTLM 绑定被服务端掐断（LDAPSessionTerminatedByServerError），加 -at SIMPLE 后 Bind OK + Domain dump finished ③b rpcclient 通过（6 用户带 RID、6 组）⑤SPN/DONT_REQ_PREAUTH/委派三条 LDAP 过滤通过（svc-web HTTP/…、svc-sql MSSQLSvc/…；UAC 查询显示 4260352）⑧kerbrute userenum 通过（17 名字、2 valid）⑨端口面通过（53/88/135/139/389/445/464/636/3268/3269 open）。未通过并已写入常见失败：④bloodhound-python 的 Kerberos 路径报 dc1.lab.local:88 名字解析失败（容器 DNS 不解析域内名字）、NTLM 路径被拒；⑥certipy find 与 ⑦adidnsdump 分别因 KRB_AP_ERR_INAPP_CKSUM 与「只支持 NTLM」未通。两条夹具限制已记入 docker/ad-dc 与 RUNBOOK"
---

# AD 域面清点（recon-ad-surface）

## 适用场景
- 情报收集阶段，范围里出现域控（典型端口 88/389/445/636/3268）或域成员主机。
- 两种起点，**先说清是哪一种**：
  - **未认证**：只有网络可达，能问的是 SMB/RPC/LDAP 的公共面（域是谁、主机叫什么、匿名能不能绑 LDAP）；
  - **已认证**：人类给了一组域账号（哪怕是普通域用户）——这是 AD 攻击面的真正入口。
- 本条只做「把域面记录成可复核的事实」。Kerberoast/ADCSC 这些**结论**在 `vuln-ad-checks`，利用在 `exploit-*`。

## 前提与边界
- **本技能没有结构化通道**：`pentest_recon` 的 technique 是网络/Web 面，AD 面一个都没有。所以下面每条命令都经
  `pentest_exec` 走 `direct_command` 模板，类别 `exploit_validation` —— **每条都要人类逐条放行**。
  写法上因此要「一条命令一个目的」：把 8 步揉成一条长命令，人类在放行卡上看不懂，等于自己给自己制造风险。
- 凭据来源必须记录：谁给的、什么权限、有没有过期时间。**不要在命令里写死口令**，用人类放行的那条命令里带
  （或落到 `/tmp/cred.env` 再 `source`），并在产出里标注「凭据来自人类放行 #N」。
- **Kerberos 对时钟敏感**：域控与容器相差 >5 分钟会以 `KRB_AP_ERR_SKEW` 失败；先对时（见「常见失败」），
  不要把它归因成「凭据错」。
- 容器内的 DNS **不解析域内的名字**（解析器是宿主的）。Kerberos 相关工具一律用 `--dc-ip <已裁决地址>` /
  `-ns <地址>` 直连，不要指望 `dc1.lab.local` 能解析。
- 只读纪律：本技能**一个写操作都没有**。任何 `set`/`add`/`modify`/`reset`/`--action write` 都不在这里。

## 步骤

> 下面每一步都先写清「期望什么、拿什么当判据」。拿不到期望输出时先看「常见失败」，不要直接换工具重试。

### 1. 未认证面：这台机器是不是域控、域叫什么
```bash
enum4linux-ng -A <已裁决地址>
```
**期望**：`Domain Information` 段给出域名/NetBIOS 名/主机名/OS 版本，`Session Check` 给出 SMB 签名情况。
**判据**：出现域名 + `[+]` 的共享/用户列表才算摸到表面；**SMB signing 是否为 required** 要单独记一句
（它决定后面 SMB 中继面是否成立，属漏洞分析阶段的输入）。

### 2. 未认证面：LDAP 允许匿名绑定吗
```bash
ldapsearch -x -H ldap://<已裁决地址> -s base -b "" namingContexts defaultNamingContext dnsHostName
```
**期望**：要么返回 namingContexts（匿名可读根 DSE），要么 `result: 50 Insufficient access`（匿名被拒）。
**判据**：**两种都是结论**——匿名可读就把命名上下文写进证据；被拒就记「匿名绑定关闭」，别重试。

### 3. 已认证：域对象清单（用户/组/计算机/信任）
```bash
ldapdomaindump -u '<域名>\<域账号>' -p '<口令>' -at SIMPLE -o /tmp/ldd -n <已裁决地址> <已裁决地址>
```
**期望**：`Bind OK` + `Domain dump finished`，`/tmp/ldd/` 下生成 `domain_users.json` / `domain_groups.json` /
`domain_computers.json` 等。
**判据**：用户/组/计算机三类计数必须落到产出里；**计数为 0 是一个结论**（权限不够或该域为空），
不要当成「工具坏了」。
> **`-at SIMPLE` 不是可选项**：该工具默认走 NTLM，而不少目标（含 Samba 实现与开了强认证的域）
> 会直接掐断 NTLM 的 LDAP 绑定，报 `LDAPSessionTerminatedByServerError`——换成 SIMPLE 立刻通
> （2026-10-06 实测：同一目标默认参数失败、加 `-at SIMPLE` 成功）。目标强制 TLS 时改用 LDAPS。

### 3b. 已认证：用户/组普查（走 RPC，不依赖 LDAP）
```bash
rpcclient -U '<域名>\<域账号>%<口令>' <已裁决地址> -c 'enumdomusers;enumdomgroups;netshareenumall'
```
**期望**：`user:[<名>] rid:[0x…]` 与 `group:[…]` 逐行。
**判据**：RID 要一起记（RID 500/512/519 这些是特权侧的判据）；与第 3 步的计数交叉核对，
两边差得多说明一方被权限截断。

> **为什么两条都留着**：LDAP 面可能被策略掐断（NTLM/简单绑定），RPC 面可能被 SMB 加固掐断；
> 两条路互为备份，哪条通就用哪条的计数，并把「另一条为什么不通」写进产出。

### 4. 已认证：BloodHound 收集（把关系图落成文件）
```bash
bloodhound-python -d <域名> -u '<域账号>' -p '<口令>' -ns <已裁决地址> --auth-method kerberos -c All --zip -op /tmp/bh
```
**期望**：`/tmp/bh/*.json` + 一个 zip；输出里会打印每类节点的计数。
**判据**：节点/边计数写进产出；**图分析本身不在这一步**（谁到 Domain Admin 的最短路属于判断，交威胁建模/漏洞分析）。
> **Kerberos 要名字，不只是地址**：这条命令会去连 `<域控主机名>.<域名>:88`，而容器里的 DNS 是宿主的、
> 不解析域内名字（实测报 `Connection error (dc1.lab.local:88) Name or service not known`）。
> 处理：确认地址已裁决后，在容器内临时补一条解析（`echo '<地址> <域控主机名>.<域名>' >> /etc/hosts`，
> 容器一次性、`--rm` 即弃），或用 `--auth-method ntlm`（目标若拒 NTLM 则此路不通——见第 3 步的说明）。
> 不要为此改 `/etc/resolv.conf`。

### 5. 已认证：把「攻击面候选」用 LDAP 过滤出来（只读查询，不请求票据）
```bash
ldapsearch -x -H ldap://<已裁决地址> -D '<域账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(&(objectCategory=person)(objectClass=user)(servicePrincipalName=*))' sAMAccountName servicePrincipalName
ldapsearch -x -H ldap://<已裁决地址> -D '<域账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(userAccountControl:1.2.840.113556.1.4.803:=4194304)' sAMAccountName
ldapsearch -x -H ldap://<已裁决地址> -D '<域账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(|(msDS-AllowedToDelegateTo=*)(msDS-AllowedToActOnBehalfOfOtherIdentity=*))' sAMAccountName msDS-AllowedToDelegateTo
```
**期望**：SPN 账号清单、不要求预认证的账号（`DONT_REQ_PREAUTH`=4194304）、委派配置项。
**判据**：三类都只产出**候选清单**——「有 SPN」只说明可尝试 Kerberoast，「不要求预认证」只说明可尝试 AS-REP，
**都不等于已证实可利用**；证实在 `vuln-ad-checks`，利用要人类放行。

### 6. 已认证：ADCS（证书服务）是否存在与模板清单
```bash
certipy find -u '<域账号>@<域名>' -p '<口令>' -dc-ip <已裁决地址> -stdout
```
**期望**：存在 CA 时会打印 CA 信息与模板表；不存在时明确报没有 CA。
**判据**：拿到模板表 → 把与「注册权限/模板 EKU/SAN 可写」相关的行作为线索转给 `vuln-ad-checks`。
**本条不判定 ESC、不申请证书**。

### 7. 已认证：AD 里的 DNS 记录（容易被忽略的资产源）
```bash
adidnsdump -u '<域名>\<域账号>' -p '<口令>' <已裁决地址> -r
```
**期望**：A/CNAME 记录列表（含动态注册的主机名）。
**判据**：新出现的名字要么进资产表，要么明确标注「记录存在但主机未确认存活」。

### 8. 已认证：用户名枚举（**这一步不试口令**）
```bash
kerbrute userenum -d <域名> --dc <已裁决地址> /usr/share/wordlists/top-usernames.txt
```
**期望**：逐行 `VALID USERNAME` / `invalid username`，末尾给计数。
**判据**：**只枚举、不喷洒**。`kerbrute passwordspray` 属爆破类，本技能不使用；要试口令必须走
`exploit-auth-testing` 的纪律（单账号 ≤5 次、间隔 ≥1s、人类逐条放行）。

### 9. 服务面：域控与域成员对外的端口
```bash
nmap -Pn -p 53,88,135,139,389,445,464,593,636,3268,3269,5985,5986,3389 <已裁决地址>
```
**期望**：Kerberos(88)/LDAP(389,636,3268,3269)/SMB(445)/WinRM(5985)/RDP(3389) 哪些 open。
**判据**：把 open 的端口与「哪一类后续动作因此可行」写在一起（如 5985 open ⇒ WinRM 面存在，evil-winrm 才有的打）。

## 判读与去噪
- **域信息与主机信息是两层**：`enum4linux-ng` 的「域」结论来自 SMB/LDAP 应答，可能因目标是非 DC 的成员机而缺失；
  没有域信息不等于「不是 AD 环境」。
- **LDAP 的 1000 条上限**：默认 `ldapsearch` 会截断到 1000 条，大域要分页（`-E pr=500/noprompt`）或改用
  `ldapdomaindump`（它自己分页）。把「截断了」写进产出，别把 1000 条当全量。
- **计数要交叉核对**：`ldapdomaindump` 与 `bloodhound-python` 对同一域的用户数应当接近；差得多说明权限/分页有问题，
  先解决这个再往下走。
- **时间**：所有 Kerberos 结论都要先确认时钟偏差在 5 分钟内，否则失败原因全是假的。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| `LDAPSessionTerminatedByServerError` / `Strong(er) authentication required` | 目标拒绝**非 TLS 的简单绑定**，或拒绝 **NTLM** 的 LDAP 绑定 | 二选一：工具换认证方式（`ldapdomaindump -at SIMPLE`）、或走 LDAPS/签名；**这是目标策略事实，写进产出**，不要当成凭据错 |
| `KRB_AP_ERR_INAPP_CKSUM` / `Kerberos SessionError` | Kerberos 校验和与某些 KDC 实现（含 Samba）互操作不合 | 换认证方式（LDAP 面用 SIMPLE、SMB 面用 NTLM/口令）；把「哪条路走通」写进产出，别把工具报错当目标结论 |
| `Connection error (<域控主机名>.<域名>:88) Name or service not known` | 容器 DNS 是宿主的，不解析域内名字；而 Kerberos 必须用名字 | 容器内临时补 hosts 解析（见第 4 步）；不要改 `/etc/resolv.conf` |
| `KRB_AP_ERR_SKEW` / `Clock skew too great` | 容器与域控时钟差 >5 分钟 | 先比对 `date -u` 与域控时间，把偏差记为环境事实；条件允许时以人类放行的一次校时解决 |
| `ldap_sasl_bind(SIMPLE): Can't contact LDAP server` | 端口没开 / 目标不是 DC / 被过滤 | 回到第 9 步确认端口；不要换协议硬试 |
| 工具的判读与 LDAP 实测**不一致** | 工具自己的解析/版本差异（实测：`userAccountControl` 查询显示 `4260352`（含 0x400000），而某工具仍报「未设 DONT_REQ_PREAUTH」） | **以 LDAP 原始查询为准**，把冲突作为未决线索写进产出，不要二选一了事 |

## 不做的事
- 不写域：不建/改用户、组、GPO、DNS 记录（本技能全程只读）。
- 不请求票据（roast）、不申请证书、不中继、不横向——那是验证/利用阶段，且**免批**（命令原文不再经人过目）。
- 不做口令喷洒与爆破（`kerbrute` 只用来枚举用户名）。
- 不投载荷、不留后门、不改目标配置。

## 产出（交给下一步）
- **域画像**：域名、NetBIOS、功能级别（拿得到就写）、域控地址与 SMB 签名要求、匿名 LDAP 是否可读。
- **对象清单**：用户/组/计算机计数与关键条目（Domain Admins 等特权组成员）。
- **候选线索**（标为线索，不是结论）：有 SPN 的账号、不要求预认证的账号、委派配置、ADCS CA 与模板。
- **覆盖率与未测项**：哪些步骤因权限/时间/端口没做，以及原因。

## 参考
- PTES：Intelligence Gathering；MITRE ATT&CK：T1087.002（账户发现）、T1069.002（权限组发现）、T1482（域信任发现）、T1201（口令策略发现）、T1649（证书滥用）。
- Microsoft：Active Directory 架构与 LDAP 查询语法；Samba 官方文档（`samba-tool`、域控部署）。
- 覆盖核对（只用来比对条目是否漏，不取文本）：社区 AD 技能包对 AD 面的常见拆分是「recon / ADCS-PKI / attack-classes / methodology」四块；本文件与 `vuln-ad-checks` 覆盖前两块。
