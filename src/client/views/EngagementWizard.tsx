/**
 * 授权与范围向导：engagement 的建立入口。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §11.1、§6.1、§13.1
 *
 * ── 这一步只建立能力边界 ──
 *
 * §1.2 的分工：向导产出的是**授权、目标、范围、排除项与规则**，它不创建任何 Agent、
 * 不启动任何会话。首个 Worker 由人类在建立之后显式启动（§6.1「选择起始阶段并启动
 * Agent」）。界面必须把这一点说出来——否则人类会以为「确认」就等于「开打」。
 *
 * ── 范围校验走服务端端点 ──
 *
 * §13.1 要求「服务端规范化并校验 → 展示最终范围与限制 → 人类确认」。
 * 范围规范化是**安全边界**，它必须只有一份实现，因此本组件**不复制**服务端策略代码
 * （也不把 `src/policy/scope.ts` 打进浏览器产物）。做法是：
 *
 *   人类点「校验范围」→ 调用方发 `previewScope` 端点 → 结论经 `scopePreview` 传回 →
 *   界面按行展示服务端裁定。
 *
 * 这样「界面的结论」与「服务端落库时的校验」永远同源（同一函数、同一版本），
 * 浏览器产物里也不含策略代码。代价是多一次显式的人类动作——而它本来就是向导该有的一步
 * （避免人类填完整张表才被打回）。
 *
 * ── 必填与闸门 ──
 *
 * §11.1 的**两项**必填：名称、至少一个目标。授权依据引用与到期时间是可选的高级项
 * （留空即走安全默认值）。缺任一项时**提交按钮禁用并说明
 * 原因**（`Button` 的 `reason`），而不是提交后由服务端拒绝——闸门要可见。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ANY_PORT, APPROVAL_MODES, BEHAVIOR_PROFILES, CUSTOM_GUIDANCE_MAX_CHARS, SCOPE_ENTRY_PROFILES } from '../../contracts.ts';
import type { ApprovalMode } from '../../contracts.ts';
import { APPROVAL_MODE_HINTS, APPROVAL_MODE_LABELS, BEHAVIOR_PROFILE_HINTS, BEHAVIOR_PROFILE_LABELS } from '../presets.ts';
import type { BehaviorProfile, Protocol, ScopeEntryProfile, ScopeTarget } from '../../contracts.ts';
import type { ConsoleController } from '../controller.ts';
import type { PreviewScopeInput, ScopePreview, ScopePreviewEntry } from '../../contracts.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, Table, TextArea, TextInput } from '../ui.tsx';

// ───────────────────────────── 文案与选项（集中在此，便于将来接入 locale） ─────────────────────────────

const CARD_TITLE = '授权与范围向导';

/** §1.2：向导不创建 Agent。这句话必须出现在确认之前。 */
const NO_AGENT_NOTICE =
  '这里只会建立授权与范围（范围版本 1），不会创建任何 Agent；首个 Worker 由你在建立之后显式启动。';

const SCOPE_ACK_LABEL =
  '我已核对以上目标、排除项、授权的动作类别与服务端将展开的行为预设，并确认它们在授权范围内（§13.1）';

const TARGET_KIND_LABELS: Readonly<Record<ScopeTarget['kind'], string>> = {
  domain: '域名',
  ip: 'IP',
  cidr: '网段',
  url: 'URL',
  'asset-label': '资产标签',
};

const PROTOCOL_OPTIONS: readonly { readonly id: Protocol; readonly label: string }[] = [
  { id: 'tcp', label: 'TCP' },
  { id: 'udp', label: 'UDP' },
  { id: 'icmp', label: 'ICMP' },
];

/**
 * 类型下拉的顺序表。
 *
 * 由标签表的键导出（`Object.keys` 保持插入顺序），因此**不可能与标签表脱节**：
 * 新增一种条目类型时，`Record<ScopeTarget['kind'], string>` 会先逼标签表补齐，
 * 这里自动跟上——不需要维护第二份清单。
 */
const TARGET_KINDS: readonly ScopeTarget['kind'][] = Object.keys(TARGET_KIND_LABELS).filter(isTargetKind);

/**
 * 范围入口与行为预设的展示名。
 *
 * 键类型写成 `Record<ScopeEntryProfile, string>` 而不是自由字符串：契约导出的
 * `SCOPE_ENTRY_PROFILES`/`BEHAVIOR_PROFILES` 一旦增删成员，这里会立刻编译失败——
 * 展示名清单不可能与契约脱节。
 */
const SCOPE_ENTRY_PROFILE_LABELS: Readonly<Record<ScopeEntryProfile, string>> = {
  ip: 'IP',
  domain: '域名',
  cidr: '网段',
  custom: '自定义',
};

const WEEKDAYS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'mon', label: '周一' },
  { id: 'tue', label: '周二' },
  { id: 'wed', label: '周三' },
  { id: 'thu', label: '周四' },
  { id: 'fri', label: '周五' },
  { id: 'sat', label: '周六' },
  { id: 'sun', label: '周日' },
];

// ───────────────────────────── 表单状态 ─────────────────────────────

/** 一条目标/排除项的可编辑形态。与 `ScopeTarget` 的差别只在端口是文本（便于人类书写）。 */
interface TargetRow {
  readonly kind: ScopeTarget['kind'];
  readonly value: string;
  readonly protocols: readonly Protocol[];
  /** `80,443,8000-8100`；留空表示按条目类型的默认语义（见下方提示）。 */
  readonly portsText: string;
}

interface WizardForm {
  readonly name: string;
  readonly publicMemory: string;
  readonly authorizationRef: string;
  readonly authorizationExpiresAt: string;
  readonly reason: string;
  /** §6.2.0.5：范围入口语义；只描述怎么填目标，条目规范化仍由服务端做。 */
  readonly scopeEntryProfile: ScopeEntryProfile;
  /**
   * §6.2.0.5：行为预设——**必选项**，未选时为 `null`（没有默认值）。
   *
   * 它决定注入 Agent 的行为指引（场景差异）与宿主侧节奏，服务端展开后冻结成策略快照。
   */
  readonly behaviorProfile: BehaviorProfile | null;
  /** `custom` 预设的自定义指引（人类自己写的行为提示词；只有 custom 用得上）。 */
  readonly customGuidance: string;
  /** 审批模式——**必选项**，未选时为 `null`（没有默认值）。 */
  readonly approvalMode: ApprovalMode | null;
  readonly targets: readonly TargetRow[];
  readonly exclusions: readonly TargetRow[];
  readonly allowedTestTypes: string;
  readonly rateLimitPerSecond: string;
  readonly maxConcurrency: string;
  readonly maxImpact: string;
  readonly credentialRule: string;
  readonly dataHandling: string;
  readonly emergencyContact: string;
  readonly stopConditions: string;
  readonly timezone: string;
  readonly allowedDays: readonly string[];
  readonly windowFrom: string;
  readonly windowTo: string;
  /** §13.1「人类确认」的落点。 */
  readonly acknowledged: boolean;
}

