-- 002_security.sql — 隔离与角色（§9.4）+ 追加写与完整性（§9.5）
--
-- 权威来源：docs/dsh-pentest-plugin-design.md
--   §9.4 隔离与角色、§9.5 追加写与完整性、§11.5 保留策略（解释本文件为何不把 DELETE 授予运行时角色）。
--
-- 本文件按固定顺序做四件事，顺序不可调换：
--   1. 建四个角色与「事务上下文」辅助函数（§9.4）；
--   2. 对全部 engagement 相关表 ENABLE + FORCE ROW LEVEL SECURITY，按会话变量
--      pentest.engagement_id 隔离（§9.4）；
--   3. 按 §9.5 把表分成「审计账本」与「运行态记录」两类，前者的 UPDATE/DELETE 被触发器拒绝，
--      后者只允许状态与结算列的一次性前向迁移；
--   4. 按角色 GRANT/REVOKE，最后把对象所有权移交给 pentest_migrator。
--
-- 部署契约（三条，都是安全前提，不满足时本迁移会响亮失败而不是静默降级）：
--   - 迁移连接必须是能 CREATE ROLE、并能 SET ROLE pentest_migrator 的管理员角色
--     （标准部署用管理员执行迁移；文件末尾把所有对象所有权移交给 pentest_migrator）；
--   - 运行时连接池只授 pentest_app，绝不使用表所有者或超级用户
--     （§9.4「表所有者不得作为运行时角色」；超级用户会绕过全部 RLS，FORCE 也拦不住）；
--   - 本文件不为未来对象设置默认权限：新增表必须在后续迁移里显式补齐 RLS 与 GRANT，
--     否则会出现「有数据、无策略」的新表。

-- ───────────────────────────── §9.4 角色 ─────────────────────────────
--
-- 四个角色职责互斥，互不进入对方的连接池：
--   pentest_migrator   迁移与维护；本 schema 的对象所有者；不进入运行时连接池
--   pentest_app        运行时读写；非表所有者；无 DDL、无 DELETE
--   pentest_worker_ro  Worker 侧受限只读（记忆与证据元数据），不写状态
--   pentest_auditor    按授权读取全量事件，含思考链（llm_calls.reasoning_zstd、
--                      context_events 原始载荷），只读
--
-- PostgreSQL 没有 CREATE ROLE IF NOT EXISTS，用 DO 块 + 目录检查实现幂等；
-- CREATE ROLE 是工具命令，plpgsql 里必须走 EXECUTE。

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_migrator') THEN
        EXECUTE 'CREATE ROLE pentest_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_app') THEN
        EXECUTE 'CREATE ROLE pentest_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_worker_ro') THEN
        EXECUTE 'CREATE ROLE pentest_worker_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_auditor') THEN
        EXECUTE 'CREATE ROLE pentest_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    END IF;
END;
$$;

-- 既有角色不改写属性，但必须拦住「带 superuser / BYPASSRLS 的角色」：
-- 这类角色会静默绕过下面全部策略，属于必须人工处置的配置错误，不能继续迁移。
DO $$
DECLARE
    bad_roles text;
BEGIN
    SELECT string_agg(rolname, ', ' ORDER BY rolname)
      INTO bad_roles
      FROM pg_roles
     WHERE rolname IN ('pentest_migrator', 'pentest_app', 'pentest_worker_ro', 'pentest_auditor')
       AND (rolsuper OR rolbypassrls);
    IF bad_roles IS NOT NULL THEN
        RAISE EXCEPTION 'pentest 角色不得是 superuser 或 BYPASSRLS：% 必须由管理员重建为普通角色（§9.4）',
            bad_roles
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

-- 部署前提（提前拦截，避免在文件末尾才抛出难以理解的错误）：
-- 文件末尾要把对象所有权移交给 pentest_migrator，这要求迁移连接能 SET ROLE pentest_migrator——
-- 超级用户、或创建过该角色的管理员都满足。角色已存在但当前连接不是其成员时，
-- 与其让 `ALTER TABLE ... OWNER TO` 在中途报错，不如在这里给出可执行的提示。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_migrator')
       AND NOT pg_has_role(current_user, 'pentest_migrator', 'MEMBER') THEN
        RAISE EXCEPTION '迁移连接必须是 pentest_migrator 的成员（或超级用户）才能移交对象所有权（§9.4）：当前角色 % 不满足',
            current_user
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

