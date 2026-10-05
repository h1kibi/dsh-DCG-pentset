-- 025_approval_revocable.sql — approved(未消费) → revoked 的人类撤回通道
--
-- 事故（2026-10-05）：UI 对 `approved` 且未消费的凭证给出「撤销」按钮，并写明
-- 「撤销后凭证立即失效，Agent 的后续调用会被拒」；但 service、resolver、触发器
-- 三层都只认 `pending`，人类对自己刚批准、Agent 还没用的凭证没有任何撤回通道。
--
-- 本迁移只增加一条显式受保护的边：
--
--     approved + consumed_at IS NULL + 未过期  --(人类 revoke)-->  revoked
--
-- 其余语义全部保持：
--   * 已消费的凭证不可撤销（消费见证不可覆盖，§16.1.1）；
--   * pending 的结算规则、superseded 的受保护 GUC 通道不变（011 的行为原样保留）；
--   * 撤销必须写入新的决策见证（decided_by / decision_reason / decided_at），
--     且不得触碰消费列——消费只属于执行侧的一次性消费路径（§10.3.1）。

CREATE OR REPLACE FUNCTION pentest.enforce_approval_update() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.decision <> 'pending' THEN
        IF OLD.decision = 'approved' AND NEW.decision = 'revoked' AND OLD.consumed_at IS NULL THEN
            -- 人类撤回一张尚未使用的放行凭证：允许改写决策见证，但必须成对写入。
            IF NEW.decided_by IS NULL OR NEW.decision_reason IS NULL OR NEW.decided_at IS NULL THEN
                RAISE EXCEPTION '审批 % 的撤销必须同时写入 decided_by、decision_reason、decided_at', OLD.id
                    USING ERRCODE = 'not_null_violation';
            END IF;
            IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_tool_run IS NOT NULL THEN
                RAISE EXCEPTION '审批 % 的撤销不得写入消费见证（消费只属于执行侧）', OLD.id
                    USING ERRCODE = 'restrict_violation';
            END IF;
        ELSE
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
        END IF;
    ELSIF NEW.decision = 'pending' AND (
        NEW.decided_by IS NOT NULL OR NEW.decision_reason IS NOT NULL OR NEW.decided_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION '审批 % 在 pending 状态不能伪造人类决策见证', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.decision = 'pending' AND NEW.decision NOT IN ('approved', 'rejected', 'revoked', 'superseded') THEN
        RAISE EXCEPTION '审批 % 只能从 pending 由人类入口推进，实际为 %', OLD.id, NEW.decision
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.decision = 'pending' AND NEW.decision = 'superseded'
       AND current_setting('pentest.approval_supersede', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION '审批 % 的 superseded 只能由受保护替代函数写入', OLD.id
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
ALTER FUNCTION pentest.enforce_approval_update() OWNER TO pentest_migrator;

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
     WHERE id = p_id
       AND (
         engagement_id = pentest.current_engagement_id()
         OR (
           pentest.current_engagement_id() IS NULL
           AND session_user <> 'pentest_app'
           AND current_setting('role', true) IS DISTINCT FROM 'pentest_app'
         )
       )
       AND consumed_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         decision = 'pending'
         -- 撤回一张**尚未消费**的已批准凭证（§10.3.1 放行队列可撤销）。
         OR (p_decision = 'revoked' AND decision = 'approved')
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION '审批不存在、跨 engagement、已处理、已消费或已过期：%', p_id
            USING ERRCODE = 'restrict_violation';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION pentest.resolve_approval(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pentest.resolve_approval(uuid, text, text, text) TO pentest_app;
ALTER FUNCTION pentest.resolve_approval(uuid, text, text, text) OWNER TO pentest_migrator;
