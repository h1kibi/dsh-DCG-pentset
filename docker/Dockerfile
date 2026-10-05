# dsh-pentest：Kali + dsh + 本插件的自包含镜像。
#
# ── 这个镜像里有什么、为什么 ──
#
#   - **Kali（kalilinux/kali-rolling）**：渗透工具集的基座，也是本插件的目标运行环境。
#   - **PostgreSQL 18 + pgvector**：插件的唯一持久化（账本、状态机、范围、记忆、报告）。
#     迁移 001 第一句就是 `CREATE EXTENSION vector` 与 `pg_trgm`，缺一不可。
#     Kali 仓库自带 `postgresql-18-pgvector`，因此**不需要源码编译**——少一个构建失败点。
#   - **Node 22.20.0（官方 tarball）**：与项目实际验证过的运行时**逐版本对齐**。
#     Kali 自带的 nodejs 是 24.x；engines 虽然允许 `>=24`，但全部测试是在 22.20.0 上
#     跑绿的，换大版本会把「镜像环境问题」与「代码问题」混在一起，无法归因。
#     走官方 tarball 而不是 NodeSource：NodeSource 的安装脚本按 /etc/os-release 识别发行版，
#     Kali 的 ID 不在其支持列表里，装了会失败或装错版本。
#   - **dsh 0.1.5-rc.2**：宿主 harness 本体（npm 上是 public 包）。
#   - **本项目**（`/opt/dsh-pentest`）：构建产物 + 运行期依赖，并已装进 `pentest` profile。
#
# ── 一个刻意的取舍：镜像消费的是**宿主构建好的 lib/** ──
#
# `lib/` 由宿主 `npm run build` 产出（tsc 出 ESM、tsdown 出浏览器 bundle），是纯 JS 产物，
# 跨平台复制是正确的。镜像内不重新构建，因为那需要全量 devDependencies（typescript、
# tsdown 等，数百 MB），而它换来的只是「在镜像里也能改代码」——那是挂载源码 +
# 本地构建的活，不该固化进镜像。
#
# 代价必须写清楚：**改了源码要先在宿主 `npm run build`，再重建镜像**。
#
# 构建（在仓库根执行，上下文必须是根因为要 COPY lib/）：
#   docker build -f docker/Dockerfile -t dsh-pentest .

FROM kalilinux/kali-rolling

ARG NODE_VERSION=22.20.0
ARG DSH_VERSION=0.1.5-rc.2
ARG PNPM_VERSION=11.4.0
ARG PG_MAJOR=18

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DSH_HOME=/opt/dsh \
    DSH_PROFILE=pentest \
    APP_DIR=/opt/dsh-pentest \
    PENTEST_DATABASE_URL=postgresql://postgres:check@127.0.0.1:5432/pentest

# ── 1) 系统层：Kali 基础工具 + PostgreSQL 18 + pgvector ──
#
# `postgresql-18` 自带 contrib（`Provides: postgresql-contrib-18`），pg_trgm 的 .so 与
# .control 都在里面，因此**不要**再装 `postgresql-contrib`——Kali 里那个名字不存在，
# 会导致 apt 直接失败。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git procps tini \
      postgresql-18 "postgresql-${PG_MAJOR}-pgvector" \
 && rm -rf /var/lib/apt/lists/*

# ── 2) Node 22（官方 tarball，逐版本对齐宿主）──
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    node --version; npm --version

# ── 3) dsh 与 pnpm ──
#
# pnpm 是 `dsh plugin` 的实现依赖：官方 `plugin` 子命令把剩余参数**转发给 profile 目录里的
# pnpm**。镜像里不放 pnpm，`dsh plugin add` 会在运行时才失败。
RUN npm install -g --no-audit --no-fund \
      "pnpm@${PNPM_VERSION}" \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version \
 && pnpm --version

# ── 4) 本项目 ──
WORKDIR ${APP_DIR}

# 4a) 镜像内的运行期依赖：用**声明式清单**（`docker/package.json`）而不是命令行列举。
#
# 为什么不用仓库根的 package.json：它把宿主包声明为 `peerDependencies`（正确——开发时
# 由宿主提供，不该拖进插件自己的依赖树）。但**镜像自带宿主**，所以在镜像里它们是真实依赖，
# 而 npm 会**忽略命令行里那些已在 peerDependencies 中声明的包**（实测：只落地
# typert-protocol 与 pg，`cordis`/`dsh-session`/`dsh-tools`/`dsh-util-values` 全缺，
# 结果是插件在镜像里加载即 `Cannot find module`）。
#
# 用清单而非 `npm install a@1 b@2 …`：命令行形式**会漂移**——本轮新增
# `@deepseek-ai/dsh-typert-protocol` 时就漏过一次。清单可 diff、可复核，
# 且 `docker/package.json` 里写了「必须覆盖 lib/ 全部外部 import」的核对方法。
COPY docker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && rm -f package-lock.json
# 删掉 lock：它描述的是上面那份镜像清单，而下一层会把 package.json 换成插件自己的，
# 留着会是一份**指向错根包的**锁文件，比没有更容易误导。

# 4b) 换回插件自己的 package.json（带 `type`/`exports`/`dsh` 元数据，profile 的
#     `dsh plugin add` 要靠 `dsh.bundle.patch` 找到本插件的补丁层）。
COPY package.json ./package.json
# 运行期产物：lib/（含 lib/db/migrations，由宿主 build 的 postbuild 拷进去）
COPY lib ./lib
# 迁移文件本体（容器内应用迁移要读 src/db/migrations）
COPY src/db/migrations ./src/db/migrations
COPY scripts ./scripts
COPY cordis.patch.yml ./

# ── 5) dsh profile + 插件安装 ──
#
# 分两步，各有理由：
#   a. 建 profile 并**预装 bundle**（dsh-base / dsh-web-app）：这一步需要网络，
#      放在构建期做掉，容器起来后就不必再连 registry。
#   b. 装本插件：`dsh plugin add` 会读 package.json 的 `dsh.bundle.patch` 把包名写进
#      profile 的 bundles，并把依赖记成 `link:/opt/dsh-pentest`。
RUN dsh --profile "${DSH_PROFILE}" --from-default-profile web --dump-config >/dev/null \
 && cd "${DSH_HOME}/profiles/${DSH_PROFILE}" \
 && pnpm install --silent \
 && dsh plugin --profile "${DSH_PROFILE}" add "${APP_DIR}" \
 && pnpm install --silent

COPY docker/profile.patch.yml "${DSH_HOME}/profiles/${DSH_PROFILE}/cordis.patch.yml"

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/smoke.sh /usr/local/bin/smoke.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/smoke.sh

# PostgreSQL 数据目录（未挂卷时数据留在容器层；挂了空卷时入口脚本会 initdb）
VOLUME ["/var/lib/postgresql"]

EXPOSE 5432
EXPOSE 3080

# tini 负责收割孤儿进程与转发信号：PostgreSQL 会派生 worker，没有 init 时
# `docker stop` 的信号到不了它们，容器要等满超时才退出。
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
# 默认起 dsh web（插件的目标界面）。端口 3080 对应 dsh 默认。
CMD ["dsh", "web", "--no-open", "--host", "0.0.0.0", "--port", "3080"]
