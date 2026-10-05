/**
 * 政策服务的 PostgreSQL 装配层（设计文档 §10.2、§10.2.1、§10.2.2、§10.3）。
 *
 * 本模块只做一件事：把**已有的纯逻辑**接到数据来源上。判定算法没有任何一份复制品——
 *   - 目标规范化、范围加载与匹配、排除项优先级：`scope.ts`（§10.2.2 的唯一实现）；
 *   - 动作类别判定与参数白名单：`templates.ts`（§10.2.1 的唯一实现）；
 *   - 默认动作策略：`execution/service.ts` 的 `DEFAULT_ACTION_POLICY`。
 *
 * 因此本模块的三个类都只做「读 + 喂给纯函数 + 原样返回结论」。
 *
 * 四条 fail-closed 纪律（每一条都有对应用例，见 `test/pg-policy.test.ts`）：
 *   1. 范围版本不存在或条目无法安全解析 → 拒绝，绝不当作「全部在范围内」；
 *   2. 无法归类（未注册模板、参数越界）→ `{ok:false}`，绝不降级为低风险放行（§10.2.1）；
 *   3. 策略快照读不到或形状非法 → 回落 `DEFAULT_ACTION_POLICY`（严格默认：契约基线类别
 *      逐次放行、没有任何默认禁用类别被开启），且契约基线是**下界**，策略快照只能扩大
 *      逐次放行集合——§10.3 的风险分级表不可由策略快照豁免；
 *   4. 裁决/复核所依赖的读取失败（存储故障）→ 一律拒绝，且**不**伪装成 `out_of_scope`：
 *      范围路径返回 `address_not_adjudicated`（上游映射为 `target_not_adjudicated`），
 *      复核路径返回 `blocked`。理由是「目标未获裁决」与「目标被裁决为范围外」是两件事，
 *      混报会污染 §10.2.2 的范围违规计数（连续三次会触发自动暂停）。
 *
 * 只依赖注入的 `DbClient`（`{ query(sql, params) }`），不持有连接池：装配点传 `pg.Pool`
 * （或 `PoolClient`），测试传记录型假实现。
 */

import type {
  ActionClass,
  ActionPacing,
  AssetScopeDecision,
  ErrorCode,
  ExecutionPlan,
  NormalizedTarget,
  PolicyService,
  PortRange,
  Protocol,
  RunMarker,
  ScopeRejectionCode,
  ScopeTarget,
  ScopeVerdict,
  SessionLease,
  SessionStatus,
  ToolError,
} from '../contracts.ts';
import {
  ACTION_CLASSES,
  DEFAULT_DISABLED_CLASSES,
  PER_ACTION_APPROVAL_CLASSES,
  RUN_MARKERS,
  SESSION_STATUSES,
} from '../contracts.ts';
import type { DbClient } from '../memory/ledger.ts';
import type {
  ActionPolicySnapshot,
  ActionPolicySource,
  SessionBinding,
  SessionDirectory,
} from '../execution/service.ts';
import { DEFAULT_ACTION_POLICY } from '../execution/service.ts';
import type { ActionTemplateSpec, ParamBag, TemplateRegistry } from '../execution/templates.ts';
import { createRegistry, defaultRegistry, validateParams } from '../execution/templates.ts';
import type {
  AdjudicatedAddresses,
  AssetRegistry,
  LoadedScope,
  RedirectChainVerdict,
  ScopeRuleSet,
} from './scope.ts';
import { policySnapshotIsIntact } from './behavior-profile.ts';
import {
  assertAdjudicatedAddress,
  evaluateRedirectChain,
  evaluateScope as evaluateScopeRules,
  loadScopeRuleSet,
  normalizeTarget,
} from './scope.ts';

// ───────────────────────────── 数据库行形状 ─────────────────────────────

interface ScopeVersionRow {
  readonly targets: unknown;
  readonly exclusions: unknown;
}

/** `asset_scope_versions` 与 `assets` 的连接结果：同一份行同时供标签登记表与资产裁决使用。 */
interface AssetDecisionRow {
  readonly canonical_target: string;
  readonly kind: string;
  readonly labels: unknown;
  readonly decision: string;
}

interface SessionRow {
  readonly engagement_id: string;
  readonly status: string;
  readonly scope_version: number | string;
  readonly policy_epoch: number | string;
  /** engagement 的运行标记（§5.1）。 */
  readonly engagement_status: string;
}

interface LeaseRow {
  readonly id: string;
  readonly worker_session_id: string;
  readonly task_ref: string | null;
  readonly generation: number | string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly revoked_reason: string | null;
}

interface PolicySnapshotRow {
  readonly policy_snapshot: unknown;
  readonly policy_version: number | string | null;
  readonly policy_snapshot_hash: string | null;
}

// ───────────────────────────── SQL ─────────────────────────────

/**
 * §10.2.2「范围版本的绑定」：判断用**会话冻结的版本**，因此按 (engagement, version)
 * 精确读取，而不是读最新版本（读最新版本会随修订中途改判）。
 */
const SQL_SCOPE_VERSION = `select targets, exclusions
       from pentest.scope_versions
      where engagement_id = $1 and version = $2`;

/**
 * §10.2.2「资产标签」与「排除项优先于包含项」。
 *
 * 只取**在该范围版本内登记过决策**的资产：没有 `asset_scope_versions` 行的资产不属于
 * 该版本的范围，不能借「同标签」进入资产标签条目的展开集合（那会是一次静默的越权扩大）。
 */
