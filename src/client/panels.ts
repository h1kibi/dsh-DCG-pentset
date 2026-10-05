/**
 * 面板装配：把契约数据接进八个功能面板。
 *
 * ── 为什么单独一个模块 ──
 *
 * `ConsoleApp` 管生命周期（创建控制器、订阅快照、持有展示状态），装配管「哪些数据
 * 喂给哪个面板」。两者混在一起会让入口文件同时承担副作用与布局，且装配逻辑无法在
 * 纯环境里测。本模块只导出**纯函数**：给定数据与回调，按数据可用性返回最多七个面板节点。
 *
 * ── 空、缺、错是三件事 ──
 *
 * 面板的数据来源可能处于三种状态，界面必须区分：
 *
 *   - **已读到、确实没有** → 空数组。这是确定的事实（「没有待放行的动作」）。
 *   - **还没读** → `undefined`。面板说「尚未读取」，并给出读取入口。
 *   - **读失败** → 错误。面板说「读取失败」并显示原因。
 *
 * 把三者都渲染成空列表是最常见也最有害的省略：人类看到「没有待放行的动作」会
 * 认为 Agent 没在请求放行，而实际上可能只是那次读取失败了。
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';

import type {
  ApprovalDetail,
  HandoffDraft,
  ReportDraft,
  AssetScopeDecision,
  CandidateAsset,
  Finding,
  MemorySearchHit,
  MemoryWatermark,
  ScopeDetail,
  ScopeTarget,
  SkillSummary,
} from '../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from './controller.ts';
import type {
  MemoryExpandRef,
  MemoryHitView,
  MemoryQueryForm,
  MemorySearchParams,
} from './views/MemoryExplorer.tsx';
import { MemoryExplorer } from './views/MemoryExplorer.tsx';
import { ApprovalQueue, approvalItemOf } from './views/ApprovalQueue.tsx';
import { ReportReview } from './views/ReportReview.tsx';
import { ScopeManager } from './views/ScopeManager.tsx';
import { SkillLibrary } from './views/SkillLibrary.tsx';
import { PublicMemoryPanel } from './views/PublicMemoryPanel.tsx';
import type { DispositionAction, DispositionInput, DispositionOutcome } from './views/ReportReview.tsx';
import type {
  SkillAddInput,
  SkillRemoveInput,
  SkillUpdateInput,
} from './views/SkillLibrary.tsx';
import { HandoffPanel } from './views/HandoffPanel.tsx';
import { ReportExport } from './views/ReportExport.tsx';
import type { ExportFormat, ExportOutcome } from './views/ReportExport.tsx';
import type { CandidateAsset as CandidateAssetView } from './views/ScopeManager.tsx';
import type { ConsolePanel } from './views/ConsoleShell.tsx';
import type { EngagementMemory } from '../contracts.ts';

// ───────────────────────── 契约 → 视图 ─────────────────────────

/**
 * 检索命中的映射。
 *
 * 两个字段名不同，必须显式映射而不是靠结构化类型：
 *
 *   - 契约叫 `memoryId`（记忆条目的标识），视图叫 `chunkId`（分块的标识）——
 *     同一个东西的两种叫法。分开命名是有意的：契约层说的是「一条记忆」，
 *     而检索实现说的是「一个分块」，映射点就是两者的翻译处。
 *   - 契约的 `kind` 是 `string`，视图也是 `string`（视图侧查表兜底），因此原样传递。
 */
export function toMemoryHits(hits: readonly MemorySearchHit[]): readonly MemoryHitView[] {
  return hits.map((hit) => ({
    chunkId: hit.memoryId,
    kind: hit.kind,
    excerpt: hit.excerpt,
    score: hit.score,
    trustLevel: hit.trustLevel,
    citation: hit.citation,
    occurredAt: hit.occurredAt,
    reasoningLabel: hit.reasoningNote ?? null,
  }));
}

/**
 * 候选资产的映射。
 *
 * 三个字段名不同：契约用 `id`（这条候选的标识），视图用 `assetId`（它指向的资产）；
 * 契约把发现来源拆成「来自会话」与「来自资产」两个可空列，视图要一句人能读的来源说明。
 *
 * `discoveredFrom` 的措辞在这里定，不在视图里：视图面对的是「已经准备好的展示数据」，
 * 让它反推数据来源的组合会把契约的形状泄漏进渲染逻辑。
 */
