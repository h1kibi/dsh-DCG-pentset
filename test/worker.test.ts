/**
 * Worker 工具面的测试（设计文档 §10.1、§10.2、§10.2.1）。
 *
 * 本文件补上此前完全缺失的覆盖：既有测试从未调用过 `createWorkerTools`，因此
 * dsh schema DSL 的违规（`limit` 上的 `minimum`/`maximum`）一直没被拦住——它只在
 * `defineTool` 编译参数 schema 时抛 `JsonSchemaError`，也就是插件加载期的硬阻断。
 *
 * 锁定五条：
 *   1. `createWorkerTools` 在 `defineTool` 编译期**不抛**（A7 类缺陷的回归闸门）。
 *   2. 拿到的参数 schema 是**编译产物**（根 `type: 'object'` + `required` 数组），
 *      这证明第 1 条真的走过了编译路径，而不是空断言。
 *   3. 工具名集合与 `WORKER_TOOL_NAMES` 一致；`TARGET_TOOL_NAMES` 只含触及目标的三个
 *      （`pentest_exec` / `pentest_recon` / `pentest_scan`）。
 *   4. `paramsOf` **不过滤**：object / array / boolean / null 原样到达服务，由服务端
 *      `validateParams` 判定拒绝（§10.2.1 禁止「忽略未知字段」）。
 *   5. 便签在工具边界按 `DEFAULTS.statusNoteMaxChars` 截断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import {
  createWorkerTools,
  TARGET_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  type ArtifactRecord,
  type MemoryRecord,
  type MemorySearchResult,
  type WorkerToolDeps,
} from '../src/tools/worker.ts';
import { DEFAULTS, type ExecutionPlan, type ToolError } from '../src/contracts.ts';

// ───────────────────────────── 测试替身 ─────────────────────────────

type SearchInput = Parameters<WorkerToolDeps['search']>[0];
type ReadInput = Parameters<WorkerToolDeps['read']>[0];
type ArtifactInput = Parameters<WorkerToolDeps['readArtifact']>[0];
type SubmitReportInput = Parameters<WorkerToolDeps['submitReport']>[0];
type WriteNoteInput = Parameters<WorkerToolDeps['writeStatusNote']>[0];
type ApprovalInput = Parameters<WorkerToolDeps['requestApproval']>[0];
type ExecInput = Parameters<WorkerToolDeps['execute']>[0];

const SEARCH_RESULT: MemorySearchResult = {
  hits: [
    {
      memoryId: 'm-1',
      excerpt: '片段',
      score: 0.75,
      source: {
        eventId: 'ev-1',
        workerSessionId: 'ws-1',
        phase: 'recon',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
      trust: 'verified',
      citation: 'm-1',
    },
  ],
  indexWatermark: 42,
};

const RECORDS: readonly MemoryRecord[] = [
  {
    memoryId: 'm-1',
    content: '完整内容',
    contentHash: 'hash-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    originWorkerSessionId: 'ws-0',
    trust: 'verified',
    classification: 'fact',
    provisional: false,
    relatedEventIds: ['ev-1'],
  },
];

const ARTIFACT: ArtifactRecord = {
  artifactId: 'a-1',
  mediaType: 'text/plain',
  byteSize: 12,
  contentHash: 'hash-a',
  truncated: false,
  metadata: { source: 'probe' },
};

const PLAN: ExecutionPlan = {
  workerSessionId: 'ws-1',
  templateId: 'http_get',
  actionClass: 'passive_collection',
  normalizedTarget: 'example.com',
  resolvedAddresses: ['93.184.216.34'],
  normalizedCommand: "shell_exec target=10.0.0.5 port=3002 command_b64=aWQ=",
  planHash: 'plan-hash',
  idempotencyKey: 'idem-1',
  scopeVersion: 1,
  policyEpoch: 1,
  leaseGeneration: 1,
  approvalId: null,
  timeoutMs: 10_000,
  maxOutputBytes: 64 * 1024,
};

const EXEC_CONTROLLER = new AbortController();


interface FakeDeps {
  readonly deps: WorkerToolDeps;
  readonly searchCalls: SearchInput[];
  readonly readCalls: ReadInput[];
  readonly readArtifactCalls: ArtifactInput[];
  readonly submitReportCalls: SubmitReportInput[];
  readonly writeStatusNoteCalls: WriteNoteInput[];
  readonly requestApprovalCalls: ApprovalInput[];
  readonly executeCalls: ExecInput[];
  /** 解析器收到的 dsh 会话标识；用来证明身份确实过了这一层。 */
  readonly resolveCalls: string[];
  /** 交接草稿请求的目标阶段（省略时不应出现该键）。 */
}

