/**
 * 嵌入提供方与嵌入版本登记测试（设计文档 §12.2、§9.1、§8.5、§8.4）。
 *
 * 两类用例：
 *   - **纯逻辑**：分批、顺序、维度/形状校验、取消传播、失败语义、远端请求与响应解析。
 *     不碰数据库、不碰网络（远端用注入的假 `fetch`），因此始终运行。
 *   - **集成**：嵌入版本登记只在设置了 `PENTEST_DATABASE_URL` 时运行。必须用真实
 *     PostgreSQL 的原因：`embedding_revisions_one_active` 是**部分唯一索引**
 *     （`WHERE is_active`），`engagement_id` 是 `uuid` 外键——假 DB 两者都模拟不出来，
 *     而 `activate` 的正确性恰恰取决于「先让位、后激活」是否躲开该索引。
 *
 * 连接用单连接 `pg.Client`：`activate`/`ensureRevision` 的 `begin`/`commit` 与
 * advisory lock 必须在同一条连接上（见实现文件的事务约定）。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';

import type { DbClient } from '../src/memory/ledger.ts';
import {
  DEFAULT_EMBED_BATCH_SIZE,
  EmbeddingError,
  EmbeddingRevisionRegistry,
  LocalEmbeddingProvider,
  MEMORY_EMBEDDING_DIMENSIONS,
  RemoteEmbeddingProvider,
  assertDimensions,
  type EmbedBatchInfer,
  type EmbeddingFetch,
  type EmbeddingHttpResponse,
} from '../src/memory/embedding.ts';

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

const DIMS = MEMORY_EMBEDDING_DIMENSIONS;

/** 便于断言顺序的向量：第 0 位放标识，其余补零。 */
function vector(id: number, dimensions: number = DIMS): number[] {
  const values = new Array<number>(dimensions).fill(0);
  values[0] = id;
  return values;
}