export function toCandidateAssets(assets: readonly CandidateAsset[]): readonly CandidateAssetView[] {
  return assets.map((asset) => ({
    assetId: asset.id,
    canonicalTarget: asset.canonicalTarget,
    kind: asset.kind,
    labels: asset.labels,
    discoveredFrom: discoverySourceOf(asset),
    discoveredInSessionId: asset.discoveredFromSessionId,
    firstSeenIteration: asset.firstSeenIteration,
  }));
}

function discoverySourceOf(asset: CandidateAsset): string {
  // 两个来源列都为空的候选仍要显示——「不知道它从哪来」本身是人类需要知道的，
  // 因此给出一句明确的说明而不是空字符串。
  if (asset.discoveredFromAssetId !== null) return `关联资产 ${asset.discoveredFromAssetId}`;
  if (asset.discoveredFromSessionId !== null) return `会话 ${asset.discoveredFromSessionId}`;
  return '来源未记录';
}

/**
 * 范围条目的种类。客户端只认识这几个——服务端的规范化会拒绝未知种类。
 *
 * 这是**原样列出**稳定键的前缀，不是复制规范化规则：本函数不做任何校验，只把
 * `kind:value` 拆回两段。真正的判定（协议、端口、是否允许任意端口）全在服务端。
 */
const SCOPE_KINDS: readonly ScopeTarget['kind'][] = ['domain', 'ip', 'cidr', 'url', 'asset-label'];

function isScopeKind(value: string): value is ScopeTarget['kind'] {
  return (SCOPE_KINDS as readonly string[]).includes(value);
}

/**
 * 把候选资产的稳定键拆成范围条目。
 *
 * 稳定键形如 `domain:lab.example.com`（`src/policy/scope.ts` 的规范化产物）。
 * 拆不出来时**保留整串作为 value** 并交给服务端裁决——比丢掉这条候选好，
 * 也比在客户端猜一个种类好。
 *
 * 协议与端口一律留空：它们是人类的意图，不是可以从键推出来的东西。留空的语义
 * 按条目种类不同（域名与 IP 走默认 80/443；网段与资产标签条目会被服务端整体拒绝，
 * 见 §10.2.2 的端口要求），因此人类必须显式声明。
 */
function toScopeTarget(canonicalTarget: string): ScopeTarget {
  const at = canonicalTarget.indexOf(':');
  const head = at < 0 ? '' : canonicalTarget.slice(0, at);
  if (at > 0 && isScopeKind(head)) {
    return { kind: head, value: canonicalTarget.slice(at + 1), protocols: [], ports: [] };
  }
  return { kind: 'asset-label', value: canonicalTarget, protocols: [], ports: [] };
}

// ───────────────────────── 装配 ─────────────────────────

export interface BuildPanelsInput {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  readonly now: Date;

  /** 报告审阅。 */
  /** 全部结论；`null` = 尚未成功读取（还没读，或读失败）。读失败的原因在快照的 `lastError`。 */
  readonly findings: readonly Finding[] | null;
  /**
   * `findingId` → 最近一次处置动作（§8.9）。
   *
   * 契约的 `Finding` **不含**处置记录（它落在 `human_decisions`），而审阅页的四节分节
   * 依赖它——缺了就只能一律显示「从未处置」，于是「未处置候选」这一节永远虚高、
   * 签字前置也就永远看起来没满足。
   */
  readonly dispositions: Readonly<Record<string, DispositionAction>>;
  /** 处置结论的回调（§8.9 三选一）。 */
  readonly onDispose: (input: DispositionInput) => DispositionOutcome | Promise<DispositionOutcome> | void;

  /**
   * skill 库的写回调（§2.2 可添加）。
   *
   * 端点（`addSkill`/`updateSkill`/`removeSkill`）一直在方法表里，但此前**没有客户端封装、
   * 也没有接线**——Skill 库面板的增/改/删三个按钮因此全部禁用。
   */
  readonly onAddSkill: (input: SkillAddInput) => void;
  readonly onUpdateSkill: (input: SkillUpdateInput) => void;
  readonly onRemoveSkill: (input: SkillRemoveInput) => void;
  /** 放行队列。 */
  readonly approvals: readonly ApprovalDetail[] | null;
  /** 范围版本（`history` 只在请求过历史时有值）。 */
  readonly scope: ScopeDetail | null;
  /**
   * 公共记忆；`null` = 尚未成功读取。
   *
   * 与 `skills`/`scope` 一样按需加载：它可能很长，首屏不该顺带拉。
   */
  readonly publicMemory: EngagementMemory | null;
  /** 保存公共记忆的回调（写操作只在这一条路径上）。 */
  readonly onSavePublicMemory: (content: string, reason: string) => Promise<void> | void;
  readonly candidateAssets: readonly CandidateAsset[] | null;
  /** skill 库。 */
  readonly skills: readonly SkillSummary[] | null;

