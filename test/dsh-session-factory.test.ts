/**
 * 真实 DSH 会话工厂的测试（设计文档 §4.3、§5.3、§7.2、§7.4、§15.6）。
 *
 * 全部用**注入的假宿主面**：本文件不加载 dsh 运行时，也不需要真模型。
 * 假宿主只实现工厂真正调用的那些成员（`ctx.get('agents')`、
 * `agentCtx.tools.restrict`、`agentCtx.systemPrompt.section`、`agent.*`、
 * `session.seq/eventAt`），因此这些用例同时是**缝的形状契约**：
 * 宿主换版本、少了任何一个缝，第一条用例就会红。
 *
 * 锁定五件事：
 *   1. 创建的是**顶层**会话（`parentAgent` 字段根本不出现）且 sessionId 原样用工作流派生的标识；
 *   2. 工具面在 `setup` 里被 `restrict` 收窄为输入的那一份（只能收窄，没有放宽入口）；
 *   3. 冻结能力与任务简报真的进了提示词分节（模型看得见自己的边界）；
 *   4. 关闭后任何投递都失败；被宿主摘掉的会话也失败（不静默成功）；
 *      非法阶段 → null；非法动作类别 → 拒绝。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from '@deepseek-ai/cordis';
import { SessionSeq } from '@deepseek-ai/dsh-session';

import type { FrozenSessionInput } from '../src/workflow/session-port.ts';
import { HUMAN_QUESTION_TOOL } from '../src/contracts.ts';
import { SessionFactoryError } from '../src/workflow/session-port.ts';
import {
  DshSessionFactory,
} from '../src/agents/dsh-session-factory.ts';

// ───────────────────────────── 假宿主 ─────────────────────────────

interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** `agents.create` 的入参视图：假宿主只读这几项（索引签名保留未知字段，以便断言 parentAgent 缺席）。 */
interface CreateCallOption {
  readonly sessionId?: unknown;
  readonly meta?: unknown;
  readonly agentOptions?: unknown;
  readonly setup?: (agentCtx: unknown) => void | Promise<void>;
  readonly [key: string]: unknown;
}

/** 投递值的结构视图：本文件只断言 dsh 的 user 消息里这三项。 */
interface UserMessageShape {
  readonly id: unknown;
  readonly role: unknown;
  readonly source: unknown;
}

/** 取消息文本；不是 `[{type:'text',text}]` 形状则 undefined（`in` 窄化，不做类型断言）。 */
function textOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('content' in message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const block: unknown = content[0];
  if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) {
    return undefined;
  }
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

/** 把投递值窄化成 user 消息视图；缺任一字段即 undefined。 */
function asUserMessage(value: unknown): UserMessageShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('id' in value) || !('role' in value) || !('source' in value)) return undefined;
  return { id: value.id, role: value.role, source: value.source };
}

/** 假会话：只实现工厂读的两个成员。 */
class FakeSession {
  readonly id: string;
  readonly events: unknown[] = [];

  constructor(id: string) {
    this.id = id;
  }

  get seq(): number {
    return this.events.length;
  }

  eventAt(seq: SessionSeq): unknown {
    return this.events[Number(seq)];
  }

  /** 模拟模型的 assistant 回复（落在新增事件区间的末尾）。 */
  appendAssistant(text: string): void {
    this.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  }
}

class FakeAgent {
  readonly session: FakeSession;
  status: 'idle' | 'running' = 'idle';
  readonly calls: RecordedCall[] = [];
  /** 收到投递时如何「回复」；返回 undefined 表示这个回合不产生 assistant 文本。 */
  reply: ((text: string) => string | undefined) | undefined;

  constructor(id: string) {
    this.session = new FakeSession(id);
  }

  followup(message: unknown): void {
    this.calls.push({ name: 'followup', args: [message] });
    this.#simulateReply(message);
  }

  steer(message: unknown): void {
    this.calls.push({ name: 'steer', args: [message] });
    this.#simulateReply(message);
  }

  cancel(cause: unknown, options: unknown): void {
    this.calls.push({ name: 'cancel', args: [cause, options] });
  }

  whenIdle(): Promise<void> {
    this.calls.push({ name: 'whenIdle', args: [] });
    return this.idleGate ?? Promise.resolve();
  }

  /** 悬挂的 whenIdle（用于超时用例）。 */
  idleGate: Promise<void> | undefined;

