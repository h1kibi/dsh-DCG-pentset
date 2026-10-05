/**
 * NOTIFY 唤醒适配器：把数据库通知变成 `IndexScheduler.wakeNow()`。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.4（Streaming RAG 管线：
 * 「唤醒通知只传递任务标识或水位；可靠性由任务队列表承担」）、§5.4 第 8 步
 * （「写索引任务队列，事务提交后发出唤醒通知」「唤醒通知只用于降低界面与索引
 * 延迟……通知丢失不会造成状态不一致」）、§12.1（多实例下唤醒通知只用于降低
 * 延迟，实例启动后必须扫描未完成任务）、§14.2（指标）。
 *
 * ── 这个模块补的是什么缺口 ──
 *
 * `outbox_jobs` 入队之后，`IndexScheduler` 要等到下一个周期（默认 15 秒）才会
 * 排空队列：人类刚发送的消息在检索面里要空窗十几秒。本模块把 `LISTEN`/
 * `NOTIFY` 的通知接成一次立即 tick，把这个空窗压掉。
 *
 * ── 四条纪律 ──
 *
 * 1. **通知不是可靠性来源**。它可能丢——连接断开、防火墙掐断、订阅建立之前
 *    就已提交的事务。丢了只晚一个间隔，不会漏任务：调度器本来就在周期扫描，
 *    启动时还会重扫一遍（§14.3）。因此本模块**不做**补偿、重放或投递确认；
 *    收到通知就无条件唤醒，负载内容一概不看（它只是「去队列看一眼」的提示）。
 * 2. **断线不能是终态**。长连接会被数据库重启、防火墙空闲回收、NAT 超时切断。
 *    断开后必须自动重连（指数退避 + 上限），否则通知能力在第一次抖动后就永久
 *    消失——那是静默降级，没人会注意到。
 * 3. **不阻止宿主退出**。重连定时器必须 `unref()`：否则只要退避在等，dsh 进程
 *    就退不出去（与 `IndexScheduler` 同一条纪律）。
 * 4. **不把连接故障抛到启动路径上**。`start()` 与 `scheduler.start()` 是同一个
 *    调用位置（`apply`）；数据库正好在重启时抛错会连带让整个插件加载失败，
 *    而通知本来只是延迟优化。连接失败记进 `onError` 并持续重试。
 *
 * ── 端口而不是 `new Pool()` ──
 *
 * 本模块不读环境变量、不自己建连接池：连接由装配层注入（见
 * {@link NotifyListenerDeps.connect}），测试用假连接即可覆盖全部逻辑。
 * 真实实现 {@link createPgNotifyConnection} 一并导出，但它**必须**是独立连接
 * （理由见该函数的注释）。
 */

import { Client } from 'pg';
import type { Notification } from 'pg';

import type { TimerHandle } from './scheduler.ts';

// ───────────────────────────── 通道名 ─────────────────────────────

/**
 * 订阅通道名。
 *
 * 为什么是这个形状：
 *
 * - **带命名空间**：`pentest_` 前缀避免与宿主或其它插件共用数据库时撞名
 *   （§12.1 允许多个 dsh 实例共享同一个数据库）。
 * - **全小写、下划线分隔，且按标识符看待**：PostgreSQL 的通道名在
 *   `LISTEN <标识符>` 里会被**折叠为小写**，而在 `pg_notify(<字符串>)` 里是
 *   **区分大小写的字符串**。若通道名带大写字母而收发两侧一侧当标识符、一侧当
 *   字符串，就会订阅到一个永远收不到消息的名字，且不报任何错。全小写让两种
 *   写法落到同一个名字上，这个坑就不存在了；适配器侧仍然显式加双引号
 *   （见 {@link createPgNotifyConnection}），双保险。
 * - 长度远小于 63 字节（PostgreSQL 标识符上限），不会被截断。
 *
 * 入队侧（`outbox` 的事务内）必须用**同一个常量**发通知，不要手写字符串。
 */
