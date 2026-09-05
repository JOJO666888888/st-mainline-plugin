/**
 * src/core/mainline-schema.ts — 主线设计数据结构与严格校验器（Task 4/7）
 *
 * 「主线设计」是长期主线的总纲设计，数据结构与 shujuku continuation 的
 * arc-architect 总纲（scope=story / scope=volume）同构，供后续「立纲转交」
 * 把设计还原给 continuation 复现：
 *   - story   一条全书方向（全局仅一条，含目标/对抗/代价/期待/终局保留的分量）；
 *   - volumes 3–8 个卷台阶，每卷携带 direction / escalation / withheld /
 *             narrativeRole / targetStageRange / sustainingThreads / payoffTargets，
 *             语义与 V20/V26 的 arc-architect 卷契约字段一一对应。
 *
 * 硬性约束：本模块全部为纯函数 + 只读校验，零依赖，不得触碰 window/DOM，
 * 便于单测与后续被 UI / 转交逻辑复用。
 */

/** 主线设计当前 schema 版本（持久化与迁移用，语义等同 shujuku 的 storyArc revision） */
export const MAINLINE_SCHEMA_VERSION = '1.0.0';

/** 卷数量合法下限 / 上限（短/中/长期主线都不少于 3 卷，不超过 8 卷） */
export const VOLUME_COUNT_MIN = 3;
export const VOLUME_COUNT_MAX = 8;

/** 全书方向条目：一条 story，全局仅一条，携带全书主线的五要素写法 */
export interface StoryArcEntry {
  /** 稳定 ID，如 'ARC-STORY' */
  id: string;
  /** 全书方向简称 */
  title: string;
  /** 本层推进方向：谁追求什么、为何必须追求、核心对抗、失败会失去什么、读者核心期待 */
  direction: string;
  /** 本层冲突要抬到什么高度、全书如何收束、终局新局面 */
  escalation: string;
  /** 本层禁止提前释放的终局底牌 / 储备 */
  withheld: string;
}

/** 单个卷台阶条目：语义对齐 continuation 的 volume upsert 字段 */
export interface VolumeEntry {
  /** 稳定 ID，如 'VOL-01' */
  id: string;
  /** 本卷标题 */
  title: string;
  /** 本卷主目标 + 主角关键行动 + 至少一条服务主线的副线 + 压力来源（竞品语义：direction） */
  direction: string;
  /** 微型完整弧：进入→中段风险/反转→高潮兑现→不可逆收尾并推出下一卷（语义：escalation） */
  escalation: string;
  /** 本卷禁止提前翻出的真相/能力/关系转折/终局手段（语义：withheld） */
  withheld: string;
  /** 卷在全书里的结构职责：setup | development | escalation | turn | payoff | aftermath */
  narrativeRole: string;
  /** 本卷的阶段容量锚 {min,max}，均为正整数且 max>=min */
  targetStageRange: { min: number; max: number };
  /** 跨阶段持续经营的关系/利益/认知线（至少 1 条） */
  sustainingThreads: string[];
  /** 本卷要兑现的既有读者期待（至少 1 条） */
  payoffTargets: string[];
}

/** 主线设计的完整对象（供 LLM 输出、持久化、转交 continuation 复现） */
export interface MainlineDesign {
  schemaVersion: string;
  /** 生成本设计所依据的角色卡快照（把材料包 name 与 token 估算落进来，供追溯） */
  characterRef: {
    name: string;
    materialTokenEstimate: number;
    generatedAt: string;
  };
  /** 全书方向，全局仅一条 */
  story: StoryArcEntry;
  /** 卷台阶，3–8 条 */
  volumes: VolumeEntry[];
}

/** 校验结果：ok 为 false 时给出按字段路径定位的中文错误清单 */
export interface MainlineValidationResult {
  ok: boolean;
  errors: { path: string; message: string }[];
}

/** 校验错误分组：把 errors 按父路径归并成缺项清单（供修补提示与 UI 展示） */
export interface MissingFieldGroup {
  /** 父路径，如 'volumes[2]' / 'story' */
  path: string;
  /** 该父路径下缺失/非法的字段名列表 */
  fields: string[];
}

