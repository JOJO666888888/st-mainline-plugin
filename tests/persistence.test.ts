/**
 * tests/persistence.test.ts — 主线设计持久化与写回用例（Task 5/7）
 *
 * 覆盖：
 *   - 纯函数 applyDesignToMetadata / extractDesignFromMetadata 的写入/读取/往返；
 *   - 宿主薄壳 saveDesignToChat / loadDesignFromChat；写回角色卡 writeBackToCharacter；
 *   - 各类宿主缺省（无 ctx / 无 chat_metadata / 无 characters）的静默降级。
 * 全程不触碰 window/DOM，宿主用注入的假 ctx 模拟。
 */
import { describe, it, expect } from 'vitest';
import {
  STORAGE_NAMESPACE,
  applyDesignToMetadata,
  extractDesignFromMetadata,
  saveDesignToChat,
  loadDesignFromChat,
  writeBackToCharacter,
} from '../src/core/persistence';
import type { MainlineDesign } from '../src/core/mainline-schema';

/** 生成一组合法（>=3 卷，通过校验）的卷台阶 */
function makeVolumes(): MainlineDesign['volumes'] {
  return [
    {
      id: 'VOL-01',
      title: '第一卷',
      direction: '主角离开家乡',
      escalation: '进入冒险并埋下伏笔',
      withheld: '隐藏的身世',
      narrativeRole: 'setup',
      targetStageRange: { min: 6, max: 9 },
      sustainingThreads: ['与伙伴的羁绊'],
      payoffTargets: ['揭晓身份的铺垫'],
    },
    {
      id: 'VOL-02',
      title: '第二卷',
      direction: '主角追查线索',
      escalation: '冲突升级',
      withheld: '幕后真凶',
      narrativeRole: 'development',
      targetStageRange: { min: 8, max: 12 },
      sustainingThreads: ['与伙伴的羁绊'],
      payoffTargets: ['查明真凶方向'],
    },
    {
      id: 'VOL-03',
      title: '第三卷',
      direction: '主角直面幕后',
      escalation: '高潮收束',
      withheld: '终局底牌',
      narrativeRole: 'payoff',
      targetStageRange: { min: 10, max: 14 },
      sustainingThreads: ['与伙伴的羁绊'],
      payoffTargets: ['了结身世之谜'],
    },
  ];
}

/** 构造一份合法（通过 validateMainlineDesign）的设计对象 */
function makeDesign(overrides: Partial<MainlineDesign> = {}): MainlineDesign {
  return {
    schemaVersion: '1.0.0',
    characterRef: { name: '测试角色', materialTokenEstimate: 120, generatedAt: '2026-01-01T00:00:00.000Z' },
    story: {
      id: 'ARC-STORY',
      title: '全书方向',
      direction: '主角追求真相',
      escalation: '冲突逐卷升级至终局',
      withheld: '大反派的身份',
    },
    volumes: makeVolumes(),
    ...overrides,
  };
}

describe('applyDesignToMetadata / extractDesignFromMetadata 纯函数', () => {
  it('空 extensions（undefined）也能写入并读回', () => {
    const design = makeDesign();
    const out = applyDesignToMetadata(undefined, design);
    expect(out[STORAGE_NAMESPACE]).toEqual({ mainlineDesign: design });
    const back = extractDesignFromMetadata(out);
    expect(back).toEqual(design);
  });

  it('在既有 extensions 上写入并保留其他命名空间字段', () => {
    const design = makeDesign();
    const extensions = { other_plugin: { x: 1 } } as Record<string, unknown>;
    const out = applyDesignToMetadata(extensions, design);
    expect(out.other_plugin).toEqual({ x: 1 });
    expect(extractDesignFromMetadata(out)).toEqual(design);
  });

  it('重复写入只更新 mainlineDesign，不覆盖 st_mainline 段的其他字段', () => {
    const design = makeDesign();
    const out0 = applyDesignToMetadata(undefined, design);
    // 在 st_mainline 段额外塞一个字段后再次写入
    (out0[STORAGE_NAMESPACE] as Record<string, unknown>).extra = 'keep-me';
    const out1 = applyDesignToMetadata(out0, makeDesign({}));
    expect((out1[STORAGE_NAMESPACE] as Record<string, unknown>).extra).toBe('keep-me');
    expect(extractDesignFromMetadata(out1)).toEqual(design);
  });

  it('extractDesignFromMetadata 对垃圾/缺省数据返回 null（不抛错）', () => {
    expect(extractDesignFromMetadata(undefined)).toBeNull();
    expect(extractDesignFromMetadata(null)).toBeNull();
    expect(extractDesignFromMetadata('nope')).toBeNull();
    expect(extractDesignFromMetadata({})).toBeNull();
    // 命名空间存在但 mainlineDesign 非法 → null
    const bad = { [STORAGE_NAMESPACE]: { mainlineDesign: { schemaVersion: 'x' } } };
    expect(extractDesignFromMetadata(bad)).toBeNull();
  });

  it('applyDesignToMetadata 不修改入参对象', () => {
    const design = makeDesign();
    const extensions = { other_plugin: { x: 1 } } as Record<string, unknown>;
    const before = JSON.stringify(extensions);
    applyDesignToMetadata(extensions, design);
    expect(JSON.stringify(extensions)).toBe(before);
  });
});

