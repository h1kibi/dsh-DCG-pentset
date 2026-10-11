/**
 * 证据落盘（`src/tools/evidence-sink.ts`）的回归锁。
 *
 * 为什么单独锁：文件名两段来自**目标**与**模型给的 purpose**——直接当文件名会带来
 * 路径穿越与非法字符；而"写盘失败不得把已执行的动作报成失败"是它唯一的行为约定
 * （写成失败会让模型重发命令＝对目标再打一次）。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { evidenceRelPath, slugForFileName, utcStamp, writeEvidence, writesIntoMount } from '../src/tools/evidence-sink.ts';

test('文件名片段只留白名单字符，中文等一律折叠（不出现路径分隔符与点号连排）', () => {
  assert.equal(slugForFileName('47.109.76.66'), '47.109.76.66');
  assert.equal(slugForFileName('只读登录核验：25/110/143 三方对话') !== '', true);
  assert.equal(slugForFileName('../../etc/passwd').includes('..'), false);
  assert.equal(slugForFileName('../../etc/passwd').includes('/'), false);
  assert.equal(slugForFileName('a b\tc'), 'a-b-c');
  assert.equal(slugForFileName('///'), 'unnamed');
  assert.equal(slugForFileName('x'.repeat(200)).length <= 48, true);
});

test('时间戳与相对路径：UTC、无冒号（Windows 文件名合法）、以 evidence/ 开头', () => {
  const at = new Date('2026-10-08T12:01:23.456Z');
  assert.equal(utcStamp(at), '2026-10-08T1201Z');
  const rel = evidenceRelPath({ targetSelector: '47.109.76.66', purpose: '端口与协议核实', at });
  assert.equal(rel.startsWith('evidence/47.109.76.66/'), true);
  assert.equal(rel.endsWith('.txt'), true);
  assert.equal(rel.includes(':'), false);
  assert.equal(rel.includes('..'), false);
});

test('写盘：建目录、落内容；越界路径被拒；写不进去只报失败、不抛', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-sink-'));
  const rel = evidenceRelPath({
    targetSelector: '10.0.0.1',
    purpose: 'dialog',
    at: new Date('2026-10-08T00:00:00Z'),
  });
  const written = writeEvidence(root, rel, 'hello\n');
  assert.equal(written.ok, true, written.detail);
  assert.equal(readFileSync(join(root, rel), 'utf8'), 'hello\n');

  // 越界：绝对路径与 `..` 都必须被拒（与 pentest_workdir 的越界校验同源）
  assert.equal(writeEvidence(root, '/etc/passwd', 'x').ok, false);
  assert.equal(writeEvidence(root, '../escape.txt', 'x').ok, false);

  // 写不进去（把"根"指到一个文件上）⇒ 只报失败，绝不抛
  const notADir = join(root, 'a-file');
  writeFileSync(notADir, 'x');
  const failed = writeEvidence(notADir, 'evidence/x/y.txt', 'x');
  assert.equal(failed.ok, false);
  assert.equal(existsSync(join(notADir, 'evidence')), false);
});

test('命令自己写挂载根时不重复落盘：只看**最后一段**简单命令（2026-10-11 操作者实测 #5）', () => {
  // 实况：命令里写了 `/work/evidence/...txt` 的台账，宿主侧又按 `save_stdout_as_evidence`
  // 落一份 ⇒ 每条命令两份近重复文件，而派生那份是用途 slug 的截断（可读性更差）。
  const mount = ['/work'];
  for (const command of [
    'curl -s http://x/ > /work/evidence/a.txt',
    'curl -s http://x/ >> /work/evidence/a.txt',
    'grep -o x /tmp/out | tee /work/evidence/a.txt',
    'grep -o x /tmp/out | tee -a /work/evidence/a.txt',
    "printf 'x' > '/work/evidence/a.txt'",
    'curl -s http://x/ >/work/evidence/a.txt',
  ]) {
    assert.equal(writesIntoMount(command, mount), true, `应判为"命令自己写了挂载根"：${command}`);
  }
  for (const command of [
    // 中间步骤写临时台账、最后一段才是产物 ⇒ **不能**抑制（安全网正是"忘了写"的场景）
    'curl -s http://x/ > /work/tmp.txt | cat',
    // 写入发生在最后一段**之前**：那份自动副本是命令的**最终 stdout**（与台账不是同一份内容）
    // ⇒ 照旧落盘，不算重复。
    'curl -s http://x/ > /work/evidence/a.txt && echo done',
    'curl -s http://x/ | head -5',
    'grep -o x /tmp/out | tee /tmp/a.txt',
    'ls /work/evidence',
    'cat < /work/evidence/a.txt',
    'curl -s http://x/ > /tmp/a.txt',
  ]) {
    assert.equal(writesIntoMount(command, mount), false, `不得判为"命令自己写了挂载根"：${command}`);
  }
  // 会话挂载可能不是 `/work`（cwd 覆盖），判据跟着挂载走。
  assert.equal(writesIntoMount('curl -s http://x/ > /srv/eng/a.txt', ['/srv/eng']), true);
  assert.equal(writesIntoMount('curl -s http://x/ > /srv/eng/a.txt', ['/work']), false);
});
