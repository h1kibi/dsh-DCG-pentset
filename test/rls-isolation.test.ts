/**
 * 租户边界与 engagement 边界的**真实角色**测试（§9.4）。
 *
 * ── 为什么必须有这个文件 ──
 *
 * 其余集成测试用超级用户连接（`test/pg-policy.test.ts` 甚至把理由写在文件头），而超级用户
 * **始终绕过 RLS**——策略写得再完整，那些用例也证明不了任何隔离。迁移 013 就是在这个盲区里
 * 把一个 P0 缺陷送进主干的：它给四张表加的 `app_tenant_session_first` 是
 * **PERMISSIVE**，而 PERMISSIVE 策略之间是 OR。于是
 *
 *     app_engagement:      id = current_engagement_id() ∧ tenant_id = current_tenant_id()
 *     app_tenant_session_first:            tenant_id = current_tenant_id()
 *     OR 之后            = tenant_id = current_tenant_id()
 *
 * ——同租户内 engagement 判定被完全抹掉：跨 engagement 读得到目标数据、也写得动
 * `engagements` / `worker_sessions` / `session_leases` / `scope_intake_proposals`。
 * 用非超级用户实测才看得见（本文件第 1 组用例就是它的复现锁）。
 *
 * ── 用什么身份 ──
 *
 * 连接仍用超级用户（它要造种子数据），但断言一律在 `SET LOCAL ROLE pentest_app` 之后执行：
 * RLS 的适用与否看的是 `current_user`，`SET ROLE` 之后既不是超级用户也没有 BYPASSRLS，
 * 因此策略**真的**生效（没生效的话，第 1 组的「跨租户 INSERT 被 42501 拒绝」与
 * 「同租户另一个作业既读不到也改不动」都会绿——两者是这一点的证据）。
 *
 * ── 事务边界与清理（两件事，别混）──
 *
 * `SET ROLE`、`set_rls_context`（内部是 `set_config(..., is_local => true)`）与 `asApp` 里的
 * 断言都在**同一个会 `ROLLBACK` 的事务**内，因此它们不会给共享库留下痕迹。
 *
 * 但**种子数据不是**：`seedPair()` 用超级用户在事务外提交（理由见该函数注释），
 * `ROLLBACK` 撤不掉它。所以它必须登记到 `seeded` 并由 `after` 走共享夹具清理——
 * 漏掉就会按运行次数线性残留，而残留的会话租约会启动对账判为无主并回写账本，
 * 那种污染是跨运行的。**新增种子时记得 `seeded.push(...)`。**
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, Pool } from 'pg';

import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

describe('集成：租户与 engagement 隔离（真实角色 + FORCE RLS）', {
  skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false,
}, () => {
  let client: Client;
  let pool: Pool;
  /**
   * 本文件已造出的 engagement。
   *
   * **必须记下来并清理**：种子数据是用超级用户在事务**外**写的（原因见 `seedPair`），
   * 因此 `asApp` 的 `ROLLBACK` 撤不掉它。不清理就会让共享库按运行次数线性残留，
   * 而残留的会话租约会被启动对账（§15.2 的整库扫描）判为无主并回写账本——
   * 那种污染会跨运行累积，表现为难以复现的 flakiness。
   */
  const seeded: string[] = [];

  before(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    // 角色必须是「不可登录」的部署角色，否则这个测试可能被一条错误的连接串悄悄变成特权会话。
    const roles = await client.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean }>(
      `select rolname, rolcanlogin, rolsuper from pg_roles where rolname = 'pentest_app'`,
    );
    assert.equal(roles.rows[0]?.rolcanlogin, false, 'pentest_app 必须是 NOLOGIN（运行时经 SET ROLE 使用）');
    assert.equal(roles.rows[0]?.rolsuper, false, 'pentest_app 绝不能是超级用户——超级用户绕过全部 RLS');
  });

  after(async () => {
    // 用共享夹具而不是各写一份：表清单只有一个来源（见 `helpers/cleanup.ts` 的头注释）。
    await cleanupEngagements(pool, seeded);
    await pool.end();
    await client.end();
  });

  /** 在一个会回滚的事务里、以 `pentest_app` 身份执行断言。 */
  async function asApp(
    context: { tenantId: string; engagementId: string } | null,
    run: (probe: Probe) => Promise<void>,
  ): Promise<void> {
    await client.query('begin');
    try {
      await client.query('set local role pentest_app');
      if (context !== null) {
        await client.query('select pentest.set_rls_context($1, $2::uuid, null)', [
          context.tenantId,
          context.engagementId,
        ]);
      }
      await run(makeProbe());
    } finally {
      await client.query('rollback');
    }
  }

  /**
   * 把「预期被拒」与「预期为空」分开断言。
   *
   * 两者都算「挡住了」，但机制不同：前者是 WITH CHECK / INSERT 权限拒绝（抛错），
   * 后者是 USING 把行过滤掉（零行）。混成一个「没成功」会掩盖住「USING 漏了、
   * 只是恰好撞上 WITH CHECK」这类半边成立的情形。
   */
  interface Probe {
    /** 预期抛错：用 `42501` 之类的权限拒绝证明写入确实被闸住。 */
    denied(sql: string, params?: readonly unknown[]): Promise<{ code: string }>;
    /** 预期零行：证明读取路径在没有权限错误的情况下也看不见。 */
    empty(sql: string, params?: readonly unknown[]): Promise<void>;
    rows<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  }

  function makeProbe(): Probe {
    return {
      async denied(sql, params) {
        await client.query('savepoint probe');
        try {
          await client.query(sql, params as unknown[] | undefined);
        } catch (error) {
          await client.query('rollback to savepoint probe');
          const code = (error as { code?: string }).code;
          assert.ok(typeof code === 'string', `预期被拒但错误没有稳定码：${String(error)}`);
          return { code };
        }
        await client.query('release savepoint probe');
        throw new Error(`预期被拒，实际通过：${sql}`);
      },
      async empty(sql, params) {
        const result = await client.query(sql, params as unknown[] | undefined);
        assert.equal(result.rowCount, 0, `预期看不见任何行，实际 ${String(result.rowCount)} 行：${sql}`);
      },
      async rows(sql, params) {
        return (await client.query(sql, params as unknown[] | undefined)).rows;
      },
    };
  }

  /**
   * 造两个作业：A（当前上下文）与 B（同租户的另一个作业），各带会话、租约、提案、资产。
   *
   * ── 为什么种子在事务外写 ──
   *
   * `probe` 里的断言要求 A 的数据在**切换上下文之前**就已提交存在（否则 `SET LOCAL ROLE`
   * 之后连自己的行也看不到，那些「本作业的资产必须仍可见」的对照断言会失去意义）。
   * 因此种子用超级用户连接直接提交，而 `asApp` 只回滚它自己 `begin` 的那一段。
   *
   * 代价是种子**不会**被 `ROLLBACK` 撤掉，所以必须登记到 `seeded` 由 `after` 清理——
   * 漏了这一步就会污染共享库（见 `seeded` 的注释）。
   */
  async function seedPair(): Promise<{
    tenantId: string;
    a: string;
    b: string;
    sessionA: string;
    sessionB: string;
  }> {
    const tenantId = `rls-${randomUUID().slice(0, 8)}`;
    const a = randomUUID();
    const b = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    seeded.push(a, b);

    for (const [id, name] of [[a, 'iso-a'], [b, 'iso-b']]) {
      await client.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
            roe_snapshot, policy_snapshot, config_snapshot, created_by, client_session_key)
         values ($1::uuid, $2, $3, 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'rls-test', $4)`,
        [id, tenantId, name, `key-${id}`],
      );
    }
    for (const [sessionId, engagementId] of [[sessionA, a], [sessionB, b]]) {
      await client.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt,
            iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
         values ($1::uuid, $2::uuid, $3, 'vulnerability-analysis', 'p', 'r1', 1, 1, 1, 'tp',
            '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
        [sessionId, engagementId, `dsh-${sessionId}`],
      );
      await client.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
        [engagementId, sessionId],
      );
    }
    await client.query(
      `insert into pentest.assets (engagement_id, canonical_target, kind, first_seen_iteration)
       values ($1::uuid, 'a.rls.test', 'domain', 1), ($2::uuid, 'b.rls.test', 'domain', 1)`,
      [a, b],
    );
    await client.query(
      `insert into pentest.scope_intake_proposals
         (engagement_id, worker_session_id, objective, proposed_targets, proposed_exclusions,
          proposed_allowed_actions, authorization_note, status)
       values ($1::uuid, $2::uuid, 'o', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'n', 'pending')`,
      [b, sessionB],
    );
    return { tenantId, a, b, sessionA, sessionB };
  }

  // ─────────────── 1. engagement 边界（013 缺陷的复现锁） ───────────────

  it('上下文设为 A 时，A 之外的目标数据既读不到也改不动（同租户内也不行）', async () => {
    const { tenantId, a, b, sessionB } = await seedPair();
    await asApp({ tenantId, engagementId: a }, async (probe) => {
      // 目标数据：读不到。
      await probe.empty('select 1 from pentest.assets where engagement_id = $1::uuid', [b]);
      await probe.empty('select 1 from pentest.worker_sessions where engagement_id = $1::uuid', [b]);
      await probe.empty('select 1 from pentest.session_leases where engagement_id = $1::uuid', [b]);
      await probe.empty('select 1 from pentest.scope_intake_proposals where engagement_id = $1::uuid', [b]);
      // 自己的看得见——否则上面的「读不到」可能只是整条路径都坏了。
      assert.equal(
        (await probe.rows('select 1 from pentest.assets where engagement_id = $1::uuid', [a])).length,
        1,
        '本作业的资产必须仍然可见（不然这条用例的空结果没有意义）',
      );

      // 写路径：0 行受影响。**这正是 013 放开的口子**——当时这里会返回 1 行。
      await probe.empty("update pentest.engagements set name = 'pwned' where id = $1::uuid returning 1", [b]);
      await probe.empty("update pentest.session_leases set revoked_at = now() where engagement_id = $1::uuid and revoked_at is null returning 1", [b]);
      await probe.empty("update pentest.worker_sessions set status = 'closed' where engagement_id = $1::uuid returning 1", [b]);

      // ── INSERT：USING 与 WITH CHECK 是两条独立的闸，必须分别证明 ──
      //
      // UPDATE 被挡下只说明 USING 过滤掉了目标行（0 行受影响）；**WITH CHECK 缺失时
      // UPDATE 依旧返回 0 行**，两者不可区分。只有 INSERT 能让「只写了 USING、漏写
      // WITH CHECK」显形：它没有旧行可过滤，唯一能拦它的就是 WITH CHECK（或权限）。
      //
      // 断言「被拒」而不是「0 行」：这里的正确结论是抛错（42501 / WITH CHECK 违规），
      // 而「静默写入成功」与「静默什么都没发生」都必须算失败。
      const intoB = await probe.denied(
        `insert into pentest.assets (engagement_id, canonical_target, kind, first_seen_iteration)
         values ($1::uuid, 'smuggled.rls.test', 'domain', 1)`,
        [b],
      );
      assert.equal(intoB.code, '42501', '向别的作业插入必须被策略/权限拒绝（42501）');
      const leaseIntoB = await probe.denied(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 99, now() + interval '1 hour')`,
        [b, sessionB],
      );
      assert.equal(leaseIntoB.code, '42501', '向别的作业插入租约同样必须被拒');
      // 自己租户内、但**别的 engagement** 的会话也不行（防止「只校验租户」的写法混进来）。
      await probe.empty(
        `select 1 from pentest.session_leases where engagement_id = $1::uuid and generation = 99`,
        [b],
      );

      // 自己的写路径照常（证明 WITH CHECK 用的是当前上下文而不是「一律拒绝」）。
      assert.equal(
        (await probe.rows("update pentest.session_leases set revoked_reason = null where engagement_id = $1::uuid and revoked_at is null returning 1", [a])).length,
        1,
      );
      assert.equal(
        (await probe.rows(
          `insert into pentest.assets (engagement_id, canonical_target, kind, first_seen_iteration)
           values ($1::uuid, 'own.rls.test', 'domain', 1) returning 1`,
          [a],
        )).length,
        1,
        '本作业内的插入必须成功（否则上面的「被拒」可能只是权限没给）',
      );
    });
  });

  it('作业列表按租户可见（这是控制台首屏的设计行为，不是泄露）', async () => {
    const { tenantId, a, b } = await seedPair();
    await asApp({ tenantId, engagementId: a }, async (probe) => {
      const names = await probe.rows<{ name: string }>(
        'select name from pentest.engagements order by name',
      );
      const visible = names.map((row) => row.name);
      assert.ok(visible.includes('iso-a'), '当前作业必须在列表里');
      assert.ok(
        visible.includes('iso-b'),
        '同租户的其它作业也必须在列表里——「列出我有哪些作业」是控制台的第一步（§6.1）',
      );
    });
  });

  it('未设上下文时一切为空（fail-closed：连接池借出脏连接不该看到任何行）', async () => {
    const { tenantId } = await seedPair();
    await asApp(null, async (probe) => {
      await probe.empty('select 1 from pentest.engagements');
      await probe.empty('select 1 from pentest.assets');
      await probe.empty('select 1 from pentest.worker_sessions');
    });
    // 租户字段本身也不构成放行条件：只有租户、没有 engagement 时同样什么都看不见。
    await asApp({ tenantId, engagementId: randomUUID() }, async (probe) => {
      await probe.empty('select 1 from pentest.assets');
    });
  });

  // ─────────────── 2. 跨租户 ───────────────

  it('跨租户：另一个租户的作业既不可见，反查也不返回', async () => {
    const { a, sessionA } = await seedPair();
    const otherTenant = `rls-other-${randomUUID().slice(0, 8)}`;
    await asApp({ tenantId: otherTenant, engagementId: a }, async (probe) => {
      await probe.empty('select 1 from pentest.engagements');
      await probe.empty('select 1 from pentest.assets');
      await probe.empty('select 1 from pentest.worker_sessions');
      // 反查函数必须自己再校验一次租户：它是 SECURITY DEFINER，绕过 RLS 读原表。
      const viaSession = await probe.rows<{ engagement_id: string | null }>(
        'select pentest.engagement_for_worker_session($1::uuid) as engagement_id',
        [sessionA],
      );
      assert.equal(viaSession[0]?.engagement_id, null, '不属于当前租户的会话不得被反查出来');
    });
  });

  it('反查函数：本租户返回 engagement，供「先有鸡」的路径使用', async () => {
    const { tenantId, a, b, sessionA } = await seedPair();
    await asApp({ tenantId, engagementId: a }, async (probe) => {
      const viaSession = await probe.rows<{ engagement_id: string | null }>(
        'select pentest.engagement_for_worker_session($1::uuid) as engagement_id',
        [sessionA],
      );
      assert.equal(viaSession[0]?.engagement_id, a);
      const viaKey = await probe.rows<{ engagement_id: string | null }>(
        'select pentest.engagement_for_client_session($1, $2) as engagement_id',
        [tenantId, `key-${b}`],
      );
      assert.equal(viaKey[0]?.engagement_id, b, 'openTask 靠它反查自己的作业');
      const wrongTenant = await probe.rows<{ engagement_id: string | null }>(
        'select pentest.engagement_for_client_session($1, $2) as engagement_id',
        ['another-tenant', `key-${b}`],
      );
      assert.equal(wrongTenant[0]?.engagement_id, null, '租户不符时反查必须返回 NULL');
    });
  });

  /**
   * 016 的反查函数：**dsh 会话标识 → Worker 绑定**。
   *
   * 这条必须锁住，因为工具层拿到的是 dsh 侧身份，而它是「先有鸡后有蛋」的第一步
   * （要先知道会话属于哪个作业，才能设出 RLS 上下文）。此前这一步是裸查询，
   * 在 015 拆掉 `worker_sessions` 的租户级放行之后恒返回 0 行——工具于是把
   * 「查不到」报成「本会话不是渗透控制台创建的」，**在已经成功 bootstrap 的会话上
   * 也这么说**（实测：建单成功，紧随其后的记忆检索与状态便签全部以该错误失败）。
   */
  it('按 dsh 会话反查绑定：租户内可解析，无上下文与跨租户都拿不到', async () => {
    const { tenantId, a, sessionA } = await seedPair();

    // ① 租户上下文内：解析出正确的 worker 会话与作业——工具层的身份来源。
    await asApp({ tenantId, engagementId: a }, async (probe) => {
      const rows = await probe.rows<{ worker_session_id: string | null; engagement_id: string | null }>(
        'select worker_session_id, engagement_id from pentest.worker_session_binding_by_dsh($1)',
        [`dsh-${sessionA}`],
      );
      assert.equal(rows.length, 1, '本租户的 dsh 会话必须可解析');
      assert.equal(rows[0]?.worker_session_id, sessionA, '必须给出 worker 会话标识（服务方法的身份）');
      assert.equal(rows[0]?.engagement_id, a, '并且要指出它属于哪个作业');
    });

    // ② 没有租户上下文：函数体要求 current_tenant_id() 非空，因此零行（fail closed）。
    //    函数是 SECURITY DEFINER，若只信任当前上下文就成了绕过通道，这条正是它的闸。
    await asApp(null, async (probe) => {
      await probe.empty(
        'select worker_session_id from pentest.worker_session_binding_by_dsh($1)',
        [`dsh-${sessionA}`],
      );
    });

    // ③ 另一个租户：不归你，零行。与「不存在」不可区分是有意的。
    await asApp({ tenantId: `other-${randomUUID().slice(0, 8)}`, engagementId: a }, async (probe) => {
      await probe.empty(
        'select worker_session_id from pentest.worker_session_binding_by_dsh($1)',
        [`dsh-${sessionA}`],
      );
    });
  });

  // ─────────────── 3. 根因锁：租户边界必须是 RESTRICTIVE ───────────────

  it('租户边界是 RESTRICTIVE：再加一条 PERMISSIVE 租户策略也打不开跨租户访问', async () => {
    const { tenantId, a, b } = await seedPair();
    const otherTenant = `rls-x-${randomUUID().slice(0, 8)}`;

    // 结构性事实：每张 engagement/租户作用域的表都必须有一条 RESTRICTIVE 租户边界策略。
    //
    // 这里锁的**不是**「跨 engagement」——那由 `app_engagement` 与「不存在租户级 PERMISSIVE
    // 放行」共同保证，第 1 组用例按行为锁它（实测注入「把 engagements 的 tenant_boundary
    // 改成 PERMISSIVE」后第 1 组立刻变红）。这里锁的是**租户**维度：PERMISSIVE 只能放宽
    // （任一满足即通过），所以想表达「无论以后谁再加什么策略，租户都必须对得上」，
    // 唯一形态是 RESTRICTIVE。013 的教训正是拿 PERMISSIVE 去表达一个本该是「与」的约束。
    //
    // 判据按「有 engagement_id **或**有 tenant_id」取表，因此 `engagements` **也在内**——
    // 它恰恰是 013 与 015 争夺的那一张，漏掉它会让这条结构断言对根因不敏感。
    //
    // 用超集而不是精确计数：002 起就有别的 RESTRICTIVE 策略（例如
    // `memory_access_log` 的 `app_access_log_own_session`），精确计数会把它们误判成多余。
    const scoped = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
        where c.relnamespace = 'pentest'::regnamespace and c.relkind = 'r'
          and exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname in ('engagement_id', 'tenant_id')
                         and a.attnum > 0 and not a.attisdropped)
        order by c.relname`,
    );
    const restrictive = new Set(
      (await client.query<{ relname: string }>(
        `select distinct c.relname from pg_policy p join pg_class c on c.oid = p.polrelid
          where c.relnamespace = 'pentest'::regnamespace and p.polpermissive = false`,
      )).rows.map((row) => row.relname),
    );
    assert.deepEqual(
      scoped.rows.map((row) => row.relname).filter((name) => !restrictive.has(name)),
      [],
      '每张有 engagement_id 或有 tenant_id 的表都必须带一条 RESTRICTIVE 的边界策略',
    );

    // 行为性事实：注入一条**确实会放行该行**的 PERMISSIVE 策略，RESTRICTIVE 仍把它 AND 掉。
    //
    // 关键在 `using (true)`：这是 PERMISSIVE 语义下最强的放宽（「任何行都可见」）。
    // 之前这里注入的是 013 原样的 `e.tenant_id = current_tenant_id()`，而断言用的上下文
    // 租户与行不同 → 那个 EXISTS 恒为假 → 注入的策略根本不可能放行 → 断言与该 DDL 无关，
    // 删掉它结果也一样。**弱锁**：它没有触及 PERMISSIVE(OR) 与 RESTRICTIVE(AND) 的语义差异，
    // 而那正是 §9.4.2 记的教训。
    //
    // 用 `using (true)` 之后这条断言才有判别力：
    //   - 有 RESTRICTIVE 层 → `true AND tenant 相符` → 跨租户仍不可见 → 绿；
    //   - 没有 RESTRICTIVE 层 → `true OR ...` → 可见 → **红**。
    await client.query('begin');
    try {
      await client.query(
        `create policy regression_tenant_widener on pentest.worker_sessions
             as permissive for all to pentest_app
             using (true) with check (true)`,
      );
      await client.query('set local role pentest_app');
      // 上下文与作业 A 的租户不符：RESTRICTIVE 必须让「任何行都可见」这条放宽失效。
      await client.query('select pentest.set_rls_context($1, $2::uuid, null)', [otherTenant, a]);
      const leaked = await client.query(
        'select 1 from pentest.worker_sessions where engagement_id = $1::uuid',
        [a],
      );
      assert.equal(
        leaked.rowCount,
        0,
        'using(true) 是最强的 PERMISSIVE 放宽；租户不符时它仍必须被 RESTRICTIVE 层 AND 掉',
      );

      // 租户相符时该放行就放行——证明上面那条 0 行不是因为「整段都读不到」。
      await client.query('select pentest.set_rls_context($1, $2::uuid, null)', [tenantId, a]);
      const stillOwn = await client.query(
        'select 1 from pentest.worker_sessions where engagement_id = $1::uuid',
        [a],
      );
      assert.equal(stillOwn.rowCount, 1, '放宽策略不该把正常路径一起挡掉');
    } finally {
      await client.query('rollback');
    }

    // 撤掉放宽策略之后，「同租户的另一个作业不可见」必须重新成立——第 1 组用例覆盖的
    // 正是这条；这里再确认一次，是因为上面那段故意把 013 的条件造出来过。
    await asApp({ tenantId, engagementId: a }, async (probe) => {
      await probe.empty('select 1 from pentest.worker_sessions where engagement_id = $1::uuid', [b]);
    });
  });
});