const SQL_ASSET_DECISIONS = `select a.canonical_target, a.kind, a.labels, d.decision
       from pentest.asset_scope_versions d
       join pentest.assets a on a.id = d.asset_id
      where d.engagement_id = $1 and d.scope_version = $2
      order by a.canonical_target`;

/** 会话绑定：会话冻结的范围版本（§10.2.2）+ engagement 的单调策略 epoch（§10.3.1）。 */
const SQL_SESSION = `select s.engagement_id, s.status, s.scope_version, e.policy_epoch, e.status as engagement_status
       from pentest.worker_sessions s
       join pentest.engagements e on e.id = s.engagement_id
      where s.id = $1`;

/**
 * 未吊销租约。`session_leases_one_active`（`WHERE revoked_at IS NULL` 的部分唯一索引）
 * 保证同一会话至多一行；`order by generation desc` 只是让读取结果在索引重建等异常下仍然确定。
 */
const SQL_ACTIVE_LEASE = `select id, worker_session_id, task_ref, generation, expires_at, revoked_at, revoked_reason
       from pentest.session_leases
      where worker_session_id = $1 and revoked_at is null
      order by generation desc
      limit 1`;

/** engagement 策略快照与版本（§10.3）：会话 → engagement 一次连接读回。 */
const SQL_POLICY_SNAPSHOT = `select e.policy_snapshot, e.policy_version, e.policy_snapshot_hash
       from pentest.worker_sessions s
       join pentest.engagements e on e.id = s.engagement_id
      where s.id = $1`;

/**
 * 授权有效期（§11.1 的硬边）。
 *
 * 建 engagement 时授权到期时间随范围版本 1 一起冻结进 `engagements.scope_snapshot`
 * （见 `pg-workflow.ts` 的 `createEngagement`），因此这里从快照读。
 *
 * `->>` 取出的是文本；**本层不做解释**，原样交给 {@link readExpiry} 分成
 * `none` / `at` / `invalid` 三态。业务含义（哪种形态放行、哪种拒绝）在 `readExpiry`
 * 一处定义，避免 SQL 注释与代码各持一套口径。
 */
const SQL_AUTHORIZATION_EXPIRES_AT = `select scope_snapshot ->> 'authorizationExpiresAt' as expires_at
       from pentest.engagements
      where id = $1`;

/**
 * 授权到期字段的三种形态。
 *
 * 区分它们不是洁癖：「未声明到期」与「读到的东西根本读不懂」在处置上完全相反——
 * 前者是合法且常见的部署状态（向导不强制填，§6.2.0.4），后者意味着 `scope_snapshot`
 * 被手工改坏或历史数据损坏，此时**没有任何**可信的授权硬边，唯一正确的动作是停下来。
 */
type ExpiryReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'at'; readonly at: Date }
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * 解析授权到期时间。
 *
 * ── 为什么坏值必须 fail-closed ──
 *
 * 这里的前一版把「非空但不可解析」也归成 `null`（= 未声明到期），并在注释里论证
 * 「放行但可见」优于「当成已过期」。那个论证有个致命缺口：**它默认坏值一定会被人看见**。
 * 实际上 `null` 会让 `admit` 与 `validateExecution` 双双跳过到期判定，于是一条
 * `update pentest.engagements set scope_snapshot = ...` 就能静默移除 §11.1 的硬边——
 * 而 §11.1 说的是「授权过期后**任何**触及目标的动作都不受理」，前提是「过期时间可信」。
 * 读不懂的到期时间不构成「未声明到期」，它构成「授权依据不可信」。
 *
 * 因此三种形态分开：合法空值仍是 `none`（不限制），合法时间按时间判，**非空而不可解析
 * 一律是 `invalid`**，由调用方转成 `authorization_expired` 拒绝。拒绝码复用它而不是新造，
 * 因为处置完全相同：取得新的授权或修订授权依据——改目标、重试、重开会话都绕不过去。
 */
function readExpiry(raw: string | null): ExpiryReading {
  if (raw === null || raw.trim() === '') return { kind: 'none' };
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime())
    ? { kind: 'at', at: parsed }
    : { kind: 'invalid', raw };
}

/** 把「不可解析的授权到期」转成统一的拒绝载荷（§11.1）。 */
function invalidExpiryError(raw: string, engagementId: string): ToolError {
  return blocked(
    'authorization_expired',
    `授权依据不可信：engagement ${engagementId} 的 authorizationExpiresAt 无法解析为时间` +
      `（实际 ${JSON.stringify(raw)}）。读到坏值时不能当成「未声明到期」——那等于静默移除 §11.1 的硬边`,
    '由人类修正授权依据（重填合法的到期时间，或清空该字段表示不作限制）后重新申请；' +
      '在修正前任何触及目标的动作都不该被受理',
  );
}

/** 范围版本是否仍存在：`validateExecution` 复核用（§10.3.1「执行前重新裁决」）。 */
const SQL_SCOPE_VERSION_EXISTS = `select 1 as present
       from pentest.scope_versions
      where engagement_id = $1 and version = $2`;

// ───────────────────────────── 解析辅助 ─────────────────────────────

/**
 * 会话标识是 `uuid` 列：非 uuid 串交给 PostgreSQL 会抛 22P02（文本表示非法），
 * 而两个服务面的契约都要求「会话不存在 → undefined / 默认策略」。因此判定放在查询之前，
 * 让「不是标识」与「不存在」走同一条确定的路径，而不是把驱动错误漏给调用方。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toNumber(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`列 ${field} 的取值不是整数：${String(value)}`);
  }
  return parsed;
}

function toDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`列 ${field} 的取值不是时间：${String(value)}`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 类型守卫保留收窄（`unknown` → `ActionClass`），与契约词汇表同源，不另立一份清单。 */
function isActionClass(value: unknown): value is ActionClass {
  return typeof value === 'string' && (ACTION_CLASSES as readonly string[]).includes(value);
}

