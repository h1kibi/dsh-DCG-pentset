/**
 * 行内 Markdown 渲染器（`src/client/format.ts`）的回归锁。
 *
 * 起因：模型写的便签/摘要/结论天然带 `**粗体**`，而视图当纯文本插值 ⇒ 界面上出现字面的
 * `**零目标动作**`（人类反馈 + 截图，2026-10-07）。修在**渲染边界**，所以这里锁两件事：
 *  1. 标记被吃掉、强调被保留（用 `renderToStaticMarkup` 断言真实输出，而不是断言内部结构）；
 *  2. **模型文本里的 HTML 必须被转义**——渲染器返回的是节点，绝不允许变成可执行标记。
 *
 * 纯文本时返回原字符串（不产生多余节点）；`stripInlineMarkdown` 是"只能是字符串"的出口
 * （`title=`、日志行、导出文件名）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderInlineMarkdown, stripInlineMarkdown } from '../src/client/format.ts';

const html = (text: string): string => renderToStaticMarkup(renderInlineMarkdown(text) as never);

test('行内标记：粗体/代码/斜体被渲染成原生元素，标记本身消失', () => {
  assert.equal(html('**成立**'), '<strong>成立</strong>');
  assert.equal(html('`dsh-4779`'), '<code>dsh-4779</code>');
  assert.equal(html('*未验证*'), '<em>未验证</em>');
  assert.equal(html('前 **中** 后'), '前 <strong>中</strong> 后');
  assert.equal(html('混合 **粗** 与 `码` 与 *斜*'), '混合 <strong>粗</strong> 与 <code>码</code> 与 <em>斜</em>');
});

test('纯文本原样返回（不引入多余包装），未闭合的标记保持字面', () => {
  assert.equal(html('没有任何标记'), '没有任何标记');
  assert.equal(html('**未闭合'), '**未闭合');
  assert.equal(html('**a**b**'), '<strong>a</strong>b**');
});

test('模型文本里的 HTML 必须被转义（渲染器返回节点，不允许变成可执行标记）', () => {
  const markup = html('<img src=x onerror=alert(1)> 与 <script>alert(2)</script>');
  assert.doesNotMatch(markup, /<img|<script/i);
  assert.match(markup, /&lt;img/);
  // 反过来：标记语法里嵌的 HTML 也只当文本
  assert.equal(html('**<b>x</b>**'), '<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
});

test('stripInlineMarkdown：只能是纯文本的出口（title、日志、导出名）', () => {
  assert.equal(stripInlineMarkdown('**零目标动作**'), '零目标动作');
  assert.equal(stripInlineMarkdown('`cdldgdx` 登录 **成功**'), 'cdldgdx 登录 成功');
  assert.equal(stripInlineMarkdown('无标记'), '无标记');
  // strip 之后再截断：星号不占字数、截断位置才正确（便签卡片就是这么用的）
  assert.equal(stripInlineMarkdown('**A组**完成').slice(0, 4), 'A组完成');
});
