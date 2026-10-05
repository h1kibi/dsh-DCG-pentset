-- 022_engagement_purges_owner.sql — 属主归位
--
-- 002 的库级不变量：**全部业务表与序列归 `pentest_migrator`**（`test/db.test.ts` 会检查，
-- 新表漏了就会红）。`019` 建 `engagement_purges` 时没有显式改属主，迁移连接（postgres）
-- 成了它的 owner——这里补上。

ALTER TABLE pentest.engagement_purges OWNER TO pentest_migrator;
