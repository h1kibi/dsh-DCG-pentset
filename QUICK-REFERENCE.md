# dsh-pentest 快速参考卡

**打印版** | 贴在显示器旁边

---

## 一页纸掌握全局

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  dsh-pentest: 人驾驶 + Agent 协作 = 渗透测试工作台        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

核心承诺：
  ✓ 人在每一步决策（不是自动化）
  ✓ 每条命令都在真沙箱里验证过
  ✓ 所有输出都审计留痕
  ✓ 可循环：新发现 → 回到早期补侦察

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  五个阶段（PHASES）                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  0️⃣  情报收集        → nmap / ffuf / dns 侦察
      intelligence-gathering

  1️⃣  威胁建模        → STRIDE / 信任边界 / 攻击路径
      threat-modeling

  2️⃣  漏洞分析        → Web / 网络 / Cloud / AD 漏洞
      vulnerability-analysis

  3️⃣  利用验证        → 权限提升 / RCE / 数据访问
      exploitation

  4️⃣  后渗透          → 横移 / 持久化（禁用）/ 信息搜集
      post-exploitation

  每个阶段 = 一个独立的 Agent 会话 + 相应的 25 个技能

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  关键概念速查                                            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  技能 (Skill)
  = 一个 markdown 文件（skills/<name>/SKILL.md）
  = 方法论 + 命令 + 期望 + 判据
  = 每条命令都在真沙箱里跑过（冒烟测试）
  = 会话冻结快照（防止中途漂移）

  状态机 (State Machine)
  = 8 个 MainStatus + 5 个 RunMarker
  = 五阶段循环工作流（不是线性）
  = 人在 waiting_human_review 决策
  = 每次转移记录 iteration + scope_version + 审计

  Loop (循环)
  = 发现新范围 → 回到早期补侦察
  = 例：Phase 3 发现内网 172.30.0.0/24 → 回到 Phase 0
  = iteration++, scope_version++（严格单调）

  Handoff (交接)
  = Phase N Agent 完成 → 起草给 Phase N+1 的摘要
  = 人审阅 → 确认 → Phase N+1 Agent 启动
  = 所有上下文（原始数据 + 分析结果）持久化到 PostgreSQL

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  作业状态转移（8 个 MainStatus）                         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  auth_pending
      ↓ [人确认范围]
  ready
      ↓ [启动 Phase 0 Agent]
  worker_running
      ↓ [Agent 输出结果]
  waiting_human_review  ← 🟡 人工决策点
      ├─ [retry 同会话]          → worker_running
      ├─ [retry 新会话]          → worker_running
      ├─ [advance 到下一阶段]    → handoff_drafting
      ├─ [rollback 到上一阶段]   → handoff_drafting
      ├─ [loop 回早期阶段]       → handoff_drafting
      └─ [end_testing]           → report_ready
      
  handoff_drafting
      ↓ [Agent 起草交接摘要]
  transition_confirmation
      ↓ [人确认交接]
  ready  ← [启动下一 Agent]
      ↓
  (重复或跳到 report_ready)

  report_ready
      ↓ [人签名]
  complete

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  技能编写 5 分钟版                                       ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  1. 创建 skills/<name>/SKILL.md

  2. Frontmatter:
     ---
     name: kebab-case
     description: 一句话
     whenToUse: 什么场景
     metadata:
       version: 0.1.0
       phase: intelligence-gathering|threat-modeling|...
       sources: [...]
       smoked: "待验证"
     ---

  3. 8 个小节（严格顺序）:
     ## 适用场景
     ## 前提与边界
     ## 步骤
       ### 1. 标题
           ```bash
           命令
           ```
           期望: ...
           判据: ...
     ## 判读与去噪
     ## 常见失败
     | 现象 | 原因 | 处置 |
     ## 不做的事
     ## 产出(交给下一步)
     ## 参考

  4. 冒烟测试（本地）:
     docker run --rm pentest-tools /bin/bash -c '
       bash_block_1 &&
       bash_block_2 &&
       bash_block_3
     '

  5. 更新 smoked 字段（镜像摘要 + 结果）

  6. 注册到 src/skills/skill-pack.ts:
     export const SKILL_PACKS = {
       'threat-modeling': [
         ...
         'your-new-skill',  ← 加这里
       ],
     };

  7. 编译:
     pnpm run build && pnpm run test:skills

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  常用命令                                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  # 启动完整环境
  cd C:/Projects/Agent-projects/dsh-DCG-pentest
  DSH_PROFILE=pentest node start-personal.mjs
  # → http://127.0.0.1:3090/?token=...

  # 编译项目
  pnpm run build

  # 检查技能格式
  pnpm run test:skills

  # 验证数据库迁移
  npm run db:verify -- --keep

  # 查看作业历史
  curl http://127.0.0.1:3090/api/engagements/{id}/transitions \
    -H "Authorization: Bearer $TOKEN" | jq

  # Docker 里执行 SQL
  docker exec pentest-db-full psql -U postgres -d pentest_personal \
    -c "SELECT * FROM engagements LIMIT 5;"

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  设计原则（死不悔改）                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  ✓ 人在环：每个决策都是人做的（Agent 不能自行推进）
  ✓ 证据链：所有命令输出都留痕（hash + 脱敏）
  ✓ 可验证：每条命令都能复现（沙箱隔离 + 一次性容器）
  ✓ 可循环：新发现可以 loop 回早期（不是线性）
  ✓ 可审计：所有状态转移都记录（iteration, scope_version, timestamp）

  ✗ 不做：自动利用、批量外传、留后门
  ✗ 不做：容器跑在宿主上
  ✗ 不做：跨 Agent 的隐式依赖

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  故障排查速查                                            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  Agent 没加载技能
  → 检查 SKILL_PACKS 里有没有
  → 检查编译是否成功
  → 检查会话选的阶段对不对

  状态卡住
  → 查 dsh 日志: tail /tmp/pentest-ready.log
  → 查约束: psql 查 engagements 表
  → 手动修复: UPDATE engagements SET run_marker='running'

  技能冒烟失败
  → 获取当前镜像摘要: docker images --no-trunc --quiet
  → 重新本地跑命令
  → 更新 smoked 字段

  数据库迁移出问题
  → npm run db:verify -- --keep
  → 查迁移日志: psql 查 schema_migrations
  → 手工运行对应的 SQL 文件

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  文件导航                                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  关键文件:
  ├─ src/contracts.ts               五阶段 + 8 个状态 + 13 个转移类型定义
  ├─ src/workflow/
  │  ├─ phases.ts                   阶段定义 + 推荐转移
  │  ├─ transition-table.ts         转移分派表 + 验证器
  │  ├─ core.ts                     事务原语 + 审计
  │  └─ sessions.ts                 会话生命周期
  ├─ src/skills/
  │  ├─ skill-pack.ts               技能到阶段的映射
  │  └─ pg-skill.ts                 技能库服务
  └─ skills/
     ├─ AUTHORING-SPEC.md           撰写规范（法律）
     └─ **/SKILL.md                 25 个技能

  参考文档:
  ├─ DEEP-DIVE-SKILLS-STATE-MACHINE.md  ← 你在这里
  ├─ IMPLEMENTATION-GUIDE.md
  ├─ docs/dsh-pentest-plugin-design.md  权威设计文档（400KB）
  └─ RUNBOOK.md                          运维指南

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  下一步                                                  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  想要...                          做这个:

  □ 理解完整设计                   读 DEEP-DIVE-SKILLS-STATE-MACHINE.md
  □ 添加新技能                     看 IMPLEMENTATION-GUIDE.md 部分 A
  □ 修改状态机                     看 IMPLEMENTATION-GUIDE.md 部分 B
  □ 故障排查                       看 IMPLEMENTATION-GUIDE.md 部分 D
  □ 运维操作                       看 IMPLEMENTATION-GUIDE.md 部分 C
  □ 完整设计理由                   读 docs/dsh-pentest-plugin-design.md
  □ 启动/停止/升级                 读 RUNBOOK.md

