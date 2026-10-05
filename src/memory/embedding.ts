/**
 * 嵌入提供方抽象、维度契约与嵌入版本登记
 * —— 设计文档 §12.2「嵌入服务支持本地与远端两种部署」、§9.1「版本三元分离（嵌入版本）」、
 * §8.5「分块与嵌入」、§8.4「Streaming RAG 管线（索引水位与幂等重跑）」。
 *
 * 本模块只负责「把文本变成向量」这一步，不做分块、不写 `memory_chunks`、不排序检索。
 * 三条不可让步的纪律：
 *
 * 1. **凭据由调用方注入**。本地与远端提供方都不读环境变量、不读 KMS：§12.2 的
 *    `endpoint_ref` / `api_key_ref` 由装配层解析后作为普通参数传入。本模块也绝不把
 *    api-key 写进日志、错误消息或数据库。
 * 2. **维度是硬约束，提前失败优于 INSERT 失败**。`memory_chunks.embedding` 是
 *    `vector(1024)`（001_init.sql，§9.2），维度不符的向量塞进去会被数据库拒绝比较或写入。
 *    {@link assertDimensions} 在登记与写入之前就拒绝，并给出「新建嵌入版本 + 重建索引」
 *    的可操作指引——§9.1 明确要求**不原地解释旧向量**（截断/补零改维度是数据损坏）。
 * 3. **失败必须响亮**。提供方不可用时**抛错**，绝不返回零向量、绝不静默降级为「跳过嵌入」。
 *    零向量与真实向量之间的余弦距离没有意义，混进 `memory_chunks` 会污染整个召回面，
 *    而且看起来「检索有结果」，这种缺陷极难发现；索引失败的正确后果是 engagement 标记
 *    为索引滞后（§8.4），由水位与重试承担，而不是伪造向量。
 *
 * 关于「本地/远端两条部署路径共用同一份索引数据」：两条路径写的是同一张
 * `memory_chunks`，靠 `embedding_revision` 区分。切换提供方或模型时**新建嵌入版本并重建索引**
 * （§12.2），检索侧强制按当前生效版本过滤（`MemoryRetrieval` 的
 * `activeEmbeddingRevisionOnly`），因此旧版本向量永远不会被新模型「解释」。若远端模型维度
 * 与本地不同（如 1024 vs 1536），那不是配置问题而是 schema 问题：本模块拒绝登记，必须由
 * 迁移引入与维度匹配的新向量列并新建嵌入版本，**不允许在同一列里混放不同维度的向量**。
 */
import type { DbClient } from '../db/port.ts';
import { engagementLockKey, transactionRunnerFor, type DbTransactionRunner } from './ledger.ts';

// ───────────────────────────── 维度契约 ─────────────────────────────

/**
 * `memory_chunks.embedding` 的列维度（001_init.sql `vector(1024)`，§9.2）。
 * 该常量与 DDL 同步：改动它必须同时改迁移并新建嵌入版本，不能只改这里。
 */
export const MEMORY_EMBEDDING_DIMENSIONS = 1024;

/** 单次嵌入请求的默认批量上限：控制请求体大小，避免一次提交过大被提供方限流。 */
export const DEFAULT_EMBED_BATCH_SIZE = 64;

/** 远端嵌入服务的默认调用超时。 */
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

// ───────────────────────────── 错误类型 ─────────────────────────────

/**
 * 嵌入链路错误码。与 `contracts.ts` 的 `ErrorCode` 分开：那些码面向工具调用方，
 * 这里的码面向索引器与装配层，且都不会被渲染成模型可见的成功消息。
 */
type EmbeddingErrorCode =
  | 'invalid_config'
  | 'dimension_mismatch'
  | 'invalid_response'
  | 'provider_unavailable'
  | 'revision_conflict'
  | 'revision_unknown';

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly detail: string;

  constructor(code: EmbeddingErrorCode, message: string, detail = '') {
    super(detail === '' ? message : `${message}；${detail}`);
    this.name = 'EmbeddingError';
    this.code = code;
    this.detail = detail;
  }
}

// ───────────────────────────── 提供方面 ─────────────────────────────