describe('saveDesignToChat / loadDesignFromChat 宿主薄壳', () => {
  it('写入 chat_metadata.extensions 并触发 saveChatConditional', () => {
    let triggered = 0;
    const ctx: any = {
      chat_metadata: { extensions: {} },
      saveChatConditional: () => (triggered += 1),
    };
    const design = makeDesign();
    const ok = saveDesignToChat(ctx, design);
    expect(ok).toBe(true);
    expect(triggered).toBe(1);
    expect(loadDesignFromChat(ctx)).toEqual(design);
  });

  it('chat_metadata / extensions 不存在时自动创建', () => {
    const ctx: any = { saveChatDebounced: () => undefined };
    const design = makeDesign();
    expect(saveDesignToChat(ctx, design)).toBe(true);
    expect(loadDesignFromChat(ctx)).toEqual(design);
  });

  it('宿主为 null/undefined 时保存失败（返回 false）', () => {
    expect(saveDesignToChat(undefined, makeDesign())).toBe(false);
    expect(saveDesignToChat(null, makeDesign())).toBe(false);
    expect(loadDesignFromChat(undefined)).toBeNull();
  });

  it('无持久化函数也可返回 true（写入已在内存完成）', () => {
    const ctx: any = { chat_metadata: { extensions: {} } };
    expect(saveDesignToChat(ctx, makeDesign())).toBe(true);
  });

  it('loadDesignFromChat 读取非法结构返回 null', () => {
    const ctx: any = { chat_metadata: { extensions: { [STORAGE_NAMESPACE]: { mainlineDesign: { bad: 1 } } } } };
    expect(loadDesignFromChat(ctx)).toBeNull();
  });
});

describe('writeBackToCharacter 写回角色卡', () => {
  it('写入 characters[characterId].extensions 并触发保存', () => {
    let triggered = 0;
    const ctx: any = {
      characterId: '1',
      characters: [{ name: '角色A' }, { name: '角色B' }],
      saveCharacterDebounced: () => (triggered += 1),
    };
    const design = makeDesign();
    expect(writeBackToCharacter(ctx, design)).toBe(true);
    expect(ctx.characters[1].extensions[STORAGE_NAMESPACE]).toEqual(design);
    expect(triggered).toBe(1);
  });

  it('characters 不存在时返回 false', () => {
    const ctx: any = { characterId: 0 };
    expect(writeBackToCharacter(ctx, makeDesign())).toBe(false);
  });

  it('characters 为空数组时返回 false', () => {
    const ctx: any = { characterId: 0, characters: [] };
    expect(writeBackToCharacter(ctx, makeDesign())).toBe(false);
  });

  it('角色对象 extensions 不存在时自动创建', () => {
    const ctx: any = { characterId: 0, characters: [{ name: '角色A' }] };
    const design = makeDesign();
    expect(writeBackToCharacter(ctx, design)).toBe(true);
    expect(ctx.characters[0].extensions[STORAGE_NAMESPACE]).toEqual(design);
  });

  it('宿主为 null 时返回 false', () => {
    expect(writeBackToCharacter(null, makeDesign())).toBe(false);
  });

  it('有 saveCharactersDebounced 时触发它', () => {
    let triggered = 0;
    const ctx: any = {
      characterId: 0,
      characters: [{ name: '角色A' }],
      saveCharactersDebounced: () => (triggered += 1),
    };
    writeBackToCharacter(ctx, makeDesign());
    expect(triggered).toBe(1);
  });
});