/**
 * `worker_sessions.status` 有 CHECK 约束，读到未知值只能说明数据被绕过约束写入（或约束被改）。
 * 这不是「不存在」，必须响亮失败，不能静默归到一个更宽松的状态上。
 */
function parseSessionStatus(value: unknown): SessionStatus {
  if (typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus;
  }
  throw new Error(`worker_sessions.status 取值不在契约词汇表内：${String(value)}`);
}

/**
 * 解析 engagement 运行标记（§5.1）。
 *
 * **不认识的取值按 `blocked` 处理，不抛错也不当作 `running`**。理由：
 * 这个值决定「是否允许触及目标的动作」。遇到未来新增的标记时，两种极端都不对：
 *   - 抛错 → 整个 binding 失败，连读状态都做不了（可用性问题）；
 *   - 当作 `running` → **静默放行**一个未知状态下的目标动作（安全问题）。
 *
 * 取 `blocked` 是保守的一侧：动作被拒，错误信息里带上原始取值，人类据此
 * 判断是版本不匹配还是数据异常。这与 §9.1「遇到更新的表结构响亮拒绝」同一精神——
 * 宁可停下并说明，也不要猜。
 */
function parseRunMarker(value: unknown): RunMarker {
  if (typeof value === 'string' && (RUN_MARKERS as readonly string[]).includes(value)) {
    return value as RunMarker;
  }
  return 'blocked';
}

function parseRevocationReason(value: unknown): SessionLease['revokedReason'] {
  if (value === null) return null;
  if (
    value === 'superseded' ||
    value === 'closed' ||
    value === 'failed' ||
    value === 'human_revoke' ||
    value === 'expired'
  ) {
    return value;
  }
  throw new Error(`session_leases.revoked_reason 取值不在契约词汇表内：${String(value)}`);
}

function toSessionLease(row: LeaseRow): SessionLease {
  return {
    id: row.id,
    workerSessionId: row.worker_session_id,
    taskRef: row.task_ref,
    generation: toNumber(row.generation, 'generation'),
    expiresAt: toDate(row.expires_at, 'expires_at'),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at, 'revoked_at'),
    revokedReason: parseRevocationReason(row.revoked_reason),
  };
}

// ───────────────────────────── 范围条目解析（jsonb → ScopeTarget） ─────────────────────────────

const SCOPE_KINDS = ['domain', 'ip', 'cidr', 'url', 'asset-label'] as const;

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * `scope_versions.targets` / `exclusions` 是 jsonb。解析策略是**全有或全无**：
 * 任一条目形状非法即让整份范围加载失败（`malformed_target`），绝不做「跳过坏条目」的处理——
 * 跳过一条非法条目可能正好跳过一条排除项，那是把边界悄悄放宽。
 *
 * 这里只校验容器形状（是不是对象、kind 是否在词汇表内、protocols/ports 是不是数组）；
 * 协议取值、端口区间、通配合法性等语义校验全部交给 `loadScopeRuleSet`，避免出现第二份判定。
 */
function toScopeTargets(raw: unknown, bucket: string): Parsed<readonly ScopeTarget[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, detail: `${bucket} 不是数组（实际 ${describeShape(raw)}）` };
  }
  const out: ScopeTarget[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, detail: `${bucket}[${i}] 不是对象（实际 ${describeShape(entry)}）` };
    }
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    const value = record['value'];
    if (typeof kind !== 'string' || !(SCOPE_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, detail: `${bucket}[${i}] 的 kind 非法：${String(kind)}` };
    }
    if (typeof value !== 'string') {
      return { ok: false, detail: `${bucket}[${i}] 的 value 不是字符串：${String(value)}` };
    }
    const protocols = record['protocols'];
    if (!Array.isArray(protocols)) {
      return { ok: false, detail: `${bucket}[${i}] 的 protocols 不是数组（未声明协议即拒绝，§10.2.2 协议）` };
    }
    const ports = record['ports'];
    if (!Array.isArray(ports)) {
      return { ok: false, detail: `${bucket}[${i}] 的 ports 不是数组` };
    }
    const wildcard = record['wildcardSubdomain'];
    if (wildcard !== undefined && typeof wildcard !== 'boolean') {
      return { ok: false, detail: `${bucket}[${i}] 的 wildcardSubdomain 不是布尔值：${String(wildcard)}` };
    }
    // 协议与端口的取值合法性留给 scope.ts：此处只保证容器形状是数组。
    out.push({
      kind: kind as ScopeTarget['kind'],
      value,
      protocols: protocols as readonly Protocol[],
      ports: ports as readonly PortRange[],
      ...(wildcard === undefined ? {} : { wildcardSubdomain: wildcard }),
    });
  }
  return { ok: true, value: out };
}

// ───────────────────────────── 资产标签与资产裁决 ─────────────────────────────

/** `labels` 是 jsonb 字符串数组；`@` 前缀在入库前后都可能出现，统一去掉（§10.2.2「资产标签」）。 */
function parseLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const label = (item.startsWith('@') ? item.slice(1) : item).trim();
    if (label.length > 0) out.push(label);
  }
  return out;
}

function parseDecision(raw: unknown): AssetScopeDecision['decision'] {
  if (raw === 'included' || raw === 'excluded' || raw === 'pending') return raw;
  // 未知决策不得按「最宽松的那个」处理；抛错由调用方转成拒绝。
  throw new Error(`asset_scope_versions.decision 取值非法：${String(raw)}`);
}

