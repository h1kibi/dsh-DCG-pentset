---
name: vuln-ad-checks
description: 把 AD 域面清点出的线索核验成有证据的判定（Kerberoast/AS-REP/委派/ADCS/签名口），不做利用
whenToUse: 漏洞分析阶段；recon-ad-surface 已产出候选线索（有 SPN 的账号、不要求预认证、委派配置、ADCS 模板、口令策略）；需要判断哪些线索真的成立
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [MITRE ATT&CK T1558.003 / T1558.004 / T1649 / T1557, Microsoft AD 安全最佳实践, certipy 与 Impacket 官方文档, PTES 漏洞分析]
  smoked: "沙箱实测@b9d9011f8331：对实验室 Samba AD DC（域 LAB.LOCAL）逐块跑：①口令策略通过（lockoutThreshold=0、minPwdLength=7、pwdProperties=0）④委派判定通过（无约束 524288 命中 1 条、约束委派与 RBCD 各 0 条）⑥SMB 签名通过（Message signing enabled and required ⇒ 中继面不成立）⑦共享清单通过（smbmap 与 smbclient -L 都列出 sysvol/netlogon/IPC$）⑧rpcclient 通过（enumdomusers/enumdomgroups/netshareenumall 逐行带 RID）⑨LAPS 查询通过（0 条 ⇒ 只说明读不到，不是「未部署」）。未通过（原因逐条写进常见失败）：②Kerberoast 与 ⑤certipy 报 KRB_AP_ERR_INAPP_CKSUM（Samba KDC 互操作）；③AS-REP 报未设 UF_DONT_REQUIRE_PREAUTH，而 LDAP 实测 userAccountControl=4260352 含 0x400000——已在文中写「以 LDAP 为准」"
---

# AD 线索核验（vuln-ad-checks）

## 适用场景
- 漏洞分析阶段，**输入是 `recon-ad-surface` 产出的线索清单**：有 SPN 的账号、`DONT_REQ_PREAUTH` 账号、
  委派配置、ADCS 的 CA 与模板、SMB 签名情况、共享可读面。
- 本条的目标是「把线索变成**有证据、可判定**的结论」，不是「拿下域控」。利用在 `exploit-*`，且**免批**（命令原文不再经人过目）。

## 前提与边界
- **每条命令都经 `pentest_exec`（`direct_command` ⇒ 类别 `exploit_validation`）逐条人工放行**。
  所以命令要一条一个目的：一次请求一张票据、一次只读一个共享，别批量。
- **哈希不在沙箱里破解**：本技能最多产出「可离线破解」这一**条件成立**的证据（一张 TGS / 一张 AS-REP）。
  破解本身交人类在专用机器上做（`hashcat` 那类吃 GPU 的活，见提示词纪律）。
- **试口令之前必须先读锁定阈值**（步骤 1）。阈值非 0 时，纯属自找锁号——那不是「运气不好」，是流程错。
  无论阈值如何，口令尝试的纪律是：单账号 ≤5 次、间隔 ≥1s、人类逐条放行（与 `exploit-auth-testing` 同一套）。
- Kerberos 结论都以时钟偏差 <5 分钟为前提（先看 `KRB_AP_ERR_SKEW`，别把它当凭据问题）。
- 本技能**不写域**、不申请证书、不中继、不横向。

## 步骤

### 1. 先读口令策略与锁定阈值（**决定后面能不能试口令**）
```bash
ldapsearch -x -H ldap://<已裁决地址> -D '<账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(objectClass=domainDNS)' pwdProperties lockoutThreshold lockoutDuration maxPwdAge minPwdLength
```
**期望**：`lockoutThreshold` / `lockoutDuration` / `minPwdLength` 的数值。
**判据**：`lockoutThreshold: 0` = 不锁定（才允许小规模试口令）；非 0 时把阈值写进结论，并把它作为
「任何口令尝试的硬上限」——超过阈值的人为失误要如实写进报告，而不是悄悄继续。

### 2. Kerberoast 可行性（最小验证：**一个账号一张票**）
```bash
GetUserSPNs.py <域名>/<账号>:<口令> -dc-ip <已裁决地址> -request-user <线索里的 SPN 账号> -outputfile /tmp/spn.hash
```
**期望**：输出一行 `$krb5tgs$23$...`（或 `$krb5tgs$18$...`，取决于加密类型）并写入 `/tmp/spn.hash`。
**判据**：拿到 TGS ⇒ 「该账号的服务票可被离线破解」这一**条件**成立，写进结论并附哈希前 32 字符与算法 ID。
**不批量**：`--request`（请求全部 SPN 账号）属批量动作，要人类明确放行才做，且要说明为什么需要。
> **脚本名以镜像里实际存在的为准**：pip 版 impacket 的脚本**不带 `impacket-` 前缀**（`GetUserSPNs.py`、
> `GetNPUsers.py`、`secretsdump.py`）；apt 的 `python3-impacket` 只提供带前缀的一部分
> （`impacket-smbclient` 等）。实测：写 `impacket-GetUserSPNs.py` 直接 `No such file or directory`。
> 该域若与 Kerberos 校验和互操作不合（见「常见失败」），本步会报 `KRB_AP_ERR_INAPP_CKSUM`——
> 那时把「哪一种认证路径可用」写进产出，不要把它当成「Kerberoast 不可行」。

