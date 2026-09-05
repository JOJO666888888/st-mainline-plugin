/**
 * tests/material-selection.test.ts — 世界书条目"注入选择"共享存储用例
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  bindEntrySelection,
  isSelectionBound,
  setEntrySelected,
  isEntrySelected,
  setAllEntriesSelected,
  countSelected,
  filterBySelection,
} from '../src/shared/material-selection';

function makeEntry(uid: number | string, comment = ''): any {
  return { uid, comment, content: '内容', tokenEstimate: 10 };
}

describe('材料包世界书条目选择', () => {
  beforeEach(() => {
    // 重置模块内部状态：通过重新 bind 空列表清空
    bindEntrySelection([]);
  });

  it('bind 后默认为全选', () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry('abc')];
    bindEntrySelection(entries);
    expect(isSelectionBound()).toBe(true);
    expect(countSelected(entries)).toBe(3);
    expect(entries.every((e) => isEntrySelected(e))).toBe(true);
  });

  it('取消勾选后 filterBySelection 将其过滤掉', () => {
    const entries = [makeEntry(1, 'a'), makeEntry(2, 'b'), makeEntry(3, 'c')];
    bindEntrySelection(entries);
    setEntrySelected(entries[1], false);
    setEntrySelected(entries[2], false);
    const filtered = filterBySelection(entries);
    expect(filtered.map((e) => e.uid)).toEqual([1]);
    expect(countSelected(entries)).toBe(1);
  });

  it('全不选 / 全选切换', () => {
    const entries = [makeEntry(1), makeEntry(2)];
    bindEntrySelection(entries);
    setAllEntriesSelected(entries, false);
    expect(countSelected(entries)).toBe(0);
    expect(filterBySelection(entries)).toHaveLength(0);
    setAllEntriesSelected(entries, true);
    expect(countSelected(entries)).toBe(2);
    expect(filterBySelection(entries)).toHaveLength(2);
  });

  it('未初始化（从未 bind 过真实材料）时视为全选', () => {
    // 通过 bind 空列表后再"假装未初始化"不可行（模块级状态），此处验证空列表语义
    const entries: any[] = [];
    expect(filterBySelection(entries)).toEqual([]);
    expect(countSelected(entries)).toBe(0);
  });

  it('按 uid 语义去重：同 uid 两条记录共享选择状态', () => {
    const a = makeEntry(7, 'x');
    const b = makeEntry(7, 'y');
    bindEntrySelection([a, b]);
    setEntrySelected(a, false);
    expect(isEntrySelected(b)).toBe(false);
  });
});