-- ───────────────────── §9.4 事务上下文（tenant / engagement / session）─────────────────────
-- 策略一律走这三个辅助函数，不在每条策略里重复写 current_setting：
--   - current_setting(..., true) 在未设置时返回 NULL，NULLIF 把空串也归一成 NULL，
--     于是策略比较结果为 NULL → 不返回任何行。**fail-closed**：忘记设置上下文只会看不见数据，
--     不会看见别人的数据；
--   - 值为非法 uuid 时转换报错（响亮失败），不静默当作未设置。

CREATE OR REPLACE FUNCTION pentest.current_tenant_id() RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT NULLIF(current_setting('pentest.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION pentest.current_engagement_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT NULLIF(current_setting('pentest.engagement_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION pentest.current_worker_session_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT NULLIF(current_setting('pentest.worker_session_id', true), '')::uuid $$;

-- 事务开始时一次性设置上下文（§9.4）。set_config(..., true) 是事务内生效（等价 SET LOCAL），
-- 因此必须在事务里调用：连接池借出连接后由调用方在 BEGIN 之后调用本函数。
CREATE OR REPLACE FUNCTION pentest.set_rls_context(
    p_tenant_id text,
    p_engagement_id uuid,
    p_worker_session_id uuid DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('pentest.tenant_id', coalesce(p_tenant_id, ''), true);
    PERFORM set_config('pentest.engagement_id', coalesce(p_engagement_id::text, ''), true);
    PERFORM set_config('pentest.worker_session_id', coalesce(p_worker_session_id::text, ''), true);
END;
$$;

-- 清除会话级残留上下文（§9.4「连接池借出连接时必须清理残留上下文」）：
-- 事务级设置随事务结束失效，但连接池归还/借出时仍应显式清除会话级值，避免复用连接串上下文。
CREATE OR REPLACE FUNCTION pentest.clear_rls_context() RETURNS void
    LANGUAGE sql VOLATILE
AS $$
    SELECT set_config('pentest.tenant_id', '', false),
           set_config('pentest.engagement_id', '', false),
           set_config('pentest.worker_session_id', '', false)
$$;

-- ───────────────────────────── §9.4 行级安全 ─────────────────────────────
--
-- 覆盖范围：全部带 engagement_id 的表，加上 retrieval_hits（自身无 engagement_id，
-- 经 retrieval_queries 归属）。skills 是跨 engagement 的全局技能注册表，不含 engagement_id，
-- 因此不启用 RLS——它的访问控制由 GRANT 单独表达。
--
-- 每张表两条策略：
--   app_engagement       pentest_app：FOR ALL，读与写都必须落在当前 engagement；
--   readonly_engagement  pentest_worker_ro / pentest_auditor：FOR SELECT，同一 engagement 边界。
-- 两者隔离范围相同，差别在授权：auditor 能读全部表（含思考链），worker_ro 只读记忆与证据元数据。
--
-- ENABLE 让策略对非所有者生效；FORCE 让**表所有者**也受策略约束（§9.4 要求所有者不得是运行时角色，
-- 而所有者一旦被用于运行时连接，FORCE 是最后一道闸）。超级用户始终绕过 RLS，因此运维连接除外。

ALTER TABLE pentest.engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.engagements FORCE ROW LEVEL SECURITY;
-- engagements 是租户边界的落点：其余表通过与它的 id 关联间接归属租户，因此只在这里校验 tenant_id
CREATE POLICY app_engagement ON pentest.engagements
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (id = pentest.current_engagement_id() AND tenant_id = pentest.current_tenant_id())
    WITH CHECK (id = pentest.current_engagement_id() AND tenant_id = pentest.current_tenant_id());
CREATE POLICY readonly_engagement ON pentest.engagements
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (id = pentest.current_engagement_id() AND tenant_id = pentest.current_tenant_id());

ALTER TABLE pentest.scope_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.scope_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.scope_versions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.scope_versions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.assets FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.assets
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.assets
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.asset_scope_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.asset_scope_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.asset_scope_versions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.asset_scope_versions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.worker_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.worker_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.worker_sessions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.worker_sessions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.worker_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.worker_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.worker_reports
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.worker_reports
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.session_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.session_leases
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.session_leases
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.context_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.context_events FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.context_events
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.context_events
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.ledger_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.ledger_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.ledger_anchors
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.ledger_anchors
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.llm_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.llm_calls
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.llm_calls
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.request_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.request_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.request_snapshots
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.request_snapshots
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.tool_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.tool_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.tool_runs
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.tool_runs
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.artifacts
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.artifacts
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.memory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.memory_items
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.memory_items
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.findings FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.findings
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.findings
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.memory_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.memory_chunks
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.memory_chunks
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.embedding_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.embedding_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.embedding_revisions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.embedding_revisions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.retrieval_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.retrieval_queries FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.retrieval_queries
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.retrieval_queries
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

-- retrieval_hits 没有 engagement_id：经 retrieval_queries 归属，避免命中明细成为隔离缺口。
-- 子查询里的 retrieval_queries 自身也受 RLS 约束（同 engagement），两条判定一致。
ALTER TABLE pentest.retrieval_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.retrieval_hits FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.retrieval_hits
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (EXISTS (SELECT 1 FROM pentest.retrieval_queries q
                    WHERE q.id = retrieval_hits.query_id
                      AND q.engagement_id = pentest.current_engagement_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM pentest.retrieval_queries q
                         WHERE q.id = retrieval_hits.query_id
                           AND q.engagement_id = pentest.current_engagement_id()));
CREATE POLICY readonly_engagement ON pentest.retrieval_hits
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (EXISTS (SELECT 1 FROM pentest.retrieval_queries q
                    WHERE q.id = retrieval_hits.query_id
                      AND q.engagement_id = pentest.current_engagement_id()));

ALTER TABLE pentest.memory_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.memory_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.memory_access_log
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.memory_access_log
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());
-- 会话标识的落点：访问日志只能记录**当前会话自身**的访问，防止运行时代他人记账/伪造访问痕迹。
-- RESTRICTIVE 与上面的 PERMISSIVE 策略是「与」关系，收紧而不是放开；
-- 控制台访问（operator_id 有值、worker_session_id 为 NULL）在上下文未设会话时同样成立。
CREATE POLICY app_access_log_own_session ON pentest.memory_access_log
    AS RESTRICTIVE FOR INSERT TO pentest_app
    WITH CHECK (worker_session_id IS NOT DISTINCT FROM pentest.current_worker_session_id());

ALTER TABLE pentest.handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.handoffs
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.handoffs
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.human_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.human_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.human_decisions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.human_decisions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.state_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.state_transitions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.state_transitions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.approvals
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.approvals
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.reports FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.reports
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.reports
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

ALTER TABLE pentest.outbox_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.outbox_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.outbox_jobs
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.outbox_jobs
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

-- ───────────────────────────── §9.5 追加写与完整性 ─────────────────────────────
--
-- §9.5 把表**分成两类，规则相反**，这是本文件最容易被搞混的地方：
--
--   A. 审计账本类（context_events、human_decisions、state_transitions、memory_access_log、
--      ledger_anchors）：事实来源。运行时角色无 UPDATE/DELETE，触发器拒绝修改已提交行。
--      修正只能「追加新事件并引用被取代条目」——所以这里连运行时的改写通道都不留。
--
--   B. 运行态记录类（llm_calls、tool_runs、worker_sessions、session_leases、outbox_jobs、handoffs）：
--      跟踪**在途**状态，结算时必须从 running 改为 completed / failed / unknown
--      （§15.2 崩溃对账、§15.3 结果丢失都依赖这一点）。如果对它们套用只追加规则，
--      结算写入必然失败、崩溃恢复无法对账。因此这里允许更新，但把可更新面收窄：
--         - 冻结列：首次写入后不可改（request_header、arguments_json、stdout_zstd、draft_json 等原始内容）；
--         - 一次性结算列：只允许 NULL → 非 NULL 写一次，不允许覆盖；
--         - 可变结算列：状态与结算字段（status、finished_at、consumed_*、revoked_*、attempts 等）；
--         - 状态：只允许转换表里显式列出的边，终态不可回退，已结算行只允许状态继续前向。
--
-- 签名与锚点：每批追加的 HMAC/签名由插件进程用 KMS 密钥在库外产生（§9.5），运行时角色不持有密钥；
-- 数据库侧要保证的是「运行时角色无法伪造或删除锚点」——ledger_anchors 属于 A 类，
-- 只有 INSERT/SELECT 权限且被触发器拒绝改写，因此链头摘要与事件计数不可被运行时抹除。

-- A 类：审计账本只追加。一个共享函数 + 每表一个触发器（此前先用 GRANT 收掉 UPDATE/DELETE，
-- 触发器是第二道闸：即使将来误授了权限，已提交行仍然改不动）。
CREATE OR REPLACE FUNCTION pentest.reject_append_only_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '审计账本表 % 只允许追加，% 被拒绝（§9.5）：修正必须追加新事件并引用被取代条目',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER context_events_append_only
    BEFORE UPDATE OR DELETE ON pentest.context_events
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_append_only_mutation();

CREATE TRIGGER human_decisions_append_only
    BEFORE UPDATE OR DELETE ON pentest.human_decisions
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_append_only_mutation();

CREATE TRIGGER state_transitions_append_only
    BEFORE UPDATE OR DELETE ON pentest.state_transitions
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_append_only_mutation();

CREATE TRIGGER memory_access_log_append_only
    BEFORE UPDATE OR DELETE ON pentest.memory_access_log
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_append_only_mutation();

CREATE TRIGGER ledger_anchors_append_only
    BEFORE UPDATE OR DELETE ON pentest.ledger_anchors
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_append_only_mutation();

-- B 类：运行态记录的状态推进。触发器参数（TG_ARGV，按顺序）：
--   0 状态列名
--   1 终态集合（终态不可回退、不可改写）
--   2 已结算集合（含终态；进入后只有状态列还能按转换表前向推进）
--   3 允许的状态迁移边，`旧>新`，源写 `*` 表示「任意非终态」
--   4 可变结算列（状态列天然可变）
--   5 一次性列（只允许 NULL → 非 NULL）
--   6 其中属于「结算」的一次性列（只能在同一次 UPDATE 进入结算态时写入；生命周期列留空）
-- 未列出的列一律视为冻结列：改了就抛错，而不是静默放行。
CREATE OR REPLACE FUNCTION pentest.enforce_state_progression() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    status_col     text   := TG_ARGV[0];
    terminal_set   text[] := string_to_array(NULLIF(TG_ARGV[1], ''), ',');
    settled_set    text[] := string_to_array(NULLIF(TG_ARGV[2], ''), ',');
    transition_set text[] := string_to_array(NULLIF(TG_ARGV[3], ''), ',');
    mutable_cols   text[] := string_to_array(NULLIF(TG_ARGV[4], ''), ',');
    once_cols      text[] := string_to_array(NULLIF(TG_ARGV[5], ''), ',');
    settlement_cols text[] := string_to_array(NULLIF(TG_ARGV[6], ''), ',');
    old_row    jsonb := to_jsonb(OLD);
    new_row    jsonb := to_jsonb(NEW);
    old_status text  := old_row ->> TG_ARGV[0];
    new_status text  := new_row ->> TG_ARGV[0];
    changed    text;
BEGIN
    -- 幂等重放：内容完全一致的 UPDATE 放行（不产生状态推进，也不留版本痕迹）
    IF old_row = new_row THEN
        RETURN NEW;
    END IF;

    -- 终态不可回退：终态行的一切修改都拒绝（结算已完成，内容冻结）
    IF old_status = ANY (terminal_set) THEN
        RAISE EXCEPTION '运行态表 % 的行已处于终态 %：终态不可回退、不可改写（§9.5）',
            TG_TABLE_NAME, old_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- 状态推进必须是显式允许的一条边（终态源已在上面拦下，`*` 只可能命中非终态源）
    IF old_status IS DISTINCT FROM new_status THEN
        IF NOT ((old_status || '>' || new_status) = ANY (transition_set)
                OR ('*>' || new_status) = ANY (transition_set)) THEN
            RAISE EXCEPTION '运行态表 %.% 的非法状态迁移：% → %（§9.5 只允许一次性前向迁移）',
                TG_TABLE_NAME, status_col, old_status, new_status
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    FOR changed IN SELECT jsonb_object_keys(new_row) LOOP
        CONTINUE WHEN changed = status_col;
        CONTINUE WHEN (old_row -> changed) IS NOT DISTINCT FROM (new_row -> changed);
        -- 已结算的行只允许状态列变化（上面已按转换表校验），其余内容一律冻结
        IF old_status = ANY (settled_set) THEN
            RAISE EXCEPTION '运行态表 % 的行已结算（%），列 % 不可再改（§9.5）',
                TG_TABLE_NAME, old_status, changed
                USING ERRCODE = 'restrict_violation';
        END IF;
        CONTINUE WHEN changed = ANY (mutable_cols);
        IF changed = ANY (once_cols) THEN
            -- 注意：列值为 SQL NULL 时 `to_jsonb(row) -> 列` 得到的是 JSON null 而不是 SQL NULL，
            -- 因此必须与 'null'::jsonb 比较；否则「NULL → 值」这种唯一合法的首次写入会被误拒。
            -- 能走到这里说明新旧值已不同，于是「旧值不是 JSON null」等价于「覆盖已写入的值」；
            -- 反向（值 → NULL）同样落在该分支被拒，一次性语义成立。
            IF (old_row -> changed) IS DISTINCT FROM 'null'::jsonb THEN
                RAISE EXCEPTION '运行态表 %.% 是一次性列，不允许覆盖已写入的值（§9.5）',
                    TG_TABLE_NAME, changed
                    USING ERRCODE = 'restrict_violation';
            END IF;
            -- 结算列必须与「进入结算」同事务写入：否则可以在存活期给会话盖上 ended_at、
            -- 给执行中的工具写 exit_code，伪造出「已干净结束」的证据形状（§9.5 只允许结算时写）。
            -- 生命周期列（如会话 started_at、工具 started_at、报告关联）不属于结算列，不受此约束。
            IF changed = ANY (settlement_cols) AND NOT (new_status = ANY (settled_set)) THEN
                RAISE EXCEPTION '运行态表 %.% 是结算列：只能在结算时写入，当前状态 % 未结算（§9.5）',
                    TG_TABLE_NAME, changed, new_status
                    USING ERRCODE = 'restrict_violation';
            END IF;
            CONTINUE;
        END IF;
        RAISE EXCEPTION '运行态表 %.% 是冻结列：首次写入后不可修改（§9.5）',
            TG_TABLE_NAME, changed
            USING ERRCODE = 'restrict_violation';
    END LOOP;

    RETURN NEW;
END;
$$;

-- llm_calls：模型调用无外部副作用。人类中止（abort）记 cancelled；
-- 崩溃后「已受理但没有结束事件」按 §15.2 记 unknown。请求内容（request_header、
-- request_content_hash）与调用标识冻结，响应与用量在结算时一次性写入
-- （这里的一次性列全部是结算列：它们都只随响应一起到达）。
CREATE TRIGGER llm_calls_state_progression
    BEFORE UPDATE ON pentest.llm_calls
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'completed,failed,cancelled,unknown',
        'completed,failed,cancelled,unknown',
        'pending>running,pending>failed,pending>unknown,running>completed,running>failed,running>cancelled,running>unknown',
        'status',
        'finished_at,reasoning_zstd,visible_content_zstd,tool_calls,response_meta,usage,provider_request_id',
        'finished_at,reasoning_zstd,visible_content_zstd,tool_calls,response_meta,usage,provider_request_id'
    );

-- tool_runs：工具有外部副作用，因此**没有 cancelled**——执行中被打断时结果未知，
-- 必须记 unknown 并人工核查，不得当作「已取消」自动重试（§15.3）。
-- 原始内容（arguments_json、normalized_command、policy_decision）冻结。
-- started_at 是生命周期列（认领执行时首次写入），不受「结算时才能写」约束；
-- 输出与结果才是结算列，只能在进入 completed/failed/unknown 的同一次写入里落地。
CREATE TRIGGER tool_runs_state_progression
    BEFORE UPDATE ON pentest.tool_runs
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'completed,failed,unknown',
        'completed,failed,unknown',
        'pending>running,pending>failed,pending>unknown,running>completed,running>failed,running>unknown',
        'status',
        'started_at,finished_at,exit_code,stdout_zstd,stderr_zstd,result_json,artifact_ids',
        'finished_at,exit_code,stdout_zstd,stderr_zstd,result_json,artifact_ids'
    );

