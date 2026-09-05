/**
 * tests/host-compat.test.ts — detectHost 优先级用例
 *
 * 覆盖三种宿主形态的判定优先级（使用 fake window / globalThis 桩，
 * 无需真实 DOM）：
 *   1. SillyTavern.getContext 可用 → 'sillytavern'（首选规范 ST 上下文；
 *      实测部分环境会注入字段不全的 TavernHelper shim，故 ST 优先）
 *   2. 仅 TavernHelper 存在        → 'tavern-helper'
 *   3. 仅 __TAURITAVERN__ 存在     → 'tauritavern'
 * 以及备用场景：全部缺失时兜底为 'sillytavern'。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectHost, getHostAdapter, HostKind } from '../src/host/host-compat';

/** 待清理的全局键，避免用例间互相污染 */
const GLOBAL_KEYS = ['TavernHelper', '__TAURITAVERN__', 'SillyTavern'] as const;

/** 记录并清空相关全局键 */
function cleanupGlobals(): void {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as any)[key];
  }
}

beforeEach(() => {
  cleanupGlobals();
});

afterEach(() => {
  cleanupGlobals();
});

describe('detectHost 宿主判定优先级', () => {
  it('SillyTavern.getContext 可用时优先判定为 sillytavern（即使存在 TavernHelper shim）', () => {
    // 模拟实测环境：注入字段不全的 TavernHelper + __TAURITAVERN__ + 规范 ST ctx
    (globalThis as any).TavernHelper = { getContext: () => ({ tavernHelperOnly: true }) };
    (globalThis as any).__TAURITAVERN__ = { api: {} };
    (globalThis as any).SillyTavern = { getContext: () => ({ characters: [], name2: '测试角色' }) };

    expect(detectHost()).toBe<HostKind>('sillytavern');
  });

  it('无 SillyTavern.getContext 但存在 TavernHelper 时判定为 tavern-helper', () => {
    (globalThis as any).TavernHelper = { getContext: () => ({}) };
    (globalThis as any).__TAURITAVERN__ = { api: {} };

    expect(detectHost()).toBe<HostKind>('tavern-helper');
  });

  it('仅 __TAURITAVERN__ 存在时判定为 tauritavern', () => {
    (globalThis as any).__TAURITAVERN__ = { api: {} };

    expect(detectHost()).toBe<HostKind>('tauritavern');
  });

  it('仅有 SillyTavern.getContext 时判定为 sillytavern', () => {
    (globalThis as any).SillyTavern = { getContext: () => ({}) };

    expect(detectHost()).toBe<HostKind>('sillytavern');
  });

  it('全部缺失时兜底为 sillytavern 且不抛错', () => {
    expect(detectHost()).toBe<HostKind>('sillytavern');
  });

  it('getHostAdapter 返回的 kind 与 detectHost 一致且上下文取自 ST 优先', () => {
    (globalThis as any).TavernHelper = { getContext: () => ({ tavernHelperOnly: true }) };
    (globalThis as any).SillyTavern = { getContext: () => ({ extensionSettings: {} }) };
    const adapter = getHostAdapter();
    expect(adapter.kind).toBe<HostKind>('sillytavern');
    // getHostContext 应返回规范 ST 上下文，而非 TavernHelper shim
    const ctx = adapter.getContext() as any;
    expect(ctx.extensionSettings).toBeDefined();
    expect(ctx.tavernHelperOnly).toBeUndefined();
  });
});