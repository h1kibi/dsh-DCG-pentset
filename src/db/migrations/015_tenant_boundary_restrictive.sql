-- 015：把「租户边界」与「engagement 边界」分开表达，并堵住 013 引入的跨 engagement 放行。
--
-- ── 013 的缺陷（实测，不是推断）──
--
-- 013 为 session-first 流程在四张表上各加了一条 **PERMISSIVE FOR ALL** 策略
-- `app_tenant_session_first`，条件是 `tenant_id = current_tenant_id()`（或其等价 EXISTS 连接）。
-- PostgreSQL 的 PERMISSIVE 策略之间是 **OR**，而 002 的 `app_engagement` 要求
-- `id = current_engagement_id() AND tenant_id = current_tenant_id()`。两者 OR 之后：
--
--     租户内任意行 ⟺ (id = 当前 engagement ∧ tenant 相同) ∨ (tenant 相同)
--                  = tenant 相同
--
-- 也就是说，**只要租户对得上，engagement 判定就被完全抹掉**。以非超级用户
-- `pentest_app`、上下文设为 engagement A 实测：
--
--     select count(*) from pentest.assets where engagement_id = B   → 看得见 B 的行
--     update pentest.engagements set name='pwned' where id = B      → 成功，1 行
--
-- 影响面覆盖 `engagements` / `worker_sessions` / `session_leases` /
-- `scope_intake_proposals`：会话与**租约**是「谁被授权代表本作业工作」的凭证，
-- 跨 engagement 可读写等于同一租户下的作业之间没有隔离。仅 INSERT 被 WITH CHECK
-- 拦下（42501），读写两条路径都是开的。
--
-- ── 为什么必须用 RESTRICTIVE 而不是再补一条 PERMISSIVE ──
--
-- PERMISSIVE 只能**放宽**——它的语义是「满足任一条即通过」。想用 PERMISSIVE 表达
-- 「再加一层与」，在逻辑上不可能。要表达「无论以后谁再加什么策略，租户边界都必须成立」，
-- 唯一形态是 RESTRICTIVE（AND 语义，且**至少**要求对同一命令存在一条适用的 RESTRICTIVE
-- 策略）。这正是本迁移的核心：租户边界做成 RESTRICTIVE，engagement 边界留在 PERMISSIVE 的
-- `app_engagement` 上；此后任何新增的 PERMISSIVE 策略都只能在同一租户内放宽，跨租户永远不成立。
--
-- ── 那 013 想解决的事怎么办 ──
--
-- 它要解决的是真实的先有鸡后有蛋：浏览器在**知道 engagement id 之前**就要按
-- `client_session_key` 找到自己的作业，而租约相关代码在知道会话 id 之后、知道 engagement 之前
-- 要读 `session_leases`。这两种「按非 engagement 键反查 engagement」的读取**不应该**
-- 靠放宽整张表的策略来实现——那会连带放宽写入。正确形态是**单点、只读、受租户约束**的
-- SECURITY DEFINER 解析函数（与 008 的 `pentest.resolve_approval` 同一模式）：
-- 它只回答「这个键属于哪个 engagement」，拿回 id 之后一切照常走 engagement 上下文的策略。
--
-- ── 与之配套的应用侧改动（同一次交付，缺一不可）──
--
-- 策略收紧后，「先查再设上下文」的顺序必须调整：`openTask` 在反查到/生成 engagement id
-- 之后、读 `worker_sessions` 之前就要设上下文；`session_leases` 的反查改走
-- `engagement_for_worker_session`。否则这些路径会从「越权可读」变成「什么都读不到」。

-- ───────────────────── 1) 拆掉 013 的租户级放行 ─────────────────────

DROP POLICY app_tenant_session_first ON pentest.engagements;
DROP POLICY app_tenant_session_first ON pentest.worker_sessions;
DROP POLICY app_tenant_session_first ON pentest.session_leases;
DROP POLICY app_tenant_session_first ON pentest.scope_intake_proposals;

-- ───────────────────── 2) 租户边界：RESTRICTIVE（不可被放宽）─────────────────────
--
-- `engagements` 自带 tenant_id，直接比较；其余 25 张 engagement 作用域表经它反查。
-- 反查本身受上面那条 RESTRICTIVE 策略约束（子查询以调用者身份执行），不构成绕过点。
--
-- ── 为什么每张有 engagement_id 的表都要有这一条 ──
--
-- 只给 013 碰过的那四张加是不够的：其余表的租户归属是**传递**来的（engagement → tenant），
-- 而 `app_engagement` 只比较 engagement_id。于是当上下文里的 tenant 与 engagement 不配套
-- （配置写错、控制面 bug、连接池残留），目标数据照样读得出来——实测：
--
--     set_rls_context('别的租户', engagement_A) → select from pentest.assets  → 1 行
--
-- 「租户与 engagement 必然配套」是调用方的约定，而 013 的教训正是**不要把边界交给约定**。
-- 加上这一层之后，租户不符的上下文读不到任何行，与 engagement 不符时读不到该作业的行，
-- 两个维度各自独立成立。