export interface EmbeddingProvider {
  readonly model: string;
  /** 必须与 `memory_chunks.embedding` 的 `vector(1024)` 一致才可用于本插件（§9.1）。 */
  readonly dimensions: number;
  /** 嵌入版本标识，原样写入 `memory_chunks.embedding_revision` 与 `embedding_revisions.revision`。 */
  readonly revision: string;
  /**
   * 批量嵌入。返回顺序与入参一一对应；任何一批失败即整体抛错（不返回部分结果）。
   * `signal` 原样传给底层推理/HTTP 调用，调用方取消时必须原样抛出取消原因。
   */
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}

/** 版本三元（revision 标识 + model + dimensions）：登记、校验与冲突判定只需要这三项。 */
export type EmbeddingDescriptor = Pick<EmbeddingProvider, 'model' | 'dimensions' | 'revision'>;

/** 单批推理入口：一批文本 → 等长向量数组（本地运行时或远端 HTTP 客户端）。 */
export type EmbedBatchInfer = (
  batch: readonly string[],
  signal: AbortSignal | undefined,
) => Promise<readonly (readonly number[])[]>;

// ───────────────────────────── 维度校验 ─────────────────────────────

/**
 * 维度硬约束校验（§9.1、§9.2）。不一致时**拒绝**，并说明为什么不能就地改维度：
 * 换模型必须新建嵌入版本并按新版本重建索引，旧向量不得原地被新维度解释。
 *
 * @param provider 提供方（或仅其版本三元）
 * @param expected 期望维度，默认取 `memory_chunks.embedding` 的 `vector(1024)`
 */
export function assertDimensions(
  provider: EmbeddingDescriptor,
  expected: number = MEMORY_EMBEDDING_DIMENSIONS,
): void {
  if (!Number.isInteger(expected) || expected <= 0) {
    throw new EmbeddingError(
      'invalid_config',
      `期望维度非法：${String(expected)}`,
      'memory_chunks.embedding 是固定维度列，期望值必须是正整数',
    );
  }
  if (provider.dimensions === expected) return;
  throw new EmbeddingError(
    'dimension_mismatch',
    `嵌入提供方维度与 memory_chunks.embedding 列不一致：` +
      `model=${provider.model} revision=${provider.revision} 返回 ${String(provider.dimensions)} 维，` +
      `而列固定为 vector(${String(expected)})`,
    `不得把旧向量截断或补零后塞进新维度（§9.1「不原地解释旧向量」）：` +
      `请为该模型新建嵌入版本（embedding_revisions）并重建索引；` +
      `若索引列维度不变，请改用维度为 ${String(expected)} 的提供方。` +
      `不同维度的向量不允许写进同一列混用`,
  );
}

// ───────────────────────────── 通用校验与批处理内核 ─────────────────────────────

function normalizeDescriptor(input: EmbeddingDescriptor, label: string): EmbeddingDescriptor {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const revision = typeof input.revision === 'string' ? input.revision.trim() : '';
  if (model === '') {
    throw new EmbeddingError('invalid_config', `${label} 缺少 model`, '嵌入版本三元 (revision, model, dimensions) 不允许空 model');
  }
  if (revision === '') {
    throw new EmbeddingError(
      'invalid_config',
      `${label} 缺少 revision`,
      'revision 是 embedding_revisions 的主键之一，也是分块 embedding_revision 的取值来源',
    );
  }
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new EmbeddingError(
      'invalid_config',
      `${label} dimensions 非法：${String(input.dimensions)}`,
      '必须是正整数，且与 memory_chunks.embedding 的 vector(1024) 一致',
    );
  }
  return { model, revision, dimensions: input.dimensions };
}

function normalizeBatchSize(batchSize: number | undefined, label: string): number {
  if (batchSize === undefined) return DEFAULT_EMBED_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new EmbeddingError(
      'invalid_config',
      `${label} batchSize 非法：${String(batchSize)}`,
      '必须是正整数（每批提交给提供方的文本条数）',
    );
  }
  return batchSize;
}

function describeProvider(descriptor: EmbeddingDescriptor): string {
  return `model=${descriptor.model} revision=${descriptor.revision} dimensions=${String(descriptor.dimensions)}`;
}

interface BatchKernel {
  readonly descriptor: EmbeddingDescriptor;
  readonly batchSize: number;
  readonly providerLabel: string;
  readonly callBatch: EmbedBatchInfer;
}

