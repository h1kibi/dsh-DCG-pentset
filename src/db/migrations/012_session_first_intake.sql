-- 012_session_first_intake.sql — session-first intake and scope confirmation
--
-- The engagement remains the durable security aggregate, but the browser opens a
-- task by client session key.  An intake Worker has no target capability and may
-- only submit a scope proposal.  A human confirmation creates scope version 1 and
-- the first phase Worker.

ALTER TABLE pentest.engagements
    ADD COLUMN client_session_key text;

CREATE UNIQUE INDEX engagements_tenant_client_session
    ON pentest.engagements (tenant_id, client_session_key)
    WHERE client_session_key IS NOT NULL;

ALTER TABLE pentest.worker_sessions
    ADD COLUMN session_kind text NOT NULL DEFAULT 'phase'
        CHECK (session_kind IN ('intake', 'phase'));

CREATE TABLE pentest.scope_intake_proposals (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id         uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id     uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    objective             text NOT NULL,
    proposed_targets      jsonb NOT NULL,
    proposed_exclusions   jsonb NOT NULL DEFAULT '[]',
    proposed_allowed_actions jsonb NOT NULL DEFAULT '[]',
    authorization_note    text NOT NULL DEFAULT '',
    status                text NOT NULL CHECK (status IN ('pending','confirmed','rejected','superseded')),
    human_decision_id     uuid REFERENCES pentest.human_decisions(id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    decided_at            timestamptz
);

CREATE INDEX scope_intake_proposals_engagement_created
    ON pentest.scope_intake_proposals (engagement_id, created_at DESC);

CREATE UNIQUE INDEX scope_intake_proposals_one_pending
    ON pentest.scope_intake_proposals (engagement_id)
    WHERE status = 'pending';

ALTER TABLE pentest.scope_intake_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pentest.scope_intake_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY app_engagement ON pentest.scope_intake_proposals
    AS PERMISSIVE FOR ALL TO pentest_app
    USING (engagement_id = pentest.current_engagement_id())
    WITH CHECK (engagement_id = pentest.current_engagement_id());
CREATE POLICY readonly_engagement ON pentest.scope_intake_proposals
    AS PERMISSIVE FOR SELECT TO pentest_worker_ro, pentest_auditor
    USING (engagement_id = pentest.current_engagement_id());

CREATE TRIGGER scope_intake_proposals_state_progression
    BEFORE UPDATE ON pentest.scope_intake_proposals
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'confirmed,rejected,superseded',
        'confirmed,rejected,superseded',
        'pending>confirmed,pending>rejected,pending>superseded',
        'status',
        'human_decision_id,decided_at',
        'human_decision_id,decided_at'
    );

GRANT SELECT, INSERT, UPDATE ON pentest.scope_intake_proposals TO pentest_app;
GRANT SELECT ON pentest.scope_intake_proposals TO pentest_auditor;

ALTER TABLE pentest.scope_intake_proposals OWNER TO pentest_migrator;

