/**
 * src/core/design-doc.ts — 主线设计的人类可读文档渲染（Task 5/7）
 *
 * 把 MainlineDesign 渲染成中文 Markdown 风格的可读主线文档，供「设计页签」的
 * 可读视图展示。硬性约束：本模块为纯函数，零依赖，不触碰 window/DOM，便于
 * 单测（tests/design-doc.test.ts）与后续被转交/导出逻辑复用。
 *
 * 输出结构（对应 design 各字段）：
 *   - 角色卡引用：characterRef.name + generatedAt
 *   - 【全书方向】：story 的 direction / escalation / withheld
 *   - 【卷序列】：每卷编号 + title + narrativeRole + 目标·行动·副线·压力（direction）
 *     + 底牌（withheld）+ 阶段预期（targetStageRange.min–max）+ 持续经营线
 *     + 兑现目标列表
 */
import type { MainlineDesign } from './mainline-schema';

/** 把字符串数组按中文分号拼成一行；不是数组或空数组输出占位文案 */
function list(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '（无）';
  return items.map((s) => String(s)).join('；');
}

/** 安全的字符串取值，缺省/非字符串时输出占位，避免拼出 "undefined" */
function str(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.trim();
}

/** 安全的阶段范围取值，非数字时回落给定默认；返回 "min – max" */
function rangeStr(r: unknown, fallbackMin: number, fallbackMax: number): string {
  const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
  const min = typeof o.min === 'number' ? o.min : fallbackMin;
  const max = typeof o.max === 'number' ? o.max : fallbackMax;
  return `${min} – ${max}`;
}

/**
 * 渲染主线设计为人类可读的中文 Markdown 文档。
 * 任何字段缺省时以占位/空串兜底，绝不抛错；入参不修改。
 */
export function renderDesignDoc(design: MainlineDesign): string {
  const ref = (design?.characterRef ?? {}) as Partial<MainlineDesign['characterRef']>;
  const story = design?.story;
  const volumes = Array.isArray(design?.volumes) ? design.volumes : [];

  const lines: string[] = [];
  const title = str(story?.title) || '未命名主线';
  lines.push(`# 主线设计 · 《${title}》`);
  lines.push('');
  lines.push(`> 角色：${str(ref?.name) || '（未命名）'}｜生成时间：${str(ref?.generatedAt) || '（未知）'}`);
  lines.push('');

  lines.push('## 【全书方向】');
  lines.push(`- **方向（目标 / 对抗 / 代价 / 期待 / 终局保留）**：${str(story?.direction)}`);
  lines.push(`- **升级与收束**：${str(story?.escalation)}`);
  lines.push(`- **终局底牌保留**：${str(story?.withheld)}`);
  lines.push('');

  lines.push('## 【卷序列】');
  volumes.forEach((v, i) => {
    lines.push(`### 第 ${i + 1} 卷 · 《${str(v.title) || '未命名'}》`);
    lines.push(`- **叙事职责**：${str(v.narrativeRole)}`);
    lines.push(`- **阶段预期**：${rangeStr(v.targetStageRange, 0, 0)} 章`);
    lines.push(`- **目标 / 行动 / 副线 / 压力**：${str(v.direction)}`);
    lines.push(`- **本卷底牌（禁提前翻出）**：${str(v.withheld)}`);
    lines.push(`- **持续经营线**：${list(v.sustainingThreads)}`);
    lines.push(`- **兑现目标**：${list(v.payoffTargets)}`);
    if (i < volumes.length - 1) lines.push('');
  });

  return lines.join('\n');
}