function assertVectorShape(kernel: BatchKernel, expectedCount: number, vectors: readonly (readonly number[])[]): void {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    const actual = Array.isArray(vectors) ? String(vectors.length) : typeof vectors;
    throw new EmbeddingError(
      'invalid_response',
      `嵌入提供方返回的向量数量与请求不一致（${kernel.providerLabel} · ${describeProvider(kernel.descriptor)}）`,
      `请求 ${String(expectedCount)} 条，返回 ${actual} 条；` +
        `拒绝部分结果——按位置拼接会让分块与向量错位，且错位后无法检测`,
    );
  }
  for (let position = 0; position < vectors.length; position += 1) {
    const vector = vectors[position];
    if (!Array.isArray(vector)) {
      throw new EmbeddingError(
        'invalid_response',
        `嵌入提供方第 ${String(position)} 条结果不是数值数组（${kernel.providerLabel}）`,
        describeProvider(kernel.descriptor),
      );
    }
    if (vector.length !== kernel.descriptor.dimensions) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `嵌入向量维度不符：${describeProvider(kernel.descriptor)} 声明 ${String(kernel.descriptor.dimensions)} 维，` +
          `第 ${String(position)} 条返回 ${String(vector.length)} 维`,
        `维度必须与 memory_chunks.embedding 的 vector(${String(MEMORY_EMBEDDING_DIMENSIONS)}) 一致；` +
          `更换模型请新建嵌入版本并重建索引（§9.1「不原地解释旧向量」）`,
      );
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingError(
          'invalid_response',
          `嵌入向量含非有限数值（${kernel.providerLabel} · 第 ${String(position)} 条）`,
          'NaN/Infinity 会让余弦距离失去意义，按不可用处理而不是写入数据库',
        );
      }
    }
  }
}

/**
 * 分批提交内核：所有提供方共用。
 *
 * - 顺序：输出与输入一一对应，批间顺序固定，不重排（§8.4 幂等重跑要求同一输入得到同一分块）。
 * - 取消：进入每一批之前复检 `signal`；底层抛出的取消原因**原样**上抛，不包装成提供方不可用。
 * - 失败：任一批失败即整体失败。**不做零向量/空向量兜底**（见文件头第 3 条）。
 * - 空输入：直接返回空数组，不发起任何请求。
 */
async function embedInBatches(
  kernel: BatchKernel,
  texts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly (readonly number[])[]> {
  if (!Array.isArray(texts)) {
    throw new EmbeddingError('invalid_config', 'embed 的 texts 必须是字符串数组', typeof texts);
  }
  for (const text of texts) {
    if (typeof text !== 'string') {
      throw new EmbeddingError(
        'invalid_config',
        'embed 的 texts 含非字符串元素',
        `实际类型 ${typeof text}；文本在进入提供方之前必须先完成规范化`,
      );
    }
  }
  const vectors: (readonly number[])[] = [];
  if (texts.length === 0) return vectors;

  for (let start = 0; start < texts.length; start += kernel.batchSize) {
    signal?.throwIfAborted();
    const batch = texts.slice(start, start + kernel.batchSize);
    let batchVectors: readonly (readonly number[])[];
    try {
      batchVectors = await kernel.callBatch(batch, signal);
    } catch (error) {
      // 调用方主动取消：原样抛出取消原因，让上层区分「用户取消」与「提供方故障」。
      if (signal?.aborted === true) throw error;
      // 已分类的嵌入错误（维度不符、响应形状非法）原样上抛，避免被抹成笼统的「不可用」。
      if (error instanceof EmbeddingError) throw error;
      throw unavailableFromError(kernel, error);
    }
    assertVectorShape(kernel, batch.length, batchVectors);
    for (const vector of batchVectors) vectors.push(vector);
  }
  return vectors;
}

function unavailableFromError(kernel: BatchKernel, error: unknown): EmbeddingError {
  const reason = error instanceof Error ? error.message : String(error);
  // `AbortSignal.timeout` 的取消原因是 DOMException 'TimeoutError'（不是 'AbortError'）；
  // 调用方主动取消在上面已经被放行，走到这里的取消只剩超时与内部中止。
  const timedOut =
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return new EmbeddingError(
    'provider_unavailable',
    `嵌入提供方不可用：${kernel.providerLabel}（${describeProvider(kernel.descriptor)}）`,
    timedOut ? `调用超时：${reason}` : reason,
  );
}

// ───────────────────────────── 本地提供方 ─────────────────────────────

interface LocalEmbeddingOptions {
  readonly model: string;
  readonly dimensions: number;
  readonly revision: string;
  /**
   * 本地/内网推理入口。由部署方绑定到本机运行时（进程内模型、本机 HTTP 服务等）；
   * 本模块不读环境变量、不自行发起网络请求。§12.2「本地」是自有靶场场景的默认选择，
   * 渗透发现不出域。
   */
  readonly infer: EmbedBatchInfer;
  /** 每批文本条数，默认 {@link DEFAULT_EMBED_BATCH_SIZE}。 */
  readonly batchSize?: number;
}

/** 本机/内网嵌入提供方（§12.2 默认部署路径）。 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly revision: string;
  readonly batchSize: number;
  readonly #infer: EmbedBatchInfer;

  constructor(options: LocalEmbeddingOptions) {
    const descriptor = normalizeDescriptor(options, 'LocalEmbeddingProvider');
    this.model = descriptor.model;
    this.dimensions = descriptor.dimensions;
    this.revision = descriptor.revision;
    this.batchSize = normalizeBatchSize(options.batchSize, 'LocalEmbeddingProvider');
    if (typeof options.infer !== 'function') {
      throw new EmbeddingError(
        'invalid_config',
        'LocalEmbeddingProvider 缺少 infer 推理入口',
        '本地模型必须由部署方注入推理函数，本模块不猜测运行时也不读环境变量',
      );
    }
    this.#infer = options.infer;
  }

  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    return embedInBatches(
      {
        descriptor: { model: this.model, revision: this.revision, dimensions: this.dimensions },
        batchSize: this.batchSize,
        providerLabel: 'local',
        callBatch: this.#infer,
      },
      texts,
      signal,
    );
  }
}

// ───────────────────────────── 远端提供方 ─────────────────────────────

/** 远端响应端口（只保留本模块需要的字段，便于注入假实现）。 */
export interface EmbeddingHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  text(): Promise<string>;
}