/** 记录型假服务：每个端口都返回可断言的固定值，并留下调用痕迹。 */
function makeDeps(): FakeDeps {
  const searchCalls: SearchInput[] = [];
  const readCalls: ReadInput[] = [];
  const readArtifactCalls: ArtifactInput[] = [];
  const submitReportCalls: SubmitReportInput[] = [];
  const writeStatusNoteCalls: WriteNoteInput[] = [];
  const requestApprovalCalls: ApprovalInput[] = [];
  const executeCalls: ExecInput[] = [];
  const resolveCalls: string[] = [];

  const deps: WorkerToolDeps = {
    // 本文件不测 skill 装载（那是 pg-worker-tools 的职责）：给一个空实现满足形状。
    async loadSkill() {
      return { skill: null, loadedNames: [] };
    },
    async bootstrapIntake(input) {
      return {
        engagementId: 'e1',
        workerSessionId: 'w1',
        dshSessionId: input.dshSessionId,
        leaseId: 'l1',
        leaseGeneration: 1,
        scopeVersion: 0,
        resumed: false,
        nextStep: '测试',
      };
    },
    async resolveWorkerSessionId(dshSessionId) {
      resolveCalls.push(dshSessionId);
      // 真实实现按 `dsh_session_id` 查库；这里按同一派生约定回代。
      return dshSessionId.startsWith('dsh-') ? dshSessionId.slice(4) : null;
    },
    async resolveWorkerSessionContext(dshSessionId) {
      const workerSessionId = dshSessionId.startsWith('dsh-') ? dshSessionId.slice(4) : null;
      return workerSessionId === null ? null : { workerSessionId, leaseGeneration: 1 };
    },
    async search(input) {
      searchCalls.push(input);
      return SEARCH_RESULT;
    },
    async read(input) {
      readCalls.push(input);
      return RECORDS;
    },
    async readArtifact(input) {
      readArtifactCalls.push(input);
      return ARTIFACT;
    },
    async submitReport(input) {
      submitReportCalls.push(input);
      // 这个假端口不落 findings（真实端口在提交事务里写 `pentest.findings`）。
      return { reportId: 'report-1', stateVersion: 3, findings: { written: 0, skipped: 0 } };
    },
    async writeStatusNote(input) {
      writeStatusNoteCalls.push(input);
      return { stored: true, source: 'agent' };
    },
    async requestScopeConfirmation() {
      return {
        id: 'proposal-1',
        engagementId: 'engagement-1',
        workerSessionId: 'worker-1',
        objective: 'scope intake',
        targets: [],
        exclusions: [],
        allowedActions: [],
        authorizationNote: 'authorized lab',
        status: 'pending' as const,
        createdAt: '2026-01-01T00:00:00Z',
        decidedAt: null,
      };
    },
    async requestApproval(input) {
      requestApprovalCalls.push(input);
      return { approvalId: 'ap-1', planHash: 'plan-hash', expiresAt: '2026-01-01T00:10:00.000Z' };
    },
    async execute(input) {
      executeCalls.push(input);
      return { kind: 'executed' as const, plan: PLAN, result: { ok: true } };
    },
  };

  return {
    deps,
    searchCalls,
    readCalls,
    readArtifactCalls,
    submitReportCalls,
    writeStatusNoteCalls,
    requestApprovalCalls,
    executeCalls,
    resolveCalls,
  };
}

