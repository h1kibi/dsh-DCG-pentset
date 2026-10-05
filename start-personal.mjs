/**
 * 个人渗透测试控制台 —— 启动器。
 *
 * 先验证 Docker 沙箱和个人数据库确实可用，再启动 dsh。启动成功的定义是：
 * dsh 输出带 token 的 URL，且该 URL 返回可读的 HTTP 页面；仅有子进程并不算就绪。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh';
const PORT = process.env.PENTEST_PORT ?? '3090';
const DSH_BIN = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const PROFILE = process.env.DSH_PROFILE ?? 'pentest';
const NETWORK = process.env.PENTEST_INTERNAL_NETWORK ?? 'pentest-internal';
const PROXY = process.env.PENTEST_PROXY_HOST ?? 'pentest-proxy';
const REGISTRY = process.env.PENTEST_REGISTRY_CONTAINER ?? 'pentest-registry';
const PROFILE_FILE = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
const READY_TIMEOUT_MS = Number(process.env.PENTEST_READY_TIMEOUT_MS ?? 60_000);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function docker(args) {
  return run('docker', args);
}

function inspectFormat(target, format) {
  return docker(['inspect', '--format', format, target]);
}

function runningContainer(name) {
  const result = inspectFormat(name, '{{.State.Running}}');
  if (!result.ok) return { ok: false, detail: `容器不存在或 Docker 无法检查：${name}` };
  if (result.stdout.trim() !== 'true') return { ok: false, detail: `容器存在但未运行：${name}` };
  return { ok: true };
}

function profileValue(text, key, fallback) {
  const envName = key === 'image' ? 'PENTEST_TOOL_IMAGE' : key === 'digest' ? 'PENTEST_TOOL_DIGEST' : null;
  if (envName !== null && process.env[envName]) return process.env[envName];
  if (key === 'image' || key === 'digest') {
    const match = text.match(
      /allowedImages:[^\r\n]*\r?\n\s*-\s+name:\s*(?:"([^"]+)"|'([^']+)'|(\S+))[^\r\n]*\r?\n\s+digest:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/,
    );
    if (!match) return fallback;
    const value = key === 'image' ? (match[1] ?? match[2] ?? match[3]) : (match[4] ?? match[5] ?? match[6]);
    return value ?? fallback;
  }
  // 沙箱的网络与代理**必须从 profile 读**：它们与镜像摘要同处一段，是同一份部署事实。
  // 只看环境默认值会出「预检通过、运行期走另一条链路」的假绿灯（实测踩过：
  // 预检报 pentest-proxy/pentest-internal，而 profile 用的是 pentest-lab-proxy/pentest-lab-internal）。
  const sandboxKeys = { internalNetwork: 'internalNetwork', proxyHost: 'proxyHost', proxyPort: 'proxyPort', allowEgress: 'allowEgress' };
  const field = sandboxKeys[key];
  if (field === undefined) return fallback;
  // profile 里的沙箱值写成 `!!js process.env.X ?? '默认值'`：先看环境变量，再看该行的
  // **最后一个字面量**（`!!js` 是 YAML 标签，不是值——先前把它当成值解析，预检直接报 `!!js`）。
  const line = text.split(/\r?\n/).find((entry) => new RegExp(`^\\s*${field}:`).test(entry));
  if (line === undefined) return fallback;
  const sandboxEnvName = /process\.env\.(\w+)/.exec(line)?.[1];
  if (sandboxEnvName !== undefined && process.env[sandboxEnvName]) return process.env[sandboxEnvName];
  const literals = [...line.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (literals.length > 0) return literals[literals.length - 1];
  // `proxyPort: !!js Number(process.env.X ?? 18080)` —— 端口是不带引号的数字。
  const numeric = /\?\?\s*(\d+)/.exec(line)?.[1];
  if (numeric !== undefined) return numeric;
  // `allowEgress: true` —— 不带引号的布尔字面量。
  if (/^\s*[^#]*:\s*true\s*$/.test(line)) return 'true';
  if (/^\s*[^#]*:\s*false\s*$/.test(line)) return 'false';
  return fallback;
}

function configuredSandbox() {
  let text;
  try {
    text = readFileSync(PROFILE_FILE, 'utf8');
  } catch (error) {
    throw new Error(`找不到 dsh profile 配置 ${PROFILE_FILE}。请先创建 profile：dsh --profile ${PROFILE} --from-default-profile web --dump-config`);
  }
  const image = profileValue(text, 'image', '127.0.0.1:5005/pentest-tools');
  const digest = profileValue(text, 'digest', '');
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new Error(`profile 的工具镜像摘要无效（${digest || '缺失'}）。请设置 PENTEST_TOOL_DIGEST 为完整 sha256 摘要。`);
  }
  const internalNetwork = profileValue(text, 'internalNetwork', NETWORK);
  const proxyHost = profileValue(text, 'proxyHost', PROXY);
  const portFallback = process.env.PENTEST_PROXY_PORT ?? '8080';
  const proxyPort = Number(profileValue(text, 'proxyPort', portFallback)) || Number(portFallback) || 8080;
  // 「沙箱可达范围 = 宿主可达范围」是**操作者的决定**，必须显式声明才生效：
  // profile 写 `sandbox.allowEgress: true`，或用环境变量临时放开。
  const allowEgress =
    profileValue(text, 'allowEgress', 'false') === 'true' || process.env.PENTEST_ALLOW_SANDBOX_EGRESS === '1';
  return { image, digest, internalNetwork, proxyHost, proxyPort, allowEgress };
}

function checkNetwork(network, proxy, notes = [], allowEgress = false) {
  const internal = inspectFormat(network, '{{.Internal}}');
  if (!internal.ok) return `内部网络不存在：${network}。请执行 sh scripts/dev-sandbox-up.sh up`;
  if (internal.stdout.trim() !== 'true') {
    if (!allowEgress) {
      return (
        `网络 ${network} 存在但不是 internal=true。\n` +
        '  两条路，选一条：\n' +
        '   ① 封闭动作集（默认）：docker network rm 后重建为 --internal 网络；\n' +
        '   ② 让沙箱像宿主一样出网：profile 的 runtime.sandbox 里写 allowEgress: true（或设 PENTEST_ALLOW_SANDBOX_EGRESS=1）。\n' +
        '  选 ② 会把「网络成员集合 = 可达集合」这条范围边界换成「admit 范围裁决 + 逐次人工放行」。'
      );
    }
    // 放开是操作者的显式决定，但**必须每次都提醒**它意味着什么：网络层不再设界。
    notes.push(
      `⚠ 沙箱网络 ${network} 不是 internal：容器与宿主有同样的出网能力，**网络层不再是范围边界**。` +
        '仅剩的闸门是 admit 阶段的范围裁决（选择器/地址/端口记账）与**审批模式**——' +
        '人工审批档逐条人批；高权限档下预设内的动作由服务端自行放行，人类看不到命令内容。' +
        '要恢复封闭可达集合：把该网络重建为 --internal 并去掉 allowEgress。',
    );
  }

  const members = inspectFormat(network, '{{json .Containers}}');
  if (!members.ok) return `无法读取 ${network} 的成员列表`;
  let containers;
  try { containers = JSON.parse(members.stdout.trim() || '{}'); } catch { return `${network} 的 Docker 成员信息无法解析`; }
  const memberNames = Object.values(containers).map((entry) => entry?.Name).filter((name) => typeof name === 'string');
  // 2026-10-04 起沙箱**直连**该网络上的授权目标（不再经 HTTP 代理），所以网络成员不再只有代理：
  // 目标必须与沙箱同网才可达。**该网络的成员集合就是可达集合**——因此多出来的成员必须是
  // 人类显式声明的实验室目标（PENTEST_LAB_TARGETS，逗号分隔），否则拒绝启动。
  const declaredTargets = (process.env.PENTEST_LAB_TARGETS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const undeclared = memberNames.filter((name) => name !== proxy && !declaredTargets.includes(name));
  if (undeclared.length > 0) {
    return (
      `网络 ${network} 上的成员未声明为授权目标：${undeclared.join(', ')}（当前成员：${memberNames.join(', ')}）。` +
      '沙箱直连该网络、成员即可达：把授权目标写进 PENTEST_LAB_TARGETS 再启动，或断开非授权容器。'
    );
  }

  const attached = inspectFormat(proxy, '{{json .NetworkSettings.Networks}}');
  if (!attached.ok) return `无法读取 ${proxy} 的网络连接`;
  let networks;
  try { networks = JSON.parse(attached.stdout.trim()); } catch { return `${proxy} 的 Docker 网络信息无法解析`; }
  const names = Object.keys(networks);
  // 直连部署（2026-10-04 起）：沙箱不再经代理出网，代理**没有理由留在目标网上**——
  // 留在上面等于给沙箱多一个可攻击的邻居（沙箱有 NET_RAW，且同处一个二层域）。
  // 因此这里不再要求代理接入该网络：接上了只点名警告（那是「经代理出网」的旧形态）。
  if (Object.hasOwn(networks, network)) {
    notes.push(
      `${proxy} 仍连接着 ${network}：直连部署不需要它，且沙箱（含 NET_RAW）与它同处二层域。` +
        `确认是旧形态再保留，否则执行 docker network disconnect ${network} ${proxy}`,
    );
  }
  if (!Object.hasOwn(networks, 'bridge') || names.some((name) => name !== network && name !== 'bridge')) {
    return `${proxy} 只能连接 bridge 与 ${network}，当前网络：${names.join(', ')}`;
  }
  return null;
}

function checkProxyAllowlist(proxy) {
  const env = inspectFormat(proxy, '{{range .Config.Env}}{{println .}}{{end}}');
  if (!env.ok) return `无法读取 ${proxy} 的环境变量`;
  const line = env.stdout.split(/\r?\n/).find((entry) => entry.startsWith('EGRESS_ALLOW='));
  const value = line?.slice('EGRESS_ALLOW='.length).trim() ?? '';
  if (value === '') return `${proxy} 未设置 EGRESS_ALLOW；第一轮实战禁止使用全放行代理`;
  if (value.includes('*')) return `${proxy} 的 EGRESS_ALLOW 不得包含通配符`;
  return null;
}

function checkImage(image, digest) {
  const exact = docker(['image', 'inspect', `${image}@${digest}`]);
  if (!exact.ok) return `工具镜像摘要不存在或不匹配：${image}@${digest}。请执行 sh scripts/dev-sandbox-up.sh up，并把输出摘要写入 profile。`;
  const digests = inspectFormat(`${image}@${digest}`, '{{join .RepoDigests "\\n"}}');
  if (!digests.ok || !digests.stdout.split(/\r?\n/).some((entry) => entry.trim() === `${image}@${digest}`)) {
    return `工具镜像 ${image} 的 RepoDigest 与 profile 不一致；请重新推送并更新 profile 中的 digest。`;
  }
  return null;
}

async function checkDatabase() {
  const url = process.env.PENTEST_DATABASE_URL ?? 'postgresql://postgres:check@127.0.0.1:55446/pentest_personal';
  let Pool;
  try {
    ({ Pool } = await import('pg'));
  } catch {
    throw new Error('无法加载 pg，不能安全验证个人数据库；请安装依赖后重试。');
  }
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3_000, max: 1 });
  try {
    const result = await pool.query('SELECT current_database() AS database_name');
    const name = result.rows[0]?.database_name;
    if (!name) throw new Error('连接成功但没有返回数据库名');
    return { url, name };
  } catch (error) {
    const parsed = (() => { try { return new URL(url); } catch { return null; } })();
    const dbName = parsed?.pathname?.substring(1) || '<database>';
    const host = parsed?.hostname || '<host>';
    const port = parsed?.port || '5432';
    // 把**底层原因**一并说出来：只说「不可用或不存在」会把超时、认证失败、权限问题
    // 全都伪装成「数据库没建」，而这三者的修法完全不同（实测被这条误导过一次）。
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `个人数据库连接失败：${dbName}（${host}:${port}）——${cause}\n` +
        `  若确实尚未创建：createdb -h ${host} -p ${port} -U ${parsed?.username || 'postgres'} ${dbName}`,
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
async function checkDatabaseRole(database) {
  let Pool;
  ({ Pool } = await import('pg'));
  const pool = new Pool({ connectionString: database.url, connectionTimeoutMillis: 3_000, max: 1 });
  try {
    // **按设计用 `SET ROLE`**：`pentest_app` 在迁移 002 里建为 NOLOGIN（RLS 测试同样断言
    // `rolcanlogin = false`），运行时经 SET ROLE 降到它。此前这里直接校验「登录用户就是
    // pentest_app」，于是环境为了让启动器满意，把该角色改成了 LOGIN——那既违反迁移的不变量，
    // 也把「用超级用户登录再降权」这条正规路径掩掉了。
    // SET ROLE 之后 `current_user` 是被降权的角色，RLS 按**当前角色**生效（superuser 不能靠
    // SET ROLE 绕过），因此这一步校验是有意义的。
    let effectiveRole;
    try {
      await pool.query('set role pentest_app');
      effectiveRole = 'pentest_app';
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法 SET ROLE pentest_app：${cause}\n` +
          '  连接串请用可登录的管理角色（例如默认的 postgres），运行时降权到 pentest_app；' +
          '不要把 pentest_app 本身改成 LOGIN（迁移 002 与 RLS 测试都要求它是 NOLOGIN）。',
      );
    }
    const result = await pool.query(`
      SELECT current_user,
             rolsuper,
             rolbypassrls
        FROM pg_roles
       WHERE rolname = $1
    `, [effectiveRole]);
    const row = result.rows[0];
    if (row?.rolsuper === true || row?.rolbypassrls === true) {
      if (process.env.PENTEST_ALLOW_SUPERUSER !== '1') {
        throw new Error(
          `运行时数据库角色 ${row.current_user} 具有 superuser/BYPASSRLS；第一轮默认拒绝。` +
          '请改用非特权 pentest_app；仅功能演练可显式设置 PENTEST_ALLOW_SUPERUSER=1（不证明 RLS 隔离）',
        );
      }
      console.warn(`警告：本次运行使用 ${row.current_user}（superuser/BYPASSRLS），仅属于功能演练，不证明 RLS 隔离。`);
      return row.current_user;
    }
    if (row?.current_user !== 'pentest_app') {
      throw new Error(`运行时数据库角色必须是非特权 pentest_app，实际为 ${row?.current_user ?? '<unknown>'}`);
    }
    return row.current_user;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * 迁移新鲜度检查 + 自动应用。
 *
 * **为什么必须在这里**（2026-10-05 实测事故）：profile 刻意设 `migrateOnStartup: false`
 * （运行进程不承担 DDL），于是「升级插件后忘了跑迁移」的表现是——
 * 前置检查全过、服务正常起来，直到某个动作读到新列才炸：
 * `column "skill_freeze" of relation "worker_sessions" does not exist`
 * （用户视角是「渗透通道被后端 schema 错误堵死」）。
 *
 * 本脚本是**管理员工具**（人类显式运行、只做预检与启动），DDL 放这里正合 profile 的立场：
 * 检测到未应用迁移就按 RUNBOOK §1 的同一条命令应用，并把子进程输出原样打印。
 */