/**
 * 表单初值。
 *
 * 存在的理由不是「方便测试」，而是部署配置（§12.2）本来就有默认值：授权依据引用的
 * 登记方式、默认测试类型、时区、紧急停止联系人都随部署而定，逐个手填既慢又容易漏。
 * 其余字段（尤其是名称与到期时间）**刻意不给默认值**：它们必须是一次有意的决定。
 */
interface EngagementWizardDefaults {
  readonly name?: string;
  readonly publicMemory?: string;
  readonly authorizationRef?: string;
  readonly authorizationExpiresAt?: string;
  readonly targets?: readonly ScopeTarget[];
  readonly exclusions?: readonly ScopeTarget[];
  /** 部署级默认范围入口；省略即 `custom`（与服务端省略时的兼容默认一致）。 */
  readonly scopeEntryProfile?: ScopeEntryProfile;
  /** 部署级默认行为预设；省略即不预选（预设是必选项）。 */
  readonly behaviorProfile?: BehaviorProfile;
  /** 部署级默认审批模式；省略即不预选（审批模式是必选项）。 */
  readonly approvalMode?: ApprovalMode;
  readonly allowedTestTypes?: string;
  readonly rateLimitPerSecond?: string;
  readonly maxConcurrency?: string;
  readonly maxImpact?: string;
  readonly emergencyContact?: string;
  readonly timezone?: string;
}

interface EngagementWizardProps {
  /** 提交走控制器封装的 `createEngagement`（§6.2.3、§16.1）。 */
  readonly controller: ConsoleController;
  readonly defaults?: EngagementWizardDefaults;
  /** 提交成功后的回调（调用方据此收起向导或跳到列表）。 */
  readonly onCreated?: (engagementId: string) => void;
  readonly onCancel?: () => void;
  /**
   * 服务端的范围预校验结果（`previewScope` 端点的返回）。
   *
   * **经由 props 传入而不是视图自己调策略模块**：范围规范化是**安全边界**，
   * 它必须只有一份实现（服务端的那份）。让浏览器复制一份、或把服务端策略模块
   * 打进客户端产物，都会导致两者漂移——而漂移的后果是「界面说没问题、服务端整体拒绝」
   * 或更糟的反向情况。
   *
   * 因此视图只做两件事：把待校验的行交给调用方，把结论展示出来。
   */
  readonly scopePreview?: ScopePreview;
  /**
   * 请求服务端校验这些范围条目。
   *
   * 由**人类的动作**触发（点击「校验范围」按钮），不在渲染期调用——
   * 渲染期发请求既破坏服务端渲染，也会让输入过程中无谓地打服务端。
   */
  readonly onRequestPreview?: (input: PreviewScopeInput) => void;
  /** 注入的「现在」：授权是否已过期按它判定，渲染保持确定性（测试用）。 */
  readonly now?: Date;
}

const EMPTY_ROW: TargetRow = { kind: 'domain', value: '', protocols: ['tcp'], portsText: '' };

function toRow(target: ScopeTarget): TargetRow {
  return {
    kind: target.kind,
    value: target.value,
    protocols: target.protocols,
    portsText: formatPortsForInput(target.ports),
  };
}

/**
 * 把已填写的行转成契约的范围条目，供发送给服务端校验。
 *
 * 端口无法解析时给空数组而不是放弃整行：**那一行的端口问题由本地闸门拦下**
 * （`checkRow` 会显示解析错误），而空端口让服务端能对**其余部分**给出结论
 * （例如目标形态是否合法）。让一行的小问题遮蔽整行的其它判定，对人类没有帮助。
 */
function toPreviewTargets(rows: readonly TargetRow[]): readonly ScopeTarget[] {
  return filledRows(rows).map((row) => {
    const parsed = parsePorts(row.portsText);
    return toScopeTarget(row, parsed.ok ? parsed.ports : []);
  });
}

function initialForm(defaults: EngagementWizardDefaults | undefined): WizardForm {
  return {
    name: defaults?.name ?? '',
    publicMemory: defaults?.publicMemory ?? '',
    authorizationRef: defaults?.authorizationRef ?? '',
    authorizationExpiresAt: defaults?.authorizationExpiresAt ?? '',
    reason: '授权向导确认建立 engagement 并冻结范围版本 1',
    // 默认与服务端省略时的兜底值保持一致：这样「界面上显示的就是服务端会存的」，
    // 不选也不会有意料之外的偏移。
    scopeEntryProfile: defaults?.scopeEntryProfile ?? 'custom',
    // 行为预设**不再预选**：它是每个作业的必选项，预选等于替人类做了决定。
    behaviorProfile: defaults?.behaviorProfile ?? null,
    customGuidance: '',
    // 审批模式也不预选：它决定「预设内的命令要不要人类过目」，不能让默认值替人做决定。
    approvalMode: defaults?.approvalMode ?? null,
    targets: defaults?.targets === undefined ? [EMPTY_ROW] : defaults.targets.map(toRow),
    exclusions: defaults?.exclusions === undefined ? [] : defaults.exclusions.map(toRow),
    allowedTestTypes: defaults?.allowedTestTypes ?? '',
    rateLimitPerSecond: defaults?.rateLimitPerSecond ?? '',
    maxConcurrency: defaults?.maxConcurrency ?? '',
    maxImpact: defaults?.maxImpact ?? '',
    credentialRule: '',
    dataHandling: '',
    emergencyContact: defaults?.emergencyContact ?? '',
    stopConditions: '',
    timezone: defaults?.timezone ?? 'Asia/Shanghai',
    allowedDays: WEEKDAYS.map((day) => day.id),
    windowFrom: '',
    windowTo: '',
    acknowledged: false,
  };
}

// ───────────────────────────── 校验与载荷 ─────────────────────────────

/** 端口文本 → 端口区间；`0-65535` 即显式的「任意端口」（§10.2.2）。 */
type PortParse =
  | { readonly ok: true; readonly ports: readonly { readonly from: number; readonly to: number }[] }
  | { readonly ok: false; readonly detail: string };

function parsePorts(text: string): PortParse {
  const tokens = text
    .split(/[,，\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const ports: { readonly from: number; readonly to: number }[] = [];
  for (const token of tokens) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token);
    if (match === null) {
      return { ok: false, detail: `端口写法无法解析：${token}（合法形态：80、443、8000-8100）` };
    }
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from > 65535 || to > 65535) {
      return { ok: false, detail: `端口超出 0-65535：${token}` };
    }
    if (from > to) {
      return { ok: false, detail: `端口区间起点大于终点：${token}` };
    }
    ports.push({ from, to });
  }
  return { ok: true, ports };
}