-- worker_sessions：§5.1 的会话级状态机。存活态之间可迁移（重做复用、交接草稿、暂停/阻塞），
-- 存活态 → 终态（failed/closed/superseded）一次性；终态不可回退（存活索引也不覆盖终态）。
-- 冻结：阶段、profile/skill/工具允许列表、任务提示词（§11.4「冻结到会话」）。
CREATE TRIGGER worker_sessions_state_progression
    BEFORE UPDATE ON pentest.worker_sessions
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'failed,closed,superseded',
        'failed,closed,superseded',
        'starting>active,'
        'active>waiting_human,active>handoff_drafting,active>paused,active>blocked,'
        'waiting_human>active,waiting_human>handoff_drafting,waiting_human>paused,waiting_human>blocked,'
        'handoff_drafting>transition_confirmation,handoff_drafting>waiting_human,'
        'handoff_drafting>paused,handoff_drafting>blocked,'
        'transition_confirmation>active,transition_confirmation>handoff_drafting,'
        'transition_confirmation>waiting_human,transition_confirmation>paused,'
        'transition_confirmation>blocked,'
        'paused>active,paused>waiting_human,paused>handoff_drafting,'
        'paused>transition_confirmation,paused>blocked,'
        'blocked>active,blocked>waiting_human,blocked>handoff_drafting,'
        'blocked>transition_confirmation,blocked>paused,'
        '*>failed,*>closed,*>superseded',
        'status,status_reason,status_note,status_note_at,status_note_source,'
        'attempt,iteration,scope_version,transition_id,handoff_id,'
        'consumed_tokens,consumed_steps,compacted_through_turn,'
        'budget_max_tokens,budget_max_steps,budget_max_seconds',
        'started_at,ended_at,report_id',
        -- started_at 在会话启动时写入，report_id 在提交报告时写入（waiting_human），
        -- 都不是结算列；只有 ended_at 属于结算，必须与进入终态同一次写入。
        'ended_at'
    );

