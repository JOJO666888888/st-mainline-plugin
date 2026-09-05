/**
 * tests/handoff.test.ts — 立纲转交指令渲染与文件名用例（Task 6/7）
 *
 * renderHandoffInstruction / buildHandoffFilename 均为纯函数，覆盖：
 * 开头用户意图句、全书方向字段值、卷序列各分项、结尾结构约束（卷数与
 * 禁止翻牌），以及文件名的角色名 / .md 后缀 / 非法字符替换。
 */
import { describe, it, expect } from 'vitest';
import {
  renderHandoffInstruction,
  buildHandoffFilename,
} from '../src/core/handoff';
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

describe('renderHandoffInstruction 开头与全书方向', () => {
  it('开头包含用户意图句，提示严格照此立纲', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('请采用以下主线设计为当前角色创建可长期游玩的完整故事总纲');
    expect(doc).toContain('严格照此立纲');
  });

  it('包含全书方向标题与三个要素字段值', () => {
    const d = makeDesign();
    const doc = renderHandoffInstruction(d);
    expect(doc).toContain('## 全书方向');
    expect(doc).toContain(d.story.title);
    expect(doc).toContain(d.story.direction);
    expect(doc).toContain(d.story.escalation);
    expect(doc).toContain(d.story.withheld);
  });
});

describe('renderHandoffInstruction 卷序列分项', () => {
  it('每卷含标题、叙事职责、底牌、阶段范围、持续经营线与兑现目标', () => {
    const d = makeDesign();
    const doc = renderHandoffInstruction(d);
    expect(doc).toContain('## 卷序列');
    d.volumes.forEach((v) => {
      expect(doc).toContain(v.title);
      expect(doc).toContain(v.narrativeRole);
      expect(doc).toContain(v.direction);
      expect(doc).toContain(v.withheld);
      expect(doc).toContain(`${v.targetStageRange.min}–${v.targetStageRange.max}`);
      v.sustainingThreads.forEach((t) => expect(doc).toContain(t));
      v.payoffTargets.forEach((p) => expect(doc).toContain(p));
    });
  });

  it('排出卷编号（第 N 卷）', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('第 1 卷');
    expect(doc).toContain('第 2 卷');
  });
});

describe('renderHandoffInstruction 结尾结构约束', () => {
  it('包含卷数保持 3 到 8 的约束', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('卷数保持 3 到 8');
    // 各卷均planned、首卷active面向 arc-architect 的约束
    expect(doc).toContain('active');
    expect(doc).toContain('planned');
  });

  it('包含禁止提前翻开底牌的约束', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('禁止提前翻开任何卷的底牌');
  });

  it('包含三向自洽与阶段目标只能落在当前 active 卷台阶内的约束', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('三向自洽');
    expect(doc).toContain('当前 active 卷的台阶');
  });

  it('声明本设计共 N 卷', () => {
    const doc = renderHandoffInstruction(makeDesign());
    expect(doc).toContain('本设计共 2 卷');
  });
});

describe('buildHandoffFilename', () => {
  it('含角色名与 .md 后缀', () => {
    const name = buildHandoffFilename(makeDesign());
    expect(name).toContain('主线-立纲要求-测试角色');
    expect(name.endsWith('.md')).toBe(true);
  });

  it('非法文件名字符被替换为下划线', () => {
    const d = makeDesign({ characterRef: { name: '阿:莎/神*?",<>|卡', materialTokenEstimate: 1, generatedAt: 'x' } });
    const name = buildHandoffFilename(d);
    expect(name).toContain('阿_莎_神_______卡');
    expect(name).not.toContain('/');
    expect(name).not.toContain('*');
    expect(name).not.toContain(':');
  });

  it('角色名缺省时回落「未命名」', () => {
    const d = makeDesign({ characterRef: { name: '', materialTokenEstimate: 0, generatedAt: '' } });
    const name = buildHandoffFilename(d);
    expect(name).toContain('主线-立纲要求-未命名');
  });
});