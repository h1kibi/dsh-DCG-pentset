/**
 * 事件哈希与批次签名 —— 设计文档 §9.5「追加写与完整性」。
 *
 * 三条硬约束（§9.5 原文）：
 *
 * 1. **完整性用密钥签名，不用裸哈希链**。无密钥哈希链对「能写账本的角色」不提供任何保护：
 *    任何持有运行时写权限的一方都能自行计算前序哈希、续写一条完全自洽的伪造链，
 *    也能删除尾部区间而本地检测不到断裂——因为链长本身只存在于被删的行里。
 * 2. **运行时数据库角色不持有该密钥**，因此无法伪造可验证的追加。密钥由调用方从
 *    KMS/环境变量注入本模块；本模块绝不从数据库读取密钥，也不把密钥写进任何记录。
 * 3. **哈希覆盖字段集冻结**为契约的 `EventHashPayload`，任一字段改动都必须可检出；
 *    `classification` 与 `trustLevel` 必须在哈希内，否则把「外部不可信」改标为
 *    「人工决策」既不改哈希也污染信任语义。本模块对缺字段与未覆盖字段**一律响亮拒绝**，
 *    决不做「取已知字段、忽略其余」的宽松解析。
 *
 * 规范序列化（canonical serialization）定义——哈希可重现的前提：
 *
 * - 对象：键按 UTF-16 码元升序排序（`Array.prototype.sort` 默认序），无多余空白；
 * - 数字：必须是有限数，取其最短往返表示（`JSON.stringify` 语义，`-0` 规范为 `0`）；
 * - 时间：必须是可解析时刻，规范为 UTC 的 ISO8601（`Date.prototype.toISOString`）；
 * - 字符串：`JSON.stringify` 转义（良构转义，孤立代理项被转义为 `\uXXXX`）；
 * - 字节串：编码为 `{"$binary":"<base64>"}`；
 * - 数组：按原序；`undefined`、`bigint`、`symbol`、函数、循环引用、非平凡对象
 *   （`Date`/`Map`/`Set`/类实例）与稀疏数组一律拒绝——静默丢弃等于给哈希开洞。
 *
 * 因此 `payload_json` 落 `jsonb` 后键序被重排是无害的：规范形式与键序无关。
 * 哈希公式冻结为 `sha256(prev_hash ‖ canonical(payload))`（§9.5），不加域前缀。
 *
 * 升级时的重算策略：`hashPayloadFromRow()`（ledger.ts）+ `canonicalize()` +
 * `computeEventHash()` 即可按 `chain_seq` 升序重放整条链；改变覆盖字段集属于
 * **协议版本变更**（§9.1），必须递增 `EVENT_SCHEMA_VERSION` 并随迁移脚本重算。
 */

import { createHash, createHmac, timingSafeEqual, type Hmac } from 'node:crypto';
import {
  type Classification,
  type ErrorCode,
  type EventHashPayload,
  type TrustLevel,
} from '../contracts.ts';

// ───────────────────────────── 错误 ─────────────────────────────

/**
 * 账本拒绝路径的统一错误：携带契约的稳定错误码，绝不抛裸字符串
 * （设计文档 §16.5：模型据机器码分支，不解析 message 文本）。
 */
