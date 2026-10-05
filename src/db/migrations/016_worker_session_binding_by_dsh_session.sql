-- 016：按 **dsh 会话标识**解析 Worker 绑定（多作业实例的前提）
--
-- ── 问题 ──
--
-- 工具层拿到的是 dsh 侧身份（`exec.agent.sessionId`，形如 `session-<uuid>`），
-- 而服务层要的是 `worker_sessions.id`。这一步转换此前是一条裸查询：
--
--     select id from pentest.worker_sessions where dsh_session_id = $1
--
-- 015 把 `worker_sessions` 的租户级放行整条拆掉之后，这条查询只有在**已经设好
-- 该会话所属 engagement 的上下文**时才能看见行。而它恰恰是**用来找出那个 engagement
-- 的第一步**——先有鸡后有蛋。
--
-- 单作业部署看不出来：那时 `rlsContext.engagementId` 就是进程锁定的那个作业，
-- 裸查询落在它的上下文里，能查到。多作业之后上下文是租户级（engagement 为 NULL），
-- 行被 RLS 挡住，`resolveWorkerSessionId` 返回 null，工具层于是报
-- 「本会话不是渗透控制台创建的」——**在已经成功 bootstrap 的会话上也这么说**，
-- 把「查不到」说成了「不存在」。实测：`pentest_bootstrap_intake` 成功建单并绑定，
-- 紧随其后的 `memory_search` / `pentest_write_status_note` / `pentest_submit_report`
-- 全部以该错误失败。
--
-- ── 修法 ──
--
-- 与 015 引入 `engagement_for_worker_session` 同一模式：**单点、只读、受租户约束的
-- SECURITY DEFINER 解析函数**。它只回答「这个 dsh 会话属于哪个 Worker 会话与作业」，
-- 拿回 id 之后一切照常走 engagement 上下文的策略。
--
-- 返回两个键（而不是只返回 engagement）：调用方需要 worker_session_id 作为后续
-- 所有服务方法的身份，而这一步之后才有上下文可用。
--
-- 租户约束在函数体内再校验一次：函数是 SECURITY DEFINER（绕过 RLS 读原表），
-- 若只信任当前上下文，它就会变成一条绕过通道。返回 0 行表示「不归你」，
-- 与「不存在」不可区分——调用方据此拒绝，正是想要的 fail-closed。

CREATE OR REPLACE FUNCTION pentest.worker_session_binding_by_dsh(p_dsh_session_id text)
    RETURNS TABLE (worker_session_id uuid, engagement_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pentest, pg_catalog
AS $$
    SELECT ws.id, ws.engagement_id
      FROM pentest.worker_sessions ws
      JOIN pentest.engagements e ON e.id = ws.engagement_id
     WHERE ws.dsh_session_id = p_dsh_session_id
       AND p_dsh_session_id IS NOT NULL
       AND pentest.current_tenant_id() IS NOT NULL
       AND e.tenant_id = pentest.current_tenant_id()
$$;

-- 只读、不接受任意 SQL，且租户不符时恒为 0 行。
GRANT EXECUTE ON FUNCTION pentest.worker_session_binding_by_dsh(text)
    TO pentest_app, pentest_worker_ro, pentest_auditor;