export const NOTIFY_CHANNEL = 'pentest_outbox';

// ───────────────────────────── 端口 ─────────────────────────────

/**
 * 唤醒目标。`IndexScheduler` 结构上就满足它——`wakeNow()` 是唯一的必需品。
 */
export interface NotifyTarget {
  /** 立刻触发一次索引 tick。它内部不重叠，因此连续调用不会堆叠。 */
  wakeNow(): void;
}

/**
 * 已订阅的连接，由装配层提供的适配器实现。
 *
 * **两份契约，实现必须满足**（否则监听循环会挂起或重复订阅）：
 *
 * 1. `listen()` 返回的 Promise 是**连接的寿命**：连接可用期间保持 pending，
 *    连接正常结束（服务端关闭）时 resolve，异常断开时 reject。不是「订阅完成
 *    就 resolve」——那样监听器无从得知何时该重连。
 * 2. `close()` **幂等**，且必然让 `listen()` 的 Promise 结算：`stop()` 用它把
 *    连接从等待中唤醒（否则停止会死等一条永不结束的连接），重连路径也会在
 *    断开后再调一次做清理。
 */
export interface NotifyConnection {
  /** 订阅 `channel`；`handler` 收到该通道的每条通知（含空负载）。 */
  listen(channel: string, handler: (payload: string) => void): Promise<void>;
  /** 关闭连接，并让 `listen()` 的 Promise 结算。幂等。 */
  close(): Promise<void>;
}

// ───────────────────────────── 退避 ─────────────────────────────

export interface NotifyBackoff {
  /** 第一次失败后的等待（毫秒），也是递增的起点。 */
  readonly initialDelayMs: number;
  /** 等待上限（毫秒）。 */
  readonly maxDelayMs: number;
}

/**
 * 默认退避：1 秒起步，翻倍，封顶 30 秒。
 *
 * 1 秒起步是因为数据库重启通常几秒内恢复，这一段等待决定通知面恢复的速度；
 * 30 秒封顶是因为再长已经没有意义——周期扫描的间隔就是 15 秒，通知彻底失效
 * 的代价已经被周期兜住了，继续拉长只会让恢复更慢。
 *
 * 刻意**不加抖动**：抖动是为「大量客户端同时重连打垮数据库」准备的，§12.1 的
 * 部署形态是单机或少量实例共享数据库，不值得为它牺牲可预测性（退避序列要能
 * 被测试与日志逐项核对）。
 */
export const DEFAULT_NOTIFY_BACKOFF: NotifyBackoff = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * 默认退避序列的公式：`min(initialDelayMs × 2^(attempt-1), maxDelayMs)`，
 * 即 1s、2s、4s、8s、16s、30s、30s……
 *
 * 指数封顶在 2^30 而不是直接 `2 ** (attempt-1)`：`attempt` 没有上限，
 * 不封指数会溢出成 `Infinity`。
 */
function backoffDelayMs(attempt: number, backoff: NotifyBackoff): number {
  return Math.min(backoff.initialDelayMs * 2 ** Math.min(attempt - 1, 30), backoff.maxDelayMs);
}

// ───────────────────────────── 依赖 ─────────────────────────────

/** 事故发生的环节，用于区分「连不上」与「连上了但被断开」。 */
export type NotifyErrorPhase =
  /** `connect()` 失败：数据库不可达、认证失败。 */
  | 'connect'
  /** 订阅期间失败：连接在此阶段断开。 */
  | 'listen'
  /** 关闭连接时失败（停止路径，已吞掉不影响停止）。 */
  | 'close'
  /** 唤醒目标抛错（`wakeNow()` 的事故不应波及连接循环）。 */
  | 'notify';

