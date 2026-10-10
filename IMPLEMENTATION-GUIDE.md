# dsh-pentest 实操指南：添加新技能 & 自定义工作流

**版本 0.1.18** | 基于稳定的 dsh 0.1.5-rc.2

---

## 部分 A：添加一个新技能（10 分钟）

### A.1 前置检查

```bash
# 你需要：
✓ 熟悉你要实现的渗透测试技术（如：LDAP 枚举）
✓ 沙箱里的工具（ldapsearch、ldapnomnom 等）
✓ 已跑过一遍该技能对应的阶段（熟悉流程）
```

### A.2 目录结构

```bash
mkdir -p skills/your-new-skill
cd skills/your-new-skill
touch SKILL.md
```

### A.3 填写 SKILL.md

**第一步：Frontmatter**

```yaml
---
name: your-new-skill
description: 一句话描述你做什么
whenToUse: 什么场景下用这个技能？（如：threat-modeling 阶段，需要识别 AD 信任关系时）

metadata:
  version: 0.1.0
  phase: threat-modeling          # ← 五个选项之一
  sources: 
    - PTES 威胁建模
    - Microsoft Active Directory 官方文档
    - HackTricks LDAP 枚举
  smoked: "待验证"                 # ← 稍后填充（见 A.5）
---
```

**第二步：8 个固定小节**

```markdown
# 新技能名称(your-new-skill)

## 适用场景

- 什么情况下应该跑这个技能
- 输入数据是什么（前一个阶段的交接）
- 成功的标志是什么

例子：
- 威胁建模中已识别了 AD 域
- 需要确认 AD 林信任关系与双向信任情况
- 成功标志：列出所有信任关系，分类为单向/双向

## 前提与边界

- 环境前提（如必须有 AD 环境）
- 工具可用性（如需要 ldapsearch、或需要域成员）
- 权限要求（匿名、低权、高权）
- 速率声明（如最多 100 个 LDAP 查询/分钟）

## 步骤

### 1. 枚举信任关系
\`\`\`bash
ldapsearch -H ldap://dc.example.com -x -s sub \
  -b "cn=Trust-Parent,cn=System,dc=example,dc=com" \
  objectClass=* | tee /tmp/trusts.ldif
\`\`\`

**期望:** LDIF 格式输出，包含 trustPartner 与 trustAttributes

**判据:** grep -q "trustPartner" /tmp/trusts.ldif

### 2. 解析信任方向
\`\`\`bash
ldapsearch ... | grep trustAttributes | \
  awk '{print $NF}' | while read attr; do
    case "$attr" in
      1) echo "OUTBOUND (单向出)" ;;
      2) echo "INBOUND (单向入)" ;;
      3) echo "BIDIRECTIONAL (双向)" ;;
    esac
  done > /tmp/trust_directions.txt
\`\`\`

**期望:** 信任方向清单

**判据:** wc -l /tmp/trust_directions.txt | grep -v "^0 "

### 3. 生成友好的 JSON 格式
\`\`\`bash
# 把 /tmp/trust_directions.txt 转成 JSON（便于 Agent 处理）
jq -Rs 'split("\n") | map(select(length > 0))' /tmp/trust_directions.txt > /tmp/trust_map.json
\`\`\`

**期望:** 有效的 JSON 数组

**判据:** jq empty /tmp/trust_map.json

## 判读与去噪

### 假阳性排除

| 现象 | 处理 |
|---|---|
| 信任关系报错权限不足 | 说明需要高权限，但不是环境问题；记在报告里 |
| LDAP 返回"referral"而非数据 | 这通常意味着信任存在但跨域，记录 referral target 作为证据 |
| 查询超时 | AD 可能很大，改用更细粒度的搜索（如按 OU） |

## 常见失败

| 现象 | 真实原因 | 处置 |
|---|---|---|
| 全部"No such object" | LDAP baseDN 错了 | 用 `ldapsearch -x -s base` 探测有效的 baseDN |
| "Insufficient Access Rights" | 匿名查询被拒 | 改用域帐号，或记录"匿名 LDAP 被拒" |
| 返回 0 个信任关系 | 这个森林里真的没有其他信任 | 验证一下 AD 本身是否是单域 |

## 不做的事

- 不修改信任关系（这是 destructive）
- 不创建新的信任关系
- 不 dump 整个 AD 目录（这是 exfiltration，操作员需禁用）
- 不尝试破坏信任链

## 产出(交给下一步)

- 信任关系清单：源域 → 目标域，方向，可信度
- 跨林入口点：哪些域对当前作业范围相关
- 下一步建议：是否需要深入某个信任链

## 参考

- PTES: Threat Modeling
- Microsoft Docs: Trust Relationships
- HackTricks: AD Enumeration
```

