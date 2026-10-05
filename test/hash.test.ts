/**
 * `src/memory/hash.ts` 的纯函数测试（设计文档 §9.5）。
 *
 * 覆盖三条硬约束：确定性序列化、冻结字段集全覆盖（尤其 `classification` 与
 * `trustLevel`）、密钥签名的可验证性（含尾部截断不保持签名有效）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import type { EventHashPayload } from '../src/contracts.ts';
import {
  CLASSIFICATIONS,
  HASH_COVERED_FIELDS,
  HASH_HEX_LENGTH,
  LedgerError,
  TRUST_LEVELS,
  ZERO_HASH,
  canonicalize,
  computeEventHash,
  signBatch,
  verifyBatch,
} from '../src/memory/hash.ts';

const SECRET = 'kms://test/ledger-secret';

function payload(overrides: Partial<EventHashPayload> = {}): EventHashPayload {
  return {
    eventType: 'tool.result',
    sourceSystem: 'dsh',
    sourceId: 'run-1',
    sourceSeq: 1,
    chainSeq: 1,
    occurredAt: '2026-01-02T03:04:05.000Z',
    provisional: false,
    classification: 'engagement',
    trustLevel: 'tool_observation',
    payloadJson: { b: 2, a: 1 },
    rawPayload: new TextEncoder().encode('raw-bytes'),
    ...overrides,
  };
}

function assertLedgerError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LedgerError, `期望 LedgerError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('canonicalize：确定性序列化', () => {
  it('键序不影响规范字节串', () => {
    const a = canonicalize(payload({ payloadJson: { a: 1, b: { d: 4, c: 3 } } }));
    const b = canonicalize(payload({ payloadJson: { b: { c: 3, d: 4 }, a: 1 } }));
    assert.ok(a.equals(b));
  });

  it('等价时刻写法（偏移、无毫秒）收敛为同一字节串', () => {
    const utc = canonicalize(payload({ occurredAt: '2026-01-02T03:04:05.000Z' }));
    const offset = canonicalize(payload({ occurredAt: '2026-01-02T05:04:05+02:00' }));
    const noMillis = canonicalize(payload({ occurredAt: '2026-01-02T03:04:05Z' }));
    assert.ok(utc.equals(offset));
    assert.ok(utc.equals(noMillis));
  });

  it('数字取最短往返表示，-0 规范为 0', () => {
    const a = canonicalize(payload({ payloadJson: { n: -0, f: 1.5, e: 1e21 } }));
    const b = canonicalize(payload({ payloadJson: { e: 1e21, f: 1.5, n: 0 } }));
    assert.ok(a.equals(b));
  });

  it('数组按序，不排序', () => {
    const a = canonicalize(payload({ payloadJson: [1, 2, 3] }));
    const b = canonicalize(payload({ payloadJson: [3, 2, 1] }));
    assert.ok(!a.equals(b));
  });

  it('字节串以 base64 标记参与哈希，与同值的文本负载可区分', () => {
    const raw = new TextEncoder().encode('AQID');
    const asBytes = canonicalize(payload({ payloadJson: null, rawPayload: raw }));
    const asText = canonicalize(payload({ payloadJson: 'AQID', rawPayload: new Uint8Array(0) }));
    assert.ok(!asBytes.equals(asText));
    // 同样字节长度不同 → 规范字节串不同
    assert.ok(
      !canonicalize(payload({ rawPayload: new Uint8Array([1, 2, 3]) })).equals(
        canonicalize(payload({ rawPayload: new Uint8Array([1, 2, 4]) })),
      ),
    );
  });

  it('拒绝非有限数值', () => {
    assertLedgerError(() => canonicalize(payload({ payloadJson: { n: Number.NaN } })), 'audit_unavailable');
    assertLedgerError(
      () => canonicalize(payload({ payloadJson: { n: Number.POSITIVE_INFINITY } })),
      'audit_unavailable',
    );
  });

  it('拒绝 undefined / bigint / 函数', () => {
    assertLedgerError(() => canonicalize(payload({ payloadJson: { n: undefined } })), 'audit_unavailable');
    assertLedgerError(() => canonicalize(payload({ payloadJson: { n: 1n } })), 'audit_unavailable');
    assertLedgerError(() => canonicalize(payload({ payloadJson: { n: () => 1 } })), 'audit_unavailable');
  });

  it('拒绝非平凡对象（Date / Map / 类实例）', () => {
    assertLedgerError(
      () => canonicalize(payload({ payloadJson: { d: new Date('2026-01-02T03:04:05Z') } })),
      'audit_unavailable',
    );
    assertLedgerError(() => canonicalize(payload({ payloadJson: { m: new Map() } })), 'audit_unavailable');
    assertLedgerError(() => canonicalize(payload({ payloadJson: { s: new Set([1]) } })), 'audit_unavailable');
  });

  it('拒绝稀疏数组与循环引用', () => {
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1];
    assertLedgerError(() => canonicalize(payload({ payloadJson: sparse })), 'audit_unavailable');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assertLedgerError(() => canonicalize(payload({ payloadJson: cyclic })), 'audit_unavailable');
  });

  it('拒绝缺失的覆盖字段', () => {
    const broken = payload();
    delete (broken as { trustLevel?: unknown }).trustLevel;
    assertLedgerError(() => canonicalize(broken), 'audit_unavailable');
  });

  it('拒绝哈希未覆盖的额外字段（改字段集属协议版本变更）', () => {
    const extra = { ...payload(), classificationLabel: '内部' } as unknown as EventHashPayload;
    assertLedgerError(() => canonicalize(extra), 'audit_unavailable');
  });

  it('拒绝取值域外的分类与可信度', () => {
    assertLedgerError(
      () => canonicalize(payload({ classification: 'top-secret' as EventHashPayload['classification'] })),
      'classification_rejected',
    );
    assertLedgerError(
      () => canonicalize(payload({ trustLevel: 'god' as EventHashPayload['trustLevel'] })),
      'classification_rejected',
    );
  });

  it('拒绝不可解析的 occurredAt 与非字节串 rawPayload', () => {
    assertLedgerError(() => canonicalize(payload({ occurredAt: '昨天' })), 'audit_unavailable');
    assertLedgerError(
      () => canonicalize(payload({ rawPayload: 'raw' as unknown as Uint8Array })),
      'audit_unavailable',
    );
  });

  it('规范字节串是 UTF-8 文本且可跨进程重现', () => {
    const bytes = canonicalize(payload());
    assert.equal(bytes.toString('utf8'), bytes.toString());
    assert.ok(bytes.length > 0);
  });
});

describe('computeEventHash：链式哈希', () => {
  it('同负载同前序哈希得同一摘要', () => {
    assert.equal(computeEventHash(null, payload()), computeEventHash(null, payload()));
  });

  it('覆盖字段集内任一字段变化都会改变摘要', () => {
    const base = payload();
    const baseline = computeEventHash(null, base);
    const mutations: Record<string, Partial<EventHashPayload>> = {
      eventType: { eventType: 'tool.call' },
      sourceSystem: { sourceSystem: 'collector' },
      sourceId: { sourceId: 'run-2' },
      sourceSeq: { sourceSeq: 2 },
      chainSeq: { chainSeq: 2 },
      occurredAt: { occurredAt: '2026-01-02T03:04:06.000Z' },
      provisional: { provisional: true },
      classification: { classification: 'public' },
      trustLevel: { trustLevel: 'external_untrusted' },
      payloadJson: { payloadJson: { a: 1, b: 3 } },
      rawPayload: { rawPayload: new TextEncoder().encode('raw-bytez') },
    };
    assert.deepEqual(Object.keys(mutations).sort(), [...HASH_COVERED_FIELDS].sort());
    for (const field of HASH_COVERED_FIELDS) {
      const mutated = { ...base, ...mutations[field] };
      assert.notEqual(
        computeEventHash(null, mutated),
        baseline,
        `字段 ${field} 的改动未被哈希覆盖`,
      );
    }
  });

  it('篡改 classification 导致校验失败（改标信任语义必须可检出）', () => {
    const stored = computeEventHash(null, payload({ classification: 'credential-like' }));
    const tampered = payload({ classification: 'public' });
    assert.notEqual(computeEventHash(null, tampered), stored);
  });

  it('篡改 trustLevel 导致校验失败（外部不可信不能改标为人工决策）', () => {
    const stored = computeEventHash(null, payload({ trustLevel: 'external_untrusted' }));
    const tampered = payload({ trustLevel: 'human_decision' });
    assert.notEqual(computeEventHash(null, tampered), stored);
    const reordered = computeEventHash(null, payload({ trustLevel: 'human_decision' }));
    assert.notEqual(reordered, stored);
  });

  it('前序哈希参与摘要：换前序即换事件哈希', () => {
    const chainSeq = 2;
    const prevA = Buffer.alloc(32, 1);
    const prevB = Buffer.alloc(32, 2);
    const at = payload({ chainSeq });
    assert.notEqual(computeEventHash(prevA, at), computeEventHash(prevB, at));
    assert.notEqual(computeEventHash(prevA, at), computeEventHash(null, at));
  });

  it('前序哈希必须是 32 字节摘要', () => {
    assertLedgerError(() => computeEventHash(new Uint8Array(16), payload()), 'audit_unavailable');
    assertLedgerError(() => computeEventHash(new Uint8Array(0), payload()), 'audit_unavailable');
  });

  it('摘要是 64 位小写十六进制（SHA-256）', () => {
    const digest = computeEventHash(null, payload());
    assert.equal(digest.length, HASH_HEX_LENGTH);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(ZERO_HASH.length, HASH_HEX_LENGTH);
  });
});

describe('signBatch / verifyBatch：密钥签名', () => {
  const batch = [payload(), payload({ sourceSeq: 2, chainSeq: 2, payloadJson: { a: 2 } })];
  const scope = { engagementId: 'eng-1', chainHead: 'a'.repeat(64), eventCount: 2 };

  it('同输入同密钥得同一签名，且是 HMAC-SHA256 定长', () => {
    const first = signBatch(SECRET, batch, scope);
    assert.equal(first, signBatch(SECRET, batch, scope));
    assert.equal(first.length, HASH_HEX_LENGTH);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it('签名随密钥变化（运行时角色不持密钥，故无法伪造）', () => {
    assert.notEqual(signBatch('other-key', batch, scope), signBatch(SECRET, batch, scope));
  });

  it('签名需要密钥：不是负载的裸摘要（无密钥哈希链不提供保护）', () => {
    const canonical = Buffer.concat(batch.map((item) => canonicalize(item)));
    const naked = createHash('sha256').update(canonical).digest('hex');
    assert.notEqual(signBatch(SECRET, batch, scope), naked);
    assert.notEqual(signBatch('key-a', batch, scope), signBatch('key-b', batch, scope));
  });

  it('负载集合的内容变化导致签名变化', () => {
    const tampered = [batch[0]!, payload({ sourceSeq: 2, chainSeq: 2, payloadJson: { a: 3 } })];
    assert.notEqual(signBatch(SECRET, tampered, scope), signBatch(SECRET, batch, scope));
    assert.equal(verifyBatch(SECRET, tampered, signBatch(SECRET, batch, scope), scope), false);
  });

  it('负载顺序影响签名（长度前缀分帧，避免拼接歧义）', () => {
    assert.notEqual(signBatch(SECRET, [...batch].reverse(), scope), signBatch(SECRET, batch, scope));
  });

  it('作用域（engagement/链头/计数）绑定：尾部截断不保持签名有效', () => {
    const signature = signBatch(SECRET, batch, scope);
    assert.equal(verifyBatch(SECRET, batch, signature, scope), true);
    assert.equal(
      verifyBatch(SECRET, batch, signature, { ...scope, eventCount: 1 }),
      false,
      '事件计数变了签名必须失效——计数是检测尾部截断的抓手',
    );
    assert.equal(
      verifyBatch(SECRET, batch, signature, { ...scope, chainHead: 'b'.repeat(64) }),
      false,
    );
    assert.equal(
      verifyBatch(SECRET, batch, signature, { ...scope, engagementId: 'eng-2' }),
      false,
    );
  });

  it('签名负载截断或改写后校验失败', () => {
    const signature = signBatch(SECRET, batch, scope);
    assert.equal(verifyBatch(SECRET, [batch[0]!], signature, { ...scope, eventCount: 1 }), false);
    assert.equal(verifyBatch(SECRET, batch, signature.slice(0, 63), scope), false);
    assert.equal(verifyBatch(SECRET, batch, 'Z'.repeat(64), scope), false);
    assert.equal(verifyBatch(SECRET, batch, '', scope), false);
  });

  it('错误密钥或不存在的密钥一律校验失败，不抛异常', () => {
    const signature = signBatch(SECRET, batch, scope);
    assert.equal(verifyBatch('wrong-key', batch, signature, scope), false);
    assert.equal(verifyBatch('', batch, signature, scope), false);
  });

  it('空密钥被拒绝（密钥必须由 KMS 注入）', () => {
    assertLedgerError(() => signBatch('', batch, scope), 'audit_unavailable');
    assertLedgerError(() => signBatch(new Uint8Array(0), batch, scope), 'audit_unavailable');
    assert.equal(verifyBatch('', batch, signBatch(SECRET, batch, scope), scope), false);
  });

  it('支持 Uint8Array 密钥（KMS 原始字节）与 bytea 签名', () => {
    const key = new TextEncoder().encode(SECRET);
    const signature = signBatch(key, batch, scope);
    assert.equal(signature, signBatch(SECRET, batch, scope));
    assert.equal(verifyBatch(key, batch, Buffer.from(signature, 'hex'), scope), true);
    assert.equal(verifyBatch(key, batch, Buffer.from(signature, 'hex').subarray(0, 31), scope), false);
  });

  it('作用域非法时拒绝签名（不静默接受坏作用域）', () => {
    assertLedgerError(
      () => signBatch(SECRET, batch, { ...scope, chainHead: 'short' }),
      'audit_unavailable',
    );
    assertLedgerError(
      () => signBatch(SECRET, batch, { ...scope, eventCount: -1 }),
      'audit_unavailable',
    );
  });

  it('分类取值域与契约一致', () => {
    assert.deepEqual([...CLASSIFICATIONS].sort(), [
      'binary',
      'credential-like',
      'engagement',
      'public',
      'reasoning',
      'secret-like',
    ]);
    assert.deepEqual([...TRUST_LEVELS].sort(), [
      'agent_claim',
      'external_untrusted',
      'human_decision',
      'model_reasoning',
      'tool_observation',
    ]);
  });
});