/**
 * 执行身份。
 *
 * **必须是真实的 dsh 会话标识形状**（`dsh-<workerSessionId>`）。这里曾经写成裸的
 * `ws-1`——即「dsh 会话标识恰好等于 worker 会话标识」，而那正是宿主**不会**给的形状：
 * 实测中 `exec.agent.sessionId` 是 `dsh-<uuid>`，服务层却按 `worker_sessions.id`
 * （裸 uuid）查库，于是每个工具都以 `invalid input syntax for type uuid` 失败。
 * 夹具不真实，缺陷就测不出来。下面的解析器回代出 `ws-1`，断言因此同时验证：
 * 工具层拿到的是 dsh 身份，交给服务层的是 worker 身份。
 */
const EXEC = { agent: { sessionId: 'dsh-ws-1' }, signal: EXEC_CONTROLLER.signal } as unknown as ToolRunContext;

/** 取出唯一一次调用；多次调用会让断言失去意义，因此在这里直接失败。 */
function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1, `期望恰好一次调用，实际 ${items.length} 次`);
  return items[0]!;
}

/** 从工具返回值中断言取回一台 blocked 的 ToolError 载荷（§16.5：不抛异常）。 */
function assertBlocked(value: unknown, expectedCode: ToolError['code']): ToolError {
  const err = value as ToolError;
  assert.equal(err.status, 'blocked');
  assert.equal(err.code, expectedCode);
  assert.ok(err.message.length > 0, '错误载荷必须带可读原因');
  assert.ok(err.next_action.length > 0, '错误载荷必须带下一步动作');
  return err;
}

// ───────────────────────────── schema 编译 ─────────────────────────────

test('createWorkerTools 在 defineTool 编译期不抛异常（schema DSL 违规会硬阻断插件加载）', () => {
  // 这是本文件最关键的断言：defineTool 在调用时就编译参数 schema，任何
  // dsh DSL 不支持的键都会在这里抛 JsonSchemaError。
  assert.doesNotThrow(() => {
    createWorkerTools(makeDeps().deps);
  }, 'createWorkerTools 必须在加载期可构造');

  const tools = createWorkerTools(makeDeps().deps);
  const names = Object.values(tools).map((def) => def.name);
  // 数量从 `WORKER_TOOL_NAMES` 派生，而不是写死一个字面量：写死会在每次增删工具时
  // 变成第二份真相（本次加 `pentest_bootstrap_intake` 就撞上了）。这里真正要断言的是
  // **构造物的名字集合与权威清单完全一致**，下一条 `deepEqual` 已经把它表达完整。
  assert.equal(
    names.length,
    WORKER_TOOL_NAMES.length,
    `Worker 工具面数量必须与 WORKER_TOOL_NAMES 一致（当前 ${String(WORKER_TOOL_NAMES.length)} 个）`,
  );
  assert.deepEqual(names, [...WORKER_TOOL_NAMES], '工具名必须与 WORKER_TOOL_NAMES 一致（顺序即登记顺序）');
});

test('intake 范围提案工具不属于目标执行工具', () => {
  assert.equal(WORKER_TOOL_NAMES.includes('pentest_request_scope_confirmation'), true);
  assert.equal((TARGET_TOOL_NAMES as readonly string[]).includes('pentest_request_scope_confirmation'), false);
  assert.deepEqual([...TARGET_TOOL_NAMES], ['pentest_exec', 'pentest_recon', 'pentest_scan']);
});