async function applyPendingMigrations(database) {
  let Pool;
  ({ Pool } = await import('pg'));
  const files = readdirSync('src/db/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const pool = new Pool({ connectionString: database.url, connectionTimeoutMillis: 3_000, max: 1 });
  let pending;
  try {
    const applied = new Set(
      (await pool.query('select filename from pentest.schema_migrations')).rows.map((r) => r.filename),
    );
    pending = files.filter((f) => !applied.has(f));
  } finally {
    await pool.end().catch(() => {});
  }
  if (pending.length === 0) {
    console.log(`数据库迁移已是最新（${files.length} 个）`);
    return;
  }
  console.log(`检测到 ${pending.length} 个未应用迁移：${pending.join('、')}`);
  console.log('按管理员步骤应用（运行进程不承担 DDL，见 profile 的 migrateOnStartup: false）…');
  const script = [
    "const {migrate}=await import('./src/db/migrate.ts');",
    "const r=await migrate({connectionString:process.env.PENTEST_DATABASE_URL,log:(m)=>console.log('  '+m)});",
    "console.log('  applied='+r.appliedFiles.length+' databaseVersion='+r.databaseVersion+' codeVersion='+r.codeVersion);",
  ].join(' ');
  const result = run(process.execPath, ['--experimental-strip-types', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, PENTEST_DATABASE_URL: database.url },
  });
  if (result.stdout.trim() !== '') console.log(result.stdout.trimEnd());
  if (!result.ok) {
    throw new Error(
      `迁移应用失败（exit ${String(result.status)}）：${(result.stderr || result.error?.message || '').trim().slice(0, 400)}`,
    );
  }
}

