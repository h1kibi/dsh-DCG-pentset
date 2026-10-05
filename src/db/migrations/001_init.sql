-- 001_init.sql — DeepSeek Harness 渗透测试插件初始表结构
--
-- 权威来源：docs/dsh-pentest-plugin-design.md §9.1（版本与扩展）、
--           §9.2（表结构）、§9.3（索引）。
--
-- 迁移规则（§9.1）：
--   表结构版本单调递增、逐级向前迁移；旧版本代码遇到更新的库必须响亮拒绝并停止启动。
--   本文件只做向前迁移，不回滚；回滚策略由部署侧按版本三元分离原则单独设计。
--
-- 语句顺序约束：PostgreSQL 要求被 REFERENCES 引用的表先存在。
--   因此表体内只内联「引用已定义表」的外键；所有前向引用（含自引用延迟外键）
--   统一用文件后半与文末的 ALTER TABLE ... ADD CONSTRAINT 后置添加（§9.2 采用的方式）。
--
-- 注意：本文件由 migrate.ts 按语句逐条执行；每条语句都必须能独立解析。

-- ───────────────────────────── §9.1 扩展与 schema ─────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS pentest;

-- ───────────────────────────── §9.2 表结构 ─────────────────────────────

CREATE TABLE pentest.engagements (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               text NOT NULL,
    name                    text NOT NULL,
    -- status：正交运行标记，唯一落点
    status                  text NOT NULL CHECK (status IN
                              ('running','paused','blocked','aborted','failed')),
    -- current_status：主状态，取值与 §5.1 完全一致
    current_status          text NOT NULL CHECK (current_status IN
                              ('auth_pending','ready','worker_running','waiting_human_review',
                               'handoff_drafting','transition_confirmation','report_ready','complete')),
    current_phase           text,
    state_version           bigint NOT NULL DEFAULT 0,
    graph_iteration         integer NOT NULL DEFAULT 1,
    active_agent_session_id uuid,
    target_snapshot         jsonb NOT NULL,
    scope_snapshot          jsonb NOT NULL,
    roe_snapshot            jsonb NOT NULL,
    policy_snapshot         jsonb NOT NULL,
    config_snapshot         jsonb NOT NULL,
    created_by              text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.scope_versions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    version           integer NOT NULL,
    iteration         integer NOT NULL,
    targets           jsonb NOT NULL,
    exclusions        jsonb NOT NULL,
    authorization_ref text,
    amendment_reason  text,
    changed_by        text NOT NULL,
    human_decision_id uuid,
    content_hash      text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (engagement_id, version)
);

-- scope_versions 在 human_decisions 之前定义，外键用 ALTER TABLE 后置添加
-- （PostgreSQL 要求被引用表先存在）

CREATE TABLE pentest.assets (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id         uuid NOT NULL REFERENCES pentest.engagements(id),
    canonical_target      text NOT NULL,
    kind                  text NOT NULL CHECK (kind IN
                            ('domain','ip','cidr','url','service','cloud-resource',
                             'repository','host','other')),
    labels                jsonb NOT NULL DEFAULT '[]',
    first_seen_iteration  integer NOT NULL,
    discovered_in_session_id uuid,
    discovered_from_asset_id uuid REFERENCES pentest.assets(id),
    evidence_refs         uuid[] NOT NULL DEFAULT '{}',
    metadata              jsonb NOT NULL DEFAULT '{}',
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (engagement_id, canonical_target, kind)
);

-- 资产与范围版本的决策关系：范围过滤的判定依据
CREATE TABLE pentest.asset_scope_versions (
    asset_id          uuid NOT NULL REFERENCES pentest.assets(id),
    scope_version     integer NOT NULL,
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    decision          text NOT NULL CHECK (decision IN ('included','excluded','pending')),
    decided_by        text,
    human_decision_id uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, scope_version)
);