  /**
   * 交接草稿。`null` = 还没有（人类尚未请求生成，§6.3）。
   *
   * 由调用方持有而不是面板自己拉：草稿生成是**写操作**，且人类编辑后的内容要跨渲染保留。
   */
  readonly handoffDraft: HandoffDraft | null;
  /** 草稿产生或清空时回调（调用方保存它）。 */
  readonly onHandoffDraft: (draft: HandoffDraft | null) => void;
  /**
   * 回环（后渗透 → 情报收集）的前置状态（§5.4 步骤 4）。
   *
   * 由调用方从**会话绑定版本**与**当前范围版本**推出，与 `planPhaseMove` 的判据同源；
   * 服务端在 `confirmTransition` 里用同一条件复核（那是权威）。
   * 界面用它提前把闸门显示出来，而不是等提交后被打回。
   */
  readonly scopeAmendment: { readonly completed: boolean; readonly newVersion: number | null };

  /** 报告草稿（签字与导出的输入）。`null` = Host 还没生成。 */
  readonly reportDraft: ReportDraft | null;
  /**
   * 未处置结论数。**必须来自 Host**（`listUndisposed`）——它是签字硬前置的判据（§8.9），
   * 由界面从已加载的结论推算会在条目未加载完时给出错误的「可以签字」。
   */
  readonly undisposedCount: number | null;
  /**
   * 待签字的内容哈希。**`undefined`（调用方没有这个信息）与 `null`（确认还没有哈希）
   * 是两件事**：前者不传 `contentHash`，后者让签字闸门如实报出「尚无内容哈希」。
   * 两种情况下导出都不受影响——`ReportExport` 的 `wired` 只看 `onExport` 在不在。
   */
  readonly reportContentHash?: string | null;
  /**
   * 报告的导出接线点。
   *
   * 与 `findings` 等数据不同，它是**能力**而不是事实：`ReportExport` 的 `wired` 就是
   * `onExport !== undefined`，因此「没接线」与「接了线但当前没选中作业」必须分开表达
   * ——后者由 `ReportExport` 自己按 `snapshot.selectedEngagementId` 报 `engagement-missing`。
   * 用「无 engagement 时不传 onExport」去表达前者会让按钮显示成「缺少接线」，那是假原因。
   */
  readonly onExport?: (format: ExportFormat) => ExportOutcome | Promise<ExportOutcome> | void;

  /** 记忆检索：命中、水位、以及人类上次的检索参数。 */
  readonly memoryHits: readonly MemoryHitView[] | null;
  readonly memoryWatermark: MemoryWatermark | null;
  readonly memorySearched: boolean;
  /**
   * 最近一次检索的失败（null = 没有失败）。
   *
   * 与 `memoryHits` 分开传：命中为空有两种原因（真的没有匹配 / 这次没查成），
   * 面板的空态文案必须据此分岔——把失败说成「没有匹配」会让人以为记忆是空的（§6.2.1）。
   */
  readonly memoryError?: { readonly code: string; readonly message: string } | null;
  readonly memoryInitialForm: MemoryQueryForm | null;
  readonly memoryDetails: Readonly<Record<string, string>>;

  // ── 意图出口 ──

  /** 人类提交检索表单。 */
  readonly onMemorySearch: (params: MemorySearchParams) => void;
  /** 人类点开一条命中的原文。 */
  readonly onMemoryExpand: (ref: MemoryExpandRef) => void;
}

/**
 * 构造面板节点表。
 *
 * 返回值直接交给 `ConsoleShell` 的 `panels`。**只放有数据来源的面板**：
 * 其余面板由外壳显示「尚未接入」——这比渲染一个永远空的视图诚实。
 */