  #simulateReply(message: unknown): void {
    if (this.reply === undefined) return;
    const text = textOf(message);
    const answer = text === undefined ? undefined : this.reply(text);
    if (answer !== undefined) this.session.appendAssistant(answer);
  }
}

interface FakeHost {
  readonly ctx: Context;
  readonly agent: FakeAgent;
  /** `agents.create` 收到的原始 options。 */
  readonly createOptions: CreateCallOption[];
  /** `setup` 里被调用的 `restrict` 入参。 */
  readonly restrictions: unknown[];
  /** `setup` 里被注册的提示词分节。 */
  readonly sections: { name: string; order: number; text: string }[];
  readonly disposed: { count: number };
  /** 模拟宿主侧的注销（`agents.get` 返回 undefined），用于「被取代」用例。 */
  detach(): void;
  /** `setup` 收到的那个 agentCtx；用来断言挂载发生在正确的会话作用域上。 */
  readonly agentCtxForSetup: unknown;
}

function makeHost(
  options: {
    /** 省略时提供一个完整的 agentCtx（含 tools / systemPrompt）。 */
    readonly agentCtx?: unknown;
    readonly agent?: FakeAgent;
    /** 假会话的身份；省略即用 INPUT 派生出来的那个（正常路径）。 */
    readonly sessionId?: string;
  } = {},
): FakeHost {
  const agent = options.agent ?? new FakeAgent(options.sessionId ?? INPUT.dshSessionId);
  const createOptions: CreateCallOption[] = [];
  const restrictions: unknown[] = [];
  const sections: { name: string; order: number; text: string }[] = [];
  const disposed = { count: 0 };
  let attached = true;

  const agentCtx =
    options.agentCtx === undefined
      ? {
          tools: {
            restrict(filter: unknown): () => void {
              restrictions.push(filter);
              return () => undefined;
            },
          },
          systemPrompt: {
            section(section: { name: string; order: number; text: string }): () => void {
              sections.push(section);
              return () => undefined;
            },
          },
        }
      : options.agentCtx;

  const agents = {
    create: async (createOption: CreateCallOption) => {
      createOptions.push(createOption);
      // setup 现在是 async（挂预设要 await mount），宿主会 await 它——这里同样 await，
      // 否则「挂载失败 → 创建回滚」这条路径测不出来。
      await createOption.setup?.(agentCtx);
      return {
        agent,
        dispose: async () => {
          disposed.count += 1;
          attached = false;
        },
      };
    },
    get: (id: string) => (attached && id === agent.session.id ? agent : undefined),
  };

  // 假宿主只需实现工厂真正用到的 `ctx.get`；cordis 的 Context 是运行时代理，
  // 其形状无法在类型上被一个字面量构造出来，因此这里做一次具名断言并说明理由。
  const fakeContext = {
    get: (name: string) => (name === 'agents' ? agents : undefined),
    // 刻意**不**在假 ctx 上放 `agentPresets`：工厂不该去读那个服务——cordis 对未在自己
    // `inject` 里声明的服务，属性读取会抛（实测把整个 boot 拖挂过）。挂载能力由装配层
    // 以**函数**注入，工厂只依赖那个函数。
  };
  const ctx = fakeContext as unknown as Context;

  return {
    ctx,
    agent,
    createOptions,
    restrictions,
    sections,
    disposed,
    agentCtxForSetup: agentCtx,
    detach: () => {
      attached = false;
    },
  };
}

// ───────────────────────────── 输入 ─────────────────────────────

const INPUT: FrozenSessionInput = {
  workerSessionId: '11111111-1111-4111-8111-111111111111',
  dshSessionId: 'dsh-11111111-1111-4111-8111-111111111111',
  engagementId: '22222222-2222-4222-8222-222222222222',
  sessionKind: 'phase',
  phase: 'vulnerability-analysis',
  profileId: 'va-profile',
  profileRevision: 'rev-7',
  skillIds: ['web-validation'],
  toolAllow: ['memory_search', 'pentest_exec'],
  approvalRequired: ['exploit_validation'],
  modelRoute: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  actionTemplates: [
    {
      id: 'http_read',
      actionClass: 'passive_collection',
      parameters: [
        { name: 'method', carries: 'HTTP 方法，仅 GET/HEAD' },
        { name: 'path', carries: 'URL 路径' },
      ],
    },
  ],
  publicMemory: '本作业只做被动读取；不要执行任何改变远端状态的请求。',
  taskPrompt: '验证 /admin 的越权读取是否成立',
  handoffContext: '范围版本 3；资产 asset:abc',
};


