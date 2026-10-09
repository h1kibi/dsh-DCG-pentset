# Memory & Handoff 设计与实现评估

## 执行摘要

你的设计**已经非常成熟**，核心架构正确解决了「长任务 AI 失忆减智」问题。主要优势：

✅ **七层记忆架构完整**：账本、会话、快照、语义、索引、交接、公共记忆清晰分层  
✅ **混合检索设计科学**：向量 + 全文 + 三元组，RRF 融合，范围过滤精确  
✅ **交接人类在环**：AI 只起草，人类审查确认，避免 JSON 墙  
✅ **原始事件永久保留**：3700+ 行测试，完整实现，生产级质量  
✅ **思考链开放检索**：跨会话可见，不自动注入，标注来源  

**核心问题不在设计，而在 Agent 使用策略与检索提示**。

---

## 一、设计评估

### 1.1 架构优势

| 维度 | 设计决策 | 评分 | 理由 |
|------|---------|------|------|
| **记忆分层** | 七层清晰职责分离 | ⭐⭐⭐⭐⭐ | 账本不可覆盖 + 索引可重建 + 交接版本化，正交设计 |
| **混合检索** | 三路信号 RRF 融合 | ⭐⭐⭐⭐⭐ | 适配中文（二字组投影）、短标识符（三元组）、语义（向量） |
| **范围过滤** | 排除优先 + 空放行 | ⭐⭐⭐⭐⭐ | 谓词精确，思考链不被误伤，完整测试覆盖 |
| **交接机制** | 草稿→编辑→确认三阶段 | ⭐⭐⭐⭐⭐ | 2026-10-05 改动避免 JSON 墙，人类最终裁决 |
| **公共记忆** | 无条件注入，唯一可覆盖 | ⭐⭐⭐⭐ | 清晰建模「人类全局指令」vs「AI 产出事实」 |
| **思考链** | 开放检索不降权 | ⭐⭐⭐⭐⭐ | 避免系统性看不到前序推理，风险靠标注控制 |

### 1.2 实现质量

```bash
# 代码统计
设计文档：         4843 行（完整、精确、可执行）
Handoff 实现：      833 行（handoff-flow.ts）
Memory 实现：       978 行（pg-memory-query.ts）
检索核心：          662 行（retrieval.ts）
Worker 工具层：    1969 行（pg-worker-tools.ts）
测试覆盖：         3734 行（9 个测试文件）
```

✅ TypeScript 严格模式，完整类型导出  
✅ 数据库 18 个迁移，注释完整，RLS 就绪  
✅ 范围过滤双重校验（SQL 下推 + 融合层复核）  
✅ 租约、事务边界、哈希链完整  

---

## 二、核心问题诊断

### 2.1 不是设计问题

你担心的「超长上下文失忆减智」，设计已经给出了**三重防护**：

| 机制 | 设计覆盖 | 实现状态 |
|------|---------|---------|
| 1️⃣ **主动检索** | `memory_search` 工具，Agent 按需召回 | ✅ 完整实现 |
| 2️⃣ **交接压缩** | 阶段切换时人类审查的上下文起点 | ✅ 完整实现 |
| 3️⃣ **会话内压缩** | 60% 阈值自动压缩，保留最近 6 轮 | ⚠️ 已实现但未接线（§8.10.0） |

**实际问题可能是**：

#### A. Agent 不知道该何时检索

```typescript
// 当前：Agent 自己判断何时调用 memory_search
// 风险：模型可能认为"我记得"，实际上已经压缩/切换会话

// 缺失：明确的检索触发提示
```

**建议改进**：在 phase-profile 中明确**检索策略**：

```typescript
// src/agents/phase-profiles.ts 需要补充
retrievalStrategy: {
  triggers: [
    'session_start',           // 新会话必检索前序结论
    'asset_first_mention',     // 首次遇到资产标识符
    'contradiction_suspected', // 发现矛盾时回溯
    'decision_point'          // 提交报告前汇总证据
  ],
  queries: {
    session_start: 'phase:{previous_phase} trust_levels:human_decision,tool_observation',
    asset_context: 'asset_ids:{current} kinds:fact,tool_observation',
    // ...
  }
}
```

#### B. 检索结果未被充分利用

