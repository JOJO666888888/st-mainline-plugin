/**
 * src/core/mainline-generator.ts — 主线设计生成与修补闭环（Task 4/7）
 *
 * 职责：
 *   1. buildMainlinePrompt：由材料包 + 结构契约（对齐 continuation 卷字段语义）
 *      + 方法论拼装 system/user 两段，要求模型输出单个 JSON 对象（MainlineDesign）。
 *   2. extractDesignJson：容忍 ```json 围栏与前后杂文本的解析。
 *   3. generateMainline：整份生成（callLLMWithRetry）→ 严格校验 → 校验失败则
 *      至多 2 轮修补（把 errors+缺失明细回喂，只要求输出完整修正 JSON）→
 *      用尽仍失败则抛出聚合错误（含 missingFields 明细），交 UI 展示并允许用户手改。
 *
 * 硬性约束：本模块为纯逻辑，不触碰 window/DOM；错误信息为中文并带错误码前缀
 * （MAINLINE_INVALID_JSON / MAINLINE_VALIDATION_FAILED）。
 */
import type { CharacterMaterial } from './material-pack';
import { estimateTokens } from './material-pack';
import { callLLM, callLLMWithRetry } from './llm';
import {
  MAINLINE_SCHEMA_VERSION,
  normalizeVolumeCount,
  validateMainlineDesign,
  describeMissingFields,
  type MainlineDesign,
} from './mainline-schema';
import type { MainlineValidationResult } from './mainline-schema';

/** 校验/解析错误码常量 */
export const MAINLINE_INVALID_JSON = 'MAINLINE_INVALID_JSON';
export const MAINLINE_VALIDATION_FAILED = 'MAINLINE_VALIDATION_FAILED';

/** 修补轮数上限 */
const MAX_REPAIR_ROUNDS = 2;

/**
 * 聚合错误：整体生成（含修补）失败时抛出，携带可供 UI 展示与用户手改的明细。
 */
export class MainlineGenerationError extends Error {
  code: string;
  missingFields: { path: string; fields: string[] }[];
  attempts: number;
  repairRounds: number;
  lastRaw: string;

  constructor(
    code: string,
    message: string,
    extra: {
      missingFields: { path: string; fields: string[] }[];
      attempts: number;
      repairRounds: number;
      lastRaw: string;
    },
  ) {
    super(message);
    this.name = 'MainlineGenerationError';
    this.code = code;
    this.missingFields = extra.missingFields;
    this.attempts = extra.attempts;
    this.repairRounds = extra.repairRounds;
    this.lastRaw = extra.lastRaw;
  }
}

/** generateMainline 的调用选项 */
export interface GenerateMainlineOptions {
  /** 可注入的 fetch 实现（透传给 callLLM，便于单测不真实发包） */
  fetchImpl?: typeof fetch;
  /** 外部 AbortSignal（透传给 callLLM） */
  signal?: AbortSignal;
  /** 目标卷数（可选，透传给提示词；默认按 normalizeVolumeCount 回落） */
  volumeCount?: number;
  /** 计划档位（可选，透传给提示词） */
  plan?: 'short' | 'medium' | 'long' | 'custom';
}

/**
 * 拼装「生成主线设计」的 system / user 提示词。
 * - system：方法论 —— 卷数区间、卷间序列三向自洽、卷内 direction/escalation/withheld
 *   的写法义务、禁止自创角色卡外实体、输出纯 JSON 单个对象。
 * - user：注入角色卡材料包 + 目标卷数 + MainlineDesign 结构契约。
 */
