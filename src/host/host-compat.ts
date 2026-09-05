/**
 * src/host/host-compat.ts — 宿主适配层（骨架）
 *
 * 本模块是「ST·主线设计」插件在 SillyTavern / TauriTavern / 酒馆助手
 * （TavernHelper）三套宿主能力之间做统一抽象的边界。
 *
 * 目的：让上层业务代码（后续任务实现的主线设计功能）不关心到底跑在哪个宿主，
 * 只依赖本层暴露的统一接口类型。本任务只实现「宿主探测 + 统一接口类型」，具体
 * 的 host 能力调用（getChat / getCharacter / saveSettings …）由后续任务填充。
 *
 * 与 shujuku 的 host-detect.ts 口径一致：
 * - window.TavernHelper       → 酒馆助手（第三方增强 API）
 * - window.__TAURITAVERN__    → TauriTavern（Rust 后端增强 API）
 * - window.SillyTavern.getContext → 原生 SillyTavern
 *
 * 硬性约束：所有对 window / SillyTavern / TavernHelper / __TAURITAVERN__ 的
 * 访问都必须判空或可选访问，绝不允许因某个宿主未提供而抛出未定义引用崩溃。
 */

/** 宿主类型枚举：用于区分运行时所属的宿主形态 */
export type HostKind = 'tavern-helper' | 'tauritavern' | 'sillytavern';

/**
 * 统一的宿主适配器接口。
 * 顶层功能代码只需依赖该接口，后续任务在此之上扩展各宿主的具体能力。
 */
export interface HostAdapter {
  /** 探测得到的宿主类型 */
  kind: HostKind;
  /**
   * 获取宿主上下文（SillyTavern.getContext() 的返回，或 TauriTavern / TavernHelper
   * 对应的上下文）。返回 unknown，调用方需自行收窄类型。
   */
  getContext(): unknown;
  /** 打一条「适配层来源」日志（用于确认当前命中了哪个宿主） */
  logReady(): void;
}

/**
 * 内部的 window 顶层引用（只读快捷方式）。
 * 在 Node/vitest 等无 window 环境下为 undefined，判空后安全。
 */
function getGlobal(): any {
  try {
    return (globalThis as any).window ?? globalThis;
  } catch {
    return globalThis;
  }
}

/**
 * 探测当前宿主类型，优先级从高到低：
 *   1. window.SillyTavern.getContext 可用 → 'sillytavern'
 *      （优先取规范 ST 上下文。实测部分环境会注入 window.TavernHelper 兼容
 *        shim（如油猴脚本/酒馆助手），其 getContext 字段不全，不能作为主源；
 *        TauriTavern 同样保留 ST 前端，getContext 恒可用。）
 *   2. window.TavernHelper 存在          → 'tavern-helper'（兜底）
 *   3. window.__TAURITAVERN__ 存在       → 'tauritavern'（兜底）
 * 全部不满足时返回 'sillytavern' 作为兜底（此时 getContext() 会判空抛错，
 * 由调用方处理；本层只保证不崩溃地给出一个判定结果）。
 */
export function detectHost(): HostKind {
  const g = getGlobal();
  try {
    if (typeof g?.SillyTavern?.getContext === 'function') {
      return 'sillytavern';
    }
    if (g?.TavernHelper) {
      return 'tavern-helper';
    }
    if (g?.__TAURITAVERN__) {
      return 'tauritavern';
    }
    // 兜底：即便什么都没检测到，也返回 sillytavern，避免上层拿到 undefined 型别
    return 'sillytavern';
  } catch {
    // 任何异常都不应让插件崩溃，回退到 sillytavern
    return 'sillytavern';
  }
}

/**
 * 获取宿主上下文对象。
 * - SillyTavern：返回 SillyTavern.getContext()（首选，规范上下文）。
 * - TavernHelper：取其 getContext()（若存在），否则返回 TavernHelper 本身（兜底）。
 * - TauriTavern：返回 __TAURITAVERN__ 对象（兜底）。
 * 所有访问均判空/可选访问，未就绪或不存在时返回 undefined，绝不抛错。
 */
export function getHostContext(): unknown {
  const g = getGlobal();
  try {
    if (typeof g?.SillyTavern?.getContext === 'function') {
      return g.SillyTavern.getContext();
    }
    if (g?.TavernHelper) {
      if (typeof g.TavernHelper.getContext === 'function') {
        return g.TavernHelper.getContext();
      }
      return g.TavernHelper;
    }
    if (g?.__TAURITAVERN__) {
      return g.__TAURITAVERN__;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 获取统一的宿主适配器（探测 + 上下文 + 日志一次到位）。
 * 一次性构造，供插件入口调用一次并持有。
 */
export function getHostAdapter(): HostAdapter {
  const kind = detectHost();
  return {
    kind,
    getContext: () => getHostContext(),
    logReady() {
      // 中文提示当前命中的宿主来源，便于排查运行环境
      const name =
        kind === 'tavern-helper'
          ? '酒馆助手（TavernHelper）'
          : kind === 'tauritavern'
            ? 'TauriTavern'
            : 'SillyTavern';
      console.log(`[主线设计] 宿主适配层就绪：命中 ${name}（kind=${kind}）`);
    },
  };
}