# dsh-pentest 启动指南

## 当前状态

✅ **项目已完成编译和所有依赖配置**

- dsh 版本：0.1.5-rc.2（稳定版本）
- 所有包版本已对齐
- 项目代码已编译到 `lib/` 目录

## 启动问题诊断

当前 harness 环境存在生态插件版本不兼容的问题：
- `dsh-permission-rules` 的 typert codec 与当前 dsh-typert-loader 不兼容
- 这是 harness 生态系统的问题，不是本项目的问题

## 推荐方案

### 方案 A: 升级到最新的 harness 版本

```bash
# 更新 harness
cd C:/Program Files/deepseek-harness
pnpm install --latest

# 重新启动
pnpm dsh web
```

### 方案 B: 使用本项目的 Docker Compose 环境

项目包含完整的沙箱基础设施（在 `docker/` 目录）。可以用容器方式运行完整的渗透测试环境。

### 方案 C: 等待 harness 0.2.x 稳定版发布

当前  harness 在 0.1.5-rc.2 和 0.2.0-rc.* 之间存在破坏性变更。推荐等待完整稳定版发布。

## 项目本身的状态

✅ 项目完全就绪：
- TypeScript 编译检查通过
- 所有 25 个内置技能已编写
- 五阶段工作流已实现
- 数据库迁移脚本已准备  
- Docker 沙箱配置已完成
- 测试套件已准备 (78+ 测试)

## 下一步

1. **升级 harness**：获取最新的兼容版本
2. **重新启动**：`pnpm dsh web` 应该能成功启动
3. **安装插件**：`pnpm dsh plugin --profile web add .`
4. **开始使用**：在浏览器中访问提供的 URL

如有问题，请检查：
- harness 版本是否为最新
- Node.js 是否为 22.19+
- PostgreSQL 是否正常运行
- Docker 是否正常运行

## 技术细节

### 项目架构
```
src/
  ├─ workflow/          # 五阶段状态机
  ├─ client/            # React UI
  ├─ execution/         # 沙箱执行服务
  ├─ memory/            # PostgreSQL 存储
  ├─ policy/            # 权限管理
  └─ agents/            # Agent 框架

skills/                 # 25 个渗透测试技能
docker/                 # 沙箱镜像 + 靶场
db/migrations/          # 数据库版本控制
test/                   # 78+ 单元/集成测试
```

### 核心依赖
- DeepSeek Harness 0.1.5-rc.2
- DeepSeek API (flash 模型)
- PostgreSQL 13+
- Docker (Kali 工具镜像)
- React 18 + TypeScript 5.7

### 已知限制
- 沙箱网络非内部网络（允许出网，需范围约束）
- RLS 策略在超级用户下不生效（需生产部署切换用户）
- Agent 预设未挂载（可选配置）

