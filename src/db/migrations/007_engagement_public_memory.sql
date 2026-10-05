-- 007：engagement 公共记忆（所有 Agent 的公共规则与记忆）
--
-- 设计依据：docs/dsh-pentest-plugin-design.md §8.1（记忆分层）、§7.4（新会话上下文注入）
--
-- ── 这是什么 ──
--
-- 每个 engagement 一段**人类可编辑的文本**，作为该作业下所有 Agent 的公共规则与记忆。
-- 它随每次创建会话被注入系统提示词，因此「这个作业的规矩」不必在每个任务提示词里重复。
--
-- 与既有记忆机制的分工：
--   - `memory_chunks` / `memory_items`：Agent 产出的事实与证据，**只追加**、可检索；
--   - 公共记忆：人类写的**指令与共识**，可直接改写，不参与检索排序。
--
-- 两者不能合并：公共记忆会被注入每一次会话的提示词，若它混在可检索的事实流里，
-- 「哪些内容会被无条件注入」就变得不可预测——而那正是需要它稳定可靠的原因。
--
-- ── 为什么加列而不是建表 ──
--
-- 它严格是「每 engagement 一条、可空、就地改写」，没有历史版本需求（改动本身由
-- `human_decisions` 与账本留痕）。建表要多一套 RLS/GRANT/自检，换不来任何东西。
-- RLS 与 GRANT 也已覆盖 `engagements`（002），新列自动继承表级策略。
--
-- ── 为什么不用 `config_snapshot` 之类的既有 jsonb ──
--
-- `config_snapshot` 全仓没有任何读取点（它只被写）。把公共记忆塞进一个
-- 「谁都不读的快照列」里，会让「它到底进不进提示词」这件事无法从数据模型上看出来。

-- ── 1) 列 ──
--
-- `DEFAULT ''` 而非可空：调用方读到的永远是字符串，「没写过」与「写空」语义相同，
-- 少一个 null 分支就少一处忘记处理的地方。
ALTER TABLE pentest.engagements
    ADD COLUMN public_memory text NOT NULL DEFAULT '';

-- 变更时间与操作者。**为什么不复用 `updated_at`**：那个字段随任何状态变更（启动 Agent、
-- 暂停、冻结报告…）刷新，而这里的「最后修改」必须特指这段文本被谁在何时改过——
-- 否则界面上显示的「最后更新」会在人类什么都没做时自己变。
ALTER TABLE pentest.engagements ADD COLUMN public_memory_updated_at timestamptz;
ALTER TABLE pentest.engagements ADD COLUMN public_memory_updated_by text;

-- ── 2) 自检 ──
--
-- 漏了 ADD COLUMN 会让服务在第一次读公共记忆时抛 `column does not exist`，
-- 而那是一个只在运行期、只在某条路径上才出现的失败。这里让迁移自己失败。
DO $$
DECLARE
    col_count integer;
    has_default boolean;
BEGIN
    SELECT count(*), bool_or(pg_get_expr(d.adbin, d.adrelid) = '''''::text')
      INTO col_count, has_default
      FROM information_schema.columns c
      LEFT JOIN pg_attrdef d
        ON d.adrelid = 'pentest.engagements'::regclass
       AND d.adnum = c.ordinal_position
     WHERE c.table_schema = 'pentest'
       AND c.table_name = 'engagements'
       AND c.column_name IN ('public_memory', 'public_memory_updated_at', 'public_memory_updated_by');

    IF col_count <> 3 THEN
        RAISE EXCEPTION 'engagements 的公共记忆列只建了 % 列，期望 3 列', col_count;
    END IF;

    IF NOT has_default THEN
        RAISE EXCEPTION 'public_memory 缺少 DEFAULT ''''：既有行会读到 NULL，而调用方按字符串处理';
    END IF;
END
$$;