function formatPortsForInput(ports: readonly { readonly from: number; readonly to: number }[]): string {
  return ports
    .map((range) => (range.from === range.to ? String(range.from) : `${String(range.from)}-${String(range.to)}`))
    .join(',');
}

/** 已填写值的行：空值行是「还没写」，不是错误，提交时不含它们。 */
function filledRows(rows: readonly TargetRow[]): readonly TargetRow[] {
  return rows.filter((row) => row.value.trim().length > 0);
}

function toScopeTarget(row: TargetRow, ports: readonly { readonly from: number; readonly to: number }[]): ScopeTarget {
  const value = row.value.trim();
  return {
    kind: row.kind,
    value,
    protocols: row.protocols,
    ports,
    // §10.2.2：仅显式写出的 `*.example.com` 为 true（由值本身决定，不另设开关）
    wildcardSubdomain: value.startsWith('*.') || row.kind === 'asset-label',
  };
}

/** 一行条目的规范化预览结果。 */
interface PreviewRow {
  /** 行标识：同一目标可能既出现在目标里也出现在排除里，值本身不唯一。 */
  readonly key: string;
  readonly section: string;
  readonly kind: string;
  readonly value: string;
  readonly normalized: string;
  readonly protocols: string;
  readonly ports: string;
  readonly verdict: string;
  readonly tone: 'neutral' | 'done' | 'danger';
}

interface RowCheck {
  readonly row: TargetRow;
  readonly ok: boolean;
  /** 校验失败时的稳定错误码（§10.2.2 的拒绝码）。 */
  readonly code: string | null;
  readonly detail: string | null;
  readonly ports: readonly { readonly from: number; readonly to: number }[] | null;
  /** 规范化后的稳定键；校验失败时为 null。 */
  readonly normalized: string | null;
}

/**
 * 校验一行范围条目。
 *
 * **判定来自服务端**（`preview` 是该行的 `ScopePreviewEntry`），因此
 * 「界面的结论」与「服务端后续的加载校验」永远是同一个函数算出来的。
 * 视图自己只做**不需要策略知识的**本地检查（端口文本能不能解析）。
 *
 * `preview` 为 `undefined` 表示尚未校验——此时显示「尚未校验」而不是猜一个结论：
 * 猜错的两个方向都有害（说可提交而服务端拒绝、或说被拒而其实可以）。
 */
function checkRow(row: TargetRow, preview: ScopePreviewEntry | undefined): RowCheck {
  const ports = parsePorts(row.portsText);
  if (!ports.ok) {
    return { row, ok: false, code: 'malformed_target', detail: ports.detail, ports: null, normalized: null };
  }
  if (row.protocols.length === 0) {
    return {
      row,
      ok: false,
      code: 'protocol_undetermined',
      detail: '未声明协议集合，协议无法确定（§10.2.2）',
      ports: null,
      normalized: null,
    };
  }
  if (preview === undefined) {
    return {
      row,
      ok: false,
      code: null,
      detail: '尚未校验：点「校验范围」由服务端裁定（范围规范化只有服务端一份实现）',
      ports: ports.ports,
      normalized: null,
    };
  }
  if (preview.rejectionCode !== null) {
    return {
      row,
      ok: false,
      code: preview.rejectionCode,
      detail: preview.detail,
      ports: null,
      normalized: null,
    };
  }
  return { row, ok: true, code: null, detail: null, ports: ports.ports, normalized: preview.canonical };
}

/** 留空端口的语义由条目类型决定（§10.2.2），必须写出来，不能让人类猜。 */
function portsTextOf(check: RowCheck): string {
  if (check.ports === null) return '—';
  if (check.row.protocols.length === 1 && check.row.protocols[0] === 'icmp') return '无端口维度（ICMP）';
  if (check.ports.length > 0) {
    const any = check.ports.some((range) => range.from === 0 && range.to === 65535);
    return `${formatPortsForInput(check.ports)}${any ? '（任意端口）' : ''}`;
  }
  // 留空对**所有类型**都是「默认 80/443」。此前网段与资产标签会被拒，现在一致了——
  // 想表达「任意端口」要显式勾选，那会记入范围版本与放行记录。
  return '默认端口 80/443';
}

/**
 * 构造预览行。
 *
 * `previewEntries` 的下标与 `filledRows(rows)` 对齐——调用方发送校验请求时必须
 * 用**同样的过滤**（跳过全空行），否则结论会错位到别的行上。
 * 这个对齐约定由 `onRequestPreview` 的参数类型承载：调用方拿到的就是 filled 后的数组。
 */
function previewRows(
  section: string,
  rows: readonly TargetRow[],
  previewEntries: readonly ScopePreviewEntry[] | undefined,
): readonly PreviewRow[] {
  return filledRows(rows).map((row, index) => {
    const check = checkRow(row, previewEntries?.[index]);
    return {
      key: `${section}-${String(index)}`,
      section,
      kind: TARGET_KIND_LABELS[row.kind],
      value: row.value.trim(),
      normalized: check.normalized ?? '—',
      protocols: row.protocols.map((p) => p.toUpperCase()).join('/'),
      ports: portsTextOf(check),
      verdict: check.ok ? '可提交' : `${check.code ?? 'unknown'}：${check.detail ?? ''}`,
      tone: check.ok ? 'done' : 'danger',
    };
  });
}

