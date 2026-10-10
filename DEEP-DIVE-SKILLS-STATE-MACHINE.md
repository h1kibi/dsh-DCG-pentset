# dsh-pentest 深度剖析：技能系统 & 状态机

**完整版本 0.1.18** | 稳定于 dsh 0.1.5-rc.2

---

## 核心认知

这个项目用两套机制把渗透测试从"自动化脚本"变成"人驾驶 Agent 协作"：

1. **技能系统**:把方法论变成**可验证的过程**——每条命令都在真沙箱里跑过，判据可判定，证据留痕
2. **状态机**:把工作流从"线性流水线"变成**循环编排**——五个阶段可循环/回环，每次转移都有人工决策点

---

# 第一部分：技能系统

## 1. 系统定位

### 技能 ≠ 工具

| 工具 | 技能 |
|---|---|
| **可做什么** | **怎么做** |
| nmap、ffuf、sqlmap（二进制）| 「网络面清点的正确姿态」（用什么参数、怎么判结果） |
| 权限边界 | 方法论、流程、经验 |
| 由沙箱声明 | 由人编写、社区维护 |
| 工具本身不变 | 技能随理解深化而迭代 |

### 技能属于哪个阶段？

```
┌─────────────────────────────────────────────────────────┐
│ 情报收集                                               │
│ (Intelligence Gathering)                               │
│ ├─ recon-network-surface (nmap 扫描)                   │
│ ├─ recon-dns-cert (DNS 枚举)                           │
│ ├─ recon-web-surface (Web 爬取)                        │
│ ├─ internal-discovery (内网扫描)                       │
│ └─ recon-ad-surface (AD 侦察)                          │
│                                                        │
├─────────────────────────────────────────────────────────┤
│ 威胁建模                                               │
│ (Threat Modeling)                                      │
│ ├─ model-trust-boundaries (边界推导)                   │
│ ├─ model-attack-paths (路径枚举)                       │
│ ├─ model-attack-trees (树形决策)                       │
│ ├─ asset-graph (资产关系)                              │
│ └─ business-impact (业务影响)                          │
│                                                        │
├─────────────────────────────────────────────────────────┤
│ 漏洞分析                                               │
│ (Vulnerability Analysis)                              │
│ ├─ vuln-web-injection (Web 注入类)                     │
│ ├─ vuln-auth-bypass (认证绕过)                         │
│ ├─ vuln-api-broken (API 缺陷)                          │
│ ├─ vuln-cloud-config (云配置)                          │
│ └─ ...                                                 │
│                                                        │
├─────────────────────────────────────────────────────────┤
│ 利用验证                                               │
│ (Exploitation)                                         │
│ ├─ exploit-validate-web (Web 利用证明)                 │
│ ├─ exploit-validate-net (网络层)                       │
│ ├─ exploit-validate-creds (凭证利用)                   │
│ └─ ...                                                 │
│                                                        │
├─────────────────────────────────────────────────────────┤
│ 后渗透                                                 │
│ (Post-Exploitation)                                    │
│ ├─ lateral-move-creds (凭证横移)                       │
│ ├─ lateral-move-delegation (委派横移)                  │
│ ├─ persist-backdoor (后门植入——操作员禁用)             │
│ └─ ...                                                 │
└─────────────────────────────────────────────────────────┘
```

**当前已实现：25 个技能**，覆盖 5 阶段的关键动作。

---

## 2. 技能生命周期

### 2.1 撰写阶段（文件层）

**目录结构：**

```
skills/
├── AUTHORING-SPEC.md          # ← 撰写规范（法律）
├── README.md                   # ← 快速索引
├── recon-network-surface/      # ← 一个技能一个目录
│   ├── SKILL.md                # ← 主文件（必须）
│   └── references/             # ← 可选的参考文档（但 Agent 看不到）
├── recon-dns-cert/
│   └── SKILL.md
└── ... (23 more)
```

**单个技能的内部结构（SKILL.md）：**