CREATE TABLE pentest.skills (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL UNIQUE,
    description    text NOT NULL,
    body           text NOT NULL,
    content_hash   text NOT NULL,
    added_by       text NOT NULL,
    revision       integer NOT NULL DEFAULT 1,
    disabled       boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.worker_sessions (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id             uuid NOT NULL REFERENCES pentest.engagements(id),
    dsh_session_id            text NOT NULL UNIQUE,
    previous_agent_session_id uuid REFERENCES pentest.worker_sessions(id),
    retry_of_session_id       uuid REFERENCES pentest.worker_sessions(id),
    transition_id             uuid,
    phase                     text NOT NULL CHECK (phase IN
                                ('intelligence-gathering','threat-modeling',
                                 'vulnerability-analysis','exploitation','post-exploitation')),
    profile_id                text NOT NULL,
    profile_revision          text NOT NULL,
    attempt                   integer NOT NULL DEFAULT 1,
    iteration                 integer NOT NULL DEFAULT 1,
    scope_version             integer NOT NULL DEFAULT 1,
    task_prompt               text NOT NULL,
    handoff_id                uuid,
    tool_filter               jsonb NOT NULL,
    skill_ids                 jsonb NOT NULL DEFAULT '[]',
    model_route               jsonb NOT NULL,
    status                    text NOT NULL CHECK (status IN
                                ('starting','active','waiting_human','handoff_drafting',
                                 'transition_confirmation','paused','blocked','failed',
                                 'closed','superseded')),
    status_reason             text,
    status_note               text,
    status_note_at            timestamptz,
    status_note_source        text CHECK (status_note_source IN ('agent','derived')),
    budget_max_tokens         bigint,
    budget_max_steps          integer,
    budget_max_seconds        integer,
    consumed_tokens           bigint NOT NULL DEFAULT 0,
    consumed_steps            integer NOT NULL DEFAULT 0,
    compacted_through_turn    bigint,
    started_at                timestamptz,
    ended_at                  timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.worker_reports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    attempt           integer NOT NULL,
    iteration         integer NOT NULL,
    status            text NOT NULL CHECK (status IN ('report_ready','blocked')),
    objective         text NOT NULL,
    summary           text NOT NULL,
    payload_json      jsonb NOT NULL,
    content_hash      text NOT NULL,
    supersedes_id     uuid,
    superseded_by     uuid,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- 取代关系是双向的，两条边都指向同一张表内的其它行。
-- 由于取代需要「先让位、后插入」，前向引用必须延迟到事务提交时校验，
-- 因此这两个外键声明为 DEFERRABLE INITIALLY DEFERRED。
ALTER TABLE pentest.worker_reports
    ADD CONSTRAINT worker_reports_supersedes_fk
    FOREIGN KEY (supersedes_id) REFERENCES pentest.worker_reports(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE pentest.worker_reports
    ADD CONSTRAINT worker_reports_superseded_by_fk
    FOREIGN KEY (superseded_by) REFERENCES pentest.worker_reports(id)
    DEFERRABLE INITIALLY DEFERRED;

-- 每个会话每个执行轮次只有一份当前报告；被取代的历史版本让出唯一位。
-- 取代是双向记录：新行写 supersedes_id（取代了谁），旧行写 superseded_by（被谁取代），
-- 使审计可以从任一方向追溯。
CREATE UNIQUE INDEX worker_reports_current
    ON pentest.worker_reports (worker_session_id, attempt)
    WHERE superseded_by IS NULL;

-- 注：worker_sessions 不持有 `report_id` 指针。当前报告由部分唯一索引
-- `worker_reports_current (worker_session_id, attempt) WHERE superseded_by IS NULL`
-- 唯一确定；若再加一列指向 worker_reports.id，它会与
-- `worker_reports.worker_session_id` 构成外键环，使报告与会话永久不可删除
-- （§11.5 保留了人工发起的例外删除通道，环会堵死它）。

CREATE TABLE pentest.session_leases (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    task_ref          text,
    generation        integer NOT NULL DEFAULT 1,
    issued_at         timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    revoked_at        timestamptz,
    -- 取值域必须与 contracts.ts 的 LeaseRevocationReason 保持一致（不多不少）：
    -- superseded 有意替换、closed 会话关闭、failed 会话失败、human_revoke 人工吊销、
    -- expired 到期未续由 expireLeases 清扫写入（§10.6；缺 expired 会让清扫必然撞 CHECK）。
    -- 没有 budget_exhausted：预算耗尽只是暂停，租约保留，不吊销。
    revoked_reason    text CHECK (revoked_reason IN
                        ('superseded','closed','failed','human_revoke','expired')),
    UNIQUE (worker_session_id, generation)
);

-- 一个会话同时只有一份未吊销租约
CREATE UNIQUE INDEX session_leases_one_active
    ON pentest.session_leases (worker_session_id)
    WHERE revoked_at IS NULL;

ALTER TABLE pentest.engagements
    ADD CONSTRAINT engagements_active_session_fk
    FOREIGN KEY (active_agent_session_id) REFERENCES pentest.worker_sessions(id);

CREATE TABLE pentest.context_events (
    event_id            uuid NOT NULL DEFAULT gen_random_uuid(),
    engagement_id       uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id   uuid REFERENCES pentest.worker_sessions(id),
    dsh_session_id      text,
    source_system       text NOT NULL,
    source_id           text NOT NULL,
    source_seq          bigint NOT NULL,
    event_type          text NOT NULL,
    schema_version      integer NOT NULL,
    occurred_at         timestamptz NOT NULL,
    ingested_at         timestamptz NOT NULL DEFAULT now(),
    chain_seq           bigint NOT NULL,
    payload_json        jsonb,
    raw_payload_zstd    bytea NOT NULL,
    -- text_projection 恒为 NULL：检索文本只存在于 memory_chunks.content。
    -- 运行时角色对本表无 UPDATE 权限（§9.5 审计账本类），索引器无法回填该列。
    text_projection     text,
    classification      text NOT NULL,
    trust_level         text NOT NULL,
    provisional         boolean NOT NULL DEFAULT false,
    prev_hash           bytea,
    event_hash          bytea NOT NULL,
    PRIMARY KEY (event_id),
    UNIQUE (engagement_id, source_system, source_id, source_seq),
    UNIQUE (engagement_id, chain_seq)
);

-- 审计锚点：每批追加后写入链头摘要与事件计数（§9.5）。
-- 事件计数是检测尾部截断的核心——只有摘要无法发现链尾被删。
-- 运行时角色只有 INSERT / SELECT，无 UPDATE / DELETE。
-- 「计数严格递增」由 ledger.ts 在事务内校验，不依赖数据库触发器。
CREATE TABLE pentest.ledger_anchors (
    id              bigserial PRIMARY KEY,
    engagement_id   uuid NOT NULL REFERENCES pentest.engagements(id),
    chain_head      bytea NOT NULL,
    event_count     bigint NOT NULL,
    batch_from_seq  bigint NOT NULL,
    batch_to_seq    bigint NOT NULL,
    batch_signature bytea NOT NULL,
    signed_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (batch_to_seq >= batch_from_seq)
);

CREATE TABLE pentest.llm_calls (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id        uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id    uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    dsh_turn             bigint,
    dsh_step             bigint,
    provider             text NOT NULL,
    model                text NOT NULL,
    request_header       jsonb NOT NULL,
    request_content_hash text NOT NULL,
    reasoning_zstd       bytea,
    visible_content_zstd bytea,
    tool_calls           jsonb,
    response_meta        jsonb,
    usage                jsonb,
    status               text NOT NULL,
    provider_request_id  text,
    started_at           timestamptz NOT NULL,
    finished_at          timestamptz,
    UNIQUE (worker_session_id, dsh_turn, dsh_step)
);

-- 工作上下文快照：记录某次请求实际发出的内容，使 P7「可复现」有落点
CREATE TABLE pentest.request_snapshots (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    llm_call_id       uuid REFERENCES pentest.llm_calls(id),
    dsh_turn          bigint,
    dsh_step          bigint,
    assembler_version text NOT NULL,
    assembled_zstd    bytea NOT NULL,
    context_refs      jsonb NOT NULL DEFAULT '[]',
    truncated_refs    jsonb NOT NULL DEFAULT '[]',
    recall_query_ids  uuid[] NOT NULL DEFAULT '{}',
    budget_snapshot   jsonb NOT NULL DEFAULT '{}',
    content_hash      text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (worker_session_id, dsh_turn, dsh_step)
);

CREATE TABLE pentest.tool_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id      uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id  uuid REFERENCES pentest.worker_sessions(id),
    llm_call_id        uuid REFERENCES pentest.llm_calls(id),
    idempotency_key    text NOT NULL,
    tool_name          text NOT NULL,
    action_class       text NOT NULL,
    target_selector    jsonb,
    normalized_command jsonb,
    arguments_json     jsonb NOT NULL,
    approval_id        uuid,
    policy_decision    jsonb NOT NULL,
    stdout_zstd        bytea,
    stderr_zstd        bytea,
    exit_code          integer,
    result_json        jsonb,
    artifact_ids       uuid[],
    status             text NOT NULL,
    started_at         timestamptz,
    finished_at        timestamptz,
    UNIQUE (engagement_id, idempotency_key)
);

CREATE TABLE pentest.artifacts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id      uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id  uuid REFERENCES pentest.worker_sessions(id),
    tool_run_id        uuid REFERENCES pentest.tool_runs(id),
    kind               text NOT NULL,
    media_type         text NOT NULL,
    byte_size          bigint NOT NULL,
    storage_kind       text NOT NULL CHECK (storage_kind IN ('file','inline')),
    storage_path       text,
    inline_content     bytea,
    content_hash       text NOT NULL,
    encrypted          boolean NOT NULL DEFAULT true,
    encryption_key_ref text,
    classification     text NOT NULL,
    truncated          boolean NOT NULL DEFAULT false,
    source_ref         text,
    metadata           jsonb NOT NULL DEFAULT '{}',
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK ((storage_kind = 'file') = (storage_path IS NOT NULL)),
    CHECK ((storage_kind = 'inline') = (inline_content IS NOT NULL))
);

CREATE TABLE pentest.memory_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id       uuid NOT NULL REFERENCES pentest.engagements(id),
    kind                text NOT NULL,
    title               text,
    content             text NOT NULL,
    trust_level         text NOT NULL,
    confidence          numeric(5,4),
    status              text NOT NULL,
    source_event_ids    uuid[] NOT NULL DEFAULT '{}',
    source_artifact_ids uuid[] NOT NULL DEFAULT '{}',
    metadata            jsonb NOT NULL DEFAULT '{}',
    valid_at            timestamptz,
    supersedes_id       uuid REFERENCES pentest.memory_items(id),
    created_by          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.findings (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id            uuid NOT NULL REFERENCES pentest.engagements(id),
    discovered_in_session_id uuid REFERENCES pentest.worker_sessions(id),
    origin_memory_item_id    uuid REFERENCES pentest.memory_items(id),
    title                    text NOT NULL,
    severity                 text CHECK (severity IN ('critical','high','medium','low','info')),
    status                   text NOT NULL CHECK (status IN
                               ('candidate','validation_pending','validated','rejected',
                                'human_accepted','superseded')),
    affected_asset_ids       uuid[] NOT NULL DEFAULT '{}',
    evidence_refs            uuid[] NOT NULL DEFAULT '{}',
    reproduction_steps       jsonb NOT NULL DEFAULT '[]',
    impact                   text,
    remediation              text,
    confidence               numeric(5,4),
    accepted_by              text,
    accepted_at              timestamptz,
    supersedes_id            uuid REFERENCES pentest.findings(id),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.memory_chunks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id      uuid NOT NULL REFERENCES pentest.engagements(id),
    memory_item_id     uuid REFERENCES pentest.memory_items(id),
    source_event_id    uuid REFERENCES pentest.context_events(event_id),
    ordinal            integer NOT NULL,
    content            text NOT NULL,
    content_hash       text NOT NULL,
    search_vector      tsvector,
    embedding_model    text,
    embedding_revision text,
    embedding          vector(1024),
    phase              text,
    worker_session_id  uuid REFERENCES pentest.worker_sessions(id),
    -- 范围过滤的实现依据：分块归属的资产与结论
    asset_ids          uuid[] NOT NULL DEFAULT '{}',
    finding_ids        uuid[] NOT NULL DEFAULT '{}',
    trust_level        text NOT NULL,
    classification     text NOT NULL,
    provisional        boolean NOT NULL DEFAULT false,
    superseded_by_revision text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK ((memory_item_id IS NOT NULL) <> (source_event_id IS NOT NULL)),
    -- 帧分块与结算分块的区别：结算分块 embedding_revision 非空
    CHECK (provisional OR embedding_revision IS NOT NULL)
);

-- 当前生效的嵌入版本；检索强制按它过滤，避免跨版本向量比较
CREATE TABLE pentest.embedding_revisions (
    engagement_id  uuid NOT NULL REFERENCES pentest.engagements(id),
    revision       text NOT NULL,
    model          text NOT NULL,
    dimensions     integer NOT NULL,
    is_active      boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (engagement_id, revision)
);

-- 每个 engagement 至多一个生效版本
CREATE UNIQUE INDEX embedding_revisions_one_active
    ON pentest.embedding_revisions (engagement_id)
    WHERE is_active;

CREATE TABLE pentest.retrieval_queries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id uuid REFERENCES pentest.worker_sessions(id),
    origin            text NOT NULL CHECK (origin IN ('worker','console','replay')),
    operator_id       text,
    query_text        text NOT NULL,
    filters           jsonb NOT NULL,
    include_reasoning boolean,
    limit_requested   integer NOT NULL,
    embedding_model   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (origin <> 'worker' OR worker_session_id IS NOT NULL),
    CHECK (origin <> 'console' OR operator_id IS NOT NULL)
);