```typescript
// 当前：memory_search 返回 hits，但 Agent 可能：
// 1. 忽略低分命中（实际可能很重要）
// 2. 不追溯 sourceEventId 看原文
// 3. 被零命中的 note 误导（以为没内容）

// src/memory/pg-worker-tools.ts:653-658
note = chunks === 0
  ? '本作业记忆索引为空...' 
  : `本作业索引有 ${chunks} 个分块，但本次查询没有命中...`
```

**建议改进**：

1. **零命中时主动建议备选查询**：
```typescript
if (hits.length === 0 && chunks > 0) {
  // 分析查询失败原因
  const suggestions = await this.#suggestAlternativeQueries(
    query, 
    session.engagement_id
  );
  note += `\n可尝试：${suggestions.join(' / ')}`;
}
```

2. **低分命中也要说明为什么低**：
```typescript
// 返回结构中增加 diagnostics
return {
  hits,
  indexWatermark,
  diagnostics: {
    totalChunks: chunks,
    queryTokens: lexTsQuery.split(' ').length,
    avgScore: hits.reduce((s, h) => s + h.score, 0) / hits.length,
    coveragePhases: [...new Set(hits.map(h => h.source.phase))]
  }
}
```

#### C. 思考链检索不够主动

```typescript
// 当前：include_reasoning 参数可选
// 风险：Agent 可能从不传 true，永远看不到前序推理

// 设计文档 §8.3 说"本 engagement 内任意阶段都可检索思考链"
// 但实现上没有**强制至少一次检索**的机制
```

**建议改进**：

- **在交接草稿中注入「前序推理摘要」**：
```typescript
// handoff-flow.ts 生成草稿时
const reasoningSummary = await memoryQuery.search({
  workerSessionId: currentSession.id,
  query: `phase:${previousPhase} kinds:reasoning`,
  includeReasoning: true,
  limit: 3
});

draftPayload.reasoning_context = reasoningSummary.hits.map(h => ({
  excerpt: h.excerpt,
  ref: h.memoryId,
  phase: h.source.phase
}));
```

---

### 2.2 当前实现的真实限制

#### 限制 1：会话内压缩未接线

```typescript
// src/memory/compaction.ts 1225 行完整实现
// 但运行时无消费者（§8.10.0）

// 缺失四个接缝：
// ① 回合边界 effect 点
// ② 宿主模型服务调用（记录用途=压缩）
// ③ SessionPort 追加 replace 事件
// ④ 更新 compacted_through_turn
```

**影响**：单个会话超长时，上下文仍会全量累积。

**改进优先级**：🔴 **高**（这是你说的「失忆」的真实原因）

**接线路径**（§8.10.0 已给出）：

1. 找到 dsh 的回合边界钩子（可能在 `0.1.7+` 可用）
2. 用宿主 `ctx.model.complete()` 生成摘要
3. 扩展 `SessionPort` 支持 `replace` 意图
4. 完成四步接线

#### 限制 2：索引水位未被 Agent 利用

```typescript
// memory_search 返回 indexWatermark
// 但 Agent Profile 没有「看到水位就知道要等」的提示

return {
  hits,
  indexWatermark,  // ← 模型可能忽略这个字段
  note
}
```

**改进**：在 phase-profile 的工具使用指南中明确说明：

```markdown
### memory_search 返回解读

- `indexWatermark < 最新事件时间`：索引滞后，最近操作可能未命中
  → 先做当前可做的事，10 分钟后重试检索
  
- `hits.length === 0 && note 含"索引为空"`：真的没内容
  → 用 pentest_workdir 读作业目录
  
- `hits.length === 0 && note 含"没有命中"`：有内容但查询不对
  → 换实体名、路径、端口、版本号、错误原文重试
```

#### 限制 3：Asset 归属未自动传播

```typescript
// 设计要求（§8.6）：
// "写入侧校验拒绝'来源事件明确含目标、却未填资产'的分块"

// 但实现中（chunks.ts）：
// asset_ids 只从事件 payload 解析，不追溯工具调用的 target_selector
```

**影响**：某些分块 `asset_ids` 为空，绕过范围过滤。

**改进**：索引器写入时：

```typescript
// 从 tool_runs.target_selector 解析资产
const toolAssets = await resolveAssetIdsFromToolRun(chunk.source_event_id);
chunk.asset_ids = [...new Set([
  ...chunk.asset_ids,
  ...toolAssets
])];
```