export interface NotifyListenerDeps {
  readonly target: NotifyTarget;
  /**
   * 建立一条**新**连接。断开后重连会再次调用它——旧连接不可复用。
   *
   * 真实场景用 `() => createPgNotifyConnection(url)`。
   */
  readonly connect: () => Promise<NotifyConnection>;
  /** 订阅通道；省略即用 {@link NOTIFY_CHANNEL}。 */
  readonly channel?: string;
  /** 退避参数（可只覆盖一项）。 */
  readonly backoff?: Partial<NotifyBackoff>;
  /** 每次事故的回调（§14.2 指标）。观测回调自己抛错不会影响监听。 */
  readonly onError?: (error: unknown, phase: NotifyErrorPhase) => void;
  /**
   * TCP 连接建立（含重连），供指标与日志。
   *
   * **注意它不代表「已订阅」**：`NotifyConnection.listen` 的约定是「订阅 + 返回
   * 连接寿命」，而寿命 Promise 只有在断开时才结算，因此本回调只能在其之前触发。
   * 于是从本回调到 `LISTEN` 真正生效之间存在一个很小的窗口，窗口内的通知会丢失。
   *
   * 这对本模块是**可接受**的：通知只是延迟优化，周期扫描与启动重扫才是可靠性来源
   * （见文件头与 §8.4）。但不要把 `connected` 当作「可以开始依赖通知」的信号。
   */
  readonly onConnected?: () => void;
  /** 连接结束：正常结束传 `null`，异常断开传原始错误。 */
  readonly onDisconnected?: (error: unknown) => void;
  /** 定时器注入（测试用）。省略即用全局 `setTimeout`/`clearTimeout`。 */
  readonly setTimerFn?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimerFn?: (handle: TimerHandle) => void;
}

// ───────────────────────────── 监听器 ─────────────────────────────

/**
 * 把通知变成 `wakeNow()`，并在断线后持续重连。
 *
 * 生命周期与 `IndexScheduler` 一致：`start()` 幂等且同步返回，重复调用不会装
 * 第二条连接；`stop()` 幂等且等待关闭完成；停止后的实例不可重启（新建一个）。
 */
export class NotifyListener {
  readonly #deps: NotifyListenerDeps;
  readonly #channel: string;
  readonly #backoff: NotifyBackoff;
  readonly #setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;

  #connection: NotifyConnection | null = null;
  #connected = false;
  #started = false;
  #stopped = false;
  /** 连续失败次数，用于算退避；连接成功即归零。 */
  #attempt = 0;
  /** 等待重连的定时器及其唤醒器：`stop()` 要能叫醒它，否则停止会死等。 */
  #timer: TimerHandle | null = null;
  #wakeWait: (() => void) | null = null;
  /** 在途的连接循环。`stop()` 等它结束，避免留下悬挂的连接建立。 */
  #loop: Promise<void> | null = null;

  constructor(deps: NotifyListenerDeps) {
    const channel = deps.channel ?? NOTIFY_CHANNEL;
    if (channel.length === 0) {
      throw new Error('通知通道名不能为空：空通道既订阅不到也发不出');
    }
    const backoff: NotifyBackoff = {
      initialDelayMs: deps.backoff?.initialDelayMs ?? DEFAULT_NOTIFY_BACKOFF.initialDelayMs,
      maxDelayMs: deps.backoff?.maxDelayMs ?? DEFAULT_NOTIFY_BACKOFF.maxDelayMs,
    };
    if (!Number.isInteger(backoff.initialDelayMs) || backoff.initialDelayMs < 1) {
      throw new Error(`退避起点不合法：${String(backoff.initialDelayMs)}（需为 ≥1 的整数毫秒）`);
    }
    if (!Number.isInteger(backoff.maxDelayMs) || backoff.maxDelayMs < backoff.initialDelayMs) {
      throw new Error(
        `退避上限不合法：${String(backoff.maxDelayMs)}（需为 ≥ 起点的整数毫秒，` +
          `否则封顶比起点还小，退避序列无法收敛）`,
      );
    }

    this.#deps = deps;
    this.#channel = channel;
    this.#backoff = backoff;
    this.#setTimer = deps.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimerFn ?? ((handle) => { clearTimeout(handle); });
  }

  /** 当前是否有一条就绪的连接（含正在等待通知的稳定态）。 */
  get connected(): boolean {
    return this.#connected;
  }

