# dsh-pentest 插件安装快速参考

## 推荐方式：开发模式

### 前置条件检查
- [ ] dsh 已安装 (`pnpm dsh --version`)
- [ ] PostgreSQL 运行中
- [ ] Docker 已安装并运行
- [ ] 本项目已编译 (`npm run build`)

### 快速安装（3 步）

**步骤 1: 启动沙箱环境**
```bash
cd C:/Projects/Agent-projects/dsh-DCG-pentest
sh scripts/dev-sandbox-up.sh up
```

**步骤 2: 启动 dsh + 插件**
```bash
# 进入 harness 源码目录
cd <harness-root>

pnpm dsh \
  --profile dev \
  --patch C:/Projects/Agent-projects/dsh-DCG-pentest/harness.dev.patch.yml \
  web --no-open
```

**步骤 3: 打开浏览器**
```
http://localhost:5173
```

### 环境变量（.env）

```env
PENTEST_DATABASE_URL=postgresql://postgres:check@127.0.0.1:55446/pentest
PENTEST_LEDGER_SECRET=dev-ledger-secret-key
PENTEST_SESSION_CWD=C:/tmp/dsh-pentest-sessions
```

## 其他安装方式

### 生产模式（profile 安装）

```bash
# 1. 构建
cd dsh-DCG-pentest
npm run build

# 2. 添加到 profile
cd harness
pnpm dsh --profile default add C:/Projects/Agent-projects/dsh-DCG-pentest

# 3. 启动
pnpm dsh web
```

### 本地 link 安装

```bash
# 1. 创建 link
cd dsh-DCG-pentest
npm link

# 2. 在 harness 中使用
cd harness
pnpm add --save-dev link:../dsh-DCG-pentest

# 3. 启动
pnpm dsh web
```

## 验证成功标志

- ✓ 控制台加载无错误
- ✓ 左侧菜单出现"渗透测试"面板
- ✓ 可创建新的作业（engagement）
- ✓ 数据库连接正常

## 常见问题

| 问题 | 解决方案 |
|------|---------|
| Cannot find module 'dsh-pentest' | 检查 patch 路径是否正确，在 harness 目录运行 |
| Database connection failed | 验证 PENTEST_DATABASE_URL，启动 PostgreSQL |
| Sandbox image not found | 运行 `sh scripts/dev-sandbox-up.sh up` |
| 插件修改无效 | 重启 dsh 即可（开发模式无需重新构建） |

## 关键文件

- `src/index.ts` - 插件入口
- `cordis.patch.yml` - 生产配置
- `harness.dev.patch.yml` - 开发配置
- `package.json` - 插件元数据
