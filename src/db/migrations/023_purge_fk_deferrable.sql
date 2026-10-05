-- 023_purge_fk_deferrable.sql — 让清空能解开 approvals ↔ tool_runs 的外键环
--
-- 两表互指：`approvals.consumed_by_tool_run → tool_runs.id`，
-- `tool_runs.approval_id → approvals.id`。清空（020 的第二级语义）需要把两张表里的行都删掉，
-- 而**两边都被守卫触发器锁死**，谁都先改不动：
--   · 审批：`消费见证不可覆盖` / `只能从 pending 由人类入口推进`（008 / 011）——那是凭证语义，不该开口子；
--   · 工具运行：`终态不可回退、不可改写`（§9.5）。
-- 2026-10-05 实测后果：带已消费审批的作业**永远清不掉**（人类在界面上只看到「内部错误」）。
--
-- 解法只动约束，不动任何守卫：把审批一侧的外键设为**可延迟**，于是清空事务里
-- `set constraints ... deferred` 之后，两条 DELETE 可以在同一事务中互相解环，
-- 约束在 COMMIT 时才校验——那时两边的行都已消失。默认仍是 INITIALLY IMMEDIATE，
-- 日常写入的即时校验强度不变。

alter table pentest.approvals drop constraint approvals_consumed_by_tool_run_fkey;

alter table pentest.approvals add constraint approvals_consumed_by_tool_run_fkey
  foreign key (consumed_by_tool_run) references pentest.tool_runs(id) deferrable initially immediate;
