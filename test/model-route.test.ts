/**
 * 模型路由的**继承语义**（2026-10-05 人类报障：「我开会话时选的模型和 Agent 用的不一样」）。
 *
 * 根因不是选错了模型，而是**取值的时机**：人类在界面里选的模型是活的，而插件加载时
 * 取一次快照，之后每个会话都用那个旧值。这类故障的表现很隐蔽——不报错，只是所有 Agent
 * 一直用老模型跑，账单与效果都对不上。
 *
 * 因此这里钉住三条：① 函数形式每次现取；② 显式配置的值优先（部署要钉死模型时不被带偏）；
 * ③ 宿主服务未就绪时回落内置默认，而不是把空值传下去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultCapabilities } from '../src/workflow/model.ts';

test('模型路由是现取的：人类换模型后，下一个会话立刻用新值', async () => {
  let current: { provider: string; model: string } | undefined = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  };
  const caps = defaultCapabilities(() => current);

  assert.equal((await caps.resolve('intelligence-gathering')).modelRoute.model, 'deepseek-v4-flash');

  // 人类在界面里换了模型——同一个 resolver，下一次必须拿到新值。
  current = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
  assert.equal(
    (await caps.resolve('exploitation')).modelRoute.model,
    'deepseek-v4-pro',
    '第二次必须现取：快照会让「我换了模型但 Agent 还用旧的」',
  );
});

test('显式给了值就以它为准（部署钉死模型时不被界面选择带偏）', async () => {
  const caps = defaultCapabilities({ provider: 'vendor', model: 'pinned-model' });
  assert.deepEqual((await caps.resolve('intelligence-gathering')).modelRoute, {
    provider: 'vendor',
    model: 'pinned-model',
  });
});

test('解析函数取不到值（宿主服务未就绪）时回落内置默认，而不是把空值传下去', async () => {
  const caps = defaultCapabilities(() => undefined);
  const route = (await caps.resolve('intelligence-gathering')).modelRoute;
  assert.equal(route.provider, 'deepseek-official');
  assert.ok(route.model.length > 0);
});