// ───────────────────────────── 创建 ─────────────────────────────

describe('DshSessionFactory.create', () => {
  it('创建顶层会话：省略 parentAgent，原样使用工作流派生的 dshSessionId', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx, { cwd: 'C:/engagements/e-1' });

    const created = await factory.create(INPUT);

    assert.deepEqual(created, { dshSessionId: INPUT.dshSessionId });
    assert.equal(host.createOptions.length, 1);
    const options = host.createOptions[0];
    assert.ok(options !== undefined);
    assert.equal(options['sessionId'], INPUT.dshSessionId);
    // 顶层 Agent 的核心断言：这个字段不能出现（出现任何 parent 都意味着会话被挂到别的 Agent 下）。
    assert.equal(Object.hasOwn(options, 'parentAgent'), false);
    assert.deepEqual(options['meta'], { cwd: 'C:/engagements/e-1' });
    assert.deepEqual(options['agentOptions'], {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    });
  });

  it('配了预设就在 setup 里挂上，并把它记进会话元数据', async () => {
    // 「渗透模式」此前只对**聊天界面开的会话**生效，而那些会话永远拿不到 engagement 绑定
    // （绑定由控制台 startWorker 创建并派生会话标识）——预设因此是一条死路。
    // 控制台创建的会话必须自己把预设挂上，这条断言锁的就是这件事。
    const host = makeHost();
    const mounted: unknown[] = [];
    const factory = new DshSessionFactory(host.ctx, {
      presetId: 'pentest',
      mountPreset: async (agentCtx) => { mounted.push(agentCtx); },
    });

    await factory.create(INPUT);

    assert.equal(mounted.length, 1, 'setup 必须挂载配置的预设');
    // 挂载必须发生在这个会话的 agent 作用域上（传错 ctx 会让预设落到别处）。
    assert.equal(mounted[0], host.agentCtxForSetup, '必须把 agentCtx 交给挂载函数');
    // 挂了却不在元数据里记，界面会显示「无预设」——元数据与事实不符比不挂更容易误导。
    assert.equal(
      (host.createOptions[0]?.['meta'] as Record<string, unknown>)['agentPreset'],
      'pentest',
    );
  });

  it('没配预设就不挂、也不写元数据（预设是可选姿态，不是工作前提）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);
    await factory.create(INPUT);
    assert.equal(
      Object.hasOwn(host.createOptions[0]?.['meta'] as object, 'agentPreset'),
      false,
      '没挂预设就不该出现该字段',
    );
  });

  it('只配了 id 但没给挂载函数时不写元数据（否则界面会显示一个根本没挂上的预设）', async () => {
    // 装配层解析失败后正好是这个组合：id 在，但挂载能力没注入。
    // 此时往元数据里写 `agentPreset` 就是在撒谎——界面显示「渗透模式」，而会话没挂上。
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx, { presetId: 'pentest' });

    await factory.create(INPUT);

    assert.equal(
      Object.hasOwn(host.createOptions[0]?.['meta'] as object, 'agentPreset'),
      false,
      '元数据必须跟着「确实会挂」走，而不是「配了 id」',
    );
  });

  it('预设挂载失败即让创建失败（不留下提示词与配置不符的会话）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx, {
      presetId: 'ghost',
      mountPreset: async () => { throw new Error('agent-preset/not-found'); },
    });

    await assert.rejects(
      () => factory.create(INPUT),
      /挂载会话预设 ghost 失败/,
      '静默不挂会让会话带着错误的提示词一直跑到人类发现为止',
    );
  });

  it('预设没挂上时，把预设贡献的提问工具从冻结工具面里裁掉（否则会话根本建不起来）', async () => {
    // 预设是**可选**的姿态增强：宿主没有 agentPresets、或预设目录没配时，装配层解析失败，
    // 工厂拿到的是「只有 id、没有挂载函数」或什么都没有。此时预设的行（含官方提问工具）
    // 在继承面上**不存在**，而 `restrict()` 对未知工具名抛错并回滚整次创建——
    // 不收窄的代价就是「少了一层姿态」升级成「一条会话都建不起来」。
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({ ...INPUT, toolAllow: [...INPUT.toolAllow, HUMAN_QUESTION_TOOL] });

    const filter = host.restrictions.at(-1) as { allow?: readonly string[] } | undefined;
    assert.ok(filter?.allow !== undefined, '必须调用 restrict 收窄工具面');
    assert.equal(
      filter.allow.includes(HUMAN_QUESTION_TOOL),
      false,
      '没挂预设 ⇒ 提问工具不在继承面上，allow 里必须没有它',
    );
    assert.equal(filter.allow.includes('pentest_exec'), true, '其余工具面原样保留');
  });

  it('预设挂上时放行提问工具（工具与放行两侧齐备，人类才有可点的选项）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx, {
      presetId: 'pentest',
      mountPreset: async () => undefined,
    });

    await factory.create({ ...INPUT, toolAllow: [...INPUT.toolAllow, HUMAN_QUESTION_TOOL] });

    const filter = host.restrictions.at(-1) as { allow?: readonly string[] } | undefined;
    assert.equal(
      filter?.allow?.includes(HUMAN_QUESTION_TOOL),
      true,
      '预设提供工具、工具面放行它——缺任一侧，人类就只能收到纯文本问卷',
    );
  });

  it('cwd 优先级：engagement 传入的 cwd 覆盖适配器默认值', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx, { cwd: 'C:/default' });

    await factory.create({ ...INPUT, cwd: 'C:/engagements/authorized' });

    assert.deepEqual(host.createOptions[0]?.['meta'], { cwd: 'C:/engagements/authorized' });
  });

  it('setup 里 restrict 收窄为人类勾选的那一份，且只收窄（无 deny、无放宽）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create(INPUT);

    assert.deepEqual(host.restrictions, [{ allow: ['memory_search', 'pentest_exec'] }]);
  });

  it('setup 里把 skill 集合与需放行类别写进提示词分节', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create(INPUT);

    const names = host.sections.map((s) => s.name);
    assert.deepEqual(names, [
      // 公共记忆排在**能力冻结之前**：它是整个作业的长期前提，而能力是本次会话的边界。
      // 顺序在这里有语义（提示词自上而下读），换位会让模型先看到工具清单再看到作业规矩。
      'pentest:engagement-memory',
      'pentest:capability-freeze',
      'pentest:task-brief',
      'pentest:handoff-context',
    ]);
    const orders = host.sections.map((s) => s.order);
    assert.deepEqual([...orders].sort((x, y) => x - y), orders, '分节必须按 order 升序注册');
    assert.ok(orders[0]! < orders[1]!, '公共记忆必须在能力冻结之前');

    const memory = host.sections[0];
    assert.match(memory?.text ?? '', /本作业的公共规则与共识/);
    assert.match(memory?.text ?? '', /只做被动读取/, '正文必须原样进提示词');

    const capability = host.sections[1];
    assert.ok(capability !== undefined);
    assert.match(capability.text, /vulnerability-analysis/);
    assert.match(capability.text, /va-profile@rev-7/);
    assert.match(capability.text, /web-validation/);
    assert.match(capability.text, /exploit_validation/);
    assert.match(capability.text, /memory_search、pentest_exec/);

    const task = host.sections[2];
    assert.match(task?.text ?? '', /验证 \/admin 的越权读取是否成立/);
    const handoff = host.sections[3];
    assert.match(handoff?.text ?? '', /范围版本 3/);
  });

  it('放行类别以**冻结策略**为准：调用方那份语义不同，不得拿它写提示词', async () => {
    // 现场矛盾：快照写着「passive_collection 需逐次放行」，真去申请却被告知「该动作不需要人工放行」。
    // 根因是 intake 调用点把「允许的动作类别」填进了放行字段，而执行器只认策略。
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({
      ...INPUT,
      approvalRequired: ['passive_collection', 'exploit_validation'],
      enforcedApprovalClasses: ['exploit_validation', 'lateral_movement'],
    });

    const capability = host.sections.find((s) => s.name === 'pentest:capability-freeze');
    assert.ok(capability !== undefined);
    // 放行行：显示名 + 标识符 + 释义（显示名的唯一出处见 policy/action-class-labels.ts）。
    const approvalLine = /需要逐次人工放行的动作类别：([^\n]*)/.exec(capability.text)?.[1] ?? '';
    assert.match(approvalLine, /利用验证（exploit_validation）/, '必须列出策略里真正会拦下的类别');
    assert.match(approvalLine, /横向移动（lateral_movement）/, '两个类别都要列出');
    assert.ok(
      !approvalLine.includes('passive_collection'),
      '不得把调用方那份（可能含"允许类别"的那种）当成放行类别写出来',
    );
  });

  it('行为预设作为**提示词**注入：夹在能力快照与任务简报之间，且带升级出口', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({ ...INPUT, behavior: { profile: 'deep', pacing: { rate: 10, concurrency: 4 } } });

    const behavior = host.sections.find((s) => s.name === 'pentest:behavior-preset');
    assert.ok(behavior !== undefined, '传了 behavior 就必须注册该分节');
    // 位置有语义：先看边界（能力快照），再看姿态（预设），最后才是这一轮任务。
    assert.ok(behavior.order > 300 && behavior.order < 310, '必须夹在能力快照与任务简报之间');
    assert.match(behavior.text, /【行为预设：deep｜/);
    assert.match(behavior.text, /尽量覆盖/);
    assert.match(behavior.text, /速率 10\/s、并发 4/, '宿主实际生效的节奏上限必须写进去');
    assert.match(
      behavior.text,
      /pentest_request_action_approval/,
      '必须给出「超出预设怎么升级」的出口——提示词里说了超预设要请放行，就得说清用哪个工具',
    );
    assert.match(behavior.text, /不得先做后报/);
    const orders = host.sections.map((s) => s.order);
    assert.deepEqual([...orders].sort((x, y) => x - y), orders, '分节必须按 order 升序注册');
  });

  it('未传 behavior 时不注册行为分节（intake 这类会话不该出现空壳指引）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create(INPUT);

    assert.equal(host.sections.some((s) => s.name === 'pentest:behavior-preset'), false);
  });

  it('没有语义通道时：提示词不只报通道名，还要给出「该怎么查」的替代打法', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({ ...INPUT, retrievalChannels: ['lexical', 'trigram'] });

    const capability = host.sections.find((s) => s.name === 'pentest:capability-freeze');
    assert.ok(capability !== undefined);
    assert.match(capability.text, /记忆检索通道：全文、三元组/);
    // 关键：模型最容易犯的错是「用一句改写过的问题去查」，召回差就断定「记忆里没有」。
    // 提示词必须点破这一点并给出替代线索类型。
    assert.match(capability.text, /本部署未启用语义通道/);
    assert.match(capability.text, /实体名|错误原文|时间窗/);
    assert.match(capability.text, /不要据此断定/);
  });

  it('有语义通道时按混合检索呈现，不出现「未启用」的误导', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({ ...INPUT, retrievalChannels: ['semantic', 'lexical', 'trigram'] });

    const capability = host.sections.find((s) => s.name === 'pentest:capability-freeze');
    assert.ok(capability !== undefined);
    assert.match(capability.text, /混合检索/);
    assert.equal(capability.text.includes('未启用语义通道'), false);
  });

  it('公共记忆为空时不注册该分节（不往提示词里塞一个空壳标题）', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create({ ...INPUT, publicMemory: '   ' });

    // 全是空白的正文等于没有规矩：注册一个只有标题的分节，模型会以为那里本该有内容。
    assert.equal(
      host.sections.some((s) => s.name === 'pentest:engagement-memory'),
      false,
    );
    // 其余分节不受影响。
    assert.equal(host.sections.length, 3);
  });

  it('创建后立即注入人类确认的任务（followup），消息来源标明由本插件投递', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await factory.create(INPUT);

    const delivery = host.agent.calls[0];
    assert.equal(delivery?.name, 'followup');
    assert.equal(textOf(delivery?.args[0]), INPUT.taskPrompt);

    const message = asUserMessage(delivery?.args[0]);
    assert.ok(message !== undefined);
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'plugin', plugin: 'dsh-pentest' });
    assert.equal(typeof message.id, 'string');
    // 消息是对外发布的不可变值：投递后不能被后续代码改写。
    assert.equal(Object.isFrozen(delivery?.args[0]), true);
  });

  it('dsh 少了 restrict seam 时 fail loud，且不留下任何会话', async () => {
    const host = makeHost({ agentCtx: { systemPrompt: { section: () => () => undefined } } });
    const factory = new DshSessionFactory(host.ctx);

    await assert.rejects(
      () => factory.create(INPUT),
      (error: unknown) =>
        error instanceof SessionFactoryError && /tools\.restrict/.test(error.message),
    );
    // 没有半成品会话：后续投递必须被判为「不存在」。
    await assert.rejects(
      () => factory.deliver(INPUT.dshSessionId, '你好'),
      (error: unknown) => error instanceof SessionFactoryError,
    );
  });

  it('dsh 少了 systemPrompt seam 时 fail loud', async () => {
    const host = makeHost({ agentCtx: { tools: { restrict: () => () => undefined } } });
    const factory = new DshSessionFactory(host.ctx);

    await assert.rejects(
      () => factory.create(INPUT),
      (error: unknown) =>
        error instanceof SessionFactoryError && /systemPrompt\.section/.test(error.message),
    );
  });

  it('dsh 用了不同的会话标识时回滚创建（库里那行不能指向别的会话）', async () => {
    const host = makeHost({ sessionId: 'dsh-别的标识' });
    const factory = new DshSessionFactory(host.ctx);

    await assert.rejects(
      () => factory.create(INPUT),
      (error: unknown) =>
        error instanceof SessionFactoryError && /不同的会话标识/.test(error.message),
    );
    assert.equal(host.disposed.count, 1);
  });

  it('宿主没有 agents 服务时 fail loud', async () => {
    // 一个什么服务都不提供的宿主：工厂必须在创建前就拒绝，而不是创建一个无约束会话。
    const emptyHost = { get: () => undefined } as unknown as Context;
    const factory = new DshSessionFactory(emptyHost);

    await assert.rejects(
      () => factory.create(INPUT),
      (error: unknown) => error instanceof SessionFactoryError && /agents 服务/.test(error.message),
    );
  });
});

