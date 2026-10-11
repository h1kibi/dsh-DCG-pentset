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
 * ── 规则（四条，缺一不可）──
 *
 * 0. **运行标记不是终态**：`aborted`（人类按了「终止」）/ `failed` 的作业**不结算**——那是运行
 *    已经结束的作业，它的出路是归档与清空，不是把主状态回滚。
 * 1. **回滚目标取自"进入 `worker_running` 的那次转移"的 `from_status`**（`state_transitions` 记着它）
 *    ——因此路径无关、无需逐路径硬编码：重做失败回 `waiting_human_review`、重开失败回 `report_ready`、
 *    切换确认失败回 `transition_confirmation`、启动失败回 `ready`。
 *
 *    **为什么不是"最后一次转移的 `from_status`"**（2026-10-11 自纠，真库上 8 条作业现场抓到）：
 *    「终止」记的是 `worker_running → worker_running`（主状态不动，只改运行标记）——照它回滚就是
 *    **原地踏步**：事件照写、状态没动、作业还是悬空。锚点必须是真的把主状态**推进到** `worker_running`
 *    的那一次转移；一次都没有（比如从没启动过、或只有终止）就**不结算**，`update` 不命中 ⇒
 *    返回零行 ⇒ 调用方连事件都不写。
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
-- 这是转移之外的版本推进：登记项 dangling-running-settle 在 transition-table.ts 的表里。
-- 锚点 = **进入 worker_running 的那次转移**（不是"最后一条转移"：终止记的是同态空转移）。
with anchor as (
  select from_status
    from pentest.state_transitions
   where engagement_id = $1::uuid
     and to_status = 'worker_running'
     and from_status <> 'worker_running'
   order by resulting_version desc
   limit 1
)
-- version-bump-registered:dangling-running-settle
update pentest.engagements e
   set current_status = anchor.from_status,
       active_agent_session_id = null,
       state_version = e.state_version + 1,
       updated_at = now()
  from anchor
 where e.id = $1::uuid
   and e.current_status = 'worker_running'
   -- 运行标记终态不是悬空态：aborted 是人类按了「终止」、failed 是运行已判死——
   -- 两者的出路是归档与清空，回滚主状态会把「已经结束的作业」重新摆回流程里。
   and e.status not in ('aborted', 'failed')
   and not exists (
     select 1
       from pentest.worker_sessions s
      where s.engagement_id = e.id
        and s.status not in ('failed', 'closed', 'superseded')
   )
returning anchor.from_status as settled_from`;
