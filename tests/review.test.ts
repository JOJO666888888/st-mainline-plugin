/**
 * tests/review.test.ts — 主线偏差审视用例（Task 7/7）
 *
 * 覆盖：
 *   - extractChatTail：过滤无 mes / system；按 is_user 归一化 role；只取最后 N 条；
 *   - buildReviewPrompt：含设计方向字段与最近正文、卷号标注；
 *   - runDeviationReview：注入假 callLLMImpl 覆盖合法 JSON / 杂文本包裹 / 非法 JSON。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractChatTail,
  buildReviewPrompt,
  runDeviationReview,
  ReviewError,
  REVIEW_INVALID_REPORT,
} from '../src/core/review';
import type { MainlineDesign } from '../src/core/mainline-schema';

/** 构造一份合法的 MainlineDesign */
function makeDesign(): MainlineDesign {
  return {
    schemaVersion: '1.0.0',
    characterRef: { name: '沈砚', materialTokenEstimate: 0, generatedAt: '2026-09-04T00:00:00Z' },
    story: {
      id: 'ARC-STORY',
      title: '临川商路寻真',
      direction: '主角追求查明商路黑手，对抗垄断商会，失败将失去立足之地，读者期待最终清算。',
      escalation: '从地方商战推向推翻垄断商会与终局清算。',
      withheld: '终局保留：主角身世，末卷前禁止释放。',
    },
    volumes: [
      { id: 'VOL-01', title: '卷一：立足', direction: '立足商行，接首单生意；副线：掌柜之女信任；压力：同行暗算。', escalation: '进入→货案危机→揭内鬼→上位并埋第三方势力。', withheld: '不翻身世。', narrativeRole: 'setup', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['商行经营权'], payoffTargets: ['识别内鬼'] },
      { id: 'VOL-02', title: '卷二：追源', direction: '追查货案源头；副线：商会内部分裂；压力：垄断商会反击。', escalation: '危机升级→结盟→突破封锁→引出更大势力。', withheld: '不揭示后台。', narrativeRole: 'development', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['商行经营权'], payoffTargets: ['挫败商会对策'] },
      { id: 'VOL-03', title: '卷三：清算', direction: '正面对抗垄断商会；副线：身世浮出；压力：终局清算。', escalation: '高潮清算→不可逆结局→收束全书。', withheld: '终局真相最后释放。', narrativeRole: 'turn', targetStageRange: { min: 6, max: 9 }, sustainingThreads: ['身世线'], payoffTargets: ['推翻商会'] },
    ],
  };
}

/** 构造一段聊天楼层数组 */
function makeChat(): unknown[] {
  return [
    { role: 'user', is_user: true, name: '用户', mes: '你接手了一家小商行。' },
    { role: 'system', name: '旁白', mes: '（这是开场旁白）' }, // system 有 mes → 归为 assistant
    { role: 'assistant', name: '沈砚', mes: '既是如此，先从查账开始。' },
    { role: 'user', name: '掌柜', mes: '' }, // 无正文 → 过滤
    { role: 'assistant', name: '沈砚', mes: '账目确有蹊跷。' },
  ];
}

/** 合法报告 JSON 字符串 */
function validReportJson(): string {
  return JSON.stringify({
    verdicts: [{ volumeIndex: 0, volumeTitle: '卷一：立足', verdict: '符合', note: '正文与卷一方向一致。' }],
    overall: '大体贴合，可继续推进。',
  });
}

