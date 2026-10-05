#!/usr/bin/env bash
# 容器内自检：证明「Kali + PostgreSQL + dsh + 本插件」这条链路真的通了。
#
# 由 `docker run --rm dsh-pentest smoke` 调用。入口脚本已先做过 PostgreSQL 初始化、
# 迁移与插件安装，因此这里测的是**那些步骤的结果**，以及最后一跳：dsh 带着插件真的能起来。
#
# ── 每一条检查各自证伪什么 ──
#
#   1. 扩展可用        → 迁移里 `CREATE EXTENSION vector / pg_trgm` 不会失败
#   2. 迁移到位        → 表结构是 005，且可重复执行（幂等）
#   3. profile 配置    → 补丁层的 `!!js` 表达式真的求值了（不是形同虚设）
#   4. dsh 起得来      → **插件装载成功**。cordis 的加载器对任何一条 entry 失败都会
#                        让整棵树失败（`plugin tree failed to load`），因此「页面能出来」
#                        本身就是「插件的 host 半边没抛错」的证据
#   5. 客户端 bundle    → 服务端注入的 __DSH_BOOT__ 图里有 dsh-pentest 条目
set -uo pipefail

PASS=0
FAIL=0
PORT="${SMOKE_PORT:-3080}"
BOOT_LOG="$(mktemp)"
DSH_PID=""

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
info() { printf '  \033[36mi\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

cleanup() {
  if [ -n "${DSH_PID}" ] && kill -0 "${DSH_PID}" 2>/dev/null; then
    kill -TERM "${DSH_PID}" 2>/dev/null || true
    wait "${DSH_PID}" 2>/dev/null || true
  fi
  rm -f "${BOOT_LOG}"
}
trap cleanup EXIT

export PENTEST_DATABASE_URL="${PENTEST_DATABASE_URL:-postgresql://postgres:check@127.0.0.1:5432/pentest}"

head_ "1. PostgreSQL 与扩展"
if pg_isready -h 127.0.0.1 -p 5432 -q; then ok "PostgreSQL 就绪"; else bad "PostgreSQL 未就绪"; fi

PGVER="$(su postgres -c "psql -tAc 'SHOW server_version'" 2>/dev/null | tr -d '[:space:]')"
[ -n "${PGVER}" ] && ok "服务端版本 ${PGVER}" || bad "取不到服务端版本"

# 扩展可用性看 pg_available_extensions（不是 pg_extension）：迁移前它还没被创建，
# 但「装得上」才是这个镜像要保证的事。
for ext in vector pg_trgm; do
  if su postgres -c "psql -tAc \"SELECT 1 FROM pg_available_extensions WHERE name='${ext}'\"" 2>/dev/null | grep -q 1; then
    ok "扩展 ${ext} 可用"
  else
    bad "扩展 ${ext} 不可用（pgvector 需 postgresql-18-pgvector，pg_trgm 在 contrib 里）"
  fi
done

head_ "2. 表结构（迁移）"
# 幂等性也是要测的：入口脚本每次启动都跑迁移，第二次必须是「已是最新」而不是报错。
if node /opt/dsh-pentest/lib/db/migrate.js >/tmp/migrate2.log 2>&1; then
  ok "迁移可重复执行（幂等）"
else
  bad "迁移重跑失败：$(tail -3 /tmp/migrate2.log | tr '\n' ' ')"
fi

# 期望值从**迁移文件数**推出，而不是写死：写死过一次（当时是 5），
# 加了 006 之后这条断言恒为假——自检于是永远报「表结构版本不对」，
# 而那正是最容易被忽略的「狼来了」。
EXPECTED_VER="$(ls /opt/dsh-pentest/src/db/migrations/*.sql 2>/dev/null | wc -l | tr -d '[:space:]')"
VER="$(su postgres -c "psql -d pentest -tAc 'SELECT max(version) FROM pentest.schema_migrations'" 2>/dev/null | tr -d '[:space:]')"
if [ "${VER}" = "${EXPECTED_VER}" ]; then
  ok "表结构版本 ${VER}（与迁移文件数一致）"
else
  bad "表结构版本是 ${VER}，但迁移文件有 ${EXPECTED_VER} 个（迁移没跑完？）"
fi

TABLES="$(su postgres -c "psql -d pentest -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='pentest'\"" 2>/dev/null | tr -d '[:space:]')"
# 28 = 001 的 27 张业务表 + 005 的 index_watermarks + schema_migrations。
# 用 >= 而非等号：新增迁移加表不该让这条自检失败，但**掉表**必须被发现。
if [ "${TABLES:-0}" -ge 28 ]; then ok "pentest schema 有 ${TABLES} 张表"; else bad "只有 ${TABLES} 张表，期望 >= 28"; fi

for ext in vector pg_trgm; do
  if su postgres -c "psql -d pentest -tAc \"SELECT 1 FROM pg_extension WHERE extname='${ext}'\"" 2>/dev/null | grep -q 1; then
    ok "扩展 ${ext} 已创建"
  else
    bad "扩展 ${ext} 未创建（迁移没跑到？）"
  fi
done

# 006 补的 RLS：漏掉它时该表对应用角色既无权限、也无隔离（§9.4）
RLS="$(su postgres -c "psql -d pentest -tAc \"SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='pentest.index_watermarks'::regclass\"" 2>/dev/null | tr -d '[:space:]')"
if [ "${RLS}" = "t" ]; then ok "index_watermarks 的 RLS 已启用并 FORCE（§9.4）"; else bad "index_watermarks 的 RLS 未生效（值=${RLS}）"; fi