/** 记录调用批次与信号的假推理端：把文本中的数字编码进向量首位。 */
function recordingInfer(): {
  readonly calls: string[][];
  readonly signals: (AbortSignal | undefined)[];
  readonly infer: EmbedBatchInfer;
} {
  const calls: string[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const infer: EmbedBatchInfer = (batch, signal) => {
    calls.push([...batch]);
    signals.push(signal);
    return Promise.resolve(batch.map((text) => vector(Number(text) + 1)));
  };
  return { calls, signals, infer };
}

function localProvider(overrides: {
  readonly infer?: EmbedBatchInfer;
  readonly batchSize?: number;
  readonly model?: string;
  readonly revision?: string;
  readonly dimensions?: number;
}): LocalEmbeddingProvider {
  return new LocalEmbeddingProvider({
    model: overrides.model ?? 'local-model',
    dimensions: overrides.dimensions ?? DIMS,
    revision: overrides.revision ?? 'emb-1',
    infer: overrides.infer ?? recordingInfer().infer,
    ...(overrides.batchSize === undefined ? {} : { batchSize: overrides.batchSize }),
  });
}

function jsonResponse(body: unknown, status = 200): EmbeddingHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function openAiBody(vectors: readonly number[][]): unknown {
  return { data: vectors.map((embedding, index) => ({ embedding, index })) };
}

/** 记录请求的假 fetch；`handler` 拿到本批输入与调用序号，返回响应。 */
function recordingFetch(handler: (batch: readonly string[], call: number) => EmbeddingHttpResponse): {
  readonly calls: { url: string; body: { model: string; input: string[] }; apiKey: string | undefined }[];
  readonly fetch: EmbeddingFetch;
} {
  const calls: { url: string; body: { model: string; input: string[] }; apiKey: string | undefined }[] = [];
  const fetchImpl: EmbeddingFetch = (url, init) => {
    const body: { model: string; input: string[] } = JSON.parse(init.body);
    calls.push({ url, body, apiKey: init.headers['authorization'] });
    return Promise.resolve(handler(body.input, calls.length - 1));
  };
  return { calls, fetch: fetchImpl };
}

function remoteProvider(overrides: {
  readonly fetch: EmbeddingFetch;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly revision?: string;
  readonly dimensions?: number;
}): RemoteEmbeddingProvider {
  return new RemoteEmbeddingProvider({
    endpoint: overrides.endpoint ?? 'https://embeddings.example/v1/embeddings',
    apiKey: overrides.apiKey ?? 'secret-key-value',
    model: overrides.model ?? 'remote-model',
    dimensions: overrides.dimensions ?? DIMS,
    revision: overrides.revision ?? 'emb-remote-1',
    fetch: overrides.fetch,
    ...(overrides.batchSize === undefined ? {} : { batchSize: overrides.batchSize }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
}

// ───────────────────────────── 纯逻辑 ─────────────────────────────

describe('嵌入提供方（纯逻辑，不碰数据库）', () => {
  describe('LocalEmbeddingProvider：分批与顺序', () => {
    it('按 batchSize 分批提交，批间顺序不变且不丢不重', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer, batchSize: 3 });
      const texts = ['0', '1', '2', '3', '4', '5', '6'];
      const vectors = await provider.embed(texts);

      assert.deepEqual(recorder.calls.map((batch) => batch.length), [3, 3, 1]);
      assert.deepEqual(recorder.calls[0], ['0', '1', '2']);
      assert.deepEqual(recorder.calls[2], ['6']);
      // 首位即文本标识：顺序与输入一一对应，没有重复也没有缺失。
      assert.deepEqual(vectors.map((item) => item[0]), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(new Set(vectors.map((item) => item[0])).size, texts.length);
    });

    it('空输入不发起任何请求', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer, batchSize: 3 });
      assert.deepEqual(await provider.embed([]), []);
      assert.equal(recorder.calls.length, 0);
    });

    it('batchSize=1 时逐条提交', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer, batchSize: 1 });
      const vectors = await provider.embed(['0', '1']);
      assert.deepEqual(recorder.calls.map((batch) => batch.length), [1, 1]);
      assert.deepEqual(vectors.map((item) => item[0]), [1, 2]);
    });

    it('默认 batchSize 为 DEFAULT_EMBED_BATCH_SIZE', () => {
      assert.equal(localProvider({}).batchSize, DEFAULT_EMBED_BATCH_SIZE);
    });

    it('调用方传入的 AbortSignal 原样传给推理端', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer, batchSize: 2 });
      const controller = new AbortController();
      await provider.embed(['0', '1'], controller.signal);
      assert.equal(recorder.signals.length, 1);
      assert.equal(recorder.signals[0], controller.signal);
    });

    it('预取消的信号立即拒绝且不调用推理端', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(provider.embed(['0'], controller.signal), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AbortError');
        return true;
      });
      assert.equal(recorder.calls.length, 0);
    });

    it('批次间取消时抛出取消原因，不包装成提供方不可用', async () => {
      const controller = new AbortController();
      let calls = 0;
      const infer: EmbedBatchInfer = (batch) => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
          return Promise.reject(new DOMException('调用方取消', 'AbortError'));
        }
        return Promise.resolve(batch.map((text) => vector(Number(text) + 1)));
      };
      const provider = localProvider({ infer, batchSize: 2 });
      await assert.rejects(provider.embed(['0', '1', '2', '3'], controller.signal), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AbortError');
        assert.equal(error instanceof EmbeddingError, false);
        return true;
      });
      assert.equal(calls, 2);
    });
  });

  describe('LocalEmbeddingProvider：失败语义与形状校验', () => {
    it('提供方不可用时抛错，绝不返回零向量兜底', async () => {
      const infer: EmbedBatchInfer = () => Promise.reject(new Error('模型进程已退出'));
      const provider = localProvider({ infer });
      await assert.rejects(provider.embed(['需要嵌入的文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'provider_unavailable');
        // 原始原因必须带出，否则运维无法区分模型崩溃与配置错误。
        assert.match(error.message, /模型进程已退出/);
        assert.match(error.message, /local/);
        return true;
      });
    });

    it('返回向量维度不符时按维度错误拒绝（错误信息可操作）', async () => {
      const infer: EmbedBatchInfer = (batch) =>
        Promise.resolve(batch.map(() => vector(1, 768)));
      const provider = localProvider({ infer });
      await assert.rejects(provider.embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'dimension_mismatch');
        assert.match(error.message, /768/);
        assert.match(error.message, /1024/);
        assert.match(error.message, /新建嵌入版本/);
        assert.match(error.message, /重建索引/);
        return true;
      });
    });

    it('返回向量数量与请求不符时拒绝部分结果', async () => {
      const infer: EmbedBatchInfer = () => Promise.resolve([vector(1)]);
      const provider = localProvider({ infer });
      await assert.rejects(provider.embed(['甲', '乙']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'invalid_response');
        assert.match(error.message, /数量/);
        return true;
      });
    });

    it('返回 NaN/Infinity 时拒绝写入', async () => {
      const bad = vector(1);
      bad[1] = Number.NaN;
      const infer: EmbedBatchInfer = () => Promise.resolve([bad]);
      const provider = localProvider({ infer });
      await assert.rejects(provider.embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'invalid_response');
        assert.match(error.message, /非有限数值/);
        return true;
      });
    });

    it('文本数组含非字符串时在调用提供方之前拒绝', async () => {
      const recorder = recordingInfer();
      const provider = localProvider({ infer: recorder.infer });
      await assert.rejects(
        provider.embed(['ok', 42 as unknown as string]),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
          assert.equal(error.code, 'invalid_config');
          return true;
        },
      );
      assert.equal(recorder.calls.length, 0);
    });

    it('batchSize 非法时构造即失败', () => {
      assert.throws(
        () => localProvider({ batchSize: 0 }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
      assert.throws(
        () => localProvider({ batchSize: 2.5 }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
    });

    it('model/revision 缺失时构造即失败', () => {
      assert.throws(
        () => localProvider({ model: '  ' }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
      assert.throws(
        () => localProvider({ revision: '' }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
    });
  });

  describe('维度硬约束 assertDimensions', () => {
    it('列维度常量与 memory_chunks.embedding 的 vector(1024) 一致', () => {
      assert.equal(MEMORY_EMBEDDING_DIMENSIONS, 1024);
    });

    it('维度一致时通过', () => {
      assertDimensions(localProvider({}));
    });

    it('维度不符时拒绝并指引新建嵌入版本与重建索引', () => {
      const provider = localProvider({ dimensions: 768, model: 'bge-m3' });
      assert.throws(
        () => assertDimensions(provider),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
          assert.equal(error.code, 'dimension_mismatch');
          assert.match(error.message, /memory_chunks\.embedding/);
          assert.match(error.message, /vector\(1024\)/);
          assert.match(error.message, /768/);
          assert.match(error.message, /bge-m3/);
          assert.match(error.message, /新建嵌入版本/);
          assert.match(error.message, /重建索引/);
          // §9.1：不原地解释旧向量——截断/补零必须被明确禁止。
          assert.match(error.message, /截断|补零/);
          return true;
        },
      );
    });

    it('支持自定义期望维度', () => {
      assertDimensions({ model: 'm', revision: 'r', dimensions: 512 }, 512);
      assert.throws(
        () => assertDimensions({ model: 'm', revision: 'r', dimensions: 512 }, 768),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
          assert.match(error.message, /768/);
          return true;
        },
      );
    });

    it('期望维度本身非法时按配置错误拒绝', () => {
      assert.throws(
        () => assertDimensions({ model: 'm', revision: 'r', dimensions: 1024 }, 0),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
    });
  });

  describe('RemoteEmbeddingProvider：请求构造与响应解析', () => {
    it('请求体包含 model/input，凭据走 Bearer 头，响应按 index 还原顺序', async () => {
      // 服务端乱序返回（index 1 在前），客户端必须按 index 复原而不是按数组顺序。
      const recorder = recordingFetch(() =>
        jsonResponse({ data: [{ embedding: vector(2), index: 1 }, { embedding: vector(1), index: 0 }] }),
      );
      const provider = remoteProvider({ fetch: recorder.fetch });

      const vectors = await provider.embed(['alpha', 'beta']);

      assert.equal(recorder.calls.length, 1);
      assert.equal(recorder.calls[0]?.url, 'https://embeddings.example/v1/embeddings');
      assert.equal(recorder.calls[0]?.body.model, 'remote-model');
      assert.deepEqual(recorder.calls[0]?.body.input, ['alpha', 'beta']);
      assert.equal(recorder.calls[0]?.apiKey, 'Bearer secret-key-value');
      assert.deepEqual(vectors.map((item) => item[0]), [1, 2]);
    });

    it('按 batchSize 分批调用远端，每次只带本批文本', async () => {
      const recorder = recordingFetch((batch) => jsonResponse(openAiBody(batch.map(() => vector(1)))));
      const provider = remoteProvider({ fetch: recorder.fetch, batchSize: 2 });
      const vectors = await provider.embed(['0', '1', '2', '3', '4']);
      assert.deepEqual(recorder.calls.map((call) => call.body.input.length), [2, 2, 1]);
      assert.deepEqual(recorder.calls[2]?.body.input, ['4']);
      assert.equal(vectors.length, 5);
    });

    it('HTTP 非 2xx 抛 provider_unavailable 且不回显凭据', async () => {
      const recorder = recordingFetch(() => jsonResponse('upstream boom', 500));
      const provider = remoteProvider({ fetch: recorder.fetch, apiKey: 'top-secret-key' });
      await assert.rejects(provider.embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'provider_unavailable');
        assert.match(error.message, /500/);
        assert.doesNotMatch(error.message, /top-secret-key/);
        assert.match(error.message, /upstream boom/);
        return true;
      });
    });

    it('响应不是合法 JSON 时按无效响应拒绝', async () => {
      const recorder = recordingFetch(() => jsonResponse('<html>bad gateway</html>', 200));
      const provider = remoteProvider({ fetch: recorder.fetch });
      await assert.rejects(provider.embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'invalid_response');
        return true;
      });
    });

    it('缺少 data 数组时按无效响应拒绝', async () => {
      const recorder = recordingFetch(() => jsonResponse({ embeddings: [] }));
      const provider = remoteProvider({ fetch: recorder.fetch });
      await assert.rejects(provider.embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'invalid_response');
        return true;
      });
    });

    it('index 重复或越界时拒绝，避免向量错位', async () => {
      const duplicate = recordingFetch(() =>
        jsonResponse({ data: [{ embedding: vector(1), index: 0 }, { embedding: vector(2), index: 0 }] }),
      );
      await assert.rejects(
        remoteProvider({ fetch: duplicate.fetch }).embed(['甲', '乙']),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
          assert.equal(error.code, 'invalid_response');
          assert.match(error.message, /index/);
          return true;
        },
      );

      const outOfRange = recordingFetch(() =>
        jsonResponse({ data: [{ embedding: vector(1), index: 0 }, { embedding: vector(2), index: 7 }] }),
      );
      await assert.rejects(
        remoteProvider({ fetch: outOfRange.fetch }).embed(['甲', '乙']),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
          assert.equal(error.code, 'invalid_response');
          return true;
        },
      );
    });

    it('远端返回维度不符的向量时按维度错误拒绝', async () => {
      const recorder = recordingFetch(() => jsonResponse(openAiBody([vector(1, 1536)])));
      await assert.rejects(remoteProvider({ fetch: recorder.fetch }).embed(['文本']), (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'dimension_mismatch');
        assert.match(error.message, /1536/);
        assert.match(error.message, /1024/);
        return true;
      });
    });

    it('调用方取消时传播原始取消原因，不包装成提供方不可用', async () => {
      const hanging: EmbeddingFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal === undefined) {
            reject(new Error('缺少信号'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      const controller = new AbortController();
      const promise = remoteProvider({ fetch: hanging }).embed(['文本'], controller.signal);
      controller.abort();
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AbortError');
        assert.equal(error instanceof EmbeddingError, false);
        return true;
      });
    });

    it('超时报告为提供方不可用（不永久占着索引租约）', async () => {
      const hanging: EmbeddingFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal === undefined) {
            reject(new Error('缺少信号'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      // `AbortSignal.timeout` 的定时器是 unref 的，而假 fetch 没有真实连接句柄；
      // 用一次性 ref 定时器把事件循环撑住，否则进程会先判定「无事可做」。
      const keepAlive = setTimeout(() => {}, 200);
      try {
        await assert.rejects(
          remoteProvider({ fetch: hanging, timeoutMs: 5 }).embed(['文本']),
          (error: unknown) => {
            assert.ok(error instanceof EmbeddingError);
            assert.equal(error.code, 'provider_unavailable');
            assert.match(error.message, /超时/);
            return true;
          },
        );
      } finally {
        clearTimeout(keepAlive);
      }
    });

    it('配置非法时构造即失败', () => {
      const recorder = recordingFetch(() => jsonResponse(openAiBody([vector(1)])));
      assert.throws(
        () => remoteProvider({ fetch: recorder.fetch, endpoint: 'ftp://embeddings.example' }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
      assert.throws(
        () => remoteProvider({ fetch: recorder.fetch, apiKey: '   ' }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
      assert.throws(
        () => remoteProvider({ fetch: recorder.fetch, timeoutMs: 0 }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
      assert.throws(
        () => remoteProvider({ fetch: recorder.fetch, dimensions: 0 }),
        (error: unknown) => error instanceof EmbeddingError && error.code === 'invalid_config',
      );
    });
  });
});

// ───────────────────────────── 集成（真实 PostgreSQL） ─────────────────────────────

describe('集成：真实 PostgreSQL（嵌入版本登记）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let client: Client;
  let db: DbClient;
  let registry: EmbeddingRevisionRegistry;
  const engagementIds: string[] = [];

  async function seedEngagement(): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
          roe_snapshot, policy_snapshot, config_snapshot, created_by)
       VALUES ($1::uuid, 'test', $2, 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [id, `embedding-test-${id}`],
    );
    engagementIds.push(id);
    return id;
  }

  async function revisionRows(engagementId: string): Promise<
    { revision: string; model: string; dimensions: number; is_active: boolean }[]
  > {
    const result = await client.query<{
      revision: string;
      model: string;
      dimensions: number;
      is_active: boolean;
    }>(
      `SELECT revision, model, dimensions, is_active FROM pentest.embedding_revisions
        WHERE engagement_id = $1::uuid ORDER BY revision`,
      [engagementId],
    );
    return result.rows;
  }

  before(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    // 测试连的是单连接 Client；`pg.Client` 与最小端口结构一致（见实现文件的事务约定）。
    db = client as unknown as DbClient;
    registry = new EmbeddingRevisionRegistry({ db });
  });

  after(async () => {
    for (const engagementId of engagementIds) {
      await client.query('DELETE FROM pentest.embedding_revisions WHERE engagement_id = $1::uuid', [
        engagementId,
      ]);
      await client.query('DELETE FROM pentest.engagements WHERE id = $1::uuid', [engagementId]);
    }
    await client.end();
  });

  it('首次登记即生效，active 读回同一版本', async () => {
    const engagementId = await seedEngagement();
    const provider = localProvider({ model: 'bge-m3', revision: 'emb-1' });
    const record = await registry.ensureRevision(engagementId, provider);

    assert.equal(record.revision, 'emb-1');
    assert.equal(record.isActive, true);
    const active = await registry.active(engagementId);
    assert.deepEqual(active, {
      engagementId,
      revision: 'emb-1',
      model: 'bge-m3',
      dimensions: DIMS,
      isActive: true,
    });
  });

  it('未登记任何版本时 active 返回 null', async () => {
    const engagementId = await seedEngagement();
    assert.equal(await registry.active(engagementId), null);
  });

  it('同一 revision 重复登记幂等：不新增行、不报错、仍只有一个生效版本', async () => {
    const engagementId = await seedEngagement();
    const provider = { model: 'bge-m3', revision: 'emb-1', dimensions: DIMS };
    await registry.ensureRevision(engagementId, provider);
    const again = await registry.ensureRevision(engagementId, provider);

    assert.equal(again.revision, 'emb-1');
    const rows = await revisionRows(engagementId);
    assert.equal(rows.length, 1);
    assert.equal(rows.filter((row) => row.is_active).length, 1);
  });

  it('同一 revision 的 model 冲突时拒绝，且不改动生效版本', async () => {
    const engagementId = await seedEngagement();
    await registry.ensureRevision(engagementId, { model: 'bge-m3', revision: 'emb-1', dimensions: DIMS });
    await assert.rejects(
      registry.ensureRevision(engagementId, { model: 'other-model', revision: 'emb-1', dimensions: DIMS }),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'revision_conflict');
        assert.match(error.message, /emb-1/);
        return true;
      },
    );
    const rows = await revisionRows(engagementId);
    assert.deepEqual(rows, [{ revision: 'emb-1', model: 'bge-m3', dimensions: DIMS, is_active: true }]);
  });

  it('维度不符的提供方在写库之前被拒，不留残余行', async () => {
    const engagementId = await seedEngagement();
    await assert.rejects(
      registry.ensureRevision(engagementId, { model: 'bge-m3', revision: 'emb-1', dimensions: 768 }),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'dimension_mismatch');
        assert.match(error.message, /新建嵌入版本/);
        return true;
      },
    );
    assert.deepEqual(await revisionRows(engagementId), []);
    assert.equal(await registry.active(engagementId), null);
  });

  it('activate 切换生效版本：先让位再激活，不撞部分唯一索引', async () => {
    const engagementId = await seedEngagement();
    await registry.ensureRevision(engagementId, { model: 'bge-m3', revision: 'emb-1', dimensions: DIMS });
    const second = await registry.ensureRevision(engagementId, {
      model: 'remote-v2',
      revision: 'emb-2',
      dimensions: DIMS,
    });
    // 已存在生效版本时，新登记版本不自动生效——切换必须显式进行。
    assert.equal(second.isActive, false);
    assert.equal((await registry.active(engagementId))?.revision, 'emb-1');

    await registry.activate(engagementId, 'emb-2');

    const rows = await revisionRows(engagementId);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.filter((row) => row.is_active).map((row) => row.revision),
      ['emb-2'],
    );

    // 反向切回也必须成功：两次切换都经过同一对「让位/激活」语句。
    await registry.activate(engagementId, 'emb-1');
    const active = await registry.active(engagementId);
    assert.equal(active?.revision, 'emb-1');
    assert.equal((await revisionRows(engagementId)).filter((row) => row.is_active).length, 1);
  });

  it('activate 幂等：重复激活同一版本不报错且仍只有一个生效版本', async () => {
    const engagementId = await seedEngagement();
    await registry.ensureRevision(engagementId, { model: 'bge-m3', revision: 'emb-1', dimensions: DIMS });
    await registry.activate(engagementId, 'emb-1');
    await registry.activate(engagementId, 'emb-1');
    assert.equal((await revisionRows(engagementId)).filter((row) => row.is_active).length, 1);
    assert.equal((await registry.active(engagementId))?.revision, 'emb-1');
  });

  it('activate 未登记版本时抛 revision_unknown 且不改变生效版本', async () => {
    const engagementId = await seedEngagement();
    await registry.ensureRevision(engagementId, { model: 'bge-m3', revision: 'emb-1', dimensions: DIMS });
    await assert.rejects(registry.activate(engagementId, 'emb-missing'), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.code, 'revision_unknown');
      assert.match(error.message, /emb-missing/);
      return true;
    });
    assert.equal((await registry.active(engagementId))?.revision, 'emb-1');
  });

  it('登记使用真实提供方对象（LocalEmbeddingProvider）而非临时字面量', async () => {
    const engagementId = await seedEngagement();
    const provider = localProvider({ model: 'bge-m3', revision: 'emb-1' });
    const record = await registry.ensureRevision(engagementId, provider);
    assert.equal(record.dimensions, provider.dimensions);
    assert.equal(record.model, provider.model);
    assert.equal(record.revision, provider.revision);
  });
});