describe('extractChatTail', () => {
  it('只保留 user/assistant 且有正文的楼层，过滤无 mes 与纯填充楼层', () => {
    const tail = extractChatTail(makeChat(), 100);
    // 4 条有正文（user1、system→assistant、assistant、assistant）；user 空正文被过滤
    expect(tail).toHaveLength(4);
    expect(tail[0]).toEqual({ role: 'user', text: '你接手了一家小商行。' });
    // system 有 mes → 归一化为 assistant
    expect(tail[1]).toEqual({ role: 'assistant', text: '（这是开场旁白）' });
  });

  it('只取最后 N 条', () => {
    const tail = extractChatTail(makeChat(), 2);
    expect(tail).toHaveLength(2);
    expect(tail[tail.length - 1].text).toBe('账目确有蹊跷。');
  });

  it('空/非法入参返回空数组', () => {
    expect(extractChatTail(null, 5)).toEqual([]);
    expect(extractChatTail([], 5)).toEqual([]);
    expect(extractChatTail('x', 5)).toEqual([]);
    expect(extractChatTail(makeChat(), 0)).toEqual([]);
    expect(extractChatTail(makeChat(), -1)).toEqual([]);
  });

  it('非法入参元素被安全跳过（不崩溃）', () => {
    const chat = [null, 'junk', { role: 'user', mes: '正文' }, { role: 'narrator', mes: '正文' }];
    const tail = extractChatTail(chat, 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toEqual({ role: 'user', text: '正文' });
  });
});

describe('buildReviewPrompt', () => {
  it('system 声明只读审查角色；user 含设计方向字段与最近正文、卷号标注', () => {
    const design = makeDesign();
    const tail = extractChatTail(makeChat(), 100);
    const p = buildReviewPrompt(design, tail, 0);
    expect(p.system).toContain('主线偏差审查员');
    expect(p.system).toContain('只读');
    // user：包含主线定稿里的方向字段
    expect(p.user).toContain('临川商路寻真');
    expect(p.user).toContain('立足商行');
    // 卷号标注：第一卷
    expect(p.user).toContain('第 1 卷《卷一：立足》');
    expect(p.user).toContain('账目确有蹊跷');
    // 输出要求为 JSON 报告
    expect(p.user).toContain('verdicts');
    expect(p.user).toContain('overall');
  });

  it('越界卷号回落第一卷', () => {
    const p = buildReviewPrompt(makeDesign(), [], 999);
    expect(p.user).toContain('第 1 卷');
  });
});

describe('runDeviationReview', () => {
  it('注入假 callLLMImpl 返回合法 JSON → 解析出 verdicts 与 overall', async () => {
    const impl = vi.fn().mockResolvedValue(validReportJson());
    const report = await runDeviationReview(makeDesign(), makeChat(), { volumeIndex: 0, callLLMImpl: impl });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(report.overall).toBe('大体贴合，可继续推进。');
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0].verdict).toBe('符合');
    expect(report.verdicts[0].volumeIndex).toBe(0);
    expect(report.reviewedVolumeIndex).toBe(0);
    expect(report.reviewedVolumeTitle).toBe('卷一：立足');
  });

  it('容忍围栏与前后杂文本包裹的 JSON', async () => {
    const text = '好的，审视结论如下：\n```json\n' + validReportJson() + '\n```\n如有需要可让 continuation 修正。';
    const impl = vi.fn().mockResolvedValue(text);
    const report = await runDeviationReview(makeDesign(), makeChat(), { callLLMImpl: impl });
    expect(report.overall).toBe('大体贴合，可继续推进。');
  });

  it('非法 verdict 值归一化为「信息不足」而不崩溃', async () => {
    const text = JSON.stringify({
      verdicts: [{ volumeIndex: 0, volumeTitle: '卷一：立足', verdict: '离谱', note: 'x' }],
      overall: 'o',
    });
    const impl = vi.fn().mockResolvedValue(text);
    const report = await runDeviationReview(makeDesign(), makeChat(), { callLLMImpl: impl });
    expect(report.verdicts[0].verdict).toBe('信息不足');
  });

  it('非法 JSON → 抛带 code=REVIEW_INVALID_REPORT 的错误', async () => {
    const impl = vi.fn().mockResolvedValue('这不是 JSON');
    const err = await runDeviationReview(makeDesign(), makeChat(), { callLLMImpl: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect((err as ReviewError).code).toBe(REVIEW_INVALID_REPORT);
  });

  it('报告缺少 verdicts 数组 → 抛 REVIEW_INVALID_REPORT', async () => {
    const impl = vi.fn().mockResolvedValue(JSON.stringify({ overall: 'o' }));
    const err = await runDeviationReview(makeDesign(), makeChat(), { callLLMImpl: impl }).catch((e) => e);
    expect((err as ReviewError).code).toBe(REVIEW_INVALID_REPORT);
  });

  it('无正文楼层 → 抛信息不足错误（不调用 LLM）', async () => {
    const impl = vi.fn();
    await expect(runDeviationReview(makeDesign(), [], { callLLMImpl: impl })).rejects.toThrow(/信息不足/);
    expect(impl).not.toHaveBeenCalled();
  });
});