/** 远端请求端口。默认 `globalThis.fetch`；测试与代理场景可注入。 */
export type EmbeddingFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal | undefined;
  },
) => Promise<EmbeddingHttpResponse>;

interface RemoteEmbeddingOptions {
  /** 已由调用方从 `endpoint_ref` 解析出的端点。 */
  readonly endpoint: string;
  /** 已由调用方从 `api_key_ref` 解析出的凭据；本模块不回显、不落库、不写日志。 */
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly revision: string;
  readonly batchSize?: number;
  /** 单次请求超时，默认 {@link DEFAULT_EMBED_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /** 附加请求头（如租户标识）。`authorization` 由本模块设置。 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: EmbeddingFetch;
}

/**
 * 托管嵌入服务提供方（§12.2「远端」）。
 *
 * 请求体为 OpenAI 兼容形状 `{ model, input, encoding_format: 'float' }`，
 * 响应按 `data[].index` 还原顺序（**不假设服务端按输入顺序返回**，否则会静默错位）。
 * 选择这条路径意味着漏洞细节、内网主机名等会发往服务方，仅在确认可接受时使用（§12.2）。
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly revision: string;
  readonly batchSize: number;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: EmbeddingFetch;

  constructor(options: RemoteEmbeddingOptions) {
    const descriptor = normalizeDescriptor(options, 'RemoteEmbeddingProvider');
    this.model = descriptor.model;
    this.dimensions = descriptor.dimensions;
    this.revision = descriptor.revision;
    this.batchSize = normalizeBatchSize(options.batchSize, 'RemoteEmbeddingProvider');
    if (typeof options.endpoint !== 'string' || !isHttpUrl(options.endpoint)) {
      throw new EmbeddingError(
        'invalid_config',
        `RemoteEmbeddingProvider endpoint 非法：${String(options.endpoint)}`,
        '必须是 http(s) URL；配置里写的是 endpoint_ref，由调用方解析后传入',
      );
    }
    this.endpoint = options.endpoint;
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new EmbeddingError(
        'invalid_config',
        'RemoteEmbeddingProvider 缺少 apiKey',
        '凭据由调用方从密钥管理服务注入，本模块不读环境变量',
      );
    }
    this.#apiKey = options.apiKey;
    if (options.timeoutMs === undefined) {
      this.timeoutMs = DEFAULT_EMBED_TIMEOUT_MS;
    } else if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new EmbeddingError(
        'invalid_config',
        `RemoteEmbeddingProvider timeoutMs 非法：${String(options.timeoutMs)}`,
        '必须是正整数毫秒数；不设超时会让索引任务永远占着租约',
      );
    } else {
      this.timeoutMs = options.timeoutMs;
    }
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    return embedInBatches(
      {
        descriptor: { model: this.model, revision: this.revision, dimensions: this.dimensions },
        batchSize: this.batchSize,
        providerLabel: 'remote',
        callBatch: (batch, batchSignal) => this.#callRemote(batch, batchSignal),
      },
      texts,
      signal,
    );
  }

  async #callRemote(
    batch: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<readonly (readonly number[])[]> {
    // 调用方取消与超时都通过信号表达；AbortSignal.any 保留最先触发的原因。
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any(signal === undefined ? [timeout] : [signal, timeout]);
    const response = await this.#fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.#apiKey}`,
        ...this.#headers,
      },
      body: JSON.stringify({
        model: this.model,
        input: [...batch],
        encoding_format: 'float',
      }),
      signal: combined,
    });
    const body = await response.text();
    const snippet =
      body.length <= RESPONSE_SNIPPET_LENGTH ? body : `${body.slice(0, RESPONSE_SNIPPET_LENGTH)}…`;
    if (!response.ok) {
      throw new EmbeddingError(
        'provider_unavailable',
        `远端嵌入服务返回 ${String(response.status)}${
          response.statusText === undefined ? '' : ` ${response.statusText}`
        }`,
        `响应片段：${snippet}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new EmbeddingError(
        'invalid_response',
        '远端嵌入服务响应不是合法 JSON',
        `响应片段：${snippet}`,
      );
    }
    return readRemoteVectors(parsed, batch.length, this.dimensions, this.model);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const RESPONSE_SNIPPET_LENGTH = 200;

/**
 * 解析 OpenAI 兼容响应 `{ data: [{ embedding, index }] }`。
 * 数量、index 覆盖范围与向量维度三项全部校验：少一条、重一条、越界一条都抛错，
 * 不按数组顺序兜底——错位的向量比缺失的向量更难发现。
 * 响应来自外部，逐字段做运行时收窄，不做无根据的类型断言。
 */
function readRemoteVectors(
  body: unknown,
  expectedCount: number,
  dimensions: number,
  model: string,
): readonly (readonly number[])[] {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new EmbeddingError(
      'invalid_response',
      `远端嵌入服务响应缺少 data 数组（model=${model}）`,
      '期望 OpenAI 兼容形状 { data: [{ embedding: number[], index: number }] }',
    );
  }
  const data = body.data;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(
      'invalid_response',
      `远端嵌入服务响应的 data 不是数组（model=${model}）`,
      '期望 OpenAI 兼容形状 { data: [{ embedding: number[], index: number }] }',
    );
  }
  if (data.length !== expectedCount) {
    throw new EmbeddingError(
      'invalid_response',
      `远端嵌入服务返回条目数不符（model=${model}）`,
      `请求 ${String(expectedCount)} 条，返回 ${String(data.length)} 条；拒绝部分结果`,
    );
  }
  const slots: (number[])[] = new Array<number[]>(expectedCount);
  const filled: boolean[] = new Array<boolean>(expectedCount).fill(false);
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null || !('index' in entry) || !('embedding' in entry)) {
      throw new EmbeddingError(
        'invalid_response',
        `远端嵌入服务返回的条目缺少 index/embedding（model=${model}）`,
        '期望 OpenAI 兼容形状 { data: [{ embedding: number[], index: number }] }',
      );
    }
    const index = entry.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new EmbeddingError(
        'invalid_response',
        `远端嵌入服务返回的 index 非法：${String(index)}（model=${model}）`,
        `index 必须覆盖 0..${String(expectedCount - 1)} 且不重复，否则无法与输入对应`,
      );
    }
    if (filled[index] === true) {
      throw new EmbeddingError(
        'invalid_response',
        `远端嵌入服务返回重复 index ${String(index)}（model=${model}）`,
        '重复 index 意味着有输入没有对应向量，拒绝写入以免错位',
      );
    }
    const embedding = entry.embedding;
    if (!Array.isArray(embedding)) {
      throw new EmbeddingError(
        'invalid_response',
        `远端嵌入服务 index ${String(index)} 缺少 embedding 数组（model=${model}）`,
        '期望 { data: [{ embedding: number[], index: number }] }',
      );
    }
    if (embedding.length !== dimensions) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `远端嵌入服务返回 ${String(embedding.length)} 维向量，配置声明 ${String(dimensions)} 维（model=${model}）`,
        `维度必须与 memory_chunks.embedding 的 vector(${String(MEMORY_EMBEDDING_DIMENSIONS)}) 一致；` +
          '不一致请新建嵌入版本并重建索引（§9.1）',
      );
    }
    const vector: number[] = [];
    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingError(
          'invalid_response',
          `远端嵌入服务 index ${String(index)} 含非有限数值（model=${model}）`,
          'NaN/Infinity 不可写入向量列',
        );
      }
      vector.push(value);
    }
    slots[index] = vector;
    filled[index] = true;
  }
  return slots;
}

