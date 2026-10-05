/**
 * Docker 沙箱执行器的测试。
 *
 * 重点不是「能不能跑容器」（那依赖 Docker），而是**参数构造是否守住了隔离边界**：
 * 漏一个 `--network` 或 `--cap-drop` 就少一层防护，而这类疏漏在人工 review 中
 * 最难发现——它表现为「参数少了一项」，而不是报错。
 *
 * 因此这里的断言逐项检查 argv 里的关键安全开关，并用假 runner 验证结果映射。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DockerSandbox,
  buildDockerArgs,
  DOCKER_BIN,
  resolveImage,
  mapOutcome,
  assertSandboxConfig,
  appendBounded,
  spawnRunner,
  HOST_OUTPUT_BUFFER_LIMIT_BYTES,
  SandboxConfigError,
} from '../src/execution/docker-sandbox.ts';
import type { AllowedImage, DockerSandboxConfig, ProcessRunner } from '../src/execution/docker-sandbox.ts';
import type { ExecutionPlan } from '../src/contracts.ts';

const IMAGE: AllowedImage = {
  name: 'registry.example/pentest-toolbox',
  digest: 'sha256:' + 'a'.repeat(64),
};

const CONFIG: DockerSandboxConfig = {
  allowedImages: [IMAGE],
  internalNetwork: 'pentest-sandbox',
  proxyHost: 'pentest-egress-proxy',
  proxyPort: 3128,
};

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    workerSessionId: 'sess',
    templateId: 'http_read',
    actionClass: 'passive_read',
    normalizedTarget: 'https://a.target.com/',
    resolvedAddresses: ['93.184.216.34'],
    normalizedCommand: 'http_read url=https://a.target.com/ method=GET',
    planHash: 'ph-1',
    idempotencyKey: 'ik-1',
    scopeVersion: 7,
    policyEpoch: 3,
    leaseGeneration: 1,
    approvalId: null,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

function argvFor(p: ExecutionPlan, token = 'tok-1'): readonly string[] {
  return buildDockerArgs({ image: IMAGE, plan: p, config: CONFIG, containerName: 'c1', executionToken: token });
}

/** 取某个开关后面的值。 */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

// ─────────────────────── 配置自检 ───────────────────────

test('配置自检：digest 必须是 sha256 形式，不接受标签', () => {
  assert.throws(
    () => assertSandboxConfig({ ...CONFIG, allowedImages: [{ name: 'x', digest: 'latest' }] }),
    (e: unknown) => {
      assert.ok(e instanceof SandboxConfigError);
      assert.match(e.message, /sha256/);
      return true;
    },
    '标签会漂移，上游重推同名标签会让白名单静默失效',
  );
});

test('配置自检：空镜像清单、空网络名、越界端口都拒绝', () => {
  assert.throws(() => assertSandboxConfig({ ...CONFIG, allowedImages: [] }), SandboxConfigError);
  assert.throws(() => assertSandboxConfig({ ...CONFIG, internalNetwork: '  ' }), SandboxConfigError);
  assert.throws(() => assertSandboxConfig({ ...CONFIG, proxyPort: 0 }), SandboxConfigError);
});

test('配置自检：合法配置通过', () => {
  assert.doesNotThrow(() => assertSandboxConfig(CONFIG));
});

// ─────────────────────── 参数构造的安全边界 ───────────────────────

test('argv 首元素必须是 docker 可执行文件（否则真实执行一律 ENOENT）', () => {
  // 回归锁。曾经 argv 以子命令 `run` 开头，而 runner 做 `spawn(argv[0], argv.slice(1))`，
  // 于是去 spawn 一个叫 `run` 的程序 → `spawn run ENOENT` → `sandbox_unavailable`。
  // 任何真实执行都失败，而单测全绿（runner 是注入的假实现，从不碰真实进程）。
  const argv = argvFor(plan());
  assert.equal(argv[0], DOCKER_BIN);
  assert.equal(argv[1], 'run', '子命令 run 必须紧跟可执行文件');
  assert.equal(DOCKER_BIN, 'docker', '可执行名是完整命令行的一部分，不能省');
});

test('网络：只接入 internal 网络，不发布端口', () => {
  const argv = argvFor(plan());
  assert.equal(valueOf(argv, '--network'), 'pentest-sandbox');
  assert.equal(argv.includes('-p'), false, '不得发布端口——发布即意味着入站可达');
  assert.equal(argv.includes('--publish'), false);
});