export class LedgerError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;

  constructor(code: ErrorCode, message: string, detail = '') {
    super(detail === '' ? message : `${message}；${detail}`);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

// ───────────────────────────── 常量与取值域 ─────────────────────────────

const HASH_ALGORITHM = 'sha256';
export const HASH_HEX_LENGTH = 64;
/** 记录的签名算法标识（审计与锚点存储用），对应 Node 摘要名 `sha256`。 */
export const BATCH_SIGNATURE_ALGORITHM = 'hmac-sha256';
const HMAC_DIGEST = 'sha256';
/** 空账本的链头哨兵：没有事件时 `anchor()` 以全零摘要表示「无链头」。 */
export const ZERO_HASH = '0'.repeat(HASH_HEX_LENGTH);
/** 批次签名的域分隔串：防止同一密钥的其它用途与本用途互相碰撞。 */
const BATCH_SIGNATURE_DOMAIN = 'dsh-pentest/ledger/batch-signature/v1';

/** 字节串在规范形式中的表示键。 */
const BINARY_MARKER = '$binary';

/**
 * 分类取值域。类型来自契约，运行时数组用于**校验**——无效分类必须在入库前拒绝，
 * 否则链上会留下无法解释的信任标注。
 */
export const CLASSIFICATIONS = [
  'public',
  'engagement',
  'secret-like',
  'reasoning',
  'credential-like',
  'binary',
] as const satisfies readonly Classification[];

/** 来源可信度取值域，同上。 */
export const TRUST_LEVELS = [
  'human_decision',
  'tool_observation',
  'agent_claim',
  'model_reasoning',
  'external_untrusted',
] as const satisfies readonly TrustLevel[];

/**
 * event_hash 覆盖的规范化字段集合（§9.5 冻结）。改集合属协议版本变更。
 * 契约若新增字段而此处未同步，`canonicalize()` 会以「存在哈希未覆盖字段」响亮拒绝。
 */
export const HASH_COVERED_FIELDS = [
  'eventType',
  'sourceSystem',
  'sourceId',
  'sourceSeq',
  'chainSeq',
  'occurredAt',
  'provisional',
  'classification',
  'trustLevel',
  'payloadJson',
  'rawPayload',
] as const satisfies readonly (keyof EventHashPayload)[];

export type HashCoveredField = (typeof HASH_COVERED_FIELDS)[number];

/** 密钥材料：由调用方从 KMS/环境变量注入。字符串按 UTF-8 解释。 */
export type LedgerSecret = Uint8Array | string;

// ───────────────────────────── 规范序列化 ─────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new LedgerError('audit_unavailable', '规范序列化拒绝非有限数值', `${path}=${String(value)}`);
  }
  // JSON.stringify 给出最短往返表示；-0 规范为 0，指数形式稳定。
  return JSON.stringify(value) as string;
}

/** 通用 JSON 规范编码：递归、键排序、拒绝一切无法确定性表达的输入。 */
function canonicalJson(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value, path);
    case 'string':
      return JSON.stringify(value) as string;
    case 'bigint':
      throw new LedgerError('audit_unavailable', '规范序列化拒绝 bigint', path);
    case 'undefined':
      throw new LedgerError('audit_unavailable', '规范序列化拒绝 undefined', path);
    case 'function':
    case 'symbol':
      throw new LedgerError('audit_unavailable', `规范序列化拒绝 ${typeof value}`, path);
    default:
      break;
  }

  const object = value as object;
  if (stack.has(object)) {
    throw new LedgerError('audit_unavailable', '规范序列化拒绝循环引用', path);
  }
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let i = 0; i < object.length; i += 1) {
        if (!(i in object)) {
          throw new LedgerError('audit_unavailable', '规范序列化拒绝稀疏数组', `${path}[${i}]`);
        }
        parts.push(canonicalJson(object[i], `${path}[${i}]`, stack));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(object)) {
      throw new LedgerError(
        'audit_unavailable',
        '规范序列化只接受平凡对象（JSON 语义）',
        `${path} 是 ${object.constructor?.name ?? '未知类型'}`,
      );
    }
    const keys = Object.keys(object).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalJson(object[key], `${path}.${key}`, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

function toBytes(value: Uint8Array, what: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new LedgerError('audit_unavailable', `${what} 必须是 Uint8Array`, typeof value);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function requireSafeSeq(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError('audit_unavailable', '序号必须是非负安全整数', `${path}=${String(value)}`);
  }
  return value;
}

/** 覆盖字段校验：缺字段、未覆盖字段、类型不符一律拒绝（fail-closed）。 */
function assertHashCoverage(payload: EventHashPayload): void {
  if (!isPlainObject(payload)) {
    throw new LedgerError('audit_unavailable', '事件哈希负载必须是平凡对象');
  }
  const covered = new Set<string>(HASH_COVERED_FIELDS);
  for (const field of HASH_COVERED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === undefined) {
      throw new LedgerError('audit_unavailable', '事件哈希负载缺少覆盖字段', field);
    }
  }
  for (const key of Object.keys(payload)) {
    if (!covered.has(key)) {
      throw new LedgerError(
        'audit_unavailable',
        '事件哈希负载存在未覆盖字段（改字段集属协议版本变更，见 §9.5）',
        key,
      );
    }
  }
}

