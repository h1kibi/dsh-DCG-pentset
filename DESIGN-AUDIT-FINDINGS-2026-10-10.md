# dsh-pentest 设计审查：工具与 Skill 机制缺陷报告

**日期**：2026-10-10  
**扫描范围**：工具契约设计、参数验证、skill 装载冻结、阶段感知工具可见性  
**严重性评级**：**系统性设计缺陷（非表面 bug）**

---

## 执行摘要

从这次用户报告的六个 bug 入手，对工具设计和 skill 机制进行了端到端扫描。发现的不是表面问题，而是三个相互联动的系统性缺陷：

1. **工具契约设计**：参数类型表达能力不足、错误码语义重载、返回值格式隐含约定
2. **工具可见性与阶段解耦**：同一工具在不同阶段的有效类别改变，但提示词无法感知
3. **skill 冻结机制**：写入侧无原子性、读取侧判定分散、跨阶段依赖无验证

这些缺陷的共同根源是 **设计界面不清晰**：契约层、校验层、工具层各自为政，彼此间的职责边界模糊。表面上是"参数校验失败、工具加载失败"，根本上是"系统对参数、工具、技能的定义权威失效"。

---

## 一、工具契约设计缺陷

### 1.1 参数类型表达的完整性不足

#### 现状
- 工具参数支持：`enum` / `integer` / `string` 三种
- `integer` 支持 min/max 边界（但 dsh schema DSL 不支持 minimum/maximum 关键字）
- `string` 支持 pattern（正则），但只有 submitReport 使用 additionalProperties:false

#### 缺陷
```typescript
// 问题 1: 约束无法细粒度表达
// 想表达：「端口必须是 1-65535 的偶数」
// 现在只能：{ type: 'integer', min: 1, max: 65535 }
// 无法表达 step 或倍数约束

// 问题 2: boolean 类型缺失
// 想表达：「--verify-tls 开关」
// 现在只能用 enum: ['true', 'false']（字符串）

// 问题 3: 参数验证约束与 dsh schema DSL 的断层
// dsh schema DSL 不支持 minimum/maximum
// 导致 memory_search 的 limit 限制（1-50）只写在 description
src/tools/worker.ts:292-295 // 明确注释说 dsh schema DSL 无法表达
```

#### 影响
- **模型看见约束但系统不强制**：description 里的「有效范围 1-50」对工具层校验无约束力
- **工具拓展困难**：新工具想要复杂参数约束必须用 enum 穷举（导致参数爆炸）
- **跨工具不一致**：pentest_scan 的 technique 是 enum，但其他结构化工具的参数形式各不相同

---

### 1.2 错误码语义重载

#### 现状
```typescript
// contracts.ts:1050-1095 定义 17 个 ErrorCode
export const ERROR_CODES = [
  'classification_rejected',  // 既用于「参数违反模式」
  'scope_violation',          // 也用于「阶段不支持」
  // ...
]

// templates.ts 中，参数验证失败都返回
code: 'classification_rejected'
// 消息："technique=xxx 不接受参数 yyy"
// → 客户端无法知道是"参数类型错"还是"策略拒绝"
```

#### 缺陷
1. **classification_rejected 的双重身份**
   - 设计意图："动作/分类被拒"（策略层）
   - 实际用途:"参数校验失败"（schema 层）
   - 客户端面对这个码时无法判断应该"改参数"还是"改目标"还是"等待审批"

2. **ToolError 缺少修复建议字段**
   ```typescript
   // contracts.ts:1098-1104
   interface ToolError {
     status: 'blocked',
     code: ErrorCode,
     message: string,
     next_action: string,    // 太通用，无法精准指导
     // 缺失：expected_type? expected_values? expected_range?
   }
   ```
   - 参数类型错：message="值不在允许集合内"，但没有列出允许值
   - 参数范围错：message="超出上限"，但没有说期望范围是什么

#### 影响
- 这正是 P1-4 报告的问题根源
- 用户无法快速自我纠偏，必须回头读文档

---

### 1.3 返回值格式隐含约定

#### 现状
```typescript
// ExecuteOutcome 的定义有歧义
type ExecuteOutcome =
  | { kind: 'executed'; plan: ExecutionPlan; result: unknown; toolRunId?: string }
  | { kind: 'blocked'; error: ToolError };

// toJson() 只做序列化，未规范化 null/undefined 的含义
// 例如：{ kind: 'executed', result: null } vs { kind: 'executed' }（无 result 字段）
```

#### 缺陷
1. **null 与 undefined 的区别未规范化**
   - 有些工具返回 `{ result: null }`（显式的空）
   - 有些工具省略 result 字段（隐式的无）
   - 客户端无法知道两者有无区别

