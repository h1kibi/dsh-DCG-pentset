/**
 * 账本记账一致性（§5.4 的版本推进口径）。
 *
 * ── 为什么需要这道棘轮 ──
 *
 * §5.4 要求「每次转移都推进状态版本」。**反过来不成立**：Agent 提交报告、intake 暂存、
 * 审批模式切换都会推进版本却不写转移行（各自的理由见 `transition-table.ts` 的登记表）。
 * 缺一张登记表时，这种推进是**静默**的——评审时看不出来，等到回放账本时才会发现
 * 「版本跳了但没有对应行」，而那时已经无从判断是设计如此还是漏记。
 *
 * 因此：全仓扫描 `state_version` 的赋值点，每个点必须带 tag——
 * `version-bump-sanctioned:transition`（转移事务内）或在 `NON_TRANSITION_VERSION_BUMPS`
 * 里登记的 id。新增一处漏记账的推进，本文件红。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  NON_TRANSITION_VERSION_BUMP_IDS,
  NON_TRANSITION_VERSION_BUMPS,
} from '../src/workflow/transition-table.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * `state_version` 的**赋值**（不是读取、不是比较）。
 *
 * 比较式（`where id = $1 and state_version = $2`）靠**负向后顾**排除：赋值的前面不会紧跟
 * `and` / `where` / `or`。早先的写法是「整行出现 where/and/or 就跳过」——那会把
 * `update ... set a = 1, state_version = $2 where id = ...` 这种单行 SQL 静默漏掉，
 * 而漏掉一个赋值点等于棘轮上有个洞。因此本文件末尾有一条**针对检测器自身**的用例。
 */
const WRITE = /(?<!\b(?:and|where|or)\s)state_version\s*=\s*(?!=)/;
/** 允许的两种 tag：转移内推进，或登记表里的非转移推进。 */
const TAG = /version-bump-(sanctioned|registered):([a-z-]+)/;
/** tag 必须出现在赋值点上方这几行内（注释 + 多行 SQL 模板，实测最长 9 行）。 */
const TAG_LOOKBACK = 12;

interface WriteSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface TagSite {
  readonly file: string;
  readonly id: string;
  readonly kind: string;
}

function collectWrites(): { readonly writes: readonly WriteSite[]; readonly tags: readonly TagSite[] } {
  const writes: WriteSite[] = [];
  const tags: TagSite[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const relative = path.relative(path.join(HERE, '..'), file).split(path.sep).join('/');
    lines.forEach((text, index) => {
      if (WRITE.test(text)) writes.push({ file: relative, line: index + 1, text: text.trim() });
    });
    // tag 单独扫一遍（登记项声明的文件里必须真的能找到它）。
    for (const text of lines) {
      const matched = TAG.exec(text);
      if (matched !== null) tags.push({ file: relative, id: matched[2] ?? '', kind: matched[1] ?? '' });
    }
  }
  return { writes, tags };
}

describe('版本推进的记账棘轮（§5.4）', () => {
  const { writes, tags } = collectWrites();

  it('每个 state_version 赋值点都带登记 tag', () => {
    const offenders: string[] = [];
    for (const write of writes) {
      const lines = readFileSync(path.join(HERE, '..', write.file), 'utf8').split(/\r?\n/);
      const from = Math.max(0, write.line - 1 - TAG_LOOKBACK);
      const context = lines.slice(from, write.line).join('\n');
      if (!TAG.test(context)) offenders.push(`${write.file}:${write.line} — ${write.text}`);
    }
    assert.deepEqual(
      offenders,
      [],
      '这些 state_version 推进没有登记：要么把推进放进转移事务（version-bump-sanctioned:transition），' +
        '要么在 transition-table.ts 的 NON_TRANSITION_VERSION_BUMPS 里登记理由并加上对应 tag。',
    );
  });

  it('登记表的每一项都在源码里找得到，且文件与声明一致', () => {
    for (const entry of NON_TRANSITION_VERSION_BUMPS) {
      const hit = tags.find((tag) => tag.id === entry.id && tag.kind === 'registered');
      assert.ok(hit !== undefined, `登记项 ${entry.id} 在源码里没有任何 version-bump-registered tag`);
      assert.equal(hit.file, entry.file, `登记项 ${entry.id} 声明的文件与实际 tag 位置不一致`);
    }
    // 反向：源码里的 registered tag 必须都在登记表内（防「加了 tag 忘了登记理由」）。
    const known = new Set(NON_TRANSITION_VERSION_BUMP_IDS);
    for (const tag of tags) {
      if (tag.kind !== 'registered') continue;
      assert.ok(known.has(tag.id), `源码里的 version-bump-registered:${tag.id} 不在登记表内`);
    }
  });

  it('转移内的推进确实存在（否则这条棘轮可能被整体删空）', () => {
    const sanctioned = tags.filter((tag) => tag.kind === 'sanctioned' && tag.id === 'transition');
    assert.ok(
      sanctioned.length >= 4,
      `version-bump-sanctioned:transition 至少应覆盖 4 处（updateEngagement / 运行标记 / resume / 范围确认），实际 ${sanctioned.length} 处`,
    );
  });

  it('登记项本身形状合规（id 唯一、理由非空）', () => {
    assert.equal(new Set(NON_TRANSITION_VERSION_BUMP_IDS).size, NON_TRANSITION_VERSION_BUMPS.length);
    for (const entry of NON_TRANSITION_VERSION_BUMPS) {
      assert.ok(entry.reason.trim().length >= 10, `${entry.id} 的理由太短，等于没写`);
      assert.ok(entry.file.startsWith('src/'), `${entry.id} 的 file 应是仓库相对路径`);
    }
  });
});

describe('检测器自身：赋值与比较必须能分开（棘轮不能有洞）', () => {
  it('三种实测的赋值形态都能认出（含单行 SQL：where 与赋值同行）', () => {
    for (const line of [
      '                state_version = state_version + 1,',
      '              state_version = $10,',
      "`update pentest.engagements set status = 'running', state_version = $2, updated_at = now()",
      'set a = 1, state_version = $3, updated_at = now() where id = $1::uuid', // 单行 SQL：旧写法会漏
      'state_version = 0',
    ]) {
      assert.equal(WRITE.test(line), true, `应识别为赋值：${line}`);
    }
  });

  it('读取与比较不得被误判（否则每个查询都要挂 tag）', () => {
    for (const line of [
      '        where id = $1::uuid and state_version = $2`,',
      'and state_version=$2',
      "select id, status, current_status, state_version, graph_iteration",
      "      stateVersion: toInt(row.state_version, 'state_version'),",
      'if (actual !== expected) { /* stale_state_version */ }',
      "  'stale_state_version',",
      ") === row.state_version",
    ]) {
      assert.equal(WRITE.test(line), false, `不该识别为赋值：${line}`);
    }
  });

  it('真实源码里的赋值点数量与登记 + tag 齐平（多了会红，少了说明检测器退化了）', () => {
    const { writes } = collectWrites();
    // 7 处：pg-worker-tools 报告 1、updateEngagement 1、运行标记 1、策略切换 1、
    // intake 暂存 1、范围确认 1、resume 1。数字变了就要在这里解释——防止检测器
    // 因为一次正则改动而「什么都扫不到」还保持全绿。
    assert.equal(writes.length, 7, `实际扫到 ${writes.length} 处：${writes.map((w) => `${w.file}:${w.line}`).join('、')}`);
  });
});
