-- 026_skill_freeze.sql — 会话装载集合的**内容**冻结
--
-- 事故（2026-10-05）：`worker_sessions.skill_ids` 只冻结**名字**，而 `loadSkill`
-- 每次读当前行——会话运行中技能的正文/描述可被替换（人类审批时看到的指令文本
-- 与实际执行的可以不同），停用还会反向破坏历史会话的加载。名字不是契约，正文才是。
--
-- 本迁移为会话增加内容冻结列：
--
--     skill_freeze = [{name, revision, contentHash}, ...]
--
-- 读取侧据此发现漂移并**阻塞**；旧会话该列为空数组（默认），读取侧回退到既有语义。
ALTER TABLE pentest.worker_sessions
    ADD COLUMN IF NOT EXISTS skill_freeze jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN pentest.worker_sessions.skill_freeze IS
    '创建会话时冻结的技能内容三元组（name/revision/contentHash）；空数组=旧会话，读取侧不校验内容（§10.x）';
