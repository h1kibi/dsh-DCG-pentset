#!/usr/bin/env bash
# dsh-pentest 容器入口：把「运行插件所需的一切」准备好，然后执行传入的命令。
#
# 顺序不是随意的——每一步都是后一步的前提：
#   PostgreSQL 起来 → 库与角色就位 → 迁移到位 → 插件装进 profile → 才轮到 dsh 启动。
# 任何一步失败就**停下并说明原因**，绝不带着半成品继续（插件会在启动自检里失败，
# 而那时的报错离真正的原因已经隔了好几层）。
set -euo pipefail

PG_MAJOR="${PG_MAJOR:-18}"
PG_CLUSTER="${PG_CLUSTER:-main}"
PGDATA_DIR="/var/lib/postgresql/${PG_MAJOR}/${PG_CLUSTER}"
PG_HOST=127.0.0.1
PG_PORT="${PG_PORT:-5432}"
PG_SUPERUSER=postgres
PG_PASSWORD="${PENTEST_DB_PASSWORD:-check}"
PG_DB="${PENTEST_DB_NAME:-pentest}"

APP_DIR="${APP_DIR:-/opt/dsh-pentest}"
DSH_HOME="${DSH_HOME:-/opt/dsh}"
DSH_PROFILE="${DSH_PROFILE:-pentest}"
PROFILE_DIR="${DSH_HOME}/profiles/${DSH_PROFILE}"

log() { printf '[dsh-pentest-init] %s\n' "$*"; }
fail() { printf '[dsh-pentest-init] 错误：%s\n' "$*" >&2; exit 1; }

# ── 0) 只做本地库的准备工作：连接串指向别处时跳过 ──
#
# 判断用 case 而不是解析 URL：URL 语法（用户、密码、端口、参数、IPv6 字面量）足够复杂，
# 自己写解析器只会引入一类新的解析 bug。这里只需要知道「是不是本机默认端口」。
LOCAL_DB=no
case "${PENTEST_DATABASE_URL:-}" in
  ""|*"127.0.0.1:${PG_PORT}"*|*"localhost:${PG_PORT}"*) LOCAL_DB=yes ;;
  *) LOCAL_DB=no ;;
esac

if [ "${LOCAL_DB}" = yes ]; then
  # ── 1) PostgreSQL ──
  #
  # 镜像构建时 apt 已经建好集群，但数据目录常被挂上**新的空卷**：那时 PG_VERSION 不在，
  # 而 /etc/postgresql 下的配置还在（它在镜像层里）——启动会失败。因此按「数据目录是否
  # 真的初始化过」判断，而不是按「配置是否存在」。
  if [ ! -s "${PGDATA_DIR}/PG_VERSION" ]; then
    log "数据目录未初始化（${PGDATA_DIR}）：重建 ${PG_MAJOR}/${PG_CLUSTER} 集群"
    pg_dropcluster --stop "${PG_MAJOR}" "${PG_CLUSTER}" 2>/dev/null || true
    rm -rf "/etc/postgresql/${PG_MAJOR}/${PG_CLUSTER}"
    pg_createcluster "${PG_MAJOR}" "${PG_CLUSTER}" >/dev/null
  fi

  mkdir -p "/var/run/postgresql"
  chown "${PG_SUPERUSER}:${PG_SUPERUSER}" "/var/run/postgresql"

  log "启动 PostgreSQL ${PG_MAJOR}/${PG_CLUSTER}"
  pg_ctlcluster "${PG_MAJOR}" "${PG_CLUSTER}" start

  # 就绪等待：刚起来的 PG 会在恢复完成前拒绝连接，直接连会得到误导性的错误
  for i in $(seq 1 60); do
    pg_isready -h "${PG_HOST}" -p "${PG_PORT}" -q && break
    [ "$i" = 60 ] && fail "PostgreSQL 在 60 秒内没有就绪（检查数据目录权限与日志 /var/log/postgresql/）"
    sleep 1
  done

  # ── 2) 角色与库 ──
  #
  # 用 TCP + 口令而不是 unix socket：插件通过连接串连库，走的是 TCP，
  # 而 Debian/Kali 的默认 pg_hba 对 127.0.0.1 要求 scram-sha-256。只准备 socket
  # 认证会让「psql 能连、插件连不上」，那是最费时间的一类排查。
  log "确保角色 ${PG_SUPERUSER} 可口令登录，库 ${PG_DB} 存在"
  su "${PG_SUPERUSER}" -c "psql -v ON_ERROR_STOP=1 -q -c \"ALTER USER ${PG_SUPERUSER} PASSWORD '${PG_PASSWORD}'\""
  if ! su "${PG_SUPERUSER}" -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\"" | grep -q 1; then
    su "${PG_SUPERUSER}" -c "createdb '${PG_DB}'"
  fi
else
  log "PENTEST_DATABASE_URL 指向外部库，跳过本机 PostgreSQL 的初始化"
fi

# ── 3) 迁移 ──
#
# `migrate()` 是幂等的（已应用的版本记在 pentest.schema_migrations），因此每次启动都跑——
# 让「容器起来了但表结构是旧的」这种状态不可能存在。
#
# 用编译产物 lib/db/migrate.js（不是 src/*.ts）：镜像里的 Node 要跑 TypeScript 得带
# `--experimental-strip-types`，而这类实验开关的语义在大版本之间会变；产物已是标准 JS，
# 没有这层不确定性。
export PENTEST_DATABASE_URL="${PENTEST_DATABASE_URL:-postgresql://${PG_SUPERUSER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}}"
if [ -f "${APP_DIR}/lib/db/migrate.js" ]; then
  log "应用数据库迁移"
  node "${APP_DIR}/lib/db/migrate.js"
else
  fail "找不到 ${APP_DIR}/lib/db/migrate.js——镜像缺少构建产物。请在宿主执行 npm run build 后重建镜像。"
fi

# ── 4) 插件装进 profile ──
#
# 构建期已装好，这里只做兜底（有人重挂 DSH_HOME、或镜像被别人改过）。
# 检查的是 profile 的 package.json 是否已声明依赖，而不是跑一次 `plugin add`：
# 后者会调用 pnpm，在离线环境下失败，那时容器本可以正常启动却起不来。
if [ -f "${PROFILE_DIR}/package.json" ]; then
  if grep -q '"dsh-pentest"' "${PROFILE_DIR}/package.json"; then
    log "插件已安装在 profile ${DSH_PROFILE}"
  else
    log "profile 里没有 dsh-pentest，执行 dsh plugin add"
    dsh plugin --profile "${DSH_PROFILE}" add "${APP_DIR}" \
      || fail "安装插件失败（pnpm 需要能访问 npm registry，或 profile 的 store 已被清空）"
  fi
else
  fail "profile ${DSH_PROFILE} 不存在于 ${DSH_HOME}/profiles——镜像不完整"
fi

# ── 5) 交棒 ──
log "准备完成：PG=${PG_HOST}:${PG_PORT}/${PG_DB}，profile=${DSH_PROFILE}，插件=${APP_DIR}"
if [ "$#" -eq 0 ]; then
  fail "没有要执行的命令"
fi
exec "$@"
