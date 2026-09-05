/**
 * tests/material-pack.test.ts — 材料包核心逻辑用例（Task 2/7）
 *
 * 只测试 pure 逻辑（estimateTokens / trimMaterialToBudget），不依赖宿主/DOM，
 * 与 host-compat.test.ts 类似地保证纯函数可测。
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, trimMaterialToBudget, CharacterMaterial } from '../src/core/material-pack';

describe('estimateTokens 中英文混合估算', () => {
  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯英文文本估算非负且合理', () => {
    const tokens = estimateTokens('Hello world, this is a reasonably long English sentence.');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('中英文混合估算非负且合理', () => {
    const tokens = estimateTokens('你好，世界。Hello world 这是混合内容，testing mixed text 2024。');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('纯中文估算约每 1.5 字约 1 token（向上取整）', () => {
    // 纯中文串（含中文标点），不含任何拉丁字符
    const text = '这是一个用于测试的中文句子，通过反复拼接来验证中文估算的启发式，确保结果合理并且非负。'.repeat(20);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    // 每个字符都按 CJK（1/1.5 token/字）折算，因此 tokens == ceil(字长 / 1.5)
    expect(tokens).toBe(Math.ceil(text.length / 1.5));
  });
});

describe('trimMaterialToBudget 优先级裁剪', () => {
  /** 构造一份人设较全、含两条世界书 + 开场白的材料 */
  function makeMaterial(): CharacterMaterial {
    return {
      name: '测试角色',
      description: '这是一段相当长的角色描述，用于讲述角色基本设定、背景来历与性格细节，以便占用可观的 token 估算值。',
      personality: '性格温柔待人友善，喜欢帮助别人，同时偶尔会有些害羞内敛，不擅长拒绝别人的请求。',
      scenario: '故事发生在与世隔绝的偏远小镇，外界联系稀少。',
      firstMessage: '你醒来时，我已静静等候了许久。欢迎来到小镇。',
      worldbookEntries: [
        { uid: 1, comment: '世界背景', content: '这个小镇的历史悠久，坐落于深山之中，与世隔绝，居民世代以务农为生。', tokenEstimate: 0 },
        { uid: 2, comment: '人物设定', content: '镇上的居民各有秘密，旅人的到来往往会打破长久的平静，带来一连串的变故。', tokenEstimate: 0 },
      ],
    };
  }

  it('无穷大预算不裁剪任何内容', () => {
    const m = makeMaterial();
    m.worldbookEntries.forEach((e) => (e.tokenEstimate = estimateTokens(e.content)));
    const before = JSON.stringify(m);

    const out = trimMaterialToBudget(m, Infinity);
    expect(out.name).toBe(m.name);
    expect(out.description).toBe(m.description);
    expect(out.personality).toBe(m.personality);
    expect(out.scenario).toBe(m.scenario);
    expect(out.firstMessage).toBe(m.firstMessage);
    expect(out.worldbookEntries.length).toBe(m.worldbookEntries.length);
    expect(out.worldbookEntries[0].content).toBe(m.worldbookEntries[0].content);
    expect(JSON.stringify(out)).toBe(before);
    // 不修改入参对象
    expect(JSON.stringify(m)).toBe(before);
  });

  it('预算足够时保留全部内容', () => {
    const m = makeMaterial();
    m.worldbookEntries.forEach((e) => (e.tokenEstimate = estimateTokens(e.content)));
    const fullBudget = estimateTokens(m.name) + estimateTokens(m.description) + estimateTokens(m.personality) +
      estimateTokens(m.scenario) + estimateTokens(m.firstMessage) +
      m.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);

    const out = trimMaterialToBudget(m, fullBudget);
    expect(out.firstMessage).toBe(m.firstMessage);
    expect(out.worldbookEntries.length).toBe(2);
    expect(out.worldbookEntries.every((e) => e.content.length > 0)).toBe(true);
  });

  it('预算不足时丢弃低优先开场白与世界书，保留高优先人设核心', () => {
    const m = makeMaterial();
    m.worldbookEntries.forEach((e) => (e.tokenEstimate = estimateTokens(e.content)));

    // 预算仅够：人设核心 + 场景（不含开场白与世界书）
    const budget =
      estimateTokens(m.name) + estimateTokens(m.description) + estimateTokens(m.personality) + estimateTokens(m.scenario);
    const out = trimMaterialToBudget(m, budget);

    expect(out.firstMessage).toBe(''); // 最低优先级被丢弃
    expect(out.name).toBe(m.name); // 最高优先级核心保留
    expect(out.description).toBe(m.description);
    expect(out.personality).toBe(m.personality);

    // 总占用不超过预算
    const total =
      estimateTokens(out.name) + estimateTokens(out.description) + estimateTokens(out.personality) +
      estimateTokens(out.scenario) + estimateTokens(out.firstMessage) +
      out.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
    expect(total).toBeLessThanOrEqual(budget);
  });

  it('世界书条目过多时被裁减（内容清空但保留 comment 表示已略去）', () => {
    const m = makeMaterial();
    m.worldbookEntries.forEach((e) => (e.tokenEstimate = estimateTokens(e.content)));

    // 预算仅够核心 + 场景，余量不足以容纳任何世界书内容
    const budget =
      estimateTokens(m.name) + estimateTokens(m.description) + estimateTokens(m.personality) + estimateTokens(m.scenario);
    const out = trimMaterialToBudget(m, budget);

    const retainContentCount = out.worldbookEntries.filter((e) => e.content.length > 0).length;
    expect(retainContentCount).toBeLessThan(m.worldbookEntries.length);
    // 被裁减条目仍保留 comment（“已略去”记号不丢失）
    expect(out.worldbookEntries.some((e) => e.content.length === 0 && e.comment.length > 0)).toBe(true);
  });

  it('预算极小（仅够 name）时只保留角色名', () => {
    const m = makeMaterial();
    m.worldbookEntries.forEach((e) => (e.tokenEstimate = estimateTokens(e.content)));

    const budget = estimateTokens(m.name);
    const out = trimMaterialToBudget(m, budget);

    expect(out.name).toBe(m.name);
    expect(out.firstMessage).toBe('');
    const total =
      estimateTokens(out.name) + estimateTokens(out.description) + estimateTokens(out.personality) +
      estimateTokens(out.scenario) + estimateTokens(out.firstMessage) +
      out.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
    expect(total).toBeLessThanOrEqual(budget);
  });
});