-- handoffs：草稿 → 编辑 → 批准 → 交付；被取代可发生在任何非终态。
-- draft_json（Agent 原始草稿）冻结——人类修改写在 human_edited_json，这正是两者分列的目的；
-- 批准后（settled）内容全部冻结，只剩状态可继续前向（→ delivered / superseded）。
CREATE TRIGGER handoffs_state_progression
    BEFORE UPDATE ON pentest.handoffs
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'superseded',
        'approved,delivered,rejected,superseded',
        'draft>editing,draft>approved,draft>rejected,editing>approved,editing>rejected,'
        'approved>delivered,*>superseded',
        'status,human_edited_json,approved_to_phase,approved_skill_ids,human_decision_id,'
        'revision,content_hash',
        -- approved_json 在进入 approved（结算态）的同一次写入里落地，属于结算列
        'approved_json',
        'approved_json'
    );

-- outbox_jobs：队列在途。pending → leased（认领），leased → done / dead（结算），
-- leased → pending（租约过期退回重排）。done / dead 是终态：死信不自动重试（§15.3），
-- 需要重试时人工核查后新建任务。
CREATE TRIGGER outbox_jobs_state_progression
    BEFORE UPDATE ON pentest.outbox_jobs
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'done,dead',
        'done,dead',
        'pending>leased,leased>done,leased>dead,leased>pending',
        'status,attempts,available_at,lease_until,last_error',
        '',
        ''
    );

