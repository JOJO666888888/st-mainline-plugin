/**
 * src/core/material-pack.ts — 角色卡材料包读取与裁剪（Task 2/7）
 *
 * 职责：从宿主上下文中读取当前角色卡（人设 + 世界观 + 开场白），并对材料按
 * 固定优先级裁剪到给定 token 预算内，供后续「主线设计」LLM 请求使用。
 *
 * 硬性约束：
 *   1. 所有宿主访问（getContext / ctx.* / 全局函数）必须判空/可选访问，
 *      读不到角色或上下文不可用时返回 { error }，绝不允许未定义引用崩溃，
 *      也绝不把不完整的材料用于下游生成。
 *   2. 纯函数（estimateTokens / trimMaterialToBudget）不得依赖 DOM 与宿主，
 *      便于单元测试。
 */
import { getHostContext } from '../host/host-compat';

/** 世界书单条目的紧凑表示 */
export interface CharacterWorldbookEntry {
  uid: number | string;
  comment: string;
  content: string;
  /** 该条目 content 的 token 估算（读取时由 estimateTokens 计算） */
  tokenEstimate: number;
}

/** 角色卡材料包：人设核心 + 世界观 + 开场白 */
export interface CharacterMaterial {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  worldbookEntries: CharacterWorldbookEntry[];
}

/** 读取结果：成功为 CharacterMaterial，失败为 { error } */
export type MaterialReadResult = CharacterMaterial | { error: string };

/** 中文（CJK）字符判断：平假名/片假名、CJK 统一汉字与扩展 A、兼容汉字、全角形式 */
function isCJKChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点（，。？！）
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x9fff) || // CJK 统一汉字 + 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  );
}

/**
 * CJK 友好的 token 估算启发式（纯函数，可测试）：
 *   - 中文等 CJK 字符：约 1 token / 1.5 字；
 *   - 英文等拉丁字符：约 1 token / 3 字符。
 * 返回非负整数（向上取整），空串返回 0。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const CJK_TOKEN_UNITS = 1 / 1.5; // 每个 CJK 字符折算的 token
  const LATIN_TOKEN_UNITS = 1 / 3; // 每个拉丁字符折算的 token
  let units = 0;
  for (const ch of text) {
    units += isCJKChar(ch) ? CJK_TOKEN_UNITS : LATIN_TOKEN_UNITS;
  }
  return Math.ceil(units);
}

/** 安全字符串取值：非字符串一律返回 ''，避免引用崩溃。 */
function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 取宿主上下文并判空。
 * 复用 host-compat 的统一入口，所有异常在内部吞掉返回 undefined。
 */
function loadCtx(): any {
  try {
    return getHostContext();
  } catch {
    return undefined;
  }
}

/** 顶层全局对象（Node/vitest 下等同 globalThis，浏览器下为 window）。 */
function getGlobal(): any {
  try {
    return (globalThis as any).window ?? globalThis;
  } catch {
    return globalThis;
  }
}

/**
 * 从上下文解析当前角色对象（人设字段所在）。
 *
 * 兼容 SillyTavern 1.13+（模块化 st-context）与旧版/上游、TauriTavern、TavernHelper：
 * - 新式 ctx：characters 数组 + characterId(this_chid) + name2 + getCharacters() + getOneCharacter()
 * - 旧式 ctx：ctx.getCharacter(name) / 全局 getCharacter('current') / ctx.character
 * 解析优先级：索引(this_chid) → ctx.getCharacter(name)（旧式）→ 按 name2 名称匹配 →
 *   全局 getCharacter → ctx.character → 单角色兜底 → 浅层角色深度补全。
 * 全部不可用返回 undefined。
 */
async function resolveCurrentCharacter(ctx: any): Promise<any | undefined> {
  if (!ctx) return undefined;
  const g = getGlobal();
  try {
    // 候选角色数组（容忍异步 getCharacters）
    const arrays: any[][] = [];
    const push = (a: unknown) => {
      if (Array.isArray(a) && a.length > 0) arrays.push(a);
    };
    push(ctx.characters);
    push(g?.characters);
    try {
      push(await ctx.getCharacters?.());
    } catch {
      /* 某些宿主 getCharacters 会抛错，忽略 */
    }

    // 1) 按 this_chid / characterId 索引取（新式酒馆的主要路径）
    const idx = Number(ctx.characterId ?? ctx.this_chid);
    if (Number.isFinite(idx) && idx >= 0) {
      for (const arr of arrays) {
        const ch = arr[idx];
        if (ch && typeof ch === 'object') return await deepFill(ctx, ch);
      }
    }

    const name = safeStr(ctx.name2);

    // 2) 旧式 ctx.getCharacter(name)（上游 SillyTavern 兼容）
    if (name && typeof ctx.getCharacter === 'function') {
      const ch = ctx.getCharacter(name);
      if (ch && typeof ch === 'object') return ch;
    }

    // 3) 按 name2 名称匹配（this_chid 无效时的新式兜底）
    if (name) {
      for (const arr of arrays) {
        const ch = arr.find((c: any) => c && safeStr(c.name) === name);
        if (ch) return await deepFill(ctx, ch);
      }
    }

    // 4) 全局 getCharacter('current')（上游/旧酒馆兼容）
    if (typeof g?.getCharacter === 'function') {
      const ch = g.getCharacter('current');
      if (ch && typeof ch === 'object') return ch;
    }

    // 5) 直接暴露的当前角色对象（部分宿主/适配层）
    if (ctx.character && typeof ctx.character === 'object') return ctx.character;

    // 6) 单角色兜底：数组只有一个角色时即视为当前
    for (const arr of arrays) {
      if (arr.length === 1) {
        const ch = arr[0];
        if (ch && typeof ch === 'object') return await deepFill(ctx, ch);
      }
    }
  } catch {
    /* 任何异常视为解析失败 */
  }
  return undefined;
}

