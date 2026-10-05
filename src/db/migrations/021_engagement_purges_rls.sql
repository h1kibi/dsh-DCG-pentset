-- 021_engagement_purges_rls.sql — 新表接入 RLS 与租户边界
--
-- `019` 建的 `engagement_purges` 漏了 002/015 对所有 engagement 相关表的两条要求：
--   * ENABLE + **FORCE** ROW LEVEL SECURITY；
--   * 一条 **RESTRICTIVE** 的租户边界策略（`test/rls-isolation.test.ts` 会在每张带
--     `engagement_id`/`tenant_id` 的表上检查这一条——它的价值正在于「新表漏了会红」）。
--
-- 少了它，非超级用户（`pentest_app`）写销毁记录时没有边界策略约束；补上之后，
-- 运行时角色只能写「当前租户 + 当前 engagement」的记录（管理路径是超级用户，不受影响）。

ALTER TABLE pentest.engagement_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.engagement_purges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_boundary ON pentest.engagement_purges;
CREATE POLICY tenant_boundary ON pentest.engagement_purges
    AS RESTRICTIVE FOR ALL TO pentest_app
    USING (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = engagement_purges.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = engagement_purges.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ));