// ───────────────────────────── 投递 ─────────────────────────────

describe('DshSessionFactory.deliver', () => {
  it('等待中的会话被唤醒（followup）；运行中的会话按 steer 语义接收', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);
    await factory.create(INPUT);

    await factory.deliver(INPUT.dshSessionId, '把范围收窄到 /admin');

    host.agent.status = 'running';
    await factory.deliver(INPUT.dshSessionId, '停手，先确认这个接口在不在范围内');

    assert.deepEqual(
      host.agent.calls.map((c) => c.name),
      ['followup', 'followup', 'steer'],
    );
    assert.equal(textOf(host.agent.calls[2]?.args[0]), '停手，先确认这个接口在不在范围内');
  });

  it('未创建过的会话投递失败', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await assert.rejects(
      () => factory.deliver('dsh-unknown', '你好'),
      (error: unknown) => error instanceof SessionFactoryError && /不存在/.test(error.message),
    );
  });

  it('宿主已摘掉会话（被取代）时投递失败，不静默成功', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);
    await factory.create(INPUT);

    host.detach();

    await assert.rejects(
      () => factory.deliver(INPUT.dshSessionId, '你好'),
      (error: unknown) =>
        error instanceof SessionFactoryError && /不在 dsh 注册表/.test(error.message),
    );
  });
});

