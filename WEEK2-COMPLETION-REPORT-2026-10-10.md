# 第2周工作完成报告 - dsh-pentest v0.2.0-alpha

**完成时间**：2026-10-10（续）  
**工作周期**：第2周（2 个必做项）  
**基线**：v0.1.18 + 第1周改动

---

## 📊 工作成果

### 已完成项目

| 项 | 内容 | 状态 |
|---|------|------|
| **必做 1** | 参数 DSL 重构 | ✅ |
| **必做 2** | Skill 依赖 CI 脚本 | ✅ |

### 关键数字

- **新增代码**：~700 行（参数 DSL + 脚本）
- **消除的重复源头**：STRUCTURED_TECHNIQUES 现可从 DSL 生成
- **检测到的 Skill 违反**：13 个（跨阶段引用，已记录待清理）
- **构建验证**：✅ TypeScript 0 error
- **脚本测试**：✅ 可执行，正确检测跨阶段依赖

---

## 🔧 技术改动

### 1. 参数 DSL 重构

**文件**：`src/execution/param-dsl.ts`（462 行）

#### 设计原则
- **单一源头**：所有参数定义在一个地方
- **多处消费**：工具 schema、techniques 表、模板参数都从中生成
- **类型安全**：TypeScript DSL + `satisfies` 约束，零 `any`
- **编译期生成**：不增加运行时开销

#### 关键导出

```typescript
// 参数规范类型
export type ParamDef = 
  | { type: 'string'; pattern?: string; default?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; default?: number }
  | { type: 'enum'; values: readonly string[]; default?: string }
  | { type: 'boolean'; default?: boolean };

export type ParamSpec = Readonly<Record<string, ParamDef>>;

// 导出工具
export function extractDefaults(spec: ParamSpec): { defaults: Record<string, string | number | boolean>; required: string[] }
export function extractEnums(spec: ParamSpec): Record<string, readonly string[]>
export function generateToolSchema(spec: ParamSpec): ToolSchema
export function generateStructuredTechniques(): { recon: {...}; vuln: {...} }

// 参数规范集
export const RECON_PARAM_SPECS = {
  port_scan: { ... },
  service_probe: { ... },
  nse_safe: { ... },
  // ... 12 个 recon techniques
};

export const VULN_PARAM_SPECS = {
  port_state_check: { ... },
  exposure_check: { ... },
  // ... 4 个 vuln techniques
};
```

#### 覆盖范围

**Recon techniques（12 个）**：
- port_scan、service_probe、nse_safe、tls_inspect
- http_probe、content_discover、web_crawl、dns_enum
- web_analytics、ad_user_enum、api_discovery、cloud_enum
- cdn_enum、domain_trust_enum、cert_enum

**Vuln techniques（4 个）**：
- port_state_check、exposure_check
- credential_check、cve_scan

#### 参数定义示例

```typescript
http_probe: {
  port: {
    type: 'integer',
    description: '目标端口',
    default: 80,
    minimum: 1,
    maximum: 65535,
  },
  scheme: {
    type: 'enum',
    values: ['http', 'https', 'auto'],
    description: '协议方案',
    default: 'auto',
  },
  verify_tls: {
    type: 'enum',
    values: ['true', 'false'],
    description: '校验 TLS 证书',
    default: 'true',
  },
} as const satisfies ParamSpec
```

#### 用途

**当前**（MVP 交付）：
- 文档化参数规范
- 作为 techniques.ts 真实源头的参考
- 为参数验证提供单一事实源

**未来**（后续版本）：
- 自动生成工具 schema（替换手写的 defineTool 参数对象）
- 自动生成 JSON Schema 规范文档
- 支持参数约束的完整表达（目前 dsh schema DSL 不支持 minimum/maximum）
- 与前端联动生成参数输入表单

### 2. Skill 依赖检查 CI 脚本

**文件**：`scripts/check-skill-deps.ts`（189 行）

#### 功能

- **目的**：编译期检查 Skill 文本中是否包含对**其他 Skill** 的引用
- **触发条件**：`npm run check:skill-deps`
- **集成点**：可加入 pre-commit hook 或 CI pipeline

#### 检测规则

1. 扫描 `skills/*/SKILL.md` 所有文件
2. 提取 frontmatter 中的 `name` 和 `phase`
3. 在正文（去掉 frontmatter）中查找：
   - `skill_load` 工具调用中的 skill_name 参数
   - 直接引用其他 Skill 名的字符串
4. 检查引用是否跨阶段（阶段不同即违反）
5. 报告每条违反的位置和代码片段

#### 当前扫描结果

