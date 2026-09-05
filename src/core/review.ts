/**
 * src/core/review.ts — 主线偏差审视（可选开关，Task 7/7）
 *
 * 职责：把「当前剧情正文尾部」与「主线设计第一卷（或用户指定卷号）」对照，
 * 让 LLM 输出简短审视报告（每卷：符合 / 偏离 / 信息不足 + 一句话说明），
 * 帮助用户决定是重立主线还是让 continuation 修正。
 *
 * 硬性约束：
 *   - 本模块「审视」永远只读：不写入任何聊天数据、不修改主线设计；
 *   - 核心逻辑（extractChatTail / buildReviewPrompt）为纯函数，零宿主依赖；
 *   - runDeviationReview 允许注入 callLLMImpl，便于单测不真实调用 LLM；
 *   - 报告解析尽可宽容：任何怪异的 AI 输出都降级为「信息不足」而非崩溃，
 *     仅当完全无法解析出报告结构时才抛 REVIEW_INVALID_REPORT。
 */
import { loadSettings } from '../shared/settings';
import { callLLMWithRetry } from './llm';
import { renderDesignDoc } from './design-doc';
import type { MainlineDesign, VolumeEntry } from './mainline-schema';

/** 解析报告失败时抛出的错误码 */
export const REVIEW_INVALID_REPORT = 'REVIEW_INVALID_REPORT';

/** 逐卷审视结论（归一化后的三态） */
export type VerdictName = '符合' | '偏离' | '信息不足';

/** 单个卷的审视结论 */
export interface VolumeVerdict {
  volumeIndex: number;
  volumeTitle: string;
  verdict: VerdictName;
  note: string;
}

/** 总结审视报告（含标出本次审的是哪一卷，供 UI 直接展示） */
export interface DeviationReviewReport {
  overall: string;
  verdicts: VolumeVerdict[];
  reviewedVolumeIndex: number;
  reviewedVolumeTitle: string;
}

/** 审视报告解析失败时抛出的错误（携带 code=REVIEW_INVALID_REPORT） */
export class ReviewError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = REVIEW_INVALID_REPORT;
  }
}

/**
 * 从一条楼层对象中归一化出角色；无法归一到 user/assistant 时返回 null。
 * 归一化规则：
 *   - is_user === true       → 'user'
 *   - role === 'user'        → 'user'
 *   - role === 'assistant' / 'system' → 'assistant'
 */
function normalizeRole(item: Record<string, unknown>): 'user' | 'assistant' | null {
  if (item.is_user === true) return 'user';
  const role = typeof item.role === 'string' ? item.role : '';
  if (role === 'user') return 'user';
  if (role === 'assistant' || role === 'system') return 'assistant';
  return null;
}

/**
 * 纯函数：从聊天楼层数组里抽取「尾部 N 条可审视的正文」。
 * 只保留 mes 非空、且可归一到 user/assistant 的楼层（system 且无正文者被过滤），
 * 截取最后 count 条。chat 非法 / 为空 / 无合格楼层时返回 []。
 * @param chat 任意来源的楼层数组（通常来自宿主 ctx.chat）
 * @param count 要抽取的尾部条数（<=0 视作不抽取，返回 []）
 */
export function extractChatTail(chat: unknown, count: number): { role: string; text: string }[] {
  if (!Array.isArray(chat) || !Number.isFinite(count) || count <= 0) return [];
  const result: { role: string; text: string }[] = [];
  for (const itemRaw of chat) {
    if (itemRaw === null || typeof itemRaw !== 'object') continue;
    const item = itemRaw as Record<string, unknown>;
    const role = normalizeRole(item);
    if (!role) continue;
    const mes = typeof item.mes === 'string' ? item.mes.trim() : '';
    if (mes.length === 0) continue;
    result.push({ role, text: mes });
  }
  return result.slice(-count);
}

/** 把当前卷索引规范化到合法下标（非整数 / 越界时回落 0，即第一卷） */
function clampVolumeIndex(index: number, length: number): number {
  return Number.isInteger(index) && index >= 0 && index < length ? index : 0;
}

/**
 * 纯函数：构建「偏差审视」的 system / user 提示词。
 * - system：角色为「主线偏差审查员」，只读，不写正文不改大纲；
 * - user：包含【主线定稿】全文、【当前卷=第 N 卷】、[最近正文尾部]，
 *   并给出只输出指定 JSON 报告（{ verdicts, overall }）的约束。
 * @param design 主线设计（须已通过校验）
 * @param tail   extractChatTail 的输出（最近正文尾部）
 * @param volumeIndex 要审视的卷下标（0-based；越界回落 0）
 */
