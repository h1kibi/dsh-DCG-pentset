-- 013_session_first_tenant_policies.sql — tenant-scoped workflow lookup for session-first UI
--
-- The browser opens a task before it knows the hidden engagement id.  Keep the
-- tenant boundary enforced by FORCE RLS while allowing the application role to
-- locate rows belonging to its configured tenant.  All writes and target-facing
-- reads still use the engagement-specific context once the id is known.

CREATE POLICY app_tenant_session_first ON pentest.engagements
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (tenant_id = pentest.current_tenant_id())
    WITH CHECK (tenant_id = pentest.current_tenant_id());

CREATE POLICY app_tenant_session_first ON pentest.worker_sessions
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = worker_sessions.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = worker_sessions.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ));

CREATE POLICY app_tenant_session_first ON pentest.session_leases
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = session_leases.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = session_leases.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ));

CREATE POLICY app_tenant_session_first ON pentest.scope_intake_proposals
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = scope_intake_proposals.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM pentest.engagements e
         WHERE e.id = scope_intake_proposals.engagement_id
           AND e.tenant_id = pentest.current_tenant_id()
    ));