async function checkDatabaseSchema(database) {
  let Pool;
  ({ Pool } = await import('pg'));
  const pool = new Pool({ connectionString: database.url, connectionTimeoutMillis: 3_000, max: 1 });
  try {
    const result = await pool.query(`
      SELECT to_regclass('pentest.schema_migrations') AS migrations,
             to_regclass('pentest.approvals') AS approvals,
             to_regclass('pentest.context_events') AS context_events,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_trgm
    `);
    const row = result.rows[0];
    const missing = ['migrations', 'approvals', 'context_events'].filter((key) => row?.[key] === null);
    if (missing.length > 0 || row?.has_vector !== true || row?.has_trgm !== true) {
      throw new Error(`个人数据库 schema 未就绪：缺少 ${missing.join(', ') || '必需扩展'}；请先执行 npm run db:verify -- --keep`);
    }
    return database;
  } finally {
    await pool.end().catch(() => {});
  }
}

function checkLedgerSecret() {
  const secret = process.env.PENTEST_LEDGER_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    return 'PENTEST_LEDGER_SECRET 必须至少 32 字节；不要使用 profile 内置示例值';
  }
  return null;
}

function preflight() {
  const failures = [];
  const notes = [];
  if (!docker(['info']).ok) failures.push('Docker Desktop 未运行；请先启动 Docker Desktop。');
  let sandbox = null;
  try { sandbox = configuredSandbox(); } catch (error) { failures.push(error.message); }
  // 网络与代理**一律用 profile 的值**（与环境默认可能不同，实测踩过：
  // 预检报 pentest-proxy/pentest-internal，而运行期走 pentest-lab-proxy/pentest-lab-internal）。
  const network = sandbox?.internalNetwork ?? NETWORK;
  const proxy = sandbox?.proxyHost ?? PROXY;
  for (const name of [REGISTRY, proxy]) {
    const result = runningContainer(name);
    if (!result.ok) failures.push(result.detail);
  }
  const networkFailure = checkNetwork(network, proxy, notes, sandbox?.allowEgress ?? process.env.PENTEST_ALLOW_SANDBOX_EGRESS === '1');
  if (networkFailure) failures.push(networkFailure);
  if (!networkFailure) {
    const proxyAllowlistFailure = checkProxyAllowlist(proxy);
    if (proxyAllowlistFailure) failures.push(proxyAllowlistFailure);
  }
  const secretFailure = checkLedgerSecret();
  if (secretFailure) failures.push(secretFailure);
  if (sandbox) {
    const imageFailure = checkImage(sandbox.image, sandbox.digest);
    if (imageFailure) failures.push(imageFailure);
  }
  return { failures, notes, sandbox, network, proxy };
}