export function buildReviewPrompt(
  design: MainlineDesign,
  tail: { role: string; text: string }[],
  volumeIndex: number,
): { system: string; user: string } {
  const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
  const idx = clampVolumeIndex(volumeIndex, volumes.length);
  const vol: Partial<VolumeEntry> = volumes[idx] ?? {};
  const volTitle = typeof vol.title === 'string' && vol.title.trim() ? vol.title : `第 ${idx + 1} 卷`;

  const system = [
    '你是主线偏差审查员，长期从事故事主线的贴合度核验。',
    '你只做「只读」审视：对照主线设计与最近正文，判断实际剧情是否贴合当前卷的主线设计。',
    '硬性约束：',
    '  - 你绝不写正文、绝不修改或重写大纲，也不输出任何需要落盘的设计改动；',
    '  - 你只输出一句总体判断 + 逐卷简短结论，供用户决定是否重立主线或让 continuation 修正；',
    '  - 信息不足以判断时，如实标注「信息不足」，绝不臆测硬凑结论。',
  ].join('\n');

  const tailText =
    Array.isArray(tail) && tail.length > 0
      ? tail.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n')
      : '（没有可用的正文尾部）';

  const user = [
    '请对照下面的主线设计与最近正文尾部，审视「当前卷」的贴合情况。',
    '',
    '【主线定稿】',
    renderDesignDoc(design),
    '',
    `【当前卷 = 第 ${idx + 1} 卷《${volTitle}》】`,
    `- 本卷方向（目标/行动/副线/压力）：${typeof vol.direction === 'string' ? vol.direction : ''}`,
    `- 本卷升级与收束：${typeof vol.escalation === 'string' ? vol.escalation : ''}`,
    '',
    '【最近正文尾部】',
    tailText,
    '',
    '【输出要求】',
    '只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），形如：',
    '',
    '{ "verdicts": [{ "volumeIndex": 0, "volumeTitle": "第 N 卷标题", "verdict": "符合|偏离|信息不足", "note": "一句话说明" }], "overall": "一句话总体判断" }',
    '',
    '说明：',
    '- verdicts 为逐卷结论数组，verdict 只能取「符合/偏离/信息不足」三者之一；',
    '- overall 为一句话总体判断（是否贴合、是否建议重立或修正）；',
    '- note 与 overall 都要简短、中文、可读。',
    '请直接输出最终 JSON。',
  ].join('\n');

  return { system, user };
}

/** 归一化 verdict：非法值一律回落为「信息不足」，绝不让渲染/后续逻辑崩溃 */
function normalizeVerdict(v: unknown): VerdictName {
  if (v === '符合' || v === '偏离' || v === '信息不足') return v;
  return '信息不足';
}

/** 从模型文本里切出一个 JSON 对象子串（容忍 ``` 围栏与前后杂文本）；找不到返回 null */
function sliceJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/** 解析模型输出的报告文本为 DeviationReviewReport；无法解析或结构非法时抛 ReviewError */
function parseReport(text: string, idx: number, volTitle: string): DeviationReviewReport {
  const trimmed = text.trim();
  const candidate = sliceJsonObject(trimmed) ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 无法把审视报告解析为 JSON：${why}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 审视报告不是单个 JSON 对象`);
  }
  const obj = parsed as Record<string, unknown>;
  const overall = typeof obj.overall === 'string' ? obj.overall : '';
  const verdictsRaw = obj.verdicts;
  if (!Array.isArray(verdictsRaw)) {
    throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 审视报告缺少 verdicts 数组`);
  }
  const verdicts: VolumeVerdict[] = verdictsRaw.map((r) => {
    const ro = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const vi = Number.isFinite(Number(ro.volumeIndex)) ? Number(ro.volumeIndex) : idx;
    return {
      volumeIndex: vi,
      volumeTitle: typeof ro.volumeTitle === 'string' ? ro.volumeTitle : '',
      verdict: normalizeVerdict(ro.verdict),
      note: typeof ro.note === 'string' ? ro.note : '',
    };
  });
  return {
    overall,
    verdicts,
    reviewedVolumeIndex: idx,
    reviewedVolumeTitle: volTitle,
  };
}

/** runDeviationReview 的调用选项 */
export interface RunDeviationReviewOptions {
  /** 要审视的卷下标（0-based；默认/越界回落 0，即第一卷） */
  volumeIndex?: number;
  /** 可注入的 LLM 调用实现（system, user）=> 回答文本，便于单测；缺省走 callLLMWithRetry */
  callLLMImpl?: (system: string, user: string) => Promise<string>;
}

/**
 * 执行一次主线偏差审视（只读，绝不写数据）：
 *   1. 取最近正文尾部（条数取 settings.reviewTailFloors）；
 *   2. 尾部为空 → 抛错（信息不足，无正文可审）；
 *   3. 用 buildReviewPrompt 构建提示词并调用 LLM（可注入）；
 *   4. 解析报告（容忍围栏与杂文本），非法 verdict 归一化为「信息不足」。
 * @throws {ReviewError} 报告无法解析 / 字段非法（code=REVIEW_INVALID_REPORT）
 * @throws {Error}       尾部无正文（信息不足）
 */
export async function runDeviationReview(
  design: MainlineDesign,
  chat: unknown,
  opts: RunDeviationReviewOptions = {},
): Promise<DeviationReviewReport> {
  const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
  const idx = clampVolumeIndex(opts.volumeIndex ?? 0, volumes.length);
  const volTitleStr =
    typeof volumes[idx]?.title === 'string' && volumes[idx]!.title.trim()
      ? volumes[idx]!.title
      : `第 ${idx + 1} 卷`;

  const count = Number.isFinite(loadSettings().reviewTailFloors)
    ? Math.floor(loadSettings().reviewTailFloors)
    : 12;
  const tail = extractChatTail(chat, count);
  if (tail.length === 0) {
    throw new Error('没有可审视的正文：当前聊天没有 user/assistant 正文楼层（信息不足），无法进行审视。');
  }

  const prompt = buildReviewPrompt(design, tail, idx);
  const impl =
    opts.callLLMImpl ??
    ((system: string, user: string) =>
      callLLMWithRetry(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { temperature: 0 },
      ));
  const raw = await impl(prompt.system, prompt.user);
  return parseReport(raw, idx, volTitleStr);
}