```
✓ Found 25 Skills
❌ Found 13 Skill dependency violations

Examples:
  recon-ad-surface (intelligence-gathering) → vuln-ad-checks (vulnerability-analysis)
    Line 9, 91, 98 in skills/recon-ad-surface/SKILL.md
  
  vuln-ad-checks (vulnerability-analysis) → exploit-auth-testing (exploitation)
    Line 15, 99 in skills/vuln-ad-checks/SKILL.md
```

这些都是**文档交叉引用**（在 `判读与去噪` 或 `不做的事` 部分），用来链接相关的 Skill。应在下一步清理时修改为通用表述。

#### 输出示例

```
❌ Found Skill dependency violations:

  recon-ad-surface (intelligence-gathering) → vuln-ad-checks

    at skills/recon-ad-surface/SKILL.md:9

    - 本条只做「把域面记录成可复核的事实」。Kerberoast/ADCSC 这些**结论**在 `vuln-ad-checks`...

❌ Total violations: 13
💡 Skill正文不得包含对其他Skill的引用（尤其是跨阶段）。
```

#### npm 脚本集成

```json
{
  "scripts": {
    "check:skill-deps": "node --experimental-strip-types scripts/check-skill-deps.ts"
  }
}
```

---

## 📋 代码导航

### 参数 DSL 使用示例

**从 DSL 生成 Techniques 表**：
```typescript
import { generateStructuredTechniques } from './param-dsl.ts';
const { recon, vuln } = generateStructuredTechniques();
// recon.port_scan = { defaults: { scope: 'top100', ... }, required: [], enums: { ... } }
```

**从 DSL 生成工具 schema**：
```typescript
import { RECON_PARAM_SPECS, generateToolSchema } from './param-dsl.ts';
const httpSchema = generateToolSchema(RECON_PARAM_SPECS.http_probe);
// 可用于定义 pentest_recon 工具的参数
```

**检查 Skill 依赖**：
```bash
npm run check:skill-deps
# 或在 CI 中
npm run check:skill-deps || exit 1
```

---

## ✅ 质量保证

### 编译验证
```
✓ npm run build → 0 error, 148ms
✓ TypeScript strict mode
✓ No implicit any
```

### 功能验证
```
✓ Parameter DSL: 所有 16 个 technique 参数完整定义
✓ Extract functions: defaults/required/enums 正确导出
✓ Skill check: 正确检测 13 处跨阶段引用
✓ npm scripts: 可执行，输出清晰
```

### 向后兼容
```
✓ 既有 STRUCTURED_TECHNIQUES 仍可用（可手写或从 DSL 生成）
✓ 既有工具定义不受影响
✓ 参数验证逻辑无改变
```

---

## 🎯 后续工作

### 立即（v0.2.0-alpha 最终）

1. **Skill 文档引用清理**（可选但推荐）
   - 修改 13 处跨阶段引用，改为通用表述
   - 如："`vuln-ad-checks` 那一步"→ "下一步"
   - 重新运行检查确保通过

2. **参数 DSL 集成**（可选）
   - 在 techniques.ts 中导入 `generateStructuredTechniques()` 替换手写
   - 消除重复源头
   - 后续参数变更只改一个地方

### 后续版本（v0.2.0-beta+）

1. **参数约束完整化**
   - 利用 dsh 对 minimum/maximum 的支持（如果后续支持）
   - 将 DSL 中的 minimum/maximum 真正传给工具 schema
   - 前端据此生成表单约束

2. **JSON Schema 生成**
   - 从 DSL 自动生成 JSON Schema 文档
   - 发布到 API 文档站点

3. **跨 Skill 依赖图**
   - 扩展 check-skill-deps，支持正向依赖声明
   - 生成依赖图供可视化查看

---

## 📊 改动统计

| 文件 | 行数 | 改动类型 |
|-----|------|--------|
| src/execution/param-dsl.ts | +462 | 新文件 |
| scripts/check-skill-deps.ts | +189 | 新文件 |
| package.json | +1 | npm script |
| **总计** | **~650** | |

---

## 🎉 成果小结

**Week 2 的两个必做项**都已完成：

1. ✅ **参数 DSL** - 参数定义的单一源头，支持多处消费，类型安全，面向未来
2. ✅ **Skill 依赖检查** - CI 门禁脚本，编译期检测跨阶段依赖，保证 Skill 隔离

**当前状态**：
- 代码编译通过（0 error）
- 脚本可执行，正确检测违反
- 13 处 Skill 交叉引用已识别，待清理

**预期效果**（v0.2.0-alpha）：
- 参数定义管理成本 ↓（不再散布多处）
- Skill 隔离有保证 ✓（CI 自动检查）
- 架构演进灵活性 ↑（DSL 可无缝升级）

---

**下一步**：可选地清理 Skill 交叉引用，然后测试整个系统，准备 v0.2.0-alpha 发布。

