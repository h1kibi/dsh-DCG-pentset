import type { Context } from '@deepseek-ai/cordis';

/**
 * 客户端警告出口。
 *
 * `console` 出口是**必需的**，不是冗余：cordis 的 logger 默认只把消息写进内存环形缓冲，
 * 不接到 console。只走 logger 的警告在浏览器 DevTools 里一个字都看不到——那会让
 * 「插件静默降级」变成一个没有任何线索的黑洞。
 */
export function logWarn(ctx: Context, message: string): void {
  console.warn(`[dsh-pentest-client] ${message}`);

  if (!('logger' in ctx)) return;
  const logger: unknown = ctx.logger;
  if (typeof logger === 'function') {
    const named: unknown = logger.call(ctx, 'dsh-pentest-client');
    if (named !== null && typeof named === 'object' && 'warn' in named) {
      const warn: unknown = named.warn;
      if (typeof warn === 'function') warn.call(named, message);
    }
  }
}
