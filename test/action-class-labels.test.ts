/**
 * 动作类别的显示名/释义（唯一出处）的测试。
 *
 * 这里守两类失败：
 *   1. **新增类别忘了起名字** ⇒ 界面与提示词直接吐裸标识符（`exploit_validation`），
 *      人类在审批卡上读到的是内部符号，判断依据被污染；
 *   2. **显示名与执行侧的判定漂移** ⇒ 卡片上写"需要人批"而执行侧其实免批（或反之）。
 *      客户端此前自己抄了一份 `needsPerActionApproval`（硬编码两个类别），
 *      与契约的 `PER_ACTION_APPROVAL_CLASSES` 是两份事实——本测试钉住"只有一份"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_CLASSES, PER_ACTION_APPROVAL_CLASSES, DEFAULT_DISABLED_CLASSES } from '../src/contracts.ts';
import {
  ACTION_CLASS_LABELS,
  ACTION_CLASS_MEANINGS,
  actionClassLabel,
  actionClassLabelSafe,
  actionClassNames,
  describeActionClasses,
  isAlwaysDenied,
  needsPerActionApproval,
} from '../src/policy/action-class-labels.ts';

test('每个类别都有显示名与释义（新增类别不允许静默漏名）', () => {
  for (const cls of ACTION_CLASSES) {
    assert.ok(ACTION_CLASS_LABELS[cls]?.trim().length > 0, `${cls} 缺显示名`);
    assert.ok(ACTION_CLASS_MEANINGS[cls]?.trim().length > 0, `${cls} 缺释义`);
    // 释义必须说"它意味着什么"，不能只是把名字抄一遍
    assert.notEqual(ACTION_CLASS_MEANINGS[cls].trim(), ACTION_CLASS_LABELS[cls].trim(), `${cls} 的释义等于名字`);
    assert.equal(actionClassLabel(cls), ACTION_CLASS_LABELS[cls]);
  }
  assert.equal(Object.keys(ACTION_CLASS_LABELS).length, ACTION_CLASSES.length, '显示名表不得有清单外的键');
  assert.equal(Object.keys(ACTION_CLASS_MEANINGS).length, ACTION_CLASSES.length, '释义表不得有清单外的键');
});

test('三个改名的类别用约定的专业英文（2026-10-07 与操作者对齐）', () => {
  // 这三个原来叫「被动读取 / 主动发现 / 认证读取」，与它们真正干的事对不上：
  // 前者会向 crt.sh / whois 发包（不是"不发流量"），后者是"用凭据访问"。
  assert.equal(actionClassLabel('passive_read'), 'Passive Collection');
  assert.equal(actionClassLabel('active_discovery'), 'Active Probing');
  assert.equal(actionClassLabel('authenticated_read'), 'Credentialed Access');
  // 其余沿用既有中文标签（操作者裁定"还好"）
  assert.equal(actionClassLabel('exploit_validation'), '利用验证');
  assert.equal(actionClassLabel('lateral_movement'), '横向移动');
});

test('未识别的类别值原样显示，不硬转成某个已知类别', () => {
  // 显示层不该假装知道：把未知值当成已知类别，会让审批卡给出错误的严重度。
  assert.equal(actionClassLabelSafe('something_new'), 'something_new');
  assert.equal(actionClassLabelSafe('passive_read'), 'Passive Collection');
});

test('判定与执行侧同源：不逐条批 / 永不放行两份清单只有一处事实', () => {
  for (const cls of ACTION_CLASSES) {
    assert.equal(
      needsPerActionApproval(cls),
      (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(cls),
      `${cls} 的"逐条人批"判定与契约不一致`,
    );
    assert.equal(
      isAlwaysDenied(cls),
      (DEFAULT_DISABLED_CLASSES as readonly string[]).includes(cls),
      `${cls} 的"永不放行"判定与契约不一致`,
    );
  }
});

test('提示词形态：名字 + 标识符 + 释义都给出（模型要能从名字回到标识符）', () => {
  const text = describeActionClasses(['exploit_validation', 'lateral_movement']);
  assert.ok(text.includes('利用验证'), '要有显示名');
  assert.ok(text.includes('exploit_validation'), '要带上标识符（范围方案里手写的是它）');
  assert.ok(text.includes('自由命令'), 'exploit_validation 的释义必须点明它是任意自由命令');
  assert.ok(text.includes('横向移动（lateral_movement）'), '多个类别逐条给出');
  // 空集合是合法状态（intake / 无逐条批类别），不能渲染成空串
  assert.equal(describeActionClasses([]).includes('无'), true);
  assert.equal(actionClassNames([]), '（无）');
  assert.equal(actionClassNames(['passive_read', 'active_discovery']), 'Passive Collection、Active Probing');
});