---

### A.4 本地测试（冒烟）

**前提：** 你已启动完整的 dsh-pentest 环境（PostgreSQL + Docker）。

**第一步：获取当前镜像摘要**

```bash
docker images pentest-tools:toolbelt-* --no-trunc --quiet | head -1
# 输出：sha256:5ee076609c8708cdbf3e23bd2f10f1e1eb2f9c6a...
# 取前 12 位：5ee076609c87
```

**第二步：测试每个 bash 块**

```bash
# 对每个 bash 块：
docker run --rm \
  --network pentest-lab-internal \
  pentest-tools:toolbelt-2026.10.06 \
  /bin/bash -c '
    # 第 1 块
    ldapsearch -H ldap://ad-dc:389 ... && echo "✓ Block 1"
    
    # 第 2 块（依赖第 1 块的 /tmp/trusts.ldif）
    cat /tmp/trusts.ldif && echo "✓ Block 2"
    
    # 第 3 块
    jq empty /tmp/trust_map.json && echo "✓ Block 3"
  '
```

**第三步：填充 smoked 字段**

```yaml
metadata:
  smoked: "沙箱实测@5ee076609c87:3 块原文配方逐条实跑（AD 环境:ad-dc）--1\`ldapsearch -H ldap://ad-dc\` -> LDIF 输出、信任属性可见(0.4s,rc=0);2\`cat /tmp/trusts.ldif\` -> grep trustPartner 成功(0.01s);3\`jq empty /tmp/trust_map.json\` -> 有效 JSON(0.02s)"
```

---

### A.5 注册到 SKILL_PACKS

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
    'your-new-skill',  # ← 加在这里
  ],
  // ...
} as const;
```

---

### A.6 编译 & 验证

```bash
cd C:/Projects/Agent-projects/dsh-DCG-pentest

# 编译
pnpm run build

# 跑格式检查
pnpm run test:skills

# 输出应该是：
# ✓ your-new-skill: format valid
# ✓ your-new-skill: tools available
# ✓ your-new-skill: smoke test binds to image digest
```

---

### A.7 上线使用

**重启不需要！** 由于 `patchReload: "live"`，下一次会话创建时，新技能会自动加载。

```bash
# 只需这样：
# 1. 在 dsh 控制台创建新作业
# 2. 选择 threat-modeling 阶段
# 3. Agent 会话启动时自动加载 your-new-skill

# 验证：在 Agent 输出里看到：
# "skill_load: your-new-skill loaded (revision 1, hash abc123...)"
```

---

## 部分 B：自定义状态机（高级）

### B.1 修改转移边

**场景：** 你想添加一条新的转移：`Phase 3 (Exploitation) → Phase 2 (Vulnerability Analysis)`（发现需要更多漏洞）

**步骤 1：`src/workflow/phases.ts`**

```typescript
export const RECOMMENDED_MOVES = {
  // ... 其他阶段 ...
  'exploitation': [
    { to: 'post-exploitation', kind: 'advance', default: true },
    { to: 'vulnerability-analysis', kind: 'rollback', default: false },
    { to: 'exploitation', kind: 'retry', default: false },
    { to: 'intelligence-gathering', kind: 'loop', default: false },
    { to: 'vulnerability-analysis', kind: 'rollback_partial', default: false },  # ← 新转移
  ],
};
```

**步骤 2：`src/workflow/transition-table.ts`**

```typescript
export const TRANSITION_DISPATCH = {
  // ... 其他转移 ...
  'human_rollback_partial': {
    fromStatus: ['waiting_human_review'],
    toStatus: 'handoff_drafting',
    iterationDelta: 0,  # ← 不增加迭代（留在同一轮）
    scopeDelta: 0,
    handoffRecorded: true,
    sessionReuse: null,
  },
  // ...
};
```

**步骤 3：验证** 

```bash
pnpm run test:workflow

