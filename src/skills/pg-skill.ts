/**
 * skill 库服务的 PostgreSQL 实现（设计文档 §2.2「skill 装载」、§16.2「skill 库服务」、
 * §9.5「审计账本」、§15.1「审计不可用即阻断」）。
 *
 * ── 这是一个全局库，不是 engagement 局部 ──
 *
 * 契约没有 `engagementId` 参数（§16.2：「skill 是全局库，不绑定 engagement」）。
 * 由此有两条后果，都落在实现里：
 *
 *   1. **不做阶段过滤**（§2.2「可选择」）：任意阶段的 Agent 都能装载库中任意条目。
 *      `listSkills` 只有 `enabledOnly` 一个过滤器，没有「阶段 → 可选 skill」映射——
 *      合不合适由装载它的人类判断，不由插件预设。
 *   2. **空集是合法状态**（§2.2「可为空」）：这里没有「至少一条」的强制。空库 `listSkills()`
 *      返回 `[]`（不是错误），人类清空某个会话的装载集合也不经过本服务。
 *
 * ── 会话隔离，以及删除为什么是软删除 ──
 *
 * §2.2「会话隔离」：装载在创建会话时冻结（`worker_sessions.skill_ids` 是 jsonb 快照，
 * 没有外键指向本表）。本服务只保证**自己不回溯改写历史**：它从不读、也从不写任何会话行，
 * 改动只对之后创建的会话生效。
 *
 * 删除因此是**软删除**（`disabled = true`），不是 `DELETE`：
 *   - 已创建会话的 `skill_ids` 仍按 id 引用这些条目。硬删除会让那些引用**悬空**——jsonb
 *     里的 id 没有任何外键约束挡着，失败完全静默（会话装载集合读不回来，也不报错）；
 *   - 更重的是取证：skill 正文是 Agent 实际遵循过的**指令文本**（§2.2「风险提示」）。
 *     硬删除等于销毁「那个会话当时被指示做什么」的证据，账本里只剩一个哈希。
 *
 * 「引用不会悬空」因此是一条**不变式**：本文件从不执行 `delete from pentest.skills`
 * （只有 insert / update / select），所以任何曾经被装载过的 id 永远可解析。停用只改变
 * 「能否被**新**会话勾选」，不改变历史会话能否读到正文。
 *
 * ── 内容哈希 ──
 *
 * `contentHash = sha256(canonicalJson({ name, description, body, revision }))`，
 * 见 {@link skillContentHash}。`revision` 参与是刻意的：每次被接受的修订都有唯一的
 * revision，于是也有唯一的哈希，「改掉又改回」不会被读成同一次修订。`disabled` 不参与
 * ——它是生命周期标记而非指令文本；任何改动都伴随 revision 递增，因此不会与同 revision
 * 的另一状态撞哈希。
 *
 * ── 审计（§2.2「新增操作记录操作者、时间与内容哈希」）──
 *
 * 三类写操作各写一条领域事件（`skill.added` / `skill.updated` / `skill.removed`）。幂等键
 * 是账本的既有唯一键 `(engagement_id, source_system, source_id, source_seq)`，其中
 * `sourceId = <event>:<skillId>:r<revision>`（`sourceSeq` 固定 1）——**同一 revision 重复写
 * 不产生第二条事件**。
 *
 * 三处必须明说的取舍：
 *   - **省略 `ledger` = 明确降级**：不注入就不写审计。这是给单测与本地装配留的口子；
 *     生产装配必须注入（§2.2 要求技能改动留痕）。
 *   - **审计归属 engagement 必须显式给出**：`context_events.engagement_id` 有指向
 *     `pentest.engagements` 的外键，而全局库没有自己的 engagement 列。所以注入 ledger
 *     时必须同时给 `auditEngagementId`（一个真实存在的 engagement）；只给 ledger 而不给
 *     归属会在**构造期**抛出，而不是到运行时静默丢事件。
 *   - **先落库、后审计，且不做补偿回滚**：审计失败直接抛出（§15.1 审计不可用即阻断）。
 *     补偿写自己也可能失败，会把一处偏差变成两处；而当前顺序的性质是「账本里不会有
 *     没发生过的改动的事件」（假事件比缺事件更糟），代价是账本不可用时事件缺一条——
 *     但那是响亮的失败，不是静默。
 *
 * 只依赖注入的 `DbClient`（`{ query(sql, params) }`，见 `src/memory/ledger.ts`），
 * 不持有连接池。
 */