CREATE TABLE pentest.retrieval_hits (
    query_id          uuid NOT NULL REFERENCES pentest.retrieval_queries(id),
    rank              integer NOT NULL,
    chunk_id          uuid NOT NULL REFERENCES pentest.memory_chunks(id),
    semantic_score    numeric,
    lexical_score     numeric,
    final_score       numeric NOT NULL,
    returned_excerpt  text NOT NULL,
    PRIMARY KEY (query_id, rank)
);

CREATE TABLE pentest.memory_access_log (
    id                bigserial PRIMARY KEY,
    engagement_id     uuid NOT NULL REFERENCES pentest.engagements(id),
    worker_session_id uuid,
    operator_id       text,
    access_kind       text NOT NULL,
    subject_refs      uuid[] NOT NULL,
    reason            text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.handoffs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id          uuid NOT NULL REFERENCES pentest.engagements(id),
    from_worker_session_id uuid NOT NULL REFERENCES pentest.worker_sessions(id),
    transition_type        text NOT NULL CHECK (transition_type IN ('advance','retry','loop','rollback')),
    forced                 boolean NOT NULL DEFAULT false,
    suggested_to_phase     text,
    suggested_skill_ids    jsonb NOT NULL DEFAULT '[]',
    approved_to_phase      text,
    approved_skill_ids     jsonb NOT NULL DEFAULT '[]',
    draft_json             jsonb NOT NULL,
    human_edited_json      jsonb,
    approved_json          jsonb,
    context_refs           jsonb NOT NULL DEFAULT '[]',
    excluded_refs          jsonb NOT NULL DEFAULT '[]',
    truncated_refs         jsonb NOT NULL DEFAULT '[]',
    human_decision_id      uuid,
    revision               integer NOT NULL DEFAULT 1,
    content_hash           text NOT NULL,
    status                 text NOT NULL CHECK (status IN
                             ('draft','editing','approved','delivered','rejected','superseded')),
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.human_decisions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id  uuid NOT NULL REFERENCES pentest.engagements(id),
    operator_id    text NOT NULL,
    decision_type  text NOT NULL,
    subject_id     text NOT NULL,
    decision       text NOT NULL,
    reason         text NOT NULL,
    edited_payload jsonb,
    auth_context   jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pentest.state_transitions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id          uuid NOT NULL REFERENCES pentest.engagements(id),
    from_phase             text,
    to_phase               text,
    from_status            text NOT NULL,
    to_status              text NOT NULL,
    transition_type        text NOT NULL CHECK (transition_type IN
                             ('start','advance','retry','rollback','loop','interject_wake',
                              'handoff_cancel','handoff_regen','report_reopen',
                              'pause','resume','abort','complete')),
    forced                 boolean NOT NULL DEFAULT false,
    session_reused         boolean NOT NULL DEFAULT false,
    graph_iteration        integer NOT NULL DEFAULT 1,
    from_scope_version     integer,
    to_scope_version       integer,
    from_worker_session_id uuid,
    to_worker_session_id   uuid,
    expected_version       bigint NOT NULL,
    resulting_version      bigint NOT NULL,
    human_decision_id      uuid NOT NULL REFERENCES pentest.human_decisions(id),
    handoff_id             uuid REFERENCES pentest.handoffs(id),
    reason                 text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (engagement_id, resulting_version)
);