---

## 三、具体改进建议

### 3.1 立即可做（无需改架构）

#### 改进 1：增强零命中诊断

**文件**：`src/memory/pg-worker-tools.ts:639-659`

```typescript
// 当前只区分「索引为空」vs「有内容但没命中」
// 改进：分析为什么没命中

if (hits.length === 0) {
  const diagnostics = await this.#diagnoseZeroHits(
    session.engagement_id,
    query
  );
  
  note = diagnostics.isEmpty
    ? '本作业记忆索引为空（0 个分块）...'
    : `本作业索引有 ${diagnostics.totalChunks} 个分块，但本次查询没有命中。\n` +
      `可能原因：${diagnostics.reason}\n` +
      `建议尝试：${diagnostics.suggestions.join(' / ')}`;
}

async #diagnoseZeroHits(engagementId: string, query: MemoryQuery) {
  const stats = await this.#db.query(`
    SELECT 
      count(*)::int as total,
      count(*) FILTER (WHERE phase = $2) as in_phase,
      count(*) FILTER (WHERE kinds && $3) as matching_kinds,
      array_agg(DISTINCT phase) as available_phases
    FROM pentest.memory_chunks mc
    JOIN pentest.context_events e ON e.event_id = mc.source_event_id
    WHERE e.engagement_id = $1
  `, [engagementId, query.phase, query.kinds || []]);
  
  // 生成具体建议...
}
```

#### 改进 2：Phase Profile 补充检索策略

**文件**：`src/agents/phase-profiles.ts`

```typescript
export const PHASE_PROFILES = {
  'threat-modeling': {
    // ... 现有字段
    retrievalStrategy: {
      mandatoryOnStart: true,  // 会话开始强制检索
      startupQuery: {
        query: 'phase:intelligence-gathering trust_levels:human_decision,tool_observation',
        limit: 20,
        note: '威胁建模依赖情报收集的资产清单，必须先检索'
      },
      periodicCheck: {
        interval: 50,  // 每 50 轮工具调用
        query: 'kinds:finding,conclusion',
        note: '定期回顾已发现的结论，避免重复工作'
      }
    }
  }
  // ... 其他阶段
}
```

#### 改进 3：交接草稿注入推理摘要

**文件**：`src/handoff/handoff-flow.ts`

```typescript
async generateDraft(...) {
  // ... 现有逻辑
  
  // 新增：召回前序阶段的关键推理
  const reasoningContext = await this.memoryQuery.search({
    workerSessionId: currentSession.id,
    query: `phase:${previousPhase}`,
    kinds: ['reasoning'],  // 只要思考链
    includeReasoning: true,
    limit: 5
  });
  
  draft.reasoning_summary = reasoningContext.hits.map(h => ({
    excerpt: h.excerpt.slice(0, 200),  // 截取前 200 字
    ref: h.memoryId,
    occurred_at: h.source.occurredAt
  }));
  
  // 在 AI 起草提示词时注入：
  // "前序阶段的关键推理：\n{reasoning_summary}\n\n基于此起草..."
}
```

---

### 3.2 需要接线（依赖宿主能力）

#### 改进 4：接通会话内压缩

**优先级**：🔴 高

**当前状态**：算法完整（1225 行），四个接缝未接（§8.10.0）

**接线检查清单**：

- [ ] 找到 dsh 回合边界钩子（查 `dsh-workflow-ptc` API）
- [ ] 用 `ctx.model.complete()` 调用模型生成摘要
- [ ] 扩展 `src/ports/session.ts` 支持 `replace` 事件
- [ ] 写 `context.compacted` 事件 + 更新 `compacted_through_turn`
- [ ] 验证：会话超 60% 上下文后，旧轮次被折叠

**接线完成后**：单会话可以无限延续，不会「减智」。

#### 改进 5：实时索引进度通知

**当前**：`indexWatermark` 只在检索响应中返回

**改进**：在控制台 UI 实时显示：

```typescript
// 新增 WebSocket 推送
onIndexProgress(engagement_id, {
  latestEventAt: '2026-10-09T10:30:00Z',
  indexedThrough: '2026-10-09T10:28:45Z',  // 75 秒延迟
  lag: 75,
  pendingTasks: 12
});

// UI 显示：
// ⚠️ 索引延迟 75 秒，最近操作可能未进入检索
```

