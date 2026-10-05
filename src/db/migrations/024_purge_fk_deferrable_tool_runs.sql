-- 024_purge_fk_deferrable_tool_runs.sql — 外键环的另一半（023 的续）
--
-- 023 把 `approvals.consumed_by_tool_run → tool_runs` 设为可延迟后，清空仍会在
-- **另一条边**上失败：`tool_runs.approval_id → approvals`（约束名 `tool_runs_approval_fk`）。
-- 环的两条边都得可延迟，同一事务里的两条 DELETE 才能真正互相解环。
-- 2026-10-05 实测：只延迟一条边时，仍有 4 个作业清不掉，报
-- `23503 update or delete on table "approvals" violates foreign key constraint
--  "tool_runs_approval_fk" on table "tool_runs"`。
--
-- 同样只动约束：默认 INITIALLY IMMEDIATE，日常写入的即时校验强度不变；
-- 只有清空事务里显式的 `set constraints all deferred` 才会推迟到 COMMIT 校验。

alter table pentest.tool_runs drop constraint tool_runs_approval_fk;

alter table pentest.tool_runs add constraint tool_runs_approval_fk
  foreign key (approval_id) references pentest.approvals(id) deferrable initially immediate;