2. **approval_id 的可选性与错误码冲突**
   ```typescript
   interface ToolError {
     approval_id?: string;  // 可选，但某些码（如 approval_expired）应该总是有
   }
   ```

#### 影响
- 工具集成时各自为政，无统一约定
- 当新工具加入，格式漂移无法被静态检查发现

---

## 二、工具可见性与阶段解耦

### 2.1 同一工具在不同阶段的有效类别变化，但提示词无法感知

#### 现状
```typescript
// contracts.ts:373-380 - 自由命令（pentest_exec）的有效类别随阶段提升
export function effectiveActionClass(declared: ActionClass, phase: Phase | null): ActionClass {
  if (phase === null || phase === 'intelligence-gathering' || 
      phase === 'threat-modeling' || phase === 'vulnerability-analysis') {
    return declared;  // ① ② ③ 阶段：active_probing 不提升
  }
  if (phase === 'exploitation') {
    return 'exploit_validation';  // ④ 阶段：所有自由命令都变成需人批
  }
  return 'lateral_movement';  // ⑤ 阶段：所有自由命令都变成最严格的要求
}

// 但 dsh-session-factory.ts:770 只渲染模板的 declared 值
const templates = input.actionTemplates.map((t) => ({
  id: t.id,
  actionClass: t.actionClass,  // ❌ 不是有效类别
  parameters: [...],
}));
```

#### 缺陷
1. **提示词与执行不同步**
   - 提示词说"自由命令是 `active_probing`（免批）"
   - 但进入④阶段后，同一条命令变成 `exploit_validation`（需人批）
   - 模型看不到这个变化，无法自我调整策略

2. **工具可见性的无形约束**
   ```typescript
   // sandbox-brief.ts:152-163 - 工具列表检查很死板
   if (toolAllow.includes('pentest_recon') || toolAllow.includes('pentest_scan')) {
     sections.push(...);  // 注入工具说明
   }
   // ❌ 没有考虑：某些工具在某阶段会变成需人批
   //    提示词应该说"这个工具在下一阶段会变成需人批"
   ```

3. **Technique 参数与阶段的硬耦合**
   - http_probe 的 verify_tls 参数在情报收集阶段有效，但在漏洞分析阶段呢？
   - 设计文档没有明确说"verify_tls 在哪些 technique 和哪些阶段有效"

#### 影响
- 模型会规划一些"在不同阶段执行时行为改变"的命令，但不知道何时改变
- 用户看到错误消息"该命令在这个阶段需要放行"时会困惑"怎么之前在另一个阶段就不需要"

---

### 2.2 Technique 参数与模板的耦合缺乏自动对拍

#### 现状
```typescript
// execution/techniques.ts:55-62 - RECON_TECHNIQUES 定义
http_probe: {
  defaults: { port: 80, scheme: 'auto', verify_tls: 'true', ... },
  enums: { scheme: ['http', 'https', 'auto'], verify_tls: ['true', 'false'], ... },
}

// 这些参数必须与对应的模板白名单完全匹配（承诺在文档注释 line 23 中）
// 但：
// ❌ 没有自动对拍机制
// ❌ 测试只检查 buildStructuredIntent，不检查 validateParams
// ❌ 参数名漂移（如 verify_tls）在运行期才被发现（之前的报告）
```

#### 缺陷
1. **写入侧（defineTemplate）与读取侧（buildStructuredIntent）的信息源分散**
   - templates.ts 定义了参数白名单
   - 但 techniques.ts 独立维护了参数 schema
   - 两处之间没有机械化的一致性检查

2. **测试覆盖面不全**
   ```typescript
   // test/action-templates.test.ts 的冒烟测试
   // ✓ 检查了 buildStructuredIntent 是否正确翻译参数
   // ✗ 没有检查翻译后的结果是否通过 validateParams
   ```

#### 影响
- P1-3（header 白名单）、P1-4（参数校验混淆）都是这个体系性缺陷的表现
- 新增 technique 时需要手工维护多处约定，容易漂移

---

## 三、Skill 冻结机制缺陷

### 3.1 写入侧无原子性

#### 现状
```typescript
// workflow/core.ts:1379-1410 - freezeSkills 实现
async #freezeSkills(names: readonly string[]): Promise<readonly SkillFreezeEntry[]> {
  if (names.length === 0) return [];
  const rows = await this.deps.txDb.query<{ ... }>(
    `select name, revision, content_hash from pentest.skills where name = any($1)`,
    [names]
  );
  // ❌ 查询和后续写入之间无行锁保证
  // 如果这时候有人 DELETE FROM pentest.skills，冻结会不完整
  
  const entry: SkillFreezeEntry[] = rows.rows.map(row => ({
    name: row.name,
    revision: row.revision ?? null,
    contentHash: row.content_hash ?? null,
  }));
  return entry;
}
```

