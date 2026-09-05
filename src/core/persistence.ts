/**
 * src/core/persistence.ts — 主线设计的持久化与写回（Task 5/7）
 *
 * 职责：
 *   1. 按聊天持久化：把 MainlineDesign 写入当前聊天会话的 chat_metadata.extensions，
 *      读写逻辑拆成纯函数（applyDesignToMetadata / extractDesignFromMetadata），
 *      宿主读写（getHostContext 的 ctx）包一层薄壳，便于单测与复用。
 *   2. 可选写回角色卡：把设计压入 characters[characterId].extensions，供后续
 *      「立纲转交」等模块从角色卡侧读回复现。
 *
 * 硬性约束：
 *   1. 所有宿主访问（ctx / characters / characterId / saveChat 与 saveCharacter 系列）
 *      必须判空/可选访问，宿主不可用、无角色、缺持久化函数时静默失败，
 *      绝不允许未定义引用崩溃。
 *   2. 写回角色卡是「重量级」操作，必须由调用方显式开启设置（writeBackToCharacter）
 *      后才允许调用，本模块不自行判定是否写回。
 */
import { validateMainlineDesign, type MainlineDesign } from './mainline-schema';

/** chat_metadata.extensions 中的命名空间键（与其他模块一致） */
export const STORAGE_NAMESPACE = 'st_mainline';

/** extensions 里保存主线设计的字段名 */
const MAINLINE_DESIGN_KEY = 'mainlineDesign';

/**
 * 取得聊天元数据对象：兼容新式（ctx.chatMetadata，SillyTavern 1.13+ 的 st-context）
 * 与旧式（ctx.chat_metadata）两种命名。都没有时返回 null。
 */
function getChatMeta(c: Record<string, any>): Record<string, any> | null {
  const meta = c.chatMetadata ?? c.chat_metadata;
  return meta && typeof meta === 'object' ? meta : null;
}

/**
 * 把一个 design 写到 extensions 对象中去，返回新的 extensions 对象（不修改入参）。
 * 入参 extensions 可为 undefined/null（将新建）；已含的 st_mainline 段会被保留，
 * 只更新其中的 mainlineDesign 字段。
 * @param extensions 宿主的 chat_metadata.extensions（或任意可注入数据源），可为空
 * @param design 要保存的 MainlineDesign
 */
export function applyDesignToMetadata(
  extensions: unknown,
  design: MainlineDesign,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)
      ? (extensions as Record<string, unknown>)
      : {};
  const ns: Record<string, unknown> =
    typeof base[STORAGE_NAMESPACE] === 'object' &&
    base[STORAGE_NAMESPACE] !== null &&
    !Array.isArray(base[STORAGE_NAMESPACE])
      ? (base[STORAGE_NAMESPACE] as Record<string, unknown>)
      : {};
  return {
    ...base,
    [STORAGE_NAMESPACE]: { ...ns, [MAINLINE_DESIGN_KEY]: design },
  };
}

/**
 * 从 extensions 对象中提取已保存的 MainlineDesign。
 * 无数据、结构非法、校验不通过时一律返回 null（不抛错）。
 * @param extensions 宿主的 chat_metadata.extensions（或任意可注入数据源），可为空
 */
export function extractDesignFromMetadata(extensions: unknown): MainlineDesign | null {
  if (typeof extensions !== 'object' || extensions === null) return null;
  const base = extensions as Record<string, unknown>;
  const ns = base[STORAGE_NAMESPACE];
  if (typeof ns !== 'object' || ns === null || Array.isArray(ns)) return null;
  const design = (ns as Record<string, unknown>)[MAINLINE_DESIGN_KEY];
  if (typeof design !== 'object' || design === null || Array.isArray(design)) return null;
  const vr = validateMainlineDesign(design);
  return vr.ok ? (design as MainlineDesign) : null;
}

/**
 * 把主线设计保存到当前聊天的 chat_metadata.extensions 并触发持久化。
 * 缺 chat_metadata / extensions 时自动创建；宿主不可用或没有该结构时返回 false。
 * 触发持久化优先用 ctx.saveChatConditional，其次 ctx.saveChatDebounced（两者判空）。
 * @returns 是否成功写入
 */
export function saveDesignToChat(ctx: unknown, design: MainlineDesign): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  const c = ctx as Record<string, any>;
  // 兼容新式/旧式 metadata 命名；都没有时创建新式 chatMetadata
  let chatMeta = getChatMeta(c);
  if (!chatMeta) {
    chatMeta = {};
    c.chatMetadata = chatMeta;
  }
  chatMeta.extensions = applyDesignToMetadata(chatMeta.extensions, design);

  // 触发持久化（判空，按可用链取其一）
  const save = c.saveChatConditional ?? c.saveChatDebounced ?? c.saveChat ?? c.saveMetadataDebounced;
  if (typeof save === 'function') {
    try {
      save.call(c);
    } catch {
      /* 持久化触发失败不影响已写入的内存态，返回 true 表示写入动作本身成功 */
    }
  }
  return true;
}

/**
 * 从当前聊天读取已保存的主线设计；无数据 / 结构非法返回 null。
 */
export function loadDesignFromChat(ctx: unknown): MainlineDesign | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const chatMeta = getChatMeta(ctx as Record<string, any>);
  return extractDesignFromMetadata(chatMeta?.extensions);
}

/**
 * 把主线设计写回当前角色卡扩展字段 characters[characterId].extensions。
 * 缺 characters 数组 / 角色对象 / extensions 时自动处理（extensions 自动创建）；
 * 无角色或结构缺失时返回 false。触发持久化优先…… 用 ctx.saveCharacterDebounced /
 * ctx.saveCharactersDebounced（判空，二者取一）。
 * @returns 是否成功写入（写回操作只有调用方显式开启 writeBackToCharacter 才会被调用）
 */
export function writeBackToCharacter(ctx: unknown, design: MainlineDesign): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  const c = ctx as Record<string, any>;
  const characters = c.characters;
  if (!Array.isArray(characters)) return false;

  // 优先按 this_chid 索引，其次按 name2 名称匹配（兼容 this_chid 未生效的场景）
  let char: any;
  const idx = Number(c.characterId ?? c.this_chid);
  if (Number.isFinite(idx) && idx >= 0) {
    char = characters[idx];
  }
  if (!char && typeof c.name2 === 'string' && c.name2) {
    char = characters.find((it: any) => it && it.name === c.name2);
  }
  if (!char || typeof char !== 'object') return false;

  if (typeof char.extensions !== 'object' || char.extensions === null) {
    char.extensions = {};
  }
  char.extensions[STORAGE_NAMESPACE] = design;

  // 触发持久化（判空，二者取一）
  const save = c.saveCharacterDebounced ?? c.saveCharactersDebounced ?? c.saveCharacter;
  if (typeof save === 'function') {
    try {
      save.call(c);
    } catch {
      /* 写回触发失败不影响已写入的内存态 */
    }
  }
  return true;
}