/** 判断角色对象是否已带真实内容（避免多余的深读网络请求）。 */
function hasRealContent(char: any): boolean {
  if (!char) return false;
  return (
    (typeof char.description === 'string' && char.description.trim() !== '') ||
    (typeof char.personality === 'string' && char.personality.trim() !== '') ||
    (typeof char.scenario === 'string' && char.scenario.trim() !== '') ||
    hasBookEntries(char)
  );
}

/** 判断角色对象是否已带世界书条目（兼容 v2 扁平与 data.character_book 两种位置）。 */
function hasBookEntries(char: any): boolean {
  const book = char?.character_book ?? char?.data?.character_book;
  return !!(book && typeof book === 'object' && Array.isArray(book.entries) && book.entries.length > 0);
}

/**
 * 浅层角色深度补全：角色列表项可能只带 name/avatar（shallow），此时
 * ctx.getOneCharacter(avatar)（新式酒馆）会拉取完整角色卡并**就地替换**
 * characters[avatar 对应下标]，但函数本身不返回结果 —— 因此调用后再从
 * 候选角色数组中按 avatar 重取完整对象。补全失败或接口缺失时原样返回浅层对象。
 */
async function deepFill(ctx: any, char: any): Promise<any> {
  try {
    const avatar = safeStr(char?.avatar);
    if (hasRealContent(char) || !avatar || typeof ctx?.getOneCharacter !== 'function') {
      return char;
    }
    await ctx.getOneCharacter(avatar);
    const g = getGlobal();
    const sources: any[][] = [];
    const push = (a: unknown) => {
      if (Array.isArray(a)) sources.push(a);
    };
    push(ctx?.characters);
    push(g?.characters);
    for (const arr of sources) {
      const full = arr.find((c: any) => c && safeStr(c.avatar) === avatar);
      if (full && typeof full === 'object') return full;
    }
  } catch {
    /* 保持浅层 */
  }
  return char;
}

/** 从角色对象读取人设字段（逐字段判空，缺失输出空字符串）。 */
function readCharacterFields(char: any): CharacterMaterial {
  const ch = char ?? {};
  return {
    name: safeStr(ch.name),
    description: safeStr(ch.description),
    personality: safeStr(ch.personality),
    scenario: safeStr(ch.scenario),
    firstMessage: safeStr(ch.first_mes ?? ch.firstMes),
    worldbookEntries: [],
  };
}

/**
 * 读取当前角色卡世界书条目；支持多种宿主形态：
 * - 新式酒馆：角色对象内嵌 char.character_book（{ entries: [...] }）
 * - 旧式 ctx.getCharacterBook() / char.getCharacterBook()
 * - ctx.characterBook（部分宿主直接给）
 * 每个条目的 uid/comment/content 均判空；content 为空串可跳过计算。
 */
function readWorldbookEntries(ctx: any, char: any): CharacterWorldbookEntry[] {
  const entries: CharacterWorldbookEntry[] = [];
  try {
    let book: any;
    if (typeof ctx?.getCharacterBook === 'function') {
      book = ctx.getCharacterBook();
    } else if (char?.character_book && typeof char.character_book === 'object') {
      book = char.character_book;
    } else if (char?.data?.character_book && typeof char.data.character_book === 'object') {
      book = char.data.character_book;
    } else if (typeof char?.getCharacterBook === 'function') {
      book = char.getCharacterBook();
    } else if (ctx?.characterBook && Array.isArray(ctx.characterBook.entries)) {
      book = ctx.characterBook;
    }
    if (book && Array.isArray(book?.entries)) {
      for (const e of book.entries) {
        if (!e) continue;
        const content = safeStr(e.content);
        entries.push({
          uid: e.uid ?? -1,
          comment: safeStr(e.comment),
          content,
          tokenEstimate: estimateTokens(content),
        });
      }
    }
  } catch {
    /* 世界书读取失败则返回空列表 */
  }
  return entries;
}