function splitList(text: string): readonly string[] {
  return text
    .split(/[,，\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function splitLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * 规则记录（§11.1：允许的测试类型、速率、并发、最大影响、凭据规则、数据规则、
 * 紧急停止联系人与停止条件）。
 *
 * 键用 snake_case，与设计文档里落库的 JSON（§7.1 报告、§7.3 交接包）保持一致；
 * `roe` 在契约里是 `Record<string, unknown>`（jsonb），因此这套键是本实现定义的，
 * 策略侧读取时必须与此处字面一致。
 */
function buildRoe(form: WizardForm): Readonly<Record<string, unknown>> {
  return {
    allowed_test_types: splitList(form.allowedTestTypes),
    rate_limit_per_second: numberOrNull(form.rateLimitPerSecond),
    max_concurrency: numberOrNull(form.maxConcurrency),
    max_impact: form.maxImpact.trim(),
    credential_rule: form.credentialRule.trim(),
    data_handling: form.dataHandling.trim(),
    emergency_contact: form.emergencyContact.trim(),
    stop_conditions: splitLines(form.stopConditions),
  };
}

/** 时间窗（§11.1：允许执行的时间段）。同样由本实现定义键名。 */
function buildTimeWindow(form: WizardForm): Readonly<Record<string, unknown>> {
  return {
    timezone: form.timezone.trim(),
    allowed_days: form.allowedDays,
    from: form.windowFrom.trim(),
    to: form.windowTo.trim(),
  };
}

/** 提交载荷：与 `controller.createEngagement` 的参数形状**逐字对齐**（含 `reason`）。 */
interface CreateEngagementParams {
  readonly name: string;
  /**
   * 以下三项可选，省略即由服务端用默认值（见 `CreateEngagementInput`）：
   * `authorizationRef` / `authorizationExpiresAt` / `publicMemory`。
   *
   * **`targets` 不在此列**——它必填，且服务端对空范围直接拒绝。
   */
  readonly authorizationRef?: string;
  readonly authorizationExpiresAt?: string;
  readonly publicMemory?: string;
  /**
   * 范围入口与行为预设：**始终发送**（`buildParams` 不是条件展开）。
   *
   * 范围入口的兜底值是服务端的兼容默认，而界面上呈现给人类的就是当前选择；
   * 若这里也按「有值才发」省略，人类看到的与最终冻结的之间会多一道服务端默认值的
   * 二次解释——发送界面上的值才不会有这层偏差。
   */
  readonly scopeEntryProfile?: ScopeEntryProfile;
  /** 行为预设：**必发**（服务端要求必选，缺了会被拒）。 */
  readonly behaviorProfile: BehaviorProfile;
  /** 审批模式：**必发**（服务端要求必选）。 */
  readonly approvalMode: ApprovalMode;
  /** `custom` 指引：只在真有内容时发送（空串与省略在服务端同义）。 */
  readonly customGuidance?: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly roe: Readonly<Record<string, unknown>>;
  readonly timeWindow: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export function EngagementWizard(props: EngagementWizardProps): ReactNode {
  const [form, setForm] = useState<WizardForm>(() => initialForm(props.defaults));
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 「高级选项」是否展开。
   *
   * 默认**收起**：必填项只有名称与目标，其余都能留空（服务端有安全默认值）。
   * 这也让向导的首屏从 13 个字段降到 3 个。
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  /**
   * 服务端返回的策略投影。
   *
   * 缺字段时保持 null，渲染时显示占位——「服务端没给」与「服务端给了某个值」
   * 必须可区分，不能替服务端编一个版本号或哈希。
   */
  const [createdPolicy, setCreatedPolicy] = useState<PolicyProjection | null>(null);

  const patch = (next: Partial<WizardForm>): void => { setForm((current) => ({ ...current, ...next })); };

  const targetChecks = filledRows(form.targets).map((row, index) =>
    checkRow(row, props.scopePreview?.targets[index]));
  const exclusionChecks = filledRows(form.exclusions).map((row, index) =>
    checkRow(row, props.scopePreview?.exclusions[index]));
  const gates = collectGates(form, targetChecks, exclusionChecks, props.now);
  const blocked = gates.length > 0 || busy || createdId !== null;
  const preview = [
    ...previewRows('目标', form.targets, props.scopePreview?.targets),
    ...previewRows('排除', form.exclusions, props.scopePreview?.exclusions),
  ];

  /**
   * 请求服务端校验当前填写的范围条目（§13.1「展示服务端规范化后的最终范围与限制」）。
   *
   * 发送的是 `filledRows(...)` 的结果——与视图渲染预览时用的是同一个过滤，
   * 因此服务端结论的下标与界面上的行一一对应。
   */
  const requestPreview = (): void => {
    props.onRequestPreview?.({
      targets: toPreviewTargets(form.targets),
      exclusions: toPreviewTargets(form.exclusions),
    });
  };

  const submit = (): void => {
    // 闸门之外再拦一次：`gates` 只驱动按钮的 disabled，而 disabled 不是安全边界
    // （键盘回车、脚本点击、React 状态竞态都能绕过它）。
    const profile = form.behaviorProfile;
    if (profile === null) {
      setError({ code: 'behavior_profile_required', message: '请先选择行为预设（必选项，没有默认值）' });
      return;
    }
    if (profile === 'custom' && form.customGuidance.trim() === '') {
      setError({ code: 'custom_guidance_required', message: '自定义预设必须写一段指引（它是注入会话的行为指引本体）' });
      return;
    }
    const mode = form.approvalMode;
    if (mode === null) {
      setError({ code: 'approval_mode_required', message: '请先选择审批模式（必选项，没有默认值）' });
      return;
    }
    setBusy(true);
    setError(null);
    props.controller
      .createEngagement(buildParams(form, profile, mode))
      .then((result) => {
        if (!result.ok) {
          setError({ code: result.code, message: result.message });
          return;
        }
        const id = engagementIdOf(result.value);
        setCreatedId(id ?? '（服务端未返回标识）');
        setCreatedPolicy(policyProjectionOf(result.value));
        // 标识拿不到时不回调：把占位文本当标识传出去，调用方会跳到一个不存在的地方
        if (id !== null) props.onCreated?.(id);
      })
      .catch((cause: unknown) => {
        setError({
          code: 'client_call_failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Card title={CARD_TITLE}>
      <p className="pentest-wizard__notice">{NO_AGENT_NOTICE}</p>

      {error === null ? null : <ErrorBar code={error.code} message={error.message} />}
      {createdId === null ? null : (
        <>
          <p className="pentest-wizard__done">
            <Badge text="已建立" tone="done" />
            engagement {createdId} 已创建（状态 READY）。下一步由你显式启动首个 Agent。
          </p>
          {/* 策略投影：人类刚建完最需要核对的不是「建成功了」，而是「服务端最终冻结了哪套预设」。 */}
          <p className="pentest-wizard__done">
            策略 {createdPolicy === null ? 'v—' : `v${String(createdPolicy.policyVersion)}`} · 快照哈希{' '}
            {createdPolicy === null ? '—（服务端未返回）' : createdPolicy.policySnapshotHash}
          </p>
        </>
      )}

      {/* ── ① 必填部分：只有两件事 ──
          此前这里有 13 个字段平铺在同一个卡片里，其中 9 个（测试类型/速率/并发/最大影响/
          凭据规则/数据规则/时区/时间窗/紧急停止）**在代码里没有任何读取方**，却和必填项
          一样显眼。现在只留「叫什么」与「打什么」，其余收进下方的「高级选项」。 */}
      <div className="pentest-wizard">
        <div className="pentest-wizard__section">
      {/* ① 名称（唯一与授权并列的必填文本项） */}
      <Field label="名称">
        <TextInput
          value={form.name}
          onChange={(next) => { patch({ name: next }); }}
          placeholder="例如：内部靶场 A 轮"
        />
      </Field>
        </div>

        {/* ⓪ 范围入口与行为预设：把「这条授权是什么形状」先钉下来。
            它们是服务端展开策略快照的输入，因此在填具体目标之前就要选定——
            顺序反过来会让人先填完目标才发现预期的行为基线不同。 */}
        <div className="pentest-wizard__section">
          <h4 className="pentest-wizard__section-title">范围入口与行为预设</h4>
          <Field
            label="范围入口"
            hint="范围入口只描述怎么填目标，具体条目仍按 §10.2.2 由服务端规范化。"
          >
            <select
              className="pentest-select"
              value={form.scopeEntryProfile}
              onChange={(event) => {
                const next = event.target.value;
                if ((SCOPE_ENTRY_PROFILES as readonly string[]).includes(next)) {
                  patch({ scopeEntryProfile: next as ScopeEntryProfile });
                }
              }}
            >
              {SCOPE_ENTRY_PROFILES.map((profile) => (
                <option key={profile} value={profile}>{SCOPE_ENTRY_PROFILE_LABELS[profile]}</option>
              ))}
            </select>
          </Field>
          <Field
            label="行为预设（必选）"
            hint="没有默认值。预设决定注入 Agent 的行为指引（四档场景差异都在这里）与宿主侧速率/并发；服务端展开后写入冻结策略快照。"
          >
            <select
              className="pentest-select"
              value={form.behaviorProfile ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                if ((BEHAVIOR_PROFILES as readonly string[]).includes(next)) {
                  patch({ behaviorProfile: next as BehaviorProfile });
                }
              }}
            >
              <option value="" disabled>请选择本作业的场景（必选）</option>
              {BEHAVIOR_PROFILES.map((profile) => (
                <option key={profile} value={profile}>{BEHAVIOR_PROFILE_LABELS[profile]}</option>
              ))}
            </select>
          </Field>
          {form.behaviorProfile === null ? (
            <ul className="pentest-wizard__section-hint">
              {BEHAVIOR_PROFILES.map((profile) => (
                <li key={profile}>{`${BEHAVIOR_PROFILE_LABELS[profile]}：${BEHAVIOR_PROFILE_HINTS[profile]}`}</li>
              ))}
            </ul>
          ) : (
            <p className="pentest-wizard__section-hint">{BEHAVIOR_PROFILE_HINTS[form.behaviorProfile]}</p>
          )}
          <Field
            label="审批模式（必选）"
            hint="没有默认值。人工审批：逐次放行类别的每个动作都要你在控制台点一次。高权限：预设内且非默认禁用类别的动作由服务端自行放行，只有越界申请才找你。"
          >
            <select
              className="pentest-select"
              value={form.approvalMode ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                if ((APPROVAL_MODES as readonly string[]).includes(next)) {
                  patch({ approvalMode: next as ApprovalMode });
                }
              }}
            >
              <option value="" disabled>请选择审批模式（必选）</option>
              {APPROVAL_MODES.map((mode) => (
                <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>
              ))}
            </select>
          </Field>
          {form.approvalMode === null ? (
            <ul className="pentest-wizard__section-hint">
              {APPROVAL_MODES.map((mode) => (
                <li key={mode}>{`${APPROVAL_MODE_LABELS[mode]}：${APPROVAL_MODE_HINTS[mode]}`}</li>
              ))}
            </ul>
          ) : (
            <p className="pentest-wizard__section-hint">{APPROVAL_MODE_HINTS[form.approvalMode]}</p>
          )}
          {form.behaviorProfile === 'custom' ? (
            <>
              <p className="pentest-wizard__section-hint">
                {`自定义指引会逐字注入该作业下每一次会话的提示词，并随策略快照冻结、进哈希——改它等于改策略。上限 ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字。`}
              </p>
              <TextArea
                value={form.customGuidance}
                onChange={(next) => { patch({ customGuidance: next }); }}
                rows={6}
                placeholder={'例如：\n- 只写不改变远端状态的只读命令；任何 POST 前先请我放行。\n- 每完成一个发现就在状态便签里写清证据与下一步。\n- 不碰 8080 以外的端口。'}
              />
              <p className="pentest-wizard__section-hint">
                {`${String(form.customGuidance.trim().length)} / ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字`}
              </p>
            </>
          ) : null}
        </div>

        <div className="pentest-wizard__section">
          <h4 className="pentest-wizard__section-title">授权目标</h4>
          <p className="pentest-wizard__section-hint">
            至少一个。域名与 IP 留空端口即默认 80/443；网段与资产标签必须显式写端口或协议。
          </p>
      <ScopeRows
        label="目标"
        hint="域名与 IP 留空端口即默认 80/443；网段与资产标签必须显式写端口或协议，否则服务端拒绝加载（§10.2.2）"
        rows={form.targets}
        onChange={(rows) => { patch({ targets: rows }); }}
      />
        </div>

        <div className="pentest-wizard__section">
          <h4 className="pentest-wizard__section-title">公共记忆（可选）</h4>
          <p className="pentest-wizard__section-hint">
            写在这里的规则会注入本作业下**每一次新建会话**；建完之后也能在「公共记忆」面板里改。
            **授权依据、限制条件、客户约定这类说明写在这里最合适** —— 它们是给人看与给模型读的
            文字，不必塞进上面的结构化字段。
          </p>
          <TextArea
            value={form.publicMemory}
            onChange={(next) => { patch({ publicMemory: next }); }}
            rows={5}
            placeholder={'例如：\n- 只做被动读取，不发起会改变远端状态的请求。\n- 报告与状态便签一律用中文。'}
          />
        </div>
      </div>

      {/* ── ② 高级选项：都可留空 ──
          折叠起来不只是为了好看：这些字段此前**全是必填**，而其中大部分要么没有读取方、
          要么服务端本来就给了安全的默认值（排除项空 = 不排除；授权到期空 = 不过期）。
          把它们收起来，新作业的路径就只剩「起个名、填个目标」。 */}
      <div className="pentest-wizard__advanced">
        <button
          type="button"
          className="pentest-wizard__advanced-title"
          aria-expanded={advancedOpen}
          onClick={() => { setAdvancedOpen((open) => !open); }}
        >
          <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
          <span>高级选项</span>
          <span className="pentest-wizard__section-hint">
            授权依据与到期、排除项、规则、时间窗、紧急停止 —— 都可留空
          </span>
        </button>
        {advancedOpen ? (
          <>
        <Field label="授权依据引用" hint="授权主体与内部批准记录的引用。只进档案与审计——范围判定不读它，留空也能建立。">
          <TextInput
            value={form.authorizationRef}
            onChange={(next) => { patch({ authorizationRef: next }); }}
            placeholder="例如：TICKET-1234 / 授权书编号"
          />
        </Field>
        <Field label="授权到期时间" hint="到期后新动作会被拒（§11.1）——证书到期不是提醒，是硬边界。">
          <TextInput
            type="datetime-local"
            value={form.authorizationExpiresAt}
            onChange={(next) => { patch({ authorizationExpiresAt: next }); }}
          />
        </Field>

        <ScopeRows
          label="排除项"
          hint="排除项优先于目标：判为排除的请求即使落在目标网段内也会被拒。上游依赖与共享基础设施写在这里（§11.1）"
          rows={form.exclusions}
          onChange={(rows) => { patch({ exclusions: rows }); }}
        />

        {/* ③ 规则：速率、并发、最大影响 */}
        <Field label="允许的测试类型" hint="逗号分隔；例如：被动指纹, 认证扫描, 越权验证">
          <TextInput
            value={form.allowedTestTypes}
            onChange={(next) => { patch({ allowedTestTypes: next }); }}
            placeholder="被动指纹, 认证扫描"
          />
        </Field>
        <Field label="速率上限（每秒请求数）">
          <TextInput
            value={form.rateLimitPerSecond}
            onChange={(next) => { patch({ rateLimitPerSecond: next }); }}
            placeholder="例如：5"
          />
        </Field>
        <Field label="并发上限">
          <TextInput
            value={form.maxConcurrency}
            onChange={(next) => { patch({ maxConcurrency: next }); }}
            placeholder="例如：2"
          />
        </Field>
        <Field label="最大影响" hint="允许的最大影响面；破坏性动作默认关闭（§11.1）">
          <TextInput
            value={form.maxImpact}
            onChange={(next) => { patch({ maxImpact: next }); }}
            placeholder="例如：只读验证，不修改数据、不触发重启"
          />
        </Field>
        <Field label="凭据使用规则">
          <TextInput
            value={form.credentialRule}
            onChange={(next) => { patch({ credentialRule: next }); }}
            placeholder="例如：仅使用靶场预置账号，不落盘明文凭据"
          />
        </Field>
        <Field label="数据落盘与脱敏规则">
          <TextInput
            value={form.dataHandling}
            onChange={(next) => { patch({ dataHandling: next }); }}
            placeholder="例如：证据原文加密留存，导出时按字段脱敏"
          />
        </Field>

        {/* ④ 时间窗 */}
        <Field label="时区">
          <TextInput
            value={form.timezone}
            onChange={(next) => { patch({ timezone: next }); }}
            placeholder="Asia/Shanghai"
          />
        </Field>
        <Field label="允许执行的时间段">
          <span className="pentest-wizard__days">
            {WEEKDAYS.map((day) => (
              <label key={day.id} className="pentest-wizard__day">
                <input
                  type="checkbox"
                  checked={form.allowedDays.includes(day.id)}
                  onChange={() => {
                    patch({
                      allowedDays: form.allowedDays.includes(day.id)
                        ? form.allowedDays.filter((item) => item !== day.id)
                        : [...form.allowedDays, day.id],
                    });
                  }}
                />
                <span>{day.label}</span>
              </label>
            ))}
          </span>
        </Field>
        <Field label="时间窗起止" hint="24 小时制；留空表示不限制具体时刻">
          <span className="pentest-wizard__window">
            <TextInput
              value={form.windowFrom}
              onChange={(next) => { patch({ windowFrom: next }); }}
              placeholder="09:00"
            />
            <TextInput
              value={form.windowTo}
              onChange={(next) => { patch({ windowTo: next }); }}
              placeholder="18:00"
            />
          </span>
        </Field>

        {/* ⑤ 紧急停止 */}
        <Field label="紧急停止联系人">
          <TextInput
            value={form.emergencyContact}
            onChange={(next) => { patch({ emergencyContact: next }); }}
            placeholder="姓名 / 值班方式"
          />
        </Field>
        <Field label="紧急停止条件" hint="每行一条；触发即终止（§11.1）">
          <TextArea
            value={form.stopConditions}
            onChange={(next) => { patch({ stopConditions: next }); }}
            rows={4}
            placeholder={'出现业务中断迹象\n触达未在范围内的资产\n凭据泄露风险'}
          />
        </Field>


          </>
        ) : null}
      </div>

      {/* ⑥ 规范化后的最终范围与限制（§13.1：展示 → 人类确认 → 才提交） */}
      <div className="pentest-wizard__preview">
        <h4 className="pentest-wizard__preview-title">规范化后的最终范围（服务端同一套规范化逻辑）</h4>
        <Table
          columns={[
            { key: 'section', header: '分区' },
            { key: 'kind', header: '类型' },
            { key: 'value', header: '条目' },
            { key: 'normalized', header: '规范化键' },
            { key: 'protocols', header: '协议' },
            { key: 'ports', header: '端口' },
            { key: 'verdict', header: '判定' },
          ]}
          rows={preview}
          keyOf={(row) => row.key}
          empty={<Empty title="还没有目标条目" reason="至少填写一个目标才能建立 engagement（§11.1）" />}
          renderCell={(row, column) => {
            switch (column) {
              case 'section':
                return row.section;
              case 'kind':
                return row.kind;
              case 'value':
                return <code>{row.value}</code>;
              case 'normalized':
                return <code>{row.normalized}</code>;
              case 'protocols':
                return row.protocols;
              case 'ports':
                return row.ports;
              case 'verdict':
                return <Badge text={row.verdict} tone={row.tone} />;
              default:
                return null;
            }
          }}
        />
        <p className="pentest-wizard__limits">
          限制摘要：{limitSummary(form)}
        </p>
      </div>

      {/* ⑦ 人类确认与提交（§13.1） */}
      {/* 创建路径上还没有 engagement，`previewPolicy` 无法调用；但人类在按下确认前
          至少要知道自己选的两个预设是什么，以及服务端会在创建时把它们展开并冻结。 */}
      <p className="pentest-wizard__policy-note">
        {`范围入口：${SCOPE_ENTRY_PROFILE_LABELS[form.scopeEntryProfile]}；行为预设：` +
          `${form.behaviorProfile === null ? '（尚未选择——必选）' : BEHAVIOR_PROFILE_LABELS[form.behaviorProfile]}；审批模式：` +
          `${form.approvalMode === null ? '（尚未选择——必选）' : APPROVAL_MODE_LABELS[form.approvalMode]}。`}
        {'服务端会在创建时展开并冻结这两个预设，策略快照哈希随创建结果返回。'}
      </p>
      <label className="pentest-wizard__ack">
        <input
          type="checkbox"
          checked={form.acknowledged}
          onChange={() => { patch({ acknowledged: !form.acknowledged }); }}
        />
        <span>{SCOPE_ACK_LABEL}</span>
      </label>

      <Field label="决策理由" hint="写入 human_decisions（§16.1），与提交一同留痕">
        <TextInput
          value={form.reason}
          onChange={(next) => { patch({ reason: next }); }}
          placeholder="例如：客户书面授权，授权书编号 TICKET-1234"
        />
      </Field>

      {gates.length === 0 ? null : (
        <ul className="pentest-wizard__gates">
          {gates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      )}

      <div className="pentest-wizard__actions">
        {/* 校验范围：把待校验的行交给服务端（§13.1 要求服务端规范化并校验）。 */}
        <Button
          label="校验范围"
          onClick={requestPreview}
          disabled={props.onRequestPreview === undefined}
          reason={
            props.onRequestPreview === undefined
              ? '调用方未接入校验回调（onRequestPreview）'
              : undefined
          }
        />
        <Button
          label={busy ? '正在建立…' : '确认并建立 engagement'}
          kind="primary"
          onClick={submit}
          disabled={blocked}
          reason={busy ? '正在提交' : createdId !== null ? '已建立；重复提交会创建第二个 engagement（§15.3）' : gates.join('；')}
        />
        {props.onCancel === undefined ? null : (
          <Button label="取消" onClick={props.onCancel} />
        )}
      </div>
    </Card>
  );
}

/** 限制摘要：让人类在一处看到「这次授权允许什么、禁止什么」。 */
function limitSummary(form: WizardForm): string {
  const parts: string[] = [];
  parts.push(form.allowedTestTypes.trim() === '' ? '测试类型未声明' : `测试类型：${form.allowedTestTypes.trim()}`);
  parts.push(form.rateLimitPerSecond.trim() === '' ? '速率未限制' : `速率 ≤ ${form.rateLimitPerSecond.trim()} 次/秒`);
  parts.push(form.maxConcurrency.trim() === '' ? '并发未限制' : `并发 ≤ ${form.maxConcurrency.trim()}`);
  parts.push(form.maxImpact.trim() === '' ? '最大影响未声明' : `最大影响：${form.maxImpact.trim()}`);
  const days = form.allowedDays.length === WEEKDAYS.length ? '每天' : form.allowedDays.length === 0 ? '未选择任何日期（无法执行）' : form.allowedDays.join('/');
  const window = form.windowFrom.trim() === '' && form.windowTo.trim() === '' ? '全天' : `${form.windowFrom.trim() || '00:00'}–${form.windowTo.trim() || '24:00'}`;
  parts.push(`时间窗：${days} ${window}（${form.timezone.trim() || '未声明时区'}）`);
  parts.push(form.stopConditions.trim() === '' ? '紧急停止条件未声明' : '紧急停止条件已声明');
  return parts.join('；');
}

/** 未满足的条件。全部列出（而不是只给第一条）——人类一次就能补齐。 */
function collectGates(
  form: WizardForm,
  targetChecks: readonly RowCheck[],
  exclusionChecks: readonly RowCheck[],
  now: Date | undefined,
): readonly string[] {
  const gates: string[] = [];
  if (form.name.trim() === '') gates.push('必须填写名称（§11.1）');
  // 行为预设是**必选项**：不选就不让提交（理由写在按钮上方，而不是留一个灰按钮让人猜）。
  if (form.behaviorProfile === null) {
    gates.push('必须选择行为预设（必选）：它决定注入 Agent 的行为指引与宿主侧节奏');
  }
  if (form.behaviorProfile === 'custom' && form.customGuidance.trim() === '') {
    gates.push('custom 预设必须写自定义指引：那段文字就是注入会话的行为指引本体');
  }
  if (form.approvalMode === null) {
    gates.push('必须选择审批模式（必选）：人工审批逐条人批，高权限让服务端自行放行预设内的动作');
  }
  if (form.customGuidance.trim().length > CUSTOM_GUIDANCE_MAX_CHARS) {
    gates.push(`自定义指引过长：上限 ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字（它会逐次注入每一次会话提示词）`);
  }
  // 授权依据引用与到期时间**不再是闸门**。
  //
  // 依据引用只进档案与审计，没有任何判定读它——把它当必填只会让「自己给自己开个作业」
  // 每次都要编一个引用。到期时间则是「填了才有硬边」：留空即未声明到期，语义清晰。
  // 两者降为「建议填」，但**填了就必须是合法值**——否则会存进一个谁也读不懂的字符串。
  const expiry = form.authorizationExpiresAt.trim();
  if (expiry !== '' && !Number.isFinite(Date.parse(expiry))) {
    gates.push('授权到期时间无法解析（留空表示不作限制，但填了就必须是合法时间）');
  } else if (expiry !== '' && Date.parse(expiry) <= (now ?? new Date()).getTime()) {
    // 建一个「已经过期」的授权没有意义：它连第一个动作都过不去（§11.1）
    gates.push('授权到期时间已过去——那会让这个作业刚建好就无法执行任何动作；请填未来的时间或留空');
  }
  if (targetChecks.length === 0) gates.push('至少需要一个授权目标（§11.1）');
  // 「校验失败」与「尚未校验」必须分开说：前者是人类要改的输入问题，
  // 后者是人类要点一下「校验范围」的动作问题。混在一句里会让人不知道该改什么。
  const failed = [...targetChecks, ...exclusionChecks].filter((check) => !check.ok && check.code !== null);
  if (failed.length > 0) {
    gates.push(`有 ${String(failed.length)} 个条目无法通过范围校验（服务端会整体拒绝，§10.2.2）：${failed.map((check) => `${check.row.value} ${check.code ?? ''}`).join('、')}`);
  }
  const unchecked = [...targetChecks, ...exclusionChecks].filter((check) => !check.ok && check.code === null);
  if (unchecked.length > 0) {
    gates.push(`有 ${String(unchecked.length)} 个条目尚未校验：点「校验范围」由服务端裁定（§13.1）`);
  }
  if (form.reason.trim() === '') gates.push('写操作必须携带非空理由（§16.1 决策记录）');
  if (!form.acknowledged) gates.push('需勾选确认已核对范围与限制（§13.1）');
  return gates;
}

function buildParams(
  form: WizardForm,
  behaviorProfile: BehaviorProfile,
  approvalMode: ApprovalMode,
): CreateEngagementParams {
  const expiry = form.authorizationExpiresAt.trim();
  const parsed = Date.parse(expiry);
  const ref = form.authorizationRef.trim();
  const memory = form.publicMemory.trim();
  return {
    name: form.name.trim(),
    // 可选项**只在真有值时发送**。
    //
    // 这与「发个空串」不同：空串会经 `rpc.ts` 的 stringOrNull 之外的路径被当成一个值
    // 存进快照，而省略让服务端用它自己的默认值——「没填」与「填了空」在语义上本来就该
    // 是同一件事，但前者少一次「空值算不算填了」的判断分歧。
    ...(ref === '' ? {} : { authorizationRef: ref }),
    ...(expiry === ''
      ? {}
      : { authorizationExpiresAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : expiry }),
    ...(memory === '' ? {} : { publicMemory: memory }),
    scopeEntryProfile: form.scopeEntryProfile,
    behaviorProfile,
    ...(form.customGuidance.trim() === '' ? {} : { customGuidance: form.customGuidance.trim() }),
    approvalMode,
    targets: filledRows(form.targets).map((row) => {
      const ports = parsePorts(row.portsText);
      return toScopeTarget(row, ports.ok ? ports.ports : []);
    }),
    exclusions: filledRows(form.exclusions).map((row) => {
      const ports = parsePorts(row.portsText);
      return toScopeTarget(row, ports.ok ? ports.ports : []);
    }),
    roe: buildRoe(form),
    timeWindow: buildTimeWindow(form),
    reason: form.reason.trim(),
  };
}

/** 服务端返回的是新 engagement 摘要；拿不到标识时返回 null，由调用方决定怎么显示。 */
function engagementIdOf(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id;
  }
  return null;
}

/** 服务端最终冻结的策略投影（§6.2.0.5）；人类建完之后要核对的就是这两个值。 */
interface PolicyProjection {
  readonly policyVersion: number;
  readonly policySnapshotHash: string;
}

/**
 * 从服务端返回的摘要里读策略投影。
 *
 * 与 `engagementIdOf` 同样保守：两个字段缺一或类型不符就返回 null——
 * 调用方据此显示占位，而不是拿一个 undefined 拼进提示里，更不替服务端编造。
 */
function policyProjectionOf(value: unknown): PolicyProjection | null {
  if (value === null || typeof value !== 'object') return null;
  if (!('policyVersion' in value) || typeof value.policyVersion !== 'number') return null;
  if (!('policySnapshotHash' in value) || typeof value.policySnapshotHash !== 'string') return null;
  return { policyVersion: value.policyVersion, policySnapshotHash: value.policySnapshotHash };
}

/**
 * 目标/排除项行编辑器。
 *
 * 独立成组件而不是内联：目标与排除项用的是**同一套**字段与校验，写两遍必然漂移。
 */
function ScopeRows(props: {
  readonly label: string;
  readonly hint: string;
  readonly rows: readonly TargetRow[];
  readonly onChange: (rows: readonly TargetRow[]) => void;
}): ReactNode {
  const replace = (index: number, next: TargetRow): void => {
    props.onChange(props.rows.map((row, i) => (i === index ? next : row)));
  };
  const remove = (index: number): void => {
    props.onChange(props.rows.filter((_, i) => i !== index));
  };

  return (
    <Field label={props.label} hint={props.hint}>
      <span className="pentest-wizard__rows">
        {props.rows.map((row, index) => (
          // 行没有服务端标识，索引即身份；输入值全部受控，因此增删行不会串值
          <span className="pentest-wizard__row" key={`${props.label}-${String(index)}`}>
            <select
              className="pentest-select"
              value={row.kind}
              onChange={(event) => {
                const kind = event.target.value;
                if (isTargetKind(kind)) replace(index, { ...row, kind });
              }}
            >
              {TARGET_KINDS.map((kind) => (
                <option key={kind} value={kind}>{TARGET_KIND_LABELS[kind]}</option>
              ))}
            </select>
            <TextInput
              value={row.value}
              onChange={(next) => { replace(index, { ...row, value: next }); }}
              placeholder={placeholderFor(row.kind)}
            />
            <span className="pentest-wizard__protocols">
              {PROTOCOL_OPTIONS.map((option) => (
                <label key={option.id} className="pentest-wizard__protocol">
                  <input
                    type="checkbox"
                    checked={row.protocols.includes(option.id)}
                    onChange={() => {
                      replace(index, {
                        ...row,
                        protocols: row.protocols.includes(option.id)
                          ? row.protocols.filter((item) => item !== option.id)
                          : [...row.protocols, option.id],
                      });
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </span>
            <TextInput
              value={row.portsText}
              onChange={(next) => { replace(index, { ...row, portsText: next }); }}
              placeholder="端口（80,443；留空=默认 80/443）"
            />
            {/*
              「任意端口」必须是**人类可见的显式选项**（§10.2.2 的原话）。
              它此前只能靠知道 `0-65535` 这个写法来表达——输入框的提示里一个字都没提，
              于是实际上只有一个「会用它的人才会用」的隐藏约定。
              给一个复选框，让这个选择的后果当场可见（勾上并把端口框置灰）。
            */}
            <label
              className="pentest-wizard__anyport"
              title="授权该条目范围内的全部端口（0-65535）。这是一次宽授权，会记入范围版本与放行记录。"
            >
              <input
                type="checkbox"
                checked={isAnyPortText(row.portsText)}
                onChange={() => {
                  replace(index, {
                    ...row,
                    portsText: isAnyPortText(row.portsText) ? '' : String(ANY_PORT.from) + '-' + String(ANY_PORT.to),
                  });
                }}
              />
              <span>任意端口</span>
            </label>
            <Button label="删除" onClick={() => { remove(index); }} />
          </span>
        ))}
        <Button
          label={`添加${props.label}`}
          onClick={() => { props.onChange([...props.rows, EMPTY_ROW]); }}
        />
      </span>
    </Field>
  );
}

/**
 * 端口文本是否已经是「任意端口」（`0-65535`）。
 *
 * 用 `parsePorts` 判而不是字符串比较：人类可能写成 `0 - 65535` 或 `0-65535,80`。
 * 后者虽含 80 但已被 0-65535 覆盖，语义上同样是任意端口。
 */
function isAnyPortText(text: string): boolean {
  const parsed = parsePorts(text);
  if (!parsed.ok) return false;
  return parsed.ports.some((range) => range.from === ANY_PORT.from && range.to === ANY_PORT.to);
}

function isTargetKind(value: string): value is ScopeTarget['kind'] {
  return Object.prototype.hasOwnProperty.call(TARGET_KIND_LABELS, value);
}

function placeholderFor(kind: ScopeTarget['kind']): string {
  switch (kind) {
    case 'domain':
      return 'example.com 或 *.example.com';
    case 'ip':
      return '10.0.0.5';
    case 'cidr':
      return '10.0.0.0/24';
    case 'url':
      return 'https://lab.example.com/app';
    case 'asset-label':
      return '@lab-web';
  }
}