// ───────────────────────────── 中止与关闭 ─────────────────────────────

describe('DshSessionFactory.interrupt / close', () => {
  it('interrupt 用带理由的取消原因，并保留已排队的输入', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);
    await factory.create(INPUT);

    await factory.interrupt(INPUT.dshSessionId, '跑偏到范围外的主机');

    const cancel = host.agent.calls.find((c) => c.name === 'cancel');
    assert.deepEqual(cancel?.args[0], {
      kind: 'hook',
      reason: 'pentest interrupt: 跑偏到范围外的主机',
    });
    assert.deepEqual(cancel?.args[1], { keepInbox: true });
  });

  it('关闭后任何投递都失败，且重复关闭是幂等的', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);
    await factory.create(INPUT);

    await factory.close(INPUT.dshSessionId, '切换阶段');
    await factory.close(INPUT.dshSessionId, '切换阶段');
    assert.equal(host.disposed.count, 1);

    for (const attempt of [
      () => factory.deliver(INPUT.dshSessionId, '还在吗'),
      () => factory.interrupt(INPUT.dshSessionId, '停止'),
    ]) {
      await assert.rejects(
        attempt,
        (error: unknown) => error instanceof SessionFactoryError && /已关闭/.test(error.message),
      );
    }
  });

  it('关闭一个本进程没有的会话失败', async () => {
    const host = makeHost();
    const factory = new DshSessionFactory(host.ctx);

    await assert.rejects(
      () => factory.close('dsh-unknown', '切换阶段'),
      (error: unknown) => error instanceof SessionFactoryError,
    );
  });
});