/**
 * `AssetScopeDecision.assetId` 与 `scope.ts` 的候选键（`decisionCandidates`）做字符串比较，
 * 候选键的形态是：规范化主机名、`kind:host`、`url:scheme://host:port`、`domain:*.parent`。
 *
 * 因此把 `assets.canonical_target` 映射成这些既有形态，而不是自造第四种键：
 *   - `canonical_target` 本身（对应候选键里的裸 host）；
 *   - 其规范化形态（候选键来自规范化后的请求主机，未规范化的存量数据否则永远匹配不上）；
 *   - 加上 `kind:` 前缀的两种形态（对应 `kind:host` 候选键）。
 * 只要其中任一形态命中，判定就落到这条人类决策上。
 */
function decisionKeys(canonicalTarget: string, kind: string): readonly string[] {
  const raw = canonicalTarget.trim();
  if (raw.length === 0) return [];
  const keys = new Set<string>([raw]);
  const normalized = normalizeTarget(raw, {});
  if (normalized.ok) {
    const n = normalized.normalized;
    keys.add(n.kind === 'url' ? `${n.scheme ?? ''}://${n.host}:${n.port ?? ''}` : n.host);
  }
  if (kind === 'domain' || kind === 'ip' || kind === 'url') {
    for (const key of [...keys]) keys.add(`${kind}:${key}`);
  }
  return [...keys];
}

interface LoadedAssets {
  readonly assetRegistry: AssetRegistry;
  readonly decisions: readonly AssetScopeDecision[];
}

/** 由已读取的行组装标签登记表与资产裁决表；不做 I/O，便于单测复用。 */
function buildAssets(rows: readonly AssetDecisionRow[]): LoadedAssets {
  const registry: Record<string, string[]> = {};
  const decisions: AssetScopeDecision[] = [];
  for (const row of rows) {
    const decision = parseDecision(row.decision);
    for (const key of decisionKeys(row.canonical_target, row.kind)) {
      decisions.push({ assetId: key, decision });
    }
    for (const label of parseLabels(row.labels)) {
      const members = registry[label] ?? [];
      if (!members.includes(row.canonical_target)) members.push(row.canonical_target);
      registry[label] = members;
    }
  }
  return { assetRegistry: registry, decisions };
}

// ───────────────────────────── 动作策略快照（§10.3） ─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 读一个字符串数组键：同时接受契约的 camelCase 与配置面的 snake_case 拼写。
 * 非字符串元素与未知类别一律**丢弃**——这两种丢弃都是收紧方向：
 * 传入的开启请求被丢弃等于「没有开启」，传入的逐次放行类别被丢弃等于「只剩契约基线」。
 */
function readClasses(source: Record<string, unknown>, keys: readonly string[]): readonly ActionClass[] {
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const out: ActionClass[] = [];
    for (const item of value) if (isActionClass(item) && !out.includes(item)) out.push(item);
    return out;
  }
  return [];
}

function readBoolean(source: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (source[key] === true) return true;
  }
  return false;
}

/**
 * 读展开后的 pacing（§6.2.0.5）。
 *
 * 只接受**完整且合法**的五元组：缺一项就返回 `undefined`（= 不施加 pacing），
 * 而不是用契约默认值补齐——补出来的节奏不是人类批准的节奏，凭空施加它比不施加更坏。
 */
function readPacing(source: Record<string, unknown>): ActionPacing | undefined {
  const nested = asRecord(source['pacing']);
  if (nested === undefined) return undefined;
  const rate = nested['rate'];
  const concurrency = nested['concurrency'];
  const jitter = nested['jitter'];
  const burst = nested['burst'];
  const retry = nested['retry'];
  if (
    typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0
    || typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1
    || typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0
    || typeof burst !== 'number' || !Number.isInteger(burst) || burst < 1
    || typeof retry !== 'number' || !Number.isInteger(retry) || retry < 0
  ) {
    return undefined;
  }
  return { rate, concurrency, jitter, burst, retry };
}

/**
 * 读策略版本：**只认数据库列**（`engagements.policy_version`）。
 *
 * 快照里的 `profile_version` 是预设公式的修订号（schema 版本），与「这是第几份
 * 人类确认过的快照」不是一件事。混用它们会让计划摘要里的策略版本在修订后不变。
 */
function readPolicyVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 策略快照 → 动作策略（§10.3）。
 *
 * 完整性（内容与记录哈希是否一致）由调用方先用 {@link policySnapshotIsIntact} 判定：
 * 那是「这份策略能不能信」的问题，与本函数的「怎么解释它」是两件事。
 *
 * `perActionApprovalClasses` 取**契约基线 ∪ 快照值**：§10.3 的风险分级表规定
 * 「利用验证 / 横向移动」必须逐目标逐动作放行，这条要求不能由一份配置豁免；快照只能
 * 追加（例如把主动发现也纳入逐次放行）。
 *
 * `enabledDisabledClasses` 与 `DEFAULT_DISABLED_CLASSES` 求交：只有契约里真正「默认禁用」
 * 的类别才可能被开启，快照里写 `passive_read` 不会让任何东西被启用。
 */