export function buildMainlinePrompt(
  material: CharacterMaterial,
  opts: { volumeCount?: number; plan?: 'short' | 'medium' | 'long' | 'custom' } = {},
): { system: string; user: string } {
  const volumeCount = normalizeVolumeCount(opts.volumeCount, opts.plan);
  const materialJson = JSON.stringify(
    {
      name: material.name,
      description: material.description,
      personality: material.personality,
      scenario: material.scenario,
      firstMessage: material.firstMessage,
      worldbookEntries: material.worldbookEntries.map((e) => ({
        uid: e.uid,
        comment: e.comment,
        content: e.content,
      })),
    },
    null,
    2,
  );

  const system = [
    '你是一名金丝雀级的长篇故事主线总纲设计师（对应 shujuku continuation 的 arc-architect）。',
    '你只依据注入的角色卡材料包设计长期主线，绝不臆造材料之外的人物、组织、地点、能力或事件实体。',
    '你的产物是《主线设计》，一个固定的 JSON 对象（MainlineDesign），包含：',
    '  1. story —— 一条全书方向（全局仅一条）。要写清：主角长期目标、为何必须追求、核心对抗、失败会失去什么、读者核心期待与终局保留。',
    '  2. volumes —— 若干卷台阶，把全书方向拆成可持续展开、彼此因果承接、功能不重复的长程结构。',
    '卷数要求：共 ${VOLUME_COUNT} 卷（3–8 卷；仅 1 卷或不足 3 卷会被打回）。',
    '',
    '【卷序列三向自洽】每一份设计都必须通过以下核对：',
    '  1. 全书方向能拆出各卷：每条卷的 direction 都是全书方向的一个可判定切面；',
    '  2. 各卷因果组成完整升级路径：后一卷必须由前一卷的结果、代价、关系变化或未解决问题推出，',
    '     且冲突层级 / 资源格局 / 认知边界逐卷换层升级，不能只是换地点或换敌人重复同一功能；',
    '  3. 每卷结果反推仍指向同一全书方向：从任何一卷的落点往回推都不会偏离全书主线。',
    '',
    '【单卷字段写法义务】每条卷必须同时满足以下三段的写法义务：',
    '  direction —— 写明本卷主目标、主角关键选择或行动、至少一条服务主线的关系/利益/认知副线、'
      + '本卷主要压力来源；副线不能另起炉灶，必须在卷末反推或改变主线。',
    '  escalation —— 形成微型完整弧：承接前卷结果进入本卷；中段发生风险升级、误判或立场变化；'
      + '高潮兑现一项既有期待；结尾造成不可逆变化并推出下一卷问题。',
    '  withheld —— 写清本卷禁止提前放出的真相、能力、关系转折或终局手段；同时保留更高层对抗，'
      + '避免本卷高潮把全书主线一次性打穿。',
    '  narrativeRole —— 用 setup | development | escalation | turn | payoff | aftermath 标明该卷在全书中的结构职责；',
    '  targetStageRange —— 本卷的阶段容量锚 {min,max}，均为正整数且 max>=min；',
    '  sustainingThreads —— 至少 1 条跨阶段持续经营的关系/利益/认知线；',
    '  payoffTargets —— 至少 1 条本卷要兑现的既有读者期待。',
    '',
    '【输出约束】你必须只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字、不要写出 JSON 以外的任何内容），'
      + '严格符合 MainlineDesign 结构。JSON 之外的一切都会被忽略并导致校验失败。',
  ].join('\n');

  const user = [
    '请基于下面的角色卡材料包，为本角色设计一份完整的主线设计（目标 ${VOLUME_COUNT} 卷）。',
    'characterRef.name 取角色名；characterRef.materialTokenEstimate 取下面材料包的 token 估算。',
    '',
    '【角色卡材料包】',
    materialJson,
    '',
    '【输出 JSON 结构契约】',
    '输出的 JSON 对象必须形如：',
    JSON.stringify(
      {
        schemaVersion: MAINLINE_SCHEMA_VERSION,
        characterRef: { name: '<角色名>', materialTokenEstimate: 0, generatedAt: '<ISO 时间>', },
        story: { id: 'ARC-STORY', title: '<全书方向简称>', direction: '<实测：目标/对抗/代价/期待/终局保留>', escalation: '<全层升级与收束>', withheld: '<终局底牌储备>' },
        volumes: [
          {
            id: 'VOL-01',
            title: '<卷标题>',
            direction: '<主目标/关键行动/副线/压力来源>',
            escalation: '<微型完整弧>',
            withheld: '<本卷禁翻底牌>',
            narrativeRole: 'setup',
            targetStageRange: { min: 6, max: 9 },
            sustainingThreads: ['<至少1条>'],
            payoffTargets: ['<至少1条>'],
          },
        ],
      },
      null,
      2,
    ),
    '',
    'volumes 数组长度必须为你上面指定的 ${VOLUME_COUNT} 条，各卷 targetStageRange 的 min>=1 且 max>=min；'
      + 'sustainingThreads 与 payoffTargets 每条卷都至少 1 个非空字符串。',
    '请直接输出最终 JSON。',
  ].join('\n');

  // 把卷数占位符替换成实际数值
  return {
    system: system.split('${VOLUME_COUNT}').join(String(volumeCount)),
    user: user.split('${VOLUME_COUNT}').join(String(volumeCount)),
  };
}