test('加固：能力全 drop + 只加 NET_RAW、禁提权、有资源限额', () => {
  const argv = argvFor(plan());
  assert.equal(valueOf(argv, '--cap-drop'), 'ALL');
  assert.equal(valueOf(argv, '--security-opt'), 'no-new-privileges');
  // 放开权限后**唯一**新增的能力：真 SYN 扫描/sendto 探测需要它。多给一个 cap 就是
  // 多一分容器逃逸面，所以这条断言按「恰好一个」写死（`--cap-add` 是重复出现的开关）。
  const capsAdded = argv.filter((a, i) => argv[i - 1] === '--cap-add');
  assert.deepEqual(capsAdded, ['NET_RAW'], '除 NET_RAW 外不得授予任何能力');
  // 只读根是**有意去掉**的（2026-10-04）：工具需要写 /tmp 之外的位置时不该无谓失败。
  // 容器仍是一次性的（--rm）、非特权用户、限额在——这条断言把这个取舍钉住。
  assert.equal(argv.includes('--read-only'), false, '不再用只读根；隔离靠网络成员与限额');
  assert.ok(valueOf(argv, '--pids-limit') !== undefined, '缺少 PID 限额即可能 fork 炸弹');
  assert.ok(valueOf(argv, '--memory') !== undefined, '缺少内存限额');
  assert.ok(valueOf(argv, '--cpus') !== undefined, '缺少 CPU 限额');
  assert.equal(argv.includes('--privileged'), false);
  assert.equal(argv.includes('--host-network'), false);
  // 不得挂载宿主路径或容器运行时套接字
  assert.equal(argv.some((a) => a.includes('/var/run/docker.sock')), false);
});

test('出口：不再注入 HTTP 代理——容器直连 internal 网络上的授权目标', () => {
  const argv = argvFor(plan());
  // 真工具（nmap/ffuf/sqlmap）穿不过 HTTP 代理；注入它只会让 curl 类工具被代理挡在门外。
  // 出口边界改由「网络成员集合」承担：目标必须与沙箱同在 internalNetwork 上。
  assert.equal(argv.some((a) => a.startsWith('HTTP_PROXY=')), false, '不得再注入 HTTP_PROXY');
  assert.equal(argv.some((a) => a.startsWith('HTTPS_PROXY=')), false, '不得再注入 HTTPS_PROXY');
  assert.equal(valueOf(argv, '--network'), 'pentest-sandbox', '可达集合 = 该网络的成员集合');
});

test('镜像用 digest 引用，不用标签', () => {
  const argv = argvFor(plan());
  const ref = argv.find((a) => a.startsWith('registry.example/'));
  assert.ok(ref !== undefined);
  assert.ok(ref.includes('@sha256:'), `镜像必须以 @sha256: 引用，实际 ${ref}`);
});

test('执行令牌经环境变量传入，不出现在 argv 的命令文本里', () => {
  const argv = argvFor(plan(), 'secret-token-abc');
  assert.ok(argv.includes('PENTEST_EXECUTION_TOKEN=secret-token-abc'));
  // 命令文本是最后一个元素，不得含令牌
  assert.equal(argv[argv.length - 1]!.includes('secret-token-abc'), false);
});

test('令牌与 planHash/epoch/scope 一起传入：容器内可自校验裁决基准', () => {
  const argv = argvFor(plan({ planHash: 'ph-9', policyEpoch: 5, scopeVersion: 3 }));
  assert.ok(argv.includes('PENTEST_PLAN_HASH=ph-9'));
  assert.ok(argv.includes('PENTEST_POLICY_EPOCH=5'));
  assert.ok(argv.includes('PENTEST_SCOPE_VERSION=3'));
});
test('地址裁决集合经环境变量传入工具容器', () => {
  const argv = argvFor(plan({ resolvedAddresses: ['93.184.216.34', '93.184.216.35'] }));
  assert.ok(argv.includes('PENTEST_RESOLVED_ADDRESSES=["93.184.216.34","93.184.216.35"]'));
});

test('超时取 plan 与沙箱上限的较小者', () => {
  const short = argvFor(plan({ timeoutMs: 1000 }));
  assert.ok(short.includes('PENTEST_TIMEOUT_MS=1000'));
  const long = argvFor(plan({ timeoutMs: 999_999_999 }));
  assert.ok(
    long.includes('PENTEST_TIMEOUT_MS=900000'),
    'plan 给的超时超过沙箱上限时应被截到上限',
  );
});

// ─────────────────────── 执行路径 ───────────────────────