-- session_leases 没有 status 列：它的「状态」是 revoked_at 是否为 NULL，
-- 且续租会不断前推 expires_at，套用通用函数会把合法续租判成回退。因此单独一个函数：
--   冻结列      id / engagement_id / worker_session_id / task_ref / generation / issued_at
--   续租        expires_at、last_heartbeat_at 只允许前推，不允许回退
--   吊销        revoked_at 与 revoked_reason 必须成对，且只能 NULL → 非 NULL 一次
--   终态        已吊销的行不可复活、不可续租、不可改写吊销理由（§10.6 与 worker_sessions 状态对应）
-- revoked_reason 的取值域由 001 的 CHECK 约束保证（与 contracts.ts 的 LeaseRevocationReason 逐字一致），
-- 此处不重复枚举，避免两处取值域漂移。
CREATE OR REPLACE FUNCTION pentest.enforce_lease_settlement() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF to_jsonb(OLD) = to_jsonb(NEW) THEN
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
       OR NEW.worker_session_id IS DISTINCT FROM OLD.worker_session_id
       OR NEW.task_ref IS DISTINCT FROM OLD.task_ref
       OR NEW.generation IS DISTINCT FROM OLD.generation
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
        RAISE EXCEPTION '租约 % 的身份与签发字段在首次写入后冻结（§9.5）', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION '租约 % 已于 % 吊销（%）：吊销是终态，不可续租、复活或改写吊销字段（§10.6）',
            OLD.id, OLD.revoked_at, coalesce(OLD.revoked_reason, '未知理由')
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.revoked_at IS NULL AND NEW.revoked_reason IS NOT NULL THEN
        RAISE EXCEPTION '租约 % 只写了 revoked_reason 而没有 revoked_at：吊销时间与理由必须成对（§10.6）',
            OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND NEW.revoked_reason IS NULL THEN
        RAISE EXCEPTION '租约 % 吊销缺少 revoked_reason：取值域见 001 的 CHECK（§10.6）', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.expires_at < OLD.expires_at THEN
        RAISE EXCEPTION '租约 % 的 expires_at 不得回退（% → %）：续租只允许前推（§10.6）',
            OLD.id, OLD.expires_at, NEW.expires_at
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.last_heartbeat_at < OLD.last_heartbeat_at THEN
        RAISE EXCEPTION '租约 % 的 last_heartbeat_at 不得回退（§10.6）', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER session_leases_settlement
    BEFORE UPDATE ON pentest.session_leases
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_lease_settlement();