/**
 * 从模型文本中抽取出 JSON 对象并解析为 MainlineDesign。
 * 容忍：```json 围栏、``` 普通围栏、前后任意杂文本；找不到合法 JSON 对象时抛错。
 * @throws {MainlineGenerationError} 解析失败（code=MAINLINE_INVALID_JSON，中文带上限截断上下文）
 */
export function extractDesignJson(text: string): MainlineDesign {
  const trimmed = text.trim();
  let candidate: string;

  const fenceJson = /```json\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceJson) {
    candidate = fenceJson[1].trim();
  } else {
    const fenceAny = /```[\s\S]*?```/i.exec(trimmed);
    if (fenceAny) {
      // 非 json 围栏：取围栏内首个 '{' .. 最后 '}'
      const inner = fenceAny[0].replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
      candidate = sliceJsonObject(inner) ?? inner;
    } else {
      candidate = sliceJsonObject(trimmed) ?? trimmed;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MainlineGenerationError(
      MAINLINE_INVALID_JSON,
      `[${MAINLINE_INVALID_JSON}] 无法把模型输出解析为 JSON：${why}。原文（截断）: ${truncate(trimmed)}`,
      { missingFields: [], attempts: 1, repairRounds: 0, lastRaw: trimmed },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MainlineGenerationError(
      MAINLINE_INVALID_JSON,
      `[${MAINLINE_INVALID_JSON}] 模型输出解析成功但不是单个 JSON 对象。原文（截断）: ${truncate(trimmed)}`,
      { missingFields: [], attempts: 1, repairRounds: 0, lastRaw: trimmed },
    );
  }
  return parsed as MainlineDesign;
}

/** 截取首个 '{' 到最后一个 '}' 之间的子串；找不到返回 null */
function sliceJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/** 长文本截断（用于错误信息附带上下文） */
function truncate(s: string, max = 600): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 生成主线设计核心流程（整份生成 + 至多 2 轮修补闭环）：
 *   1. 整份生成：callLLMWithRetry(buildMainlinePrompt(material))；
 *   2. 解析 + validateMainlineDesign 严格校验；errors 非空 → 至多 2 轮修补
 *      （把 errors + 缺失明细回喂，要求输出修正后的完整 JSON，每轮重新校验）；
 *   3. 修补用尽仍失败 → 抛 MainlineGenerationError（MAINLINE_VALIDATION_FAILED，
 *      携带 missingFields 明细）交 UI 展示并允许用户手改。
 * 材料包 name 与 token 估算会写入/校正 design.characterRef。
 */
export async function generateMainline(
  material: CharacterMaterial,
  opts: GenerateMainlineOptions = {},
): Promise<{ design: MainlineDesign; attempts: number; repairRounds: number; requiresReview: boolean }> {
  const llmOpts = {
    temperature: 0,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
  };
  const prompt = buildMainlinePrompt(material, opts);

  let attempts = 0;
  let repairRounds = 0;
  let lastRaw = '';
  let lastErrors: MainlineValidationResult['errors'];
  let lastDesign: MainlineDesign | null = null;

  // 第 1 步：整份生成
  lastRaw = await callLLMWithRetry(
    [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    llmOpts,
  );
  attempts += 1;

  // 解析 + 校验 + 至多 2 轮修补
  for (;;) {
    let errors: MainlineValidationResult['errors'];
    try {
      const extracted = extractDesignJson(lastRaw);
      lastDesign = extracted;
      const vr = validateMainlineDesign(extracted);
      errors = vr.errors;
    } catch (e) {
      // JSON 解析失败：同样视为需修补（回喂要求输出合法 JSON）
      errors = [{ path: '$', message: e instanceof Error ? e.message : String(e) }];
    }
    lastErrors = errors;

    if (errors.length === 0) break;
    if (repairRounds >= MAX_REPAIR_ROUNDS) break;

    // 修补：构造回喂内容（含 previous JSON、errors 清单、缺失明细）
    repairRounds += 1;
    const repairUser = buildRepairUserContent(prompt, lastDesign, lastErrors);
    lastRaw = await callLLM(
      [{ role: 'system', content: prompt.system }, { role: 'user', content: repairUser }],
      llmOpts,
    );
    attempts += 1;
  }

  if (lastErrors.length > 0) {
    const missingFields = describeMissingFields(lastDesign, lastErrors);
    throw new MainlineGenerationError(
      MAINLINE_VALIDATION_FAILED,
      `[${MAINLINE_VALIDATION_FAILED}] 主线设计在 ${attempts} 次尝试（含 ${repairRounds} 轮修补）后仍未通过校验，请人工修正。` +
        `共 ${lastErrors.length} 项问题：${lastErrors.map((e) => e.message).join('；')}`,
      { missingFields, attempts, repairRounds, lastRaw },
    );
  }

  // 校验通过：校正 characterRef（材料包 name 与 token 估算）
  const design = lastDesign as MainlineDesign;
  design.characterRef = {
    ...design.characterRef,
    name: material.name,
    materialTokenEstimate: estimateMaterialTokens(material),
  };
  design.schemaVersion = MAINLINE_SCHEMA_VERSION;

  return {
    design,
    attempts,
    repairRounds,
    // 只要动用了修补预算即提示用户复核
    requiresReview: repairRounds > 0,
  };
}

/** 材料包整体 token 估算（与 material-pack.trimMaterialToBudget 口径一致） */
function estimateMaterialTokens(material: CharacterMaterial): number {
  return (
    estimateTokens(material.name) +
    estimateTokens(material.description) +
    estimateTokens(material.personality) +
    estimateTokens(material.scenario) +
    estimateTokens(material.firstMessage) +
    material.worldbookEntries.reduce((sum, e) => sum + estimateTokens(e.content), 0)
  );
}

/** 构造修补轮的用户回喂内容（只要求输出修正后的完整 JSON） */
function buildRepairUserContent(
  prompt: { user: string },
  design: MainlineDesign | null,
  errors: MainlineValidationResult['errors'],
): string {
  const missingGroups = describeMissingFields(design, errors);
  const lines: string[] = [];
  lines.push('你上一版输出的主线设计未通过严格校验。请修正下面的问题，然后重新输出【完整的】JSON 对象。');
  lines.push('只输出改正后的完整 MainlineDesign JSON，不要解释、不要只输出修改片段。');
  lines.push('');
  lines.push('【上一版输出】（若为 null 表示没能解析出合法 JSON 对象）');
  lines.push(design ? truncate(JSON.stringify(design), 4000) : '（null）');
  lines.push('');
  lines.push('【校验错误清单】');
  if (errors.length === 0) lines.push('（无，仅要求重新输出完整 JSON）');
  else errors.forEach((e) => lines.push(`  - ${e.path}: ${e.message}`));
  lines.push('');
  lines.push('【缺失/问题字段分组】');
  if (missingGroups.length === 0) lines.push('（无，仅要求重新输出完整 JSON）');
  else missingGroups.forEach((g) => lines.push(`  - ${g.path}: ${g.fields.join(', ')}`));
  lines.push('');
  lines.push('【原始生成任务】');
  lines.push(prompt.user);
  return lines.join('\n');
}