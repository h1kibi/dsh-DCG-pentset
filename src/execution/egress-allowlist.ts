/**
 * 出口白名单（`EGRESS_ALLOW`）与**已确认范围**的自动对齐。
 *
 * ── 为什么要有这个模块 ──
 *
 * 出口代理是唯一出网路径，白名单是它的唯一依据（见 RUNBOOK §6.5.3 第 1 条）。它此前是
 * **人工维护**的：人类得自己 `docker inspect` 看当前值、再 `docker rm -f` 重建容器。
 * 实机后果（2026-10-04）：作业范围是 `47.109.76.66:3002`，而白名单还停在旧实验室目标上，
 * 于是**每一次探针都被 403 拒绝**，Agent 把 403 读成「服务未识别」，人类则要自己去读 RUNBOOK。
 *
 * 白名单不该由人手抄：它是**已确认范围的一个投影**。范围由人类确认（那是唯一的授权动作），
 * 白名单是这个授权的机械落地。因此：确认/修订范围之后，插件从范围条目推导出主机集合，
 * 把当前白名单**并集**上它（只增不减——基础设施目标由人类设置的条目不许被我们悄悄删掉），
 * 必要时按原容器规格重建代理容器。
 *
 * ── 边界（不能放开的部分） ──
 *
 * - **不放开「任意目标」**：白名单仍然只含已确认范围里的主机；代理不会变成全放行。
 * - **不做端口级放行**：代理按**主机**比对，端口粒度由插件的范围闸门负责（§10.2），
 *   两者是不同层——把端口写进白名单既无意义也会误导人。
 * - **不改人设的其它条目**：只做并集，并在返回值里给出前后差异供审计。
 *
 * 依赖 `docker` 在 PATH 上；进程运行器由调用方注入（生产用真实 spawn，测试用假 runner）。
 */

import type { ProcessRunner } from './docker-sandbox.ts';
import { DOCKER_BIN } from './docker-sandbox.ts';

/** 白名单条目：主机名或 IP 字面量（代理按字符串比对）。 */
export type EgressHost = string;

export interface EgressScopeTarget {
  readonly kind: string;
  readonly value: string;
}

/**
 * 范围条目 → 出口白名单主机集合（纯函数）。
 *
 * - `url`：取 hostname（端口与路径不属于白名单语义）；
 * - `ip` / `domain`：原样（出口代理按**主机字符串**比对，域名还支持后缀匹配）；
 * - `cidr`：**跳过**——代理没有网段运算，写进去的 `a.b.c.0/24` 永远不会命中
 *   （`host == entry or host.endswith('.' + entry)`）。它们由
 *   {@link unrepresentableEgressEntries} 回报给调用方，由人类决定怎么处理；
 * - `asset-label`：不是地址，跳过（放行一个标签没有意义）。
 *
 * 排除项从结果里移除：范围里的排除是**优先**的（§8.6），白名单跟着它走。
 */
/** 主机名大小写不敏感：统一小写，避免「语义未变却触发一次容器重建」。 */
function normalizeHost(host: string): EgressHost {
  return host.toLowerCase();
}

export function egressHostsForScope(
  targets: readonly EgressScopeTarget[],
  exclusions: readonly EgressScopeTarget[] = [],
): readonly EgressHost[] {
  const hosts = new Set<EgressHost>();
  for (const target of targets) {
    const host = hostOf(target);
    if (host !== null) hosts.add(normalizeHost(host));
  }
  for (const target of exclusions) {
    const host = hostOf(target);
    if (host !== null) hosts.delete(normalizeHost(host));
  }
  return [...hosts].sort();
}

/**
 * 白名单**表达不了**的范围条目（网段）。
 *
 * 出口代理按**主机字符串**比对（`EGRESS_ALLOW` 是一串主机名/IP），没有网段运算——
 * 把 `192.0.2.0/24` 写进去只会得到一条永远不匹配的条目（看着像放行了，实际没有）。
 * 因此这里**显式跳过**并把它们回报给调用方，由调用方决定是提示人类还是拒绝确认；
 * 静默写一条死条目是最坏的选项。
 */
