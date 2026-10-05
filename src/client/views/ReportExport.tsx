/**
 * 报告签字与导出。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.9（签字前置条件）、§6.2.1（报告编辑器职责）
 *
 * ── 两条硬规则 ──
 *
 * 1. **未处置条目阻止签字**：`undisposedCount > 0` 时签字按钮禁用并写明还剩多少条。
 *    这不是界面偏好——服务端 `pg-workflow.ts` 的 `signReport` 会先调
 *    `report.listUndisposed()`，非空即拒绝（契约错误码 `handoff_incomplete`）。
 *    因此界面只是把**同一个**前置条件提前告诉人类，而不是自己发明一条规则。
 * 2. **不显示模型生成的「批准」字样**：签字状态只从 Host 事实派生
 *    （`snapshot.state.mainStatus === 'complete'`），绝不从报告草稿正文里读
 *    「已批准 / approved」这类模型措辞。真实决策只来自 Host RPC（§4.1）。
 *
 * ── 端点现状（决定了本组件的接线方式）──
 *
 * 报告面（契约的 `PentestReportService`）的 7 个端点**全部在**控制台方法表里
 * （`src/console/rpc.ts` 的 `REPORT_METHOD_TABLE`，与 workflow / memory / skills 并列的
 * 第四个服务面）。因此本组件不需要「端点缺口」的日子已经过去了：
 *
 * - `signReport`（workflow 面，锁 `actor`、`reason: false`）：签字经
 *   `controller.signReport(contentHash, …)` 直接提交。
 * - `exportReport`（`kind: 'read'`、`operator: true`、`reason: false`）：导出**经
 *   `onExport` 回调**转到调用方（`ConsoleApp` 里即 `controller.exportReport(format)`）。
 *
 * `onExport` 是**真实的接线约定**，不是端点缺席时的替代品：本组件刻意不直接发 RPC
 * （保持纯 props、可服务端渲染、可脱开控制器单测），所以「谁去调用控制器」必须由外层
 * 指明。两种禁用原因因此是两件不同的事实——没接线（`wiring-missing`）与接了线但当
 * 前没有选中作业（`engagement-missing`）——界面分开报出，不互相冒充。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ExportRequest, ExportResult, MainStatus, ReportDraft } from '../../contracts.ts';
// **值导入**必须来自零依赖清单：`console/rpc.ts` 的实现链会拉到 `node:crypto`，
// 浏览器产物里出现 `require("node:")` 会让整个插件加载失败（2026-10-05 复核 REQ-13c）。
import { isConsoleMethod } from '../../console/method-names.ts';
import type { ConsoleMethodName } from '../../console/method-names.ts';
import type { PentestReportService } from '../../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatCount, mainStatusLabel, runMarkerLabel, truncate } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, List, Stat } from '../ui.tsx';
import { GateList, type GateBlocker } from './GateList.tsx';

// ─────────────── 常量与端点现状 ───────────────

/** 报告导出端点名。已在方法表里——见文件头「端点现状」。 */
export const REPORT_EXPORT_METHOD_NAME = 'exportReport';

/**
 * 报告面（契约 `PentestReportService`）在控制台上的端点名。
 *
 * `satisfies` 把这份清单**绑到契约上**：每个名字都必须是
 * 「`PentestReportService` 的成员」**且**「控制台端点」。因此
 *   - 服务方法改名/删除 → 这里编译失败（不会留下一个指向不存在端点的名字）；
 *   - 打错字（例如把 `getReportDraft` 写成 `getDraft`）→ 同样编译失败。
 *
 * 这正是一处实测缺陷：清单里曾写 `getDraft`（真实端点是 `getReportDraft`），
 * 而它只被用来做运行时探测，于是界面**长期显示一句假的「端点缺口」**——
 * 报告面 7 个端点其实全在表里。当时靠 `readonly string[]` 谁也没拦住。
 *
 * 漏写（而不是写错）由 `test/client-report-views.test.ts` 的条数断言兜住。
 */
type ReportEndpointName = Extract<keyof PentestReportService, ConsoleMethodName>;

export const REPORT_FACE_METHOD_NAMES = [
  'getReportDraft',
  'listFindings',
  'dispositionFinding',
  'updateReport',
  'redactPreview',
  'exportReport',
  'listUndisposed',
] as const satisfies readonly ReportEndpointName[];

/**
 * 上面这些名字里，**不在**控制台方法表里的。
 *
 * 空数组表示报告面已经挂上。它是运行时探测（而不是一份写死的事实），下方据此决定
 * 是否渲染「端点缺口」说明——这样端点表变动时界面自动跟上，不必有人回来改文案。
 */