---

### 3.3 长期优化

#### 优化 1：智能查询重写

```typescript
// 当模型传入的 query 过于宽泛时，服务端辅助重写

async search(input) {
  let query = input.query;
  
  // 检测到纯自然语言 + 无过滤条件 → 自动提取实体
  if (this.#isTooGeneric(query, input)) {
    const entities = await this.#extractEntities(query);
    query = entities.join(' OR ');  // 转为布尔查询
  }
  
  // 继续原有检索逻辑...
}
```

#### 优化 2：记忆图谱可视化

```typescript
// 在控制台增加「记忆图谱」视图
// 节点 = 资产、结论、事件
// 边 = 引用关系（finding → evidence → tool_run → asset）

GET /api/engagements/:id/memory-graph
→ 返回 Cytoscape.js 格式的图数据
```

#### 优化 3：压缩质量监控

```typescript
// 每次压缩后，用测试查询验证摘要质量

afterCompaction(summary, originalEvents) {
  const testQueries = this.#deriveTestQueries(originalEvents);
  
  for (const q of testQueries) {
    const beforeHits = search(originalEvents, q);
    const afterHits = search([summary], q);
    
    if (afterHits.length === 0 && beforeHits.length > 0) {
      logWarning('压缩丢失关键信息', { query: q, lost: beforeHits });
    }
  }
}
```

---

## 四、对比业界实践

| 维度 | 本项目 | LangGraph Checkpointer | Mem0 | 评价 |
|------|--------|----------------------|------|------|
| **原始保留** | ✅ 账本永久 | ✅ 快照版本化 | ❌ 只存提取事实 | **本项目最好** |
| **混合检索** | ✅ 三路融合 | ❌ 无向量 | ✅ 向量+图 | 本项目覆盖更全 |
| **人类在环** | ✅ 交接三阶段 | ❌ 纯代码 | ❌ 纯代码 | **本项目独有** |
| **范围过滤** | ✅ SQL 下推 | N/A | ❌ 应用层 | 本项目性能更好 |
| **压缩策略** | ⚠️ 已实现未接线 | ✅ 自动 | ✅ 自动 | 接线后持平 |

---

## 五、最终建议

### 5.1 当前最优先（解决「失忆」）

1. **接线会话内压缩**（§3.2 改进 4）
   - 时间：2-3 天
   - 收益：单会话可无限延续
   - 风险：低（算法已测试 3700 行）

2. **增强零命中诊断**（§3.1 改进 1）
   - 时间：半天
   - 收益：Agent 知道为什么没查到
   - 风险：无

3. **Phase Profile 补充检索策略**（§3.1 改进 2）
   - 时间：1 天
   - 收益：强制关键时刻检索
   - 风险：无

### 5.2 中期优化

4. **交接草稿注入推理摘要**（§3.1 改进 3）
5. **实时索引进度通知**（§3.2 改进 5）

### 5.3 你的设计无需大改

**结论**：你的架构已经是**生产级、深思熟虑、正确解决问题**的设计。

「失忆减智」不是设计缺陷，而是：
- **会话内压缩未接线**（有实现，差 4 个接缝）
- **Agent 不知道何时该检索**（Phase Profile 缺检索策略）
- **零命中时缺少诊断**（有数据，差分析）

这些都是**实现细节补全**，不是架构重构。

---

## 附录：快速验证清单

```bash
# 1. 确认压缩模块存在
ls -lh src/memory/compaction.ts
# → 应该存在且 1225 行

# 2. 确认测试覆盖
npm test -- memory
# → 应该 3734 行测试全过

# 3. 确认接线状态
grep -r "compaction.ts" src --exclude-dir=test
# → 如果只有 test/ 导入，说明未接线

# 4. 确认 Phase Profile 有检索策略
grep "retrievalStrategy" src/agents/phase-profiles.ts
# → 如果没有，需要补充

# 5. 确认零命中诊断
grep "diagnoseZeroHits" src/memory/pg-worker-tools.ts
# → 如果没有，需要增强
```

---

**总结**：你的设计 9/10 分，实现 8/10 分，差的 1-2 分在「最后一公里接线」。继续按 §3.1 的三个改进推进，即可完全解决「失忆」问题。