```markdown
---
name: recon-network-surface
description: 用沙箱里的真 nmap 做网络面清点
whenToUse: 情报收集阶段；需要确定目标开放端口与服务版本时
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, Nmap 官方文档]
  smoked: "沙箱实测@5ee076:6 块原文配方逐条实跑..."
---

# 网络面清点(recon-network-surface)

## 适用场景
...

## 前提与边界
...

## 步骤

### 1. SYN 扫描（全连接端口）
\`\`\`bash
nmap -sS -Pn -p 8080 -oN /tmp/alive.txt 172.29.0.2
\`\`\`
**期望：** 1s 内完成，输出包含 `Host is up` 和开放端口列表
**判据：** `grep "Host is up" /tmp/alive.txt && grep "open" /tmp/alive.txt`

### 2. 服务版本识别
...

## 判读与去噪
（如何排除假阳性）

## 常见失败
| 现象 | 真实原因 | 处置 |
| --- | --- | --- |

## 不做的事
- 不做漏洞利用
- 不扫范围外主机
- ...

## 产出(交给下一步)
- 资产/服务条目：地址:端口、协议、产品与版本
- 覆盖说明：扫了哪些端口
- 未决线索：可疑但未证实的服务

## 参考
- PTES: Intelligence Gathering - Network Survey
- Nmap: https://...
```

**撰写纪律（硬要求）：**

| 项 | 要求 | 为什么 |
|---|---|---|
| **命令真实性** | 每条 bash 块都在沙箱里跑过（标注 smoked: 摘要） | 保证不是"看起来对"的幻想 |
| **判据可判定** | 用 grep/jq/awk，不写"视情况而定" | 自动化 Agent 才能执行 |
| **容器一次性** | bash 块内所有中间产物写到 /tmp，跨块用 `&&` 合并 | 真实执行是 `docker run --rm` |
| **原创内容** | 可引用方法论名字（PTES、MITRE ATT&CK），不整段照抄 | 法律责任 + 能表达你的理解 |
| **不超 300 行** | 包括代码、表格、参考 | 可读性 + Agent token 预算 |

---

### 2.2 注册阶段（代码层）

**文件：`src/skills/skill-pack.ts`**

```typescript
export const SKILL_PACKS = {
  'intelligence-gathering': [
    'recon-network-surface',
    'recon-web-surface',
    'recon-dns-cert',
    'internal-discovery',
    'recon-ad-surface',
  ],
  'threat-modeling': [
    'model-trust-boundaries',
    'model-attack-paths',
    'model-attack-trees',
    'asset-graph',
    'business-impact',
  ],
  'vulnerability-analysis': [
    'vuln-web-injection',
    'vuln-auth-bypass',
    'vuln-api-broken',
    'vuln-cloud-config',
    'vuln-creds-weak',
    'vuln-ad-dcsync',
    'vuln-app-rce',
  ],
  'exploitation': [
    'exploit-validate-web',
    'exploit-validate-net',
    'exploit-validate-creds',
  ],
  'post-exploitation': [
    'lateral-move-creds',
    'lateral-move-delegation',
    'enum-lateral-scope',
  ],
} as const;
```

**这就是单一事实源**：哪个 Phase 加载哪些 Skill？看这个。

---

### 2.3 冻结阶段（Session 创建时）

**发生在：** Worker Agent 会话创建时（`insertWorkerSession()`）

**做什么：**

```typescript
// src/workflow/core.ts
async insertWorkerSession(engagementId, agentName, skillIds) {
  // 1. 从库里读取所有技能内容
  const skills = await db.query(
    `SELECT name, revision, content_hash FROM skills WHERE id = ANY($1)`,
    [skillIds]
  );

  // 2. 冻结快照：name + revision + content_hash
  const skillFreeze = skills.map(s => ({
    name: s.name,
    revision: s.revision,
    contentHash: s.content_hash,
  }));

  // 3. 写入 worker_sessions.skill_freeze 列
  await db.query(
    `INSERT INTO worker_sessions (..., skill_freeze) VALUES (..., $1)`,
    [JSON.stringify(skillFreeze)]
  );
}
```

**为什么要冻结？**

真实事件（2026-10-05）：技能 A 在执行过程中被人编辑了，Agent 拿到新版本的提示词，执行逻辑对不上了。

**冻结的作用：** 一旦会话开始，技能的**内容、版本、哈希**全部钉死，即使库里后来改了，这个会话用的还是当时的版本。

---

### 2.4 加载阶段（执行时）

**发生在：** Agent 执行 `skill_load` 工具时

**代码路径：** `src/memory/pg-worker-tools.ts:loadSkill()`