/** 非空字符串判断（string 且 trim 后非空） */
function isNonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 卷数量是否在合法区间 3–8 */
export function validateVolumeCount(count: number): boolean {
  return Number.isInteger(count) && count >= VOLUME_COUNT_MIN && count <= VOLUME_COUNT_MAX;
}

/**
 * 规范化卷数量：
 *   - 提供了 short/medium/long 计划时，按档位取默认值；
 *   - 计划为 custom 或未提供计划时，优先采用合法（3–8）的 requested；
 *   - 都无法得到合法值时回落到默认 4。
 */
export function normalizeVolumeCount(
  requested?: number,
  plan?: 'short' | 'medium' | 'long' | 'custom',
): number {
  const FALLBACK = 4;
  if (plan === 'short') return VOLUME_COUNT_MIN; // 3
  if (plan === 'medium') return 4;
  if (plan === 'long') return 6;
  if (plan === 'custom') {
    return requested !== undefined && validateVolumeCount(requested) ? requested : FALLBACK;
  }
  // 未提供计划：合法则用 requested，否则回落默认
  if (requested !== undefined && validateVolumeCount(requested)) return requested;
  return FALLBACK;
}

/** 校验 characterRef 块 */
function checkCharacterRef(ref: unknown, errors: MainlineValidationResult['errors']): void {
  const p = 'characterRef';
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    errors.push({ path: p, message: 'characterRef 必须为对象 { name, materialTokenEstimate, generatedAt }' });
    return;
  }
  const o = ref as Record<string, unknown>;
  if (!isNonEmpty(o.name)) errors.push({ path: `${p}.name`, message: '角色名称必填非空' });
  if (typeof o.materialTokenEstimate !== 'number' || !Number.isFinite(o.materialTokenEstimate)) {
    errors.push({ path: `${p}.materialTokenEstimate`, message: '材料 token 估算必须为有限数字' });
  }
  if (!isNonEmpty(o.generatedAt)) errors.push({ path: `${p}.generatedAt`, message: '生成时间必填非空' });
}

/** 校验 story / 各 volume 公共必备字段（id/title/direction/escalation/withheld） */
function checkArcFields(o: Record<string, unknown>, p: string, errors: MainlineValidationResult['errors']): void {
  if (!isNonEmpty(o.id)) errors.push({ path: `${p}.id`, message: 'ID 必填非空（如 story 用 ARC-STORY，卷用 VOL-01）' });
  if (!isNonEmpty(o.title)) errors.push({ path: `${p}.title`, message: '标题必填非空' });
  if (!isNonEmpty(o.direction)) errors.push({ path: `${p}.direction`, message: '方向（主目标/关键行动/副线/压力来源）必填非空' });
  if (!isNonEmpty(o.escalation)) errors.push({ path: `${p}.escalation`, message: '升级与收束（微型完整弧）必填非空' });
  if (!isNonEmpty(o.withheld)) errors.push({ path: `${p}.withheld`, message: '底牌保留（withheld）必填非空' });
}

/** 校验 story：必须是单个对象，不允许数组（全书方向全局唯一） */
function checkStory(story: unknown, errors: MainlineValidationResult['errors']): void {
  const p = 'story';
  if (typeof story !== 'object' || story === null || Array.isArray(story)) {
    errors.push({ path: p, message: 'story 必须为单个对象，全书方向全局仅一条，不使用数组' });
    return;
  }
  checkArcFields(story as Record<string, unknown>, p, errors);
}

/** 校验一个「非空字符串数组」字段（如 sustainingThreads / payoffTargets） */
function checkStringArray(v: unknown, p: string, note: string, errors: MainlineValidationResult['errors']): void {
  if (!Array.isArray(v)) {
    errors.push({ path: p, message: `${note}（应为非空字符串数组）` });
    return;
  }
  if (v.length === 0) errors.push({ path: p, message: note });
  v.forEach((s, i) => {
    if (!isNonEmpty(s)) errors.push({ path: `${p}[${i}]`, message: '元素必须是非空字符串' });
  });
}