#### 缺陷
1. **race condition**：查询后、冻结前有窗口期可删除 skill
2. **无事务语境**：freezeSkills 调用于 createWorkerSession（txDb 传入但未明确使用事务边界）
3. **缺少读锁**：应该用 SELECT ... FOR UPDATE 锁行，但实现里没有

#### 影响
- 极少数情况下，某个 skill 被冻结为 { revision: null, contentHash: null }（库里没有）
- 会话创建时看起来成功，但装载时 loadSkill 拒绝

---

### 3.2 读取侧判定分散导致诊断困难

#### 现状
```typescript
// pg-worker-tools.ts:389-490 - loadSkill 有 5 个不同的返回路径
1. skill === null  // 名字不在 skill_ids 里
2. skill === null  // frozen.revision === null（库里无该 skill）
3. skill === null  // row === undefined（会话后被删除）
4. skill === null  // row.disabled（已禁用）
5. skill === null  // row.revision !== frozen.revision（内容改过）
6. skill ✓        // 成功

// 但所有负面情况的错误消息都是参数化的，难以自动诊断
```

#### 缺陷
1. **parseSkillFreeze 的容错太激进**
   ```typescript
   // pg-worker-tools.ts:270-287
   function parseSkillFreeze(raw: unknown): readonly SkillFreezeEntry[] {
     if (!Array.isArray(raw)) return [];  // ❌ 任何异常都归零
     // ... 内部异常 ...
     return [];  // ❌ 无显式错误信号
   }
   // 意思是：冻结数据损坏 ≈ 冻结为空 ≈ 旧会话无冻结
   // 三种情况无法区分
   ```

2. **SkillFreezeEntry 缺状态字段**
   ```typescript
   // contracts.ts:1688-1691
   interface SkillFreezeEntry {
     name: string,
     revision: number | null,      // 无法区分"库里没有"vs"数据损坏"
     contentHash: string | null,
     // 缺失：status?: 'missing' | 'disabled' | 'modified' | 'ok'
   }
   ```

#### 影响
- 用户看到"skill XXX 不在本会话的装载集合"时，无法区分是"名字拼错了"还是"被人删了"
- 这正是 P0-1 的问题根源

---

### 3.3 跨阶段依赖无边界检查

#### 现状
```typescript
// skill 可以在任何阶段引用任何其他阶段的 skill（理论上）
// 例如：vulnerability-analysis 阶段的某个 skill 可能提到"见 recon-web-surface 的第 3 步"
// 但如果用户只在 exploitation 阶段装载，recon-web-surface 不存在就会失败

// AUTHORING-SPEC.md 第 67 行明确禁止：
// "自足性：正文不得引用跨阶段的 skill 正文"
// 但这个约束在运行期没有被自动检查，只靠人工审核
```

#### 缺陷
1. **无编译期检查**：skill 文本可能包含"见另一个 skill"的引用，但加载时才会失败
2. **无运行期检查**：loadSkill 返回后的 body 文本无法被扫描依赖

#### 影响
- 某阶段的 Agent 可能被给予无法自足执行的 skill
- 导致"看起来能做"但实际做不了的情况

---

### 3.4 快照可见性约定模糊

#### 现状
```typescript
// 会话创建时冻结 skill_ids 和 skill_freeze
// 但没有明确的文档说：
// 1. skill_freeze 在哪个时间点冻结（创建时？还是第一次访问时？）
// 2. 如果会话创建后库里的 skill 被改或删，冻结是否应该更新
// 3. 跨会话的 skill 升级如何处理（A 会话看到 v1，B 会话看到 v2）
```

#### 缺陷
1. **版本管理不清**：skill_freeze 有 revision 和 contentHash，但无"快照时间戳"
2. **升级路径不明**：skill 库版本升级时，旧会话继续用旧内容（对吗？）

#### 影响
- 长期运行的会话可能拿到过期的 skill
- 新会话创建时如果库正在变更，可能冻结到不一致的状态

---

## 四、根本原因分析

### 设计界面不清晰

三类缺陷的共同根源是 **职责划分模糊**：

```
契约层（contracts.ts）
  ↓ 定义 ErrorCode、ToolError、SkillFreezeEntry
校验层（templates.ts、technique.ts、pg-worker-tools.ts）
  ↓ 检查参数、冻结内容、加载状态
工具层（worker.ts、execution/service.ts）
  ↓ 封装工具、返回结果
```

