-- 020_engagement_purge_content.sql — 清理第二级：**清空内容，保留审计骨架**
--
-- 为什么不是「删掉整个作业」：§9.5 规定审计账本表只允许追加
-- （`context_events` / `human_decisions` / `state_transitions` / `ledger_anchors` /
-- `memory_access_log`，以及 018 的 `policy_versions`），触发器会拒绝任何 DELETE——
-- 而它们都引用 `engagements`，因此作业行本身也**不能**删。
--
-- 于是第二级的语义是：**内容清零 + 审计壳保留 + 记一行销毁记录**。空间收益来自可删的
-- 那几张大表（memory_chunks / memory_items / llm_calls / tool_runs / artifacts / …），
-- 保留的是每场作业都必然存在、且体量很小的审计骨架。
--
-- `purged_at` 非空 = 内容已清空（不可逆）；它与 `archived_at` 一起决定列表里的显示。

alter table pentest.engagements
  add column if not exists purged_at timestamptz;

comment on column pentest.engagements.purged_at is
  '内容清空时间（清理第二级，不可逆）；审计账本行按 §9.5 保留，作业行随之保留';
