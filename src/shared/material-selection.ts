/**
 * src/shared/material-selection.ts — 世界书条目"注入选择"共享存储
 *
 * 需求（用户反馈）：当前 ST 角色卡主流写作方式是把主要内容集中写在世界书中，
 * 因此材料包读取到世界书后，应允许用户**勾选**哪些条目真正注入到主线设计生成中。
 *
 * 设计：
 * - 用 entry 的 uid（字符串化）作为选择键，trim 裁剪不改变 uid，选择跨裁剪稳定。
 * - 读取新材料包时调用 bindSelection 重置为"全选"。
 * - 未初始化时 filterBySelection 返回原列表（默认全注入）。
 */
import type { CharacterWorldbookEntry } from '../core/material-pack';

/** 当前被选中的世界书条目 uid 集合 */
const selected = new Set<string>();

/** 是否已初始化过选择状态（读到过至少一次材料包） */
let bound = false;

/** 归一化条目选择键：优先 uid，其次 comment，最后下标占位。 */
function keyOf(entry: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>): string {
  if (entry.uid !== undefined && entry.uid !== null && String(entry.uid) !== '') {
    return `uid:${String(entry.uid)}`;
  }
  if (typeof entry.comment === 'string' && entry.comment.trim() !== '') {
    return `comment:${entry.comment}`;
  }
  return `idx:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 绑定一批新读取的条目（重置为全选）。
 * @param entries 最新读取的世界书条目（裁剪前）
 */
export function bindEntrySelection(entries: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>[]): void {
  selected.clear();
  for (const entry of entries) {
    selected.add(keyOf(entry));
  }
  bound = true;
}

/** 当前材料包是否已初始化选择状态。 */
export function isSelectionBound(): boolean {
  return bound;
}

/** 设置某条目的选中状态。 */
export function setEntrySelected(
  entry: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>,
  on: boolean,
): void {
  const key = keyOf(entry);
  if (on) selected.add(key);
  else selected.delete(key);
}

/** 查询某条目是否选中。 */
export function isEntrySelected(entry: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>): boolean {
  if (!bound) return true;
  return selected.has(keyOf(entry));
}

/** 全选 / 全不选。 */
export function setAllEntriesSelected(entries: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>[], on: boolean): void {
  for (const entry of entries) {
    setEntrySelected(entry, on);
  }
  bound = true;
}

/** 返回被勾选条目的数量。 */
export function countSelected(entries: Pick<CharacterWorldbookEntry, 'uid' | 'comment'>[]): number {
  if (!bound) return entries.length;
  return entries.filter((e) => selected.has(keyOf(e))).length;
}

/**
 * 按当前选择过滤条目（未初始化时原样返回）。
 * @param entries 裁剪后的条目列表
 */
export function filterBySelection<T extends Pick<CharacterWorldbookEntry, 'uid' | 'comment'>>(entries: T[]): T[] {
  if (!bound) return entries;
  return entries.filter((e) => selected.has(keyOf(e)));
}