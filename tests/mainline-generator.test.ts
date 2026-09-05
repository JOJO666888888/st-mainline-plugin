/**
 * tests/mainline-generator.test.ts — 主线设计生成与修补闭环用例（Task 4/7）
 *
 * generateMainline 通过注入 fake fetch（opts.fetchImpl）覆盖 LLM 调用，不真实发包：
 *   - buildMainlinePrompt：system/user 非空且带结构契约与卷数区间；
 *   - extractDesignJson：容忍围栏与杂文本，解析失败抛 MAINLINE_INVALID_JSON；
 *   - generateMainline：一次成功、两轮内修补成功、用尽仍失败抛聚合错误。
 */
import { describe, it, expect, vi } from 'vitest';
import type { CharacterMaterial } from '../src/core/material-pack';
import {
  buildMainlinePrompt,
  extractDesignJson,
  generateMainline,
  MainlineGenerationError,
  MAINLINE_INVALID_JSON,
  MAINLINE_VALIDATION_FAILED,
} from '../src/core/mainline-generator';
import {
  validateMainlineDesign,
  MAINLINE_SCHEMA_VERSION,
  type MainlineDesign,
} from '../src/core/mainline-schema';

/** 构造一份材料包 */
function makeMaterial(): CharacterMaterial {
  return {
    name: '沈砚',
    description: '一名出身贫寒却精于算账的年轻商吏，执意查明商路背后的黑手。',
    personality: '冷静沉着，重情义却寡言，对背叛深恶痛绝。',
    scenario: '故事发生在临川城这个商贸重镇。',
    firstMessage: '夜深了，账房里的灯火仍在跳动。',
    worldbookEntries: [{ uid: 1, comment: '开篇设定', content: '临川商会把持货运命脉，暗地里垄断暴利。', tokenEstimate: 0 }],
  };
}