import { canonicalJson } from '../canonical.ts';
import type {
  ErrorCode,
  MemoryLedgerService,
  PentestSkillService,
  SkillAddRequest,
  SkillListRequest,
  SkillRemoveRequest,
  SkillSummary,
  SkillUpdateRequest,
} from '../contracts.ts';
import { sha256Hex } from '../memory/chunks.ts';
import type { DbClient } from '../db/port.ts';

// ───────────────────────────── 错误 ─────────────────────────────

/**
 * skill 服务的拒绝路径。与 `ReportServiceError` 同约定：契约的 `ERROR_CODES` 没有
 * 「未找到 / 字段非法 / 名称冲突」这类取值，这些情况 `code` 为 `null`，靠可读的
 * message 让人（而不是模型分支）看懂原因。审计不可用时抛的是账本自己的
 * `LedgerError('audit_unavailable')`，不在这里包装。
 */
export class SkillServiceError extends Error {
  override readonly name = 'SkillServiceError';
  readonly code: ErrorCode | null;

  constructor(message: string, code: ErrorCode | null = null) {
    super(message);
    this.code = code;
  }
}

// ───────────────────────────── 取值与常量 ─────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL 唯一约束冲突的 SQLSTATE。重名由它最终裁决（先查后插之间有竞态窗口）。 */
const UNIQUE_VIOLATION = '23505';

/** 审计事件的来源系统名（全局库有自己的来源，不借用 engagement 局部的名字）。 */
const SKILL_AUDIT_SOURCE_SYSTEM = 'pentest-skill-library';

/** 新增时的初始修订号，与迁移 001 的列默认值一致。 */
const FIRST_REVISION = 1;

/**
 * CAS 重试上限。更新走「读 → 校验 → 带 revision 守卫的写」，两个人同时编辑同一条 skill
 * 时后写者会读到旧 revision 而被守卫挡下；重读后重试即可。人类操作频率极低，3 次足够，
 * 超过就说明有别的东西在改，应当响亮失败而不是无限重试。
 */
const MAX_CAS_ATTEMPTS = 3;

const CONTENT_REQUIREMENT = '名称、描述与正文三者非空（§2.2「可添加」）';
const AUDIT_REQUIREMENT = 'skill 正文是 Agent 会遵循的指令文本，改动必须可归因、可复核（§2.2）';

// ───────────────────────────── 内容哈希 ─────────────────────────────

/**
 * §2.2 的内容哈希：`sha256(canonicalJson({ name, description, body, revision }))`。
 *
 * 键排序 + 规范 JSON 保证同一逻辑内容得到同一哈希；`revision` 参与保证每个被接受的
 * 修订都有唯一哈希（§2.2 要的是「每次改动留痕」，同哈希的两次修订在审计里分不开）。
 */
export function skillContentHash(input: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly revision: number;
}): string {
  return sha256Hex(
    canonicalJson({
      name: input.name,
      description: input.description,
      body: input.body,
      revision: input.revision,
    }),
  );
}

// ───────────────────────────── 运行时窄化 ─────────────────────────────

/**
 * 取 driver 错误的 SQLSTATE（`pg` 在错误对象上放 `code`）。
 *
 * 不假设错误的具体类型、也不写类型断言：不是对象、没有 `code`、`code` 不是字符串时
 * 一律返回 `null`，调用方只与 SQLSTATE 常量比较。
 */
function sqlStateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
}

