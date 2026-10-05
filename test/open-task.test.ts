/**
 * `openTask` 的幂等恢复（session-first intake，`012` / `015`）。
 *
 * ── 为什么单独一个文件 ──
 *
 * 这条路径此前**没有任何测试**，而它是控制台每次挂载都会走的第一跳：
 * `ConsoleApp` 在未选中作业时调 `openTask(clientSessionKey)`，靠
 * `engagements_tenant_client_session` 部分唯一索引把「同一个浏览器键」收敛到**同一个**
 * 作业。缺陷形态因此很难在别处暴露——它会表现为「第二次打开控制台报 23505」。
 *
 * 实测确实发生过：`015` 把反查从「直查 `engagements`」改成受租户约束的
 * `engagement_for_client_session`，而那个函数在函数体内要求 `current_tenant_id()` 非空；
 * 两处交付配置都没有 `config.rlsContext`，GUC 恒为空 → 函数恒返回 NULL → 每次 `openTask`
 * 都以为「没有既有作业」→ 走 INSERT → 撞唯一索引。本文件锁住两条配置路径都不回归。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';

import { compose } from '../src/compose.ts';
import { HUMAN_QUESTION_TOOL } from '../src/contracts.ts';
import type { ComposedPlugin } from '../src/compose.ts';
import type {
  CreatedSession,
  FrozenSessionInput,
  SessionFactory,
} from '../src/workflow/session-port.ts';

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];
const SANDBOX = {
  allowedImages: [{ name: 'registry.example/pentest-toolbox', digest: `sha256:${'a'.repeat(64)}` }],
  internalNetwork: 'pentest-sandbox',
  proxyHost: 'pentest-egress-proxy',
  proxyPort: 3128,
};

/**
 * 只记录、不真的建 dsh 会话。
 *
 * `openTask` 会在签发租约**之后**创建 dsh 会话；真实实现需要 cordis Context，
 * 而这里断言的是数据库侧的幂等收敛，与 dsh 无关。
 */
