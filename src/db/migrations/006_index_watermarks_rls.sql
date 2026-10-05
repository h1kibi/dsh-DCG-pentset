-- 006：补上 index_watermarks 的 RLS 与授权
--
-- 设计依据：docs/dsh-pentest-plugin-design.md §9.4（隔离策略）
--
-- ── 这个迁移在修什么 ──
--
-- 005 建了 `pentest.index_watermarks`（含 `engagement_id`），但**只移交了所有权**，
-- 既没有 `ENABLE ROW LEVEL SECURITY`，也没有任何 POLICY 与 GRANT。
--
-- 讽刺的是 005 自己的注释写着「运行时角色 `pentest_app` 非所有者，才受 RLS 约束」——
-- 那句话描述的是 RLS 生效的**前提**，而它恰恰没有把 RLS 打开。于是本表对
-- `pentest_app` 而言：既没有权限（无 GRANT）、也没有隔离策略。前者让「读写水位」
-- 直接失败，后者意味着**一旦有人补了 GRANT，隔离就是零**——跨 engagement 可读可写。
--
-- §9.4 的原话是「所有 engagement 相关表启用 RLS + FORCE」。005 漏了这一步，
-- 属于**迁移自身的缺陷**，不是配置问题。
--
-- ── 为什么是 006 而不是改 005 ──
--
-- 遵循本仓既有约定：已发布的迁移不改，向前修（对照 `004_drop_report_pointer.sql`
-- 修 001 的做法）。改 005 会让任何已经跑过它的库（开发库、测试库、容器）永久
-- 停在旧状态——`schema_migrations` 里记着 005 已应用，迁移器不会再跑它。

-- ── 1) 开启 RLS（与 002 对同类表的做法逐字一致）──
--
-- `FORCE` 不能省：表所有者默认绕过 RLS，FORCE 让所有者**也**受策略约束。
-- 少了它，任何以所有者身份连接的代码路径都能看到全部 engagement 的水位。
ALTER TABLE pentest.index_watermarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.index_watermarks FORCE ROW LEVEL SECURITY;

CREATE POLICY app_engagement ON pentest.index_watermarks
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.index_watermarks
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

-- ── 2) 授权 ──
--
-- 水位是**派生数据**：索引器（以 `pentest_app` 身份写）要 upsert 它，
-- 控制台与 Worker 只读。因此给 UPDATE 而不给 DELETE——删除水位等于让索引器
-- 从全量重扫开始，那是运维动作（由 migrator 执行），不该是运行期权限。
--
-- 与 002 的分工一致：002 对已存在的对象整体授权，006 只补 005 之后新建的这一个。
GRANT SELECT, INSERT, UPDATE ON pentest.index_watermarks TO pentest_app;
GRANT SELECT ON pentest.index_watermarks TO pentest_worker_ro, pentest_auditor;

-- ── 3) 自检 ──
--
-- 漏掉上面任一句都会**静默**降级（无策略 = 只有 GRANT 时的全通，无 GRANT = 读不了），
-- 因此在这里显式断言，让迁移本身失败而不是留下一个看似正常的库。
DO $$
DECLARE
    rls_enabled  boolean;
    rls_forced   boolean;
    policy_count integer;
BEGIN
    SELECT relrowsecurity, relforcerowsecurity
      INTO rls_enabled, rls_forced
      FROM pg_class
     WHERE oid = 'pentest.index_watermarks'::regclass;

    IF NOT rls_enabled OR NOT rls_forced THEN
        RAISE EXCEPTION
            'index_watermarks 的 RLS 未按 §9.4 启用（enabled=% forced=%）',
            rls_enabled, rls_forced;
    END IF;

    SELECT count(*) INTO policy_count
      FROM pg_policies
     WHERE schemaname = 'pentest' AND tablename = 'index_watermarks';

    IF policy_count < 2 THEN
        RAISE EXCEPTION
            'index_watermarks 只有 % 条策略，期望至少 2 条（app_engagement + readonly_engagement）',
            policy_count;
    END IF;
END
$$;
