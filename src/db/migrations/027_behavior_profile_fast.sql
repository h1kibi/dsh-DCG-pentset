-- 027_behavior_profile_fast.sql — 行为预设词汇表 `deep` → `fast`
--
-- 事故（2026-10-09，由 `test/pg-workflow.test.ts` 的「审批模式：运行中可切」用例抓到）：
-- 迁移 017 把 `behavior_profile` 的取值域钉成 `('stealth','standard','deep','custom')`，
-- 而契约的 `BEHAVIOR_PROFILES` 随后把这一档改名为 `fast`（语义也从「深度测试」改为
-- 「快速评估 / 时间受限」）。**代码与库的词汇表分叉**，后果是创建作业直接失败：
--
--     new row for relation "engagements" violates check constraint "engagements_behavior_profile_check"
--
-- 错误只报约束名、不报合法取值；而 `npm run typecheck` 与全部门禁都是绿的——两边各自自洽。
--
-- ── 两张表要分开对待（这是本迁移最容易做错的地方）──
--
-- `pentest.engagements.behavior_profile` 是**可变现值**，必须落成代码能解释的词汇：
-- 保留 `deep` 不是「更忠实」，而是让这个作业的行为指引**静默消失**——
-- `BehaviorBriefOf` 与 `expandBehaviorProfile` 对未知预设分别返回 `undefined` / 抛错。
-- 因此这一列改名，随后按新词汇表收紧 CHECK。
--
-- `pentest.policy_versions` 是**A 类只追加表**（§9.5，触发器 `policy_versions_append_only`
-- 拒绝对已提交行的 UPDATE/DELETE），历史行里的 `deep` 是当时的事实，不能改写。
-- 因此这一张表**只放宽** CHECK（加上 `fast`），并把 `deep` 标注为历史词汇：
-- 旧行照旧可读（读路径对未知预设返回 undefined，即「没有行为指引」，不炸），
-- 而写入路径只可能写新词汇（写入方取的是 `engagements.behavior_profile`）。
--
-- 顺序：先放开旧约束 → 改可变表的数据 → 装回新约束。直接换约束会被存量 `deep` 行挡住。

-- ① 放开旧的 CHECK（`IF EXISTS`：inline CHECK 的约束名由 Postgres 自动生成，
--    依赖建表语句的写法，别的环境上可能不叫这个名字——找不到就跳过，别中断迁移）。
ALTER TABLE pentest.engagements
    DROP CONSTRAINT IF EXISTS engagements_behavior_profile_check;
ALTER TABLE pentest.policy_versions
    DROP CONSTRAINT IF EXISTS policy_versions_behavior_profile_check;

-- ② 可变现值改名（只动 `engagements`；`policy_versions` 是只追加表，UDPATE 会被触发器拒绝）。
UPDATE pentest.engagements
   SET behavior_profile = 'fast'
 WHERE behavior_profile = 'deep';

-- ③ 装回 CHECK：当前值只认新词汇表（与 `contracts.ts` 的 `BEHAVIOR_PROFILES` 逐字一致）。
ALTER TABLE pentest.engagements
    ADD CONSTRAINT engagements_behavior_profile_check
        CHECK (behavior_profile IN ('stealth','standard','fast','custom'));

-- ④ 历史表：新词汇 + 历史词汇（`deep` 只可能来自 017 到本迁移之间的已提交行）。
ALTER TABLE pentest.policy_versions
    ADD CONSTRAINT policy_versions_behavior_profile_check
        CHECK (behavior_profile IN ('stealth','standard','fast','deep','custom'));

COMMENT ON COLUMN pentest.engagements.behavior_profile IS
    '行为预设（契约 BEHAVIOR_PROFILES：stealth/standard/fast/custom）；2026-10-09 由 deep 改名 fast';
COMMENT ON COLUMN pentest.policy_versions.behavior_profile IS
    '策略版本冻结的预设名；只追加表，`deep` 是 2026-10-09 更名前的历史词汇（读路径按未知值处理，不给行为指引）';