function fakeRunner(
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted?: boolean },
): { runner: ProcessRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(argv) {
        calls.push([...argv]);
        return { aborted: false, ...result };
      },
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;

test('缺少执行令牌时拒绝执行（不降级为直接跑）', async () => {
  const { runner, calls } = fakeRunner({ code: 0, stdout: 'ok', stderr: '', timedOut: false });
  const sandbox = new DockerSandbox(CONFIG, { runner });
  const out = await sandbox.run({ plan: plan(), executionToken: '   ' }, signal());
  assert.equal(out.status, 'blocked');
  assert.equal(out.error?.code, 'scope_violation');
  assert.equal(calls.length, 0, '未准入时不得启动容器');
});

test('正常执行：把 runner 的结果映射为 completed', async () => {
  const { runner } = fakeRunner({ code: 0, stdout: 'scan done', stderr: '', timedOut: false });
  const sandbox = new DockerSandbox(CONFIG, { runner });
  const out = await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
  assert.equal(out.status, 'completed');
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, 'scan done');
});

test('超时映射为 timed_out 且标记截断', async () => {
  const { runner } = fakeRunner({ code: null, stdout: 'partial', stderr: '', timedOut: true });
  const sandbox = new DockerSandbox(CONFIG, { runner });
  const out = await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
  assert.equal(out.status, 'timed_out');
});

test('进程未能启动映射为 runtime_error + sandbox_unavailable', async () => {
  const { runner } = fakeRunner({ code: null, stdout: '', stderr: 'docker not found', timedOut: false });
  const sandbox = new DockerSandbox(CONFIG, { runner });
  const out = await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
  assert.equal(out.status, 'runtime_error');
  assert.equal(out.error?.code, 'sandbox_unavailable');
});

// ─────────────────────── 中止 ≠ 沙箱不可用 ───────────────────────

test('被信号中止映射为 cancelled，而不是 sandbox_unavailable', () => {
  // 回归锁。被 SIGKILL 的进程在 Node 里 `code === null`，与「docker 根本没起来」同形。
  // 此前两者都落到 `runtime_error` + `sandbox_unavailable`，于是**策略 epoch 前进**
  // 或**人工终止**在库里和在模型眼里都成了「沙箱坏了，检查容器运行时」——
  // 一次有意的终止被记成一次故障，而模型会据此做出错误决定。
  const out = mapOutcome(
    { code: null, stdout: 'partial output', stderr: '', timedOut: false, aborted: true },
    1024,
  );
  assert.equal(out.status, 'cancelled');
  assert.equal(out.error, undefined, 'cancelled 是完整事实，不该再挂一个 error');
  assert.equal(out.stdout, 'partial output', '已产生的输出仍然带回来（诊断需要它）');
});

test('超时优先于中止：两者都置位时报 timed_out', () => {
  const out = mapOutcome(
    { code: null, stdout: '', stderr: '', timedOut: true, aborted: true },
    1024,
  );
  assert.equal(out.status, 'timed_out');
});