export function actionPolicyFromSnapshot(snapshot: unknown): ActionPolicySnapshot {
  const source = asRecord(snapshot);
  if (source === undefined) return DEFAULT_ACTION_POLICY;
  const nested = asRecord(source['action_policy']);
  const policySource = nested === undefined ? source : { ...source, ...nested };

  const extra = readClasses(policySource, [
    'perActionApprovalClasses',
    'per_action_approval_classes',
    'approval_required',
  ]).filter((cls) => !(PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(cls));

  const enabled = readClasses(policySource, ['enabledDisabledClasses', 'enabled_disabled_classes']).filter((cls) =>
    (DEFAULT_DISABLED_CLASSES as readonly string[]).includes(cls),
  );
  const dualConfirmed = readBoolean(policySource, ['dualConfirmed', 'dual_confirmed']);
  // 展开的动作集合是**上界**：只取契约里认识的类别，未识别的丢弃（收紧方向）。
  const enabledActionClasses = readClasses(policySource, ['enabled', 'enabledActionClasses', 'enabled_action_classes']);
  const pacing = readPacing(policySource);
  // 审批模式：旧快照没有这个键 ⇒ 缺省 `human`（保守）。识别不了的取值同样按 human。
  const rawMode = policySource['approvalMode'] ?? policySource['approval_mode'];
  const approvalMode = rawMode === 'auto' || rawMode === 'human' ? rawMode : undefined;

  const result: ActionPolicySnapshot = {
    perActionApprovalClasses: [...PER_ACTION_APPROVAL_CLASSES, ...extra],
    ...(enabled.length === 0 ? {} : { enabledDisabledClasses: enabled, dualConfirmed }),
    ...(enabledActionClasses.length === 0 ? {} : { enabledActionClasses }),
    ...(pacing === undefined ? {} : { pacing }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
  };
  if (
    extra.length === 0 && enabled.length === 0 && enabledActionClasses.length === 0 &&
    pacing === undefined && approvalMode === undefined
  ) {
    return DEFAULT_ACTION_POLICY;
  }
  return result;
}

// ───────────────────────────── 错误构造 ─────────────────────────────

function blocked(code: ErrorCode, message: string, nextAction: string): ToolError {
  return { status: 'blocked', code, message, next_action: nextAction };
}

// ───────────────────────────── PgPolicyService ─────────────────────────────

export interface PgPolicyServiceOptions {
  /**
   * 服务端受信模板集（§10.2.1）。默认使用 `DEFAULT_TEMPLATES`；扩展必须由人类显式传入，
   * 这也意味着「模板集合」在任何部署里都是可枚举的封闭集合。
   */
  readonly templates?: readonly ActionTemplateSpec[];
  /** 时钟注入，便于测试授权到期这类与时间相关的判定。 */
  readonly now?: () => Date;
  /**
   * DNS 裁决钩子（§10.2.2「DNS 解析与地址固定」）。
   *
   * 地址裁决不是本模块的职责——`scope.ts` 明确不查 DNS——因此由装配点注入 Host 侧的
   * 裁决结果（出站代理按已裁决地址连接，工具不做二次解析）。未注入时域名目标一律按
   * `dns_unresolved` 拒绝，**不退化为按域名拨号**；IP 字面量目标不受影响。
   */
  readonly resolveAddresses?: (host: string) => Promise<readonly string[] | undefined>;
}

/**
 * 只读政策判定（§10.2.2 范围判定、§10.2.1 类别判定、§10.3.1 执行前复核）。
 */
export class PgPolicyService implements PolicyService {
  readonly #db: DbClient;
  readonly #now: () => Date;
  readonly #registry: TemplateRegistry;
  readonly #resolveAddresses: ((host: string) => Promise<readonly string[] | undefined>) | undefined;

  constructor(db: DbClient, options: PgPolicyServiceOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#registry =
      options.templates === undefined ? defaultRegistry() : createRegistry(options.templates);
    this.#resolveAddresses = options.resolveAddresses;
  }

  /**
   * 逐跳校验一条重定向链（§10.2.2「重定向每一跳都重新校验」）。
   *
   * 这是 `scope.ts` 里 `evaluateRedirectChain` 的**接线点**——该函数此前已实现但
   * 无调用者，等于这条安全规则在运行时没有落点。HTTP 路径的每次跳转都应经它。
   *
   * 数据来源与 `evaluateScope` 相同（同一范围版本 + 资产裁决），因此不增加查询语义
   * 负担；范围读取失败与判定失败一样返回确定拒绝，不退化为「放过」。
   */
  /**
   * 已注册的动作模板（顺序即注册顺序）。
   *
   * 暴露它的原因：模板集合是封闭的，而提示词必须把它交给模型，否则模型只能猜
   * `template_id`（实测连猜 9 个全错，最后以「无法枚举可用模板」收场）。
   * 注册表在策略服务里，就从这里取——在别处重建一份必然漂移。
   */
  listActionTemplates(): readonly ActionTemplateSpec[] {
    return this.#registry.list();
  }

  async evaluateRedirectChain(input: {
    engagementId: string;
    scopeVersion: number;
    chain: readonly string[];
    protocol: Protocol;
    port?: number;
  }): Promise<RedirectChainVerdict> {
    const loaded = await this.#loadScopeFor(input.engagementId, input.scopeVersion);
    if (!loaded.ok) {
      return { ok: false, code: loaded.code, detail: loaded.detail, hopIndex: 0 };
    }
    return evaluateRedirectChain({
      chain: input.chain,
      scope: loaded.value,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.port === undefined ? {} : { port: input.port }),
    });
  }

  /**
   * 地址固定校验（§10.2.2）：实际拨号地址必须落在裁决时解析出的地址集合内。
   *
   * 这是 `scope.ts` 里 `assertAdjudicatedAddress` 的接线点——同样此前无调用者。
   * 代理在建立连接前调用它，即可保证「连接的地址」= 「校验的地址」，
   * 从而闭合 DNS 重绑定的窗口。
   */
  assertAdjudicatedAddress(normalized: NormalizedTarget, dialedAddress: string): ScopeVerdict {
    return assertAdjudicatedAddress(normalized, dialedAddress);
  }

  /**
   * 读取并加载一个范围版本（含资产标签与资产裁决）。
   *
   * `evaluateScope` 与 `evaluateRedirectChain` 共用它：两者的数据来源相同，
   * 差别只在判定方式（单目标 vs 逐跳）。抽出来的另一个好处是**失败语义统一**——
   * 版本不存在、条目无法解析、存储读取失败，三者都返回确定拒绝而不是放任。
   */
  async #loadScopeFor(
    engagementId: string,
    scopeVersion: number,
  ): Promise<{ ok: true; value: LoadedScope } | { ok: false; code: ScopeRejectionCode; detail: string }> {
    let scopeRow: ScopeVersionRow | undefined;
    let assetRows: readonly AssetDecisionRow[];
    try {
      const scopeResult = await this.#db.query<ScopeVersionRow>(SQL_SCOPE_VERSION, [
        engagementId,
        scopeVersion,
      ]);
      scopeRow = scopeResult.rows[0];
      if (scopeRow === undefined) {
        return {
          ok: false,
          code: 'out_of_scope',
          detail: `范围版本 ${engagementId}#${scopeVersion} 不存在，该版本下没有任何目标被授权（§10.2.2 范围版本的绑定与撤销）`,
        };
      }
      const assetResult = await this.#db.query<AssetDecisionRow>(SQL_ASSET_DECISIONS, [
        engagementId,
        scopeVersion,
      ]);
      assetRows = assetResult.rows;
    } catch (error) {
      return {
        ok: false,
        code: 'address_not_adjudicated',
        detail: `范围裁决不可用：读取范围版本失败（${errorMessage(error)}）；目标未被裁决，拒绝动作`,
      };
    }

    const targets = toScopeTargets(scopeRow.targets, 'targets');
    if (!targets.ok) {
      return {
        ok: false,
        code: 'malformed_target',
        detail: `范围版本 ${engagementId}#${scopeVersion} 无法加载：${targets.detail}（§10.2.2 加载范围时报错）`,
      };
    }
    const exclusions = toScopeTargets(scopeRow.exclusions, 'exclusions');
    if (!exclusions.ok) {
      return {
        ok: false,
        code: 'malformed_target',
        detail: `范围版本 ${engagementId}#${scopeVersion} 无法加载：${exclusions.detail}（§10.2.2 加载范围时报错）`,
      };
    }

    let assets: LoadedAssets;
    try {
      assets = buildAssets(assetRows);
    } catch (error) {
      return {
        ok: false,
        code: 'malformed_target',
        detail: `资产裁决行无法解析：${errorMessage(error)}`,
      };
    }

    const ruleSet: ScopeRuleSet = {
      targets: targets.value,
      exclusions: exclusions.value,
      decisions: assets.decisions,
    };
    const loaded = loadScopeRuleSet(ruleSet, { assetRegistry: assets.assetRegistry });
    if (!loaded.ok) return loaded;
    return { ok: true, value: loaded.value };
  }

  /**
   * 范围判定：读会话冻结的范围版本 → 载入资产标签与资产裁决 → 交给 `scope.ts` 判定。
   *
   * 数据层面的失败全部转成稳定的拒绝码：
   *   - 版本不存在 → `out_of_scope`（该版本下没有任何目标被授权）；
   *   - 条目/资产行无法安全解析 → `malformed_target`（§10.2.2「加载范围时报错」）；
   *   - 存储读取失败 → `address_not_adjudicated`（目标**未获裁决**，不是被裁决为范围外）。
   */
  async evaluateScope(input: {
    engagementId: string;
    scopeVersion: number;
    target: string;
    protocol: Protocol;
    port?: number;
  }): Promise<ScopeVerdict> {
    const loaded = await this.#loadScopeFor(input.engagementId, input.scopeVersion);
    if (!loaded.ok) return loaded;

    const adjudicated = await this.#adjudicate(input.target, loaded.value.assetRegistry);
    return evaluateScopeRules({
      target: input.target,
      protocol: input.protocol,
      ...(input.port === undefined ? {} : { port: input.port }),
      scope: loaded.value,
      ...(adjudicated === undefined ? {} : { adjudicatedAddresses: adjudicated }),
    });
  }

  /**
   * 动作类别判定（§10.2.1）。**这是唯一的判定入口，且没有默认分支**：
   * 只有「模板已注册」且「参数通过白名单校验」才返回 `ok:true`，类别取自模板注册信息
   * 本身（不由参数、不由调用方决定）。其余一切情况返回 `ok:false` + 稳定错误码。
   */
  async classifyAction(input: {
    templateId: string;
    params: Readonly<Record<string, string | number>>;
  }): Promise<{ ok: true; actionClass: ActionClass } | { ok: false; code: ErrorCode; detail: string }> {
    const spec = this.#registry.get(input.templateId);
    if (spec === undefined) {
      const known = this.#registry
        .list()
        .map((s) => s.template.id)
        .join(', ');
      return {
        ok: false,
        code: 'classification_rejected',
        detail:
          `未注册的模板 ${JSON.stringify(input.templateId)}：可执行动作集合由服务端注册表封闭，` +
          `不尝试按名称近似归类（§10.2.1「无法归类即拒绝」，绝不降级为低风险放行）。已注册：${known}`,
      };
    }
    const validated = validateParams(spec.template, input.params as ParamBag, { allowFreeForm: spec.allowFreeForm === true });
    if (!validated.ok) {
      return { ok: false, code: validated.error.code, detail: validated.error.message };
    }
    return { ok: true, actionClass: spec.template.actionClass };
  }

  /**
   * 读授权时效（§11.1）。
   *
   * 返回的是**裁决**而不只是时间：`none`（未声明到期，合法）与 `invalid`（非空但读不懂）
   * 必须能被调用方区分，否则坏值会退化回「未声明到期」这条放行路径。见 {@link readExpiry}。
   */
  async authorizationValidity(
    engagementId: string,
  ): Promise<{ ok: true; expiresAt: Date | null } | { ok: false; error: ToolError }> {
    // engagement 标识不是 uuid 时没有可读的授权依据，按「未声明」处理会放行一个不存在的
    // engagement；这里也归到 fail-closed 一侧，措辞与读不到快照一致。
    if (!UUID_RE.test(engagementId)) {
      return {
        ok: false,
        error: blocked(
          'classification_rejected',
          `授权时效查询的 engagement 标识不是有效标识：${JSON.stringify(engagementId)}`,
          '改用控制台给出的 engagement 标识；不要自行构造标识',
        ),
      };
    }
    const result = await this.#db.query<{ readonly expires_at: string | null }>(
      SQL_AUTHORIZATION_EXPIRES_AT,
      [engagementId],
    );
    const reading = readExpiry(result.rows[0]?.expires_at ?? null);
    if (reading.kind === 'invalid') return { ok: false, error: invalidExpiryError(reading.raw, engagementId) };
    return { ok: true, expiresAt: reading.kind === 'at' ? reading.at : null };
  }

  /**
   * 执行前复核（§10.3.1「执行前重新裁决」）：人类放行可能数分钟后才到，期间模板、类别、
   * 范围版本与策略 epoch 都可能已经变了。
   *
   * 复核项：模板仍在注册表内 → 类别复算一致 → 会话仍存在 → 会话冻结的范围版本与计划一致
   * → `policy_epoch` 未前进 → 该范围版本仍存在。任一项不通过即 `blocked`。
   */
  async validateExecution(plan: ExecutionPlan): Promise<{ ok: true } | { ok: false; error: ToolError }> {
    const spec = this.#registry.get(plan.templateId);
    if (spec === undefined) {
      return {
        ok: false,
        error: blocked(
          'classification_rejected',
          `执行前复核失败：模板 ${plan.templateId} 已不在服务端注册表中`,
          '模板被移出注册表后旧计划失效，改用已注册模板重新申请',
        ),
      };
    }
    if (spec.template.actionClass !== plan.actionClass) {
      return {
        ok: false,
        error: blocked(
          'classification_rejected',
          `执行前复核失败：类别复算不一致（模板注册为 ${spec.template.actionClass}，计划为 ${plan.actionClass}）`,
          '模板与计划不一致即拒绝，重新申请放行',
        ),
      };
    }

    let session: SessionRow | undefined;
    let scopeVersionPresent: boolean;
    try {
      const sessionResult = await this.#db.query<SessionRow>(SQL_SESSION, [plan.workerSessionId]);
      session = sessionResult.rows[0];
      if (session === undefined) {
        return {
          ok: false,
          error: blocked(
            'stale_state_version',
            `执行前复核失败：会话 ${plan.workerSessionId} 不存在`,
            '会话已失效，重新申请会话与放行凭证',
          ),
        };
      }
      const scopeVersion = toNumber(session.scope_version, 'scope_version');
      const policyEpoch = toNumber(session.policy_epoch, 'policy_epoch');
      if (scopeVersion !== plan.scopeVersion) {
        return {
          ok: false,
          error: blocked(
            'stale_state_version',
            `执行前复核失败：会话冻结的范围版本与计划不一致（计划 ${plan.scopeVersion}，当前 ${scopeVersion}）`,
            '范围修订后旧计划失效，重新申请放行',
          ),
        };
      }
      if (policyEpoch !== plan.policyEpoch) {
        return {
          ok: false,
          error: blocked(
            'stale_state_version',
            `执行前复核失败：策略版本已前进（计划 ${plan.policyEpoch}，当前 ${policyEpoch}）`,
            '策略或范围变更后旧计划失效，重新申请放行',
          ),
        };
      }
      // §11.1 的硬边：授权过期后**任何**触及目标的动作都不受理。
      // 放在执行前重裁决里而不是只在受理时判：受理与执行之间可能隔很久（人在放行队列前
      // 停留、命令排队），而授权恰好在那个窗口里到期——那时按旧判断继续执行就是越权。
      //
      // 读不懂的到期值同样在这里被拒：它不代表「未声明到期」，见 `readExpiry`。
      const expiresResult = await this.#db.query<{ readonly expires_at: string | null }>(
        SQL_AUTHORIZATION_EXPIRES_AT,
        [session.engagement_id],
      );
      const reading = readExpiry(expiresResult.rows[0]?.expires_at ?? null);
      if (reading.kind === 'invalid') {
        return { ok: false, error: invalidExpiryError(reading.raw, session.engagement_id) };
      }
      if (reading.kind === 'at' && reading.at.getTime() <= this.#now().getTime()) {
        return {
          ok: false,
          error: blocked(
            'authorization_expired',
            `执行前复核失败：授权已于 ${reading.at.toISOString()} 过期（§11.1）`,
            '取得新的授权或修订授权依据后重新申请；过期的授权不会因为凭证仍在有效期内而被接受',
          ),
        };
      }

      const exists = await this.#db.query<{ readonly present: number }>(SQL_SCOPE_VERSION_EXISTS, [
        session.engagement_id,
        plan.scopeVersion,
      ]);
      scopeVersionPresent = exists.rows[0] !== undefined;
    } catch (error) {
      return {
        ok: false,
        error: blocked(
          'target_not_adjudicated',
          `执行前复核不可用：读取会话绑定失败（${errorMessage(error)}）；本次执行未被裁决，拒绝`,
          '政策存储不可用时不放过任何动作，等待控制台恢复后重新申请',
        ),
      };
    }

    if (!scopeVersionPresent) {
      return {
        ok: false,
        error: blocked(
          'scope_violation',
          `执行前复核失败：计划绑定的范围版本 ${plan.scopeVersion} 已不存在`,
          '范围版本被移除后旧计划失效，按当前范围重新申请放行',
        ),
      };
    }
    return { ok: true };
  }

  /** 域名目标的地址裁决（§10.2.2 地址固定）：裁决结果由装配点注入，本模块不查 DNS。 */
  async #adjudicate(
    target: string,
    assetRegistry: AssetRegistry,
  ): Promise<AdjudicatedAddresses | undefined> {
    const resolve = this.#resolveAddresses;
    if (resolve === undefined) return undefined;
    // 目标本身非法时不猜：交给 evaluateScope 给出正确的拒绝码。
    const pre = normalizeTarget(target, { assetRegistry });
    if (!pre.ok) return undefined;
    if (pre.normalized.kind === 'ip') return undefined; // 字面量 IP 自身即已裁决地址
    try {
      const addresses = await resolve(pre.normalized.host);
      if (addresses === undefined || addresses.length === 0) return undefined;
      return { [pre.normalized.host]: addresses };
    } catch {
      // 裁决失败等于没有裁决结果：由 evaluateScope 按 dns_unresolved 拒绝。
      return undefined;
    }
  }
}