```typescript
async loadSkill(skillName: string) {
  // 1. 检查：这个会话是否有权限加载这个 skill？
  const frozen = session.skillFreeze.find(s => s.name === skillName);
  if (!frozen) {
    throw new Error(`Skill '${skillName}' not in this session's pack`);
  }

  // 2. 从库里读最新版本
  const latest = await db.query(
    `SELECT content, revision, content_hash FROM skills WHERE name = $1`,
    [skillName]
  );

  // 3. 对比：内容有没有漂移？
  if (latest.content_hash !== frozen.contentHash) {
    throw new Error(
      `Skill '${skillName}' content changed after session created. ` +
      `Expected hash ${frozen.contentHash}, got ${latest.content_hash}`
    );
  }

  // 4. 安全：返回完整内容给 Agent
  return {
    name: skillName,
    content: latest.content,
    revision: latest.revision,
  };
}
```

**流程图：**

```
┌─────────────────┐
│ Agent 执行中    │
│ skill_load(foo) │
└────────┬────────┘
         │
         ↓
    ┌────────────────────────────────┐
    │ 1. 检查权限                    │
    │    frozen = skillFreeze.find   │
    │    freeze 里有 foo 吗？        │
    └────────┬───────────────────────┘
             │ NO → 错误
             │ YES ↓
    ┌────────────────────────────────┐
    │ 2. 读最新版本                  │
    │    SELECT ... FROM skills      │
    └────────┬───────────────────────┘
             │ ↓
    ┌────────────────────────────────┐
    │ 3. 对比哈希                    │
    │    latest.hash == frozen.hash? │
    └────────┬───────────────────────┘
             │ NO → 错误（内容漂移）
             │ YES ↓
    ┌────────────────────────────────┐
    │ 4. 返回内容                    │
    │    Agent 加入 system prompt    │
    └────────────────────────────────┘
```

---

## 3. 实际例子：recon-network-surface 技能

完整文件：`skills/recon-network-surface/SKILL.md`

**关键部分：**

### 步骤 1：存活探测（TCP SYN）

```bash
nmap -sS -Pn -p 8080 -oN /tmp/alive.txt 172.29.0.2
```

**期望：** 输出 `Host is up`，列出开放端口
**判据：** 文件存在且包含"open"

### 步骤 2：版本识别

```bash
nmap -sV --version-light -p 8080 /tmp/alive.txt | \
  grep -E "^[0-9]+/tcp" > /tmp/versions.txt
```

**期望：** 服务名与版本（如 "Apache/2.4.41"）
**判据：** 版本字段非"unknown"

### 步骤 3：ARP 扫描（内网）

```bash
arp-scan -I eth0 172.29.0.0/16 | \
  awk '$0 !~ /^Bytes:|^Starting|^Interface/ {print $1, $3}' > /tmp/mac_map.txt
```

**期望：** IP 到 MAC 的映射
**判据：** 行数 > 0

### 常见失败表格

| 现象 | 真实原因 | 处置 |
|---|---|---|
| 全部超时、0 hosts up | 目标没接进 `internalNetwork` | 报告「目标不可达」，请人类确认 |
| `-sS` 报 requires root | 容器没跑在 root | 改用 `-sT` 继续 |
| 结果比真实面少 | 范围只声明了部分端口 | 把缺口写进报告，请人决定扩范围 |

---

## 4. 技能的质量把关

### 4.1 撰写时（test/skill-pack.test.ts）

```typescript
// ✓ 检查格式
- frontmatter 完整（name, description, whenToUse, metadata）
- 8 个小节顺序正确
- 不超 300 行
- LF 线尾

// ✓ 检查安全
- bash 块里只用 SANDBOX_TOOL_GROUPS 里声明的工具
- 不引用跨阶段技能
- /tmp 依赖清楚标注

// ✓ 检查冒烟
- metadata.smoked 字段绑定到镜像摘要
- 如果摘要和当前不符 → 红灯，必须重跑命令
```

### 4.2 会话时（加载检查）

```typescript
// ✓ 权限检查
- 这个会话有没有权限加载这个 skill？

// ✓ 内容检查
- 哈希对不对？

// ✓ 版本检查
- revision 记录了没有？
```

---

# 第二部分：状态机

## 1. 核心架构：两层状态模型

### 1.1 第一层：MainStatus（8 个位置）

```
auth_pending
    ↓
 ready
    ↓
 worker_running  ←→ waiting_human_review  ←→  report_ready  →  complete
    ↓                     ↓
 waiting_human_review   handoff_drafting
                             ↓
                      transition_confirmation