════════════════════════════════════════════════════════════════

问题?  查快速参考 + 故障排查速查 + 看日志 + 查 DB

祝你好运！🎯
```

---

## 转移决策树（帮你决定 retry / advance / rollback / loop）

```
Agent 报结果了
    ↓
结果正确吗？
    ├─ 不对
    │  ├─ 想在当前会话重试？
    │  │  └─ [retry 同会话] → worker_running
    │  └─ 想在新会话重试？
    │     └─ [retry 新会话] → worker_running
    │
    ├─ 对，但不完整
    │  ├─ 需要回到上一阶段补数据？
    │  │  └─ [rollback] → 上一阶段（iteration--）
    │  └─ 需要回到更早的阶段重新侦察？
    │     └─ [loop] → 早期阶段（iteration++, scope_version++）
    │
    └─ 对，且完整
       ├─ 可以进下一阶段吗？
       │  └─ [advance] → 下一阶段（iteration++）
       └─ 测试完了？
          └─ [end_testing] → report_ready
```

---

## 技能的八字真言

```
┌──────────────────────────────┐
│ 每条命令都在沙箱里跑过      │
│ 判据必须可判定                │
│ 容器是一次性的                │
│ /tmp 跨步需合并               │
│ 速率要标注                    │
│ 常见失败 ≥ 3 行               │
│ 产出清单要具体                │
│ 冒烟要绑定镜像                │
└──────────────────────────────┘
```

---

**版本：** 0.1.18 | **最后更新：** 2026-10-10
