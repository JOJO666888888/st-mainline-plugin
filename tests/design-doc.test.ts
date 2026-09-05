/**
 * tests/design-doc.test.ts — 主线设计可读文档渲染用例（Task 5/7）
 *
 * renderDesignDoc 为纯函数，覆盖：角色卡引用、全书方向、卷序列各分项，
 * 以及字段缺省/空数组时的兜底（不抛错）。
 */
import { describe, it, expect } from 'vitest';
import { renderDesignDoc } from '../src/core/design-doc';
import type { MainlineDesign } from '../src/core/mainline-schema';

function makeDesign(overrides: Partial<MainlineDesign> = {}): MainlineDesign {
  return {
    schemaVersion: '1.0.0',
    characterRef: { name: '测试角色', materialTokenEstimate: 120, generatedAt: '2026-01-01T10:00:00.000Z' },
    story: {
      id: 'ARC-STORY',
      title: '黎明挽歌',
      direction: '主角追寻家族真相，对抗伪神，代价是记忆',
      escalation: '战线逐卷扩大，终局粉碎伪神教廷',
      withheld: '主角之死可被「代价」交易的本质',
    },
    volumes: [
      {
        id: 'VOL-01',
        title: '灰烬之城',
        direction: '主角抵达灰烬之城，埋下与旧识的冲突副线，压迫来自教会围城',
        escalation: '中段误以为故人来援，实为诱饵；高潮焚烧贡碑，末尾城门失守',
        withheld: '贡碑之下镇压的初代先祖',
        narrativeRole: 'setup',
        targetStageRange: { min: 6, max: 9 },
        sustainingThreads: ['与旧识的信任危机', '贡碑的秘密'],
        payoffTargets: ['揭露贡碑来路的铺垫'],
      },
      {
        id: 'VOL-02',
        title: '长夜将至',
        direction: '主角率残部突围，副线转向夺取伪神权杖',
        escalation: '中段权杖反噬；高潮重夺城邦，末尾立起新秩序',
        withheld: '伪神本体仍在虚空蛰伏',
        narrativeRole: 'development',
        targetStageRange: { min: 8, max: 12 },
        sustainingThreads: ['泛化同盟的裂痕'],
        payoffTargets: ['夺回城邦'],
      },
    ],
    ...overrides,
  };
}

describe('renderDesignDoc 基本结构', () => {
  it('包含角色卡引用（角色名 + 生成时间）', () => {
    const doc = renderDesignDoc(makeDesign());
    expect(doc).toContain('测试角色');
    expect(doc).toContain('2026-01-01T10:00:00.000Z');
  });

  it('包含全书方向标题与三个要素', () => {
    const d = makeDesign();
    const doc = renderDesignDoc(d);
    expect(doc).toContain('【全书方向】');
    expect(doc).toContain(d.story.title);
    expect(doc).toContain(d.story.direction);
    expect(doc).toContain(d.story.escalation);
    expect(doc).toContain(d.story.withheld);
  });

  it('包含卷序列及各卷分项', () => {
    const d = makeDesign();
    const doc = renderDesignDoc(d);
    expect(doc).toContain('【卷序列】');
    // 每卷：标题、叙事职责、阶段预期 min–max、目标/行动/副线/压力、底牌、经营线、兑现目标
    d.volumes.forEach((v) => {
      expect(doc).toContain(v.title);
      expect(doc).toContain(v.narrativeRole);
      expect(doc).toContain(`${v.targetStageRange.min} – ${v.targetStageRange.max}`);
      expect(doc).toContain(v.direction);
      expect(doc).toContain(v.withheld);
      v.sustainingThreads.forEach((t) => expect(doc).toContain(t));
      v.payoffTargets.forEach((p) => expect(doc).toContain(p));
    });
  });

  it('排出卷编号（第 N 卷）', () => {
    const doc = renderDesignDoc(makeDesign());
    expect(doc).toContain('第 1 卷');
    expect(doc).toContain('第 2 卷');
  });

  it('角色名缺省时用占位文案（不抛错）', () => {
    const d = makeDesign({ characterRef: { name: '', materialTokenEstimate: 0, generatedAt: '' } });
    const doc = renderDesignDoc(d as MainlineDesign);
    expect(doc).toContain('（未命名）');
    expect(doc).toContain('（未知）');
  });

  it('空 volumes / 缺失字段时兜底为「无」且不抛错', () => {
    const d = makeDesign({
      volumes: [
        {
          ...(makeDesign().volumes[0] as NonNullable<MainlineDesign['volumes']>[number]),
          sustainingThreads: [],
          payoffTargets: [],
          title: '',
          direction: '',
          withheld: '',
        },
      ],
    });
    const doc = renderDesignDoc(d);
    expect(doc).toContain('（无）');
    expect(doc).toContain('未命名');
  });

  it('完全空对象也不抛错', () => {
    const doc = renderDesignDoc({} as unknown as MainlineDesign);
    expect(typeof doc).toBe('string');
    expect(doc.length).toBeGreaterThan(0);
  });
});