export const MISSING_CONSOLE_METHODS: readonly string[] = REPORT_FACE_METHOD_NAMES.filter(
  (name) => !isConsoleMethod(name),
);

/**
 * 导出端点是否已挂到控制台方法表上。
 *
 * 端点存在**只是导出可用的必要条件**：还要调用方提供 `onExport`（见文件头「端点现状」）。
 * 两者分开探测，是因为「控制台没这个端点」与「这次点击没人接」的责任人不同。
 */
export const REPORT_EXPORT_ENDPOINT_EXPORTED: boolean = isConsoleMethod(REPORT_EXPORT_METHOD_NAME);

/**
 * 信封要求的审计理由。
 *
 * `signReport` 的输入契约里没有 `reason` 字段（`METHOD_TABLE` 里也是 `reason: false`）
 * ——签字以内容哈希为准，不要求人类写自由文本。但信封一律要求非空理由（§16.1 审计），
 * 所以这里给一条固定说明；人类意见落在报告正文与结论处置理由里。
 * 服务端另会把 `human_decisions.reason` 记成「报告签字并导出」。
 */
const SIGN_AUDIT_REASON = '人类在控制台报告审阅页签字确认该内容哈希';

export type ExportFormat = ExportRequest['format'];

const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  markdown: '导出 Markdown',
  json: '导出 JSON',
};

// ─────────────── 纯规则（可独立测试） ───────────────

/**
 * 一条闸门：`code` 供分支与测试使用（渲染成 `data-blocker`），`message` 是给人看的原因。
 *
 * 形状与共享组件同源（见 `GateList.tsx`）；别名保留是因为这个面**导出**了它
 * （`signBlockers` / `exportBlockers` 的返回类型），调用方按这个面取类型。
 */
export type ExportGateBlocker = GateBlocker;

/** 签字按钮的前置条件。 */
export interface SignGateInput {
  readonly engagementId: string | null;
  /** 当前主状态；`null` 表示尚未读到工作流状态。 */
  readonly mainStatus: MainStatus | null;
  /** 是否已有报告草稿（`getDraft` / `finishTechnicalTesting` 的结果）。 */
  readonly draftVersion: number | null;
  /** 待签字的内容哈希；服务端把它记入 `human_decisions.subject_id`。 */
  readonly contentHash: string | null;
  /** 未处置结论数（Host 的 `listUndisposed` 结果）。 */
  readonly undisposedCount: number;
}

/**
 * 签字闸门。空数组 = 可以签字。
 *
 * §8.9 的顺序：先把「未处置条目」这条产品前置条件摆出来，再摆环境前提。
 * 界面与服务端**各自独立**判定同一条规则：服务端是权威（拒绝即拒绝），界面负责提前解释。
 */
export function signBlockers(input: SignGateInput): readonly ExportGateBlocker[] {
  const blockers: ExportGateBlocker[] = [];
  if (input.undisposedCount > 0) {
    blockers.push({
      code: 'undisposed-findings',
      message: `还有 ${formatCount(input.undisposedCount)} 条结论未处置：§8.9 不允许带着未处置条目出报告`,
    });
  }
  if (input.engagementId === null) {
    blockers.push({ code: 'engagement-missing', message: '尚未选中 engagement：先在列表里选一个作业' });
  }
  if (input.draftVersion === null) {
    blockers.push({
      code: 'draft-missing',
      message: '还没有报告草稿：先完成技术测试（finishTechnicalTesting）生成草稿',
    });
  }
  if (input.contentHash === null) {
    blockers.push({
      code: 'content-hash-missing',
      message: '尚无内容哈希：Host 未返回报告版本引用，§8.9 的签字以内容哈希为准',
    });
  }
  if (input.mainStatus === null) {
    blockers.push({ code: 'state-unknown', message: '尚未读到工作流状态：无法确认报告已就绪' });
  } else if (input.mainStatus !== 'report_ready') {
    blockers.push({
      code: 'not-report-ready',
      message: `只有报告就绪状态可以签字（当前：${mainStatusLabel(input.mainStatus)}）`,
    });
  }
  return blockers;
}

/** 导出按钮的前置条件。**不含签字状态**：§8.9 允许签字前导出供人工审阅。 */
export interface ExportGateInput {
  readonly engagementId: string | null;
  readonly endpointExported: boolean;
  readonly wired: boolean;
}