// ───────────────────────────── 嵌入版本登记 ─────────────────────────────

/** `embedding_revisions` 行在本模块内的投影。 */
interface EmbeddingRevisionRecord {
  readonly engagementId: string;
  readonly revision: string;
  readonly model: string;
  readonly dimensions: number;
  readonly isActive: boolean;
}

interface EmbeddingRevisionRegistryOptions {
  /** 读路径客户端（`active` 不走事务）。 */
  readonly db: DbClient;
  /**
   * 写路径客户端。`begin`/`commit`/`rollback` 与 advisory lock 必须在**同一条连接**上，
   * `pg` 部署时传 `pool.connect()` 的结果或单连接客户端；默认回落到 `db`
   * （与 `MemoryLedger` / `PgWorkerTools` 的 `txDb` 同约定）。
   */
  readonly txDb?: DbClient;
}

interface RevisionRow {
  readonly revision: string;
  readonly model: string;
  readonly dimensions: number;
  readonly is_active: boolean;
}

const SQL_LOCK_ENGAGEMENT = 'select pg_advisory_xact_lock($1)';
const SQL_SELECT_REVISION = `select revision, model, dimensions, is_active
   from pentest.embedding_revisions
  where engagement_id = $1::uuid and revision = $2`;
const SQL_SELECT_ACTIVE = `select revision, model, dimensions, is_active
   from pentest.embedding_revisions
  where engagement_id = $1::uuid and is_active`;
