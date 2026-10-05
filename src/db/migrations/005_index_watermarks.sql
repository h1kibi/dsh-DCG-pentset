-- 005：索引水位与索引状态
--
-- 设计依据：docs/dsh-pentest-plugin-design.md §8.4（Streaming RAG 管线）、
-- §15.5（索引滞后）、§14.2（指标）
--
-- 为什么需要它：
--
-- 索引器按事件账本增量推进，必须知道「已索引到哪」。这个水位有三个用途：
--   1. 重启后从水位继续，而不是全量重扫（§15.5「可按事件水位重建」）；
--   2. 向 Agent 与人类显示「检索可能遗漏尚未索引的事件」（§8.4 明确要求）；
--   3. 作为一致性检查的基准：水位与 `context_events` 的最大 chain_seq 之差
--      就是滞后量。
--
-- **水位是派生数据，不是事实源**。原始账本（`context_events`）永远是唯一事实源，
-- 水位丢了大不了重扫。因此这张表允许 UPDATE（它有明确的状态推进语义），
-- 与只追加的审计账本表是两类（§9.5 的两类表划分）。

CREATE TABLE pentest.index_watermarks (
    engagement_id  uuid PRIMARY KEY REFERENCES pentest.engagements(id),
    -- 已索引到的账本链序号。0 表示尚未索引任何事件。
    last_chain_seq bigint NOT NULL DEFAULT 0,
    -- 已索引到的最后事件时间，供控制台显示时间范围（§8.4）。
    indexed_through_occurred_at timestamptz,
    -- 索引状态：就绪 / 滞后 / 失败（§15.5「单独展示为就绪、滞后或失败」）
    status         text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','lagging','failed')),
    last_error     text,
    -- 索引策略版本。策略变更（分块方式、脱敏规则）时应重建，此列用于识别
    -- 哪些 engagement 的索引是按旧策略生成的（§9.1 的版本分离原则）。
    strategy_version text NOT NULL DEFAULT 'index-v1',
    updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pentest.index_watermarks IS
    '索引水位（§8.4）。派生数据非事实源：可安全删除并从 context_events 重建。允许 UPDATE（有状态推进语义），与只追加的审计账本表不同类。';

-- 落后水位查询：控制台需要按滞后量列出需要关注的 engagement
CREATE INDEX index_watermarks_status
    ON pentest.index_watermarks (status, updated_at)
    WHERE status <> 'ready';

-- ───────────────────────────── 所有权 ─────────────────────────────
--
-- 002 在末尾把所有对象所有权移交给 `pentest_migrator`，但它只覆盖**那时已存在**
-- 的对象；005 在它之后运行，因此必须自己做同样的事——否则本表归执行迁移的管理员
-- 所有，而 §9.4 要求业务对象归 `pentest_migrator`（运行时角色 `pentest_app`
-- 非所有者，才受 RLS 约束）。
--
-- 用 DO 块而非直接 `ALTER TABLE ... OWNER TO`：角色不存在时给出可执行提示，
-- 而不是在中途以一句 "role does not exist" 失败。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pentest_migrator') THEN
        RAISE EXCEPTION
            '角色 pentest_migrator 不存在：请先执行 002_security.sql（它负责建角色），或手工建好角色后重跑本迁移';
    END IF;
    EXECUTE 'ALTER TABLE pentest.index_watermarks OWNER TO pentest_migrator';
END
$$;
