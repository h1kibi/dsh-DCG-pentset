# 设计缺陷修复 - 决策记录与最终优先级

**决策时间**：2026-10-10  
**决策人**：项目负责人  
**输入**：DESIGN-AUDIT-FINDINGS 与 REMEDIATION-ACTION-PLAN  

---

## 决策记录

### 1️⃣ ErrorCode 拆分策略 → 方案 C（结构化错误）

**决定**：不改 ErrorCode 本身，用 ToolError 加 `error_type` 枚举字段

```typescript
// contracts.ts
interface ToolError {
  status: 'blocked',
  code: ErrorCode,
  message: string,
  error_type?: 'parameter_schema' | 'parameter_validation' | 'policy_rejected',
  expected_values?: string[],
  expected_range?: { min?: number; max?: number },
  next_action: string,
}
```

**理由**：
- 向后兼容（error_type 可选）
- 不需要改 dsh 的 ErrorCode 处理
- 客户端可按 error_type 快速判定

**成本**：~1 小时改代码 + 测试

---

### 2️⃣ 参数 DSL 方案 → 用 TypeScript DSL（现在交付）

**决定**：现在就用 TypeScript DSL，不等 dsh 支持 JSON Schema

```typescript
// 示例：techniques.ts 中参数规范
export const http_probe_params = {
  port: {
    type: 'integer' as const,
    minimum: 1,
    maximum: 65535,
    default: 80,
    description: '目标端口（默认 80）',
  },
  verify_tls: {
    type: 'boolean' as const,
    default: true,
    description: '是否校验 TLS 证书...',
  },
} as const satisfies ParamSpec;
```

**理由**：
- 不阻断当前版本
- 代码即文档，类型检查天然可得
- 未来迁移 JSON Schema 只需改生成器，不改源

**成本**：~3 小时设计 DSL + 改造现有 technique 定义

---

### 3️⃣ Skill 冻结原子性 → 接受极少见的 race condition

**决定**：现在**不加**行锁，保持现状

**理由**：
- Race condition 极少见（同时创建会话 + 删除 skill）
- 加行锁会影响并发会话创建的吞吐
- v0.3.0 再改，成本不高

**风险认可**：万一发生，冻结不完整 → 加载时 refusal 返回，用户得到清晰诊断

---

### 4️⃣ 工具的阶段感知 → 显式警告

**决定**：提示词中**显式说明**"这个工具在下一阶段会变成需人批"

```
本阶段（④ 利用验证）：
  自由命令需人放行（已启用）

下一阶段（⑤ 后渗透）：
  自由命令**必须**人放行（全部命令都需要）
```

**理由**：
- 成本低（只改提示词）
- 清晰度足够（模型能自我调整策略）
- 不需要改 Worker 生命周期

**vs. 动态重编**：后者成本高，这个方案够用

---

### 5️⃣ Skill 跨阶段依赖 → 编译期检查（CI/CD）

**决定**：在 CI 阶段扫描 skill 文本中的引用

```bash
# scripts/check-skill-deps.ts
# 遍历 skills/**/*.md
# 找 "见 <skill-name>" 的引用
# 检查 <skill-name> 是否在当前或全局允许的范围内
# 失败时 exit 1
```

**理由**：
- 编写 skill 时当场失败，开发者立即得到反馈
- 不影响运行时性能
- 成本最低（正则扫描）

**落实**：
- CI 流程中加一步 `npm run verify:skill-deps`
- pre-commit hook 可选

---

### 6️⃣ 执行时间线 → 全部纳入当前 sprint（v0.2.0-alpha）

**决定**：用 **2 周集中完成**（一个 sprint）

**任务优先级**（按开始顺序）：