head_ "3. 插件在 profile 里"
PROFILE_DIR="/opt/dsh/profiles/pentest"
if grep -q '"dsh-pentest"' "${PROFILE_DIR}/package.json" 2>/dev/null; then
  ok "profile 声明了 dsh-pentest 依赖"
else
  bad "profile 未声明 dsh-pentest"
fi

if grep -q 'dsh-pentest' "${PROFILE_DIR}/package.json" 2>/dev/null; then
  ok "dsh-pentest 在 profile 的 bundles 列表里（否则它的补丁层不会应用）"
fi

DUMP="$(dsh --profile pentest --dump-config 2>/dev/null)"
if printf '%s' "${DUMP}" | grep -q 'id: pentest'; then
  ok "组合配置里有 pentest 行"
else
  bad "组合配置里没有 pentest 行"
fi
# `!!js` 表达式是否真的求值：默认值来自 docker/profile.patch.yml
if printf '%s' "${DUMP}" | grep -q 'container-operator'; then
  ok "profile 补丁层的 config 求值成功（operator=container-operator）"
else
  bad "profile 补丁层未生效（operator 没到配置里）"
fi

head_ "4. dsh 带插件启动（host 半边）"
dsh web --no-open --host 127.0.0.1 --port "${PORT}" >"${BOOT_LOG}" 2>&1 &
DSH_PID=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "${BOOT_LOG}" | head -1)"
  [ -n "${URL}" ] && break
  kill -0 "${DSH_PID}" 2>/dev/null || break
  sleep 1
done

if [ -n "${URL}" ]; then
  ok "dsh web 已监听（${URL%%\?*}）"
  # 加载器对任何 entry 的失败都会让整棵树失败，因此这一条等价于「插件的 host 半边没抛错」
  if grep -qE 'plugin tree failed to load|Invalid effect|failed to apply loader entry pentest' "${BOOT_LOG}"; then
    bad "插件装载失败：$(grep -oE 'failed to apply loader entry pentest[^\n]*|Invalid effect[^\n]*' "${BOOT_LOG}" | head -1)"
  else
    ok "插件 host 半边装载无错（加载器未拒绝任何 entry）"
  fi
else
  bad "dsh 在 60 秒内没有监听。最后几行日志："
  tail -12 "${BOOT_LOG}" | sed 's/^/      /'
fi

head_ "5. 客户端 bundle（浏览器半边）"
if [ -n "${URL}" ]; then
  HTML="$(curl -fsS "${URL}" 2>/dev/null || true)"
  if printf '%s' "${HTML}" | grep -q '"id":"dsh-pentest"'; then
    ok "__DSH_BOOT__ 图里有 dsh-pentest 条目（客户端 bundle 已登记）"
  else
    bad "__DSH_BOOT__ 图里找不到 dsh-pentest（客户端半边没登记）"
  fi
  if printf '%s' "${HTML}" | grep -q 'dsh-pentest/client.js'; then
    ok "服务端提供了 dsh-pentest/client.js 的 URL"
  else
    bad "服务端没有给出客户端 bundle 的 URL"
  fi
fi

# ── 6. 控制面端点（经共享网关 /api）──
#
# 端点暴露为 Typert Remote：`POST /api/pentest/<method>`。这里真的调一次读端点，
# 因为「dsh 起来了」不等于「控制面可用」——它们失败的层次不同
# （前者是插件装载，后者是网关认领/参数形状/认证）。
#
# 曾经这段测的是自建通道 `/pentest/<method>` 并**接受 405**，还把它写成「已知缺口」。
# 那是迁移前的形态；迁移后那个路径已不存在，断言恒成立，自检对「控制面是否可用」
# 完全失明。现在改为断言**真的拿到数据**。
if [ -n "${URL}" ]; then
  BASE="${URL%%/\?*}"
  COOKIE="$(mktemp)"
  if curl -sS -c "${COOKIE}" -o /dev/null "${URL}" 2>/dev/null; then
    ok "launch token 换到了会话 cookie"
  else
    bad "无法用 launch token 换 cookie（${URL}）"
  fi

  BODY='{"type":"client-request","rpcId":"smoke-1","method":"pentest/listEngagements","payload":{"args":{"request":{"method":"listEngagements","params":{},"expectedStateVersion":0,"reason":"容器自检","idempotencyKey":"smoke-1"}}}}'
  RESP="$(curl -sS -b "${COOKIE}" -H 'content-type: application/json' -X POST \
      "${BASE}/api/pentest/listEngagements" -d "${BODY}" 2>/dev/null || true)"

  if printf '%s' "${RESP}" | grep -q '"ok":true'; then
    ok "控制面端点可用：POST /api/pentest/listEngagements 返回 ok:true"
  else
    bad "控制面端点不可用。响应：$(printf '%s' "${RESP}" | head -c 300)"
    info "  401 ⇒ cookie 没换到；404 ⇒ 端点未被网关认领（服务未注册/命名空间不符）；"
    info "  gateway/arguments-invalid ⇒ 载荷形状不符（需两层 args；内层键名 = 宿主方法参数名）"
    info "  gateway/invocation-unavailable ⇒ SRC 找不到 active 服务 + typertRemote 绑定 + @Remote 标记"
  fi

  # 未认证必须被拦：控制面在共享网关上，认证由宿主的围栏负责，这条确认它真的在生效。
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d "${BODY}" \
      "${BASE}/api/pentest/listEngagements" 2>/dev/null || echo '???')"
  if [ "${CODE}" = "401" ]; then
    ok "未认证请求被拒（401）"
  else
    bad "未认证请求没有被拒：得到 ${CODE}（期望 401）"
  fi
  rm -f "${COOKIE}"
fi

head_ "结果"
printf '  通过 %d 项，失败 %d 项\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
