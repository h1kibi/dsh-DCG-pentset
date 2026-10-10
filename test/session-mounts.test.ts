/**
 * 「本次运行挂什么」的**一致性锁**（2026-10-11）。
 *
 * **为什么这个文件必须存在**：容器 argv、`pentest_workdir` 的读写根、宿主侧证据落盘根、会话简报
 * 是同一份事实的四个视图。2026-10-08 引入"按会话 cwd 覆盖 `/work`"时只改了前两者中的 argv
 * （与简报），工具与证据落盘仍读配置目录 —— 实测症状是最坏的一种：容器把 `.xml/.json` 写进会话
 * cwd，而操作者在工具里只看到自己手写的 `.txt`，于是"证据不存在"。文件一份不少，只是分居两处。
 *
 * 这里在**一个断言里跨两侧**（`buildDockerArgs` 的 `-v` ↔ 工具侧 roots ↔ 证据根）：
 * 切缝两侧的约定必须在一处对齐，否则下一次改动还会只改一半。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDockerArgs } from '../src/execution/docker-sandbox.ts';
import type { AllowedImage, DockerSandboxConfig } from '../src/execution/docker-sandbox.ts';
import { sessionMountsForCwd, sessionMountViews } from '../src/execution/session-mounts.ts';
import type { ExecutionPlan, SandboxMount } from '../src/contracts.ts';

const IMAGE: AllowedImage = {
  name: 'registry.example/pentest-toolbox',
  digest: 'sha256:' + 'd'.repeat(64),
};
const CONFIG: DockerSandboxConfig = { allowedImages: [IMAGE], internalNetwork: 'pentest-sandbox' };

const norm = (p: string): string => p.replace(/\\/g, '/');

function plan(workerSessionId: string): ExecutionPlan {
  return {
    workerSessionId,
    templateId: 'http_read',
    actionClass: 'passive_collection',
    normalizedTarget: 'https://a.target.com/',
    resolvedAddresses: ['93.184.216.34'],
    normalizedCommand: 'http_read url=https://a.target.com/ method=GET',
    planHash: 'ph-1',
    idempotencyKey: 'ik-1',
    scopeVersion: 7,
    policyEpoch: 3,
    leaseGeneration: 1,
    approvalId: null,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  };
}

/** 从 argv 里取出真实的 `-v` 值（`host:container[:ro]` 是**一个** argv 元素）。 */
function volumeFlags(argv: readonly string[]): readonly string[] {
  return argv.flatMap((entry, index) => (entry === '-v' ? [argv[index + 1] ?? ''] : []));
}

test('会话 cwd 覆盖 /work；配置里其余挂载（/mnt 只读锚点）保留', () => {
  const configured: readonly SandboxMount[] = [
    { hostPath: 'C:/pentest/project', containerPath: '/work' },
    { hostPath: 'C:/pentest/deliverables', containerPath: '/mnt/engagement', readOnly: true },
  ];
  // ① 有 cwd ⇒ /work 换成人给的目录，其余原样（含只读标记与顺序）
  assert.deepEqual(
    sessionMountsForCwd('C:/some/session-dir', configured),
    [
      { hostPath: 'C:/some/session-dir', containerPath: '/work' },
      { hostPath: 'C:/pentest/deliverables', containerPath: '/mnt/engagement', readOnly: true },
    ],
    '会话 cwd 只覆盖 /work，不得顺手把 /mnt 锚点丢掉（旧实现整份换掉，锚点静默消失）',
  );
  // ② 没 cwd ⇒ 配置原样（回退语义，返回的必须是同一份对象而不是等价副本）
  assert.equal(sessionMountsForCwd(undefined, configured), configured);
  // ③ `/work/` 这种带尾斜杠的写法同样算 /work（否则会出现两个 /work 挂载，后者静默盖前者）
  assert.deepEqual(
    sessionMountsForCwd('/sess', [{ hostPath: 'C:/x', containerPath: '/work/' }]),
    [{ hostPath: '/sess', containerPath: '/work' }],
  );
});

test('四个视图同源：容器 argv 的 -v ↔ workdir 读写根 ↔ 证据落盘根（跨切缝断言）', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'session-mounts-'));
  const anchorDir = mkdtempSync(join(tmpdir(), 'session-anchor-'));
  const configured: readonly SandboxMount[] = [
    { hostPath: 'C:/pentest/project', containerPath: '/work' },
    { hostPath: anchorDir, containerPath: '/mnt/engagement', readOnly: true },
  ];
  const views = sessionMountViews({
    configured,
    // 装配层注入的取法：一个在视图里、一个不在（无 cwd 的会话走配置回退）
    cwdOf: (workerSessionId) => (workerSessionId === 'sess-with-cwd' ? sessionDir : undefined),
    mountsForCwd: (cwd) => sessionMountsForCwd(cwd, configured),
  });

  for (const workerSessionId of ['sess-with-cwd', 'sess-without-cwd']) {
    const mounts = views.mountsForWorker(workerSessionId);
    // ① 容器侧：真正交给 docker 的 argv
    const argv = buildDockerArgs({
      image: IMAGE,
      plan: plan(workerSessionId),
      config: CONFIG,
      containerName: 'c1',
      mounts: views.mountsFor(plan(workerSessionId)),
    });
    const expectedVolumes = mounts.map(
      (mount) =>
        `${norm(mount.hostPath)}:${mount.containerPath ?? '/work'}${mount.readOnly === true ? ':ro' : ''}`,
    );
    assert.deepEqual(
      volumeFlags(argv).map(norm),
      expectedVolumes,
      `容器 argv 必须原样挂上视图给出的列表（${workerSessionId}）`,
    );

    // ② 工具侧：`pentest_workdir` 读写用的根，必须逐项等于容器看到的那份
    const roots = views.workdirRootsFor(workerSessionId);
    assert.deepEqual(
      roots.map((root) => `${norm(root.hostPath)}:${root.containerPath}${root.readOnly === true ? ':ro' : ''}`),
      expectedVolumes,
      `pentest_workdir 的读写根必须与 argv 同源（${workerSessionId}）`,
    );

    // ③ 宿主侧证据落盘根 = 容器里 /work 的宿主路径（证据必须落在容器能看见的那个目录）
    const workMount = mounts.find((mount) => (mount.containerPath ?? '/work') === '/work');
    assert.equal(
      views.evidenceRootFor(workerSessionId),
      workMount?.hostPath,
      `证据落盘根必须等于 /work 的宿主路径（${workerSessionId}）`,
    );
  }

  // ④ 有 cwd 的会话：三处都落在会话目录；无 cwd 的会话：三处都回退到配置目录
  assert.equal(views.evidenceRootFor('sess-with-cwd'), sessionDir);
  assert.equal(views.evidenceRootFor('sess-without-cwd'), 'C:/pentest/project');
  assert.deepEqual(
    views.roots.map((root) => root.containerPath),
    ['/work', '/mnt/engagement'],
    'roots 视图（工具描述用）是配置声明的那份',
  );
});