function printReady(url) {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────────────────╮');
  console.log('  │  控制台已就绪，在浏览器打开：                            │');
  console.log('  ╰──────────────────────────────────────────────────────────╯');
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log('  进界面后：设置 → 插件 → 渗透作业。');
  console.log('  关闭本窗口即停止服务。');
  console.log('');
  if (process.env.PENTEST_NO_OPEN !== '1') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

async function waitForReady(child, logs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let timer;
    let settled = false;
    let lastFailure = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(url);
    };
    const onError = (error) => finish(new Error(`dsh 子进程启动失败：${error.message}`));
    const onClose = (code, signal) => {
      if (!settled) finish(new Error(`dsh 子进程在就绪前退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`));
    };
    const poll = async () => {
      if (settled) return;
      const match = logs.join('').match(/(https?:\/\/[^\s"']+\?token=[A-Za-z0-9_-]+)/);
      if (match) {
        const url = match[1];
        try {
          // dsh 的 token URL 首次返回 303，并通过 HttpOnly cookie 建立会话；Node fetch
          // 不持久化 cookie，自动跟随会把 token 丢掉并误报 401。手动完成这条握手。
          const bootstrap = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(2_000),
          });
          const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
          const location = bootstrap.headers.get('location');
          if (bootstrap.status < 300 || bootstrap.status >= 400 || cookie === undefined || location === null) {
            lastFailure = `HTTP ${bootstrap.status}; dsh token handshake did not set an auth cookie`;
          } else {
            const base = new URL(url);
            const pageUrl = new URL(location, base).toString();
            const response = await fetch(pageUrl, {
              headers: { Cookie: cookie },
              signal: AbortSignal.timeout(2_000),
            });
            const body = await response.text();
            if (response.ok && body.includes('__DSH_BOOT__')) {
              finish(null, url);
              return;
            }
            lastFailure = `HTTP ${response.status}; authenticated dsh page marker __DSH_BOOT__ missing`;
          }
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
        }
      }
      if (Date.now() >= deadline) {
        const tail = logs.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
        finish(new Error(`dsh 在 ${Math.ceil(READY_TIMEOUT_MS / 1000)} 秒内没有返回已认证的可用页面${lastFailure ? `（${lastFailure}）` : ''}；最后日志：\n${tail || '（没有日志）'}`));
        return;
      }
      timer = setTimeout(() => { void poll(); }, 250);
    };
    child.once('error', onError);
    child.once('close', onClose);
    void poll();
  });
}