export function unrepresentableEgressEntries(targets: readonly EgressScopeTarget[]): readonly string[] {
  return targets
    .filter((target) => target.kind === 'cidr')
    .map((target) => target.value.trim())
    .filter((value) => value.length > 0);
}

function hostOf(target: EgressScopeTarget): EgressHost | null {
  const raw = target.value.trim();
  if (raw.length === 0) return null;
  if (target.kind === 'url') {
    try {
      return new URL(raw).hostname.length > 0 ? new URL(raw).hostname : null;
    } catch {
      return null;
    }
  }
  // 网段与标签都不是代理能比对的「主机」：跳过（网段由 `unrepresentableEgressEntries` 回报）。
  if (target.kind === 'asset-label' || target.kind === 'cidr') return null;
  return raw;
}

export interface EgressSyncDeps {
  readonly runner: ProcessRunner;
  /**
   * 出口代理容器名。
   *
   * ⚠️ 2026-10-04 后**沙箱不再经过它**（直连 `internalNetwork` 上的授权目标，见
   * `docker-sandbox.ts` 的边界说明）。这段同步逻辑保留给「经代理出网」的部署形态；
   * 在直连部署里它只维护代理自身的白名单，**不构成沙箱的出口边界**——那道边界现在是
   * 「`internalNetwork` 的成员集合」，所以**别把非授权目标接进那个网络**。
   */
  readonly proxyContainer: string;
  /** 代理必须同时连接的内网（`--internal` 网络；容器重建后要重新接上）。 */
  readonly internalNetwork: string;
  readonly dockerBin?: string;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface EgressAllowlistState {
  readonly hosts: readonly EgressHost[];
  /** 容器里那一行原始值（含人类设置的基础设施条目），审计用。 */
  readonly raw: string;
}

export type EgressSyncResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly before: readonly EgressHost[];
      readonly after: readonly EgressHost[];
      readonly detail: string;
    }
  | { readonly ok: false; readonly detail: string };

async function docker(deps: EgressSyncDeps, argv: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return deps.runner.run([deps.dockerBin ?? DOCKER_BIN, ...argv], {
    signal: new AbortController().signal,
    timeoutMs: deps.timeoutMs ?? 20_000,
  });
}

/** 读当前白名单。读不到（容器缺失/没设 EGRESS_ALLOW）返回 `null`——不猜。 */
export async function readEgressAllowlist(deps: EgressSyncDeps): Promise<EgressAllowlistState | null> {
  const inspected = await docker(deps, [
    'inspect',
    '--format',
    '{{range .Config.Env}}{{println .}}{{end}}',
    deps.proxyContainer,
  ]);
  if (inspected.code !== 0) return null;
  const line = inspected.stdout.split(/\r?\n/).find((entry) => entry.startsWith('EGRESS_ALLOW='));
  if (line === undefined) return null;
  const raw = line.slice('EGRESS_ALLOW='.length).trim();
  return { raw, hosts: splitHosts(raw) };
}

function splitHosts(raw: string): readonly EgressHost[] {
  return [...new Set(raw.split(',').map((entry) => normalizeHost(entry.trim())).filter((entry) => entry.length > 0))].sort();
}

/**
 * 把「范围变化后同步白名单」挂到两个范围入口上。
 *
 * ── 为什么是 Proxy，而不是 `{...inner, …}` ──
 *
 * 类实例的方法是**原型方法**，对象展开只复制**自有可枚举属性**：展开出来的是一个只剩两个
 * 包装方法的空壳，其余方法（`getState`/`listEngagements`/`pause`…）在运行时变成 `undefined`
 * 并整片报错。而 TS 对展开的类型是**乐观**的（按实例类型推），编译期看不出这种错位——
 * 2026-10-04 的代码自审正是在这里抓到一个 Critical。
 *
 * Proxy + `bind(target)`：未包装的属性落到原实例上执行（`this` 正确，私有字段 `#x` 才可访问），
 * 方法身份也被缓存住（每次访问都新绑一份会让 `svc.m === svc.m` 为假）。
 */
