/**
 * tests/mainline-schema.test.ts — 主线设计数据结构与严格校验器用例（Task 4/7）
 *
 * 纯函数零依赖，只测 mainline-schema.ts 的导出，不触网。
 */
import { describe, it, expect } from 'vitest';
import {
  MAINLINE_SCHEMA_VERSION,
  validateMainlineDesign,
  describeMissingFields,
  validateVolumeCount,
  normalizeVolumeCount,
  type MainlineDesign,
  type StoryArcEntry,
  type VolumeEntry,
} from '../src/core/mainline-schema';

/** 构造一条合法的卷 */
function makeVolume(overrides: Partial<VolumeEntry> = {}): VolumeEntry {
  return {
    id: 'VOL-01',
    title: '卷一：锋芒初显',
    direction: '主目标：主角在临川城立足商行；关键行动：接下第一笔风头生意；副线：与掌柜之女建立信任；压力来源：同行妒忌暗算。',
    escalation: '承接开局进入本卷；中段因一桩货案陷入商行信誉危机；高潮当众揭破内鬼兑现期待；结尾主角上位却埋下第三方势力介入的尾巴。',
    withheld: '本卷不得翻出主角身世与身后组织的真相。',
    narrativeRole: 'setup',
    targetStageRange: { min: 6, max: 9 },
    sustainingThreads: ['商行经营权归属', '主角与掌柜之女的关系'],
    payoffTargets: ['识别出内鬼并夺回商行主动权'],
    ...overrides,
  };
}

/** 构造一份完全合法的 MainlineDesign */
function makeValidDesign(): MainlineDesign {
  const story: StoryArcEntry = {
    id: 'ARC-STORY',
    title: '临川商路寻真',
    direction: '主角追求查明商路背后的黑手，对抗垄断商会的既得利益，失败将失去唯一立足与养育之恩的真相，读者期待最终的清算。',
    escalation: '从地方商战逐步推向推翻垄断商会、揭露身世与终局清算。',
    withheld: '终局保留：主角身世与幕后扶持者，全书末卷前禁止释放。',
  };
  return {
    schemaVersion: MAINLINE_SCHEMA_VERSION,
    characterRef: { name: '沈砚', materialTokenEstimate: 1234, generatedAt: '2026-09-04T00:00:00Z' },
    story,
    volumes: [makeVolume(), makeVolume({ id: 'VOL-02', title: '卷二', narrativeRole: 'development' }), makeVolume({ id: 'VOL-03', title: '卷三', narrativeRole: 'turn' })],
  };
}

describe('validateMainlineDesign 顶层', () => {
  it('顶层不是对象返回错误', () => {
    for (const bad of [null, undefined, 42, 'x', []] as unknown[]) {
      const r = validateMainlineDesign(bad);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.path === '$')).toBe(true);
    }
  });

  it('schemaVersion 缺失或版本不符报错', () => {
    const d = makeValidDesign() as unknown as Record<string, unknown>;
    delete d.schemaVersion;
    expect(validateMainlineDesign(d).ok).toBe(false);

    const d2 = makeValidDesign() as unknown as Record<string, unknown>;
    d2.schemaVersion = '9.9.9';
    const r2 = validateMainlineDesign(d2);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.path === 'schemaVersion')).toBe(true);
  });
});

describe('validateMainlineDesign story', () => {
  it('story 为数组（非对象）时打回', () => {
    const d = makeValidDesign() as unknown as { story: unknown };
    d.story = [];
    expect(validateMainlineDesign(d).ok).toBe(false);
  });

  it('story 缺失必填字段报错', () => {
    const d = makeValidDesign() as unknown as { story: Record<string, unknown> };
    d.story.direction = '';
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'story.direction')).toBe(true);
  });
});