-- ───────────────────────────── 授权（GRANT / REVOKE 的显式落点）─────────────────────────────
--
-- 三条原则：
--   1. 运行时角色无 DDL：只授 schema 的 USAGE，不授 CREATE；对象所有权归 pentest_migrator；
--   2. 审计账本只追加：pentest_app 只有 SELECT + INSERT；
--   3. **不授 DELETE**：删除是 §11.5 的人工通道（需要删除决策、加密删除验证与不可变凭证），
--      由 pentest_migrator 执行，不能由运行时/Agent 触发。

GRANT USAGE, CREATE ON SCHEMA pentest TO pentest_migrator;
GRANT USAGE ON SCHEMA pentest TO pentest_app, pentest_worker_ro, pentest_auditor;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA pentest TO pentest_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pentest TO pentest_migrator;

-- A 类：审计账本只追加（触发器是第二道闸）
GRANT SELECT, INSERT ON pentest.context_events, pentest.ledger_anchors,
    pentest.human_decisions, pentest.state_transitions, pentest.memory_access_log
    TO pentest_app;

-- B 类：运行态记录需要在 UPDATE 权限内结算，可更新列由触发器收窄
GRANT SELECT, INSERT, UPDATE ON pentest.llm_calls, pentest.tool_runs, pentest.worker_sessions,
    pentest.session_leases, pentest.outbox_jobs, pentest.handoffs
    TO pentest_app;