# 输出：
# ✓ TRANSITION_DISPATCH valid
# ✓ All edges in RECOMMENDED_MOVES covered
# ✓ No unreachable transitions
```

---

### B.2 添加新的 Phase

**场景：** 你想插入一个新阶段「合规评估」在报告前。

**⚠️ 高风险！不推荐。** 但如果必须做：

**步骤 1：`src/contracts.ts`**

```typescript
export const PHASES = [
  'intelligence-gathering',
  'threat-modeling',
  'vulnerability-analysis',
  'exploitation',
  'post-exploitation',
  'compliance-assessment',  # ← 新阶段
] as const;
```

**步骤 2：`src/workflow/phases.ts`**

```typescript
export const PHASE_DEFINITIONS = {
  // ... 其他 ...
  'compliance-assessment': {
    ordinal: 5,
    displayName: '合规评估',
    agentName: 'pentest-compliance-agent',
    deliverables: [
      '发现映射到 NIST / PCI-DSS / ISO 27001',
      '补救建议与优先级',
    ],
    exitCriteria: [
      '所有发现都映射到合规框架',
    ],
  },
};

export const RECOMMENDED_MOVES = {
  'post-exploitation': [
    // ...
    { to: 'compliance-assessment', kind: 'advance', default: false },  # ← 新边
  ],
  'compliance-assessment': [
    { to: 'complete', kind: 'end_testing', default: true },
    { to: 'post-exploitation', kind: 'rollback', default: false },
  ],
};
```

**步骤 3：创建 Agent**

```bash
# 为新阶段创建 Agent（该 Agent 需要对应的技能）
mkdir -p src/agents/compliance-agent
```

**步骤 4：编译 & 测试**

```bash
pnpm run build
pnpm run test:workflow

# 检查：迭代号、范围版本是否符合预期
```

---

### B.3 修改人工决策点

**场景：** 当前是 `waiting_human_review` 时人决策。想要在 Agent 运行 5 分钟后自动检查点。

**这不能通过配置改，需要改 Agent 逻辑。** 但可以做这个：

**在 `src/workflow/sessions.ts` 里添加自动暂停：**

```typescript
async function startWorker(engagementId, phaseId) {
  // ... 启动 Agent ...
  
  // 5 分钟后自动暂停，等人查看
  setTimeout(() => {
    recordDecision({
      engagementId,
      type: 'auto_checkpoint',
      reason: '自动 5 分钟检查点',
    });
    recordPlannedTransition('auto_pause');
    // 更新 status = waiting_human_review, marker = blocked
  }, 5 * 60 * 1000);
}
```

---

## 部分 C：运维操作

### C.1 技能库维护

**查看已注册的所有技能：**

```bash
curl http://127.0.0.1:3090/api/skills \
  -H "Authorization: Bearer $(cat ~/.dsh-token)" | jq '.[] | {name, version, phase}'
```

**输出：**

```json
{
  "name": "recon-network-surface",
  "version": "0.1.0",
  "phase": "intelligence-gathering"
},
...
```

**上传新技能：**

```bash
curl -X POST http://127.0.0.1:3090/api/skills \
  -H "Authorization: Bearer ..." \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "name": "your-new-skill",
  "content": "$(cat skills/your-new-skill/SKILL.md)",
  "version": "0.1.0",
  "phase": "threat-modeling"
}
EOF
```

---

### C.2 数据库迁移（如果修改了状态机）

**场景：** 添加新字段后，需要数据库同步。

```bash
# 1. 创建迁移文件
cat > db/migrations/028_custom_phase.sql << 'EOF'
-- Add compliance-assessment phase
ALTER TABLE state_transitions
  ADD COLUMN compliance_notes text;

UPDATE engagements SET phase = 'compliance-assessment'
  WHERE phase = 'post-exploitation' AND needs_compliance = true;
EOF

# 2. 执行迁移
npm run db:verify -- --keep

# 3. 验证
psql -h 127.0.0.1 -p 55446 -U postgres -d pentest_personal \
  -c "SELECT COUNT(*) FROM state_transitions WHERE compliance_notes IS NOT NULL;"
```

---

### C.3 监控和日志

**查看作业的完整转移历史：**

```bash
curl http://127.0.0.1:3090/api/engagements/{id}/transitions \
  -H "Authorization: Bearer ..." | jq '.[] | {from_phase, to_phase, transition_type, timestamp}'
