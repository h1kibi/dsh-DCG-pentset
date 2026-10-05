-- 010_approval_privilege_binding.sql — approvals creation and resolver tenant hardening
--
-- Runtime code may create only an unresolved pending request. Human decisions remain
-- exclusively in the SECURITY DEFINER resolver, and that resolver is scoped to the
-- transaction-local engagement context for app callers.

CREATE OR REPLACE FUNCTION pentest.enforce_approval_insert() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.decision <> 'pending'
       OR NEW.decided_by IS NOT NULL
       OR NEW.decision_reason IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.consumed_at IS NOT NULL
       OR NEW.consumed_by_tool_run IS NOT NULL THEN
        RAISE EXCEPTION '审批只能以 pending 且无决策/消费见证创建：%', NEW.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approvals_insert_guard ON pentest.approvals;
CREATE TRIGGER approvals_insert_guard
    BEFORE INSERT ON pentest.approvals
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_approval_insert();

ALTER FUNCTION pentest.enforce_approval_insert() OWNER TO pentest_migrator;

DROP POLICY IF EXISTS approvals_migrator_resolve ON pentest.approvals;
CREATE POLICY approvals_migrator_resolve
    ON pentest.approvals
    AS PERMISSIVE FOR UPDATE TO pentest_migrator
    USING (
      engagement_id = pentest.current_engagement_id()
      OR (
        pentest.current_engagement_id() IS NULL
        AND session_user <> 'pentest_app'
        AND current_setting('role', true) IS DISTINCT FROM 'pentest_app'
      )
    )
    WITH CHECK (
      engagement_id = pentest.current_engagement_id()
      OR (
        pentest.current_engagement_id() IS NULL
        AND session_user <> 'pentest_app'
        AND current_setting('role', true) IS DISTINCT FROM 'pentest_app'
      )
    );

DROP POLICY IF EXISTS approvals_migrator_resolve_read ON pentest.approvals;
CREATE POLICY approvals_migrator_resolve_read
    ON pentest.approvals
    AS PERMISSIVE FOR SELECT TO pentest_migrator
    USING (
      engagement_id = pentest.current_engagement_id()
      OR (
        pentest.current_engagement_id() IS NULL
        AND session_user <> 'pentest_app'
        AND current_setting('role', true) IS DISTINCT FROM 'pentest_app'
      )
    );

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
       AND decision = 'pending'
       AND consumed_at IS NULL
       AND (expires_at IS NULL OR expires_at > now());
    IF NOT FOUND THEN
        RAISE EXCEPTION '审批不存在、跨 engagement、已处理、已消费或已过期：%', p_id
            USING ERRCODE = 'restrict_violation';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION pentest.resolve_approval(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pentest.resolve_approval(uuid, text, text, text) TO pentest_app;
ALTER FUNCTION pentest.resolve_approval(uuid, text, text, text) OWNER TO pentest_migrator;