const { failures, notes, sandbox, network, proxy } = preflight();
for (const note of notes) console.log(`提醒：${note}`);
if (sandbox && failures.length === 0) {
  try {
    const database = await checkDatabase();
    await checkDatabaseRole(database);
    await checkDatabaseSchema(database);
    await applyPendingMigrations(database);
    console.log(`前置检查通过：Docker、${network}、${proxy}、工具镜像摘要、个人数据库 ${database.name}`);
    process.env.PENTEST_DATABASE_URL = database.url;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
if (failures.length > 0) {
  console.error('启动前检查失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`启动 dsh（profile: ${PROFILE}，端口 ${PORT}）…`);
  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--port', PORT], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME, PENTEST_DATABASE_URL: process.env.PENTEST_DATABASE_URL },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const logs = [];
  const collect = (chunk) => { const text = chunk.toString('utf8'); logs.push(text); process.stdout.write(text); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  const onChildError = (error) => {
    if (process.exitCode === undefined) {
      console.error(`dsh 子进程错误：${error.message}`);
      process.exitCode = 1;
    }
  };
  const onChildClose = (code, signal) => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (process.exitCode === undefined) process.exitCode = code ?? (signal ? 1 : 0);
  };
  child.on('error', onChildError);
  child.once('close', onChildClose);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const url = await waitForReady(child, logs);
    printReady(url);
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    stop();
    process.exitCode = 1;
  }
}
