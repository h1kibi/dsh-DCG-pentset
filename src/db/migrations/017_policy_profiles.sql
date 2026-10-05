-- 017：策略预设、完整快照与只追加策略版本
--
-- 只增加新列/新表，不修改已发布迁移。旧 engagement 使用 migration 来源回填，
-- 不伪造历史的人类 profile 选择；新建路径由工作流写入真实 profile 与快照哈希。

ALTER TABLE pentest.engagements
    ADD COLUMN IF NOT EXISTS scope_entry_profile text NOT NULL DEFAULT 'custom'
        CHECK (scope_entry_profile IN ('ip','domain','cidr','custom')),
    ADD COLUMN IF NOT EXISTS behavior_profile text NOT NULL DEFAULT 'stealth'
        CHECK (behavior_profile IN ('stealth','standard','deep','custom')),
    ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 1
        CHECK (policy_version > 0),
    ADD COLUMN IF NOT EXISTS policy_snapshot_hash text NOT NULL DEFAULT 'sha256:legacy'
        CHECK (policy_snapshot_hash <> ''),
    ADD COLUMN IF NOT EXISTS authorization_confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS authorization_confirmed_by text;

CREATE TABLE IF NOT EXISTS pentest.policy_versions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engagement_id         uuid NOT NULL REFERENCES pentest.engagements(id),
    version               integer NOT NULL CHECK (version > 0),
    scope_entry_profile   text NOT NULL CHECK (scope_entry_profile IN ('ip','domain','cidr','custom')),
    behavior_profile      text NOT NULL CHECK (behavior_profile IN ('stealth','standard','deep','custom')),
    policy_snapshot       jsonb NOT NULL,
    content_hash          text NOT NULL CHECK (content_hash <> ''),
    policy_epoch          bigint NOT NULL CHECK (policy_epoch >= 0),
    changed_by            text NOT NULL,
    human_decision_id     uuid,
    amendment_reason      text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (engagement_id, version)
    -- 刻意**没有** UNIQUE(engagement_id, content_hash)：`policy_epoch` 每次范围/策略变更都递增，
    -- 于是「重新确认同一份范围」这样的合法动作会产生内容相同、epoch 不同的新版本。
    -- 内容哈希在这里是**可复核性**的证据，不是身份；身份是 (engagement_id, version)。
);

-- 为已有数据建立可回放的 legacy 版本；来源明确是迁移，不代表历史人类选择。
-- 原始策略被**原样保存在 `policy_snapshot` 字段内**（旧行只有 `{...}` 或
-- `{"approval_required":[...]}` 这类通用投影），外层是版本行，`legacy: true` 标明来源。
INSERT INTO pentest.policy_versions
    (engagement_id, version, scope_entry_profile, behavior_profile, policy_snapshot,
     content_hash, policy_epoch, changed_by, amendment_reason)
SELECT e.id,
       1,
       e.scope_entry_profile,
       e.behavior_profile,
       jsonb_build_object(
           'profile', e.behavior_profile,
           'profile_version', 1,
           'scope_entry', e.scope_entry_profile,
           'legacy', true,
           'policy_snapshot', e.policy_snapshot
       ),
       'sha256:' || encode(
           digest(
               convert_to(
                   jsonb_build_object(
                       'profile', e.behavior_profile,
                       'profile_version', 1,
                       'scope_entry', e.scope_entry_profile,
                       'legacy', true,
                       'policy_snapshot', e.policy_snapshot
                   )::text,
                   'UTF8'
               ),
               'sha256'
           ),
           'hex'
       ),
       e.policy_epoch,
       'migration',
       '017 legacy policy projection backfill'
  FROM pentest.engagements e
ON CONFLICT (engagement_id, version) DO NOTHING;

UPDATE pentest.engagements e
   SET policy_snapshot = p.policy_snapshot,
       policy_snapshot_hash = p.content_hash
  FROM pentest.policy_versions p
 WHERE p.engagement_id = e.id
   AND p.version = e.policy_version
   AND e.policy_snapshot_hash = 'sha256:legacy';

CREATE INDEX IF NOT EXISTS policy_versions_engagement_created
    ON pentest.policy_versions (engagement_id, version DESC, created_at DESC);

COMMENT ON TABLE pentest.policy_versions IS
    'Immutable policy snapshots. engagements.policy_snapshot is only the current projection.';
COMMENT ON COLUMN pentest.engagements.policy_snapshot_hash IS
    'SHA-256 of the complete canonical policy snapshot, including normalized scope and exclusions.';