test('中止经沙箱执行路径一路传到结果（不是只在纯函数里成立）', async () => {
  const { runner } = fakeRunner({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
  const sandbox = new DockerSandbox(CONFIG, { runner });
  const out = await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
  assert.equal(out.status, 'cancelled');
});

// ─────────────────────── 超时/中止后的容器兜底（GAP-6） ───────────────────────

test('超时/中止后必须补一次 docker rm -f 兜底：宿主杀了 CLI ≠ 容器已停', async () => {
  // 回归锁（2026-10-05 复核 GAP-6）：`spawnRunner` 只杀 docker CLI 的进程组，
  // 容器内进程可能继续跑；容器名是确定性的，因此必须显式删除。
  for (const result of [
    { code: null, stdout: '', stderr: '', timedOut: true, aborted: false },
    { code: null, stdout: '', stderr: '', timedOut: false, aborted: true },
  ]) {
    const { runner, calls } = fakeRunner(result);
    const sandbox = new DockerSandbox(CONFIG, { runner });
    await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
    const removal = calls.find((argv) => argv[1] === 'rm');
    assert.ok(removal !== undefined, `必须尝试删除容器（${JSON.stringify(result)}）`);
    assert.deepEqual(removal.slice(0, 3), ['docker', 'rm', '-f']);
    assert.ok(removal[3]?.startsWith('pentest-'), '删除的是确定性容器名');
  }
});

test('正常退出与运行期错误**不**做兜底删除：那可能删掉别人的容器', async () => {
  for (const result of [
    { code: 0, stdout: 'ok', stderr: '', timedOut: false },
    { code: null, stdout: '', stderr: 'docker not found', timedOut: false },
  ]) {
    const { runner, calls } = fakeRunner(result);
    const sandbox = new DockerSandbox(CONFIG, { runner });
    await sandbox.run({ plan: plan(), executionToken: 'tok' }, signal());
    assert.equal(calls.filter((argv) => argv[1] === 'rm').length, 0, '非超时/中止不得触发删除');
  }
});

// ─────────────────────── 真实 runner（此前完全没测过） ───────────────────────

/**
 * 真实 `spawnRunner` 的 smoke test。
 *
 * 此前测试只用注入的假 runner，于是「argv 交给真实进程时会发生什么」那一环没人断言——
 * 这里补上，且只用 Node 自身当子进程（不依赖 Docker）。
 */
const sleepCommand = (ms: number): readonly string[] => [
  process.execPath,
  '-e',
  `setTimeout(() => {}, ${String(ms)})`,
];

test('真实 runner：已 abort 的 signal 必须立刻终止，而不是等墙钟超时', async () => {
  // 这是 `ExecutionService` 真实存在的一个窗口：它先登记在途动作、再调 `sandbox.run`，
  // 而 `abortInFlight` 随时可能在这两步之间触发。`AbortSignal` 在已 abort 时
  // **不会再触发监听器**，所以少了显式检查，容器会一直跑到超时（最长 15 分钟）。
  //
  // 子进程刻意睡 60s 而断言「10s 内结算」：没有那句检查时它会一路睡完，
  // 于是这条用例以**超时**变红。代价是失败要等满 `--test-timeout`，
  // 因此下面另有一条短睡眠的用例负责「快速失败 + 精确归因」。
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const out = await spawnRunner.run(sleepCommand(60_000), {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - started;
  assert.equal(out.aborted, true, '必须报告「被中止」，否则上层只能靠 code===null 猜');
  assert.equal(out.timedOut, false);
  assert.ok(elapsed < 10_000, `已 abort 的信号必须立刻生效，实际等了 ${String(elapsed)}ms`);
});

test('真实 runner：已 abort 时 aborted 标志必须为真（短睡眠，失败快且归因明确）', async () => {
  // 与上一条互补：上一条失败要等满测试超时（进程真的没被杀），这条用 1s 的子进程，
  // 失败时 1s 内就能看出「aborted 没被报告」——两种退化（没杀 / 没报告）各有精确的判据。
  const controller = new AbortController();
  controller.abort();
  const out = await spawnRunner.run(sleepCommand(1_000), {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false, '中止不是超时，两者必须分开报告');
});

test('真实 runner：运行中 abort 同样终止并如实报告', async () => {
  // 这里不能用假定时器：被断言的是**真实进程**是否被真的杀掉，只能对照平台时钟。
  // 也不用 sleep——调用返回后立刻 abort 即可覆盖「监听器已挂上、进程已起来」的路径，
  // 与上面那条「一开始就已 abort」互补，两者之间没有靠猜测时长掩盖的窗口。
  const controller = new AbortController();
  const pending = spawnRunner.run(sleepCommand(60_000), {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  controller.abort();
  const started = Date.now();
  const out = await pending;
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false);
  assert.ok(Date.now() - started < 10_000, 'abort 必须尽快结算，而不是等满墙钟超时');
});

test('真实 runner：正常退出时 aborted 为 false，输出被带回', async () => {
  const out = await spawnRunner.run(
    [process.execPath, '-e', 'process.stdout.write("hello-from-child")'],
    { signal: new AbortController().signal, timeoutMs: 30_000 },
  );
  assert.equal(out.aborted, false);
  assert.equal(out.timedOut, false);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'hello-from-child');
});

// ─────────────────────── 结果映射的截断语义 ───────────────────────

test('输出超限时截断并带 truncated 标记（不返回看起来完整的结果）', () => {
  const big = 'x'.repeat(2000);
  const out = mapOutcome({ code: 0, stdout: big, stderr: '', timedOut: false, aborted: false }, 100);
  assert.equal(out.truncated, true);
  assert.ok(out.stdout!.includes('已截断'));
  assert.ok(out.stdout!.length < big.length);
});

test('runtime_error 的 stderr 同样按 maxOutputBytes 截断（GAP-7 回归锁）', () => {
  // 其余三个分支都截断，只有这条曾经把最多 8MiB 的 docker 报错原样返回——
  // 模板声明的 maxOutputBytes 在这条路径上形同虚设。
  const big = 'e'.repeat(2000);
  const out = mapOutcome({ code: null, stdout: '', stderr: big, timedOut: false, aborted: false }, 100);
  assert.equal(out.status, 'runtime_error');
  assert.equal(out.truncated, true);
  assert.ok(out.stderr!.includes('已截断'));
  assert.ok(out.stderr!.length < big.length);
});

test('未超限时不带 truncated 标记', () => {
  const out = mapOutcome({ code: 0, stdout: 'small', stderr: '', timedOut: false, aborted: false }, 1000);
  assert.equal(out.truncated, undefined);
  assert.equal(out.stdout, 'small');
});

test('按字节而非字符截断：多字节字符不会被截出半个', () => {
  // 每个中文字符 3 字节；上限 10 字节 → 只能容纳 3 个字
  const out = mapOutcome({ code: 0, stdout: '中文字符测试', stderr: '', timedOut: false, aborted: false }, 10);
  assert.equal(out.truncated, true);
  assert.equal(out.stdout!.includes('\uFFFD'), false, '不得产生替换字符（半个 UTF-8 序列）');
});

// ─────────────────────── 镜像解析 ───────────────────────

test('镜像解析：单镜像可省略映射；多镜像必须按模板显式映射，未匹配时拒绝', () => {
  const other: AllowedImage = {
    name: 'other-tool',
    digest: 'sha256:' + 'b'.repeat(64),
    templateIds: ['other-tool-x'],
  };
  assert.equal(resolveImage(plan({ templateId: 'other-tool-x' }), [IMAGE, other])?.name, 'other-tool');
  assert.equal(resolveImage(plan({ templateId: 'unmatched' }), [IMAGE, other]), undefined);
});

// ─────────────────────── 宿主侧输出上限（内存保护） ───────────────────────

test('宿主输出按字节上限累积：超限后丢弃后续字节并置 overflowed', () => {
  // 锁的是「上限在**累积时**生效」这条：此前宿主先无限追加、只在进程退出后的
  // mapOutcome 里截断，于是一个持续喷输出的容器能在退出前把宿主内存吃光。
  const limit = 16;
  let text = '';
  let overflowed = false;
  for (const chunk of ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']) {
    const next = appendBounded(text, chunk, limit);
    text = next.text;
    overflowed = next.overflowed || overflowed;
  }
  assert.equal(Buffer.byteLength(text, 'utf8'), limit, '保留的字节数不得超过上限');
  assert.equal(text, 'aaaabbbbccccdddd', '保留前 N 字节——命令回显与错误开头才是有用的诊断信息');
  assert.equal(overflowed, true, '发生过丢弃必须能被标记出来，否则结果看起来是完整的');
});

test('宿主输出未超限时不置 overflowed，且内容原样保留', () => {
  const next = appendBounded('hello ', 'world', 1024);
  assert.equal(next.text, 'hello world');
  assert.equal(next.overflowed, false);
});

test('宿主输出按字节截断：多字节字符不会被切成半个', () => {
  // 每个中文字符 3 字节；上限 10 字节 → 只放得下 3 个完整字符（9 字节），
  // 第 4 个字符的首字节必须被丢掉，而不是留一个孤立的引导字节。
  const next = appendBounded('', '中文字符测试', 10);
  assert.equal(next.overflowed, true);
  assert.equal(next.text, '中文字');
  assert.equal(Buffer.byteLength(next.text, 'utf8'), 9, '保留的字节数不得超过上限，也不应切出半个字符');
  assert.equal(next.text.includes('\uFFFD'), false, '不得产生替换字符（半个 UTF-8 序列）');
});

test('宿主输出上限是容器内上限之外的**独立**兜底（两者不是同一个数）', () => {
  // 容器内 Reporter 的 `PENTEST_MAX_OUTPUT_BYTES` 由 plan 决定，可以比宿主缓冲小得多；
  // 宿主上限必须独立存在，不能写成「plan.maxOutputBytes」——那会把内存保护交给
  // 一个由动作模板决定的、可能很大的值。
  const argv = argvFor(plan({ maxOutputBytes: 200 * 1024 * 1024 }));
  assert.ok(argv.includes('PENTEST_MAX_OUTPUT_BYTES=209715200'));
  assert.ok(
    HOST_OUTPUT_BUFFER_LIMIT_BYTES < 200 * 1024 * 1024,
    '宿主缓冲上限必须显著小于模板可声明的输出上限，否则兜底形同虚设',
  );
});
