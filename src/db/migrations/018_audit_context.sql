-- 018：策略版本与审计读取的隔离、权限和索引
--
-- 策略/执行/访问事实仍进入 context_events；本迁移不创建平行审计事实表。

ALTER TABLE pentest.policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.policy_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_engagement ON pentest.policy_versions;
CREATE POLICY app_engagement ON pentest.policy_versions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());

DROP POLICY IF EXISTS readonly_engagement ON pentest.policy_versions;
CREATE POLICY readonly_engagement ON pentest.policy_versions
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

-- 租户边界用 RESTRICTIVE（与 015 给另外 26 张表加的那一条同形）。
--
-- 为什么不靠 `app_engagement` 就够：它只比较 `engagement_id = current_engagement_id()`，
-- 而那两个 GUC 是可以被任意角色设置的会话变量。015 已经把「租户与 engagement 必然配套」
-- 这条**约定**换成了数据库层的与（`AS RESTRICTIVE`），新表必须一起跟上——
-- 否则新表就成了同一租户边界里唯一可以「上下文写错也读得到」的缺口。
CREATE POLICY tenant_boundary ON pentest.policy_versions
    AS RESTRICTIVE FOR ALL TO pentest_app
    USING (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = policy_versions.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = policy_versions.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ));

-- 策略版本与人类/系统事实只追加；修订通过新版本和 context_events 表达。
CREATE OR REPLACE FUNCTION pentest.reject_policy_version_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'policy_versions 只允许追加，不能更新或删除已记录策略版本（§9.5）'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS policy_versions_append_only ON pentest.policy_versions;
CREATE TRIGGER policy_versions_append_only
    BEFORE UPDATE OR DELETE ON pentest.policy_versions
    FOR EACH ROW EXECUTE FUNCTION pentest.reject_policy_version_mutation();

GRANT SELECT, INSERT ON pentest.policy_versions TO pentest_app;
GRANT SELECT ON pentest.policy_versions TO pentest_worker_ro, pentest_auditor;
GRANT EXECUTE ON FUNCTION pentest.reject_policy_version_mutation() TO pentest_migrator;

ALTER TABLE pentest.context_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.context_events FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS context_events_audit_accessed
    ON pentest.context_events (engagement_id, occurred_at, chain_seq)
    WHERE event_type IN ('audit.accessed','memory.access');
CREATE INDEX IF NOT EXISTS context_events_policy_execution
    ON pentest.context_events (engagement_id, occurred_at, chain_seq)
    WHERE event_type IN (
        'policy.profile.selected','policy.snapshot.previewed','policy.snapshot.confirmed',
        'policy.snapshot.frozen','policy.snapshot.amended','policy.epoch.advanced',
        'execution.policy.checked','execution.pacing.applied','execution.detection_signal',
        'execution.stopped'
    );

DO $$
DECLARE
    obj record;
BEGIN
    FOR obj IN
        SELECT c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'pentest'
           AND c.relname = 'policy_versions'
           AND c.relkind IN ('r', 'p')
           AND pg_get_userbyid(c.relowner) <> 'pentest_migrator'
    LOOP
        EXECUTE format('ALTER TABLE pentest.%I OWNER TO pentest_migrator', obj.relname);
    END LOOP;
    FOR obj IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pentest'
           AND p.proname = 'reject_policy_version_mutation'
           AND pg_get_userbyid(p.proowner) <> 'pentest_migrator'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO pentest_migrator', obj.sig);
    END LOOP;
END;
$$;