CREATE TABLE pentest.approvals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id       uuid NOT NULL REFERENCES pentest.engagements(id),
    requested_by_worker uuid REFERENCES pentest.worker_sessions(id),
    action_class        text NOT NULL,
    target_snapshot     jsonb NOT NULL,
    command_plan        jsonb NOT NULL,
    plan_hash           text NOT NULL,
    risk_summary        text NOT NULL,
    decision            text NOT NULL CHECK (decision IN
                          ('pending','approved','rejected','expired','revoked','superseded')),
    decided_by          text,
    decision_reason     text,
    lease_generation    integer,
    consumed_at         timestamptz,
    consumed_by_tool_run uuid REFERENCES pentest.tool_runs(id),
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    decided_at          timestamptz
);

-- 一次性消费：同一凭证只能被一个工具执行消费
ALTER TABLE pentest.tool_runs
    ADD CONSTRAINT tool_runs_approval_fk
    FOREIGN KEY (approval_id) REFERENCES pentest.approvals(id);

CREATE UNIQUE INDEX approvals_single_consumption
    ON pentest.approvals (consumed_by_tool_run)
    WHERE consumed_by_tool_run IS NOT NULL;

CREATE TABLE pentest.reports (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id       uuid NOT NULL REFERENCES pentest.engagements(id),
    version             integer NOT NULL,
    projection_json     jsonb NOT NULL,
    edited_content      text,
    accepted_finding_ids uuid[] NOT NULL DEFAULT '{}',
    signed_by           text,
    signed_at           timestamptz,
    content_hash        text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (engagement_id, version)
);