export function withEgressSync<T extends object>(
  inner: T,
  syncScope: (targets: readonly EgressScopeTarget[], exclusions: readonly EgressScopeTarget[]) => Promise<void>,
  methods: { readonly confirm: string; readonly amend: string } = {
    confirm: 'confirmScopeProposal',
    amend: 'amendScope',
  },
): T {
  const bound = new Map<PropertyKey, unknown>();
  const wrap = (name: string): ((input: { targets: readonly EgressScopeTarget[]; exclusions?: readonly EgressScopeTarget[] }) => Promise<unknown>) => {
    // **缺方法就抛**：`?.` 会让「方法名改了而这里没跟上」变成「白名单照同步、结果 undefined、
    // 控制台不报错」——本批改动刚在同类错位（`{...inner}`）上吃过一次亏，同一个盲点不留第二遍。
    const method = (inner as unknown as Record<string, ((value: unknown) => Promise<unknown>) | undefined>)[name];
    if (typeof method !== 'function') {
      throw new Error(`withEgressSync: ${name} 不存在（装配错位：扩展的方法名与实际实现不一致）`);
    }
    return async (input) => {
      const result = await method.call(inner, input);
      await syncScope(input.targets, input.exclusions ?? []);
      return result;
    };
  };
  const wrappedConfirm = wrap(methods.confirm);
  const wrappedAmend = wrap(methods.amend);
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === methods.confirm) return wrappedConfirm;
      if (property === methods.amend) return wrappedAmend;
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const cached = bound.get(property);
      if (cached !== undefined) return cached;
      const boundFn = value.bind(target) as unknown;
      bound.set(property, boundFn);
      return boundFn;
    },
  });
}

/**
 * 把 `required` 并入代理容器的白名单；必要时按**原容器规格**重建它。
 *
 * 「原规格」= 从 `docker inspect` 复制的镜像/命令/入口/其它环境变量/端口映射/绑定挂载/
 * 重启策略/网络，只把 `EGRESS_ALLOW` 换成新值。这样人类先前为部署做的任何定制都不会被
 * 这次重建抹掉——我们只改一个变量。
 *
 * 返回 `changed: false` 表示当前白名单已经覆盖 `required`（**不需要动容器**）。
 */