describe('validateMainlineDesign volumes', () => {
  it('volumes 非数组报错', () => {
    const d = makeValidDesign() as unknown as { volumes: unknown };
    d.volumes = 'oops';
    expect(validateMainlineDesign(d).ok).toBe(false);
  });

  it('仅 1 卷会打回', () => {
    const d = makeValidDesign();
    d.volumes = [makeVolume()];
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);
    const occasions = r.errors.filter((e) => e.path === 'volumes');
    expect(occasions.length).toBeGreaterThan(0);
    expect(occasions[0].message).toContain('3');
  });

  it('2 卷与 9 卷都不合法（3–8）', () => {
    const two = makeValidDesign();
    two.volumes = [makeVolume(), makeVolume()];
    expect(validateMainlineDesign(two).ok).toBe(false);

    const nine = makeValidDesign();
    nine.volumes = Array.from({ length: 9 }, (_, i) => makeVolume({ id: `VOL-0${i + 1}` }));
    expect(validateMainlineDesign(nine).ok).toBe(false);
  });

  it('targetStageRange min>max 与 min<1 报错', () => {
    const d = makeValidDesign();
    d.volumes[0].targetStageRange = { min: 10, max: 5 };
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'volumes[0].targetStageRange.max')).toBe(true);

    const d2 = makeValidDesign();
    d2.volumes[0].targetStageRange = { min: 0, max: 4 };
    const r2 = validateMainlineDesign(d2);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.path === 'volumes[0].targetStageRange.min')).toBe(true);
  });

  it('sustainingThreads / payoffTargets 至少 1 条且为非空字符串', () => {
    const d = makeValidDesign();
    d.volumes[0].sustainingThreads = [];
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'volumes[0].sustainingThreads')).toBe(true);

    const d2 = makeValidDesign();
    d2.volumes[0].payoffTargets = ['  '];
    const r2 = validateMainlineDesign(d2);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.path === 'volumes[0].payoffTargets[0]')).toBe(true);
  });

  it('卷缺 narrativeRole 报错', () => {
    const d = makeValidDesign();
    d.volumes[0].narrativeRole = '';
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'volumes[0].narrativeRole')).toBe(true);
  });
});

describe('validateMainlineDesign 全合例', () => {
  it('完全合法的设计通过', () => {
    expect(validateMainlineDesign(makeValidDesign()).ok).toBe(true);
  });
});

describe('describeMissingFields 归并', () => {
  it('把 errors 按父路径归并成字段分组', () => {
    const vr = validateMainlineDesign(makeValidDesign());
    // 制造两处问题：story.direction 与 volumes[0].withheld + sustainingThreads
    const d = makeValidDesign();
    d.story.direction = '';
    d.volumes[0].withheld = '';
    d.volumes[0].sustainingThreads = [];
    const r = validateMainlineDesign(d);
    expect(r.ok).toBe(false);

    const groups = describeMissingFields(d, r.errors);
    const storyGroup = groups.find((g) => g.path === 'story');
    expect(storyGroup?.fields).toContain('direction');
    const volGroup = groups.find((g) => g.path === 'volumes[0]');
    expect(volGroup?.fields).toContain('withheld');
    expect(volGroup?.fields).toContain('sustainingThreads');
  });

  it('errors 为空返回空分组', () => {
    expect(describeMissingFields(makeValidDesign(), [])).toEqual([]);
  });
});

describe('validateVolumeCount / normalizeVolumeCount', () => {
  it('validateVolumeCount 3 与 8 合法，其余不合法', () => {
    expect(validateVolumeCount(3)).toBe(true);
    expect(validateVolumeCount(8)).toBe(true);
    expect(validateVolumeCount(2)).toBe(false);
    expect(validateVolumeCount(1)).toBe(false);
    expect(validateVolumeCount(9)).toBe(false);
  });

  it('normalizeVolumeCount 默认 4，按计划档位映射', () => {
    expect(normalizeVolumeCount()).toBe(4);
    expect(normalizeVolumeCount(undefined)).toBe(4);
    expect(normalizeVolumeCount(undefined, 'short')).toBe(3);
    expect(normalizeVolumeCount(undefined, 'medium')).toBe(4);
    expect(normalizeVolumeCount(undefined, 'long')).toBe(6);
  });

  it('custom / 无计划时优先采用合法 requested', () => {
    expect(normalizeVolumeCount(5, 'custom')).toBe(5);
    expect(normalizeVolumeCount(7)).toBe(7);
    expect(normalizeVolumeCount(100, 'custom')).toBe(4);
    expect(normalizeVolumeCount(100)).toBe(4);
  });
});