```

每个 Status 的含义：

| 位置 | 含义 | 允许的人工动作 |
|---|---|---|
| `auth_pending` | 等待授权与范围确认 | confirm_scope、reject |
| `ready` | 已授权，等待启动 Agent | start_worker |
| `worker_running` | Agent 正在执行 | pause、interject、ask_human_review |
| `waiting_human_review` | Agent 报结果，等待人决策 | **retry**、**advance**、**rollback**、**loop**、**end_testing** |
| `handoff_drafting` | Agent 起草下一阶段交接 | 无（编辑交接草稿用户界面） |
| `transition_confirmation` | 人确认交接内容后 | 无（仅确认转移） |
| `report_ready` | 全阶段完成，报告已生成 | sign_report、export |
| `complete` | 工作已结束 | 无 |

### 1.2 第二层：RunMarker（正交的执行标记，5 个值）

```
running    → paused     (Agent 暂停)
  ↓            ↓
running    ← paused     (恢复)

running/paused → blocked      (等待人工决策)
                    ↓
                running/paused (继续)

running/paused → aborted      (人中止)
                    ↓
                complete

running → failed       (异常终止)
    ↓
waiting_human_review (人看看哪里出的问题)
```

**两层独立：** 一个作业可以是 `(status=worker_running, marker=paused)`——Agent 暂停了，但还没报结果。

---

## 2. 五个阶段的执行流

### 2.1 阶段定义（Phase Definitions）

**文件：`src/workflow/phases.ts`**

```typescript
export const PHASE_DEFINITIONS = {
  'intelligence-gathering': {
    ordinal: 0,
    displayName: '情报收集',
    agentName: 'pentest-intelligence-agent',
    deliverables: [
      '资产清单（IP、域名、主机）',
      '开放端口与服务版本',
      'Web 面爬虫结果',
      'DNS 记录与证书信息',
    ],
    exitCriteria: [
      '覆盖声明：扫了哪些范围',
      '未决项：可疑但未证实的发现',
      '下一阶段所需的信息是否完整',
    ],
  },

  'threat-modeling': {
    ordinal: 1,
    displayName: '威胁建模',
    agentName: 'pentest-threat-agent',
    deliverables: [
      '信任边界图（Stride）',
      '攻击路径枚举',
      '业务影响评估',
    ],
    exitCriteria: [
      '威胁模型是否覆盖全资产',
      '是否需要补充情报',
    ],
  },

  'vulnerability-analysis': {
    ordinal: 2,
    displayName: '漏洞分析',
    agentName: 'pentest-vuln-agent',
    deliverables: [
      '发现清单（CVE、弱点）',
      '利用前提条件',
      '风险评级',
    ],
    exitCriteria: [
      '发现数量、质量',
      '是否需要补充侦察',
    ],
  },

  'exploitation': {
    ordinal: 3,
    displayName: '利用验证',
    agentName: 'pentest-exploit-agent',
    deliverables: [
      '利用成功的证明（权限级、时间戳）',
      '防御绕过的证据',
    ],
    exitCriteria: [
      '是否已达到目标',
      '是否转向横移',
    ],
  },

  'post-exploitation': {
    ordinal: 4,
    displayName: '后渗透',
    agentName: 'pentest-lateral-agent',
    deliverables: [
      '横移路径记录',
      '持久化（如适用）',
    ],
    exitCriteria: [
      '是否已覆盖所有关键资产',
    ],
  },
} as const;
```

---

### 2.2 推荐的转移边（RECOMMENDED_MOVES）

```typescript
export const RECOMMENDED_MOVES = {
  'intelligence-gathering': [
    { to: 'threat-modeling', kind: 'advance', default: true },
    { to: 'intelligence-gathering', kind: 'retry', default: false },
  ],

  'threat-modeling': [
    { to: 'vulnerability-analysis', kind: 'advance', default: true },
    { to: 'intelligence-gathering', kind: 'rollback', default: false },
    { to: 'threat-modeling', kind: 'retry', default: false },
  ],

  'vulnerability-analysis': [
    { to: 'exploitation', kind: 'advance', default: true },
    { to: 'threat-modeling', kind: 'rollback', default: false },
    { to: 'vulnerability-analysis', kind: 'retry', default: false },
    { to: 'intelligence-gathering', kind: 'loop', default: false },  // ← 新发现需补侦察
  ],

  'exploitation': [
    { to: 'post-exploitation', kind: 'advance', default: true },
    { to: 'vulnerability-analysis', kind: 'rollback', default: false },
    { to: 'exploitation', kind: 'retry', default: false },
    { to: 'intelligence-gathering', kind: 'loop', default: false },  // ← 发现内网入口
  ],

  'post-exploitation': [
    { to: 'complete', kind: 'end_testing', default: true },
    { to: 'exploitation', kind: 'rollback', default: false },
    { to: 'post-exploitation', kind: 'retry', default: false },
    { to: 'intelligence-gathering', kind: 'loop', default: false },  // ← 循环扩展范围
  ],
};
```

**转移类型的含义：**

| 类型 | 动作 | 迭代 | 范围 | 会话 |
|---|---|---|---|---|
| `advance` | 正常推进到下一阶段 | +1 | 不变 | 新建 |
| `retry` | 重做当前阶段 | 不变 | 不变 | 重用或新建（由人决定） |
| `rollback` | 回到上一阶段 | -1 | 缩小或不变 | 新建 |
| `loop` | 回到早期阶段（扩范围） | +1 | 扩大 | 新建 |
| `end_testing` | 终止测试 | 不变 | 不变 | 无 |

---

## 3. 状态转移的完整流程

### 3.1 转移表（Transition Dispatch Table）

**文件：`src/workflow/transition-table.ts`**

```typescript
export const TRANSITION_DISPATCH = {
  'session_start': {
    fromStatus: ['ready'],
    toStatus: 'worker_running',
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: false,
    sessionReuse: null,
  },

  'worker_result_ready': {
    fromStatus: ['worker_running'],
    toStatus: 'waiting_human_review',
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: true,
    sessionReuse: null,
  },

  'human_retry_same_session': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'worker_running',
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: false,
    sessionReuse: true,  // ← 重用当前会话
  },

  'human_retry_new_session': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'worker_running',
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: false,
    sessionReuse: false,  // ← 新建会话
  },

  'human_advance': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'handoff_drafting',
    iterationDelta: +1,
    scopeDelta: 0,
    handoffRecorded: true,
    sessionReuse: null,
  },

  'human_rollback': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'handoff_drafting',
    iterationDelta: -1,
    scopeDelta: 0,
    handoffRecorded: true,
    sessionReuse: null,
  },

  'human_loop': {  // ← 关键：发现新范围后重新侦察
    fromStatus: ['waiting_human_review'],
    toStatus: 'handoff_drafting',
    iterationDelta: +1,  // ← 迭代递进
    scopeDelta: +1,      // ← 范围扩大
    handoffRecorded: true,
    sessionReuse: null,
  },

  'handoff_confirmed': {
    fromStatus: ['transition_confirmation'],
    toStatus: 'ready',   // ← 回到 ready，等待启动下一 Agent
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: false,
    sessionReuse: null,
  },

  'end_testing': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'report_ready',
    iterationDelta: 0,
    scopeDelta: 0,
    handoffRecorded: false,
    sessionReuse: null,
  },

  // ... 还有 6 个
};
```

---

### 3.2 转移的执行流程

```
人类决策
    ↓
    ├─ retry (same session)
    │  └─ recordDecision()
    │     └─ recordPlannedTransition('human_retry_same_session')
    │        └─ UPDATE engagements SET status='worker_running', run_marker='running'
    │           UPDATE state_transitions ADD row
    │           UPDATE worker_sessions SET active=true
    │
    ├─ advance
    │  └─ recordDecision()
    │     └─ freezeHandoff()
    │        └─ UPDATE handoff_flow WITH next phase data
    │     └─ recordPlannedTransition('human_advance')
    │        └─ UPDATE engagements SET status='handoff_drafting', iteration+=1
    │           UPDATE state_transitions ADD row
    │           COMMIT
    │     └─ dsh.createWorkerSession() [新会话]
    │
    └─ rollback
       └─ recordDecision()
          └─ freezeHandoff()
             └─ UPDATE handoff_flow WITH rollback data
          └─ recordPlannedTransition('human_rollback')
             └─ UPDATE engagements SET status='handoff_drafting', iteration-=1
                UPDATE state_transitions ADD row
                COMMIT
          └─ dsh.createWorkerSession() [新会话]