const SQL_INSERT_REVISION = `insert into pentest.embedding_revisions
    (engagement_id, revision, model, dimensions, is_active)
  values ($1::uuid, $2, $3, $4, $5)`;
// 先让位再激活：embedding_revisions_one_active 是部分唯一索引（每个 engagement 至多一个生效版本），
// 直接插入/置位新版本会撞索引。两条语句在同一事务内执行，中间的空窗对并发读不可见。
const SQL_CLEAR_ACTIVE = `update pentest.embedding_revisions
     set is_active = false
   where engagement_id = $1::uuid and is_active and revision <> $2`;
const SQL_SET_ACTIVE = `update pentest.embedding_revisions
     set is_active = true
   where engagement_id = $1::uuid and revision = $2`;

/**
 * 嵌入版本登记（§9.1、§12.2、§8.4）。
 *
 * 规则：
 * - `ensureRevision` 幂等：同一 (engagement, revision) 重复登记不新增行，但必须校验
 *   model/dimensions 与既有行一致——同一 revision 对应两个模型意味着分块与向量无法对账。
 * - **首个版本自动生效**：engagement 还没有任何生效版本时，登记即生效（否则首次索引会
 *   因为读不到生效版本而整批失败）；之后切换版本必须显式 `activate`。
 * - `activate` 在单个事务内「先取消旧的、再激活新的」，因此不会撞
 *   `embedding_revisions_one_active` 部分唯一索引。
 * - 全部写操作在 engagement 级 advisory lock 下串行（同一把键，与 `MemoryLedger` 一致，
 *   §15.4），避免两个进程同时给同一 engagement 登记两个生效版本。
 */
export class EmbeddingRevisionRegistry {
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #txRunner: DbTransactionRunner;

