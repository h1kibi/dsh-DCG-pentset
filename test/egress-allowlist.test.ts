/**
 * 出口白名单与范围的自动对齐（`src/execution/egress-allowlist.ts`）。
 *
 * 不碰真实 docker：进程运行器是注入的，断言的是**我们发出的 docker 命令**与
 * **重建时是否原样保留了人类的部署定制**（镜像/命令/环境变量/端口/挂载/网络）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProcessRunner } from '../src/execution/docker-sandbox.ts';
import {
  egressHostsForScope,
  readEgressAllowlist,
  syncEgressAllowlist,
  unrepresentableEgressEntries,
  withEgressSync,
  type EgressScopeTarget,
} from '../src/execution/egress-allowlist.ts';

// ───────────────────────────── 范围 → 主机 ─────────────────────────────

test('范围条目 → 出口白名单主机：URL 取 hostname，标签与网段跳过，排除项优先', () => {
  const targets = [
    { kind: 'url', value: 'http://47.109.76.66:3002/' },
    { kind: 'ip', value: '10.0.0.5' },
    { kind: 'domain', value: 'lab.example.com' },
    { kind: 'cidr', value: '192.0.2.0/24' },
    { kind: 'asset-label', value: '内部靶场 A' },
    { kind: 'url', value: '不是 URL' },
    { kind: 'domain', value: '  ' },
  ];
  const hosts = egressHostsForScope(targets, [{ kind: 'ip', value: '10.0.0.5' }]);
  assert.deepEqual(hosts, ['47.109.76.66', 'lab.example.com']);
  // 端口不属于白名单语义（代理按主机比对，端口粒度在插件的范围闸门里）。
  assert.equal(hosts.includes('47.109.76.66:3002'), false);
  // 网段：代理没有网段运算 —— 显式跳过并**回报**，而不是写一条永远不匹配的死条目。
  assert.deepEqual(unrepresentableEgressEntries(targets), ['192.0.2.0/24']);
});

// ───────────────────────────── 同步 ─────────────────────────────

/** 代理容器的 inspect 输出：形状照抄真实容器（只改白名单值）。 */
function proxyInspect(allow: string): string {
  return JSON.stringify([
    {
      Config: {
        Image: 'python:3.10-slim-bookworm',
        Cmd: ['python3', '/proxy/egress-proxy.py', '--port', '18080'],
        Entrypoint: null,
        Env: [`EGRESS_ALLOW=${allow}`, 'PATH=/usr/local/bin', 'LANG=C.UTF-8'],
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: { '18080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] },
      },
      Mounts: [
        { Type: 'bind', Source: 'C:/Projects/Agent-projects/dsh-DCG-pentest/scripts/egress-proxy.py', Destination: '/proxy/egress-proxy.py', RW: false },
      ],
      NetworkSettings: { Networks: { bridge: {}, 'pentest-lab-internal': {} } },
    },
  ]);
}

interface FakeDocker {
  readonly runner: ProcessRunner;
  readonly calls: string[][];
}

function fakeDocker(options: { readonly inspect: (argv: readonly string[]) => { code: number; stdout: string; stderr: string } }): FakeDocker {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(argv) {
        calls.push([...argv]);
        if (argv.includes('inspect') && argv.includes('{{range .Config.Env}}{{println .}}{{end}}')) {
          const result = options.inspect(argv);
          return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, aborted: false };
        }
        if (argv.includes('inspect')) {
          const result = options.inspect(argv);
          return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, aborted: false };
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
      },
    },
  };
}

const deps = (docker: FakeDocker, log?: (message: string) => void) => ({
  runner: docker.runner,
  proxyContainer: 'pentest-lab-proxy',
  internalNetwork: 'pentest-lab-internal',
  log,
});

test('白名单已覆盖本次范围时不重建容器（不打扰基础设施）', async () => {
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: proxyInspect('172.17.0.7,47.109.76.66'), stderr: '' }) });
  const result = await syncEgressAllowlist(deps(docker), ['47.109.76.66']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, false);
  assert.deepEqual(result.before, ['172.17.0.7', '47.109.76.66']);
  assert.equal(
    docker.calls.some((argv) => argv.includes('rm') || argv.includes('run')),
    false,
    '已覆盖就不该删/建容器',
  );
});