function requireText(value: unknown, field: string, requirement: string): string {
  if (typeof value !== 'string') {
    throw new SkillServiceError(`${field} 必须是字符串，实际为 ${JSON.stringify(value) ?? 'undefined'}`);
  }
  if (value.trim() === '') {
    throw new SkillServiceError(`${field} 不能为空：${requirement}`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new SkillServiceError(`${field} 必须是 uuid，实际为 ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

function toRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new SkillServiceError(`skills.revision 不是安全整数：${JSON.stringify(value) ?? 'undefined'}`);
}

function toBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SkillServiceError(`skills.${field} 不是布尔值：${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

function toIso(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new SkillServiceError(`skills.${field} 不是可解析时刻：${JSON.stringify(value) ?? 'undefined'}`);
  }
  return date.toISOString();
}

// ───────────────────────────── 数据库行形状 ─────────────────────────────

interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly content_hash: string;
  readonly added_by: string;
  readonly revision: number | string;
  readonly disabled: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const SKILL_COLUMNS =
  'id, name, description, body, content_hash, added_by, revision, disabled, created_at, updated_at';

const SQL_LIST_ALL = `select ${SKILL_COLUMNS} from pentest.skills order by name asc`;

const SQL_LIST_ENABLED = `
select ${SKILL_COLUMNS} from pentest.skills where disabled = false order by name asc`;

const SQL_FIND_BY_ID = `select ${SKILL_COLUMNS} from pentest.skills where id = $1::uuid`;

const SQL_FIND_BY_NAME = `select ${SKILL_COLUMNS} from pentest.skills where name = $1`;

const SQL_INSERT = `
insert into pentest.skills (name, description, body, content_hash, added_by, revision, disabled)
values ($1, $2, $3, $4, $5, $6, false)
returning ${SKILL_COLUMNS}`;

/**
 * CAS 写：`where id = $1 and revision = $8` 是守卫。读到的 revision 已被别人推进时
 * 影响 0 行，调用方重读重试——避免「两个人同时编辑，后写者静默覆盖前写者」。
 */
const SQL_UPDATE = `
update pentest.skills
   set name = $2,
       description = $3,
       body = $4,
       disabled = $5,
       revision = $6,
       content_hash = $7,
       updated_at = now()
 where id = $1::uuid and revision = $8
returning ${SKILL_COLUMNS}`;

function toSummary(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    revision: toRevision(row.revision),
    disabled: toBool(row.disabled, 'disabled'),
    contentHash: row.content_hash,
    addedBy: row.added_by,
    createdAt: toIso(row.created_at, 'created_at'),
    updatedAt: toIso(row.updated_at, 'updated_at'),
  };
}

/** 一条 skill 的当前可写状态（更新时由「读到的行 + 请求字段」推导出的完整新状态）。 */
interface SkillState {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly disabled: boolean;
  readonly revision: number;
}

/** 更新请求里显式给出的字段（未给出的保持原值）。 */
interface UpdateFields {
  readonly name?: string;
  readonly description?: string;
  readonly body?: string;
  readonly disabled?: boolean;
  readonly changedFields: readonly string[];
}

function readUpdateFields(input: SkillUpdateRequest): UpdateFields {
  const changed: string[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let body: string | undefined;
  let disabled: boolean | undefined;

  if (input.name !== undefined) {
    // name 是标识：去掉首尾空白后再比较与入库，避免「同一个名字因空格而看起来不冲突」。
    name = requireText(input.name, 'name', CONTENT_REQUIREMENT).trim();
    changed.push('name');
  }
  if (input.description !== undefined) {
    description = requireText(input.description, 'description', CONTENT_REQUIREMENT);
    changed.push('description');
  }
  if (input.body !== undefined) {
    // 正文是指令文本：只校验非空，原样保留（不 trim），免得改动缩进/换行的语义。
    body = requireText(input.body, 'body', CONTENT_REQUIREMENT);
    changed.push('body');
  }
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== 'boolean') {
      throw new SkillServiceError(
        `disabled 必须是布尔值，实际为 ${JSON.stringify(input.disabled) ?? 'undefined'}`,
      );
    }
    disabled = input.disabled;
    changed.push('disabled');
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(body === undefined ? {} : { body }),
    ...(disabled === undefined ? {} : { disabled }),
    changedFields: changed,
  };
}

function nextState(current: SkillState, fields: UpdateFields): SkillState {
  return {
    name: fields.name ?? current.name,
    description: fields.description ?? current.description,
    body: fields.body ?? current.body,
    disabled: fields.disabled ?? current.disabled,
    revision: current.revision + 1,
  };
}

function duplicateNameError(name: string, id: string | null): SkillServiceError {
  const where = id === null ? '' : `（已存在的是 ${id}）`;
  return new SkillServiceError(
    `skill 名称「${name}」已被占用${where}：names 是全局唯一的（§16.2 的库是全局库），` +
      '请换一个名字或修改已有条目',
    'skill_name_taken',
  );
}

// ───────────────────────────── 服务 ─────────────────────────────

interface PgSkillServiceOptions {
  /**
   * 审计账本（§2.2 要求技能改动留痕）。省略即**明确降级**：不写审计。
   * 提供它时必须同时给出 {@link auditEngagementId}。
   */
  readonly ledger?: MemoryLedgerService;
  /**
   * 审计事件的归属 engagement（uuid，且必须真实存在——`context_events.engagement_id`
   * 有外键）。全局库没有自己的 engagement 列，这个归属只能由装配方指定。
   */
  readonly auditEngagementId?: string;
}

/** 审计落点：账本 + 归属。二者缺一不可，因此绑成一个对象，避免「有账本没归属」的中间态。 */
interface SkillAuditTarget {
  readonly ledger: MemoryLedgerService;
  readonly engagementId: string;
}

export class PgSkillService implements PentestSkillService {
  readonly #db: DbClient;
  readonly #audit: SkillAuditTarget | null;

  constructor(db: DbClient, options: PgSkillServiceOptions = {}) {
    this.#db = db;

    const ledger = options.ledger ?? null;
    const engagementId = options.auditEngagementId;
    if (ledger === null) {
      this.#audit = null;
    } else {
      this.#audit = { ledger, engagementId: requireUuid(engagementId, 'auditEngagementId') };
    }
  }

  /** §2.2「可选择」：不过滤阶段，只按 `enabledOnly` 过滤。默认连停用的也返回（见文件头）。 */
  async listSkills(input: SkillListRequest = {}): Promise<readonly SkillSummary[]> {
    const result = await this.#db.query<SkillRow>(
      input.enabledOnly === true ? SQL_LIST_ENABLED : SQL_LIST_ALL,
    );
    return result.rows.map(toSummary);
  }

  async addSkill(input: SkillAddRequest): Promise<SkillSummary> {
    const operatorId = requireText(input.operatorId, 'operatorId', AUDIT_REQUIREMENT).trim();
    const reason = requireText(input.reason, 'reason', AUDIT_REQUIREMENT);
    const name = requireText(input.name, 'name', CONTENT_REQUIREMENT).trim();
    const description = requireText(input.description, 'description', CONTENT_REQUIREMENT);
    const body = requireText(input.body, 'body', CONTENT_REQUIREMENT);

    // 先查一次是为了给出可读的拒绝；最终裁判仍是 UNIQUE 约束（两次调用之间的竞态窗口）。
    const clash = await this.#findByName(name);
    if (clash !== null) throw duplicateNameError(name, clash.id);

    const contentHash = skillContentHash({ name, description, body, revision: FIRST_REVISION });
    let row: SkillRow | undefined;
    try {
      const result = await this.#db.query<SkillRow>(SQL_INSERT, [
        name,
        description,
        body,
        contentHash,
        operatorId,
        FIRST_REVISION,
      ]);
      row = result.rows[0];
    } catch (error) {
      if (sqlStateOf(error) === UNIQUE_VIOLATION) throw duplicateNameError(name, null);
      throw error;
    }
    if (row === undefined) {
      throw new SkillServiceError('新增 skill 未返回行：拒绝在不知道落库结果时继续（审计需要真实 revision）');
    }

    const summary = toSummary(row);
    await this.#appendAudit({
      eventType: 'skill.added',
      summary,
      previousRevision: null,
      operatorId,
      reason,
      changedFields: ['name', 'description', 'body'],
    });
    return summary;
  }

  async updateSkill(input: SkillUpdateRequest): Promise<SkillSummary> {
    const operatorId = requireText(input.operatorId, 'operatorId', AUDIT_REQUIREMENT).trim();
    const reason = requireText(input.reason, 'reason', AUDIT_REQUIREMENT);
    const skillId = requireUuid(input.skillId, 'skillId');
    const fields = readUpdateFields(input);
    if (fields.changedFields.length === 0) {
      throw new SkillServiceError(
        'updateSkill 没有给出任何要修改的字段：空修订会让 revision 无意义地递增，请在请求里给出 name/description/body/disabled 之一',
      );
    }

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#findById(skillId);
      if (current === null) {
        throw new SkillServiceError(`skill ${skillId} 不存在：无法更新（已停用的条目仍可更新）`);
      }
      if (fields.name !== undefined && fields.name !== current.name) {
        const clash = await this.#findByName(fields.name);
        if (clash !== null && clash.id !== skillId) throw duplicateNameError(fields.name, clash.id);
      }

      const next = nextState(current, fields);
      const row = await this.#casWrite(skillId, current.revision, next);
      if (row !== null) {
        const summary = toSummary(row);
        await this.#appendAudit({
          eventType: 'skill.updated',
          summary,
          previousRevision: current.revision,
          operatorId,
          reason,
          changedFields: fields.changedFields,
        });
        return summary;
      }
    }

    throw new SkillServiceError(
      `skill ${skillId} 连续 ${String(MAX_CAS_ATTEMPTS)} 次在编辑中被人改动：请刷新后重试（未写入任何改动）`,
    );
  }

  /**
   * 删除 = **软删除**（`disabled = true` + revision 递增），理由见文件头。
   *
   * 幂等：对已停用的 skill 再次调用是**无操作**——状态已经是调用方要求的样子，就不再
   * 递增 revision、也不再写审计事件（否则连点两次删除会在账本里留下两条「删除」，
   * 让人以为发生了两次改动）。要恢复请走 `updateSkill({ disabled: false })`。
   */
  async removeSkill(input: SkillRemoveRequest): Promise<void> {
    const operatorId = requireText(input.operatorId, 'operatorId', AUDIT_REQUIREMENT).trim();
    const reason = requireText(input.reason, 'reason', AUDIT_REQUIREMENT);
    const skillId = requireUuid(input.skillId, 'skillId');

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#findById(skillId);
      if (current === null) {
        throw new SkillServiceError(`skill ${skillId} 不存在：无法删除`);
      }
      if (current.disabled) return; // 已是删除态：幂等返回

      const next: SkillState = { ...current, disabled: true, revision: current.revision + 1 };
      const row = await this.#casWrite(skillId, current.revision, next);
      if (row !== null) {
        await this.#appendAudit({
          eventType: 'skill.removed',
          summary: toSummary(row),
          previousRevision: current.revision,
          operatorId,
          reason,
          changedFields: ['disabled'],
        });
        return;
      }
    }

    throw new SkillServiceError(
      `skill ${skillId} 连续 ${String(MAX_CAS_ATTEMPTS)} 次在删除中被人改动：请刷新后重试（未写入任何改动）`,
    );
  }

  // ───────────────────────── 内部 ─────────────────────────

  async #findById(skillId: string): Promise<SkillState | null> {
    const result = await this.#db.query<SkillRow>(SQL_FIND_BY_ID, [skillId]);
    const row = result.rows[0];
    return row === undefined ? null : stateOf(row);
  }

  async #findByName(name: string): Promise<{ readonly id: string } | null> {
    const result = await this.#db.query<{ readonly id: string }>(SQL_FIND_BY_NAME, [name]);
    return result.rows[0] ?? null;
  }

  /** 带 revision 守卫的写。守卫不匹配（影响 0 行）返回 `null`，由调用方重读重试。 */
  async #casWrite(skillId: string, expectedRevision: number, next: SkillState): Promise<SkillRow | null> {
    const contentHash = skillContentHash({
      name: next.name,
      description: next.description,
      body: next.body,
      revision: next.revision,
    });
    let result;
    try {
      result = await this.#db.query<SkillRow>(SQL_UPDATE, [
        skillId,
        next.name,
        next.description,
        next.body,
        next.disabled,
        next.revision,
        contentHash,
        expectedRevision,
      ]);
    } catch (error) {
      // 重命名撞上别人刚插入的同名条目：同样是可读的重名拒绝。
      if (sqlStateOf(error) === UNIQUE_VIOLATION) throw duplicateNameError(next.name, null);
      throw error;
    }
    return result.rows[0] ?? null;
  }

  /**
   * 写一条审计事件。没有注入账本时**明确降级**（不写、不假装写了）——文件头已说明这是
   * 给单测/本地装配留的口子，生产装配必须注入。
   */
  async #appendAudit(input: {
    readonly eventType: 'skill.added' | 'skill.updated' | 'skill.removed';
    readonly summary: SkillSummary;
    readonly previousRevision: number | null;
    readonly operatorId: string;
    readonly reason: string;
    readonly changedFields: readonly string[];
  }): Promise<void> {
    const audit = this.#audit;
    if (audit === null) return;

    const payload = {
      skillId: input.summary.id,
      name: input.summary.name,
      revision: input.summary.revision,
      previousRevision: input.previousRevision,
      contentHash: input.summary.contentHash,
      disabled: input.summary.disabled,
      changedFields: [...input.changedFields],
      operatorId: input.operatorId,
      reason: input.reason,
    };
    await audit.ledger.appendEvent({
      engagementId: audit.engagementId,
      workerSessionId: null,
      eventType: input.eventType,
      sourceSystem: SKILL_AUDIT_SOURCE_SYSTEM,
      // 幂等键：同一 revision 的同一事件重复写只留一条（账本按
      // (engagement_id, source_system, source_id, source_seq) 去重）。
      sourceId: `${input.eventType}:${input.summary.id}:r${String(input.summary.revision)}`,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload,
      rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
      // 全局库条目是人工维护的指令文本，按 engagement 级分类、人类决策级可信度记录。
      classification: 'engagement',
      trustLevel: 'human_decision',
    });
  }
}

function stateOf(row: SkillRow): SkillState {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    disabled: toBool(row.disabled, 'disabled'),
    revision: toRevision(row.revision),
  };
}
