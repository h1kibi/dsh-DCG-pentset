/**
 * 控制台契约的**零依赖常量与端点名清单**。
 *
 * ── 为什么要单独一个模块 ──
 *
 * 浏览器侧视图与 `ConsoleClient` 只需要「命名空间/通道/端点名」这几个常量，而
 * `console/rpc.ts` 的实现链会拉到 `node:crypto`（会话摘要 `sha256Hex`）。
 * 此前这些值都从 rpc.ts 取，那条 `node:` 边只靠 tree-shaking 才没进产物
 * （2026-10-05 复核 REQ-13c）——「产物里没有 node: 依赖」当时是构建系统的运气，
 * 不是源码事实。抽成零依赖模块后，客户端图里根本不出现 rpc.ts。
 *
 * ── 单一来源 ──
 *
 * 清单与 `rpc.ts` 的方法表在**加载期**对齐（rpc.ts 断言两边逐字一致，不一致直接抛），
 * 并有 `test/console-rpc.test.ts` 锁定；两边漂移会立刻失败，而不是静默放行。
 */

/**
 * 控制台端点的 Remote **命名空间**，同时是宿主侧的 cordis 服务键。
 *
 * 它决定浏览器里的端点路径：`POST /api/pentest/<method>`。
 * 必须匹配宿主的段名规则 `/^[A-Za-z0-9_$.-]+$/`（`pentest` 合法；带斜杠或空格的键会被拒）。
 *
 * 放在零依赖模块而不是 `typert-face.ts`：后者依赖 cordis 与 typert 协议，
 * **不能进浏览器产物**；而客户端要拼同一个前缀，两侧必须来自同一处，否则改一处就静默 404。
 */
export const CONSOLE_TYPRET_SERVICE = 'pentest';

/**
 * 控制台端点所在的通道。
 *
 * 固定为 `/api`：端点是**共享网关**上的 Remote（`/api/<namespace>/<method>`），
 * 不再自建通道——`connection.rpc.handle()` 在本版本对任何调用方都抛
 * `cannot get property "webServer" without inject`（详见 `typert-face.ts`）。
 *
 * 宿主的通道规则是 `/^\/[A-Za-z0-9._~-]+$/`（**单层**）：`/api` 合法，
 * `/rpc/pentest` 这类两层名会在客户端被拒（`invalid RPC target`）。
 */
export const DEFAULT_CONSOLE_CHANNEL = '/api';

/** 端点名（声明序近似 §16.1 的列出顺序，按服务面分组）。 */
export const CONSOLE_METHOD_NAMES = [
  'createEngagement',
  'openTask',
  'getIntakeStatus',
  'getScopeProposal',
  'confirmScopeProposal',
  'rejectScopeProposal',
  'listEngagements',
  'listWorkerSessions',
  'getWorkerReport',
  'beginHandoff',
  'currentHandoffDraft',
  'previewScope',
  'previewPolicy',
  'listApprovals',
  'getEngagementMemory',
  'updateEngagementMemory',
  'getScope',
  'listCandidateAssets',
  'getState',
  'startWorker',
  'cancelHandoff',
  'confirmTransition',
  'retryWorker',
  'reopenTechnicalWork',
  'amendScope',
  'archiveEngagement',
  'previewEngagementPurge',
  'purgeEngagement',
  'setApprovalMode',
  'extendBudget',
  'interject',
  'pause',
  'resume',
  'abort',
  'decideApproval',
  'revokeApproval',
  'finishTechnicalTesting',
  'signReport',
  'getReportDraft',
  'listFindings',
  'dispositionFinding',
  'updateReport',
  'redactPreview',
  'exportReport',
  'listUndisposed',
  'listAssets',
  'searchMemory',
  'readMemory',
  'memoryWatermark',
  'verifyLedger',
  'listSkills',
  'addSkill',
  'updateSkill',
  'removeSkill',
  'getDiagnostics',
] as const;

export type ConsoleMethodName = (typeof CONSOLE_METHOD_NAMES)[number];

const KNOWN_METHODS: ReadonlySet<string> = new Set(CONSOLE_METHOD_NAMES);

/** 端点是否存在。用 `Set` 而不是对象字面量索引：不受原型链影响。 */
export function isConsoleMethod(name: string): name is ConsoleMethodName {
  return KNOWN_METHODS.has(name);
}
