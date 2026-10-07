/**
 * 作业目录访问（`pentest_workdir` 的核心）的测试。
 *
 * 这里守的是**一条安全边界**：模型给的路径只能落在配置里显式声明的挂载根内。
 * 越界形态比"忘了校验"更隐蔽——`..` 抵消、前缀同名（`/work` vs `/workx`）、
 * 符号链接指向根外，三种都不报错地读到了别的东西。因此逐条锁住。
 *
 * 背景（2026-10-07 实测的自锁）：空范围作业里 `pentest_exec` 会被 out_of_scope 拒绝，
 * 于是「读作业资料」这条与目标无关的路径必须存在——但它只能是**目录内**的路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listWorkdir,
  readWorkdir,
  writeWorkdir,
  resolveInRoots,
  WorkdirError,
  WORKDIR_READ_LIMIT_BYTES,
  WORKDIR_WRITE_LIMIT_BYTES,
} from '../src/execution/workdir.ts';
import type { WorkdirRoot } from '../src/execution/workdir.ts';

function roots(): { root: WorkdirRoot; dir: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-work-'));
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'));
  writeFileSync(join(outside, 'secret.txt'), '不该读到的内容');
  return { root: { hostPath: dir, containerPath: '/work' }, dir, outside };
}

function expectError(fn: () => unknown, code: string, why: string): void {
  assert.throws(fn, (error: unknown) => error instanceof WorkdirError && error.code === code, why);
}

test('读写往返：列表、读文本、写文件（父目录自动创建）', () => {
  const { root, dir } = roots();
  writeFileSync(join(dir, 'a.md'), '# 资产\n10.0.0.1\n');
  mkdirSync(join(dir, '证据'));

  const listing = listWorkdir([root], '.');
  // 顺序是「稳定排序」而不是契约（locale 会影响中文与 ASCII 的先后），因此按集合断言。
  assert.deepEqual(
    [...listing.entries.map((e) => `${e.name}:${e.type}`)].sort(),
    ['a.md:file', '证据:dir'],
  );

  const file = readWorkdir([root], 'a.md');
  assert.equal(file.text.includes('10.0.0.1'), true);
  assert.equal(file.truncated, false);
  assert.equal(file.binary, false);
  // 容器路径与提示词里给的一致（模型在两条通道之间搬运路径时不会错）。
  assert.equal(file.containerPath, '/work/a.md');

  const written = writeWorkdir([root], '报告/阶段一.md', '结论');
  assert.equal(written.bytes, 6);
  assert.equal(readWorkdir([root], '报告/阶段一.md').text, '结论');
});

test('容器路径写法可直接使用（模型常把提示词里的 /work/xxx 原样带进来）', () => {
  const { root, dir } = roots();
  writeFileSync(join(dir, 'x.txt'), 'ok');
  assert.equal(readWorkdir([root], '/work/x.txt').text, 'ok');
  assert.equal(readWorkdir([root], './x.txt').text, 'ok');
});

test('越界一律拒绝：.. 跳出、绝对宿主路径、前缀同名目录', () => {
  const { root, outside } = roots();
  // 兄弟目录（`..` 一跳就到）——这是最容易被忽略的一条。
  writeFileSync(join(outside, 'secret.txt'), 'x');

  expectError(() => resolveInRoots([root], '../dsh-outside-x/secret.txt'), 'outside_roots', '.. 跳出根');
  expectError(() => resolveInRoots([root], 'a/../../x.md'), 'outside_roots', '多级 .. 跳出根');
  expectError(() => resolveInRoots([root], 'C:/Windows/win.ini'), 'bad_path', '绝对宿主路径');
  expectError(() => resolveInRoots([root], '/etc/passwd'), 'bad_path', '/etc/passwd 之类绝对路径');
  // 空路径 = **挂载根本身**（2026-10-07 修正：此前被拒，Agent 必须猜一个 `.` 才列得出根目录）
  assert.equal(resolveInRoots([root], '').rel, '', '空路径就是根');
  assert.equal(resolveInRoots([root], '.').rel, '', '`.` 规范化后就是根（rel 为空串）');
  assert.equal(resolveInRoots([root], '/work').rel, '', '容器路径前缀指向根也合法');
  // `..` 只在根内抵消是**合法**的（不该被误伤）
  assert.equal(resolveInRoots([root], 'a/../b.md').rel, 'b.md');
});

test('符号链接指向根外时拒绝（在根内则放行）', (t) => {
  const { root, dir, outside } = roots();
  writeFileSync(join(outside, 'secret.txt'), '不该读到的内容');
  try {
    symlinkSync(outside, join(dir, 'link-out'));
  } catch {
    t.skip('本机不允许创建符号链接（Windows 需要开发者模式/管理员）');
    return;
  }
  expectError(() => readWorkdir([root], 'link-out/secret.txt'), 'outside_roots', '跟随符号链接读出根外');
});

test('只读根不能写，读写根可以', () => {
  const { root, dir } = roots();
  writeFileSync(join(dir, 'a.md'), 'x');
  const ro: WorkdirRoot = { ...root, readOnly: true };
  expectError(() => writeWorkdir([ro], 'b.md', 'x'), 'read_only', '只读挂载');
  assert.equal(readWorkdir([ro], 'a.md').text, 'x', '只读挂载仍然可读');
});

test('没有挂载根时明确拒绝（不退回 cwd、不猜目录）', () => {
  expectError(() => resolveInRoots([], 'a.md'), 'no_roots', '零挂载');
  expectError(() => listWorkdir([], '.'), 'no_roots', '零挂载下连 list 也不行');
});

test('读取截断与二进制如实标注（不假装读全了）', () => {
  const { root, dir } = roots();
  writeFileSync(join(dir, 'big.txt'), 'a'.repeat(WORKDIR_READ_LIMIT_BYTES + 10));
  const big = readWorkdir([root], 'big.txt');
  assert.equal(big.truncated, true);
  assert.equal(Buffer.byteLength(big.text, 'utf8'), WORKDIR_READ_LIMIT_BYTES);

  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  const bin = readWorkdir([root], 'bin.dat');
  assert.equal(bin.binary, true);
  assert.equal(bin.text, '', '二进制不返回正文（避免半个字符与上下文污染）');
});

test('写入有上限，且拒绝把挂载根本身当文件写', () => {
  const { root } = roots();
  expectError(
    () => writeWorkdir([root], 'huge.txt', 'x'.repeat(WORKDIR_WRITE_LIMIT_BYTES + 1)),
    'too_large',
    '超过写入上限',
  );
  expectError(() => writeWorkdir([root], '', 'x'), 'is_dir', '空路径指向挂载根本身，不是文件');
});

test('类型错误如实回报：目录用 read、文件用 list、不存在就用 not_found', () => {
  const { root, dir } = roots();
  writeFileSync(join(dir, 'a.md'), 'x');
  mkdirSync(join(dir, 'sub'));
  expectError(() => readWorkdir([root], 'sub'), 'is_dir', '读目录');
  expectError(() => listWorkdir([root], 'a.md'), 'not_dir', '列文件');
  expectError(() => readWorkdir([root], 'nope.md'), 'not_found', '不存在');
});

test('多根时按相对路径命中（并回报命中的那个根）', () => {
  const a = roots();
  const b = roots();
  writeFileSync(join(b.dir, 'only-b.md'), 'b');
  const both: readonly WorkdirRoot[] = [
    a.root,
    { hostPath: b.dir, containerPath: '/mnt/second' },
  ];
  const file = readWorkdir(both, 'only-b.md');
  assert.equal(file.text, 'b');
  assert.equal(file.containerPath, '/mnt/second/only-b.md');
  // 容器路径前缀也能定位到具体某个根
  assert.equal(readWorkdir(both, '/mnt/second/only-b.md').text, 'b');
});

test('多根 + 写新文件必须带前缀（不替调用方猜写到哪个根）', () => {
  const a = roots();
  const b = roots();
  const both: readonly WorkdirRoot[] = [
    a.root,
    { hostPath: b.dir, containerPath: '/mnt/second' },
  ];
  // 无前缀：拒绝，并且报错里给出可用的前缀
  expectError(() => writeWorkdir(both, '新文件.md', 'x'), 'bad_path', '多根新文件的歧义写入');
  // 带前缀：只写到那个根
  const written = writeWorkdir(both, '/mnt/second/新文件.md', 'x');
  assert.equal(written.containerPath, '/mnt/second/新文件.md');
  assert.equal(readWorkdir([{ hostPath: b.dir, containerPath: '/mnt/second' }], '新文件.md').text, 'x');
  assert.throws(
    () => readWorkdir([{ hostPath: a.dir, containerPath: '/work' }], '新文件.md'),
    '第一个根里不该出现这个文件',
  );
  // 已存在的文件不受该限制（读改写同一个已存在文件是明确的）
  writeFileSync(join(a.dir, 'known.md'), 'k');
  assert.equal(writeWorkdir(both, 'known.md', 'k2').containerPath, '/work/known.md');
});