test('缺少目标时按原规格重建：只换 EGRESS_ALLOW，其它定制原样保留', async () => {
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: proxyInspect('172.17.0.7,172.17.0.2'), stderr: '' }) });
  const logged: string[] = [];
  const result = await syncEgressAllowlist(deps(docker, (message) => logged.push(message)), ['47.109.76.66']);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.deepEqual(result.after, ['172.17.0.2', '172.17.0.7', '47.109.76.66'], '并集：人类设的条目不许被删');

  const rename = docker.calls.find((argv) => argv[1] === 'rename');
  assert.deepEqual(rename, ['docker', 'rename', 'pentest-lab-proxy', 'pentest-lab-proxy.rebuild-old'],
    '先改名旧容器（不是先删）：run 失败时才能回滚');
  const run = docker.calls.find((argv) => argv[1] === 'run');
  assert.ok(run !== undefined, '必须发出 docker run');
  const args = (run ?? []).join(' ');
  assert.match(args, /--name pentest-lab-proxy/);
  assert.match(args, /--restart unless-stopped/, '重启策略要保留');
  assert.match(args, /-e EGRESS_ALLOW=172\.17\.0\.2,172\.17\.0\.7,47\.109\.76\.66/, '只换白名单值');
  assert.match(args, /-e PATH=\/usr\/local\/bin/, '其它环境变量要保留');
  assert.match(args, /-p 127\.0\.0\.1:18080:18080/, '端口映射要保留');
  assert.match(args, /-v .*egress-proxy\.py:\/proxy\/egress-proxy\.py:ro/, '只读挂载要保留');
  assert.match(args, /--network bridge/, '原本的网络要保留');
  assert.match(args, /python:3\.10-slim-bookworm python3 \/proxy\/egress-proxy\.py --port 18080/, '镜像与命令要保留');
  assert.equal(args.includes('EGRESS_ALLOW=172.17.0.7,172.17.0.2'), false, '旧的白名单值不得重复出现');
  // 主网络必须选 `bridge`（代理自己的出网），内网靠 connect —— 即便内网在 inspect 里排在前面。
  assert.match(args, /--network bridge/, '主网络必须是 bridge');

  const connects = docker.calls.filter((argv) => argv[1] === 'network' && argv[2] === 'connect');
  assert.deepEqual(
    connects,
    [['docker', 'network', 'connect', 'pentest-lab-internal', 'pentest-lab-proxy']],
    '重建后必须把内网接回去（非 bridge 的网络逐个 connect；内网是硬要求）',
  );
  const cleanup = docker.calls.find((argv) => argv[1] === 'rm' && argv[3] === 'pentest-lab-proxy.rebuild-old');
  assert.ok(cleanup !== undefined, '成功后要清掉改名保留的旧容器');
  assert.equal(logged.length, 1, '同步成功要留一行日志');
});

test('读不到代理容器时明确失败并指向 RUNBOOK，而不是静默跳过', async () => {
  const docker = fakeDocker({ inspect: () => ({ code: 1, stdout: '', stderr: 'No such object' }) });
  const result = await syncEgressAllowlist(deps(docker), ['47.109.76.66']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /RUNBOOK/, '要把人指向处置规程');
  assert.equal(await readEgressAllowlist(deps(docker)), null, '读不到就是 null，不猜');
});

test('没有可放行的主机时拒绝改白名单（不把代理改成空），并说清是「推导不出」而不是「无需放行」', async () => {
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: proxyInspect('172.17.0.7'), stderr: '' }) });
  const result = await syncEgressAllowlist(deps(docker), []);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /网段|标签/, '要说清为什么推导不出主机');
  assert.equal(docker.calls.length, 0, '连 inspect 都不该发');
});

test('加固项按原样复制，复制不了的要在重建前告警（安全边界不许静默变弱）', async () => {
  const withHardening = JSON.stringify([
    {
      Config: {
        Image: 'python:3.10-slim-bookworm',
        Cmd: ['python3', '/proxy/egress-proxy.py'],
        Entrypoint: null,
        Env: ['EGRESS_ALLOW=172.17.0.7', 'PATH=/usr/local/bin'],
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: {},
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=64m' },
        PidsLimit: 128,
      },
      Mounts: [],
      NetworkSettings: { Networks: { bridge: {} } },
    },
  ]);
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: withHardening, stderr: '' }) });
  const logged: string[] = [];
  const result = await syncEgressAllowlist(deps(docker, (message) => logged.push(message)), ['47.109.76.66']);
  assert.equal(result.ok, true);
  const args = (docker.calls.find((argv) => argv[1] === 'run') ?? []).join(' ');
  assert.match(args, /--cap-drop ALL/, 'cap-drop 必须复制（否则重建后容器能力变大）');
  assert.match(args, /--security-opt no-new-privileges/);
  assert.match(args, /--read-only/);
  assert.match(args, /--tmpfs \/tmp:rw,size=64m/, 'tmpfs 要连挂载选项一起复制');
  assert.ok(
    logged.some((line) => line.includes('PidsLimit')),
    '复制不了的项必须在重建前告警（这里 PidsLimit=128）',
  );
});

test('容器没连 bridge 时不会把内网 connect 两次（否则每次同步都失败并回滚）', async () => {
  const internalOnly = JSON.stringify([
    {
      Config: { Image: 'img', Cmd: ['c'], Entrypoint: null, Env: ['EGRESS_ALLOW=172.17.0.7'] },
      HostConfig: { RestartPolicy: { Name: 'no' }, PortBindings: {} },
      Mounts: [],
      NetworkSettings: { Networks: { 'pentest-lab-internal': {} } },
    },
  ]);
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: internalOnly, stderr: '' }) });
  const result = await syncEgressAllowlist(deps(docker), ['47.109.76.66']);
  assert.equal(result.ok, true);
  const connects = docker.calls.filter((argv) => argv[1] === 'network' && argv[2] === 'connect');
  assert.deepEqual(connects, [], 'primary 就是内网时不该再 connect 它一次');
});

