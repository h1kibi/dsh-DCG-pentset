# 设计缺陷修复行动计划

**基于**：DESIGN-AUDIT-FINDINGS-2026-10-10.md  
**范围**：工具契约、skill 机制、阶段感知工具能力  
**时间**：0.2.0 版本计划

---

## 第一阶段：快速修复（v0.2.0-alpha，2-3 周）

### 任务 1: additionalProperties 统一

**目标**：所有工具参数 schema 都显式声明 `additionalProperties: false`

**变更集**：
- [ ] `src/tools/worker.ts`
  - [ ] memory_search 参数对象加 additionalProperties:false
  - [ ] artifact_read 参数对象加 additionalProperties:false
  - [ ] pentest_workdir 的 path 不需要（string 类型）
  - 其他工具参数逐个检查

**验证**：
- [ ] 参数拼错时会报错而非被忽略（测试用例）
- [ ] 现有工具测试不能失败

**风险**：无，向后兼容（只是更严格了）

---

### 任务 2: ErrorCode 详细化（schema 层修复）

**目标**：让参数验证失败的错误消息包含修复建议

**变更集**：
- [ ] `src/execution/techniques.ts`
  - [ ] buildStructuredIntent 参数错误时加入 expected_values
  - [ ] 枚举值不匹配时列出允许值

示例：
```
之前：technique=http_get 参数 scheme 取值不在允许集合内：xyz
之后：technique=http_get 参数 scheme 取值不在允许集合内：xyz
     （只允许：http、https、auto）
```

- [ ] `src/contracts.ts`
  - [ ] ToolError 添加可选字段 `expected_values?: string[]`

**测试**：
- [ ] 参数值错误的测试用例

**风险**：低，向后兼容（只是扩字段）

---

### 任务 3: Technique 参数对拍

**目标**：确保 RECON_TECHNIQUES/VULN_TECHNIQUES 与模板注册的参数一致

**变更集**：
- [ ] `test/action-templates.test.ts`
  - [ ] 新增测试：遍历所有 technique，调用 buildStructuredIntent 再 validateParams
  - [ ] 确保参数通过两层校验

- [ ] `src/execution/techniques.ts`
  - [ ] 如果参数不一致，修正

**风险**：低，测试先行发现漂移

---

### 任务 4: loadSkill 错误诊断

**目标**：让 loadSkill 的负面情况返回更准确的 refusal

**变更集**：
- [ ] `src/memory/pg-worker-tools.ts`
  - [ ] 第 481-501 行已修复（P0-1）
  - [ ] 增加测试覆盖这些路径

- [ ] `src/memory/pg-worker-tools.ts` parseSkillFreeze
  - [ ] 如果冻结数据格式错误，返回显式错误而非 []
  - [ ] 加版本检查（冻结格式如果改过，能够协商）

**风险**：中，可能改变旧会话的行为（需要向后兼容路径）

---

### 任务 5: 工具可见性 + 阶段感知

**目标**：提示词准确反映工具在当前阶段的有效类别

**变更集**：
- [ ] `src/agents/dsh-session-factory.ts`
  - [ ] renderSandboxBrief 时，用 effectiveActionClass 代替 declared actionClass
  - [ ] 为 vulnerability-analysis 阶段的 pentest_scan 正确生成参数指南

已做：sandbox-brief.ts 第 194 行加上 pentest_scan 条件

**风险**：低，只是提示词优化

---

## 第二阶段：架构改进（v0.2.0-beta，4-6 周）

### 任务 6: 参数白名单单一事实源

**目标**：技术参数的定义在 techniques.ts 中，模板中只引用

**设计**：
```typescript
// techniques.ts 中定义完整的参数规范
export interface TechniqueSpec {
  defaults: Record<string, ParamValue>,
  required: string[],
  enums: Record<string, string[]>,
  ranges?: Record<string, { min?: number; max?: number }>,
  // 新增：
  documentation?: Record<string, string>,
  applicablePhases?: Phase[],
}

// templates.ts 中只引用 technique 名
// 执行时动态查询该 technique 的参数规范
```

**变更集**：
- [ ] 拆分 techniques.ts 和 templates.ts 的职责
- [ ] 建立参数规范的单一查询点

**影响**：中等规模重构，需要修改 buildStructuredIntent 和 validateParams