export async function syncEgressAllowlist(
  deps: EgressSyncDeps,
  required: readonly EgressHost[],
): Promise<EgressSyncResult> {
  const log = deps.log ?? ((): void => undefined);
  const requiredSet = new Set(required.map((host) => host.trim()).filter((host) => host.length > 0));
  if (requiredSet.size === 0) {
    // 空集**不重建**：把白名单缩成 0 条等于把代理关掉。但「范围里只有网段/标签」这种情形
    // 要说清——那不是「无需放行」，而是「这次的范围推导不出任何可放行的主机」。
    return {
      ok: false,
      detail:
        '范围推导不出任何可直接放行的主机（只含网段/资产标签？）——代理按主机字符串比对，' +
        '网段需要用「网段内的具体地址」逐条加入范围，或由人类显式维护白名单',
    };
  }

  const inspected = await docker(deps, ['inspect', deps.proxyContainer]);
  if (inspected.code !== 0) {
    return {
      ok: false,
      detail:
        `读不到代理容器 ${deps.proxyContainer}（docker inspect 退出码 ${String(inspected.code)}）：` +
        '先按 RUNBOOK §6.5.3 第 1 条把它建起来，之后本步骤即可自动同步',
    };
  }
  let spec: ProxySpec;
  try {
    spec = parseSpec(inspected.stdout);
  } catch (cause) {
    return { ok: false, detail: `解析代理容器规格失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const before = splitHosts(spec.allowRaw);
  const after = [...new Set([...before, ...requiredSet])].sort();
  if ([...requiredSet].every((host) => before.includes(host))) {
    return { ok: true, changed: false, before, after: before, detail: '白名单已覆盖本次范围，无需重建代理' };
  }

  // ── 换位而不是「先删后建」 ──
  //
  // `docker rm -f` + `docker run --name` 之间有一个**没有代理**的窗口；若 `run` 失败，
  // 旧代理已经没了（只剩手工恢复）。改用改名换位：把旧容器改名为 `<name>.rebuild-old`，
  // 用原名建新的；成功后删旧，失败则把旧容器改回来——任何一步失败都能回到原点。
  const retired = `${deps.proxyContainer}.rebuild-old`;
  await docker(deps, ['rm', '-f', retired]); // 上次失败可能留下的残留（best effort）
  const renamed = await docker(deps, ['rename', deps.proxyContainer, retired]);
  if (renamed.code !== 0) {
    return {
      ok: false,
      detail: `改名旧代理容器失败：${renamed.stderr.trim() || `退出码 ${String(renamed.code)}`}（容器未改动）`,
    };
  }
  if (spec.droppedOptions.length > 0) {
    // 不静默：这些设置重建后会回到镜像默认值，属于**安全边界被放宽**的候选，必须让人看见。
    log(
      `[egress] 注意：旧容器的这些设置不会被重建复制（重建后按镜像默认）：${spec.droppedOptions.join(', ')}。` +
        '需要保留请用 RUNBOOK §6.5.3 第 1 条的手工命令重建，并把它们写进命令。',
    );
  }
  const created = await docker(deps, ['run', '-d', ...spec.runArgs(deps.proxyContainer, after.join(','))]);
  if (created.code !== 0) {
    await docker(deps, ['rename', retired, deps.proxyContainer]); // 回滚：旧代理回到原名
    return {
      ok: false,
      detail:
        `重建代理容器失败：${created.stderr.trim() || `退出码 ${String(created.code)}`}。` +
        '已回滚到旧容器（白名单未变）',
    };
  }
  // 网络必须接回：原容器连过的每个网络（内网是硬要求，其余照原样）。
  // 排掉已作为 `--network` 传入的那个：docker 会以「endpoint already exists」拒绝重复 connect，
  // 那种拓扑下（容器没连 bridge，primary 恰是内网）每次同步都会失败并回滚。
  const reattach = [...new Set([...spec.otherNetworks, deps.internalNetwork])].filter(
    (network) => network !== spec.primaryNetwork,
  );
  for (const network of reattach) {
    const connected = await docker(deps, ['network', 'connect', network, deps.proxyContainer]);
    if (connected.code !== 0) {
      await docker(deps, ['rm', '-f', deps.proxyContainer]);
      await docker(deps, ['rename', retired, deps.proxyContainer]); // 回滚
      return {
        ok: false,
        detail:
          `代理容器已重建但接入 ${network} 失败：${connected.stderr.trim() || `退出码 ${String(connected.code)}`}。` +
          '已回滚到旧容器（白名单未变）',
      };
    }
  }
  const removed = await docker(deps, ['rm', '-f', retired]);
  if (removed.code !== 0) {
    // 新代理已经在跑，旧容器只是残留——如实说出来，不假装干净。
    log(`[egress] 旧代理容器 ${retired} 删除失败，请手工 docker rm -f ${retired}`);
  }
  log(`[egress] 白名单已同步：${before.join(',') || '（空）'} → ${after.join(',')}`);
  return { ok: true, changed: true, before, after, detail: `白名单已更新：${after.join(',')}` };
}

/** 从 `docker inspect` 的 JSON 里抽出重建所需的最小规格。 */
interface ProxySpec {
  readonly allowRaw: string;
  /**
   * 除 `--network` 选中的那个之外，原容器连过的其它网络（重建后要逐个 `network connect`）。
   * 出口代理必须同时连着 `bridge`（它自己的出网）与 `--internal` 内网（沙箱的会合点）。
   */
  readonly otherNetworks: readonly string[];
  /** 用 `--network` 传进去的那个网络名（`reattach` 时必须排掉它，否则会重复 connect 而失败）。 */
  readonly primaryNetwork: string | undefined;
  /**
   * 被设置过、但本模块**不会复制**到重建命令里的 HostConfig 项（资源限制、日志、健康检查…）。
   *
   * 不复制就无法保证「只改一个变量」：这些项会在重建后回到镜像默认值。调用方必须把它们
   * **报警**（而不是静默丢掉）——加固相关的常见项（cap/security-opt/read-only/user/tmpfs/dns/
   * add-host/device）已按原样复制，这里是剩下的。
   */
  readonly droppedOptions: readonly string[];
  /**
   * 重建参数：`docker run -d --name <name> <原样复制的选项…> -e EGRESS_ALLOW=<值> <镜像> <命令…>`。
   *
   * 选项必须在镜像名之前，因此这里把「镜像及其之后」单列一段，插入点在它之前。
   */
  runArgs(containerName: string, allowValue: string): readonly string[];
}

function parseSpec(rawJson: string): ProxySpec {
  const parsed: unknown = JSON.parse(rawJson);
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  if (first === undefined) throw new Error('inspect 输出不是容器数组');
  const config = asRecord(first['Config']);
  const host = asRecord(first['HostConfig']);
  const networks = asRecord(asRecord(first['NetworkSettings'])?.['Networks']) ?? {};
  const env = readStringArray(config?.['Env']);
  const allowLine = env.find((entry) => entry.startsWith('EGRESS_ALLOW='));
  if (allowLine === undefined) throw new Error('容器没有 EGRESS_ALLOW（拒绝在未知白名单上重建）');

  const image = typeof config?.['Image'] === 'string' ? config['Image'] : '';
  if (image.length === 0) throw new Error('容器没有镜像信息');
  const cmd = readStringArray(config?.['Cmd']);
  const entrypoint = readStringArray(config?.['Entrypoint']);

  const options: string[] = [];
  const hostConfig = host ?? {};
  const restart = asRecord(hostConfig['RestartPolicy'])?.['Name'];
  if (typeof restart === 'string' && restart !== '' && restart !== 'no') options.push('--restart', restart);
  for (const entry of env) {
    if (entry.startsWith('EGRESS_ALLOW=')) continue;
    options.push('-e', entry);
  }
  // 端口映射（`HostConfig.PortBindings`）：只复制显式的绑定。
  for (const [containerPort, rawBindings] of Object.entries(asRecord(host?.['PortBindings']) ?? {})) {
    if (!Array.isArray(rawBindings)) continue;
    for (const binding of rawBindings) {
      const record = asRecord(binding);
      const hostIp = typeof record?.['HostIp'] === 'string' && record['HostIp'].length > 0 ? record['HostIp'] : '127.0.0.1';
      const hostPort = typeof record?.['HostPort'] === 'string' ? record['HostPort'] : '';
      if (hostPort.length === 0) continue;
      options.push('-p', `${hostIp}:${hostPort}:${containerPort}`);
    }
  }
  // 绑定挂载（跳过命名卷：它们的来源不是路径，本模块不猜）。
  for (const raw of Array.isArray(first['Mounts']) ? (first['Mounts'] as readonly unknown[]) : []) {
    const mount = asRecord(raw);
    if (mount?.['Type'] !== 'bind') continue;
    const source = typeof mount['Source'] === 'string' ? mount['Source'] : '';
    const destination = typeof mount['Destination'] === 'string' ? mount['Destination'] : '';
    if (source.length === 0 || destination.length === 0) continue;
    options.push('-v', `${source}:${destination}${mount['RW'] === false ? ':ro' : ''}`);
  }
  // 首选 `bridge` 当 `--network`：出口代理必须**先**有真实出网能力，再被接进 `--internal`
  // 内网与沙箱会合（RUNBOOK §6.5.3 第 1 条的命令就是这个形状）。其余网络由调用方逐个
  // `network connect`。若容器没连 bridge（非本部署的拓扑），退到第一个网络。
  const networkNames = Object.keys(networks).filter((name) => name !== 'none');
  const primary = networkNames.includes('bridge') ? 'bridge' : networkNames[0];
  if (primary !== undefined) options.push('--network', primary);
  if (entrypoint.length > 0) options.push('--entrypoint', entrypoint[0] as string);

  const imageAndCmd = [image, ...entrypoint.slice(1), ...cmd];

  // ── 加固与资源设置：能复制的复制，复制不了的**如实报警** ──
  //
  // 只复制「7 类字段」时，人类给代理容器加的 `--cap-drop ALL` / `--security-opt no-new-privileges`
  // / `--read-only` 会被一次自动重建**悄悄抹掉**——那是安全边界被放宽，评审把它列为红线。
  copyStringArray(options, hostConfig, 'CapDrop', '--cap-drop');
  copyStringArray(options, hostConfig, 'CapAdd', '--cap-add');
  copyStringArray(options, hostConfig, 'SecurityOpt', '--security-opt');
  copyStringArray(options, hostConfig, 'Dns', '--dns');
  copyStringArray(options, hostConfig, 'ExtraHosts', '--add-host');
  copyStringArray(options, hostConfig, 'Devices', '--device');
  // `Tmpfs` 是 **map**（`{"/tmp": "rw,size=64m"}`），会连挂载选项一起复制。
  copyStringMap(options, hostConfig, 'Tmpfs', '--tmpfs');
  if (hostConfig['ReadonlyRootfs'] === true) options.push('--read-only');
  const user = hostConfig['User'];
  if (typeof user === 'string' && user.length > 0) options.push('--user', user);

  return {
    allowRaw: allowLine.slice('EGRESS_ALLOW='.length).trim(),
    otherNetworks: networkNames.filter((name) => name !== primary),
    primaryNetwork: primary,
    droppedOptions: listUncopiedHostOptions(hostConfig),
    runArgs: (containerName: string, allowValue: string) => [
      '--name',
      containerName,
      ...options,
      '-e',
      `EGRESS_ALLOW=${allowValue}`,
      ...imageAndCmd,
    ],
  };
}

/** 把 `HostConfig` 里的字符串数组项转成 docker 选项（空值跳过）。 */
function copyStringArray(options: string[], host: Record<string, unknown>, key: string, flag: string): void {
  const value = host[key];
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) options.push(flag, entry);
  }
}

/** 把 `HostConfig` 里的「路径 → 选项串」map 转成 docker 选项（空值跳过）。 */
function copyStringMap(options: string[], host: Record<string, unknown>, key: string, flag: string): void {
  const value = host[key];
  const record = asRecord(value);
  if (record === undefined) return;
  for (const [name, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry.length > 0) options.push(flag, `${name}:${entry}`);
  }
}

/** 未复制却在容器上设置过的 HostConfig 项（用于告警；顺序固定便于断言）。 */
const UNCOPIED_HOST_OPTIONS = [
  'PidsLimit',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'CpuShares',
  'CpuQuota',
  'Ulimits',
  'LogConfig',
  'Healthcheck',
  'Privileged',
  'IpcMode',
  'PidMode',
  'UsernsMode',
  'VolumesFrom',
  'GroupAdd',
  'ShmSize',
  'DevicesCgroupRules',
] as const;

function listUncopiedHostOptions(host: Record<string, unknown>): readonly string[] {
  return UNCOPIED_HOST_OPTIONS.filter((key) => {
    const value = host[key];
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return Object.keys(value as object).length > 0;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