/**
 * 确定性序列化。返回 UTF-8 规范字节串——同一逻辑负载必须得到逐字节相同的输出，
 * 否则哈希不可重现（§9.5「哈希可重现的前提」）。
 */
export function canonicalize(payload: EventHashPayload): Buffer {
  assertHashCoverage(payload);

  if (typeof payload.eventType !== 'string' || payload.eventType === '') {
    throw new LedgerError('audit_unavailable', 'eventType 必须是非空字符串');
  }
  if (typeof payload.sourceSystem !== 'string' || payload.sourceSystem === '') {
    throw new LedgerError('audit_unavailable', 'sourceSystem 必须是非空字符串');
  }
  if (typeof payload.sourceId !== 'string' || payload.sourceId === '') {
    throw new LedgerError('audit_unavailable', 'sourceId 必须是非空字符串');
  }
  requireSafeSeq(payload.sourceSeq, 'sourceSeq');
  requireSafeSeq(payload.chainSeq, 'chainSeq');
  if (typeof payload.provisional !== 'boolean') {
    throw new LedgerError('audit_unavailable', 'provisional 必须是布尔值');
  }
  if (!(CLASSIFICATIONS as readonly string[]).includes(payload.classification)) {
    throw new LedgerError(
      'classification_rejected',
      '分类取值不在契约取值域内',
      String(payload.classification),
    );
  }
  if (!(TRUST_LEVELS as readonly string[]).includes(payload.trustLevel)) {
    throw new LedgerError(
      'classification_rejected',
      '来源可信度取值不在契约取值域内',
      String(payload.trustLevel),
    );
  }

  if (typeof payload.occurredAt !== 'string') {
    throw new LedgerError('audit_unavailable', 'occurredAt 必须是 ISO8601 字符串');
  }
  const occurredAtMs = Date.parse(payload.occurredAt);
  if (Number.isNaN(occurredAtMs)) {
    throw new LedgerError('audit_unavailable', 'occurredAt 不可解析', payload.occurredAt);
  }
  // 时刻规范为 UTC ISO8601：带偏移的等价写法、毫秒位写法都收敛到同一字节串。
  const occurredAt = new Date(occurredAtMs).toISOString();

  const rawPayload = toBytes(payload.rawPayload, 'rawPayload');

  const record: Record<string, unknown> = {
    eventType: payload.eventType,
    sourceSystem: payload.sourceSystem,
    sourceId: payload.sourceId,
    sourceSeq: payload.sourceSeq,
    chainSeq: payload.chainSeq,
    occurredAt,
    provisional: payload.provisional,
    classification: payload.classification,
    trustLevel: payload.trustLevel,
    payloadJson: payload.payloadJson,
    rawPayload: { [BINARY_MARKER]: rawPayload.toString('base64') },
  };

  return Buffer.from(canonicalJson(record, '$', new Set<object>()), 'utf8');
}

// ───────────────────────────── 事件哈希 ─────────────────────────────

/**
 * `event_hash = sha256(prev_hash ‖ canonical(payload))`。
 * `prevHash` 为 `null` 表示创世事件（前缀为空字节串）；非空时必须正好 32 字节，
 * 否则「空字节串」与「零长度 Uint8Array」会产生同一摘要，链上出现歧义。
 */
export function computeEventHash(prevHash: Uint8Array | null, payload: EventHashPayload): string {
  const canonical = canonicalize(payload);
  const hash = createHash(HASH_ALGORITHM);
  if (prevHash !== null) {
    const prev = toBytes(prevHash, 'prevHash');
    if (prev.length !== 32) {
      throw new LedgerError('audit_unavailable', 'prevHash 必须是 32 字节 SHA-256 摘要', `${prev.length}`);
    }
    hash.update(prev);
  }
  hash.update(canonical);
  return hash.digest('hex');
}

// ───────────────────────────── 批次签名（HMAC-SHA256） ─────────────────────────────