### 3. AS-REP roast 可行性（**一个账号一次**）
```bash
GetNPUsers.py <域名>/<线索里的不要求预认证账号> -dc-ip <已裁决地址> -no-pass -request -outputfile /tmp/asrep.hash
```
**期望**：`$krb5asrep$23$...` 一行 + 文件。
**判据**：拿到 AS-REP ⇒ 该账号不要求预认证且可离线尝试，写进结论。**注意**：这一步**不需要口令**，
因此在报告里要写清「无需凭据即可触发」——这是它的风险等级比 Kerberoast 更高的原因。
> **先确认那个位真的设了**：用 LDAP 原始查询核对 `userAccountControl` 是否含 `4194304`（0x400000）。
> 实测踩到过：LDAP 查询显示 `4260352`（含该位），而本工具仍报「doesn't have UF_DONT_REQUIRE_PREAUTH set」——
> **以 LDAP 实测为准**，把工具与实测的冲突作为未决线索写进产出（工具版本差异，不是目标事实）。

### 4. 委派判定（读配置，再与 bloodhound 的边交叉核对）
```bash
ldapsearch -x -H ldap://<已裁决地址> -D '<账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(userAccountControl:1.2.840.113556.1.4.803:=524288)' sAMAccountName
ldapsearch -x -H ldap://<已裁决地址> -D '<账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(msDS-AllowedToDelegateTo=*)' sAMAccountName msDS-AllowedToDelegateTo
ldapsearch -x -H ldap://<已裁决地址> -D '<账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(msDS-AllowedToActOnBehalfOfOtherIdentity=*)' sAMAccountName msDS-AllowedToActOnBehalfOfOtherIdentity
```
**期望**：三类各自的条目（无约束委派 524288 / 约束委派 `msDS-AllowedToDelegateTo` / 基于资源的 RBCD）。
**判据**：类型不同、成立条件不同，**不能混成一句「有委派」**：无约束委派需要能触发该主机的认证；
约束委派需要协议转换（S4U2Self/S4U2Proxy）；RBCD 需要对该对象有写权限（写权限本身就是另一个判定项）。

### 5. ADCS（ESC 判定，只读枚举）
```bash
certipy find -u '<账号>@<域名>' -p '<口令>' -dc-ip <已裁决地址> -stdout -vulnerable
```
**期望**：列出 ESC1–ESC8 中与当前配置匹配的项，以及每条对应的模板/CA 名。
**判据**：**每条 ESC 的判定依据字段必须落到结论里**——模板 EKU、是否允许请求者指定 SAN、是否需要审批、
注册权限的 ACL 对象。只说「有 ESC1」不算证据。**不申请证书**（`certipy req` 属利用）。

### 6. SMB 签名与中继面
```bash
nmap -Pn -p 445 --script smb2-security-mode,smb2-capabilities <目标地址>
```
**期望**：`Message signing enabled but not required` 或 `required`。
**判据**：`not required` ⇒ 「该主机的 SMB 认证可被中继」这一**条件**成立（中继本身是 `exploit_validation`，
逐条批，且要人类明确指定中继目标）。`required` 时本条判为不成立——**不要**为此换其它协议硬凑。

### 7. 共享与凭据暴露（**只列不拉**）
```bash
smbmap -H <目标地址> -u '<账号>' -p '<口令>'
smbclient -L <目标地址> -U '<域名>\<账号>%<口令>'
```
**期望**：共享清单 + 读写权限列（`READ, WRITE`）。
**判据**：只把**共享名与权限**写进结论；文件名值得看时另起一条命令列目录。**拉取文件内容属证据采集**，
要单独放行，且只拉与范围相关的最小样本（并在证据里写哈希，见 `exploit-evidence`）。