CREATE TABLE pentest.outbox_jobs (
    id              bigserial PRIMARY KEY,
    engagement_id   uuid NOT NULL REFERENCES pentest.engagements(id),
    job_type        text NOT NULL,
    entity_id       uuid NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    status          text NOT NULL CHECK (status IN ('pending','leased','done','dead')),
    attempts        integer NOT NULL DEFAULT 0,
    available_at    timestamptz NOT NULL DEFAULT now(),
    lease_until     timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- 后置外键：目标表在引用处之后才定义，统一放在全部 CREATE TABLE 之后
-- （PostgreSQL 要求被引用表先存在，因此不能在表体内内联声明）

ALTER TABLE pentest.assets
    ADD CONSTRAINT assets_discovered_session_fk
    FOREIGN KEY (discovered_in_session_id) REFERENCES pentest.worker_sessions(id);

ALTER TABLE pentest.scope_versions
    ADD CONSTRAINT scope_versions_decision_fk
    FOREIGN KEY (human_decision_id) REFERENCES pentest.human_decisions(id);

ALTER TABLE pentest.handoffs
    ADD CONSTRAINT handoffs_decision_fk
    FOREIGN KEY (human_decision_id) REFERENCES pentest.human_decisions(id);

-- ───────────────────────────── §9.3 索引 ─────────────────────────────

CREATE INDEX context_events_engagement_time
    ON pentest.context_events (engagement_id, occurred_at, event_type);

CREATE INDEX ledger_anchors_latest
    ON pentest.ledger_anchors (engagement_id, id DESC);

CREATE INDEX worker_sessions_engagement_phase
    ON pentest.worker_sessions (engagement_id, phase, created_at);

CREATE INDEX memory_items_engagement_kind
    ON pentest.memory_items (engagement_id, kind, status, created_at);

CREATE INDEX memory_chunks_search_vector
    ON pentest.memory_chunks USING gin (search_vector);

CREATE INDEX memory_chunks_content_trgm
    ON pentest.memory_chunks USING gin (content gin_trgm_ops);

CREATE INDEX memory_chunks_embedding_hnsw
    ON pentest.memory_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

-- 一个 engagement 同时只能有一个存活会话：唯一性约束，不是普通索引
-- 覆盖全部非终态：终态为 closed / superseded / failed
CREATE UNIQUE INDEX worker_sessions_one_live_per_engagement
    ON pentest.worker_sessions (engagement_id)
    WHERE status IN ('starting','active','waiting_human','handoff_drafting',
                     'transition_confirmation','paused','blocked');

CREATE INDEX worker_reports_session
    ON pentest.worker_reports (worker_session_id, attempt);

CREATE INDEX findings_engagement_status
    ON pentest.findings (engagement_id, status, severity);

CREATE INDEX artifacts_engagement
    ON pentest.artifacts (engagement_id, created_at);

CREATE INDEX scope_versions_engagement
    ON pentest.scope_versions (engagement_id, version DESC);

CREATE INDEX skills_enabled
    ON pentest.skills (disabled, name)
    WHERE disabled = false;

CREATE UNIQUE INDEX memory_chunks_event_unique
    ON pentest.memory_chunks (source_event_id, ordinal, embedding_revision)
    WHERE source_event_id IS NOT NULL;

CREATE UNIQUE INDEX memory_chunks_item_unique
    ON pentest.memory_chunks (memory_item_id, ordinal, embedding_revision)
    WHERE memory_item_id IS NOT NULL;

CREATE INDEX memory_chunks_asset_ids
    ON pentest.memory_chunks USING gin (asset_ids);

CREATE INDEX memory_chunks_finding_ids
    ON pentest.memory_chunks USING gin (finding_ids);

CREATE INDEX assets_engagement_kind
    ON pentest.assets (engagement_id, kind, canonical_target);

CREATE INDEX asset_scope_versions_lookup
    ON pentest.asset_scope_versions (engagement_id, scope_version, decision);

CREATE INDEX session_leases_expiry
    ON pentest.session_leases (expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX outbox_claimable
    ON pentest.outbox_jobs (status, available_at, id);