```

---

## 4. Loop（循环）的特殊处理

### 4.1 Loop vs Advance

```
Advance:      Phase 0 → Phase 1    (线性推进)
              iteration: 1 → 2
              scope: no change

Loop:         Phase 3 → Phase 0    (回到早期，扩范围重新侦察)
              iteration: 2 → 3
              scope: +1 (version_id++)
```

### 4.2 Loop 的驱动场景

**场景 1：漏洞分析中发现新的内网面**

```
作业阶段 2（漏洞分析）正进行中。
Agent 说："我发现了另一个 Subnet（172.30.0.0/24）"

人的决策：
├─ retry 这个阶段？ 不，发现是好的
├─ advance 到利用验证？ 不，还没覆盖完
└─ loop 回到情报收集？ 是！新范围需要系统性侦察

Action:
  recordDecision(...)
  recordPlannedTransition('human_loop')
  scope_versions.create({...new subnet declaration...})
  state_transitions.insert({from: 'Phase 2', to: 'Phase 0', type: 'loop'})
  iteration++, scope_version++

Next:
  Phase 0 Agent 启动，看到新的范围声明，从零开始扫这个子网
```

**场景 2：后渗透中发现横移目标**

```
作业阶段 4（后渗透）。
Agent 说："我看到了域管在 172.20.0.5 登录过"