// ───────────────────────────── PgSessionDirectory ─────────────────────────────

/**
 * 会话绑定（§10.2.2、§10.3.1、§10.6）：范围版本、策略 epoch 与未吊销租约是执行准入的上下文。
 *
 * 三者的来源分别是 `worker_sessions.scope_version`（会话冻结版本）、
 * `engagements.policy_epoch`（单调的策略/范围边界版本）与 `session_leases`（未吊销租约）。
 */
export class PgSessionDirectory implements SessionDirectory {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async binding(workerSessionId: string): Promise<SessionBinding | undefined> {
    if (!UUID_RE.test(workerSessionId)) return undefined;
    const sessions = await this.#db.query<SessionRow>(SQL_SESSION, [workerSessionId]);
    const row = sessions.rows[0];
    if (row === undefined) return undefined;
    const leases = await this.#db.query<LeaseRow>(SQL_ACTIVE_LEASE, [workerSessionId]);
    const leaseRow = leases.rows[0];
    return {
      engagementId: row.engagement_id,
      status: parseSessionStatus(row.status),
      // 运行标记用运行时窄化而非断言：列是自由文本（001 有 CHECK 但读路径仍可能
      // 遇到未来新增的标记）。不认识的标记**按最保守处理**——不当作 running，
      // 因此会让动作被拒。fail-closed。
      engagementStatus: parseRunMarker(row.engagement_status),
      scopeVersion: toNumber(row.scope_version, 'scope_version'),
      policyEpoch: toNumber(row.policy_epoch, 'policy_epoch'),
      lease: leaseRow === undefined ? null : toSessionLease(leaseRow),
    };
  }
}

