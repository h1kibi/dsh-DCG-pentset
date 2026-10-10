# dsh-pentest 文档索引

**完整 dsh-pentest 0.1.18 | 稳定于 dsh 0.1.5-rc.2**

---

## 快速开始（5 分钟）

👉 **如果你只有 5 分钟：** 打开 `QUICK-REFERENCE.md`

---

## 文档结构

### 第一阶段：理解系统

| 文档 | 内容 | 用时 |
|---|---|---|
| **QUICK-REFERENCE.md** | 一页纸掌握全局、决策树、转移表 | 5-10 分钟 |
| **DEEP-DIVE-SKILLS-STATE-MACHINE.md** | 技能系统 & 状态机的完整剖析 | 30-45 分钟 |

### 第二阶段：动手实操

| 文档 | 内容 | 用时 |
|---|---|---|
| **IMPLEMENTATION-GUIDE.md** | 部分 A：添加新技能（10 分钟指南） | 10-20 分钟 |
| **IMPLEMENTATION-GUIDE.md** | 部分 B：自定义状态机（高级） | 30-60 分钟 |
| **IMPLEMENTATION-GUIDE.md** | 部分 C：运维操作 & 监控 | 按需 |
| **IMPLEMENTATION-GUIDE.md** | 部分 D：故障排查 & 常见问题 | 按需 |

### 第三阶段：深度参考

| 文档 | 内容 | 用时 |
|---|---|---|
| **docs/dsh-pentest-plugin-design.md** | 权威设计文档（400KB，21 个章节） | 需要时查阅 |
| **RUNBOOK.md** | 运维指南、升级路径、已知问题 | 运维时查阅 |
| **skills/AUTHORING-SPEC.md** | 技能撰写的法律文本（硬要求） | 编写技能时必读 |
| **skills/README.md** | 技能包快速索引 | 浏览技能时查阅 |

---

## 按使用场景查找文档

### 🟢 我是 QA / 测试人员

**目标：** 理解系统如何运行，验收作业质量

**建议路径：**
1. 读 `QUICK-REFERENCE.md`（理解五阶段 + 人工决策点）
2. 读 `DEEP-DIVE-SKILLS-STATE-MACHINE.md` 的"第 6 节：审计与版本管理"（了解留痕机制）
3. 参考 `IMPLEMENTATION-GUIDE.md` 部分 D（故障排查）

**关键概念：** 
- 作业是循环的（loop），不是线性的
- 每次状态转移都记录在 `state_transitions` 表
- 技能冒烟测试绑定到镜像摘要

---

### 🟡 我是工程师 / 工具开发者

**目标：** 添加新技能、修改工作流、扩展功能

**建议路径：**
1. 读 `QUICK-REFERENCE.md`（快速掌握）
2. 读 `DEEP-DIVE-SKILLS-STATE-MACHINE.md`（完整理解）
3. 按需实操：
   - 添加技能 → `IMPLEMENTATION-GUIDE.md` 部分 A
   - 修改状态机 → `IMPLEMENTATION-GUIDE.md` 部分 B
   - 故障排查 → `IMPLEMENTATION-GUIDE.md` 部分 D
4. 参考 `skills/AUTHORING-SPEC.md`（技能编写的硬要求）

**关键文件：**
- `src/contracts.ts` - 五阶段、八状态的定义
- `src/workflow/phases.ts` - 阶段定义 + 推荐转移
- `src/workflow/transition-table.ts` - 转移分派表
- `src/skills/skill-pack.ts` - 技能到阶段的映射

---

### 🔴 我是运维 / DevOps

**目标：** 启动、维护、监控、升级系统

**建议路径：**
1. 读 `QUICK-REFERENCE.md` 中的"常用命令"
2. 读 `IMPLEMENTATION-GUIDE.md` 部分 C（运维操作）
3. 读 `RUNBOOK.md`（升级、已知问题、应急处置）

**关键命令：**
```bash
# 启动
DSH_PROFILE=pentest node start-personal.mjs

# 查看作业历史
curl http://127.0.0.1:3090/api/engagements/{id}/transitions -H "Authorization: Bearer $TOKEN"

# 数据库迁移
npm run db:verify -- --keep

# Docker 里执行 SQL
docker exec pentest-db-full psql -U postgres -d pentest_personal -c "..."
```

---

### 🔵 我是渗透测试师 / 安全分析师

**目标：** 使用工作台进行渗透测试，理解工作流

**建议路径：**
1. 读 `QUICK-REFERENCE.md`（理解五阶段 + 人工决策点）
2. 在 dsh 控制台创建作业（实践第一次）
3. 参考 `docs/dsh-pentest-plugin-design.md` 第 1-3 节（理解设计）
4. 遇到问题 → `IMPLEMENTATION-GUIDE.md` 部分 D

**关键概念：**
- 五个独立的 Agent，每个都需要人工决策
- 发现新范围 → loop 回情报收集（自动化不给你这个选择）
- 所有命令都在沙箱里跑（看不到源码，但可看日志）