-- 其余 engagement 数据：运行时读写（无 DELETE）
GRANT SELECT, INSERT, UPDATE ON pentest.engagements, pentest.scope_versions, pentest.assets,
    pentest.asset_scope_versions, pentest.skills, pentest.worker_reports, pentest.request_snapshots,
    pentest.artifacts, pentest.memory_items, pentest.findings, pentest.memory_chunks,
    pentest.embedding_revisions, pentest.retrieval_queries, pentest.retrieval_hits,
    pentest.approvals, pentest.reports
    TO pentest_app;

-- bigserial 主键的 nextval/currval
GRANT USAGE, SELECT ON SEQUENCE pentest.ledger_anchors_id_seq, pentest.memory_access_log_id_seq,
    pentest.outbox_jobs_id_seq
    TO pentest_app;

-- Worker 侧受限只读：记忆与证据元数据可读，状态与思考链不可读，且不能写任何东西
GRANT SELECT ON pentest.engagements, pentest.scope_versions, pentest.assets,
    pentest.asset_scope_versions, pentest.skills, pentest.memory_items, pentest.memory_chunks,
    pentest.embedding_revisions, pentest.findings, pentest.artifacts,
    pentest.retrieval_queries, pentest.retrieval_hits
    TO pentest_worker_ro;

