#!/bin/sh
# dsh-pentest 沙箱工具镜像的本地 bring-up。
#
# 为什么需要「本地 registry」这一步：`buildDockerArgs` 只用 `<name>@sha256:<digest>` 引用
# 镜像，而 `docker build` 出来的本地镜像**没有 RepoDigest**（标签会漂移，所以代码拒绝标签）。
# 把镜像推进一个本地 registry 再从 `docker inspect` 读回真实摘要，就得到了一条
# 「现在能用、且与未来重新拉起的行为一致」的 digest 引用。
#
# 用法（Windows 上用 `sh` 调起：`bash` 会解析到 System32 的 WSL bash，那里没有 docker；
# 直接 `./scripts/dev-sandbox-up.sh` 也不行——Windows 的 CreateProcess 不认 shebang）：
#   sh scripts/dev-sandbox-up.sh up       # 构建 + 起 registry + 建网络 + 推送 + 打印 digest 与 sandbox 配置段
#   sh scripts/dev-sandbox-up.sh proxy    # 起出口代理容器 pentest-proxy（双接 bridge + pentest-internal）
#   sh scripts/dev-sandbox-up.sh digest   # 只读回当前 digest
#   sh scripts/dev-sandbox-up.sh smoke    # 用与 buildDockerArgs 相同的 argv 实跑一次（internal 网络 + 代理 env）
#   sh scripts/dev-sandbox-up.sh direct   # 同一 argv、仅把网络换成 bridge，用来区分「镜像问题」和「网络边界问题」
#   sh scripts/dev-sandbox-up.sh down     # 停掉 registry（保留数据卷）并删除网络
# Linux/macOS 上 `bash scripts/dev-sandbox-up.sh up` 同样可用。
#
# 注意：Git Bash 下需要 MSYS_NO_PATHCONV=1，否则 `--tmpfs /tmp:...` 会被改写成 Windows 路径
# （脚本内部已 export，手工照抄命令时别忘了）。

set -eu

REPO_ROOT="$(cd "$(dirname "${0}")/.." && pwd)"
# Docker CLI 在 Windows 上不认 MSYS 风格路径（/c/...），统一用仓库根 + 相对路径。
cd "${REPO_ROOT}"
IMAGE_REPO="127.0.0.1:5005/pentest-tools"
IMAGE_TAG="0.1.0"
REGISTRY_NAME="${PENTEST_REGISTRY_CONTAINER:-pentest-registry}"
REGISTRY_PORT="${PENTEST_REGISTRY_PORT:-5005}"
REGISTRY_VOLUME="pentest-registry-data"
NETWORK="${PENTEST_INTERNAL_NETWORK:-pentest-internal}"
PROXY_HOST="${PENTEST_PROXY_HOST:-pentest-proxy}"
RESOLVED_ADDRESSES="${PENTEST_RESOLVED_ADDRESSES:-}"
PROXY_PORT="${PENTEST_PROXY_PORT:-8080}"
PROXY_IMAGE="python:3.10-slim-bookworm"
TARGET="${TARGET:-}"
# 沙箱里只允许模板声明的参数；smoke/direct 必须由调用者显式提供实验室目标。
COMMAND="${COMMAND:-http_get target=${TARGET} method=GET path=/ follow_redirects=false}"
# 第一轮实战必须显式限定出口目标；空值不得退化成全放行。
EGRESS_ALLOW="${EGRESS_ALLOW:-}"

export MSYS_NO_PATHCONV=1

require_egress_allow() {
  case "${EGRESS_ALLOW}" in
    '')
      printf '拒绝启动出口代理：EGRESS_ALLOW 不能为空。请只填书面授权的实验室主机，例如 EGRESS_ALLOW=lab.example\n' >&2
      exit 2
      ;;
    *\**)
      printf '拒绝启动出口代理：EGRESS_ALLOW 不接受通配符；请列出明确的实验室主机或已裁决地址\n' >&2
      exit 2
      ;;
  esac
}

require_smoke_target() {
  if [ -z "${TARGET}" ] || [ -z "${RESOLVED_ADDRESSES}" ]; then
    printf '拒绝 smoke/direct：必须显式设置 TARGET 与 PENTEST_RESOLVED_ADDRESSES，禁止默认请求公网目标\n' >&2
    exit 2
  fi
}

run_tool() {
  local network="$1"; shift
  docker run --rm \
    --network "${network}" \
    --cap-drop ALL --security-opt no-new-privileges \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    -e "PENTEST_RESOLVED_ADDRESSES=${RESOLVED_ADDRESSES}" \
    --pids-limit 256 --cpus 1.0 --memory 1g \
    "$@" \
    "${IMAGE_REPO}@${DIGEST}" \
    "${COMMAND}"
}