CREATE POLICY tenant_boundary ON pentest.engagements
    AS RESTRICTIVE FOR ALL TO pentest_app
    USING (tenant_id = pentest.current_tenant_id())
    WITH CHECK (tenant_id = pentest.current_tenant_id());

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'approvals', 'artifacts', 'asset_scope_versions', 'assets', 'context_events',
        'embedding_revisions', 'findings', 'handoffs', 'human_decisions', 'index_watermarks',
        'ledger_anchors', 'llm_calls', 'memory_access_log', 'memory_chunks', 'memory_items',
        'outbox_jobs', 'reports', 'request_snapshots', 'retrieval_queries',
        'scope_intake_proposals', 'scope_versions', 'session_leases', 'state_transitions',
        'tool_runs', 'worker_reports', 'worker_sessions'
    ] LOOP
        EXECUTE format($f$
            CREATE POLICY tenant_boundary ON pentest.%1$I
                AS RESTRICTIVE FOR ALL TO pentest_app
                USING (EXISTS (
                    SELECT 1 FROM pentest.engagements e
                     WHERE e.id = %1$I.engagement_id
                       AND e.tenant_id = pentest.current_tenant_id()
                ))
                WITH CHECK (EXISTS (
                    SELECT 1 FROM pentest.engagements e
                     WHERE e.id = %1$I.engagement_id
                       AND e.tenant_id = pentest.current_tenant_id()
                ))
        $f$, target);
    END LOOP;
END
$$;

-- ───────────────────── 3) `engagements` 的租户级**只读** ─────────────────────
--
-- 控制台的作业列表（`listEngagements`）与 `openTask` 的反查都必须在本作业之外看到
-- 同租户的 engagement 行——**这是设计要的行为**，不是泄露：engagement 行是操作者自己的
-- 工作项，不含目标数据，而界面的第一步正是「列出我有哪些作业」。
--
-- 但它**只放行 SELECT**：013 的缺陷不是「允许跨作业看列表」，而是「顺手也允许了跨作业写」。
-- INSERT / UPDATE / DELETE 仍然只能落在 `app_engagement` 的当前 engagement 上。
CREATE POLICY app_tenant_read ON pentest.engagements
    AS PERMISSIVE FOR SELECT TO pentest_app
    USING (tenant_id = pentest.current_tenant_id());

-- ───────────────────── 4) 两个受约束的反查函数 ─────────────────────

-- 会话 → engagement。给「知道会话 id、还不知道 engagement」的路径用（租约上下文解析、
-- `#activeLeaseOf`）。只返回一个 uuid：调用方拿到它之后一切照常走 engagement 上下文。
--
-- 租户约束在函数内部再校验一次：函数是 SECURITY DEFINER（绕过 RLS 读原表），
-- 若只信任调用方传参或当前上下文，它会变成一条绕过通道。返回 NULL 表示「不归你」，
-- 与「不存在」不可区分——调用方据此拒绝，正是想要的 fail-closed。
CREATE OR REPLACE FUNCTION pentest.engagement_for_worker_session(p_worker_session_id uuid)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pentest, pg_catalog
AS $$
    SELECT ws.engagement_id
      FROM pentest.worker_sessions ws
      JOIN pentest.engagements e ON e.id = ws.engagement_id
     WHERE ws.id = p_worker_session_id
       AND pentest.current_tenant_id() IS NOT NULL
       AND e.tenant_id = pentest.current_tenant_id()
$$;

-- (tenant, client_session_key) → engagement。给 session-first 的开场反查用。
-- 与 `engagements_tenant_client_session` 的部分唯一索引同一判据，因此至多一行。
CREATE OR REPLACE FUNCTION pentest.engagement_for_client_session(
    p_tenant_id text,
    p_client_session_key text
)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pentest, pg_catalog
AS $$
    SELECT e.id
      FROM pentest.engagements e
     WHERE e.tenant_id = p_tenant_id
       AND e.client_session_key = p_client_session_key
       AND pentest.current_tenant_id() IS NOT NULL
       AND p_tenant_id = pentest.current_tenant_id()
$$;

-- 两个函数都不改数据、不接受任意 SQL，只回答「这个键属于哪个 engagement」。
-- 租户不是当前上下文时一律 NULL（见函数体的 IS NOT NULL 与等值比较）。
GRANT EXECUTE ON FUNCTION pentest.engagement_for_worker_session(uuid)
    TO pentest_app, pentest_worker_ro, pentest_auditor;
GRANT EXECUTE ON FUNCTION pentest.engagement_for_client_session(text, text)
    TO pentest_app, pentest_worker_ro, pentest_auditor;
