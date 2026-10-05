-- 014：把「资产归属」补到记忆条目与证据上（§8.6 范围过滤、§9.2 数据模型）。
--
-- ── 为什么必须补 ──
--
-- §8.6 的可见性公式定义在**分块**上（`chunk.asset_ids`），因为分块是可检索文本的
-- 唯一落点。但**按标识读取**（§8.7 `memory:<id>`）还接受两种其它引用：
--   - `memory:<memory_items.id>`：条目的正文在 `memory_items.content`；
--   - 证据读取 `artifact_read`：正文/元数据在 `artifacts`。
-- 这两张表此前都没有资产归属列，于是它们的内容**绕不过**范围排除：只要知道 UUID，
-- 被排除资产派生的条目与证据仍可读出来。分块那一侧的过滤做得再严也没用——
-- 引用路径根本不经过分块。
--
-- 因此这里把归属**物化**到这两张表上，让三条读取路径共用 §8.6 的同一份谓词：
--
--     可见 ⟺ NOT (asset_ids ∩ X(v) ≠ ∅) ∧ (asset_ids ∩ I(v) ≠ ∅ ∨ asset_ids = '{}')
--
-- ── 空归属仍然放行，且这是刻意的 ──
--
-- 与分块同口径：`{}` 可见。人工决策、交接、压缩摘要、思考链本来就解析不出资产归属，
-- 要求「必须归属某资产」会把它们整批从可读面抹掉。与之配套的是**写入侧义务**
-- （§8.6 末段）：凡是能确定资产归属的内容，写入时必须填齐 `asset_ids`——
-- 只标分块不标条目等于留一条旁路。写入侧校验器应复用 `chunks.ts` 的
-- `checkChunkAssetObligation` 同款判定（来源事件明确含目标却没有归属即拒绝写入）。
--
-- ── 为什么默认值是 `{}` 而不是 NULL ──
--
-- `{}` 与 NULL 在过滤谓词里的语义不同：前者是「已知无归属」，后者会被 SQL 的三值逻辑
-- 变成「未知」。用 NOT NULL DEFAULT '{}' 让「尚未回填归属的历史行」明确落在
-- 「无归属」这一侧，而不是让每个读取点各自解释 NULL。这也让 `asset_ids && X` 这类
-- 数组重叠谓词无需额外判空。
--
-- ── 已有数据怎么办（升级部署必读）──
--
-- `DEFAULT '{}'` 只对新行生效；**升级前已存在的行会拿到 `{}`**，而 `{}` 在可见性公式里
-- 是**放行**。于是那些历史上由被排除资产派生的条目与证据，在 `014` 之后仍然可读——
-- 新加的这一列并没有追溯性地保护它们。本插件是 0.1.0 私仓、尚无生产数据，因此这里
-- **不做回填**（多数旧行的真实归属无法从现有列推导：`artifacts` 只连到 `tool_runs`
-- 与 `worker_sessions`，两者的目标选择器不构成资产标识）。
--
-- 若某个库确实有升级前数据，部署方必须自己决定：
--   - 能推导归属的（例如 `memory_chunks.asset_ids` 非空的条目，可按 `memory_item_id` 汇总回填）；
--   - 推导不出的，按「归属未知」处理——即把这些行的 `asset_ids` 显式置为
--     **该 engagement 当前排除集合里的资产**，让它们 fail-closed 地不可见，
--     而不是让 `{}` 的放行语义默默继续生效。
-- 判据是 `asset_scope_versions`，不是猜测。

-- ── 部署前提 ──
--
-- 本迁移只加列与注释，不改策略、不动 GRANT：002 对这两张表的授权是**表级**的
-- （`GRANT SELECT, INSERT, UPDATE ON ... pentest.artifacts, pentest.memory_items TO pentest_app`
-- 与 Worker/审计角色的 SELECT），新增列自动落在既有授权内，不需要补 GRANT。
-- 两张表也都不在 002 的状态推进触发器清单里（它们没有「结算列」语义），
-- 因此不存在「新列未列入可更新白名单而被冻结」的问题。

-- 记忆条目：条目正文的资产归属。与 memory_chunks.asset_ids 同为 §8.6 谓词的输入。
ALTER TABLE pentest.memory_items
    ADD COLUMN asset_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pentest.memory_items.asset_ids IS
    '条目正文归属的资产（§8.6）。写入侧义务：来源事件能确定目标时必须填齐；空数组表示已知无归属（人工决策、交接、压缩摘要等），在可见性公式里放行。';

-- 证据：证据内容的资产归属。读取路径（artifact_read）据此复用 §8.6 谓词，
-- 使「范围修订后与被排除资产关联的证据按 UUID 直读」不再成立。
ALTER TABLE pentest.artifacts
    ADD COLUMN asset_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pentest.artifacts.asset_ids IS
    '证据内容归属的资产（§8.6）。写入侧义务：能确定目标时必须填齐，否则被排除资产的证据仍可按标识读出来；空数组表示已知无归属。';