```

**输出：**

```
{
  "from_phase": "intelligence-gathering",
  "to_phase": "threat-modeling",
  "transition_type": "advance",
  "timestamp": "2026-10-10T14:23:45Z"
},
{
  "from_phase": "threat-modeling",
  "to_phase": "intelligence-gathering",
  "transition_type": "loop",
  "timestamp": "2026-10-10T14:50:12Z"
}
```

---

## 部分 D：常见问题与故障排查

### Q1: 新技能在会话中没有加载

**症状：** Agent 说 "skill 'your-new-skill' not found"

**排查：**

```bash
# 1. 检查是否注册到 SKILL_PACKS
grep -r "your-new-skill" src/skills/skill-pack.ts

# 2. 检查会话创建时是否选了对应的阶段
# 在 dsh 控制台查看会话详情 → skillIds 字段

# 3. 检查编译是否成功
pnpm run build 2>&1 | grep -i error

# 4. 强制重启 dsh（清缓存）
pkill -9 node
cd C:/Projects/Agent-projects/dsh-DCG-pentest
DSH_PROFILE=pentest node start-personal.mjs
```

---

### Q2: 状态机卡在某个状态

**症状：** 状态是 `waiting_human_review` 但决策按钮没反应

**排查：**

```bash
# 1. 查看 dsh 日志
tail -100 /tmp/pentest-ready.log | grep -E "error|Error|ERROR"

# 2. 检查数据库约束
docker exec pentest-db-full psql -U postgres -d pentest_personal \
  -c "SELECT * FROM engagements WHERE id = '{engagement_id}' \G"

# 3. 检查审计账本是否已满
psql -c "SELECT COUNT(*) FROM state_transitions WHERE engagement_id = '{id}';"

# 4. 手动修复（小心！）
psql -c "UPDATE engagements SET run_marker = 'running' WHERE id = '{id}';"
```

---

### Q3: 技能冒烟测试失败

**症状：** `smoked: "..." 与当前镜像摘要不符`

**解决：**

```bash
# 1. 获取当前镜像摘要
docker images pentest-tools:toolbelt-* --no-trunc --quiet | head -1

# 2. 重新跑命令（见 A.4）

# 3. 更新 SKILL.md 里的 smoked 字段
# 或者，跳过检查（仅开发用）
pnpm run test:skills --skip-smoke
```

---

## 部分 E：最佳实践

### E.1 技能编写的 10 条金律

| 规则 | 为什么 |
|---|---|
| 每条命令都在真沙箱里跑过 | 避免"看起来对"的幻想 |
| 判据用 `grep/jq/awk`，不用"视情况" | Agent 需要机械的判定规则 |
| `/tmp` 中间产物必须与消费命令合并（用 `&&`） | 真实执行是一次性容器 |
| 不写跨技能依赖 | 技能应该自足；不能假设加载顺序 |
| 每个技能 ≤ 300 行 | Agent token 预算，可读性 |
| 标注速率（如"最多 100 个 HTTP 请求/分钟"） | 配额系统需要这个数据 |
| 不做 destructive / persistence / exfiltration | 这三类操作员禁用，不应出现在技能里 |
| 常见失败表格必须 ≥ 3 行 | 这就是 Agent 的故障排查指南 |
| 产出清单要具体（不写"相关信息"） | 下一阶段 Agent 需要精确的输入 |
| metadata.smoked 必须有 | 品质保证的根本 |

---

### E.2 状态机配置的 5 条金律

| 规则 | 为什么 |
|---|---|
| 转移表不要跨越超过 2 个阶段 | Agent 交接的信息丢失，质量下降 |
| 每个阶段的 exit criteria 要明确 | 决策点的锚点 |
| loop 要求 scope_version++ | 追踪扩范围，避免重复 |
| 不允许从 complete 转移到任何地方 | 工作已结束，不能反悔 |
| 人工决策点只在 waiting_human_review | Agent 无法在其他地方暂停人，维持可预测性 |

---

## 总结

- **添加技能：** 写 SKILL.md → 冒烟测试 → 注册到 SKILL_PACKS → 编译 → 下次会话自动加载
- **修改状态机：** 改 phases.ts 和 transition-table.ts → 编译 → 新会话生效
- **上线前：** 本地测试、格式检查、镜像摘要绑定
- **故障排查：** 查日志 → 查数据库 → 查编译错误 → 手动修复（必要时）

---

**下一步：** 想要写一个特定的技能吗？告诉我场景，我来帮你起草！
