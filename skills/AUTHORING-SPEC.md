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

镜像里装好了：`nmap curl wget nc dig openssl jq whois ping ffuf sqlmap` + python3
（`requests` / `dnspython` / `beautifulsoup4`）+ 字典 `/usr/share/wordlists/{common.txt,raft-small-directories.txt,subdomains-5000.txt}`。

- 容器内是 **root**，有 **NET_RAW**（`nmap -sS` 可用），`/tmp` 可写可执行，根可写，`--rm` 即弃。
- **网络**：沙箱接入部署方指定的那张网；本部署 2026-10-05 起该网非 internal ⇒ **可出网**（可达范围与宿主一致，DNS 用宿主解析器）。写 skill 时别把「只能到授权目标」当成网络事实——它是**规则**（范围闸门 + 逐次放行）。
  凡需要公网的步骤（查 CVE 网站、下载模板、外部解析器、外部 whois），必须写清两件事：
  **证据纪律**（外部结果标来源；2026-10-05 起沙箱可出网，但外部资料不是目标证据）与
  **取不到时怎么办**（改用人类提供的材料 / 记忆检索 / 由人类在控制台完成）。
- 目标地址用**选择器给的已裁决地址**，不要自己解析域名。
- 宿主按行为预设限速（stealth 1/s、standard 5/s、deep 10/s）。**不要**用 `--min-rate` 之类去顶；
  被排队是预期行为，不是故障，不要重试绕过。
- 越界即中止并请人类修订范围；破坏性 / 持久化 / 数据外传类动作会被上游直接拒——技能里要写明这条边界。

## 4. 允许的验证（每个 pack 至少冒烟一次）

```bash
docker run --rm --network pentest-lab-internal --cap-drop ALL --cap-add NET_RAW \
  --security-opt no-new-privileges --pids-limit 512 --cpus 2.0 --memory 2g \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --entrypoint /bin/sh 127.0.0.1:5005/pentest-tools@sha256:a197af1d36f678eee84372309e7f08d2c81151af93915cd454fd6fa02abe4bae \
  -c "<你的命令>"
```

实验室靶标：`172.29.0.3:8000`（python http.server，只用来证明命令能跑、输出形态对）。**别打别的地址**。

## 5. 交付

- 只新增 `skills/**` 下的文件；**不改任何源码**；不跑仓库测试 / lint / build。
- 报告：写了哪些文件；冒烟了哪些命令（贴原样输出）；哪些命令没能验证及原因。