-- 审计角色：按授权读全量事件，含思考链与原始载荷；同样只读
GRANT SELECT ON pentest.engagements, pentest.scope_versions, pentest.assets,
    pentest.asset_scope_versions, pentest.skills, pentest.worker_sessions, pentest.worker_reports,
    pentest.session_leases, pentest.context_events, pentest.ledger_anchors, pentest.llm_calls,
    pentest.request_snapshots, pentest.tool_runs, pentest.artifacts, pentest.memory_items,
    pentest.findings, pentest.memory_chunks, pentest.embedding_revisions, pentest.retrieval_queries,
    pentest.retrieval_hits, pentest.memory_access_log, pentest.handoffs, pentest.human_decisions,
    pentest.state_transitions, pentest.approvals, pentest.reports, pentest.outbox_jobs
    TO pentest_auditor;

-- 辅助函数对运行时角色显式可执行（RLS 策略表达式由查询角色求值）；
-- 这几个函数是 SECURITY INVOKER 的纯读取/会话变量设置函数，不降权也不提权。
GRANT EXECUTE ON FUNCTION pentest.current_tenant_id(),
    pentest.current_engagement_id(), pentest.current_worker_session_id(),
    pentest.set_rls_context(text, uuid, uuid), pentest.clear_rls_context()
    TO pentest_app, pentest_worker_ro, pentest_auditor;

-- ───────────────────────────── 所有权移交（§9.4）─────────────────────────────
--
-- 「表所有者不得作为运行时角色」的最后一步：把 pentest schema 的全部对象所有权交给
-- pentest_migrator（NOLOGIN、无 CREATEROLE/superuser/BYPASSRLS），运行时角色只是被授权者。
-- 与 FORCE ROW LEVEL SECURITY 配合：即使有人误用所有者连接跑运行时，策略依然生效。
-- 幂等：已属于 pentest_migrator 的对象跳过。
-- 索引与约束的所有权随表迁移；序列需要单独 ALTER SEQUENCE；辅助函数需要 ALTER FUNCTION。
-- 执行前提：迁移连接能 SET ROLE pentest_migrator（标准部署用管理员执行迁移）。

DO $$
DECLARE
    obj record;
BEGIN
    FOR obj IN
        SELECT c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'pentest'
           AND c.relkind IN ('r', 'p', 'S')
           AND pg_get_userbyid(c.relowner) <> 'pentest_migrator'
         ORDER BY c.relname
    LOOP
        IF obj.relkind = 'S' THEN
            EXECUTE format('ALTER SEQUENCE pentest.%I OWNER TO pentest_migrator', obj.relname);
        ELSE
            EXECUTE format('ALTER TABLE pentest.%I OWNER TO pentest_migrator', obj.relname);
        END IF;
    END LOOP;

    -- 函数若仍归执行迁移的管理员，schema 里就存在「非 migrator 拥有」的对象。
    -- 辅助函数都是 SECURITY INVOKER（不降权也不提权），但所有权仍应统一。
    FOR obj IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pentest'
           AND pg_get_userbyid(p.proowner) <> 'pentest_migrator'
         ORDER BY p.proname
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO pentest_migrator', obj.sig);
    END LOOP;
END;
$$;
