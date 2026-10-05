-- 008_gate_hardening.sql — approvals 状态与消费写入收窄（设计文档 §10.3.1、§16.1.1）
--
-- approvals 不是只追加表：人类入口必须把 pending 推进到 approved/rejected/revoked，
-- 执行服务还必须一次性写入消费列。因此这里使用列级保护触发器，而不是禁止全部 UPDATE。

CREATE OR REPLACE FUNCTION pentest.enforce_approval_update() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.decision <> 'pending' THEN
        IF NEW.decision IS DISTINCT FROM OLD.decision THEN
            RAISE EXCEPTION '审批 % 已从 pending 结算为 %，决策不可回退或覆盖（§16.1.1）', OLD.id, OLD.decision
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.decided_by IS DISTINCT FROM NEW.decided_by
           OR OLD.decision_reason IS DISTINCT FROM NEW.decision_reason
           OR OLD.decided_at IS DISTINCT FROM NEW.decided_at THEN
            RAISE EXCEPTION '审批 % 的人类决策见证不可覆盖（§16.1.1）', OLD.id
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.consumed_at IS NOT NULL AND (
            NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.consumed_by_tool_run IS DISTINCT FROM OLD.consumed_by_tool_run
        ) THEN
            RAISE EXCEPTION '审批 % 已消费，消费见证不可覆盖（§10.3.1）', OLD.id
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW.decision = 'pending' AND (
        NEW.decided_by IS NOT NULL OR NEW.decision_reason IS NOT NULL OR NEW.decided_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION '审批 % 在 pending 状态不能伪造人类决策见证', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.decision = 'pending' AND NEW.decision NOT IN ('approved', 'rejected', 'revoked') THEN
        RAISE EXCEPTION '审批 % 只能从 pending 由人类入口推进到 approved/rejected/revoked，实际为 %', OLD.id, NEW.decision
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.decision = 'pending' AND NEW.decision IS DISTINCT FROM OLD.decision THEN
        IF NEW.decided_by IS NULL OR NEW.decision_reason IS NULL OR NEW.decided_at IS NULL THEN
            RAISE EXCEPTION '审批 % 的人类决策必须同时写入 decided_by、decision_reason、decided_at', OLD.id
                USING ERRCODE = 'not_null_violation';
        END IF;
    END IF;

    IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
        IF NEW.consumed_by_tool_run IS NULL OR NEW.decision <> 'approved' THEN
            RAISE EXCEPTION '审批 % 只能由 approved 凭证写入一次性消费见证', OLD.id
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION '审批 % 的 consumed_at 不允许清空', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.consumed_by_tool_run IS NULL AND NEW.consumed_by_tool_run IS NOT NULL
       AND NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION '审批 % 的 consumed_by_tool_run 必须与 consumed_at 一起写入', OLD.id
            USING ERRCODE = 'restrict_violation';
    ELSIF OLD.consumed_by_tool_run IS NOT NULL
          AND NEW.consumed_by_tool_run IS DISTINCT FROM OLD.consumed_by_tool_run THEN
        RAISE EXCEPTION '审批 % 的 consumed_by_tool_run 不允许覆盖', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- 审批负载、租约世代与创建信息是人类看到并批准的冻结快照。
    IF NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
       OR NEW.requested_by_worker IS DISTINCT FROM OLD.requested_by_worker
       OR NEW.action_class IS DISTINCT FROM OLD.action_class
       OR NEW.target_snapshot IS DISTINCT FROM OLD.target_snapshot
       OR NEW.command_plan IS DISTINCT FROM OLD.command_plan
       OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
       OR NEW.risk_summary IS DISTINCT FROM OLD.risk_summary
       OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION '审批 % 的批准负载与绑定列冻结，不允许改写（§10.3.1）', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE POLICY approvals_migrator_resolve
    ON pentest.approvals
    AS PERMISSIVE FOR UPDATE TO pentest_migrator
    USING (true)
    WITH CHECK (true);

CREATE TRIGGER approvals_update_guard
    BEFORE UPDATE ON pentest.approvals
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_approval_update();

ALTER FUNCTION pentest.enforce_approval_update() OWNER TO pentest_migrator;

-- 审批决策只允许工作流入口使用；执行侧消费只写两列。
REVOKE UPDATE ON pentest.approvals FROM pentest_app;
GRANT UPDATE (consumed_at, consumed_by_tool_run) ON pentest.approvals TO pentest_app;

-- 由迁移角色执行的人类工作流连接通过 SECURITY DEFINER 函数写决策，函数内部仍受
-- 上述触发器约束。运行时角色不能直接取得 decision 的列权限。
CREATE OR REPLACE FUNCTION pentest.resolve_approval(
    p_id uuid,
    p_decision text,
    p_operator text,
    p_reason text
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pentest, pg_catalog
AS $$
BEGIN
    IF p_decision NOT IN ('approved', 'rejected', 'revoked') THEN
        RAISE EXCEPTION '非法审批决策：%', p_decision USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE pentest.approvals
       SET decision = p_decision,
           decided_by = p_operator,
           decision_reason = p_reason,
           decided_at = now()
     WHERE id = p_id AND decision = 'pending' AND consumed_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION '审批不存在、已处理或已消费：%', p_id USING ERRCODE = 'restrict_violation';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION pentest.resolve_approval(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pentest.resolve_approval(uuid, text, text, text) TO pentest_app;
ALTER FUNCTION pentest.resolve_approval(uuid, text, text, text) OWNER TO pentest_migrator;