---

## 文件物理位置

```
dsh-DCG-pentest/
├─ QUICK-REFERENCE.md                  ← 快速参考（打印版）
├─ DEEP-DIVE-SKILLS-STATE-MACHINE.md   ← 完整剖析
├─ IMPLEMENTATION-GUIDE.md              ← 实操指南
├─ DOCS-INDEX.md                        ← 你在这里
├─ RUNBOOK.md                           ← 运维指南（已有）
├─ README.md                            ← 项目概述（已有）
│
├─ docs/
│  ├─ dsh-pentest-plugin-design.md     ← 权威设计（400KB）
│  └─ ...
│
├─ skills/
│  ├─ AUTHORING-SPEC.md                ← 技能撰写规范
│  ├─ README.md                         ← 技能包索引
│  └─ <skill-name>/SKILL.md            ← 25 个技能
│
└─ src/
   ├─ contracts.ts                     ← 五阶段 + 状态定义
   ├─ skills/
   │  ├─ skill-pack.ts                 ← 技能映射
   │  └─ pg-skill.ts                   ← 技能库服务
   └─ workflow/
      ├─ phases.ts                     ← 阶段定义
      ├─ transition-table.ts           ← 转移表
      ├─ core.ts                       ← 事务原语
      └─ sessions.ts                   ← 会话管理
```

---

## 常见搜索

### "我想…"

**…了解这个系统的设计理由**
→ `DEEP-DIVE-SKILLS-STATE-MACHINE.md` + `docs/dsh-pentest-plugin-design.md`

**…添加一个新技能**
→ `IMPLEMENTATION-GUIDE.md` 部分 A + `skills/AUTHORING-SPEC.md`

**…修改五阶段的顺序**
→ `IMPLEMENTATION-GUIDE.md` 部分 B（高级）+ `src/workflow/phases.ts`

**…理解"loop"是什么**
→ `DEEP-DIVE-SKILLS-STATE-MACHINE.md` 第 4 节 + `QUICK-REFERENCE.md` 转移决策树

**…了解技能是怎么冻结的**
→ `DEEP-DIVE-SKILLS-STATE-MACHINE.md` 第 一部分、2.3 节

**…查看一个作业的完整历史**
→ `IMPLEMENTATION-GUIDE.md` 部分 C.3 + 数据库查询

**…故障排查**
→ `IMPLEMENTATION-GUIDE.md` 部分 D

**…升级 dsh 版本**
→ `RUNBOOK.md` § 升级路径

**…理解为什么容器必须一次性的**
→ `DEEP-DIVE-SKILLS-STATE-MACHINE.md` 第一部分、2.1 节（纪律）+ `skills/AUTHORING-SPEC.md`

---

## 推荐阅读顺序（从零开始）

### Day 1（了解）
1. `QUICK-REFERENCE.md` - 30 分钟
2. `README.md` - 20 分钟

### Day 2（深化）
3. `DEEP-DIVE-SKILLS-STATE-MACHINE.md` - 1 小时
4. 在 dsh 控制台创建一个测试作业 - 30 分钟

### Day 3（动手）
5. `IMPLEMENTATION-GUIDE.md` - 按需查阅
6. 尝试添加一个简单技能 - 1 小时

### Day 4+（参考）
7. `docs/dsh-pentest-plugin-design.md` - 需要时查阅
8. `skills/AUTHORING-SPEC.md` - 编写技能时必读

---

## 文档维护

| 文档 | 维护者 | 更新频率 |
|---|---|---|
| `QUICK-REFERENCE.md` | 工程师 | 重大变更时 |
| `DEEP-DIVE-SKILLS-STATE-MACHINE.md` | 设计师 | 架构变更时 |
| `IMPLEMENTATION-GUIDE.md` | 工程师 | 新功能时 |
| `RUNBOOK.md` | 运维 | 每次发版 |
| `skills/AUTHORING-SPEC.md` | 技能维护者 | 编写规范变更时 |
| `docs/dsh-pentest-plugin-design.md` | 架构师 | 很少变更（权威版本） |

---

## 如何贡献文档

1. **发现错误或遗漏？** 编辑对应文件，提交 PR
2. **新功能上线？** 在 `IMPLEMENTATION-GUIDE.md` 对应部分补充
3. **从零构建？** 在 `docs/dsh-pentest-plugin-design.md` 补充设计理由

---

## 联系方式

- **技术问题？** 查看 `IMPLEMENTATION-GUIDE.md` 部分 D（常见问题与故障排查）
- **设计问题？** 参考 `docs/dsh-pentest-plugin-design.md`
- **快速参考？** 打印 `QUICK-REFERENCE.md`

---

**最后更新：** 2026-10-10 | **作者：** dsh-pentest 核心团队

**现在可以：** 
- 启动完整的渗透测试工作台 ✓
- 理解五阶段工作流 ✓
- 添加新技能 ✓
- 自定义状态机 ✓

祝你使用愉快！🎯