### 8. 会话与共享面（RPC 直查，比 nmap 的脚本可靠）
```bash
rpcclient -U '<域名>\<账号>%<口令>' <目标地址> -c 'enumdomusers;enumdomgroups;netshareenumall;netsessionenum'
```
**期望**：用户/组（带 RID）、共享、会话逐行。
**判据**：空输出是**权限不足**（不是「没有」）；把它写成「未取得」而不是「无」。
> nmap 的 `--script smb-enum-users,smb-enum-shares` 在部分实现（实测 Samba DC）上**完全没有输出**，
> 且要额外传 `--script-args smbusername=…,smbpassword=…`；`rpcclient` 在同一目标上直接可用，
> 优先用它，nmap 那条只作为备选。

### 9. LAPS 与敏感属性（只读查询，有权限才有结果）
```bash
ldapsearch -x -H ldap://<已裁决地址> -D '<账号>@<域名>' -w '<口令>' -b '<defaultNamingContext>' \
  '(ms-MCs-AdmPwdExpirationTime=*)' sAMAccountName ms-MCs-AdmPwdExpirationTime
```
**期望**：要么列出可读到 LAPS 属性的对象（说明当前账号有读权限，这本身是一条权限过大线索），要么空。
**判据**：空不能推断「没部署 LAPS」——只有读不到。别写反。

## 判读与去噪
- **哈希格式就是判据的一部分**：`$krb5tgs$23$` = RC4（更易破解）、`$krb5tgs$18$` = AES256（更慢）；
  AS-REP 同理。写结论时带上算法 ID，不要只贴一坨哈希。
- **「条件成立」≠「已利用」**：Kerberoast/AS-REP/中继/ESC 都是「这条路成立」，实际利用要单独放行并留证据。
- **脚本的「空」有两义**：无权限与真的没有。二者必须区分（看是否报错、看返回码），否则结论会假。
- LDAP 默认截断 1000 条——大域下先用 `-E pr=500/noprompt` 分页，或直接看 `ldapdomaindump` 的 json。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| `KRB_AP_ERR_INAPP_CKSUM` | Kerberos 校验和与某些 KDC 实现（含 Samba）互操作不合 | 换认证方式：LDAP 面用 SIMPLE（`ldapdomaindump -at SIMPLE`）、SMB 面用口令/NTLM；**不要**据此判定 roast 不可行 |
| `LDAPSessionTerminatedByServerError` | 目标拒绝非 TLS 的简单绑定，或拒绝 NTLM 绑定 | 换认证方式或走 LDAPS；写进产出作为目标策略事实 |
| `impacket-GetUserSPNs.py: No such file or directory` | 镜像里 pip 版脚本**不带前缀** | 用 `GetUserSPNs.py` / `GetNPUsers.py`；带前缀的只有 apt 提供的少数几个（`impacket-smbclient` 等） |
| `KDC_ERR_ETYPE_NOSUPP` | 域里禁用了 RC4，请求默认加密类型失败 | 显式用 AES：`-aes`；**不要**因此判定「Kerberoast 不可行」 |
| `KRB_AP_ERR_SKEW` | 时钟偏差 >5 分钟 | 见 `recon-ad-surface` 的同名条目；先对时再判定 |
| `STATUS_LOGON_FAILURE` + 账号随后锁定 | 试口令超过锁定阈值 | 立刻停手，把「已锁定」写进报告并通知人类；这不是可以重试的错误 |
| 工具判读与 LDAP 实测不一致 | 工具版本差异（实测：`userAccountControl=4260352` 含 0x400000，工具仍报未设该位） | **以 LDAP 原始查询为准**，冲突记为未决线索 |
| `certipy find` 报没有 CA | 该域确实没部署 ADCS | 结论就是「无 ADCS 面」，别再找替代工具硬凑 |

## 不做的事
- 不在沙箱里破解哈希（交人类；`hashcat` 有意未装）。
- 不申请证书、不滥用模板、不配置 RBCD、不中继认证、不横向移动。
- 不写域（不改用户/组/GPO/ACL/DNS）。
- 不做批量喷洒与批量取票（`--request` 全量要单独放行）。

## 产出（交给下一步）
- **判定表**：`线索 | 判定（成立/不成立/未取得） | 证据引用 | 动作类别 | 建议动作`。
- **风险说明**：每条成立项的风险逻辑（无需凭据即可触发？需要什么前置条件？影响面多大）。
- **未判定项与原因**：权限不足 / 端口不通 / 时钟偏差 / 缺工具，逐条写清，不要把未测写成无。

## 参考
- MITRE ATT&CK：T1558.003（Kerberoasting）、T1558.004（AS-REP Roasting）、T1649（证书滥用）、T1557（中间人/中继）。
- Microsoft：ADCS 模板与注册权限语义、Kerberos 加密类型与预认证。
- 工具官方文档：`certipy`（find/req 的判定字段）、Impacket（GetUserSPNs / GetNPUsers 的选项语义）。