/**
 * 读取当前角色卡完整材料包。
 * 上下文不可用 / 找不到角色时返回 { error }（此时绝不下发生成请求）。
 */
export async function readCurrentCharacterMaterial(): Promise<MaterialReadResult> {
  const ctx = loadCtx();
  if (!ctx) {
    return {
      error: '无法获取宿主上下文（getContext 不可用）。请确认插件已运行在 SillyTavern / TauriTavern 环境且宿主已就绪。',
    };
  }
  const char = await resolveCurrentCharacter(ctx);
  if (!char) {
    const g = getGlobal();
    return {
      error:
        `未找到当前角色卡。诊断：name2=${JSON.stringify(ctx.name2)}，` +
        `characterId=${JSON.stringify(ctx.characterId ?? ctx.this_chid)}，` +
        `ctx.characters 长度=${Array.isArray(ctx.characters) ? ctx.characters.length : '无'}，` +
        `全局 getCharacter=${typeof g?.getCharacter === 'function' ? '有' : '无'}。` +
        '请先在角色列表点开角色的聊天窗口（this_chid 生效），或确认角色卡已加载。',
    };
  }
  const material = readCharacterFields(char);
  material.worldbookEntries = readWorldbookEntries(ctx, char);
  return material;
}

/** 材料包整体 token 估算（用于裁剪预算判断）。 */
function totalEstimate(m: CharacterMaterial): number {
  return (
    estimateTokens(m.name) +
    estimateTokens(m.description) +
    estimateTokens(m.personality) +
    estimateTokens(m.scenario) +
    estimateTokens(m.firstMessage) +
    m.worldbookEntries.reduce((sum, e) => sum + e.tokenEstimate, 0)
  );
}

/** 深度截断：把 text 截断到其估算不超过 maxTokens 的最长前缀。 */
function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * 按预算裁剪材料包，固定优先级：
 *   人设核心（name+description+personality 保留最高）
 *     > 世界观（scenario + worldbook）> 开场白（firstMessage 优先级最低）
 * 裁剪策略（从低优先级开始）：
 *   1. 整段丢弃 firstMessage；
 *   2. 从末尾逐个丢弃世界书条目内容（保留 comment，content 清空，tokenEstimate 归零）；
 *      随后若仍超预算则截断 scenario；
 *   3. 最后按比例截断 description 与 personality 适配剩余预算，name 始终保留。
 * 入参不被修改（返回全新副本）。无穷大预算时不裁剪。
 */
export function trimMaterialToBudget(material: CharacterMaterial, budgetTokens: number): CharacterMaterial {
  const budget = Math.max(0, Math.floor(budgetTokens));
  // 深拷贝，避免修改调用方对象
  const out: CharacterMaterial = {
    ...material,
    description: material.description,
    personality: material.personality,
    scenario: material.scenario,
    firstMessage: material.firstMessage,
    worldbookEntries: material.worldbookEntries.map((e) => ({ ...e })),
  };

  // 预算足以容纳全部（含无穷大），原样返回
  if (totalEstimate(out) <= budget) return out;

  // 阶段一：开场白优先级最低，整段丢弃
  out.firstMessage = '';

  // 阶段二：世界观 —— 先丢世界书条目内容（保留 comment），再截断 scenario
  let over = totalEstimate(out) - budget;
  if (over > 0) {
    for (let i = out.worldbookEntries.length - 1; i >= 0 && over > 0; i--) {
      const entry = out.worldbookEntries[i];
      over -= entry.tokenEstimate;
      entry.content = '';
      entry.tokenEstimate = 0;
    }
    // 保留含 comment 或仍残留内容（拖番“已略去”）的条目
    out.worldbookEntries = out.worldbookEntries.filter((e) => e.comment.length > 0 || e.content.length > 0);
  }
  over = totalEstimate(out) - budget;
  if (over > 0) {
    out.scenario = truncateTextToTokens(out.scenario, Math.max(0, estimateTokens(out.scenario) - over));
  }

  // 阶段三：人设核心 —— description 与 personality 按比例截断，name 保留
  over = totalEstimate(out) - budget;
  if (over > 0) {
    const fixed =
      estimateTokens(out.name) + estimateTokens(out.scenario) + estimateTokens(out.firstMessage) +
      out.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
    const coreBudget = Math.max(0, budget - fixed);
    const descTokens = estimateTokens(out.description);
    const persTokens = estimateTokens(out.personality);
    const cpTotal = descTokens + persTokens;
    if (coreBudget <= 0) {
      out.description = '';
      out.personality = '';
    } else if (cpTotal > coreBudget) {
      // 按两者占比分配核心预算
      const descShare = cpTotal > 0 ? descTokens / cpTotal : 0.5;
      out.description = truncateTextToTokens(out.description, Math.floor(coreBudget * descShare));
      const remainingCore = coreBudget - estimateTokens(out.description);
      out.personality = truncateTextToTokens(out.personality, Math.max(0, remainingCore));
    }
  }

  return out;
}