cmd_proxy() {
  require_egress_allow
  # 出口代理：工具容器唯一的出网路径（§10.4 第 2 层边界）。
  # 双接 bridge + pentest-internal：前者给代理自己出网，后者让工具容器能按名字连上它。
  # 端口只绑回 127.0.0.1，避免把 internal 网络经由代理暴露给局域网。
  if docker inspect "${PROXY_HOST}" >/dev/null 2>&1; then
    current_allow="$(docker inspect "${PROXY_HOST}" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^EGRESS_ALLOW=//p')"
    if [ "${current_allow}" != "${EGRESS_ALLOW}" ]; then
      printf '拒绝复用已有 %s：其 EGRESS_ALLOW=%s，与当前要求=%s 不一致。请由运维显式重建或改用新的实验室容器名。\n' \
        "${PROXY_HOST}" "${current_allow:-<空>}" "${EGRESS_ALLOW}" >&2
      exit 2
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "${PROXY_HOST}")" != "true" ]; then
      docker start "${PROXY_HOST}" >/dev/null
    fi
  else
    docker run -d --name "${PROXY_HOST}" --restart unless-stopped \
      --network bridge -p "127.0.0.1:${PROXY_PORT}:${PROXY_PORT}" \
      -e "EGRESS_ALLOW=${EGRESS_ALLOW}" \
      -v "$(pwd)/scripts/egress-proxy.py:/proxy/egress-proxy.py:ro" \
      "${PROXY_IMAGE}" python3 /proxy/egress-proxy.py --port "${PROXY_PORT}" >/dev/null
  fi
  # 等它起来再接入 internal 网络：容器名解析由 Docker 内嵌 DNS 提供，两端都要在网里。
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if docker logs "${PROXY_HOST}" 2>&1 | grep -q 'listening'; then break; fi
    sleep 0.5
  done
  if ! docker inspect "${PROXY_HOST}" --format '{{json .NetworkSettings.Networks}}' | grep -q '"'"${NETWORK}"'"'; then
    docker network connect "${NETWORK}" "${PROXY_HOST}"
  fi
  docker logs "${PROXY_HOST}" 2>&1 | tail -2
}

cmd_up() {
  require_egress_allow
  # 字典源可覆盖（见 Dockerfile 的 `ARG SECLISTS_BASE` 说明）：留空即用镜像里的默认（jsDelivr）。
  docker build ${SECLISTS_BASE:+--build-arg "SECLISTS_BASE=${SECLISTS_BASE}"} -t "${IMAGE_REPO}:${IMAGE_TAG}" docker/tools

  if ! docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    # internal: true ——容器没有默认路由，无法直连外网；唯一可达的是同网内的代理容器。
    docker network create --internal "${NETWORK}"
  fi

  if ! docker inspect "${REGISTRY_NAME}" >/dev/null 2>&1; then
    # 数据卷：registry 重启后镜像与摘要不变，digest 引用因此不会失效。
    docker run -d --name "${REGISTRY_NAME}" -p "${REGISTRY_PORT}:5000" \
      -v "${REGISTRY_VOLUME}:/var/lib/registry" registry:2 >/dev/null
    sleep 2
  elif [ "$(docker inspect -f '{{.State.Running}}' "${REGISTRY_NAME}")" != "true" ]; then
    docker start "${REGISTRY_NAME}" >/dev/null
    sleep 2
  fi

  # 既有代理也必须经过白名单一致性检查；不擅自删除或重建用户容器。
  cmd_proxy

  docker push "${IMAGE_REPO}:${IMAGE_TAG}" >/dev/null
  DIGEST="$(docker inspect "${IMAGE_REPO}:${IMAGE_TAG}" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"

  printf '\n镜像摘要：%s\n\n' "${DIGEST}"
  printf '把下面这段粘进 harness.dev.patch.yml（替换同名段）：\n\n'
  printf 'sandbox:\n'
  printf '  allowedImages:\n'
  printf '    - name: %s\n' "${IMAGE_REPO}"
  printf '      digest: %s\n' "${DIGEST}"
  printf '  internalNetwork: %s\n' "${NETWORK}"
}


DIGEST="$(docker inspect "${IMAGE_REPO}:${IMAGE_TAG}" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//' || true)"

case "${1:-up}" in
  up) cmd_up ;;
  proxy) cmd_proxy ;;
  digest) printf '%s\n' "${DIGEST}" ;;
  smoke)
    # **只用于 dev 排障**：与 `buildDockerArgs` 的参数**并不一致**——插件自 2026-10-05 起
    # 不注入任何代理变量、也不注入执行令牌（见 docker-sandbox.ts 的回归锁）。这里仍注入，
    # 是为了让"经代理出网"这条**旧链路**还能被单独排障。要复现产品 argv，请 `up` 后让插件实际执行。
    require_egress_allow
    require_smoke_target
    run_tool "${NETWORK}" \
      -e "HTTP_PROXY=http://${PROXY_HOST}:${PROXY_PORT}" \
      -e "HTTPS_PROXY=http://${PROXY_HOST}:${PROXY_PORT}" \
      -e "NO_PROXY=" \
      -e "PENTEST_EXECUTION_TOKEN=dev-smoke-token" \
      -e "PENTEST_PLAN_HASH=dev-smoke-plan" \
      -e "PENTEST_POLICY_EPOCH=1" \
      -e "PENTEST_SCOPE_VERSION=1" \
      -e "PENTEST_TIMEOUT_MS=15000" \
      -e "PENTEST_MAX_OUTPUT_BYTES=262144"
    ;;
  direct)
    # 只换网络（bridge + 不加代理 env）：仅用于实验室目标的镜像/argv 诊断。
    require_smoke_target
    run_tool bridge \
      -e "NO_PROXY=" \
      -e "PENTEST_EXECUTION_TOKEN=dev-smoke-token" \
      -e "PENTEST_TIMEOUT_MS=15000" \
      -e "PENTEST_MAX_OUTPUT_BYTES=262144"
    ;;
  down)
    docker rm -f "${PROXY_HOST}" >/dev/null 2>&1 || true
    docker rm -f "${REGISTRY_NAME}" >/dev/null 2>&1 || true
    docker network rm "${NETWORK}" >/dev/null 2>&1 || true
    printf '已停掉 %s / %s（数据卷 %s 保留）并删除网络 %s\n' "${REGISTRY_NAME}" "${PROXY_HOST}" "${REGISTRY_VOLUME}" "${NETWORK}"
    ;;
  *)
    printf '用法：%s {up|proxy|digest|smoke|direct|down}\n' "$0" >&2
    exit 2
    ;;
esac