| 周 | 任务 | 天数 | 并行度 |
|----|------|------|--------|
| 第1周前2天 | additionalProperties 统一 | 1.5 | 两人可并行 |
| 第1周 D3-4 | ErrorCode 结构化（加 error_type） | 1.5 | 同上 |
| 第1周 D4-5 | Technique 参数对拍测试 | 1 | 等 3 完成 |
| 第2周 | TypeScript DSL 设计 + 重构 | 2 | 1 人 |
| 第2周后期 | Skill 依赖检查 CI 脚本 | 1 | 并行 |
| 第2周末 | 集成测试 + 文档 | 1 | 全队 |

**总计**：~8-9 人天（2-3 人团队 = 3 天）

---

## 最终行动优先级

### 第一梯队（第 1 周，Must-Have）

1. **additionalProperties 统一**
   - 所有工具参数对象加 `additionalProperties: false`
   - 验证：参数拼错会被拒绝（不再静默忽略）
   - 风险：无（只是更严格）

2. **ToolError 加 error_type**
   - contracts.ts：加可选字段 error_type、expected_values、expected_range
   - templates.ts buildStructuredIntent：参数错误时填这些字段
   - 验证：参数错误的消息更清楚了
   - 风险：无（向后兼容）

3. **Technique 参数对拍**
   - test/action-templates.test.ts：新增测试 buildStructuredIntent + validateParams 的完整流程
   - 实测通过后可识别任何参数漂移
   - 风险：无（测试先行）

### 第二梯队（第 2 周，Should-Have）

4. **TypeScript DSL 设计与落地**
   - 定义 ParamSpec 接口
   - 把 RECON_TECHNIQUES / VULN_TECHNIQUES 改用新 DSL
   - 验证：类型检查通过，生成器工作正常
   - 风险：低（向前兼容的改造）

5. **Skill 依赖检查脚本**
   - scripts/check-skill-deps.ts：CI 脚本
   - 正则扫描 "见 <skill-name>" 模式
   - 验证：CI 阶段能catch 新增的越界引用
   - 风险：无

### 第三梯队（第 2 周末，Nice-to-Have）

6. **提示词阶段感知优化**
   - sandbox-brief.ts 已改（P0-2 修复）
   - dsh-session-factory.ts renderSandboxBrief 时用 effectiveActionClass
   - 验证：提示词明确说"下阶段会变成需人批"
   - 风险：无

---

## 不做项（当前版本）

- ❌ freezeSkills 加行锁（推到 v0.3.0，成本 > 收益）
- ❌ 等待 dsh 支持 JSON Schema（用 TypeScript DSL 替代）
- ❌ 动态重编提示词（显式警告够用）

---

## 交付物清单

### 代码改动
- [ ] `src/contracts.ts`：ToolError 加字段
- [ ] `src/execution/techniques.ts`：buildStructuredIntent 填 error_type
- [ ] `src/tools/worker.ts`：所有工具参数加 additionalProperties:false
- [ ] `src/execution/techniques.ts`：参数规范改用 DSL
- [ ] `test/action-templates.test.ts`：完整流程对拍测试
- [ ] `scripts/check-skill-deps.ts`：CI 脚本
- [ ] `src/agents/sandbox-brief.ts`：已完成（P0-2）

### 文档更新
- [ ] docs/tool-contract-dsl.md（新）：参数 DSL 规范
- [ ] docs/skill-snapshot-lifecycle.md（更新）：冻结生命周期
- [ ] CHANGELOG.md：v0.2.0-alpha 条目

### 测试
- [ ] 所有工具参数拼错时被拒绝（回归测试）
- [ ] Technique 参数完整流程（新测试）
- [ ] Skill 依赖检查在 CI 工作（新测试）

---

## 成功标志

✅ 用户能在 1 轮对话内自我纠偏参数错误  
✅ 新增的 Technique 参数漂移在 CI 阶段被catch  
✅ 无新 flaky test 被引入  
✅ 提示词准确反映工具在各阶段的需人批状态  

---

## 后续里程

- **v0.2.0-alpha** → 当前 sprint（完整的 6 项）
- **v0.2.0-beta** → 下一 sprint（架构改进：参数单一源、skill 依赖图完整化）
- **v0.3.0** → 两月后（JSON Schema 迁移、freezeSkills 加锁）