export function exportBlockers(input: ExportGateInput): readonly ExportGateBlocker[] {
  const blockers: ExportGateBlocker[] = [];
  if (input.engagementId === null) {
    blockers.push({ code: 'engagement-missing', message: '尚未选中 engagement：先在列表里选一个作业' });
  }
  if (!input.endpointExported) {
    blockers.push({
      code: 'endpoint-missing',
      message: `控制台未导出端点 ${REPORT_EXPORT_METHOD_NAME}（console/method-unavailable）：导出发不出去`,
    });
  }
  if (!input.wired) {
    blockers.push({
      code: 'wiring-missing',
      message: `调用方未提供 onExport：本视图不直接发 RPC，导出要由外层接线到 ${REPORT_EXPORT_METHOD_NAME}`,
    });
  }
  return blockers;
}

// ─────────────── 组件 ───────────────

/** 导出结果：成功带 `ExportResult`，失败带稳定错误码。 */
export type ExportOutcome =
  | { readonly ok: true; readonly result: ExportResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 签字结果。与处置同一形状：成功、失败、或调用方只想知道「发出去了」。 */
export type SignOutcome =
  | { readonly ok: true; readonly replay: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface ReportExportProps {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 报告草稿；`null` 表示 Host 还没生成（`getDraft` 无版本时导出会落一版草稿）。 */
  readonly draft: ReportDraft | null;
  /**
   * 未处置结论数（Host 的 `listUndisposed` 结果）。
   *
   * 必须来自 Host，不能由界面从结论投影里「推算」：草稿里可能还有界面没加载的条目，
   * 而这条数字正是签字硬前置条件的判据（§8.9）。
   */
  readonly undisposedCount: number;
  /** 待签字的内容哈希（报告版本引用的哈希，或最近一次导出的哈希）。 */
  readonly contentHash?: string | null;
  /** 需人工注意的限制项（报告投影里的限制条件，§6.2.1）。 */
  readonly limitations?: readonly string[];
  /** 导出的接线点。缺省时导出按钮禁用并说明原因（见文件头「端点现状」）。 */
  readonly onExport?: (format: ExportFormat) => ExportOutcome | Promise<ExportOutcome> | void;
  /** 端点可用性的覆盖值，默认取控制台方法表的运行时探测（测试与宿主自定义面用）。 */
  readonly endpointExported?: boolean;
}

export function ReportExport(props: ReportExportProps): ReactNode {
  const endpointExported = props.endpointExported ?? REPORT_EXPORT_ENDPOINT_EXPORTED;
  const wired = props.onExport !== undefined;
  const engagementId = props.snapshot.selectedEngagementId;
  const mainStatus = props.snapshot.state?.mainStatus ?? null;
  const contentHash = props.contentHash ?? null;
  const signed = mainStatus === 'complete';
  const [busy, setBusy] = useState(false);
  const [signOutcome, setSignOutcome] = useState<SignOutcome | null>(null);
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome | null>(null);

  const signGate: readonly ExportGateBlocker[] = signBlockers({
    engagementId,
    mainStatus,
    draftVersion: props.draft?.version ?? null,
    contentHash,
    undisposedCount: props.undisposedCount,
  });
  const exportGate: readonly ExportGateBlocker[] = exportBlockers({
    engagementId,
    endpointExported,
    wired,
  });
  // 限制项按序号建键：文案可能重复（两条限制说同一件事是允许的），重复的 key 会让 React
  // 复用错误的节点，因此键取自位置而不是内容。
  const limitations = (props.limitations ?? []).map((text, index) => ({ key: `${String(index)}`, text }));

  const sign = (): void => {
    if (signGate.length > 0 || contentHash === null || busy) return;
    setBusy(true);
    void props.controller
      .signReport(contentHash, SIGN_AUDIT_REASON)
      .then((result) => {
        setBusy(false);
        setSignOutcome(
          result.ok
            ? { ok: true, replay: result.replay }
            : { ok: false, code: result.code, message: result.message },
        );
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setSignOutcome({
          ok: false,
          code: 'client/sign-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  const runExport = (format: ExportFormat): void => {
    if (exportGate.length > 0 || props.onExport === undefined || busy) return;
    setBusy(true);
    void Promise.resolve(props.onExport(format))
      .then((resolved) => {
        setBusy(false);
        if (resolved !== undefined) setExportOutcome(resolved);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setExportOutcome({
          ok: false,
          code: 'client/export-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  return (
    <Card title="报告签字与导出（§8.9）">
      <div className="pentest-report-export__summary">
        <Stat
          label="报告版本"
          value={props.draft === null ? '—' : `v${formatCount(props.draft.version)}`}
          hint={props.draft === null ? 'Host 还没有报告草稿' : '报告版本号在 engagement 级锁内分配（§15.4）'}
        />
        <Stat
          label="内容哈希"
          value={contentHash === null ? '—' : truncate(contentHash, 16)}
          tone={contentHash === null ? 'attention' : 'neutral'}
          hint={
            contentHash === null
              ? '尚无哈希：签字以内容哈希为准，没有哈希不能签字（§8.9）'
              : `签字绑定到该哈希（服务端记入 human_decisions.subject_id）：${contentHash}`
          }
        />
        <Stat
          label="未处置结论"
          value={formatCount(props.undisposedCount)}
          tone={props.undisposedCount > 0 ? 'danger' : 'done'}
          hint="Host 的 listUndisposed 结果；> 0 时签字被硬阻断（§8.9）"
        />
        <Stat
          label="主状态"
          value={mainStatus === null ? '—' : mainStatusLabel(mainStatus)}
          tone={signed ? 'done' : mainStatus === 'report_ready' ? 'active' : 'neutral'}
          hint="状态来自 Host 快照（§4.1：客户端不持有权威状态）"
        />
        <Stat
          label="运行标记"
          value={props.snapshot.state === null ? '—' : runMarkerLabel(props.snapshot.state.runMarker)}
        />
      </div>

      {/*
        签字状态只从 Host 事实派生。草稿正文里可能出现模型写的「已批准 / approved」措辞——
        那不是决策，真实决策只来自 Host RPC（§4.1），因此本组件**不读正文判断签字状态**。
      */}
      {signed ? (
        <p className="pentest-report-export__signed">
          报告已签字：Host 状态为「已完成」（决策经 signReport 落库，非模型声明）。
        </p>
      ) : null}

      <Field label="需人工注意的限制项" hint="报告投影里的限制条件（§6.2.1 要求列出，不能省略）">
        <List
          items={limitations}
          keyOf={(item) => item.key}
          render={(item) => <span className="pentest-report-export__limitation">{item.text}</span>}
          empty={
            <Empty
              title="未标注限制项"
              reason="这不等于没有限制：报告投影未提供限制条件，签字前请人工确认（§6.2.1）"
            />
          }
        />
      </Field>

      {MISSING_CONSOLE_METHODS.length === 0 ? null : (
        <p className="pentest-report-export__gap">
          {`端点缺口：以下报告面端点不在控制台方法表里（console/method-unavailable）——${MISSING_CONSOLE_METHODS.join('、')}。`}
          {' 缺哪个就少哪条链路；导出另外还要求调用方经 onExport 接线（本视图不直接发 RPC）。'}
        </p>
      )}

      <div className="pentest-report-export__gates">
        <GateList blockers={signGate} label="签字前置条件" />
        <GateList blockers={exportGate} label="导出前置条件" />
      </div>
      <div className="pentest-report-export__actions">
        <Button
          label="签字"
          kind="primary"
          tone="done"
          disabled={signGate.length > 0 || busy || signed}
          reason={signed ? '报告已签字（Host 状态已完成）' : (signGate[0]?.message ?? '正在提交：等待上一次操作返回')}
          onClick={sign}
        />
        {(['markdown', 'json'] as const).map((format) => (
          <Button
            key={format}
            label={FORMAT_LABELS[format]}
            disabled={exportGate.length > 0 || busy}
            reason={exportGate[0]?.message ?? '正在导出：等待上一次操作返回'}
            onClick={() => {
              runExport(format);
            }}
          />
        ))}
        {busy ? <Badge text="提交中" tone="active" /> : null}
      </div>

      {signOutcome === null ? null : signOutcome.ok ? (
        <Badge
          text={signOutcome.replay ? '签字已记录（幂等重放，未重复执行）' : '签字已记录'}
          tone="done"
          hint="结果来自 Host RPC（§15.3）"
        />
      ) : (
        <ErrorBar code={signOutcome.code} message={signOutcome.message} />
      )}

      {exportOutcome === null ? null : exportOutcome.ok ? (
        <div className="pentest-report-export__result">
          <Stat label="文件名" value={exportOutcome.result.fileName} />
          <Stat label="媒体类型" value={exportOutcome.result.mediaType} />
          <Stat label="字节数" value={formatCount(exportOutcome.result.byteSize)} />
          <Stat
            label="导出内容哈希"
            value={truncate(exportOutcome.result.contentHash, 16)}
            hint="与签字用的哈希比对：不一致说明导出的是另一个版本（§8.9）"
          />
          <p className="pentest-report-export__hint">
            完整导出内容由宿主的下载通道交付，不在本页内联（避免把报告正文灌进 DOM）。
          </p>
        </div>
      ) : (
        <ErrorBar code={exportOutcome.code} message={exportOutcome.message} />
      )}

      {props.snapshot.lastError === null ? null : (
        <ErrorBar code={props.snapshot.lastError.code} message={props.snapshot.lastError.message} />
      )}
    </Card>
  );
}
