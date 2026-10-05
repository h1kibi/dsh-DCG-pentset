-- 009_approval_resolver_rls.sql — allow the SECURITY DEFINER resolver to see approval rows
--
-- 008 added an UPDATE policy for pentest_migrator, but approvals is FORCE RLS.
-- PostgreSQL still needs a SELECT policy when the UPDATE target is resolved by a
-- WHERE clause; without it the resolver sees zero rows and every decision fails.

CREATE POLICY approvals_migrator_resolve_read
    ON pentest.approvals
    AS PERMISSIVE FOR SELECT TO pentest_migrator
    USING (true);