  constructor(options: EmbeddingRevisionRegistryOptions) {
    this.#db = options.db;
    this.#txDb = options.txDb ?? options.db;
    this.#txRunner = transactionRunnerFor(this.#txDb);
  }
  /**
   * 登记嵌入版本（幂等）。维度不符的提供方在写库之前就被 {@link assertDimensions} 拒绝。
   */
  async ensureRevision(
    engagementId: string,
    provider: EmbeddingDescriptor,
  ): Promise<EmbeddingRevisionRecord> {
    assertEngagementId(engagementId);
    assertDimensions(provider, MEMORY_EMBEDDING_DIMENSIONS);
    return this.#withTransaction(async () => {
      await this.#lockEngagement(engagementId);
      const existing = await this.#txDb.query<RevisionRow>(SQL_SELECT_REVISION, [
        engagementId,
        provider.revision,
      ]);
      const row = existing.rows[0];
      if (row !== undefined) {
        assertSameTriple(provider, row, engagementId);
        return toRecord(engagementId, row);
      }
      const active = await this.#txDb.query<RevisionRow>(SQL_SELECT_ACTIVE, [engagementId]);
      const isActive = active.rows.length === 0;
      await this.#txDb.query(SQL_INSERT_REVISION, [
        engagementId,
        provider.revision,
        provider.model,
        provider.dimensions,
        isActive,
      ]);
      return {
        engagementId,
        revision: provider.revision,
        model: provider.model,
        dimensions: provider.dimensions,
        isActive,
      };
    });
  }

  /** 切换生效版本。`revision` 必须已登记；同一事务内先让位再激活。 */
  async activate(engagementId: string, revision: string): Promise<void> {
    assertEngagementId(engagementId);
    if (typeof revision !== 'string' || revision.trim() === '') {
      throw new EmbeddingError('invalid_config', `activate 的 revision 非法：${String(revision)}`);
    }
    await this.#withTransaction(async () => {
      await this.#lockEngagement(engagementId);
      const target = await this.#txDb.query<RevisionRow>(SQL_SELECT_REVISION, [engagementId, revision]);
      if (target.rows[0] === undefined) {
        throw new EmbeddingError(
          'revision_unknown',
          `嵌入版本不存在：engagement=${engagementId} revision=${revision}`,
          '先 ensureRevision 登记该版本，再切换生效版本；静默忽略会让检索面空转',
        );
      }
      await this.#txDb.query(SQL_CLEAR_ACTIVE, [engagementId, revision]);
      await this.#txDb.query(SQL_SET_ACTIVE, [engagementId, revision]);
    });
  }

  /** 当前生效版本；未登记任何版本时返回 `null`（检索侧此时返回空是正确行为）。 */
  async active(engagementId: string): Promise<EmbeddingRevisionRecord | null> {
    assertEngagementId(engagementId);
    const result = await this.#db.query<RevisionRow>(SQL_SELECT_ACTIVE, [engagementId]);
    const row = result.rows[0];
    return row === undefined ? null : toRecord(engagementId, row);
  }

  async #lockEngagement(engagementId: string): Promise<void> {
    await this.#txDb.query(SQL_LOCK_ENGAGEMENT, [engagementLockKey(engagementId).toString()]);
  }

  /** 事务边界：提交/回滚只包住锁与写入，共享写连接上的服务复用同一调度器。 */
  async #withTransaction<T>(run: () => Promise<T>): Promise<T> {
    return this.#txRunner.run(async () => run());
  }
}

function assertEngagementId(engagementId: string): void {
  if (typeof engagementId !== 'string' || engagementId.trim() === '') {
    throw new EmbeddingError('invalid_config', `engagementId 非法：${String(engagementId)}`);
  }
}

function assertSameTriple(
  provider: EmbeddingDescriptor,
  row: RevisionRow,
  engagementId: string,
): void {
  if (row.model === provider.model && row.dimensions === provider.dimensions) return;
  throw new EmbeddingError(
    'revision_conflict',
    `嵌入版本 ${provider.revision} 已登记且三元组不一致（engagement=${engagementId}）`,
    `已登记 model=${row.model} dimensions=${String(row.dimensions)}，` +
      `本次 model=${provider.model} dimensions=${String(provider.dimensions)}；` +
      '同一 revision 必须始终对应同一模型与维度，换模型请使用新的 revision 并重建索引（§9.1）',
  );
}

function toRecord(engagementId: string, row: RevisionRow): EmbeddingRevisionRecord {
  return {
    engagementId,
    revision: row.revision,
    model: row.model,
    dimensions: row.dimensions,
    isActive: row.is_active,
  };
}