  /**
   * 开始监听。**同步返回**：连接是后台建立的，因为 `apply` 的启动路径不能等
   * 一次网络连接。
   *
   * 幂等：重复调用不会建立第二条连接。数据库不可用时**不抛错**，只记录并持续
   * 重试——通知是延迟优化，插件加载不该被它拖垮。
   */
  start(): void {
    if (this.#stopped) {
      throw new Error('通知监听器已停止：停止后的实例不可重启，请新建一个');
    }
    if (this.#started) return;
    this.#started = true;
    this.#loop = this.#run();
  }

  /**
   * 停止：取消待重连的定时器、关闭连接、等连接循环退出。幂等。
   *
   * 顺序是刻意的：**先关连接再等循环**。循环正 `await` 在 `listen()` 上，
   * 而 `listen()` 的 Promise 只有在连接关闭后才会结算（端口契约），反过来等
   * 就是一个死锁。
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelWait();

    const connection = this.#connection;
    this.#connection = null;
    this.#connected = false;
    if (connection !== null) {
      await this.#closeQuietly(connection);
    }

    // 等循环收尾：覆盖「connect() 还在途中」的情形——那时循环会拿到连接后
    // 立刻关掉它，而不是把一条无人使用的连接漏在后台。
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
  }

  // ───────────────────────── 连接循环 ─────────────────────────

  /**
   * 连接-订阅-断开-重连的主循环。**不抛错**：任何失败都进 `onError` 并转为
   * 退避等待，否则一次抖动就会终结通知能力。
   */
  async #run(): Promise<void> {
    while (!this.#stopped) {
      let connection: NotifyConnection;
      try {
        connection = await this.#deps.connect();
      } catch (error) {
        this.#observe(() => { this.#deps.onError?.(error, 'connect'); });
        if (this.#stopped) return;
        await this.#waitBackoff();
        continue;
      }

      // 建立期间被停止：不要留下一条没人订阅的连接
      if (this.#stopped) {
        await this.#closeQuietly(connection);
        return;
      }

      this.#connection = connection;
      this.#connected = true;
      this.#attempt = 0;
      this.#observe(() => { this.#deps.onConnected?.(); });

      try {
        await connection.listen(this.#channel, this.#handlerFor(connection));
        // 正常结束：服务端主动关闭（维护、重启前排水）
        this.#observe(() => { this.#deps.onDisconnected?.(null); });
      } catch (error) {
        this.#observe(() => { this.#deps.onError?.(error, 'listen'); });
        this.#observe(() => { this.#deps.onDisconnected?.(error); });
      }

      this.#connected = false;
      if (this.#connection === connection) this.#connection = null;
      await this.#closeQuietly(connection);

      if (this.#stopped) return;
      await this.#waitBackoff();
    }
  }

  /**
   * 每条连接一个处理器，并绑定该连接的身份。
   *
   * 绑定身份是为了挡住**陈旧连接**：重连之后旧连接上的残余回调若还能触发，
   * 就会在一条已经废弃的连接上唤醒索引器，而「新连接其实没订阅成功」这件事
   * 反而被掩盖了。只认当前连接，其余一律丢弃。
   */
  #handlerFor(connection: NotifyConnection): (payload: string) => void {
    return (): void => {
      // 负载内容一概不看（§8.4：通知只带任务标识或水位，事实来源是队列）
      if (this.#connection !== connection || !this.#connected) return;
      try {
        this.#deps.target.wakeNow();
      } catch (error) {
        // 唤醒目标的事故不能波及连接循环：否则一次 tick 抛错就让通知永久失效
        this.#observe(() => { this.#deps.onError?.(error, 'notify'); });
      }
    };
  }

  // ───────────────────────── 退避等待 ─────────────────────────

  /**
   * 等一段退避时间（`backoffDelayMs` 的公式）。
   *
   * 定时器 `unref()`：退避期间不允许阻止宿主退出。`#wakeWait` 让 `stop()` 能把
   * 这次等待立刻结束——否则停止要等完当前退避（最长 30 秒）才返回。
   */
  #waitBackoff(): Promise<void> {
    this.#attempt += 1;
    const delay = backoffDelayMs(this.#attempt, this.#backoff);
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.#timer = null;
        this.#wakeWait = null;
        resolve();
      };
      this.#wakeWait = done;
      const handle = this.#setTimer(done, delay);
      unrefTimer(handle);
      this.#timer = handle;
    });
  }

  /** 取消待重连的定时器并叫醒等待者（`stop()` 专用）。 */
  #cancelWait(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const wake = this.#wakeWait;
    this.#wakeWait = null;
    wake?.();
  }

