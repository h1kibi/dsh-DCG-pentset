#!/bin/bash
# dsh-pentest 一键启动脚本
# 用途：快速启动完整的渗透测试工作台

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  dsh-pentest 启动脚本                                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# 配置
PROJECT_DIR="C:/Projects/Agent-projects/dsh-DCG-pentest"
DSH_PROFILE="pentest"
PORT="3090"
LOG_FILE="/tmp/dsh-pentest-$(date +%s).log"

echo "📋 配置信息:"
echo "  项目目录: $PROJECT_DIR"
echo "  Profile: $DSH_PROFILE"
echo "  端口: $PORT"
echo "  日志: $LOG_FILE"
echo ""

# 检查先决条件
echo "🔍 检查先决条件..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装"
    exit 1
fi
echo "  ✓ Node.js $(node --version)"

if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装"
    exit 1
fi
echo "  ✓ Docker 已安装"

if ! docker network ls | grep -q "pentest-lab-internal"; then
    echo "❌ Docker 网络 pentest-lab-internal 不存在"
    exit 1
fi
echo "  ✓ Docker 网络 pentest-lab-internal 就绪"

# 检查 PostgreSQL
if ! docker ps | grep -q "pentest-db-full"; then
    echo "⚠️  PostgreSQL 容器未运行，正在启动..."
    docker start pentest-db-full || {
        echo "❌ 无法启动 PostgreSQL"
        exit 1
    }
    sleep 5
fi
echo "  ✓ PostgreSQL 运行中"

# 清理旧进程
echo ""
echo "🧹 清理旧进程..."
pkill -9 "node.*start-personal" 2>/dev/null || true
sleep 2
echo "  ✓ 旧进程已清理"

# 启动 dsh-pentest
echo ""
echo "🚀 启动 dsh-pentest..."
cd "$PROJECT_DIR"

DSH_PROFILE=$DSH_PROFILE nohup node start-personal.mjs > "$LOG_FILE" 2>&1 &
PID=$!
echo "  进程 ID: $PID"

# 等待启动
echo ""
echo "⏳ 等待服务启动（最多 120 秒）..."
for i in {1..120}; do
    if grep -q "http://" "$LOG_FILE" 2>/dev/null; then
        break
    fi
    sleep 1
    echo -n "."
done
echo ""

# 提取 URL 和 token
if grep -q "http://" "$LOG_FILE"; then
    URL=$(grep "http://" "$LOG_FILE" | tail -1 | grep -oE "http://[^ ]+")
    echo ""
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║  ✅ dsh-pentest 已启动！                                      ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "🌐 访问地址："
    echo ""
    echo "   $URL"
    echo ""
    echo "📋 说明："
    echo "   1. 复制上面的地址到浏览器"
    echo "   2. 创建新作业"
    echo "   3. 选择五个阶段中的一个"
    echo "   4. 启动 Worker Agent"
    echo "   5. 做人工决策"
    echo ""
    echo "📚 文档："
    echo "   • QUICK-REFERENCE.md              快速参考（打印版）"
    echo "   • DEEP-DIVE-SKILLS-STATE-MACHINE.md  完整剖析"
    echo "   • IMPLEMENTATION-GUIDE.md         实操指南"
    echo "   • DOCS-INDEX.md                   文档导航"
    echo ""
    echo "🛑 停止服务："
    echo "   pkill -9 node"
    echo ""
    echo "📖 查看日志："
    echo "   tail -100 $LOG_FILE"
    echo ""
else
    echo "❌ 启动失败"
    echo ""
    echo "📖 错误日志："
    tail -50 "$LOG_FILE"
    exit 1
fi
