/**
 * src/core/handoff.ts — 主线「立纲转交」指令渲染（Task 6/7）
 *
 * 背景：shujuku continuation 的「续写任务」以用户提供的初始要求
 * （$USER_INTENT / $ORIGIN_INSTRUCTION）启动，随后 arc-architect 依据它立
 * 故事总纲（$STORY_ARC：story + volume 阶梯）。本模块把用户审阅确认后的
 * MainlineDesign 渲染成一段可直接粘贴为续写任务初始要求的立纲指令文本，
 * 让 arc-architect 无需重新自由发挥即可严格复现该设计。
 *
 * 硬性约束：本模块全部为纯函数，零依赖，不触碰 window/DOM，便于单测
 * （tests/handoff.test.ts）与后续被转交逻辑复用。
 */
import type { MainlineDesign } from './mainline-schema';

/** 字符串数组安全拼接：非数组 / 空数组输出占位，避免拼出 "undefined" */
function list(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '（无）';
  return items.map((s) => String(s)).join('；');
}

/** 安全字符串取值：非字符串/空串输出占位 */
function str(v: unknown, placeholder = ''): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || placeholder;
}

/** 安全的阶段范围取值，非数字时回落给定默认 */
function rangeStr(r: unknown, fallbackMin: number, fallbackMax: number): string {
  const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
  const min = typeof o.min === 'number' ? o.min : fallbackMin;
  const max = typeof o.max === 'number' ? o.max : fallbackMax;
  return `${min}–${max}`;
}

/** 补零：把数字补成至少两位 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 把立纲指令所需的「结构约束」段落渲染成纯文本数组。
 * 这些约束是转交指令的核心：让 arc-architect 严格照此立纲而非自由发挥。
 */
function constraintLines(): string[] {
  return [
    '## 立纲时的结构约束',
    '- 卷数保持 3 到 8，且不得增删、不得改变上述卷的先后次序。',
    '- 第一卷状态为 active，其余各卷均为 planned，卷间状态推进严格依序逐个解锁。',
    '- 卷间序列必须三向自洽：全书方向能拆解到各卷；各卷的因果链组成从第一卷到末卷的升级路径；各卷反推均指向同一全书方向。',
    '- 禁止提前翻开任何卷的底牌（withheld）；未到对应卷阶段，不得释出对应真相/能力/转折。',
    '- 所有阶段/轮目标只能落在当前 active 卷的台阶（targetStageRange）之内，不得越卷推进。',
  ];
}

/**
 * 把用户审阅确认后的主线设计渲染成一段可直接粘贴为续写任务初始要求的
 * 立纲指令纯文本（Markdown 风格）。任何字段缺省以占位/空串兜底，绝不抛错，
 * 入参不修改。
 */
export function renderHandoffInstruction(design: MainlineDesign): string {
  const ref = (design?.characterRef ?? {}) as Partial<MainlineDesign['characterRef']>;
  const story = design?.story;
  const volumes = Array.isArray(design?.volumes) ? design.volumes : [];

  const lines: string[] = [];
  lines.push(
    '请采用以下主线设计为当前角色创建可长期游玩的完整故事总纲，并严格照此立纲，无需另行自由发挥或增删卷。',
  );
  lines.push('');

  // ---- 全书方向（全局唯一 story） ----
  lines.push('## 全书方向');
  lines.push(`- 主线名称：《${str(story?.title, '未命名主线')}》`);
  lines.push(`- 方向（目标/对抗/代价/期待/终局保留）：${str(story?.direction)}`);
  lines.push(`- 升级与收束：${str(story?.escalation)}`);
  lines.push(`- 终局底牌（禁止提前释放）：${str(story?.withheld)}`);
  lines.push('');

  // ---- 卷序列（每卷一节） ----
  lines.push('## 卷序列');
  volumes.forEach((v, i) => {
    lines.push(`### 第 ${i + 1} 卷 · 《${str(v?.title, '未命名')}》`);
    lines.push(`- 叙事职责：${str(v?.narrativeRole)}`);
    lines.push(`- 主目标/关键行动/副线/压力来源：${str(v?.direction)}`);
    lines.push(`- 进入态 → 中段 → 高潮 → 卷末：${str(v?.escalation)}`);
    lines.push(`- 本卷底牌（禁提前翻出）：${str(v?.withheld)}`);
    lines.push(`- 预期阶段数：${rangeStr(v?.targetStageRange, 0, 0)}`);
    lines.push(`- 持续经营线：${list(v?.sustainingThreads)}`);
    lines.push(`- 兑现目标：${list(v?.payoffTargets)}`);
    lines.push('');
  });

  // ---- 卷数声明（与结构约束一致） ----
  lines.push(`本设计共 ${volumes.length} 卷。`);
  lines.push('');
  lines.push(...constraintLines());

  // 附一条角色与生成时间元的跟踪信息，便于追溯来源
  lines.push('');
  lines.push(`> 依据角色：${str(ref?.name, '（未知）')} ｜ 设计生成于：${str(ref?.generatedAt, '（未知）')}`);

  return lines.join('\n');
}

/**
 * 生成导出的立纲要求文件名：`主线-立纲要求-{角色名}-{yyyyMMdd-HHmm}.md`。
 * 角色名中的非法文件名字符（含 Windows 残留路径分隔符/通配符/引号等）
 * 统一替换为下划线；空角色名回落「未命名」。时间用本地时区补零格式。
 */
export function buildHandoffFilename(design: MainlineDesign): string {
  const name = str(
    design?.characterRef?.name,
    '未命名',
  ).replace(/[\\/:*?",<>|]/g, '_').trim();

  const now = new Date();
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}`;

  return `主线-立纲要求-${name}-${stamp}.md`;
}