test('参数 schema 是 defineTool 的编译产物——「不抛」这条断言确实走过了编译路径', () => {
  const tools = createWorkerTools(makeDeps().deps);
  const defs = Object.values(tools) as unknown as {
    readonly name: string;
    readonly parameters: {
      readonly type?: unknown;
      readonly required?: readonly string[];
      readonly properties: Record<string, Record<string, unknown>>;
    };
  }[];

  // DSL 里没有根 `type: 'object'`，也没有 `required` 数组：两者都是编译期产物，
  // 因此它们出现即证明 parameterSchemaSpecToJsonSchema 已经跑过。
  for (const def of defs) {
    assert.equal(def.parameters.type, 'object', `${def.name} 的参数 schema 必须是对象根`);
    assert.equal(typeof def.parameters.properties, 'object', `${def.name} 必须编译出 properties`);
  }

  const search = defs.find((def) => def.name === 'memory_search');
  assert.ok(search, '必须存在 memory_search');
  assert.deepEqual(search.parameters.required, ['query'], 'DSL 的 required: true 必须编译成 required 数组');

  // 曾经的违规点：limit 上的 minimum/maximum 会让 defineTool 抛 JsonSchemaError。
  const limit = search.parameters.properties['limit'];
  assert.ok(limit, 'limit 必须仍在参数面里（约束不得被静默删除）');
  assert.equal(limit['type'], 'integer');
  assert.equal(Object.hasOwn(limit, 'minimum'), false, 'dsh DSL 不支持 minimum');
  assert.equal(Object.hasOwn(limit, 'maximum'), false, 'dsh DSL 不支持 maximum');
  const limitText = String(limit['description']);
  assert.match(limitText, /默认 8/, '默认值必须写进 description');
  assert.match(limitText, /1/, '取值范围的下界必须写进 description');
  assert.match(limitText, /50/, '取值范围的上界必须写进 description');
});
test('范围提案 schema 要求完整 ScopeTarget，不接受旧的 value/port/protocol 形态', () => {
  const tools = createWorkerTools(makeDeps().deps);
  const definition = tools.requestScopeConfirmation as unknown as {
    readonly parameters: Parameters<typeof validateJsonSchemaValue>[0];
  };
  const schema = definition.parameters;
  const valid = {
    objective: '确认实验室服务范围',
    targets: [{ kind: 'ip', value: '192.0.2.1', protocols: ['tcp'], ports: [{ from: 3002, to: 3002 }] }],
    exclusions: [],
    allowed_actions: ['passive_collection'],
  };
  assert.deepEqual(validateJsonSchemaValue(schema, valid), []);
  assert.ok(
    validateJsonSchemaValue(schema, {
      ...valid,
      targets: [{ value: '192.0.2.1', port: 3002, protocol: 'tcp' }],
    }).some((violation) => violation.includes('targets[0].kind')),
  );
});

test('pentest_prepare_handoff：**不向会话索要草稿**，只告诉人类去哪儿点', async () => {
  // 人类报障（2026-10-05）：Agent 在会话里自己发起交接草稿，然后**卡死**——那次请求要往
  // **同一个会话**续跑一个新回合并等它空闲，而它正卡在这一回合里等工具返回：自己等自己。
  // 按 §6.3，草稿是人类的写操作（人类在控制台点「进入下一阶段」），Agent 既不该也不能发起。
  const { deps } = makeDeps();
  const tools = createWorkerTools(deps);
  const result = (await tools.prepareHandoff.execute({}, EXEC)) as {
    readonly status?: string;
    readonly code?: string;
    readonly message?: string;
    readonly next_action?: string;
  };
  assert.equal(result.status, 'blocked', '必须如实告诉 Agent：这件事不由它做');
  assert.equal(result.code, 'classification_rejected');
  assert.match(result.message ?? '', /人类/, '要说清该谁去做');
  assert.match(result.message ?? '', /进入下一阶段/, '要给出人类该点的那个入口');
  assert.match(result.next_action ?? '', /转告/, '要给出下一步：转告人类后结束本回合，别再调用');
});

test('全部 Worker 工具的参数 schema 都不含 dsh DSL 不支持的校验关键字', () => {
  // 这组键会在 defineTool 编译期抛 JsonSchemaError（实测自 dsh 0.1.5-rc.2）。
  const unsupported = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minProperties',
    'maxProperties',
  ];

  const tools = createWorkerTools(makeDeps().deps);
  const defs = Object.values(tools) as unknown as {
    readonly name: string;
    readonly parameters: { readonly properties: Record<string, Record<string, unknown>> };
  }[];

  for (const def of defs) {
    for (const [param, node] of Object.entries(def.parameters.properties)) {
      for (const key of unsupported) {
        assert.equal(
          Object.hasOwn(node, key),
          false,
          `${def.name}.${param} 使用了 dsh DSL 不支持的键 ${key}`,
        );
      }
    }
  }
});

test('TARGET_TOOL_NAMES 含三条目标通路（人批的 pentest_exec + 结构化侦察/核验），且是 WORKER_TOOL_NAMES 的真子集', () => {
  assert.deepEqual([...TARGET_TOOL_NAMES], ['pentest_exec', 'pentest_recon', 'pentest_scan']);
  const workerNames: readonly string[] = WORKER_TOOL_NAMES;
  for (const name of TARGET_TOOL_NAMES) {
    assert.ok(workerNames.includes(name), `目标类工具 ${name} 必须在 Worker 工具面内`);
  }
  assert.ok(
    TARGET_TOOL_NAMES.length < workerNames.length,
    '必须存在 non-target 工具，否则守卫的「只有它触及目标」判定没有意义',
  );
});