/**
 * 批次签名绑定的作用域。签名必须覆盖链头与事件计数，否则「尾部截断」不会改变签名：
 * 攻击者删掉尾部若干行后，剩余部分的签名仍然合法。
 */
export interface BatchSignatureScope {
  readonly engagementId: string;
  /** 本批追加后的链头摘要（空账本为 `ZERO_HASH`）。 */
  readonly chainHead: string;
  /** 本批追加后该 engagement 的累计事件数。 */
  readonly eventCount: number;
}

function secretKey(secret: LedgerSecret): Buffer {
  if (typeof secret === 'string') {
    if (secret === '') {
      throw new LedgerError('audit_unavailable', '批次签名密钥为空（密钥须由 KMS/环境注入）');
    }
    return Buffer.from(secret, 'utf8');
  }
  const key = toBytes(secret, 'secret');
  if (key.length === 0) {
    throw new LedgerError('audit_unavailable', '批次签名密钥为空（密钥须由 KMS/环境注入）');
  }
  return Buffer.from(key);
}

function resolveScope(scope: BatchSignatureScope | undefined, payloadCount: number): BatchSignatureScope {
  const resolved: BatchSignatureScope = scope ?? {
    engagementId: '',
    chainHead: ZERO_HASH,
    eventCount: payloadCount,
  };
  if (typeof resolved.engagementId !== 'string') {
    throw new LedgerError('audit_unavailable', '签名作用域的 engagementId 必须是字符串');
  }
  if (typeof resolved.chainHead !== 'string' || resolved.chainHead.length !== HASH_HEX_LENGTH) {
    throw new LedgerError('audit_unavailable', '签名作用域的 chainHead 必须是 64 位十六进制摘要');
  }
  if (!Number.isSafeInteger(resolved.eventCount) || resolved.eventCount < 0) {
    throw new LedgerError('audit_unavailable', '签名作用域的 eventCount 必须是非负安全整数');
  }
  return resolved;
}

function u32be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new LedgerError('audit_unavailable', '长度前缀超出 uint32 范围', String(value));
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function frame(hash: Hmac, bytes: Buffer): void {
  // 长度前缀是关键：没有它，["ab","c"] 与 ["a","bc"] 会签出同一个值。
  hash.update(u32be(bytes.length));
  hash.update(bytes);
}

/**
 * 对一批事件负载做 HMAC-SHA256，返回小写十六进制签名。
 *
 * 密钥由调用方注入，运行时数据库角色不持有（§9.5）。
 */
export function signBatch(
  secret: LedgerSecret,
  payloads: readonly EventHashPayload[],
  scope?: BatchSignatureScope,
): string {
  const key = secretKey(secret);
  const resolved = resolveScope(scope, payloads.length);
  const hmac = createHmac(HMAC_DIGEST, key);
  // 域分隔：签名只在本用途内有效。
  hmac.update(Buffer.from(`${BATCH_SIGNATURE_DOMAIN}\u0000`, 'utf8'));
  frame(hmac, Buffer.from(resolved.engagementId, 'utf8'));
  frame(hmac, Buffer.from(resolved.chainHead, 'utf8'));
  hmac.update(u32be(resolved.eventCount));
  hmac.update(u32be(payloads.length));
  for (const payload of payloads) {
    frame(hmac, canonicalize(payload));
  }
  return hmac.digest('hex');
}

/**
 * 校验批次签名。任何异常（密钥为空、签名格式非法、负载不可规范化）都返回 `false`，
 * 不抛异常——校验失败就是失败，调用方不得据此降级放行。
 */
export function verifyBatch(
  secret: LedgerSecret,
  payloads: readonly EventHashPayload[],
  signature: string | Uint8Array,
  scope?: BatchSignatureScope,
): boolean {
  let expected: string;
  try {
    expected = signBatch(secret, payloads, scope);
  } catch {
    return false;
  }
  let given: Buffer;
  if (typeof signature === 'string') {
    if (signature.length !== HASH_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(signature)) return false;
    given = Buffer.from(signature, 'hex');
  } else if (signature instanceof Uint8Array) {
    given = Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength);
  } else {
    return false;
  }
  if (given.length !== HASH_HEX_LENGTH / 2) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), given);
}
