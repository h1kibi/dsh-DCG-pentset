/**
 * 测试用的控制台服务面：以真实 workflow 面为主，其余三个面配**会抛错的桩**。
 *
 * ── 为什么桩要抛错而不是返回空值 ──
 *
 * `ConsoleRpc` 现在要求四个服务面（`ConsoleServices`），因为控制台的九个面板
 * 各自依赖其中至少一个。测试若只关心 workflow 面，给其余面一个「返回空值」的桩，
 * 会让「某个端点悄悄调到了不该调的面」表现得像「正常返回了空数据」——
 * 那种失败很难定位。抛错则立刻指出调用点。
 *
 * 这与 `compose.ts` 里 `missingSessionFactory` 的处理是同一原则：
 * 缺依赖时明确失败，好过静默给出错误结果。
 *
 * ── 用法 ──
 *
 * ```ts
 * import { consoleServicesStub } from './helpers/console-services.ts';
 * const rpc = new ConsoleRpc({ services: consoleServicesStub(workflow) });
 * ```
 */

import type { ConsoleServices } from '../../src/console/rpc.ts';
import type {
  HumanWorkflowService,
  PentestDiagnosticsService,
  PentestMemoryQueryService,
  PentestReportService,
  PentestSkillService,
} from '../../src/contracts.ts';

/** 造一个「每个方法都抛错」的桩，用于未被测试关注的服务面。 */
function throwingFace<T extends object>(faceName: string): T {
  const handler: ProxyHandler<T> = {
    get(_target, property): unknown {
      if (typeof property !== 'string') return undefined;
      // 让 `then` 返回 undefined：否则桩会被误判为 thenable，async 上下文会挂起
      if (property === 'then') return undefined;
      return async (): Promise<never> => {
        throw new Error(
          `测试未提供 ${faceName}.${property}：本次测试只关注 workflow 面。` +
            `若被测代码调用到了这里，说明它越过了预期的服务面——请显式提供该面的桩实现。`,
        );
      };
    },
  };
  return new Proxy({} as T, handler);
}

/**
 * 组装控制台服务面：`workflow` 用调用方给的实现，其余三个面是抛错桩。
 *
 * `overrides` 允许测试只提供它关心的那个面（例如报告端点的测试给 `report`）。
 */
export function consoleServicesStub(
  workflow: HumanWorkflowService,
  overrides: {
    readonly report?: PentestReportService;
    readonly memory?: PentestMemoryQueryService;
    readonly skills?: PentestSkillService;
    readonly diagnostics?: PentestDiagnosticsService;
  } = {},
): ConsoleServices {
  return {
    workflow,
    report: overrides.report ?? throwingFace<PentestReportService>('report'),
    memory: overrides.memory ?? throwingFace<PentestMemoryQueryService>('memory'),
    skills: overrides.skills ?? throwingFace<PentestSkillService>('skills'),
    diagnostics: overrides.diagnostics ?? throwingFace<PentestDiagnosticsService>('diagnostics'),
  };
}
