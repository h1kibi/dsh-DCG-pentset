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
 *
 * ── 面板名称历史（2026-10-09 重构）──
 *
 * 为避免现存书签/链接中断，需特别说明：
 * - `overview` → 改名为 `console`（阶段轨道 + 运行控制 + 诊断）
 * - 时间轴与 Agent 轨迹 → 移入新的 `logs` 面板
 * - 报告审阅、记忆浏览器、交接编辑 → 已删除（视图文件保留供测试用）
 *
 * URL 迁移：
 * - 旧书签 `?panel=overview` → 将被导航到 `?panel=console`（客户端 301 逻辑）
 * - 旧书签 `?panel=memory_browser` → 将被导航到 `?panel=logs`（合并了时间轴）
 * - 若需编辑交接内容，用「交接材料」部分的「编辑」按钮，不再有独立面板
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';

import type {
  ApprovalDetail,
  AssetScopeDecision,
  CandidateAsset,
  EngagementMemory,
  Finding,
  NetworkAsset,
  ScopeDetail,
  ScopeTarget,
  SkillSummary,
} from '../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from './controller.ts';
import { ApprovalQueue, approvalItemOf } from './views/ApprovalQueue.tsx';
import { ScopeManager } from './views/ScopeManager.tsx';
import { SkillLibrary } from './views/SkillLibrary.tsx';
import { PublicMemoryPanel } from './views/PublicMemoryPanel.tsx';
import { VulnerabilityList } from './views/VulnerabilityList.tsx';
import { AssetList } from './views/AssetList.tsx';
import type {
  SkillAddInput,
  SkillRemoveInput,
  SkillUpdateInput,
} from './views/SkillLibrary.tsx';
import type { CandidateAsset as CandidateAssetView } from './views/ScopeManager.tsx';
import type { ConsolePanel } from './views/ConsoleShell.tsx';

// ───────────────────────── 契约 → 视图 ─────────────────────────

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

  /** 放行队列。 */
  readonly approvals: readonly ApprovalDetail[] | null;

  /** 范围版本（`history` 只在请求过历史时有值）。 */
  readonly scope: ScopeDetail | null;
  readonly candidateAssets: readonly CandidateAsset[] | null;

  /** skill 库。 */
  readonly skills: readonly SkillSummary[] | null;
  readonly onAddSkill: (input: SkillAddInput) => void;
  readonly onUpdateSkill: (input: SkillUpdateInput) => void;
  readonly onRemoveSkill: (input: SkillRemoveInput) => void;

  /**
   * 公共记忆；`null` = 尚未成功读取。
   */
  readonly publicMemory: EngagementMemory | null;
  readonly onSavePublicMemory: (content: string, reason: string) => Promise<void> | void;

  /** 结论（控制台「漏洞列表」面板；`null` = 尚未成功读取）。 */
  readonly findings: readonly Finding[] | null;

  /** 资产清单（控制台「资产」面板；`null` = 尚未成功读取）。 */
  readonly assets: readonly NetworkAsset[] | null;
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


  if (input.approvals !== null) {
    panels.approvals = createElement(ApprovalQueue, {
      controller,
      snapshot,
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
  panels['public-memory'] = createElement(PublicMemoryPanel, {
    controller,
    snapshot,
    memory: input.publicMemory,
    onSave: input.onSavePublicMemory,
    now,
  });

  if (input.findings !== null) {
    panels.vulnerabilities = createElement(VulnerabilityList, {
      findings: input.findings,
    });
  }

  if (input.assets !== null) {
    panels.assets = createElement(AssetList, {
      assets: input.assets,
      now,
    });
  }

  return panels;
}