class RecordingSessionFactory implements SessionFactory {
  readonly created: FrozenSessionInput[] = [];
  async create(input: FrozenSessionInput): Promise<CreatedSession> {
    this.created.push(input);
    return { dshSessionId: input.dshSessionId };
  }
  async deliver(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('集成：openTask 幂等恢复（真实 PostgreSQL）', {
  skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false,
}, () => {
  let client: Client;
  const made: string[] = [];

  before(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  after(async () => {
    if (made.length > 0) {
      // 与兄弟文件同形的清理：这些表的追加写触发器与延迟外键让普通 DELETE 走不通。
      // 切到 replica 角色后用户触发器与 FK 触发器都不触发，删完立刻切回。
      const ids = made;
      await client.query("SET session_replication_role = 'replica'");
      try {
        await client.query('delete from pentest.approvals where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.session_leases where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.scope_intake_proposals where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.index_watermarks where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.outbox_jobs where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.context_events where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.ledger_anchors where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.human_decisions where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.worker_sessions where engagement_id = any($1::uuid[])', [ids]);
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        await client.query('delete from pentest.policy_versions where engagement_id = any($1::uuid[])', [ids]);
        await client.query('delete from pentest.engagements where id = any($1::uuid[])', [ids]);
      } finally {
        await client.query("SET session_replication_role = 'origin'");
      }
    }
    await client.end();
  });

  function composed(
    rlsContext?: { tenantId: string; engagementId: string },
  ): { plugin: ComposedPlugin; sessions: RecordingSessionFactory } {
    const sessions = new RecordingSessionFactory();
    const plugin = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'open-task-test-secret-32-bytes-minimum',
      sandbox: SANDBOX,
      scheduler: { intervalMs: null },
      sessions,
      ...(rlsContext === undefined ? {} : { rlsContext }),
    });
    return { plugin, sessions };
  }

  /** 记住这条路径建出来的 engagement，供清理。 */
  async function openAndTrack(
    plugin: ComposedPlugin,
    key: string,
  ): Promise<{ engagementId: string; workerSessionId: string; resumed: boolean }> {
    const opened = await plugin.workflow.openTask({
      clientSessionKey: key,
      operatorId: 'operator-test',
      reason: '集成测试：验证同一客户端键的幂等恢复',
    });
    if (!made.includes(opened.engagementId)) made.push(opened.engagementId);
    return {
      engagementId: opened.engagementId,
      workerSessionId: opened.workerSessionId,
      resumed: opened.resumed,
    };
  }

  it('未配置 rlsContext：同一 clientSessionKey 第二次调用恢复同一个作业（不是新建）', async () => {
    // 这条锁的正是那个实测回归：反查若恒返回 NULL，第二次会走 INSERT 并撞
    // `engagements_tenant_client_session` 唯一索引（23505），而不是恢复。
    const { plugin } = composed();
    const key = `idem-${randomUUID()}`;
    try {
      const first = await openAndTrack(plugin, key);
      assert.equal(first.resumed, false, '第一次是新建成');

      const second = await openAndTrack(plugin, key);
      assert.equal(second.engagementId, first.engagementId, '同一个键必须收敛到同一个作业');
      assert.equal(second.workerSessionId, first.workerSessionId, '恢复的必须是同一个 intake 会话');
      assert.equal(second.resumed, true, '第二次必须走恢复分支，而不是又建一个');

      // 第三次同样成立（别只对第二次特判）。
      const third = await openAndTrack(plugin, key);
      assert.equal(third.engagementId, first.engagementId);
      assert.equal(third.resumed, true);

      // 库里确实只有一个作业：唯一索引是持久不变量。
      const rows = await client.query<{ n: string }>(
        'select count(*)::text as n from pentest.engagements where client_session_key = $1',
        [key],
      );
      assert.equal(rows.rows[0]?.n, '1');
    } finally {
      await plugin.dispose();
    }
  });

  it('未配置 rlsContext：不同 clientSessionKey 各自建独立作业', async () => {
    // 反向断言：上一条不能靠「永远返回同一个作业」通过。
    const { plugin } = composed();
    try {
      const a = await openAndTrack(plugin, `idem-a-${randomUUID()}`);
      const b = await openAndTrack(plugin, `idem-b-${randomUUID()}`);
      assert.notEqual(a.engagementId, b.engagementId);
      assert.notEqual(a.workerSessionId, b.workerSessionId);
    } finally {
      await plugin.dispose();
    }
  });

  it('配置了 rlsContext：GUC 有值，函数反查可用且能恢复', async () => {
    // ── 这条锁什么、不锁什么（写清楚，免得被当成比实际更强的证据）──
    //
    // **锁住**：「配置了 `rlsContext` ⇒ `BEGIN` 时 GUC 被设上 ⇒ 反查函数可用」。
    // 没了它，`engagement_for_client_session` 恒返回 NULL，第二次 openTask 撞唯一索引。
    //
    // **锁不住**：「直查会被 RLS 挡下」——本文件连的是超级用户（`PENTEST_DATABASE_URL`），
    // 而超级用户**绕过全部 RLS**。因此这里即使把实现换回直查也会通过。
    // 真实角色下的隔离由 `test/rls-isolation.test.ts` 覆盖（它用 `SET LOCAL ROLE pentest_app`），
    // 而 `openTask` 在真实角色下的端到端行为需要部署级 smoke test 才能覆盖
    // （superuser 连接 + `SET ROLE` 的组合无法经连接池表达）。
    const tenantId = `ot-${randomUUID().slice(0, 8)}`;
    const key = `idem-rls-${randomUUID()}`;
    // 传入的 engagementId 是占位值：反查函数只要求 GUC 的**租户**与入参一致，
    // 不要求它等于返回行的 engagement；而 `openTask` 反查到（或生成）真正的 id 之后
    // 会重新 `set_rls_context`。因此占位值不影响本用例的结论。
    const { plugin } = composed({ tenantId, engagementId: randomUUID() });
    try {
      const first = await openAndTrack(plugin, key);
      const second = await openAndTrack(plugin, key);
      assert.equal(second.engagementId, first.engagementId, '配置了 RLS 时必须能恢复');
      assert.equal(second.resumed, true);
      assert.equal(second.workerSessionId, first.workerSessionId);
    } finally {
      await plugin.dispose();
    }
  });

  it('intake 会话的冻结工具面必须放行官方提问工具（否则人类只能收到手抄的问卷）', async () => {
    // 官方 `ask_user_question` 是「AI 提问、人类点选项」这条通道的模型侧入口：
    // 工具行由 `presets/pentest/agent.cordis.yml` 挂载（官方包的宿主半是空实现），
    // 而它能否被这个会话看见由**能力冻结**决定。intake 的全部工作就是问清范围——
    // 缺这一行，人类拿到的就是一份纯文本清单，得自己打字回答。
    const { plugin, sessions } = composed();
    try {
      await openAndTrack(plugin, `ask-${randomUUID()}`);
      const frozen = sessions.created.at(-1);
      assert.ok(frozen !== undefined, 'openTask 必须创建 intake 会话');
      assert.equal(frozen.sessionKind, 'intake');
      assert.equal(
        frozen.toolAllow.includes(HUMAN_QUESTION_TOOL),
        true,
        'intake 的冻结工具面必须包含 ask_user_question',
      );
    } finally {
      await plugin.dispose();
    }
  });

  it('绑定会话已终结：重新绑定而不是复用死会话（C5 回归锁）', async () => {
    // 修复前的形态：`openTask` 的复用判定不看绑定会话是否已终结，于是把一个**已关闭**
    // 的 intake 会话当成「可复用」返回（`resumed: true`），调用方随后拿着它去驱动对话；
    // 而同一个状态在 `bootstrapIntake` 里是「重新绑定」这条恢复路径——两份状态机分叉。
    //
    // 现在两条入口共用 `#stageIntake`：终结的绑定一律重新绑定（同一作业、同一能力边界）。
    const { plugin } = composed();
    const key = `dead-binding-${randomUUID()}`;
    try {
      const first = await openAndTrack(plugin, key);
      assert.equal(first.resumed, false);

      // 模拟真实收尾：intake 会话被关闭（或被启动对账判为中断），而它的租约仍在有效期内。
      await client.query(
        `update pentest.worker_sessions set status = 'closed', ended_at = now() where id = $1::uuid`,
        [first.workerSessionId],
      );

      const second = await openAndTrack(plugin, key);
      assert.equal(second.engagementId, first.engagementId, '同一个客户端键仍然收敛到同一个作业');
      assert.notEqual(
        second.workerSessionId,
        first.workerSessionId,
        '已终结的绑定必须重新绑定一个新会话，而不是把它当成可复用返回',
      );
      assert.equal(second.resumed, false, '重新绑定走 staging 路径（不是「恢复」）');

      // 新会话必须真的**可用**：仍是 intake、范围版本 0（能力边界未变），且被登记为该作业的活动会话。
      const bound = await client.query<{
        session_kind: string;
        scope_version: number;
        status: string;
        active_agent_session_id: string | null;
      }>(
        `select ws.session_kind, ws.scope_version, ws.status, e.active_agent_session_id
           from pentest.worker_sessions ws
           join pentest.engagements e on e.id = ws.engagement_id
          where ws.id = $1::uuid`,
        [second.workerSessionId],
      );
      const row = bound.rows[0];
      assert.equal(row?.session_kind, 'intake');
      assert.equal(row?.scope_version, 0, 'intake 不得带范围版本（确认前没有授权）');
      assert.notEqual(row?.status, 'closed', '返回的会话不得是终结态');
      assert.equal(row?.active_agent_session_id, second.workerSessionId, '必须登记为作业的活动会话');

      // 旧会话保持终结态，不会被「复活」。
      const old = await client.query<{ status: string }>(
        'select status from pentest.worker_sessions where id = $1::uuid',
        [first.workerSessionId],
      );
      assert.equal(old.rows[0]?.status, 'closed');
    } finally {
      await plugin.dispose();
    }
  });
});