  // ───────────────────────── 观测与清理 ─────────────────────────

  /**
   * 关闭连接。关闭失败只记录不抛：停止路径不该因为一条已经坏掉的连接而失败，
   * 而重连路径本来就要丢弃它。
   */
  async #closeQuietly(connection: NotifyConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      this.#observe(() => { this.#deps.onError?.(error, 'close'); });
    }
  }

  /**
   * 调用观测回调。回调自己抛错不能反过来杀掉监听循环——那会让通知静默失效，
   * 只剩周期扫描兜底，而且没人知道通知面已经死了。
   */
  #observe(action: () => void): void {
    try {
      action();
    } catch {
      /* 观测回调的事故不是监听器的事故 */
    }
  }
}

/**
 * 定时器 `unref`：可选调用，因为浏览器定时器是数字（Node 的 `Timeout` 才有
 * 这个方法）。用运行时窄化而不是类型断言——断言会把「假定时器没有 unref」
 * 这种真事故变成 `TypeError`。
 */
function unrefTimer(handle: TimerHandle): void {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    const { unref } = handle;
    if (typeof unref === 'function') unref.call(handle);
  }
}

// ───────────────────────────── PostgreSQL 适配器 ─────────────────────────────

/** PostgreSQL 通道名上限：标识符被截断到 NAMEDATALEN-1 字节，两侧写法必须一致。 */
const MAX_CHANNEL_BYTES = 63;

/**
 * 把通道名当成标识符引用：`pentest_outbox` → `"pentest_outbox"`。
 *
 * 必须加引号：`LISTEN pentest_outbox` 里的通道名是**标识符**（折叠为小写），
 * 而 `pg_notify('pentest_outbox', …)` 里是**字符串**（区分大小写）。加引号让
 * 订阅侧的标识符与发布侧的字符串逐字相同，任何大小写组合都不会出现
 * 「订阅成功但永远收不到」这种无错失败的通道。
 */
function quoteChannel(channel: string): string {
  if (channel.length === 0) {
    throw new Error('通知通道名不能为空');
  }
  if (Buffer.byteLength(channel, 'utf8') > MAX_CHANNEL_BYTES) {
    throw new Error(
      `通知通道名超过 ${String(MAX_CHANNEL_BYTES)} 字节：PostgreSQL 会截断标识符，` +
        `截断后的名字与发布侧的字符串不再相等（会静默收不到通知）`,
    );
  }
  if (channel.includes('\u0000')) {
    throw new Error('通知通道名不能包含 NUL 字节');
  }
  return `"${channel.replaceAll('"', '""')}"`;
}