// ───────────────────────────── 执行路径 ─────────────────────────────

test('artifact_read：合法参数到达服务并原样返回证据记录', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  const record = await tools.artifactRead.execute({ artifact_id: 'a-1' }, EXEC);
  assert.deepEqual(record, ARTIFACT);
  assert.deepEqual(only(fake.readArtifactCalls), { workerSessionId: 'ws-1', artifactId: 'a-1' });
});

test('缺少执行身份时拒绝执行（不猜会话，§4.2）', async () => {
  const tools = createWorkerTools(makeDeps().deps);
  // 会话标识只从执行身份推导；拿不到就必须失败，而不是退化成一个可被模型影响的默认值。
  await assert.rejects(
    tools.memorySearch.execute({ query: 'x' }, {} as ToolRunContext),
    /without an agent identity/,
  );
});

test('会话标识必须经解析：工具层收到 dsh 身份，服务层收到 worker 身份', async () => {
  // 回归锁。曾经工具层把 `exec.agent.sessionId`（`dsh-<uuid>`）直接当作
  // `workerSessionId` 传给服务层，而后者按 `worker_sessions.id`（裸 uuid）查库——
  // 于是**每一个** worker 工具都以 `invalid input syntax for type uuid` 失败。
  // 单测当时测不出来，因为夹具把 dsh 身份写成了裸 id。
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  await tools.memorySearch.execute({ query: '任意' }, EXEC);

  assert.deepEqual(fake.resolveCalls, ['dsh-ws-1'], '解析器必须收到 dsh 会话标识');
  assert.equal(
    only(fake.searchCalls).workerSessionId,
    'ws-1',
    '服务方法必须收到 worker 会话标识；收到 dsh- 前缀的值就是那个致命错配',
  );
});

test('会话未登记时拒绝执行（不退回用 dsh 标识当 worker 标识）', async () => {
  const base = makeDeps();
  const tools = createWorkerTools({
    ...base.deps,
    async resolveWorkerSessionId() {
      return null;
    },
  });

  const error = await tools.memorySearch.execute({ query: 'x' }, EXEC).then(
    () => null,
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );
  assert.ok(error !== null, '解析不出身份就必须失败——用 dsh 标识硬试只会得到一个 uuid 语法错误');
  assert.match(error, /不是渗透控制台创建的/);
  // 这条错误是**唯一**会出现在「会话不是控制台创建的」情形里的信号，而模型会把它原样
  // 转述给人类。所以它必须自己讲清三件事：为什么绑定不了、去哪儿开始、别猜范围。
  // 否则人和模型都会去尝试一件做不到的事（给这个会话补一个绑定）。
  assert.match(error, /无法\*\*事后补上/, '要说清「补不了」，否则会有人去试');
  assert.match(error, /渗透作业/, '要给出可执行的去处（控制台入口）');
  assert.match(error, /不要重试/, '要明确禁止用猜测填补空白');
});

test('memory_search：合法参数到达服务并返回其结果；limit 缺省补 8', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  const result = await tools.memorySearch.execute({ query: '目标开放端口', limit: 3 }, EXEC);
  assert.deepEqual(result, SEARCH_RESULT, '工具必须原样转发服务结果');

  const call = only(fake.searchCalls);
  assert.equal(call.workerSessionId, 'ws-1', '会话标识必须来自执行身份，而不是模型参数');
  assert.equal(call.query, '目标开放端口');
  assert.equal(call.limit, 3);

  await tools.memorySearch.execute({ query: '再来一次' }, EXEC);
  assert.equal(fake.searchCalls.length, 2);
  assert.equal(fake.searchCalls[1]!.limit, 8, '未传 limit 时补默认 8');
});

