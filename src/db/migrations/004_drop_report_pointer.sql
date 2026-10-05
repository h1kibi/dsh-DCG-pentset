-- 004：移除 worker_sessions.report_id
--
-- 设计依据：docs/dsh-pentest-plugin-design.md §9.5、§11.5
--
-- 为什么删这一列：它与 `worker_reports.worker_session_id` 形成**外键环**，
-- 而它在 002 的 `once_cols` 里（NULL → 值只能一次，不能回到 NULL）：
--
--   worker_sessions.report_id      → worker_reports.id
--   worker_reports.worker_session_id → worker_sessions.id   (NOT NULL)
--
-- 要删掉一个会话及其报告，必须先断开环的一侧。两侧都断不掉：
-- report_id 回不到 NULL（触发器拒绝），worker_session_id 是 NOT NULL。
-- 结果是**报告与会话永久不可删除**——而 §11.5 明确保留一条人工发起的删除通道
-- （用于例外情形，例如误将真实凭据或个人信息写入记忆）。这条通道被环堵死了。
--
-- 为什么不需要这一列：当前报告已由部分唯一索引唯一确定：
--   worker_reports_current ON (worker_session_id, attempt) WHERE superseded_by IS NULL
-- 指针是冗余的反规范化，且没有任何代码写入它（唯一提及是「不要写」的注释）。
--
-- 本迁移同时重建 worker_sessions 的状态推进触发器，把 report_id 从 once_cols 里去掉——
-- 保留一个指向已删列的 TG_ARGV 参数会让后人误以为该列仍存在。

BEGIN;

-- 1) 先摘掉引用它的触发器，再删列
DROP TRIGGER IF EXISTS worker_sessions_state_progression ON pentest.worker_sessions;

-- 2) 断开外键并删除列
ALTER TABLE pentest.worker_sessions
    DROP CONSTRAINT IF EXISTS worker_sessions_report_fk;
ALTER TABLE pentest.worker_sessions
    DROP COLUMN IF EXISTS report_id;

-- 3) 重建触发器（与 002 的定义一致，仅 once_cols 去掉 report_id）
CREATE TRIGGER worker_sessions_state_progression
    BEFORE UPDATE ON pentest.worker_sessions
    FOR EACH ROW EXECUTE FUNCTION pentest.enforce_state_progression(
        'status',
        'failed,closed,superseded',
        'failed,closed,superseded',
        'starting>active,'
        'active>waiting_human,active>handoff_drafting,active>paused,active>blocked,'
        'waiting_human>active,waiting_human>handoff_drafting,waiting_human>paused,waiting_human>blocked,'
        'handoff_drafting>transition_confirmation,handoff_drafting>waiting_human,'
        'handoff_drafting>paused,handoff_drafting>blocked,'
        'transition_confirmation>active,transition_confirmation>handoff_drafting,'
        'transition_confirmation>waiting_human,transition_confirmation>paused,'
        'transition_confirmation>blocked,'
        'paused>active,paused>waiting_human,paused>handoff_drafting,'
        'paused>transition_confirmation,paused>blocked,'
        'blocked>active,blocked>waiting_human,blocked>handoff_drafting,'
        'blocked>transition_confirmation,blocked>paused,'
        '*>failed,*>closed,*>superseded',
        'status,status_reason,status_note,status_note_at,status_note_source,'
        'attempt,iteration,scope_version,transition_id,handoff_id,'
        'consumed_tokens,consumed_steps,compacted_through_turn,'
        'budget_max_tokens,budget_max_steps,budget_max_seconds',
        'started_at,ended_at',
        -- started_at 在会话启动时写入；ended_at 是结算列，必须与进入终态同一次写入。
        'ended_at'
    );

COMMENT ON TABLE pentest.worker_reports IS
    '当前报告由 worker_reports_current 部分唯一索引确定（worker_session_id, attempt, superseded_by IS NULL）；worker_sessions 不再持有冗余指针（004 移除，以免与 worker_session_id 构成不可解的外键环）。';

COMMIT;