/**
 * 用 `pg` 建立一条**独立**的 `LISTEN` 连接。每次调用都新建一条——断开后的连接
 * 不可复用，重连必须重新握手并重新 `LISTEN`。
 *
 * ── 为什么必须独立连接（而不是借连接池，也不是用账本的写连接）──
 *
 * 1. **`LISTEN` 是会话状态**。订阅登记在某个后端会话上，通知也只投递给登记过该
 *    通道的会话。连接池的连接用完归还、可能被复用去跑别的查询、也可能被回收
 *    销毁——订阅会跟着连接漂移或消失，而调用方毫不知情。
 * 2. **通知回调挂在连接对象上**。共用账本那条独占写连接（`compose.ts` 的
 *    `txDb`）意味着 `client.on('notification')` 与账本事务抢同一个事件源；
 *    连接级 `error` 还会同时打断审计写入路径（§9.5：审计不可用时高风险动作不
 *    执行），把两件本来无关的事故绑成一件。
 * 3. **连接级错误必须有人监听**。`pg` 的 `Client` 在 socket 出错时发出 `error`
 *    事件，没有监听器就是进程级未捕获异常。给共享连接挂监听器等于替所有使用者
 *    接管错误处理，那是装配层的职责，不该由一个可选的通知功能代劳。
 * 4. **`LISTEN` 与事务的关系**：订阅侧是会话级、**非事务性**的效果——放在事务
 *    块里要等提交后才生效，回滚会把订阅一并撤销；所以这条连接不放进任何事务块。
 *    发布侧 `pg_notify()`（或 `NOTIFY`）是**事务性**的——同一事务里发多条**完全
 *    相同**的通知会被折叠成一条，且全部在提交时才投递，回滚则一条都不发。因此
 *    入队侧应当在写 `outbox_jobs` 的**同一事务内**调用 `pg_notify`，让「任务
 *    入队」与「唤醒通知」要么一起生效、要么一起不生效（§5.4 第 8 步）。
 * 5. **空闲连接会被掐断**：长连接可能被防火墙/NAT 静默丢弃，而 PostgreSQL 与
 *    Node 默认都不发 TCP keepalive。`keepAlive: true` 让空闲探测把死连接变成
 *    可观测的断开，交给监听器重连；否则连接看起来还活着、通知却永远不来
 *    （那时只剩周期扫描兜底：功能不丢，只是慢一个间隔）。
 */
export async function createPgNotifyConnection(
  connectionString: string,
): Promise<NotifyConnection> {
  const client = new Client({ connectionString, keepAlive: true });

  /**
   * 当前监听尝试的失败入口。连接级错误必须先有人接住：`pg` 的 `Client` 在没有
   * `error` 监听器时会把事件抛成未捕获异常。因此它在 `connect()` **之前**就挂上
   * 去，由 `listen()` 把自己的结算入口接过来；中间窗口里 `endOnFatal` 为空即丢弃
   * （那时 `LISTEN` 查询本身也会以「连接意外终止」被拒绝，故障不会被吞掉）。
   */
  let endOnFatal: ((error: Error) => void) | null = null;
  client.on('error', (error: Error) => { endOnFatal?.(error); });

  await client.connect();

  return {
    async listen(channel, handler) {
      const identifier = quoteChannel(channel);
      const onNotification = (message: Notification): void => {
        // 只订阅了一个通道；比较仍做，防止适配器被复用到多通道
        if (message.channel !== channel) return;
        handler(message.payload ?? '');
      };
      client.on('notification', onNotification);

      try {
        // 简单查询协议：`LISTEN` 不是参数化语句，必须整句下发
        await client.query(`listen ${identifier}`);
      } catch (error) {
        client.removeListener('notification', onNotification);
        throw error;
      }

      // 订阅成功之后，本 Promise 转为「连接寿命」：断开才结算。
      // executor 同步跑完，因此不存在「订阅已成功但还没挂上寿命监听」的空窗。
      // 连接级 `error` 一律走常驻监听器（它必须先于订阅存在：pg 在没有监听器时
      // 会把 `error` 抛成未捕获异常），这里只把结算入口挂到 `endOnFatal` 上。
      try {
        await new Promise<void>((resolve, reject) => {
          const onEnd = (): void => {
            endOnFatal = null;
            resolve();
          };
          endOnFatal = (error: Error): void => {
            client.removeListener('end', onEnd);
            reject(error);
          };
          client.once('end', onEnd);
        });
      } finally {
        endOnFatal = null;
        client.removeListener('notification', onNotification);
      }
    },
    async close() {
      // `end()` 幂等：已结束的连接上再次调用立即返回
      await client.end();
    },
  };
}
