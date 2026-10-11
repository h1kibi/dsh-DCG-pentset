/**
 * 结算「声称有 Agent 在跑、实际没有任何活会话」的**悬空态**。
 *
 * ── 现场（2026-10-11 外部缺陷报告，对象为别人的部署）──
 *
 * 会话进终态 `failed` → 人类点「重做」→ 转移事务把 `current_status` 推到 `worker_running`
 * → **新会话创建失败**（`createDshSessionOrMarkFailed` 写 `engagements.status='blocked'`）
 * → **主状态不回滚** → 作业停在「主状态 worker_running + 运行标记 blocked + 没有活会话」。
 * 而该主状态的两条出边：① `worker_running → waiting_human_review` 要**活着的 Agent** 提交报告；
 * ②「结束技术测试」要求 `runMarker === 'running'`（已被对账写成 blocked）。
 * ⇒ 人类盯着两个灰掉的按钮（重做/重开），唯一亮着的是「恢复」——**出路存在但不可发现**。
 *
 * 同一形态还有第二条成因：`markDeliveryFailure`（复用会话重做时投递失败）同样只写 blocked。
 *
 * ── 规则（三条，缺一不可）──
 *
 * 1. **回滚目标取自最后一次转移的 `from_status`**（`state_transitions` 记着它）——因此
 *    路径无关、无需逐路径硬编码：重做失败回 `waiting_human_review`、重开失败回 `report_ready`、
 *    切换确认失败回 `transition_confirmation`、启动失败回 `ready`。
 * 2. **只在确实没有活会话时结算**：还剩 `active`/`waiting_human`/`starting`/`paused`/… 的会话就不动
 *    主状态——否则会把一个**正常在跑**的作业按回上一态。
 * 3. **只在主状态是 `worker_running` 时结算**：其它主状态的失败各有各的语义，不在本规则内。
 *
 * 结算是一次**不经转移行**的版本推进（§5.4 的棘轮要求登记）：登记在 `transition-table.ts` 的
 * `NON_TRANSITION_VERSION_BUMPS`，并写领域事件 `workflow.dangling_running_settled`。
 *
 * `active_agent_session_id` 一并清空：它此刻指向的正是那个失败的会话，留着就是
 * 「活动会话 badge 指着一个死会话」（外部报告 §2.5 的附带缺陷）。
 *
 * 调用方（`core.settleDanglingRunning` 与启动对账里的同一步）各自负责：审计、以及**绝不抛**
 * （它是失败处置的附带动作，写不进去不该掩盖主因）。
 */
export const DANGLING_RUNNING_SETTLE_SQL = `
-- version-bump-registered:dangling-running-settle —— 理由见 transition-table.ts 的登记表：
-- 这是转移之外的版本推进（失败处置的附带动作：把主状态按回最后一次转移的 from_status）。
with latest as (
  select from_status
    from pentest.state_transitions
   where engagement_id = $1::uuid
   order by resulting_version desc
   limit 1
)
update pentest.engagements e
   set current_status = latest.from_status,
       active_agent_session_id = null,
       state_version = e.state_version + 1,
       updated_at = now()
  from latest
 where e.id = $1::uuid
   and e.current_status = 'worker_running'
   and not exists (
     select 1
       from pentest.worker_sessions s
      where s.engagement_id = e.id
        and s.status not in ('failed', 'closed', 'superseded')
   )
returning latest.from_status as settled_from`;