/** 校验 volumes：必须是 3–8 个对象的数组，逐卷严格校验 */
function checkVolumes(volumes: unknown, errors: MainlineValidationResult['errors']): void {
  const p = 'volumes';
  if (!Array.isArray(volumes)) {
    errors.push({ path: p, message: 'volumes 必须为数组' });
    return;
  }
  if (volumes.length < VOLUME_COUNT_MIN || volumes.length > VOLUME_COUNT_MAX) {
    errors.push({
      path: p,
      message: `主线共 ${volumes.length} 卷，必须为 ${VOLUME_COUNT_MIN}–${VOLUME_COUNT_MAX} 卷（仅 1 卷/不足 3 卷会被打回）`,
    });
  }
  volumes.forEach((v, i) => {
    const pp = `${p}[${i}]`;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      errors.push({ path: pp, message: '卷必须为对象' });
      return;
    }
    const o = v as Record<string, unknown>;
    checkArcFields(o, pp, errors);

    if (!isNonEmpty(o.narrativeRole)) {
      errors.push({ path: `${pp}.narrativeRole`, message: '叙事职责（setup|development|escalation|turn|payoff|aftermath）必填非空' });
    }

    const r = o.targetStageRange;
    const rp = `${pp}.targetStageRange`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      errors.push({ path: rp, message: 'targetStageRange 必须为对象 { min, max }' });
    } else {
      const rr = r as Record<string, unknown>;
      const min = typeof rr.min === 'number' ? rr.min : NaN;
      const max = typeof rr.max === 'number' ? rr.max : NaN;
      if (!Number.isFinite(min)) errors.push({ path: `${rp}.min`, message: 'min 必须为有限数字' });
      if (!Number.isFinite(max)) errors.push({ path: `${rp}.max`, message: 'max 必须为有限数字' });
      if (Number.isFinite(min) && min < 1) errors.push({ path: `${rp}.min`, message: 'min 必须 >=1' });
      if (Number.isFinite(min) && Number.isFinite(max) && max < min) {
        errors.push({ path: `${rp}.max`, message: 'max 必须 >= min' });
      }
    }

    checkStringArray(o.sustainingThreads, `${pp}.sustainingThreads`, '持续经营线至少 1 条', errors);
    checkStringArray(o.payoffTargets, `${pp}.payoffTargets`, '兑现目标至少 1 条', errors);
  });
}

/**
 * 严格校验一份（任意来源的）主线设计。
 * 规则要点：
 *   - 顶层必须是单个 JSON 对象；
 *   - story 全局仅一条（必须是对象，数组即打回）；
 *   - volumes 必须 3–8 卷（仅 1 卷 / 不足 3 卷打回）；
 *   - story 与每条卷的必填字段（id/title/direction/escalation/withheld 等）非空；
 *   - targetStageRange 的 min<=max 且 min>=1；持续经营线与兑现目标各至少 1 条非空字符串。
 */
export function validateMainlineDesign(raw: unknown): MainlineValidationResult {
  const errors: MainlineValidationResult['errors'] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '$', message: '顶层必须是单个 JSON 对象' }] };
  }
  const obj = raw as Record<string, unknown>;

  if (!isNonEmpty(obj.schemaVersion)) {
    errors.push({ path: 'schemaVersion', message: 'schemaVersion 必填非空' });
  } else if (obj.schemaVersion !== MAINLINE_SCHEMA_VERSION) {
    errors.push({ path: 'schemaVersion', message: `schemaVersion 应为 ${MAINLINE_SCHEMA_VERSION}` });
  }

  checkCharacterRef(obj.characterRef, errors);
  checkStory(obj.story, errors);
  checkVolumes(obj.volumes, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * 把校验 errors 按「父路径 → 缺失字段」归并成缺项分组，供修补提示与 UI 展示使用。
 * @param raw 原始设计对象（当前仅依赖 errors；保留入参以便后续按需增强）
 */
export function describeMissingFields(
  raw: unknown,
  errors: MainlineValidationResult['errors'],
): MissingFieldGroup[] {
  void raw; // 当前实现只消费 errors，raw 预留
  const groups = new Map<string, Set<string>>();
  for (const e of errors) {
    const idx = e.path.lastIndexOf('.');
    const parent = idx === -1 ? '$' : e.path.slice(0, idx);
    const field = idx === -1 ? e.path : e.path.slice(idx + 1);
    if (!groups.has(parent)) groups.set(parent, new Set());
    groups.get(parent)!.add(field);
  }
  return [...groups.entries()].map(([path, set]) => ({ path, fields: [...set] }));
}