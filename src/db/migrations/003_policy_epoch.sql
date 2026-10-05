-- 003：为 engagements 增加独立的 policy_epoch
--
-- 设计依据：docs/dsh-pentest-plugin-design.md §10.3.1、§10.6
--
-- 为什么需要独立列，而不是复用 state_version：
--
-- §10.3.1 要求放行凭证绑定「策略版本」，且**策略 epoch 前进时终止在途动作**
-- （沙箱/代理在连接时刻复核 epoch，已前进则关闭连接并终止进程树）。
--
-- `state_version` 被**所有**人类操作推进——包括暂停、重做、插话唤醒。若拿它当
-- 策略 epoch，暂停就会：
--   1. 终止全部在途动作；
--   2. 经「租约吊销 → 其下凭证一并失效」的链路作废该会话全部待用放行凭证。
--
-- 第 2 条正是 §10.6 明确要避免的：「一次预算追加会静默作废该会话全部待用放行凭证，
-- 这个连锁后果不可接受」。因此暂停必须保留凭证，也就不能把 state_version 当 epoch。
--
-- policy_epoch 的**唯一**推进条件是范围修订或策略变更——即「边界动过」这件事本身。
-- 它单调递增、永不回退，因此可以被沙箱与代理安全地用作「我裁决时的边界还是现在这个吗」
-- 的比较基准。

ALTER TABLE pentest.engagements
    ADD COLUMN IF NOT EXISTS policy_epoch bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN pentest.engagements.policy_epoch IS
    '策略/范围边界的单调版本（§10.3.1）。只在范围修订或策略变更时递增；暂停与重做不推进它。放行凭证与在途动作的撤销判定以它为准。';