人的决策：
  "这个新资产需要完整的覆盖"
  → loop 回到情报收集（新目标 172.20.0.5）

流程同上。
```

---

## 5. 完整的作业生命周期示例

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. 作业初始化                                                       │
│    status = auth_pending, marker = null                            │
│    人类选择目标范围（173.0.0.1-10, :80,:443,:8080）                │
│    点击"确认范围"                                                   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 2. 范围已确认                                                       │
│    status = ready, marker = null                                    │
│    scope_versions.create({domain: 173.0.0.1-10, ports: ...})       │
│    点击"启动情报收集"                                               │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Phase 0 Agent 执行中                                             │
│    status = worker_running, marker = running                       │
│    Agent 用 recon-network-surface 扫描 nmap                        │
│    ...输出 nmap 结果...                                             │
│    agent.startHumanReview({deliverables: {...}})                  │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 4. 等待人类决策                                                     │
│    status = waiting_human_review, marker = blocked                │
│    控制台显示：                                                     │
│    ├─ 发现 7 个开放端口                                             │
│    ├─ 所有资产已登记                                               │
│    ├─ 下一步建议：推进到威胁建模                                    │
│    人看了一眼，检查 nmap 输出正确，点击"推进到威胁建模"             │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 5. 交接起草                                                         │
│    status = handoff_drafting, marker = null                       │
│    Agent 起草给 Phase 1 (威胁建模) Agent 的摘要：                  │
│    "以下资产已清点：..."                                            │
│    iteration = 2, scope_version = 1                                │
│    人类审阅交接内容，点击"确认交接"                                 │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 6. Phase 1 Agent 启动                                               │
│    status = worker_running, marker = running                      │
│    新会话，新的 Agent（threat-modeling），加载 5 个技能             │
│    输入：Phase 0 的交接摘要 + 原始资产数据                          │
│    ...威胁建模输出...                                               │
│    agent.startHumanReview({threats: [...]})                        │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 7. 人类决策：发现新的内网面，需要补充侦察                          │
│    状态 = waiting_human_review                                     │
│    人看到威胁模型引用了 172.30.0.0/24（跳过的子网）               │
│    决策：loop 回到情报收集（不是 advance 到漏洞分析）              │
│    动作：recordPlannedTransition('human_loop')                     │
│          scope_versions.create({new subnet: 172.30.0.0/24})       │
│          iteration = 3                                              │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 8. Phase 0 Agent（第二轮）                                          │
│    新会话，但 iteration = 3, scope_version = 2                    │
│    输入：新的范围声明（172.30.0.0/24）+ 之前侦察的全部数据         │
│    Agent 用相同的技能，但只扫新范围                                 │
│    输出：新子网的资产                                               │
│    agent.startHumanReview({...})                                   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 9. 人类决策：现在可以推进到漏洞分析                                │
│    advance → Phase 2                                                │
│    iteration = 4, scope_version = 2 (不变)                        │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
        ...继续 Phase 2, 3, 4...
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ N. 测试完成                                                         │
│    status = report_ready                                            │
│    所有 state_transitions 已记录                                    │
│    所有工具输出已审计                                               │
│    人类签名报告 → complete                                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. 审计与版本管理

### 6.1 每次转移都留痕

**表结构：`state_transitions`**

```sql
CREATE TABLE state_transitions (
  id uuid,
  engagement_id uuid,
  from_phase phase,
  to_phase phase,
  transition_type transition_type,  -- 'advance', 'retry', 'loop', ...
  iteration_before int,
  iteration_after int,
  scope_version_before int,
  scope_version_after int,
  human_decision_id uuid,           -- 指向人的决策记录
  timestamp timestamptz,
  FOREIGN KEY (human_decision_id) REFERENCES human_decisions
);
```

### 6.2 每个会话都冻结住

**表结构：`worker_sessions`**

```sql
CREATE TABLE worker_sessions (
  id uuid,
  engagement_id uuid,
  phase phase,
  iteration int,                    -- 当前迭代号
  scope_version int,                -- 当前范围版本
  skill_ids uuid[],                 -- 这个会话加载的 25 个技能 ID
  skill_freeze jsonb,               -- [
                                    --   { name: 'recon-network-surface',
                                    --     revision: 42,
                                    --     contentHash: 'abc123...' },
                                    --   ...
                                    -- ]
  created_at timestamptz
);
```

---

## 7. 关键不变量

### 7.1 状态合法性

```typescript
const TERMINAL_SESSION_STATUSES = ['complete', 'aborted', 'failed'];