---

### 任务 7: Skill 跨阶段依赖图

**目标**：编译时或加载时检测 skill 的引用依赖

**设计**：
```typescript
// 编译时（CI/CD）
// 扫描每个 skill 的 SKILL.md，找 "见 xxx skill" 的引用
// 检查 xxx 是否属于当前阶段或必需的全局 skill

// 运行时
// loadSkill 返回时，提取 body 中的技能引用，校验是否都在 loadedNames 中
```

**变更集**：
- [ ] `scripts/` 添加 skill-dependency-checker.ts
- [ ] `src/memory/pg-worker-tools.ts` loadSkill 加依赖检查

**风险**：中，需要定义"引用 skill"的识别规则

---

### 任务 8: Skill 快照生命周期规范化

**目标**：明确 skill_freeze 的生命周期、版本管理、升级路径

**变更集**：
- [ ] `docs/` 新增 skill-snapshot-lifecycle.md
- [ ] `src/workflow/core.ts` freezeSkills 改用 SELECT...FOR UPDATE
- [ ] `src/memory/pg-worker-tools.ts` parseSkillFreeze 加版本兼容

**风险**：低，只是文档 + 防御性编程

---

## 第三阶段：长期架构演进（v0.3.0+）

### 任务 9: 工具契约 DSL

**目标**：定义一个可执行的工具契约语言，同时支持参数约束和阶段感知

**设计思路**：
- 参考 OpenAPI 3.0（JSON Schema）
- 或用 TypeScript 本身作为 DSL（代码即文档）

示例：
```typescript
export const http_probe_tool = {
  name: 'http_probe',
  technique: 'recon',
  applicablePhases: ['intelligence-gathering', 'threat-modeling'],
  parameters: {
    port: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 65535,
      default: 80,
    },
    scheme: {
      type: 'enum' as const,
      values: ['http', 'https', 'auto'],
      default: 'auto',
    },
    verify_tls: {
      type: 'boolean',
      default: true,
    },
  },
} as const;
```

---

## 优先级排序与时间线

| 任务 | 阶段 | 难度 | 优先级 | 周数 |
|---|---|---|---|---|
| 1. additionalProperties 统一 | 快 | 低 | High | 0.5 |
| 2. ErrorCode 详细化 | 快 | 低 | High | 0.5 |
| 3. Technique 参数对拍 | 快 | 低 | High | 1 |
| 4. loadSkill 诊断改进 | 快 | 中 | High | 1 |
| 5. 工具可见性优化 | 快 | 低 | High | 0.5 |
| **小计** | | | | **3.5 周** |
| 6. 参数白名单单一源 | 中 | 中 | Medium | 3 |
| 7. Skill 依赖图 | 中 | 中 | Medium | 2 |
| 8. Skill 快照生命周期 | 中 | 低 | Medium | 1 |
| **小计** | | | | **6 周** |
| 9. 工具契约 DSL | 长 | 高 | Medium | 8 |

---

## 验收标准

### v0.2.0-alpha（快速修复完成）

- [ ] 所有工具参数都有 additionalProperties:false
- [ ] 参数错误的消息包含期望值或范围
- [ ] technique 参数与模板的一致性有测试保证
- [ ] loadSkill 的五类负面情况都有清晰的 refusal 消息
- [ ] 提示词准确反映工具的有效 actionClass

### v0.2.0-beta（架构改进完成）

- [ ] 参数规范单一事实源已建立
- [ ] skill 引用依赖有编译期检查
- [ ] skill 快照生命周期文档完整且可验证
- [ ] 无新 bug 导入（回归测试通过）

### v0.3.0（长期演进）

- [ ] 工具契约 DSL 已定义
- [ ] 所有工具都用新 DSL 重新注册
- [ ] dsh schema DSL 或 JSON Schema 支持已有

---

## 关键指标

**衡量修复是否成功**：

1. **用户诊断时间**：参数错误时，模型能在 1 轮对话内自我纠偏（不需要看文档）
2. **测试覆盖**：工具参数和 skill 装载的 flaky test 降为 0
3. **代码复杂度**：工具层 / 校验层 / 契约层的职责边界清晰（可以单独审视）
4. **文档一致性**：design doc / code / test 三处的参数约束无漂移