test('memory_read：合法参数返回服务结果；refs 超 20 条返回 blocked ToolError 而非抛异常', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  const records = await tools.memoryRead.execute({ refs: ['memory:m-1'] }, EXEC);
  assert.deepEqual(records, RECORDS);
  assert.deepEqual(only(fake.readCalls).refs, ['memory:m-1']);

  const refs = Array.from({ length: 21 }, (_, i) => `memory:m-${i}`);
  const blocked = assertBlocked(await tools.memoryRead.execute({ refs }, EXEC), 'classification_rejected');
  assert.match(blocked.message, /20/, '拒绝原因必须点名上限');
  assert.equal(fake.readCalls.length, 1, '越界调用必须在工具层被拦下，不触达服务');
});

test('pentest_exec：命令与端口原样转发（命令编码为 base64，端口必须是数字）', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  // 工具层只做形状转换：命令原文 → base64（宿主侧命令是单个按空格切分的 argv 字符串），
  // 端口保持数字（字符串形式会被参数校验拒掉——这一条实测踩过，所有必填 port 的模板都不可用）。
  const command = 'nmap -sS -Pn -p 3002 10.0.0.5';

  const execResult = await tools.pentestExec.execute(
    {
      command,
      port: 3002,
      target_selector: 'http://10.0.0.5/',
      purpose: '确认 3002 端口状态',
      approval_id: 'ap-1',
    },
    EXEC,
  );
  assert.deepEqual(execResult, { plan: PLAN, result: { ok: true } });

  const intent = only(fake.executeCalls).intent;
  assert.deepEqual(intent.params, {
    port: 3002,
    command_b64: Buffer.from(command, 'utf8').toString('base64'),
  }, '参数必须是直连命令模板声明的那两个');
  assert.equal(typeof (intent.params as Record<string, unknown>)['port'], 'number', '端口必须是数字');
  assert.equal(intent.approvalId, 'ap-1');
  assert.equal(intent.workerSessionId, 'ws-1');
  assert.equal(intent.templateId, 'direct_command');
  assert.equal(intent.targetSelector, 'http://10.0.0.5/');

  // 无 approval_id 时不得凭空写入该键（服务据「是否有放行」分流）。
  await tools.pentestExec.execute(
    { command: 'id', port: 80, target_selector: 'http://example.com/', purpose: '再次确认' },
    EXEC,
  );
  const second = fake.executeCalls[1]!.intent;
  assert.equal(Object.hasOwn(second, 'approvalId'), false, '未传 approval_id 时不得伪造该字段');
  assert.deepEqual(second.params, { port: 80, command_b64: Buffer.from('id', 'utf8').toString('base64') });

  // 放行申请与执行必须用**同一套参数**：人类批的是那条命令，执行时也必须是它。
  await tools.requestApproval.execute(
    { command: 'id', port: 80, target_selector: 'http://example.com/', purpose: '申请放行' },
    EXEC,
  );
  const approvalIntent = only(fake.requestApprovalCalls).intent;
  assert.equal(approvalIntent.templateId, 'direct_command');
  assert.deepEqual(approvalIntent.params, second.params, '放行申请与执行的 params 必须一致');
});
test('pentest_exec：宿主取消信号原样传给执行依赖', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);

  await tools.pentestExec.execute(
    {
      command: 'id',
      port: 80,
      target_selector: 'http://example.com/',
      purpose: '验证取消传播',
    },
    EXEC,
  );

  assert.equal(only(fake.executeCalls).signal, EXEC_CONTROLLER.signal);
});

test('status_note 超长时截断到 DEFAULTS.statusNoteMaxChars，缺省时不写入该键', async () => {
  const fake = makeDeps();
  const tools = createWorkerTools(fake.deps);
  const limit = DEFAULTS.statusNoteMaxChars;

  const longNote = 'x'.repeat(limit * 3);
  await tools.submitReport.execute(
    { status: 'report_ready', objective: '枚举端口', summary: '完成', status_note: longNote },
    EXEC,
  );
  const report = only(fake.submitReportCalls).report;
  assert.equal(report.statusNote?.length, limit, `便签必须截断到 ${limit} 字符`);
  assert.equal(report.statusNote, longNote.slice(0, limit), '截断必须保留前缀');
  assert.equal(report.status, 'report_ready');
  assert.equal(report.objective, '枚举端口');
  assert.deepEqual(report.payload, {}, '未传 payload 时给空对象，而不是 undefined');

  await tools.submitReport.execute({ status: 'blocked', objective: '枚举端口', summary: '阻塞' }, EXEC);
  const blockedReport = fake.submitReportCalls[1]!.report;
  assert.equal(Object.hasOwn(blockedReport, 'statusNote'), false, '未产出便签时不得写入该键');

  // 独立便签工具同受同一个上限约束。
  await tools.writeStatusNote.execute({ note: longNote }, EXEC);
  const wrote = only(fake.writeStatusNoteCalls);
  assert.equal(wrote.note.length, limit);
  assert.equal(wrote.workerSessionId, 'ws-1');
});