export function buildPanels(input: BuildPanelsInput): Partial<Readonly<Record<ConsolePanel, ReactNode>>> {
  const { controller, snapshot, now } = input;

  const panels: Partial<Record<ConsolePanel, ReactNode>> = {};

  // 报告审阅：只有读到结论才渲染列表。读失败或还没读时不渲染，
  // 让外壳的「尚未接入」提示承担说明责任——避免面板自己发明一套空状态文案。
  if (input.findings !== null) {
    panels.report = createElement(
      'div',
      { className: 'pentest-report-panel' },
      createElement(ReportReview, {
        controller,
        snapshot,
        findings: input.findings,
        dispositions: input.dispositions,
        onDispose: input.onDispose,
        now,
      }),
      input.undisposedCount === null
        ? null
        : createElement(ReportExport, {
            controller,
            snapshot,
            draft: input.reportDraft,
            undisposedCount: input.undisposedCount,
            // 两个可选 prop 都用条件展开：`undefined` 表示「调用方没有这个信息」，
            // 与显式的 `null`（确认还没有内容哈希）含义不同，不能一并写成 `?? null`。
            ...(input.reportContentHash === undefined ? {} : { contentHash: input.reportContentHash }),
            ...(input.onExport === undefined ? {} : { onExport: input.onExport }),
          }),
    );
  }

  panels.handoff = createElement(HandoffPanel, {
    controller,
    snapshot,
    draft: input.handoffDraft,
    onDraft: input.onHandoffDraft,
    scopeAmendment: input.scopeAmendment,
    // 草稿内容哈希由读端点带回（REQ-9）：编辑器**不自己算**——客户端手里那份副本
    // 与服务端库里那一行可能已经不是同一份内容，显示的值必须来自权威来源。
    ...(input.handoffDraft === null ? {} : { contentHash: input.handoffDraft.contentHash }),
    // 与记忆浏览器共用同一条「展开原文」通道（同一份 details 状态、同一个审计读操作）。
    ...(input.onMemoryExpand === undefined ? {} : { onExpandRef: input.onMemoryExpand }),
    refDetails: input.memoryDetails,
  });

  if (input.approvals !== null) {
    panels.approvals = createElement(ApprovalQueue, {
      controller,
      snapshot,
      // 证据行由队列模块导出：会话卡片渲染同一份字段（见 `approvalItemOf`）。
      items: input.approvals.map(approvalItemOf),
      now,
    });
  }

  if (input.scope !== null) {
    const scope = input.scope;
    const currentTargets = scope.current?.targets ?? [];
    const currentExclusions = scope.current?.exclusions ?? [];
    panels.scope = createElement(ScopeManager, {
      controller,
      snapshot,
      current: scope.current,
      history: scope.history,
      candidateAssets: toCandidateAssets(input.candidateAssets ?? []),
      // 新版本 = 当前范围 + 本轮纳入/排除的候选。服务端仍会规范化并整体校验（§10.2.2）。
      planAmendment: (decisions: readonly AssetScopeDecision[]) => {
        const included = decisions
          .filter((decision) => decision.decision === 'included')
          .map((decision) => toScopeTarget(decision.assetId));
        const excluded = decisions
          .filter((decision) => decision.decision === 'excluded')
          .map((decision) => toScopeTarget(decision.assetId));
        return {
          targets: [...currentTargets, ...included],
          exclusions: [...currentExclusions, ...excluded],
        };
      },
      now,
    });
  }

  if (input.skills !== null) {
    panels.skills = createElement(SkillLibrary, {
      controller,
      snapshot,
      skills: input.skills,
      onAddSkill: input.onAddSkill,
      onUpdateSkill: input.onUpdateSkill,
      onRemoveSkill: input.onRemoveSkill,
    });
  }

  // 公共记忆：始终渲染（即使还没读到）——它是「可编辑的当前状态」，
  // 空着与「尚未读取」是两件事，面板自己会区分并各给文案。
  panels.publicmemory = createElement(PublicMemoryPanel, {
    controller,
    snapshot,
    memory: input.publicMemory,
    onSave: input.onSavePublicMemory,
    now,
  });

  panels.memory = createElement(MemoryExplorer, {
    controller,
    snapshot,
    hits: input.memoryHits ?? [],
    watermark: input.memoryWatermark,
    searched: input.memorySearched,
    error: input.memoryError ?? null,
    initialForm: input.memoryInitialForm ?? undefined,
    details: input.memoryDetails,
    onSearch: input.onMemorySearch,
    onExpand: input.onMemoryExpand,
    now,
  });

  return panels;
}