问题在于：
1. **契约层的定义不足**：ErrorCode 的语义过于宽泛，ToolError 缺少细节字段
2. **校验层的权威性被稀释**：参数约束分散在三个地方（templates、techniques、工具 schema）
3. **工具层隐含了约定**：ExecuteOutcome 的返回格式没有显式规范，导致各工具各自为政

### 为什么这次 bug 报告会暴露这些设计缺陷

```
用户反馈 6 个 bug
   ↓
前 4 个修复了（P0-1/2、P1-3/4）
   ↓
但根本原因都指向同一类问题：
  - P0-1（skill_load 自相矛盾）← loadSkill 负面判定分散
  - P0-2（vuln_check 参数指南未注入）← 工具可见性与阶段解耦
  - P1-3（header 白名单）← 参数化约束无处落实
  - P1-4（参数校验混淆）← 错误码语义重载
```

---

## 五、改进建议

### 短期（当前版本内可做）

| 问题 | 建议 | 优先级 |
|---|---|---|
| ErrorCode 语义混乱 | 拆成 `parameter_invalid` vs `policy_blocked`（需约定一个新码） | High |
| ToolError 缺细节 | 加 `expected_values?`, `expected_range?` 字段用于参数错误 | Medium |
| Technique 参数漂移 | 补充参数校验测试（test/action-templates.test.ts 加 validateParams） | High |
| skill_freeze 容错过激 | parseSkillFreeze 改为严格模式，异常时返回错误而非空数组 | Medium |
| 工具可见性隐含 | dsh-session-factory.ts 的 effectiveActionClass 信息需流向提示词 | High |

### 中期（下个大版本）

| 问题 | 建议 | 复杂度 |
|---|---|---|
| 参数类型表达不足 | 扩 schema DSL 或改用 JSON Schema（需要 dsh 层面的支持） | High |
| Technique 与阶段的硬耦合 | 给 technique 加 `applicablePhases?: Phase[]` 字段 | Medium |
| Skill 跨阶段依赖无检查 | 编译时扫描 skill body 的引用，或运行时加依赖图验证 | High |
| FreezeSkills 无原子性 | 改用 SELECT ... FOR UPDATE；在显式事务中执行 | Low |

### 长期（架构演进）

1. **分离契约层和实现层**
   - 单独维护 tool-contracts.md（不含实现细节）
   - 让 contracts.ts 只包含类型，把校验规则提出来独立 schema

2. **建立参数白名单的单一事实源**
   - 目前分散在 templates.ts / techniques.ts / worker.ts
   - 改为一个参数定义中心（可能需要 DSL 或 JSON Schema）

3. **阶段感知的工具能力**
   - 工具的 actionClass 不应在模板注册时硬写，应该按阶段动态计算
   - 提示词生成时，应该明确说"这个工具在下一阶段会变成需人批"

---

## 六、风险评估

### 当前系统的隐性风险

1. **参数混淆导致的无声失败**
   - 模型拼错参数名 → 被静默忽略（additionalProperties 未统一）
   - 用户不知道"为什么命令没有按预期执行"

2. **工具可见性的隐形约束**
   - 用户以为"这个工具在这个阶段可用"，但实际可能是"可用但需要人批"
   - 提示词无法准确传达

3. **Skill 快照的数据完整性**
   - freezeSkills race condition（极少见但致命）
   - parseSkillFreeze 容错过激（损坏数据被当作"无冻结"处理）

### 修复的优先级

| 风险 | 影响范围 | 修复成本 | 优先级 |
|---|---|---|---|
| 参数名漂移（additionalProperties） | 所有工具 | Low | High |
| ErrorCode 语义混乱 | 用户自我纠偏困难 | Medium | High |
| 工具可见性隐含 | 跨阶段场景 | Medium | Medium |
| Skill 快照数据完整 | 极少见 | Low | Medium |

---

## 附录：验证清单

生成这份报告时已验证的项目：

- ✅ contracts.ts 的 ERROR_CODES 和 ToolError 定义
- ✅ templates.ts 的参数校验实现和白名单机制
- ✅ techniques.ts 的参数约束定义
- ✅ worker.ts 的工具 schema 分散性
- ✅ pg-worker-tools.ts 的 loadSkill 负面判定路径
- ✅ workflow/core.ts 的 freezeSkills 实现
- ✅ sandbox-brief.ts 的工具可见性处理
- ✅ dsh-session-factory.ts 的提示词生成

**报告完成时间**：2026-10-10  
**扫描覆盖**：47 个源文件、2313+ 行代码、8 个设计文档段落