// ───────────────────────── 报告载荷 schema 与设计 §7.1 的对齐 ─────────────────────────

/**
 * 回归锁：`pentest_submit_report.payload` 是**闭合** schema（`additionalProperties:false`），
 * 因此「设计 §7.1 里出现、schema 里没列」的字段会让一份**完全合规**的报告被整份拒绝。
 *
 * 2026-10-04 的代码自审抓到过这个形状：当时 `payload` 只列了分段字段
 * （facts/hypotheses/candidate_findings/…），而设计示例里还有
 * `schema_version`/`status`/`objective`/`summary`/`completed`/`status_note`/`finished_at`——
 * 模型按设计示例照抄就会撞校验错误。
 *
 * 反向也要钉住：拼错的字段名（`fact` 而不是 `facts`）必须继续被拒——放宽成
 * `additionalProperties:true` 会让「形状错了」重新变成静默丢弃（那正是本轮的修复对象）。
 */
test('报告载荷 schema 接受设计 §7.1 的完整示例，同时拒绝拼错的字段名', async () => {
  const tools = createWorkerTools(makeDeps().deps);
  const definition = tools.submitReport as unknown as {
    readonly parameters: Parameters<typeof validateJsonSchemaValue>[0];
  };
  const schema = definition.parameters;

  // **从设计文档解析示例，不手抄**：手抄一份「设计示例」是这套代码库点名的失败模式——
  // 抄漏字段的测试会给出假绿。本用例的第一版就抄漏了
  // `engagement_id`/`agent_session_id`/`phase`（评审抓到），于是「对齐设计」的锁形同虚设。
  const doc = await readFile(new URL('../docs/dsh-pentest-plugin-design.md', import.meta.url), 'utf8');
  const block = /### 7\.1 Worker 任务报告[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(block !== null, '设计文档里必须还有 §7.1 的 JSON 示例（解析不到说明文档结构变了，先改这条测试）');
  const designReport = JSON.parse(block[1] as string) as Record<string, unknown>;

  const payloadSchema = schema.properties!['payload'] as unknown as {
    readonly additionalProperties?: unknown;
    readonly properties: Record<string, unknown>;
  };
  const declared = Object.keys(payloadSchema.properties);
  const missing = Object.keys(designReport).filter((key) => !declared.includes(key));
  assert.deepEqual(
    missing,
    [],
    `设计 §7.1 的字段必须都出现在 payload 属性里（additionalProperties:false 下漏一个就整份拒绝）：缺 ${missing.join('、')}`,
  );

  const perDesign = {
    status: designReport['status'],
    objective: designReport['objective'],
    summary: designReport['summary'],
    status_note: designReport['status_note'],
    payload: { ...designReport },
  };

  assert.deepEqual(
    validateJsonSchemaValue(schema, perDesign),
    [],
    '设计 §7.1 的报告必须能通过校验——否则模型照抄设计示例会被整份拒绝',
  );

  const unknownField = validateJsonSchemaValue(schema, {
    ...perDesign,
    payload: { ...perDesign.payload, fact: [] },
  });
  assert.ok(unknownField.length > 0, '未知字段必须被拒（additionalProperties:false 的意义）');

  const badItem = validateJsonSchemaValue(schema, {
    ...perDesign,
    payload: { facts: [{ fact: '把事实写在错字段名上' }] },
  });
  assert.ok(badItem.length > 0, 'facts 条目缺 statement 必须被拒（否则漂移又变成静默丢弃）');
});