test('withEgressSync：方法名对不上时抛装配错误，而不是静默跳过', () => {
  class Any {
    async something(): Promise<void> {}
  }
  assert.throws(
    () => withEgressSync(new Any(), async () => undefined, { confirm: 'doesNotExist', amend: 'alsoMissing' }),
    /装配错位/,
  );
});

test('重建失败时回滚到旧容器（改回去），不留一个没有代理的部署', async () => {
  const docker = fakeDocker({ inspect: () => ({ code: 0, stdout: proxyInspect('172.17.0.7'), stderr: '' }) });
  const failing: ProcessRunner = {
    async run(argv) {
      docker.calls.push([...argv]);
      if (argv[1] === 'inspect') return { code: 0, stdout: proxyInspect('172.17.0.7'), stderr: '', timedOut: false, aborted: false };
      if (argv[1] === 'run') return { code: 125, stdout: '', stderr: 'port is already allocated', timedOut: false, aborted: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    },
  };
  const result = await syncEgressAllowlist(
    { runner: failing, proxyContainer: 'pentest-lab-proxy', internalNetwork: 'pentest-lab-internal' },
    ['47.109.76.66'],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /已回滚/, '失败必须回滚，不能把部署留在「没有代理」的状态');
  const rollback = docker.calls.filter((argv) => argv[1] === 'rename');
  assert.deepEqual(
    rollback.at(-1),
    ['docker', 'rename', 'pentest-lab-proxy.rebuild-old', 'pentest-lab-proxy'],
    '最后一步是把旧容器改回原名',
  );
});

// ─────────────────── 包装器必须保住原实例的方法与私有字段 ───────────────────

/**
 * 回归锁：`{...inner}` 对**类实例**只复制自有可枚举属性——方法在原型上，展开出来就是空壳，
 * 控制台其余方法（getState/listEngagements/pause…）会变成 undefined 并在运行时炸，
 * 而 TS 的展开类型是乐观的、编译期看不出来（2026-10-04 自审抓到的 Critical）。
 */
test('withEgressSync 保住原型方法、私有字段与方法身份，只在两个范围入口上挂钩', async () => {
  class FakeWorkflow {
    #secret = 'private-slot';
    readonly confirmed: unknown[] = [];
    async getState(): Promise<string> {
      return `state:${this.#secret}`;
    }
    async pause(): Promise<string> {
      return 'paused';
    }
    async confirmScopeProposal(input: { readonly targets: readonly EgressScopeTarget[] }): Promise<string> {
      this.confirmed.push(input);
      return 'confirmed';
    }
    async amendScope(input: { readonly targets: readonly EgressScopeTarget[] }): Promise<string> {
      this.confirmed.push(input);
      return 'amended';
    }
  }

  const inner = new FakeWorkflow();
  // 记下每次同步收到的 targets（类型放宽到 unknown：这里只关心「同步发生了几次、内容是什么」）。
  const synced: unknown[] = [];
  const wrapped = withEgressSync(inner, async (targets: readonly EgressScopeTarget[]) => { synced.push(targets); });

  // ① 未包装的方法照常可用（私有字段也拿得到 → `bind(target)` 确实把 this 指回原实例）。
  assert.equal(await wrapped.getState(), 'state:private-slot');
  assert.equal(await wrapped.pause(), 'paused');

  // ② 方法身份稳定（每次访问都 `bind` 会让 `a.m === a.m` 为假）。
  assert.equal(wrapped.getState, wrapped.getState);

  // ③ 两个范围入口：先走原实现，成功后再同步白名单。
  assert.equal(await wrapped.confirmScopeProposal({ targets: [{ kind: 'ip', value: '47.109.76.66' }] }), 'confirmed');
  assert.equal(inner.confirmed.length, 1, '原实现必须被调用');
  assert.deepEqual(synced, [[{ kind: 'ip', value: '47.109.76.66' }]], '确认后必须同步一次');

  // ④ 原实现抛错时**不同步**（范围没变就不该动白名单）。
  class Failing extends FakeWorkflow {
    override async amendScope(): Promise<string> {
      throw new Error('stale_state_version');
    }
  }
  let failingSyncs = 0;
  const failing = withEgressSync(new Failing(), async () => { failingSyncs += 1; });
  await assert.rejects(
    () => (failing as unknown as { amendScope(input: unknown): Promise<string> }).amendScope({
      targets: [{ kind: 'ip', value: '10.0.0.1' }],
    }),
    /stale_state_version/,
  );
  assert.equal(failingSyncs, 0, '失败的修订不得触发白名单同步');
});