function isLegalStatusEdge(from: MainStatus, to: MainStatus): boolean {
  // 不能从 complete 转到任何地方
  if (from === 'complete') return false;

  // 只允许特定的转移边
  const legalEdges = {
    'auth_pending': ['ready'],
    'ready': ['worker_running'],
    'worker_running': ['waiting_human_review', 'paused'],
    'waiting_human_review': ['handoff_drafting', 'report_ready', 'worker_running'],
    'handoff_drafting': ['transition_confirmation'],
    'transition_confirmation': ['ready'],  // 回到等待启动下一 Agent
    'report_ready': ['complete'],
  };

  return legalEdges[from]?.includes(to) ?? false;
}
```

### 7.2 迭代的单调性

```typescript
// advance / rollback / loop 之后，iteration 必须严格递进
// 不允许同一 iteration 里跑两个不同的 Phase

if (transitionType === 'advance') {
  assert(iterationAfter === iterationBefore + 1);
  assert(phaseAfter === phaseBefore + 1);
}

if (transitionType === 'loop') {
  assert(iterationAfter === iterationBefore + 1);
  assert(phaseAfter < phaseBefore);  // 回到早期阶段
  assert(scopeVersionAfter > scopeVersionBefore);  // 范围扩大
}
```

### 7.3 交接的一致性

```typescript
// 每次 advance/rollback/loop 都必须记录交接
// 交接内容必须与当前 Agent 的最终输出一致
if (['advance', 'rollback', 'loop'].includes(transitionType)) {
  assert(handoffRecorded === true);
  const handoff = await getHandoffRecord(engagementId, fromPhase);
  assert(handoff.contentHash === agentFinalOutputHash);
}
```

---

# 总结：两套机制如何协作

```
┌────────────────────────────────────────────────────────────┐
│ SKILL SYSTEM (方法论层)                                   │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 25 个技能 = 5 阶段的工作指南                        │ │
│ │ - 每个技能都是：命令 + 期望 + 判据                  │ │
│ │ - 每条命令都在真沙箱里跑过                          │ │
│ │ - 会话冻结技能快照（内容、版本、哈希）              │ │
│ │ - 防止中途漂移                                      │ │
│ └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
              ↓ (Agent 在 worker_running 时加载)
┌────────────────────────────────────────────────────────────┐
│ STATE MACHINE (编排层)                                     │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 五阶段循环工作流                                    │ │
│ │ - 人类在 waiting_human_review 决策：retry/advance  │ │
│ │ - 每次转移都记录（iteration, scope_version）        │ │
│ │ - 支持 loop：发现新范围后回到早期补侦察            │ │
│ │ - 全程审计（state_transitions, human_decisions）   │ │
│ └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

**作者笔记：**

这套架构的核心思想是把**人的决策权**和**证据留痕**放在最中心。技能系统确保每条命令都是透明可验证的；状态机确保每个决策点都明确记录。结合起来，渗透测试变成了"可追溯、可重复、可审计"的工程过程。