// ───────────────────────────── PgActionPolicySource ─────────────────────────────

/**
 * 会话绑定的动作策略（§10.3）。
 *
 * **默认严格**：读不到（会话不存在、策略键缺失、形状非法）或读取失败一律回落到
 * `DEFAULT_ACTION_POLICY`——契约基线的逐次放行类别 + 没有任何默认禁用类别被开启。
 * 回落值在严格的一侧，因此存储故障只会让判定更严，不会放宽任何动作。
 */
export class PgActionPolicySource implements ActionPolicySource {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async forSession(workerSessionId: string): Promise<ActionPolicySnapshot> {
    if (!UUID_RE.test(workerSessionId)) return DEFAULT_ACTION_POLICY;
    let snapshot: unknown;
    let rawVersion: number | string | null;
    let recordedHash: string;
    try {
      const result = await this.#db.query<PolicySnapshotRow>(SQL_POLICY_SNAPSHOT, [workerSessionId]);
      const row = result.rows[0];
      if (row === undefined) return DEFAULT_ACTION_POLICY;
      snapshot = row.policy_snapshot;
      rawVersion = row.policy_version;
      recordedHash = row.policy_snapshot_hash ?? '';
    } catch {
      return DEFAULT_ACTION_POLICY;
    }
    // 投影被改过（哈希与内容不符）时按**严格默认**处理：不信任一份无法自证来源的策略。
    const record = asRecord(snapshot);
    if (record === undefined || !policySnapshotIsIntact(record, recordedHash)) {
      return DEFAULT_ACTION_POLICY;
    }
    const policy = actionPolicyFromSnapshot(snapshot);
    // 快照读不懂/为空即**就是**契约默认策略：此时不附加版本元数据，
    // 免得把「没有可用策略」稀释成一个看起来像正常策略的对象
    // （契约默认是身份相等的常量，调用方据此可以断言严格回落）。
    if (policy === DEFAULT_ACTION_POLICY) return DEFAULT_ACTION_POLICY;
    const policyVersion = readPolicyVersion(typeof rawVersion === 'string' ? Number(rawVersion) : rawVersion);
    // 版本读不到时**不带版本**：计划摘要里写 null 比写一个编造的 1 诚实。
    return policyVersion === undefined ? policy : { ...policy, policyVersion };
  }
}