/** fake Response：成功返回给定 content */
function okRes(content: string): any {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

/** 构造一份合法的 MainlineDesign JSON 字符串 */
function validDesignJson(): string {
  const design: MainlineDesign = {
    schemaVersion: MAINLINE_SCHEMA_VERSION,
    characterRef: { name: '沈砚', materialTokenEstimate: 0, generatedAt: '2026-09-04T00:00:00Z' },
    story: {
      id: 'ARC-STORY',
      title: '临川商路寻真',
      direction: '主角追求查明商路黑手，对抗垄断商会，失败将失去立足之地，读者期待最终清算。',
      escalation: '从地方商战推向推翻垄断商会与终局清算。',
      withheld: '终局保留：主角身世与幕后扶持者，末卷前禁止释放。',
    },
    volumes: [
      { id: 'VOL-01', title: '卷一', direction: '立足商行，接首单生意；副线：与掌柜之女建信任；压力：同行暗算。', escalation: '进入→货案危机→揭内鬼→上位并埋第三方势力。', withheld: '本卷不翻身世真相。', narrativeRole: 'setup', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['商行经营权'], payoffTargets: ['识别内鬼'] },
      { id: 'VOL-02', title: '卷二', direction: '追查货案源头；副线：商会内部分裂；压力：垄断商会反击。', escalation: '危机升级→结盟→突破封锁→引出更大势力。', withheld: '不揭示商会后台。', narrativeRole: 'development', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['商行经营权'], payoffTargets: ['挫败商会反击'] },
      { id: 'VOL-03', title: '卷三', direction: '正面对抗垄断商会；副线：身世线浮出；压力：终局清算。', escalation: '高潮清算→不可逆结局→收束全书。', withheld: '终局真相最后释放。', narrativeRole: 'turn', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['身世线'], payoffTargets: ['推翻商会'] },
    ],
  };
  return JSON.stringify(design);
}

describe('buildMainlinePrompt', () => {
  it('system/user 均非空，system 含结构契约，user 含材料包与目标卷数', () => {
    const p = buildMainlinePrompt(makeMaterial(), { volumeCount: 5 });
    expect(p.system.length).toBeGreaterThan(0);
    expect(p.user.length).toBeGreaterThan(0);
    expect(p.system).toContain('MainlineDesign');
    expect(p.system).toContain('3–8 卷');
    expect(p.user).toContain('沈砚');
    expect(p.user).toContain('5');
  });

  it('默认卷数落为 4', () => {
    const p = buildMainlinePrompt(makeMaterial());
    expect(p.system).toContain('共 4 卷');
  });
});

describe('extractDesignJson', () => {
  it('容忍 ```json 围栏与前后杂文本', () => {
    const text = '好的，下面是设计：\n```json\n' + validDesignJson() + '\n```\n希望你喜欢。';
    const d = extractDesignJson(text);
    expect(d.story.id).toBe('ARC-STORY');
    expect(d.volumes.length).toBe(3);
  });

  it('容忍无围栏但被杂文本包裹的裸 JSON', () => {
    const d = extractDesignJson('前缀垃圾 ' + validDesignJson() + ' 后缀');
    expect(validateMainlineDesign(d).ok).toBe(true);
  });

  it('解析失败抛 MAINLINE_INVALID_JSON 且消息带上下文', () => {
    for (const bad of ['', '这不是 JSON', '{"a":', '[1,2,3]']) {
      try {
        extractDesignJson(bad);
        expect.unreachable('应当抛错');
      } catch (e) {
        expect(e).toBeInstanceOf(MainlineGenerationError);
        expect((e as MainlineGenerationError).code).toBe(MAINLINE_INVALID_JSON);
      }
    }
  });
});

describe('generateMainline', () => {
  it('一次成功：attempts=1、repairRounds=0、requiresReview=false', async () => {
    const mock = vi.fn().mockResolvedValue(okRes(validDesignJson()));
    const out = await generateMainline(makeMaterial(), {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(out.attempts).toBe(1);
    expect(out.repairRounds).toBe(0);
    expect(out.requiresReview).toBe(false);
    expect(validateMainlineDesign(out.design).ok).toBe(true);
    // 材料包 name 与 token 估算接入 characterRef
    expect(out.design.characterRef.name).toBe('沈砚');
    expect(out.design.characterRef.materialTokenEstimate).toBeGreaterThan(0);
  });

  it('首轮校验失败，修补一轮后通过：repairRounds=1、requiresReview=true', async () => {
    // 首轮：只有 2 条卷（不合法）→ 触发修补
    const bad = JSON.stringify({ ...JSON.parse(validDesignJson()), volumes: [JSON.parse(validDesignJson()).volumes[0], JSON.parse(validDesignJson()).volumes[1]] });
    const good = validDesignJson();
    const mock = vi.fn().mockResolvedValueOnce(okRes(bad)).mockResolvedValueOnce(okRes(good));
    const out = await generateMainline(makeMaterial(), {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(out.attempts).toBe(2);
    expect(out.repairRounds).toBe(1);
    expect(out.requiresReview).toBe(true);
    expect(validateMainlineDesign(out.design).ok).toBe(true);
  });

  it('修补用尽仍失败抛 MAINLINE_VALIDATION_FAILED 且携带 missingFields', async () => {
    // 首轮 + 两轮修补：持续输出只有 2 条卷的设计，最终仍失败
    const badOnly2 = (): string =>
      JSON.stringify({ ...JSON.parse(validDesignJson()), volumes: JSON.parse(validDesignJson()).volumes.slice(0, 2) });
    const mock = vi
      .fn()
      .mockResolvedValueOnce(okRes(badOnly2()))
      .mockResolvedValueOnce(okRes(badOnly2()))
      .mockResolvedValueOnce(okRes(badOnly2()));

    const err = await generateMainline(makeMaterial(), {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(MainlineGenerationError);
    expect((err as MainlineGenerationError).code).toBe(MAINLINE_VALIDATION_FAILED);
    expect((err as MainlineGenerationError).attempts).toBe(3);
    expect((err as MainlineGenerationError).repairRounds).toBe(2);
    // missingFields 中应包含 vols 属于 volumes 的字段（卷数不足）
    expect((err as MainlineGenerationError).missingFields.length).toBeGreaterThan(0);
    // 消息含中文 + 错误码前缀
    expect((err as MainlineGenerationError).message).toContain(MAINLINE_VALIDATION_FAILED);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('模型输出非法 JSON 也进入修补并在用尽后报校验失败', async () => {
    // 全部三轮都输出非法 JSON（非对象），最终抛错
    const mock = vi.fn().mockResolvedValue(okRes('这不是 JSON'));
    const err = await generateMainline(makeMaterial(), {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MainlineGenerationError);
    expect((err as MainlineGenerationError).code).toBe(MAINLINE_VALIDATION_FAILED);
    expect((err as MainlineGenerationError).repairRounds).toBe(2);
  });
});