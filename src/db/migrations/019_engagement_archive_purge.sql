-- 019_engagement_archive_purge.sql — 作业清理：归档（默认）与彻底删除（显式两步）
--
-- 为什么需要它：个人环境里作业会越攒越多（向导建的、Agent 引导建的「未命名任务 …」、
-- 失败的、自检用的），列表噪声大、库也在长。但**审计要求这些行仍在库里**（§9.2），
-- 因此清理分两级：
--
--   1. **归档**（`archived_at`）：默认列表隐藏，**一个字节都不删**，可随时取消归档。
--   2. **彻底删除**：只对**已归档**的作业开放，且必须由人类输入作业名确认；执行时
--      拒绝有活会话/活租约的作业。删除顺序按外键依赖（全部 NO ACTION，没有级联）。
--
-- 销毁本身必须在**独立于被删作业**的表里留痕：那一行如果挂在被删作业上，
-- 会连同它一起消失——审计上等于「这场作业从未存在过」，而真相是「有人删了它」。

alter table pentest.engagements
  add column if not exists archived_at timestamptz;

comment on column pentest.engagements.archived_at is
  '归档时间：非空即从默认列表隐藏；不删除任何数据（审计要求，§9.2）';

create index if not exists engagements_archived
  on pentest.engagements (archived_at)
  where archived_at is not null;

create table if not exists pentest.engagement_purges (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null,
  engagement_name text not null,
  operator_id text not null,
  reason text,
  deleted_counts jsonb not null,
  purged_at timestamptz not null default now()
);

comment on table pentest.engagement_purges is
  '作业销毁记录：独立于被删作业，删除动作本身的唯一证据';

create index if not exists engagement_purges_time
  on pentest.engagement_purges (purged_at desc);

grant select, insert on pentest.engagement_purges to pentest_app;
grant select, insert, delete on pentest.engagement_purges to pentest_migrator;
