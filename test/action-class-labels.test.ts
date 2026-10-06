/**
 * 动作类别的显示名/释义/旧值兼容（唯一出处）的测试。
 *
 * 这里守三类失败：
 *   1. **新增类别忘了起名字** ⇒ 界面与提示词直接吐裸标识符（`exploit_validation`），
 *      人类在审批卡上读到的是内部符号，判断依据被污染；
 *   2. **显示名与执行侧的判定漂移** ⇒ 卡片上写"需要人批"而执行侧其实免批（或反之）。
 *      客户端曾自己抄了一份 `needsPerActionApproval`（硬编码两个类别），与契约是两份事实；
 *   3. **改名伤到历史数据** ⇒ 2026-10-07 把前三个标识符改成行业标准词，而账本里存的是旧值
 *      （`action_class` 有不可变触发器，原地重写会被数据库拒绝）。读侧必须能把旧值归一化，
 *      否则历史行会渲染成裸标识符、旧策略快照会静默少几项。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_CLASSES,
  PER_ACTION_APPROVAL_CLASSES,
  DEFAULT_DISABLED_CLASSES,
  LEGACY_ACTION_CLASS_ALIASES,
  isActionClass,
  normalizeActionClass,
} from '../src/contracts.ts';
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

test('类别名与显示名同源：标识符就是显示名的 snake_case（前三个 2026-10-07 定名）', () => {
  // 一个概念一个名字：卡上写 A、账本里写 B 是这两轮反馈的根源。
  assert.equal(actionClassLabel('passive_collection'), 'Passive Collection');
  assert.equal(actionClassLabel('active_probing'), 'Active Probing');
  assert.equal(actionClassLabel('credentialed_access'), 'Credentialed Access');
  // 其余沿用既有中文标签（操作者裁定"还好"）
  assert.equal(actionClassLabel('exploit_validation'), '利用验证');
  assert.equal(actionClassLabel('lateral_movement'), '横向移动');
});

test('旧标识符读侧兼容：归一化、渲染、判定三条都要通（改名不伤历史数据）', () => {
  assert.deepEqual(LEGACY_ACTION_CLASS_ALIASES, {
    passive_read: 'passive_collection',
    active_discovery: 'active_probing',
    authenticated_read: 'credentialed_access',
  });
  for (const [oldName, newName] of Object.entries(LEGACY_ACTION_CLASS_ALIASES)) {
    // ① 归一化
    assert.equal(normalizeActionClass(oldName), newName);
    // ② 旧值仍被识别（读旧账本/旧策略快照时不能当成未知类别）
    assert.equal(isActionClass(oldName), true, `${oldName} 必须仍被接受`);
    // ③ 渲染成同一个显示名（历史行在控制台上不会退化成裸标识符）
    assert.equal(actionClassLabelSafe(oldName), actionClassLabel(newName as never));
    // ④ 判定与执行侧一致（旧值不能因为改名而变成"免批"）
    assert.equal(needsPerActionApproval(oldName), needsPerActionApproval(newName));
    assert.equal(isAlwaysDenied(oldName), isAlwaysDenied(newName));
  }
  // 新值原样返回；不认识的值也原样返回（显示层不假装知道）
  assert.equal(normalizeActionClass('active_probing'), 'active_probing');
  assert.equal(normalizeActionClass('something_new'), 'something_new');
  assert.equal(isActionClass('something_new'), false);
  assert.equal(actionClassLabelSafe('something_new'), 'something_new');
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
  // 旧值进提示词时按新标识符呈现（写侧只用新值）
  assert.ok(describeActionClasses(['active_discovery']).includes('（active_probing）'));
  // 空集合是合法状态（intake / 无逐条批类别），不能渲染成空串
  assert.equal(describeActionClasses([]).includes('无'), true);
  assert.equal(actionClassNames([]), '（无）');
  assert.equal(actionClassNames(['passive_collection', 'active_probing']), 'Passive Collection、Active Probing');
  assert.equal(actionClassNames(['passive_read']), 'Passive Collection', '旧值列表也渲染成显示名');
});
