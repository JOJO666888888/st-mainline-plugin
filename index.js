var MainlineDesign = (function (exports) {
    'use strict';

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
    /**
     * 内部的 window 顶层引用（只读快捷方式）。
     * 在 Node/vitest 等无 window 环境下为 undefined，判空后安全。
     */
    function getGlobal$1() {
        try {
            return globalThis.window ?? globalThis;
        }
        catch {
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
    function detectHost() {
        const g = getGlobal$1();
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
        }
        catch {
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
    function getHostContext() {
        const g = getGlobal$1();
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
        }
        catch {
            return undefined;
        }
    }
    /**
     * 获取统一的宿主适配器（探测 + 上下文 + 日志一次到位）。
     * 一次性构造，供插件入口调用一次并持有。
     */
    function getHostAdapter() {
        const kind = detectHost();
        return {
            kind,
            getContext: () => getHostContext(),
            logReady() {
                // 中文提示当前命中的宿主来源，便于排查运行环境
                const name = kind === 'tavern-helper'
                    ? '酒馆助手（TavernHelper）'
                    : kind === 'tauritavern'
                        ? 'TauriTavern'
                        : 'SillyTavern';
                console.log(`[主线设计] 宿主适配层就绪：命中 ${name}（kind=${kind}）`);
            },
        };
    }

    /**
     * src/shared/settings.ts — 插件设置读写（共享基础，Task 2/3 及后续任务复用）
     *
     * 存储位置：SillyTavern extensionSettings[SETTING_NAMESPACE]，经 saveSettingsDebounced 持久化。
     * 所有宿主访问必须判空，未就绪时返回默认设置且不抛错。
     */
    /** 与 src/index.ts 导出的命名空间保持一致 */
    const SETTING_NAMESPACE$1 = 'st_mainline';
    const DEFAULT_SETTINGS = {
        enabled: true,
        apiBaseUrl: 'https://api.openai.com/v1',
        apiModel: 'gpt-4o-mini',
        apiKey: '',
        apiTemperature: 0.7,
        apiMaxTokens: 2000,
        materialTokenBudget: 3000,
        writeBackToCharacter: false,
        reviewTailFloors: 12,
    };
    /** 读取设置：逐字段回填默认值，保证结构完整。 */
    function loadSettings() {
        const ctx = getHostContext();
        const raw = ctx?.extensionSettings?.[SETTING_NAMESPACE$1];
        if (!raw || typeof raw !== 'object') {
            return { ...DEFAULT_SETTINGS };
        }
        const merged = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            const value = raw[key];
            if (value !== undefined && value !== null) {
                merged[key] = value;
            }
        }
        return merged;
    }
    /** 保存设置：写入 extensionSettings 并触发防抖保存；无宿主时静默失败。 */
    function saveSettings(settings) {
        const ctx = getHostContext();
        if (!ctx)
            return;
        if (!ctx.extensionSettings)
            ctx.extensionSettings = {};
        ctx.extensionSettings[SETTING_NAMESPACE$1] = { ...settings };
        ctx.saveSettingsDebounced?.();
    }

    /**
     * src/ui/tabs/types.ts — 面板页签注册协议（共享基础，后续任务均使用）
     *
     * 每个功能页签实现自己的模块，通过 registerTab() 向面板注册；
     * 面板（index.ts）负责渲染页签栏并调用 mount() 挂载内容。
     */
    const registry = new Map();
    /** 注册页签（同名覆盖，幂等）。 */
    function registerTab(def) {
        registry.set(def.id, def);
    }
    /** 取全部已注册页签（按注册顺序）。 */
    function getTabs() {
        return [...registry.values()];
    }

    /**
     * src/ui/panel.ts — 面板渲染层
     *
     * 读取 tabs registry（各功能模块 import 时自行 registerTab），渲染页签栏 + 内容区，
     * 点击页签切换对应 mount()。面板尺寸与样式集中到这里管理。
     */
    /**
     * 把页签面板挂载到 panelRoot（#st-mainline-panel）内。
     * 幂等：重复调用先清空内容再重建。
     */
    function mountPanel(panelRoot) {
        panelRoot.replaceChildren();
        const defs = getTabs();
        if (!defs.length) {
            const empty = document.createElement('div');
            empty.textContent = '暂无功能页签';
            empty.style.padding = '8px';
            empty.style.color = '#9a9aa0';
            panelRoot.appendChild(empty);
            return;
        }
        // 页签栏
        const bar = document.createElement('div');
        bar.style.display = 'flex';
        bar.style.flexWrap = 'wrap';
        bar.style.gap = '4px';
        bar.style.marginBottom = '10px';
        // 内容区
        const content = document.createElement('div');
        content.style.maxHeight = '70vh';
        content.style.overflowY = 'auto';
        let activeId = defs[0].id;
        const buttons = new Map();
        for (const def of defs) {
            const btn = document.createElement('button');
            btn.textContent = def.title;
            btn.style.padding = '3px 8px';
            btn.style.cursor = 'pointer';
            btn.style.borderRadius = '4px';
            btn.style.border = '1px solid #4a4a52';
            btn.style.background = 'transparent';
            btn.style.color = '#e8e8ec';
            btn.addEventListener('click', () => switchTo(def.id));
            bar.appendChild(btn);
            buttons.set(def.id, btn);
        }
        panelRoot.appendChild(bar);
        panelRoot.appendChild(content);
        const cleanups = new Map();
        function switchTo(id) {
            for (const [tabId, btn] of buttons) {
                btn.style.background = tabId === id ? '#3a6ea5' : 'transparent';
                btn.style.color = tabId === id ? '#fff' : '#e8e8ec';
            }
            content.replaceChildren();
            // 切换前清理上一页签挂载产生的副作用
            if (activeId !== id) {
                const prev = cleanups.get(activeId);
                if (typeof prev === 'function')
                    prev();
            }
            activeId = id;
            const def = defs.find((it) => it.id === id);
            if (!def)
                return;
            try {
                const cleanup = def.mount(content);
                cleanups.set(id, cleanup);
            }
            catch (error) {
                const errBox = document.createElement('div');
                errBox.style.color = '#e06666';
                errBox.style.padding = '8px';
                errBox.style.whiteSpace = 'pre-wrap';
                errBox.textContent = `页签「${def.title}」加载失败：\n${error instanceof Error ? error.message : String(error)}`;
                content.appendChild(errBox);
            }
        }
        switchTo(activeId);
    }

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
    /** 中文（CJK）字符判断：平假名/片假名、CJK 统一汉字与扩展 A、兼容汉字、全角形式 */
    function isCJKChar(ch) {
        const code = ch.codePointAt(0) ?? 0;
        return ((code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点（，。？！）
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
    function estimateTokens(text) {
        if (!text)
            return 0;
        const CJK_TOKEN_UNITS = 1 / 1.5; // 每个 CJK 字符折算的 token
        const LATIN_TOKEN_UNITS = 1 / 3; // 每个拉丁字符折算的 token
        let units = 0;
        for (const ch of text) {
            units += isCJKChar(ch) ? CJK_TOKEN_UNITS : LATIN_TOKEN_UNITS;
        }
        return Math.ceil(units);
    }
    /** 安全字符串取值：非字符串一律返回 ''，避免引用崩溃。 */
    function safeStr(v) {
        return typeof v === 'string' ? v : '';
    }
    /**
     * 取宿主上下文并判空。
     * 复用 host-compat 的统一入口，所有异常在内部吞掉返回 undefined。
     */
    function loadCtx() {
        try {
            return getHostContext();
        }
        catch {
            return undefined;
        }
    }
    /** 顶层全局对象（Node/vitest 下等同 globalThis，浏览器下为 window）。 */
    function getGlobal() {
        try {
            return globalThis.window ?? globalThis;
        }
        catch {
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
    async function resolveCurrentCharacter(ctx) {
        if (!ctx)
            return undefined;
        const g = getGlobal();
        try {
            // 候选角色数组（容忍异步 getCharacters）
            const arrays = [];
            const push = (a) => {
                if (Array.isArray(a) && a.length > 0)
                    arrays.push(a);
            };
            push(ctx.characters);
            push(g?.characters);
            try {
                push(await ctx.getCharacters?.());
            }
            catch {
                /* 某些宿主 getCharacters 会抛错，忽略 */
            }
            // 1) 按 this_chid / characterId 索引取（新式酒馆的主要路径）
            const idx = Number(ctx.characterId ?? ctx.this_chid);
            if (Number.isFinite(idx) && idx >= 0) {
                for (const arr of arrays) {
                    const ch = arr[idx];
                    if (ch && typeof ch === 'object')
                        return await deepFill(ctx, ch);
                }
            }
            const name = safeStr(ctx.name2);
            // 2) 旧式 ctx.getCharacter(name)（上游 SillyTavern 兼容）
            if (name && typeof ctx.getCharacter === 'function') {
                const ch = ctx.getCharacter(name);
                if (ch && typeof ch === 'object')
                    return ch;
            }
            // 3) 按 name2 名称匹配（this_chid 无效时的新式兜底）
            if (name) {
                for (const arr of arrays) {
                    const ch = arr.find((c) => c && safeStr(c.name) === name);
                    if (ch)
                        return await deepFill(ctx, ch);
                }
            }
            // 4) 全局 getCharacter('current')（上游/旧酒馆兼容）
            if (typeof g?.getCharacter === 'function') {
                const ch = g.getCharacter('current');
                if (ch && typeof ch === 'object')
                    return ch;
            }
            // 5) 直接暴露的当前角色对象（部分宿主/适配层）
            if (ctx.character && typeof ctx.character === 'object')
                return ctx.character;
            // 6) 单角色兜底：数组只有一个角色时即视为当前
            for (const arr of arrays) {
                if (arr.length === 1) {
                    const ch = arr[0];
                    if (ch && typeof ch === 'object')
                        return await deepFill(ctx, ch);
                }
            }
        }
        catch {
            /* 任何异常视为解析失败 */
        }
        return undefined;
    }
    /** 判断角色对象是否已带真实内容（避免多余的深读网络请求）。 */
    function hasRealContent(char) {
        if (!char)
            return false;
        return ((typeof char.description === 'string' && char.description.trim() !== '') ||
            (typeof char.personality === 'string' && char.personality.trim() !== '') ||
            (typeof char.scenario === 'string' && char.scenario.trim() !== '') ||
            hasBookEntries(char));
    }
    /** 判断角色对象是否已带世界书条目（兼容 v2 扁平与 data.character_book 两种位置）。 */
    function hasBookEntries(char) {
        const book = char?.character_book ?? char?.data?.character_book;
        return !!(book && typeof book === 'object' && Array.isArray(book.entries) && book.entries.length > 0);
    }
    /**
     * 浅层角色深度补全：角色列表项可能只带 name/avatar（shallow），此时
     * ctx.getOneCharacter(avatar)（新式酒馆）会拉取完整角色卡并**就地替换**
     * characters[avatar 对应下标]，但函数本身不返回结果 —— 因此调用后再从
     * 候选角色数组中按 avatar 重取完整对象。补全失败或接口缺失时原样返回浅层对象。
     */
    async function deepFill(ctx, char) {
        try {
            const avatar = safeStr(char?.avatar);
            if (hasRealContent(char) || !avatar || typeof ctx?.getOneCharacter !== 'function') {
                return char;
            }
            await ctx.getOneCharacter(avatar);
            const g = getGlobal();
            const sources = [];
            const push = (a) => {
                if (Array.isArray(a))
                    sources.push(a);
            };
            push(ctx?.characters);
            push(g?.characters);
            for (const arr of sources) {
                const full = arr.find((c) => c && safeStr(c.avatar) === avatar);
                if (full && typeof full === 'object')
                    return full;
            }
        }
        catch {
            /* 保持浅层 */
        }
        return char;
    }
    /** 从角色对象读取人设字段（逐字段判空，缺失输出空字符串）。 */
    function readCharacterFields(char) {
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
    function readWorldbookEntries(ctx, char) {
        const entries = [];
        try {
            let book;
            if (typeof ctx?.getCharacterBook === 'function') {
                book = ctx.getCharacterBook();
            }
            else if (char?.character_book && typeof char.character_book === 'object') {
                book = char.character_book;
            }
            else if (char?.data?.character_book && typeof char.data.character_book === 'object') {
                book = char.data.character_book;
            }
            else if (typeof char?.getCharacterBook === 'function') {
                book = char.getCharacterBook();
            }
            else if (ctx?.characterBook && Array.isArray(ctx.characterBook.entries)) {
                book = ctx.characterBook;
            }
            if (book && Array.isArray(book?.entries)) {
                for (const e of book.entries) {
                    if (!e)
                        continue;
                    const content = safeStr(e.content);
                    entries.push({
                        uid: e.uid ?? -1,
                        comment: safeStr(e.comment),
                        content,
                        tokenEstimate: estimateTokens(content),
                    });
                }
            }
        }
        catch {
            /* 世界书读取失败则返回空列表 */
        }
        return entries;
    }
    /**
     * 读取当前角色卡完整材料包。
     * 上下文不可用 / 找不到角色时返回 { error }（此时绝不下发生成请求）。
     */
    async function readCurrentCharacterMaterial() {
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
                error: `未找到当前角色卡。诊断：name2=${JSON.stringify(ctx.name2)}，` +
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
    function totalEstimate(m) {
        return (estimateTokens(m.name) +
            estimateTokens(m.description) +
            estimateTokens(m.personality) +
            estimateTokens(m.scenario) +
            estimateTokens(m.firstMessage) +
            m.worldbookEntries.reduce((sum, e) => sum + e.tokenEstimate, 0));
    }
    /** 深度截断：把 text 截断到其估算不超过 maxTokens 的最长前缀。 */
    function truncateTextToTokens(text, maxTokens) {
        if (maxTokens <= 0)
            return '';
        if (estimateTokens(text) <= maxTokens)
            return text;
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (estimateTokens(text.slice(0, mid)) <= maxTokens)
                lo = mid;
            else
                hi = mid - 1;
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
    function trimMaterialToBudget(material, budgetTokens) {
        const budget = Math.max(0, Math.floor(budgetTokens));
        // 深拷贝，避免修改调用方对象
        const out = {
            ...material,
            description: material.description,
            personality: material.personality,
            scenario: material.scenario,
            firstMessage: material.firstMessage,
            worldbookEntries: material.worldbookEntries.map((e) => ({ ...e })),
        };
        // 预算足以容纳全部（含无穷大），原样返回
        if (totalEstimate(out) <= budget)
            return out;
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
            const fixed = estimateTokens(out.name) + estimateTokens(out.scenario) + estimateTokens(out.firstMessage) +
                out.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
            const coreBudget = Math.max(0, budget - fixed);
            const descTokens = estimateTokens(out.description);
            const persTokens = estimateTokens(out.personality);
            const cpTotal = descTokens + persTokens;
            if (coreBudget <= 0) {
                out.description = '';
                out.personality = '';
            }
            else if (cpTotal > coreBudget) {
                // 按两者占比分配核心预算
                const descShare = cpTotal > 0 ? descTokens / cpTotal : 0.5;
                out.description = truncateTextToTokens(out.description, Math.floor(coreBudget * descShare));
                const remainingCore = coreBudget - estimateTokens(out.description);
                out.personality = truncateTextToTokens(out.personality, Math.max(0, remainingCore));
            }
        }
        return out;
    }

    /** 当前被选中的世界书条目 uid 集合 */
    const selected = new Set();
    /** 是否已初始化过选择状态（读到过至少一次材料包） */
    let bound = false;
    /** 归一化条目选择键：优先 uid，其次 comment，最后下标占位。 */
    function keyOf(entry) {
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
    function bindEntrySelection(entries) {
        selected.clear();
        for (const entry of entries) {
            selected.add(keyOf(entry));
        }
        bound = true;
    }
    /** 设置某条目的选中状态。 */
    function setEntrySelected(entry, on) {
        const key = keyOf(entry);
        if (on)
            selected.add(key);
        else
            selected.delete(key);
    }
    /** 查询某条目是否选中。 */
    function isEntrySelected(entry) {
        if (!bound)
            return true;
        return selected.has(keyOf(entry));
    }
    /** 全选 / 全不选。 */
    function setAllEntriesSelected(entries, on) {
        for (const entry of entries) {
            setEntrySelected(entry, on);
        }
        bound = true;
    }
    /** 返回被勾选条目的数量。 */
    function countSelected(entries) {
        if (!bound)
            return entries.length;
        return entries.filter((e) => selected.has(keyOf(e))).length;
    }
    /**
     * 按当前选择过滤条目（未初始化时原样返回）。
     * @param entries 裁剪后的条目列表
     */
    function filterBySelection(entries) {
        if (!bound)
            return entries;
        return entries.filter((e) => selected.has(keyOf(e)));
    }

    /**
     * src/ui/tabs/material-tab.ts — 「材料包」面板页签（Task 2/7）
     *
     * 面板功能：一个「读取当前角色卡」按钮；读取成功后按素材分区展示
     * （名称/描述/性格/场景/开场白/世界书列表），每区带 token 估算与展开/折叠，
     * 世界书条目用 <details> 折叠；读取失败时显示醒目的红色错误文案。
     *
     * 关键约定：本模块没有任何 LLM 生成逻辑，读取失败时仅展示错误提示，
     * 天然满足“失败不触发生成请求”。样式内联/前缀 stml-，不引外部 CSS。
     */
    /** 注入的面板样式唯一 id，避免重复插入 */
    const STYLE_ID$3 = 'stml-material-style';
    function ensureStyle$3(doc) {
        if (doc.getElementById(STYLE_ID$3))
            return;
        const style = doc.createElement('style');
        style.id = STYLE_ID$3;
        style.textContent = `
    .stml-material { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-material button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-material button:hover { background: #35353f; }
    .stml-material .stml-meta { margin-top: 8px; font-size: 12px; color: #9a9aa4; }
    .stml-material .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; }
    .stml-material .stml-hint { margin-top: 8px; color: #b0b0ba; }
    .stml-material .stml-section {
      margin-top: 12px; padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02);
    }
    .stml-material details > summary { cursor: pointer; list-style: none; }
    .stml-material details > summary::-webkit-details-marker { display: none; }
    .stml-material .stml-label { font-weight: 600; }
    .stml-material .stml-tokens { color: #7fb3d5; font-size: 12px; margin-left: 6px; }
    .stml-material .stml-content {
      margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: rgba(0,0,0,0.25);
      white-space: pre-wrap; word-break: break-word; font-size: 12px;
    }
    .stml-material .stml-empty { color: #8a8a94; font-style: italic; }
    .stml-material .stml-omitted { color: #d9a451; font-size: 12px; }
  `;
        (doc.head ?? doc.documentElement).appendChild(style);
    }
    /** 便捷节点创建 */
    function el$3(doc, tag, className) {
        const node = doc.createElement(tag);
        if (className)
            node.className = className;
        return node;
    }
    /**
     * 渲染一个带 token 估算与展开/折叠的素材分区。
     * 无内容时显示“（空）”。
     */
    function buildSection(doc, title, content, tokenEstimate) {
        const section = el$3(doc, 'details', 'stml-section');
        const summary = el$3(doc, 'summary');
        const label = el$3(doc, 'span', 'stml-label');
        label.textContent = title;
        summary.appendChild(label);
        const tokens = el$3(doc, 'span', 'stml-tokens');
        tokens.textContent = `≈ ${tokenEstimate} token`;
        summary.appendChild(tokens);
        const body = el$3(doc, 'div', 'stml-content');
        if (content) {
            body.textContent = content;
        }
        else {
            body.textContent = '';
            body.appendChild(el$3(doc, 'span', 'stml-empty')).textContent = '（空）';
        }
        section.appendChild(summary);
        section.appendChild(body);
        return section;
    }
    /**
     * 渲染世界书条目列表：每条一个 <details>，标题为 #uid + comment + token 估算，
     * 内容为条目正文；被裁剪（content 为空但 comment 保留）时显示"已略去"。
     *
     * 1.13+ 主流写法把主要内容集中写在世界书，因此每条提供「注入主线设计」勾选框，
     * 用户可挑选哪些条目真正进入后续生成（选择状态存 shared/material-selection）。
     * @param onChanged 勾选变化后回调（用于刷新选择计数视图）
     */
    function buildWorldbookSection(doc, material, onChanged) {
        const section = el$3(doc, 'div', 'stml-section');
        const title = el$3(doc, 'div', 'stml-label');
        const wbTokens = material.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
        title.textContent = `世界书（${material.worldbookEntries.length} 条）`;
        const tokens = el$3(doc, 'span', 'stml-tokens');
        tokens.textContent = `≈ ${wbTokens} token`;
        title.appendChild(tokens);
        section.appendChild(title);
        if (material.worldbookEntries.length === 0) {
            const empty = el$3(doc, 'div', 'stml-empty');
            empty.textContent = '（无世界书条目）';
            section.appendChild(empty);
            return section;
        }
        // 选择控制区：已选计数 + 全选 / 全不选
        const selectBar = el$3(doc, 'div', 'stml-meta');
        const countSpan = el$3(doc, 'span');
        const refreshCount = () => {
            countSpan.textContent = `已选 ${countSelected(material.worldbookEntries)}/${material.worldbookEntries.length} 条（未勾选的内容不会注入主线设计）`;
        };
        refreshCount();
        selectBar.appendChild(countSpan);
        const makeToggleAll = (on) => {
            const btn = el$3(doc, 'button');
            btn.textContent = on ? '全选' : '全不选';
            btn.style.marginLeft = '8px';
            btn.style.padding = '2px 8px';
            btn.addEventListener('click', () => {
                setAllEntriesSelected(material.worldbookEntries, on);
                refreshCount();
                onChanged();
            });
            return btn;
        };
        selectBar.appendChild(makeToggleAll(true));
        selectBar.appendChild(makeToggleAll(false));
        section.appendChild(selectBar);
        for (const entry of material.worldbookEntries) {
            const row = el$3(doc, 'div');
            row.style.display = 'flex';
            row.style.alignItems = 'flex-start';
            row.style.gap = '6px';
            const checkbox = doc.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isEntrySelected(entry);
            checkbox.style.marginTop = '2px';
            checkbox.addEventListener('change', () => {
                setEntrySelected(entry, checkbox.checked);
                refreshCount();
                onChanged();
            });
            const details = el$3(doc, 'details');
            const summary = el$3(doc, 'summary');
            const heading = el$3(doc, 'span', 'stml-label');
            heading.textContent = `#${String(entry.uid)} ${entry.comment || '（无注释）'}`;
            summary.appendChild(heading);
            const et = el$3(doc, 'span', 'stml-tokens');
            et.textContent = `≈ ${entry.tokenEstimate} token`;
            summary.appendChild(et);
            details.appendChild(summary);
            if (entry.content) {
                const body = el$3(doc, 'div', 'stml-content');
                body.textContent = entry.content;
                details.appendChild(body);
            }
            else {
                const omitted = el$3(doc, 'div', 'stml-omitted');
                omitted.textContent = '已略去（超出材料包预算）';
                details.appendChild(omitted);
            }
            row.appendChild(checkbox);
            row.appendChild(details);
            section.appendChild(row);
        }
        return section;
    }
    /**
     * 渲染读取成功的材料包分区。名称直接作为标题展示，其余用分区折叠。
     * @param onChanged 世界书勾选变化后回调（用于整体刷新选择计数）
     */
    function renderMaterial(doc, material, onChanged) {
        const root = el$3(doc, 'div');
        const heading = el$3(doc, 'div', 'stml-label');
        heading.textContent = `当前角色：${material.name || '（未命名）'}`;
        root.appendChild(heading);
        root.appendChild(buildSection(doc, '描述', material.description, estimateTokens(material.description)));
        root.appendChild(buildSection(doc, '性格', material.personality, estimateTokens(material.personality)));
        root.appendChild(buildSection(doc, '场景', material.scenario, estimateTokens(material.scenario)));
        root.appendChild(buildSection(doc, '开场白', material.firstMessage, estimateTokens(material.firstMessage)));
        root.appendChild(buildWorldbookSection(doc, material, onChanged));
        return root;
    }
    /**
     * 挂载材料包页签。
     * 面板固定：按钮 + 提示区 + 结果区；读取失败仅展示黄色/红色错误，不触发生成。
     * 读取成功后绑定世界书条目选择（shared/material-selection），勾选的条目才会
     * 进入「主线设计」生成。
     */
    function mountMaterialTab(container) {
        const doc = container.ownerDocument ?? document;
        ensureStyle$3(doc);
        const root = el$3(doc, 'div', 'stml-material');
        const bar = el$3(doc, 'div');
        const readBtn = el$3(doc, 'button');
        readBtn.textContent = '读取当前角色卡';
        bar.appendChild(readBtn);
        root.appendChild(bar);
        const status = el$3(doc, 'div');
        root.appendChild(status);
        const result = el$3(doc, 'div');
        root.appendChild(result);
        const hint = el$3(doc, 'div', 'stml-hint');
        hint.textContent = '读取角色卡人设与世界观材料包供「主线设计」使用；世界书条目可勾选注入，读取失败仅提示，不会发起任何生成请求。';
        root.appendChild(hint);
        // 本次读取到的材料包缓存，供勾选变化后整体刷新视图
        let lastMaterial = null;
        const refreshView = () => {
            result.textContent = '';
            if (!lastMaterial)
                return;
            const meta = el$3(doc, 'div', 'stml-meta');
            const total = estimateTokens(lastMaterial.name) +
                estimateTokens(lastMaterial.description) + estimateTokens(lastMaterial.personality) +
                estimateTokens(lastMaterial.scenario) + estimateTokens(lastMaterial.firstMessage) +
                lastMaterial.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
            meta.textContent = `材料包合计约 ${total} token；勾选变化会实时反映到「设计」页签的生成内容。`;
            result.appendChild(meta);
            result.appendChild(renderMaterial(doc, lastMaterial, refreshView));
        };
        const renderError = (message) => {
            status.textContent = '';
            const err = el$3(doc, 'div', 'stml-error');
            err.textContent = `读取失败：${message}`;
            status.appendChild(err);
            result.textContent = '';
            lastMaterial = null;
        };
        readBtn.addEventListener('click', () => {
            status.textContent = '';
            result.textContent = '';
            const loading = el$3(doc, 'div', 'stml-hint');
            loading.textContent = '正在读取角色卡材料…';
            status.appendChild(loading);
            // 异步读取；完成后再渲染或报错（绝不在失败路径触发生成请求）
            void readCurrentCharacterMaterial().then((res) => {
                status.textContent = '';
                if ('error' in res) {
                    renderError(res.error);
                    console.warn(`[主线设计] 材料包读取失败：${res.error}`);
                    return;
                }
                // 绑定世界书条目选择（默认全选），供「设计」页签过滤注入内容
                if (res.worldbookEntries.length > 0) {
                    bindEntrySelection(res.worldbookEntries);
                }
                lastMaterial = res;
                refreshView();
            });
        });
        container.replaceChildren(root);
    }
    /** 注册材料包页签 */
    registerTab({ id: 'material', title: '材料包', mount: mountMaterialTab });

    /**
     * src/core/llm.ts — LLM API 配置与调用（OpenAI 兼容）
     *
     * 本模块负责：
     *   - 从 loadSettings() 读取 baseURL / model / key / temperature / maxTokens；
     *   - 向 {baseURL}/chat/completions 发起 OpenAI 兼容的 chat 请求；
     *   - 错误归一化：网络错误 / 超时 / HTTP 非 2xx / JSON 异常 / 空内容
     *     统一转为带错误码（LLMError.code）的中文 Error；
     *   - callLLMWithRetry 对「传输类错误」（超时、网络）自动重试（指数退避），
     *     对模型拒绝 / 4xx 等业务错误不做重试；
     *   - testConnection 用最小请求验证配置可用性。
     *
     * 可测试性：全部网络逻辑走可注入的 fetch（opts.fetchImpl 或模块级 defaultFetch），
     * 单测可注入 fake fetch 而不真实发包。
     */
    /** 默认请求超时（毫秒）：120 秒 */
    const DEFAULT_TIMEOUT_MS = 120000;
    /** 重试基础间隔（毫秒）：1 秒起，指数退避 */
    const RETRY_BASE_DELAY_MS = 1000;
    /** 带错误码的中文错误，便于 UI 与重试逻辑区分 */
    class LLMError extends Error {
        constructor(code, message) {
            super(message);
            Object.defineProperty(this, "code", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            this.name = 'LLMError';
            this.code = code;
        }
    }
    /** 模块级可替换的 fetch 实现（默认用全局 fetch；无全局 fetch 时抛网络错误） */
    let defaultFetch = typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : (() => {
            throw new LLMError('LLM_NETWORK_ERROR', '当前环境没有可用的 fetch 实现');
        });
    /** 校验并取回当前生效的 fetch 实现 */
    function resolveFetch(impl) {
        const f = impl ?? defaultFetch;
        if (typeof f !== 'function') {
            throw new LLMError('LLM_NETWORK_ERROR', '当前环境没有可用的 fetch 实现');
        }
        return f;
    }
    /** 判断是否为「可重试」的传输类错误（超时 / 网络） */
    function isRetryableCode(code) {
        return code === 'LLM_TIMEOUT' || code === 'LLM_NETWORK_ERROR';
    }
    /** 判断一个异常是否属于可重试的传输类错误 */
    function isRetryableError(err) {
        return err instanceof LLMError && isRetryableCode(err.code);
    }
    /** 休眠工具（供重试退避使用） */
    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
    /**
     * 调用 OpenAI 兼容的 LLM 接口，返回模型回答文本。
     *
     * 配置全部来自 loadSettings()：baseURL、model、apiKey、apiTemperature、
     * apiMaxTokens（后两者可被 opts 覆盖）。
     *
     * @throws {LLMError} 携带 LLMErrorCode 的中文错误：
     *   - LLM_TIMEOUT      超时
     *   - LLM_NETWORK_ERROR 网络错误
     *   - LLM_HTTP_ERROR    HTTP 非 2xx
     *   - LLM_INVALID_RESPONSE 响应不是合法 JSON
     *   - LLM_EMPTY_RESPONSE   返回内容为空
     */
    async function callLLM(messages, opts = {}) {
        const settings = loadSettings();
        const baseURL = (settings.apiBaseUrl || '').replace(/\/+$/, '');
        const url = `${baseURL}/chat/completions`;
        const model = settings.apiModel;
        const temperature = opts.temperature ?? settings.apiTemperature;
        const maxTokens = opts.maxTokens ?? settings.apiMaxTokens;
        const fetchImpl = resolveFetch(opts.fetchImpl);
        // 超时控制：外部 signal 优先；否则内置 AbortController + 默认超时
        const useExternalSignal = opts.signal != null;
        const controller = new AbortController();
        const signal = useExternalSignal ? opts.signal : controller.signal;
        let timer;
        if (!useExternalSignal) {
            timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        }
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // key 为空时也照常发送，由服务端决定校验策略
                    Authorization: `Bearer ${settings.apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                }),
                signal,
            });
            if (!res.ok) {
                let detail = '';
                try {
                    detail = (await res.text?.()) ?? '';
                }
                catch {
                    // 读取失败不影响错误码判断
                }
                const trim = detail.trim().slice(0, 200);
                throw new LLMError('LLM_HTTP_ERROR', `接口返回异常（HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}）` +
                    (trim ? `：${trim}` : ''));
            }
            let data;
            try {
                data = await res.json();
            }
            catch (e) {
                throw new LLMError('LLM_INVALID_RESPONSE', '接口响应不是合法的 JSON');
            }
            const content = data?.choices?.[0]
                ?.message?.content;
            if (typeof content !== 'string' || content.trim() === '') {
                throw new LLMError('LLM_EMPTY_RESPONSE', '模型返回的内容为空');
            }
            return content;
        }
        catch (err) {
            // 已归一化的业务错误（HTTP / JSON / 空内容）原样抛出；
            // 其余（fetch 的 AbortError、TypeError 等）一律归为传输类错误。
            if (err instanceof LLMError)
                throw err;
            // 我们的超时计时器触发的中止 → 超时；其余 → 网络错误
            const abortedByUs = signal.aborted && !useExternalSignal;
            if (abortedByUs) {
                throw new LLMError('LLM_TIMEOUT', '请求超时（120 秒内未返回）');
            }
            throw new LLMError('LLM_NETWORK_ERROR', '网络错误：无法连接到 LLM 服务');
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /**
     * 带重试的 LLM 调用。
     *
     * 仅对「传输类错误」（超时 / 网络）自动重试，间隔 1s 起指数退避；
     * 模型返回 4xx / 其他业务错误（HTTP / JSON / 空内容）时不重试，直接抛出。
     */
    async function callLLMWithRetry(messages, opts = {}, retries = 2) {
        let attempt = 0;
        for (;;) {
            try {
                return await callLLM(messages, opts);
            }
            catch (err) {
                if (!isRetryableError(err) || attempt >= retries) {
                    throw err;
                }
                attempt += 1;
                // 指数退避：1s、2s、4s……
                await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
            }
        }
    }
    /**
     * 测试连接：用最小请求（"ping"）验证当前配置是否可用。
     *
     * 成功返回 { ok: true, model: 当前配置的模型 }；
     * 失败返回 { ok: false, message: 中文错误说明 }。
     */
    async function testConnection() {
        try {
            await callLLM([{ role: 'user', content: 'ping' }], { temperature: 0, maxTokens: 1 });
            return { ok: true, model: loadSettings().apiModel };
        }
        catch (err) {
            return { ok: false, message: describeError(err) };
        }
    }
    /** 把未知异常整理成中文说明文案 */
    function describeError(err) {
        if (err instanceof Error)
            return err.message;
        return String(err);
    }

    /**
     * src/ui/tabs/api-tab.ts — 「API 配置」页签
     *
     * 提供 LLM API 配置表单：baseURL / model / apiKey(password) / temperature /
     * maxTokens，以及「保存设置」「测试连接」「恢复默认」三个按钮。
     *
     * 数据读写全部走 loadSettings() / saveSettings()，不直接碰 window；保存时
     * 校验 baseURL / model 必填（空则提示并拒绝保存）。UI 文案为中文。
     */
    /** 表单字段定义（顺序即渲染顺序） */
    const FIELD_SPECS = [
        { key: 'apiBaseUrl', label: '接口地址 Base URL', type: 'text', hint: '例如 https://api.openai.com/v1' },
        { key: 'apiModel', label: '模型 Model', type: 'text', hint: '例如 gpt-4o-mini' },
        { key: 'apiKey', label: 'API Key', type: 'password', hint: '留空则由服务端决定' },
        { key: 'apiTemperature', label: '温度 Temperature', type: 'range', min: '0', max: '1', step: '0.1', hint: '0（稳重）～ 1（天马行空）' },
        { key: 'apiMaxTokens', label: '最大 Token 数', type: 'text', hint: '单次回复的最大 token 上限' },
    ];
    /** 组装表单 DOM。formInputs 以 key 为键登记各输入控件 */
    function buildForm(formEl) {
        const inputs = new Map();
        for (const spec of FIELD_SPECS) {
            const row = document.createElement('label');
            row.style.display = 'block';
            row.style.marginBottom = '10px';
            row.style.fontSize = '13px';
            const caption = document.createElement('span');
            caption.textContent = spec.label;
            caption.style.display = 'block';
            caption.style.marginBottom = '4px';
            caption.style.fontWeight = 'bold';
            row.appendChild(caption);
            const input = document.createElement('input');
            input.type = spec.type;
            if (spec.step)
                input.step = spec.step;
            if (spec.min)
                input.min = spec.min;
            if (spec.max)
                input.max = spec.max;
            input.style.width = '100%';
            input.style.boxSizing = 'border-box';
            input.style.padding = '6px 8px';
            input.style.borderRadius = '4px';
            input.style.border = '1px solid #3a3a40';
            input.style.background = 'rgba(0,0,0,0.25)';
            input.style.color = '#e8e8ec';
            row.appendChild(input);
            if (spec.hint) {
                const hint = document.createElement('span');
                hint.textContent = spec.hint;
                hint.style.display = 'block';
                hint.style.fontSize = '12px';
                hint.style.opacity = '0.65';
                hint.style.marginTop = '2px';
                row.appendChild(hint);
            }
            formEl.appendChild(row);
            inputs.set(spec.key, input);
        }
        return inputs;
    }
    /** 用设置对象回填表单控件 */
    function fillForm(inputs, s) {
        inputs.get('apiBaseUrl').value = s.apiBaseUrl;
        inputs.get('apiModel').value = s.apiModel;
        inputs.get('apiKey').value = s.apiKey;
        inputs.get('apiTemperature').value = String(s.apiTemperature);
        inputs.get('apiMaxTokens').value = String(s.apiMaxTokens);
    }
    /** 收集表单值并校验必填；不合法时返回 null 并提示 */
    function collectForm(inputs, feedback) {
        const baseUrl = inputs.get('apiBaseUrl').value.trim();
        const model = inputs.get('apiModel').value.trim();
        if (!baseUrl) {
            feedback.textContent = '请先填写「接口地址 Base URL」。';
            feedback.style.color = '#e5484d';
            return null;
        }
        if (!model) {
            feedback.textContent = '请先填写「模型 Model」。';
            feedback.style.color = '#e5484d';
            return null;
        }
        const current = loadSettings();
        return {
            ...current,
            apiBaseUrl: baseUrl,
            apiModel: model,
            apiKey: inputs.get('apiKey').value,
            apiTemperature: clampTemperature(parseFloat(inputs.get('apiTemperature').value)),
            apiMaxTokens: Math.max(1, Math.round(parseInt(inputs.get('apiMaxTokens').value, 10) || 0)),
        };
    }
    /** 温度限制在 [0,1] 且为 0.1 步进 */
    function clampTemperature(v) {
        if (Number.isNaN(v))
            return DEFAULT_SETTINGS.apiTemperature;
        return Math.min(1, Math.max(0, Math.round(v * 10) / 10));
    }
    /** 给按钮设置通用样式 */
    function styleButton(btn) {
        btn.style.padding = '6px 12px';
        btn.style.cursor = 'pointer';
        btn.style.borderRadius = '4px';
        btn.style.border = '1px solid #3a3a40';
        btn.style.background = 'rgba(255,255,255,0.08)';
        btn.style.color = '#e8e8ec';
    }
    /**
     * 「API 配置」页签挂载入口：渲染表单并把「保存设置 / 测试连接 / 恢复默认」
     * 三个按钮的事件接好。返回清理函数（此实现无资源需要清理，仅做占位）。
     */
    function mountApiTab(container) {
        container.textContent = '';
        // 表单容器
        const formEl = document.createElement('form');
        formEl.style.display = 'flex';
        formEl.style.flexDirection = 'column';
        formEl.style.gap = '4px';
        container.appendChild(formEl);
        // 反馈区（保存 / 测试连接结果展示）
        const feedback = document.createElement('div');
        feedback.style.marginTop = '8px';
        feedback.style.fontSize = '13px';
        feedback.style.minHeight = '18px';
        container.appendChild(feedback);
        const inputs = buildForm(formEl);
        fillForm(inputs, loadSettings());
        // 按钮行
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
        actions.style.marginTop = '8px';
        container.appendChild(actions);
        // 保存设置
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = '保存设置';
        styleButton(saveBtn);
        saveBtn.addEventListener('click', () => {
            const next = collectForm(inputs, feedback);
            if (!next)
                return;
            saveSettings(next);
            feedback.textContent = '设置已保存。';
            feedback.style.color = '#46a758';
        });
        actions.appendChild(saveBtn);
        // 测试连接
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.textContent = '测试连接';
        styleButton(testBtn);
        testBtn.addEventListener('click', async () => {
            // 测试前先按当前表单校验必填项（仅提示，不落盘）
            const next = collectForm(inputs, feedback);
            if (!next)
                return;
            feedback.textContent = '正在测试连接…';
            feedback.style.color = '#8a8a92';
            const result = await testConnection();
            if (result.ok) {
                feedback.textContent = `连接成功，当前模型：${result.model}。`;
                feedback.style.color = '#46a758';
            }
            else {
                feedback.textContent = `连接失败：${result.message}`;
                feedback.style.color = '#e5484d';
            }
        });
        actions.appendChild(testBtn);
        // 恢复默认
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.textContent = '恢复默认';
        styleButton(resetBtn);
        resetBtn.addEventListener('click', () => {
            // 恢复默认仅回填表单，不自动落盘，由用户按「保存设置」确认
            fillForm(inputs, DEFAULT_SETTINGS);
            feedback.textContent = '已恢复默认值，点击「保存设置」生效。';
            feedback.style.color = '#8a8a92';
        });
        actions.appendChild(resetBtn);
        // 阻止表单原生提交（避免刷新页面）
        formEl.addEventListener('submit', (e) => e.preventDefault());
    }
    // 注册页签（id 用 'api'，与面板约定一致）
    registerTab({ id: 'api', title: 'API 配置', mount: mountApiTab });

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
    const MAINLINE_SCHEMA_VERSION = '1.0.0';
    /** 卷数量合法下限 / 上限（短/中/长期主线都不少于 3 卷，不超过 8 卷） */
    const VOLUME_COUNT_MIN = 3;
    const VOLUME_COUNT_MAX = 8;
    /** 非空字符串判断（string 且 trim 后非空） */
    function isNonEmpty(v) {
        return typeof v === 'string' && v.trim().length > 0;
    }
    /** 卷数量是否在合法区间 3–8 */
    function validateVolumeCount(count) {
        return Number.isInteger(count) && count >= VOLUME_COUNT_MIN && count <= VOLUME_COUNT_MAX;
    }
    /**
     * 规范化卷数量：
     *   - 提供了 short/medium/long 计划时，按档位取默认值；
     *   - 计划为 custom 或未提供计划时，优先采用合法（3–8）的 requested；
     *   - 都无法得到合法值时回落到默认 4。
     */
    function normalizeVolumeCount(requested, plan) {
        const FALLBACK = 4;
        if (plan === 'short')
            return VOLUME_COUNT_MIN; // 3
        if (plan === 'medium')
            return 4;
        if (plan === 'long')
            return 6;
        if (plan === 'custom') {
            return requested !== undefined && validateVolumeCount(requested) ? requested : FALLBACK;
        }
        // 未提供计划：合法则用 requested，否则回落默认
        if (requested !== undefined && validateVolumeCount(requested))
            return requested;
        return FALLBACK;
    }
    /** 校验 characterRef 块 */
    function checkCharacterRef(ref, errors) {
        const p = 'characterRef';
        if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
            errors.push({ path: p, message: 'characterRef 必须为对象 { name, materialTokenEstimate, generatedAt }' });
            return;
        }
        const o = ref;
        if (!isNonEmpty(o.name))
            errors.push({ path: `${p}.name`, message: '角色名称必填非空' });
        if (typeof o.materialTokenEstimate !== 'number' || !Number.isFinite(o.materialTokenEstimate)) {
            errors.push({ path: `${p}.materialTokenEstimate`, message: '材料 token 估算必须为有限数字' });
        }
        if (!isNonEmpty(o.generatedAt))
            errors.push({ path: `${p}.generatedAt`, message: '生成时间必填非空' });
    }
    /** 校验 story / 各 volume 公共必备字段（id/title/direction/escalation/withheld） */
    function checkArcFields(o, p, errors) {
        if (!isNonEmpty(o.id))
            errors.push({ path: `${p}.id`, message: 'ID 必填非空（如 story 用 ARC-STORY，卷用 VOL-01）' });
        if (!isNonEmpty(o.title))
            errors.push({ path: `${p}.title`, message: '标题必填非空' });
        if (!isNonEmpty(o.direction))
            errors.push({ path: `${p}.direction`, message: '方向（主目标/关键行动/副线/压力来源）必填非空' });
        if (!isNonEmpty(o.escalation))
            errors.push({ path: `${p}.escalation`, message: '升级与收束（微型完整弧）必填非空' });
        if (!isNonEmpty(o.withheld))
            errors.push({ path: `${p}.withheld`, message: '底牌保留（withheld）必填非空' });
    }
    /** 校验 story：必须是单个对象，不允许数组（全书方向全局唯一） */
    function checkStory(story, errors) {
        const p = 'story';
        if (typeof story !== 'object' || story === null || Array.isArray(story)) {
            errors.push({ path: p, message: 'story 必须为单个对象，全书方向全局仅一条，不使用数组' });
            return;
        }
        checkArcFields(story, p, errors);
    }
    /** 校验一个「非空字符串数组」字段（如 sustainingThreads / payoffTargets） */
    function checkStringArray(v, p, note, errors) {
        if (!Array.isArray(v)) {
            errors.push({ path: p, message: `${note}（应为非空字符串数组）` });
            return;
        }
        if (v.length === 0)
            errors.push({ path: p, message: note });
        v.forEach((s, i) => {
            if (!isNonEmpty(s))
                errors.push({ path: `${p}[${i}]`, message: '元素必须是非空字符串' });
        });
    }
    /** 校验 volumes：必须是 3–8 个对象的数组，逐卷严格校验 */
    function checkVolumes(volumes, errors) {
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
            const o = v;
            checkArcFields(o, pp, errors);
            if (!isNonEmpty(o.narrativeRole)) {
                errors.push({ path: `${pp}.narrativeRole`, message: '叙事职责（setup|development|escalation|turn|payoff|aftermath）必填非空' });
            }
            const r = o.targetStageRange;
            const rp = `${pp}.targetStageRange`;
            if (typeof r !== 'object' || r === null || Array.isArray(r)) {
                errors.push({ path: rp, message: 'targetStageRange 必须为对象 { min, max }' });
            }
            else {
                const rr = r;
                const min = typeof rr.min === 'number' ? rr.min : NaN;
                const max = typeof rr.max === 'number' ? rr.max : NaN;
                if (!Number.isFinite(min))
                    errors.push({ path: `${rp}.min`, message: 'min 必须为有限数字' });
                if (!Number.isFinite(max))
                    errors.push({ path: `${rp}.max`, message: 'max 必须为有限数字' });
                if (Number.isFinite(min) && min < 1)
                    errors.push({ path: `${rp}.min`, message: 'min 必须 >=1' });
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
    function validateMainlineDesign(raw) {
        const errors = [];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            return { ok: false, errors: [{ path: '$', message: '顶层必须是单个 JSON 对象' }] };
        }
        const obj = raw;
        if (!isNonEmpty(obj.schemaVersion)) {
            errors.push({ path: 'schemaVersion', message: 'schemaVersion 必填非空' });
        }
        else if (obj.schemaVersion !== MAINLINE_SCHEMA_VERSION) {
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
    function describeMissingFields(raw, errors) {
        const groups = new Map();
        for (const e of errors) {
            const idx = e.path.lastIndexOf('.');
            const parent = idx === -1 ? '$' : e.path.slice(0, idx);
            const field = idx === -1 ? e.path : e.path.slice(idx + 1);
            if (!groups.has(parent))
                groups.set(parent, new Set());
            groups.get(parent).add(field);
        }
        return [...groups.entries()].map(([path, set]) => ({ path, fields: [...set] }));
    }

    /** 校验/解析错误码常量 */
    const MAINLINE_INVALID_JSON = 'MAINLINE_INVALID_JSON';
    const MAINLINE_VALIDATION_FAILED = 'MAINLINE_VALIDATION_FAILED';
    /** 修补轮数上限 */
    const MAX_REPAIR_ROUNDS = 2;
    /**
     * 聚合错误：整体生成（含修补）失败时抛出，携带可供 UI 展示与用户手改的明细。
     */
    class MainlineGenerationError extends Error {
        constructor(code, message, extra) {
            super(message);
            Object.defineProperty(this, "code", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            Object.defineProperty(this, "missingFields", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            Object.defineProperty(this, "attempts", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            Object.defineProperty(this, "repairRounds", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            Object.defineProperty(this, "lastRaw", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            this.name = 'MainlineGenerationError';
            this.code = code;
            this.missingFields = extra.missingFields;
            this.attempts = extra.attempts;
            this.repairRounds = extra.repairRounds;
            this.lastRaw = extra.lastRaw;
        }
    }
    /**
     * 拼装「生成主线设计」的 system / user 提示词。
     * - system：方法论 —— 卷数区间、卷间序列三向自洽、卷内 direction/escalation/withheld
     *   的写法义务、禁止自创角色卡外实体、输出纯 JSON 单个对象。
     * - user：注入角色卡材料包 + 目标卷数 + MainlineDesign 结构契约。
     */
    function buildMainlinePrompt(material, opts = {}) {
        const volumeCount = normalizeVolumeCount(opts.volumeCount, opts.plan);
        const materialJson = JSON.stringify({
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
        }, null, 2);
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
            JSON.stringify({
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
            }, null, 2),
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
    function extractDesignJson(text) {
        const trimmed = text.trim();
        let candidate;
        const fenceJson = /```json\s*([\s\S]*?)```/i.exec(trimmed);
        if (fenceJson) {
            candidate = fenceJson[1].trim();
        }
        else {
            const fenceAny = /```[\s\S]*?```/i.exec(trimmed);
            if (fenceAny) {
                // 非 json 围栏：取围栏内首个 '{' .. 最后 '}'
                const inner = fenceAny[0].replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
                candidate = sliceJsonObject$1(inner) ?? inner;
            }
            else {
                candidate = sliceJsonObject$1(trimmed) ?? trimmed;
            }
        }
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new MainlineGenerationError(MAINLINE_INVALID_JSON, `[${MAINLINE_INVALID_JSON}] 无法把模型输出解析为 JSON：${why}。原文（截断）: ${truncate(trimmed)}`, { missingFields: [], attempts: 1, repairRounds: 0, lastRaw: trimmed });
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new MainlineGenerationError(MAINLINE_INVALID_JSON, `[${MAINLINE_INVALID_JSON}] 模型输出解析成功但不是单个 JSON 对象。原文（截断）: ${truncate(trimmed)}`, { missingFields: [], attempts: 1, repairRounds: 0, lastRaw: trimmed });
        }
        return parsed;
    }
    /** 截取首个 '{' 到最后一个 '}' 之间的子串；找不到返回 null */
    function sliceJsonObject$1(s) {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start === -1 || end <= start)
            return null;
        return s.slice(start, end + 1);
    }
    /** 长文本截断（用于错误信息附带上下文） */
    function truncate(s, max = 600) {
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
    async function generateMainline(material, opts = {}) {
        const llmOpts = {
            temperature: 0,
            fetchImpl: opts.fetchImpl,
            signal: opts.signal,
        };
        const prompt = buildMainlinePrompt(material, opts);
        let attempts = 0;
        let repairRounds = 0;
        let lastRaw = '';
        let lastErrors;
        let lastDesign = null;
        // 第 1 步：整份生成
        lastRaw = await callLLMWithRetry([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], llmOpts);
        attempts += 1;
        // 解析 + 校验 + 至多 2 轮修补
        for (;;) {
            let errors;
            try {
                const extracted = extractDesignJson(lastRaw);
                lastDesign = extracted;
                const vr = validateMainlineDesign(extracted);
                errors = vr.errors;
            }
            catch (e) {
                // JSON 解析失败：同样视为需修补（回喂要求输出合法 JSON）
                errors = [{ path: '$', message: e instanceof Error ? e.message : String(e) }];
            }
            lastErrors = errors;
            if (errors.length === 0)
                break;
            if (repairRounds >= MAX_REPAIR_ROUNDS)
                break;
            // 修补：构造回喂内容（含 previous JSON、errors 清单、缺失明细）
            repairRounds += 1;
            const repairUser = buildRepairUserContent(prompt, lastDesign, lastErrors);
            lastRaw = await callLLM([{ role: 'system', content: prompt.system }, { role: 'user', content: repairUser }], llmOpts);
            attempts += 1;
        }
        if (lastErrors.length > 0) {
            const missingFields = describeMissingFields(lastDesign, lastErrors);
            throw new MainlineGenerationError(MAINLINE_VALIDATION_FAILED, `[${MAINLINE_VALIDATION_FAILED}] 主线设计在 ${attempts} 次尝试（含 ${repairRounds} 轮修补）后仍未通过校验，请人工修正。` +
                `共 ${lastErrors.length} 项问题：${lastErrors.map((e) => e.message).join('；')}`, { missingFields, attempts, repairRounds, lastRaw });
        }
        // 校验通过：校正 characterRef（材料包 name 与 token 估算）
        const design = lastDesign;
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
    function estimateMaterialTokens(material) {
        return (estimateTokens(material.name) +
            estimateTokens(material.description) +
            estimateTokens(material.personality) +
            estimateTokens(material.scenario) +
            estimateTokens(material.firstMessage) +
            material.worldbookEntries.reduce((sum, e) => sum + estimateTokens(e.content), 0));
    }
    /** 构造修补轮的用户回喂内容（只要求输出修正后的完整 JSON） */
    function buildRepairUserContent(prompt, design, errors) {
        const missingGroups = describeMissingFields(design, errors);
        const lines = [];
        lines.push('你上一版输出的主线设计未通过严格校验。请修正下面的问题，然后重新输出【完整的】JSON 对象。');
        lines.push('只输出改正后的完整 MainlineDesign JSON，不要解释、不要只输出修改片段。');
        lines.push('');
        lines.push('【上一版输出】（若为 null 表示没能解析出合法 JSON 对象）');
        lines.push(design ? truncate(JSON.stringify(design), 4000) : '（null）');
        lines.push('');
        lines.push('【校验错误清单】');
        if (errors.length === 0)
            lines.push('（无，仅要求重新输出完整 JSON）');
        else
            errors.forEach((e) => lines.push(`  - ${e.path}: ${e.message}`));
        lines.push('');
        lines.push('【缺失/问题字段分组】');
        if (missingGroups.length === 0)
            lines.push('（无，仅要求重新输出完整 JSON）');
        else
            missingGroups.forEach((g) => lines.push(`  - ${g.path}: ${g.fields.join(', ')}`));
        lines.push('');
        lines.push('【原始生成任务】');
        lines.push(prompt.user);
        return lines.join('\n');
    }

    /** 把字符串数组按中文分号拼成一行；不是数组或空数组输出占位文案 */
    function list$1(items) {
        if (!Array.isArray(items) || items.length === 0)
            return '（无）';
        return items.map((s) => String(s)).join('；');
    }
    /** 安全的字符串取值，缺省/非字符串时输出占位，避免拼出 "undefined" */
    function str$1(v) {
        const s = typeof v === 'string' ? v : '';
        return s.trim();
    }
    /** 安全的阶段范围取值，非数字时回落给定默认；返回 "min – max" */
    function rangeStr$1(r, fallbackMin, fallbackMax) {
        const o = (typeof r === 'object' && r !== null ? r : {});
        const min = typeof o.min === 'number' ? o.min : fallbackMin;
        const max = typeof o.max === 'number' ? o.max : fallbackMax;
        return `${min} – ${max}`;
    }
    /**
     * 渲染主线设计为人类可读的中文 Markdown 文档。
     * 任何字段缺省时以占位/空串兜底，绝不抛错；入参不修改。
     */
    function renderDesignDoc(design) {
        const ref = (design?.characterRef ?? {});
        const story = design?.story;
        const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
        const lines = [];
        const title = str$1(story?.title) || '未命名主线';
        lines.push(`# 主线设计 · 《${title}》`);
        lines.push('');
        lines.push(`> 角色：${str$1(ref?.name) || '（未命名）'}｜生成时间：${str$1(ref?.generatedAt) || '（未知）'}`);
        lines.push('');
        lines.push('## 【全书方向】');
        lines.push(`- **方向（目标 / 对抗 / 代价 / 期待 / 终局保留）**：${str$1(story?.direction)}`);
        lines.push(`- **升级与收束**：${str$1(story?.escalation)}`);
        lines.push(`- **终局底牌保留**：${str$1(story?.withheld)}`);
        lines.push('');
        lines.push('## 【卷序列】');
        volumes.forEach((v, i) => {
            lines.push(`### 第 ${i + 1} 卷 · 《${str$1(v.title) || '未命名'}》`);
            lines.push(`- **叙事职责**：${str$1(v.narrativeRole)}`);
            lines.push(`- **阶段预期**：${rangeStr$1(v.targetStageRange, 0, 0)} 章`);
            lines.push(`- **目标 / 行动 / 副线 / 压力**：${str$1(v.direction)}`);
            lines.push(`- **本卷底牌（禁提前翻出）**：${str$1(v.withheld)}`);
            lines.push(`- **持续经营线**：${list$1(v.sustainingThreads)}`);
            lines.push(`- **兑现目标**：${list$1(v.payoffTargets)}`);
            if (i < volumes.length - 1)
                lines.push('');
        });
        return lines.join('\n');
    }

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
    /** chat_metadata.extensions 中的命名空间键（与其他模块一致） */
    const STORAGE_NAMESPACE = 'st_mainline';
    /** extensions 里保存主线设计的字段名 */
    const MAINLINE_DESIGN_KEY = 'mainlineDesign';
    /**
     * 取得聊天元数据对象：兼容新式（ctx.chatMetadata，SillyTavern 1.13+ 的 st-context）
     * 与旧式（ctx.chat_metadata）两种命名。都没有时返回 null。
     */
    function getChatMeta(c) {
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
    function applyDesignToMetadata(extensions, design) {
        const base = typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)
            ? extensions
            : {};
        const ns = typeof base[STORAGE_NAMESPACE] === 'object' &&
            base[STORAGE_NAMESPACE] !== null &&
            !Array.isArray(base[STORAGE_NAMESPACE])
            ? base[STORAGE_NAMESPACE]
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
    function extractDesignFromMetadata(extensions) {
        if (typeof extensions !== 'object' || extensions === null)
            return null;
        const base = extensions;
        const ns = base[STORAGE_NAMESPACE];
        if (typeof ns !== 'object' || ns === null || Array.isArray(ns))
            return null;
        const design = ns[MAINLINE_DESIGN_KEY];
        if (typeof design !== 'object' || design === null || Array.isArray(design))
            return null;
        const vr = validateMainlineDesign(design);
        return vr.ok ? design : null;
    }
    /**
     * 把主线设计保存到当前聊天的 chat_metadata.extensions 并触发持久化。
     * 缺 chat_metadata / extensions 时自动创建；宿主不可用或没有该结构时返回 false。
     * 触发持久化优先用 ctx.saveChatConditional，其次 ctx.saveChatDebounced（两者判空）。
     * @returns 是否成功写入
     */
    function saveDesignToChat(ctx, design) {
        if (!ctx || typeof ctx !== 'object')
            return false;
        const c = ctx;
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
            }
            catch {
                /* 持久化触发失败不影响已写入的内存态，返回 true 表示写入动作本身成功 */
            }
        }
        return true;
    }
    /**
     * 从当前聊天读取已保存的主线设计；无数据 / 结构非法返回 null。
     */
    function loadDesignFromChat(ctx) {
        if (!ctx || typeof ctx !== 'object')
            return null;
        const chatMeta = getChatMeta(ctx);
        return extractDesignFromMetadata(chatMeta?.extensions);
    }
    /**
     * 把主线设计写回当前角色卡扩展字段 characters[characterId].extensions。
     * 缺 characters 数组 / 角色对象 / extensions 时自动处理（extensions 自动创建）；
     * 无角色或结构缺失时返回 false。触发持久化优先…… 用 ctx.saveCharacterDebounced /
     * ctx.saveCharactersDebounced（判空，二者取一）。
     * @returns 是否成功写入（写回操作只有调用方显式开启 writeBackToCharacter 才会被调用）
     */
    function writeBackToCharacter(ctx, design) {
        if (!ctx || typeof ctx !== 'object')
            return false;
        const c = ctx;
        const characters = c.characters;
        if (!Array.isArray(characters))
            return false;
        // 优先按 this_chid 索引，其次按 name2 名称匹配（兼容 this_chid 未生效的场景）
        let char;
        const idx = Number(c.characterId ?? c.this_chid);
        if (Number.isFinite(idx) && idx >= 0) {
            char = characters[idx];
        }
        if (!char && typeof c.name2 === 'string' && c.name2) {
            char = characters.find((it) => it && it.name === c.name2);
        }
        if (!char || typeof char !== 'object')
            return false;
        if (typeof char.extensions !== 'object' || char.extensions === null) {
            char.extensions = {};
        }
        char.extensions[STORAGE_NAMESPACE] = design;
        // 触发持久化（判空，二者取一）
        const save = c.saveCharacterDebounced ?? c.saveCharactersDebounced ?? c.saveCharacter;
        if (typeof save === 'function') {
            try {
                save.call(c);
            }
            catch {
                /* 写回触发失败不影响已写入的内存态 */
            }
        }
        return true;
    }

    /**
     * src/ui/tabs/design-tab.ts — 「设计」页签（Task 5/7）
     *
     * 面板功能：主线设计的「生成 → 双视图审阅 → 校验 → 保存」闭环。
     *   1. 打开页签若本聊天已有保存的主线设计则自动载入；否则空态提示。
     *   2. 「生成主线」：读取材料包（trim 到 settings.materialTokenBudget）→ generateMainline；
     *      材料包读取失败显示红色错误且绝不下发生成请求；生成中显示 loading 文案；
     *      成功进入审阅双视图；失败显示错误明细 + 「修改后重试」。
     *   3. 双视图：切换「可读文档 / JSON」。JSON 视图用 <textarea> 可编辑，点击「校验」
     *      逐条红字展示错误并阻止保存；可读视图由 renderDesignDoc 实时渲染。
     *   4. 「保存到当前聊天」：校验通过才保存并 toast；失败列出错误拒绝保存。
     *   5. 「写回角色卡」复选框：勾选状态存 settings.writeBackToCharacter；保存时若勾选
     *      且校验通过则调用 writeBackToCharacter 并提示成功/失败。
     *
     * 硬性约束：所有宿主访问判空；UI 文案中文；样式前缀 stml-；不引外部 CSS。
     */
    /** 注入的面板样式唯一 id，避免重复插入 */
    const STYLE_ID$2 = 'stml-design-style';
    function ensureStyle$2(doc) {
        if (doc.getElementById(STYLE_ID$2))
            return;
        const style = doc.createElement('style');
        style.id = STYLE_ID$2;
        style.textContent = `
    .stml-design { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-design button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-design button:hover { background: #35353f; }
    .stml-design button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-design .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-design .stml-meta { margin-top: 8px; font-size: 12px; color: #9a9aa4; }
    .stml-design .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-design .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; white-space: pre-wrap; }
    .stml-design .stml-error-list { margin-top: 6px; color: #ff5c5c; font-size: 12px; }
    .stml-design .stml-error-list li { margin-left: 16px; }
    .stml-design .stml-hint { margin-top: 8px; color: #b0b0ba; font-size: 12px; }
    .stml-design .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-design .stml-doc {
      margin-top: 8px; padding: 10px 12px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02); white-space: pre-wrap; word-break: break-word;
      max-height: 60vh; overflow-y: auto; font-size: 12.5px;
    }
    .stml-design .stml-json {
      margin-top: 8px; width: 100%; box-sizing: border-box; min-height: 260px;
      padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(0,0,0,0.25); color: #e8e8ec; font-family: monospace; font-size: 12px;
      resize: vertical; white-space: pre-wrap; word-break: break-word;
    }
    .stml-design .stml-check { display: flex; align-items: center; gap: 6px; font-size: 12.5px; margin-top: 8px; }
    .stml-design .stml-toast {
      position: fixed; z-index: 100000; right: 24px; top: 24px; padding: 8px 14px;
      border-radius: 6px; font-size: 13px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .stml-design .stml-toast.stml-ok { background: #2f6f47; }
    .stml-design .stml-toast.stml-bad { background: #7f3338; }
  `;
        (doc.head ?? doc.documentElement).appendChild(style);
    }
    /** 便捷节点创建 */
    function el$2(doc, tag, className) {
        const node = doc.createElement(tag);
        if (className)
            node.className = className;
        return node;
    }
    function parseJson(text) {
        const trimmed = text.trim();
        if (!trimmed)
            return { ok: false, message: 'JSON 内容为空，无法校验。' };
        try {
            return { ok: true, value: JSON.parse(trimmed) };
        }
        catch (e) {
            return { ok: false, message: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` };
        }
    }
    /**
     * 设计页签挂载入口：内部状态 + DOM 引用 + 各动作统一在此组织。
     */
    function mountDesignTab(container) {
        const doc = container.ownerDocument ?? document;
        ensureStyle$2(doc);
        const ctx = getHostContext();
        const root = el$2(doc, 'div', 'stml-design');
        // ---- 顶部按钮行：生成主线 / 视图切换 ----
        const bar = el$2(doc, 'div', 'stml-bar');
        const generateBtn = el$2(doc, 'button');
        generateBtn.textContent = '生成主线';
        generateBtn.type = 'button';
        const viewToggleBtn = el$2(doc, 'button');
        viewToggleBtn.type = 'button';
        viewToggleBtn.textContent = '切换到 JSON';
        // 有可编辑内容前禁用视图切换
        viewToggleBtn.disabled = true;
        bar.appendChild(generateBtn);
        bar.appendChild(viewToggleBtn);
        root.appendChild(bar);
        // ---- 状态 / 错误区 ----
        const status = el$2(doc, 'div', 'stml-status');
        root.appendChild(status);
        // ---- 校验开关区（写回角色卡复选框） ----
        const checkRow = el$2(doc, 'label', 'stml-check');
        const wbCheck = el$2(doc, 'input');
        wbCheck.type = 'checkbox';
        wbCheck.checked = !!loadSettings().writeBackToCharacter;
        const wbLabel = el$2(doc, 'span');
        wbLabel.textContent = '保存时写回角色卡（扩展字段）';
        checkRow.appendChild(wbCheck);
        checkRow.appendChild(wbLabel);
        root.appendChild(checkRow);
        // ---- 主内容区（可读文档 / JSON textarea / 校验错误列表） ----
        const content = el$2(doc, 'div');
        root.appendChild(content);
        // ---- 底部操作行：校验 / 保存 ----
        const actions = el$2(doc, 'div', 'stml-bar');
        const validateBtn = el$2(doc, 'button');
        validateBtn.type = 'button';
        validateBtn.textContent = '校验';
        validateBtn.disabled = true;
        const saveBtn = el$2(doc, 'button');
        saveBtn.type = 'button';
        saveBtn.textContent = '保存到当前聊天';
        saveBtn.disabled = true;
        actions.appendChild(validateBtn);
        actions.appendChild(saveBtn);
        root.appendChild(actions);
        // ---- 底部说明 ----
        const hint = el$2(doc, 'div', 'stml-hint');
        hint.textContent =
            '把角色卡材料包交给 LLM 生成长期主线；可在「可读文档 / JSON」双视图间切换，' +
                'JSON 视图可手改，必须先通过校验才能保存到当前聊天。';
        root.appendChild(hint);
        // ---- 内部状态 ----
        /** 权威改编源：textarea 里的 JSON 文本（任何改动都从这里读取） */
        const textarea = el$2(doc, 'textarea', 'stml-json');
        textarea.style.display = 'none';
        content.appendChild(textarea);
        /** 可读文档容器 */
        const docView = el$2(doc, 'div', 'stml-doc');
        content.appendChild(docView);
        /** 校验错误列表容器 */
        const errorBox = el$2(doc, 'div', 'stml-error-list');
        errorBox.style.display = 'none';
        content.appendChild(errorBox);
        let design = null; // 最近一次成功通过校验的设计（用于可读视图兜底）
        let viewIsDoc = true;
        // ---- 小工具 ----
        function showToast(message, ok) {
            try {
                const t = doc.createElement('div');
                t.className = `stml-toast ${ok ? 'stml-ok' : 'stml-bad'}`;
                t.textContent = message;
                (doc.body ?? doc.documentElement).appendChild(t);
                setTimeout(() => t.remove(), 2600);
            }
            catch {
                /* toast 失败不影响主流程 */
            }
        }
        function clearErrors() {
            errorBox.replaceChildren();
            errorBox.style.display = 'none';
        }
        function showErrors(errors) {
            errorBox.replaceChildren();
            if (errors.length === 0) {
                errorBox.style.display = 'none';
                return;
            }
            const list = doc.createElement('ul');
            for (const e of errors) {
                const li = doc.createElement('li');
                li.textContent = `${e.path}：${e.message}`;
                list.appendChild(li);
            }
            errorBox.appendChild(list);
            errorBox.style.display = '';
        }
        /** 权威文本：textarea 当前值 */
        function currentText() {
            return textarea.value;
        }
        /** 解析 + 校验当前文本；返回校验结果，解析失败时给出占位错误 */
        function parseAndValidate() {
            const parsed = parseJson(currentText());
            if (!parsed.ok) {
                return { ok: false, errors: [{ path: '$', message: parsed.message ?? 'JSON 解析失败' }] };
            }
            const vr = validateMainlineDesign(parsed.value);
            return { ok: vr.ok, design: vr.ok ? parsed.value : undefined, errors: vr.errors };
        }
        /** 渲染当前视图（doc / json） */
        function renderView() {
            if (viewIsDoc) {
                docView.style.display = '';
                clearErrors();
                // 可读视图：优先用最近一次有效 design，否则实时尝试解析显示
                if (design) {
                    docView.textContent = renderDesignDoc(design);
                }
                else {
                    const parsed = parseJson(currentText());
                    if (parsed.ok) {
                        const vr = validateMainlineDesign(parsed.value);
                        if (vr.ok)
                            docView.textContent = renderDesignDoc(parsed.value);
                        else
                            docView.textContent = '（设计尚未通过校验，无法生成可读文档）';
                    }
                    else {
                        docView.textContent = '（JSON 为空或格式有误，请切到 JSON 视图检查）';
                    }
                }
            }
            else {
                docView.style.display = 'none';
            }
        }
        /** 把某个设计载入状态（生成成功 / 载入聊天 / 手改重试后统一使用） */
        function adoptDesign(d, jsonText) {
            design = d;
            textarea.value = jsonText;
            clearErrors();
            viewToggleBtn.disabled = false;
            validateBtn.disabled = false;
            saveBtn.disabled = false;
            renderView();
        }
        // ---- 视图切换 ----
        viewToggleBtn.addEventListener('click', () => {
            viewIsDoc = !viewIsDoc;
            viewToggleBtn.textContent = viewIsDoc ? '切换到 JSON' : '切换到可读文档';
            // 切到 JSON 前把当前 docView 内容还原为 textarea 权威文本（doc 视图改动会丢失，回到 JSON 从 textarea 重读）
            renderView();
        });
        // ---- 校验 ----
        validateBtn.addEventListener('click', () => {
            const r = parseAndValidate();
            if (r.ok && r.design) {
                design = r.design;
                showErrors([]);
                showToast('校验通过，可以保存。', true);
                status.textContent = '';
            }
            else {
                showErrors(r.errors);
                status.textContent = '设计未通过校验，已阻止保存，请修正后重试。';
                // 可读视图实时解析到合法设计则更新 design，方便审阅
                const parsed = parseJson(currentText());
                if (parsed.ok && validateMainlineDesign(parsed.value).ok) {
                    design = parsed.value;
                }
            }
        });
        // ---- 保存到当前聊天 ----
        saveBtn.addEventListener('click', () => {
            clearErrors();
            const r = parseAndValidate();
            if (!r.ok || !r.design) {
                showErrors(r.errors);
                status.textContent = '保存中止：设计未通过校验。';
                return;
            }
            const designToSave = r.design;
            const saved = saveDesignToChat(ctx, designToSave);
            if (!saved) {
                showToast('保存失败：宿主上下文不可用。', false);
                status.textContent = '保存失败：未能写入当前聊天（宿主不可用）。';
                return;
            }
            // 仅当用户勾选「写回角色卡」时才调用写回
            let wbMsg = '';
            if (wbCheck.checked) {
                const wb = writeBackToCharacter(ctx, designToSave);
                wbMsg = wb ? '；已写回角色卡' : '；写回角色卡失败（无当前角色或宿主不支持）';
            }
            showToast(`已保存到当前聊天${wbMsg || ''}。`, true);
            status.textContent = `已保存到当前聊天${wbMsg || ''}。`;
            design = designToSave;
        });
        // ---- 写回复选框状态持久化 ----
        wbCheck.addEventListener('change', () => {
            const next = loadSettings();
            next.writeBackToCharacter = wbCheck.checked;
            saveSettings(next);
        });
        // ---- 生成主线 ----
        generateBtn.addEventListener('click', () => {
            clearErrors();
            status.textContent = '正在读取材料包…';
            generateBtn.disabled = true;
            const settings = loadSettings();
            void readCurrentCharacterMaterial().then(async (res) => {
                if ('error' in res) {
                    // 材料包读取失败：红色错误展示，绝不下发生成请求
                    status.classList.add('stml-error');
                    status.textContent = `材料包读取失败：${res.error}`;
                    console.warn(`[主线设计] 材料包读取失败：${res.error}`);
                    generateBtn.disabled = false;
                    return;
                }
                status.classList.remove('stml-error');
                status.textContent = `正在生成主线设计（材料 ${settings.materialTokenBudget} token 预算内）…`;
                let material;
                try {
                    // 裁剪到预算后交给生成器
                    material = trimMaterialToBudget(res, settings.materialTokenBudget);
                    // 世界书条目按「材料包」页签勾选过滤：未勾选的内容不注入主线设计
                    material.worldbookEntries = filterBySelection(material.worldbookEntries);
                }
                catch (e) {
                    status.classList.add('stml-error');
                    status.textContent = `材料裁减失败：${e instanceof Error ? e.message : String(e)}`;
                    generateBtn.disabled = false;
                    return;
                }
                try {
                    const { design: d } = await generateMainline(material);
                    status.classList.remove('stml-error');
                    adoptDesign(d, JSON.stringify(d, null, 2));
                    status.textContent = '生成成功。请审阅（可切到 JSON 手改）并通过「校验」后保存。';
                }
                catch (e) {
                    generateBtn.disabled = false;
                    status.classList.add('stml-error');
                    if (e instanceof MainlineGenerationError) {
                        const missingText = e.missingFields.length
                            ? e.missingFields.map((g) => `${g.path}(缺:${g.fields.join(',')})`).join('，')
                            : '';
                        status.textContent = `生成失败：${e.message}${missingText ? `\n缺失/问题分组：${missingText}` : ''}`;
                        // 「修改后重试」：把失败的最后产物（lastRaw）放到 JSON 视图供手动修正后「校验→保存」
                        adoptDesign(null, e.lastRaw || '');
                        viewIsDoc = false;
                        viewToggleBtn.textContent = '切换到可读文档';
                        renderView();
                        status.textContent =
                            `${status.textContent}\n已把上次输出载入 JSON 视图，请手动修改后点「校验」重试，或在生成前重新生成。`;
                    }
                    else {
                        status.textContent = `生成失败：${e instanceof Error ? e.message : String(e)}`;
                    }
                    console.warn('[主线设计] 主线生成失败', e);
                }
            });
        });
        // ---- 打开页签：若本聊天已有保存的主线设计则自动载入，否则空态提示 ----
        const loaded = loadDesignFromChat(ctx);
        if (loaded) {
            status.textContent = '已载入本聊天保存的主线设计，可在下方审阅或重新生成。';
            adoptDesign(loaded, JSON.stringify(loaded, null, 2));
        }
        else {
            const empty = el$2(doc, 'div', 'stml-empty');
            empty.textContent = '当前聊天还没有保存的主线设计。点击「生成主线」基于角色卡材料包设计，或切到「JSON」视图粘贴现有设计后校验保存。';
            content.appendChild(empty);
        }
        container.replaceChildren(root);
    }
    /** 注册「设计」页签 */
    registerTab({ id: 'design', title: '设计', mount: mountDesignTab });

    /** 字符串数组安全拼接：非数组 / 空数组输出占位，避免拼出 "undefined" */
    function list(items) {
        if (!Array.isArray(items) || items.length === 0)
            return '（无）';
        return items.map((s) => String(s)).join('；');
    }
    /** 安全字符串取值：非字符串/空串输出占位 */
    function str(v, placeholder = '') {
        const s = typeof v === 'string' ? v.trim() : '';
        return s || placeholder;
    }
    /** 安全的阶段范围取值，非数字时回落给定默认 */
    function rangeStr(r, fallbackMin, fallbackMax) {
        const o = (typeof r === 'object' && r !== null ? r : {});
        const min = typeof o.min === 'number' ? o.min : fallbackMin;
        const max = typeof o.max === 'number' ? o.max : fallbackMax;
        return `${min}–${max}`;
    }
    /** 补零：把数字补成至少两位 */
    function pad2(n) {
        return String(n).padStart(2, '0');
    }
    /**
     * 把立纲指令所需的「结构约束」段落渲染成纯文本数组。
     * 这些约束是转交指令的核心：让 arc-architect 严格照此立纲而非自由发挥。
     */
    function constraintLines() {
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
    function renderHandoffInstruction(design) {
        const ref = (design?.characterRef ?? {});
        const story = design?.story;
        const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
        const lines = [];
        lines.push('请采用以下主线设计为当前角色创建可长期游玩的完整故事总纲，并严格照此立纲，无需另行自由发挥或增删卷。');
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
    function buildHandoffFilename(design) {
        const name = str(design?.characterRef?.name, '未命名').replace(/[\\/:*?",<>|]/g, '_').trim();
        const now = new Date();
        const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
            `-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
        return `主线-立纲要求-${name}-${stamp}.md`;
    }

    /**
     * src/ui/tabs/handoff-tab.ts — 「转交」面板页签（Task 6/7）
     *
     * 面板功能：把用户审阅确认后的主线设计渲染成立纲指令文本，供复制 / 导出，
     * 交给 shujuku continuation 作为续写任务的初始要求。
     *   1. 打开页签若本聊天已有保存的主线设计则渲染到 <pre> 只读区（可滚动）；
     *      无设计时显示空态提示「请先在『设计』页签生成并保存主线」。
     *   2. 「一键复制」：优先 navigator.clipboard.writeText（try/catch），失败回退
     *      document.execCommand('copy') + 临时 textarea；成功/失败均 toast/内联提示。
     *   3. 「导出 .md」：Blob + 临时 <a download> 触发下载，文件名 buildHandoffFilename。
     *   4. 顶部与底部一行使用说明（中文）；样式前缀 stml-，不引外部 CSS。
     *
     * 硬性约束：复制/下载类操作不做任何向导吞异常，且在有浏览器环境才执行；
     * 宿主访问判空。
     */
    /** 注入的面板样式唯一 id，避免重复插入 */
    const STYLE_ID$1 = 'stml-handoff-style';
    function ensureStyle$1(doc) {
        if (doc.getElementById(STYLE_ID$1))
            return;
        const style = doc.createElement('style');
        style.id = STYLE_ID$1;
        style.textContent = `
    .stml-handoff { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-handoff button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-handoff button:hover { background: #35353f; }
    .stml-handoff button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-handoff .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-handoff .stml-hint { margin-top: 8px; color: #b0b0ba; font-size: 12px; }
    .stml-handoff .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-handoff .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-handoff .stml-pre {
      margin-top: 8px; padding: 10px 12px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(0,0,0,0.25); color: #e8e8ec; font-family: monospace; font-size: 12px;
      white-space: pre-wrap; word-break: break-word; overflow-y: auto; max-height: 60vh;
    }
    .stml-handoff .stml-toast {
      position: fixed; z-index: 100000; right: 24px; top: 24px; padding: 8px 14px;
      border-radius: 6px; font-size: 13px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .stml-handoff .stml-toast.stml-ok { background: #2f6f47; }
    .stml-handoff .stml-toast.stml-bad { background: #7f3338; }
  `;
        (doc.head ?? doc.documentElement).appendChild(style);
    }
    /** 便捷节点创建 */
    function el$1(doc, tag, className) {
        const node = doc.createElement(tag);
        if (className)
            node.className = className;
        return node;
    }
    /** 复制文本：优先 Clipboard API，失败回退 execCommand；返回是否成功 */
    function copyText(doc, text) {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(doc, text));
        }
        return Promise.resolve(fallbackCopy(doc, text));
    }
    /** execCommand('copy') 回退：临时 textarea + 选区复制 */
    function fallbackCopy(doc, text) {
        try {
            const ta = doc.createElement('textarea');
            ta.value = text;
            // 移出可视区但不隐藏，保证 select/execCommand 可用
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            (doc.body ?? doc.documentElement).appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            const ok = doc.execCommand('copy');
            ta.remove();
            return ok;
        }
        catch {
            return false;
        }
    }
    /** 触发下载：Blob + 临时 <a download> */
    function downloadText(filename, text) {
        try {
            const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            (document.body ?? document.documentElement).appendChild(a);
            a.click();
            a.remove();
            // 异步释放 object URL，避免泄漏
            setTimeout(() => URL.revokeObjectURL(url), 0);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 转交页签挂载入口：载入聊天里的主线设计，渲染 → 复制 / 导出。
     */
    function mountHandoffTab(container) {
        const doc = container.ownerDocument ?? document;
        ensureStyle$1(doc);
        const ctx = getHostContext();
        const root = el$1(doc, 'div', 'stml-handoff');
        // ---- 顶部操作行 ----
        const bar = el$1(doc, 'div', 'stml-bar');
        const copyBtn = el$1(doc, 'button');
        copyBtn.type = 'button';
        copyBtn.textContent = '一键复制';
        copyBtn.disabled = true;
        const exportBtn = el$1(doc, 'button');
        exportBtn.type = 'button';
        exportBtn.textContent = '导出 .md';
        exportBtn.disabled = true;
        bar.appendChild(copyBtn);
        bar.appendChild(exportBtn);
        root.appendChild(bar);
        // ---- 状态 / 提示区 ----
        const status = el$1(doc, 'div', 'stml-status');
        root.appendChild(status);
        // ---- 只读立纲指令区 ----
        const pre = el$1(doc, 'pre', 'stml-pre');
        root.appendChild(pre);
        // ---- 底部使用说明 ----
        const hint = el$1(doc, 'div', 'stml-hint');
        hint.textContent =
            '把上面的立纲要求复制或导出为 .md，粘贴到续写推进（shujuku continuation）的' +
                '初始要求中，即可创建以该主线为主纲的续写任务。';
        root.appendChild(hint);
        /** 全局 toast（成功绿 / 失败红） */
        function showToast(message, ok) {
            try {
                const t = doc.createElement('div');
                t.className = `stml-toast ${ok ? 'stml-ok' : 'stml-bad'}`;
                t.textContent = message;
                (doc.body ?? doc.documentElement).appendChild(t);
                setTimeout(() => t.remove(), 2600);
            }
            catch {
                /* toast 失败不影响主流程 */
            }
        }
        function enable(hasDesign) {
            copyBtn.disabled = !hasDesign;
            exportBtn.disabled = !hasDesign;
        }
        // ---- 打开页签：若有已保存的主线设计则渲染，否则空态 ----
        const design = loadDesignFromChat(ctx);
        if (design) {
            pre.textContent = renderHandoffInstruction(design);
            status.textContent = '已就绪：下方为可直接使用的立纲要求文本。';
            enable(true);
            // ---- 一键复制 ----
            copyBtn.addEventListener('click', () => {
                const text = pre.textContent ?? '';
                showToast('正在复制…', true);
                void copyText(doc, text).then((ok) => {
                    if (ok) {
                        showToast('立纲要求已复制，可粘贴到续写任务的初始要求中。', true);
                        status.textContent = '已复制立纲要求。';
                    }
                    else {
                        showToast('复制失败：浏览器不支持自动复制，请手动全选后复制。', false);
                        status.textContent = '复制失败：请手动全选下方文本后 Ctrl+C 复制。';
                    }
                });
            });
            // ---- 导出 .md ----
            exportBtn.addEventListener('click', () => {
                const text = pre.textContent ?? '';
                const filename = buildHandoffFilename(design);
                const ok = downloadText(filename, text);
                if (ok) {
                    showToast(`已导出 ${filename}。`, true);
                    status.textContent = `已导出 ${filename}。`;
                }
                else {
                    showToast('导出失败：浏览器不支持自动下载，请手动复制到文件。', false);
                    status.textContent = '导出失败：请手动复制文本到本地文件。';
                }
            });
        }
        else {
            const empty = el$1(doc, 'div', 'stml-empty');
            empty.textContent = '当前聊天还没有保存的主线设计。请先在『设计』页签生成并保存主线。';
            root.insertBefore(empty, hint);
            status.textContent = '';
            enable(false);
        }
        container.replaceChildren(root);
    }
    /** 注册「转交」页签 */
    registerTab({ id: 'handoff', title: '转交', mount: mountHandoffTab });

    /**
     * src/core/review.ts — 主线偏差审视（可选开关，Task 7/7）
     *
     * 职责：把「当前剧情正文尾部」与「主线设计第一卷（或用户指定卷号）」对照，
     * 让 LLM 输出简短审视报告（每卷：符合 / 偏离 / 信息不足 + 一句话说明），
     * 帮助用户决定是重立主线还是让 continuation 修正。
     *
     * 硬性约束：
     *   - 本模块「审视」永远只读：不写入任何聊天数据、不修改主线设计；
     *   - 核心逻辑（extractChatTail / buildReviewPrompt）为纯函数，零宿主依赖；
     *   - runDeviationReview 允许注入 callLLMImpl，便于单测不真实调用 LLM；
     *   - 报告解析尽可宽容：任何怪异的 AI 输出都降级为「信息不足」而非崩溃，
     *     仅当完全无法解析出报告结构时才抛 REVIEW_INVALID_REPORT。
     */
    /** 解析报告失败时抛出的错误码 */
    const REVIEW_INVALID_REPORT = 'REVIEW_INVALID_REPORT';
    /** 审视报告解析失败时抛出的错误（携带 code=REVIEW_INVALID_REPORT） */
    class ReviewError extends Error {
        constructor(message) {
            super(message);
            Object.defineProperty(this, "code", {
                enumerable: true,
                configurable: true,
                writable: true,
                value: void 0
            });
            this.name = 'ReviewError';
            this.code = REVIEW_INVALID_REPORT;
        }
    }
    /**
     * 从一条楼层对象中归一化出角色；无法归一到 user/assistant 时返回 null。
     * 归一化规则：
     *   - is_user === true       → 'user'
     *   - role === 'user'        → 'user'
     *   - role === 'assistant' / 'system' → 'assistant'
     */
    function normalizeRole(item) {
        if (item.is_user === true)
            return 'user';
        const role = typeof item.role === 'string' ? item.role : '';
        if (role === 'user')
            return 'user';
        if (role === 'assistant' || role === 'system')
            return 'assistant';
        return null;
    }
    /**
     * 纯函数：从聊天楼层数组里抽取「尾部 N 条可审视的正文」。
     * 只保留 mes 非空、且可归一到 user/assistant 的楼层（system 且无正文者被过滤），
     * 截取最后 count 条。chat 非法 / 为空 / 无合格楼层时返回 []。
     * @param chat 任意来源的楼层数组（通常来自宿主 ctx.chat）
     * @param count 要抽取的尾部条数（<=0 视作不抽取，返回 []）
     */
    function extractChatTail(chat, count) {
        if (!Array.isArray(chat) || !Number.isFinite(count) || count <= 0)
            return [];
        const result = [];
        for (const itemRaw of chat) {
            if (itemRaw === null || typeof itemRaw !== 'object')
                continue;
            const item = itemRaw;
            const role = normalizeRole(item);
            if (!role)
                continue;
            const mes = typeof item.mes === 'string' ? item.mes.trim() : '';
            if (mes.length === 0)
                continue;
            result.push({ role, text: mes });
        }
        return result.slice(-count);
    }
    /** 把当前卷索引规范化到合法下标（非整数 / 越界时回落 0，即第一卷） */
    function clampVolumeIndex(index, length) {
        return Number.isInteger(index) && index >= 0 && index < length ? index : 0;
    }
    /**
     * 纯函数：构建「偏差审视」的 system / user 提示词。
     * - system：角色为「主线偏差审查员」，只读，不写正文不改大纲；
     * - user：包含【主线定稿】全文、【当前卷=第 N 卷】、[最近正文尾部]，
     *   并给出只输出指定 JSON 报告（{ verdicts, overall }）的约束。
     * @param design 主线设计（须已通过校验）
     * @param tail   extractChatTail 的输出（最近正文尾部）
     * @param volumeIndex 要审视的卷下标（0-based；越界回落 0）
     */
    function buildReviewPrompt(design, tail, volumeIndex) {
        const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
        const idx = clampVolumeIndex(volumeIndex, volumes.length);
        const vol = volumes[idx] ?? {};
        const volTitle = typeof vol.title === 'string' && vol.title.trim() ? vol.title : `第 ${idx + 1} 卷`;
        const system = [
            '你是主线偏差审查员，长期从事故事主线的贴合度核验。',
            '你只做「只读」审视：对照主线设计与最近正文，判断实际剧情是否贴合当前卷的主线设计。',
            '硬性约束：',
            '  - 你绝不写正文、绝不修改或重写大纲，也不输出任何需要落盘的设计改动；',
            '  - 你只输出一句总体判断 + 逐卷简短结论，供用户决定是否重立主线或让 continuation 修正；',
            '  - 信息不足以判断时，如实标注「信息不足」，绝不臆测硬凑结论。',
        ].join('\n');
        const tailText = Array.isArray(tail) && tail.length > 0
            ? tail.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n')
            : '（没有可用的正文尾部）';
        const user = [
            '请对照下面的主线设计与最近正文尾部，审视「当前卷」的贴合情况。',
            '',
            '【主线定稿】',
            renderDesignDoc(design),
            '',
            `【当前卷 = 第 ${idx + 1} 卷《${volTitle}》】`,
            `- 本卷方向（目标/行动/副线/压力）：${typeof vol.direction === 'string' ? vol.direction : ''}`,
            `- 本卷升级与收束：${typeof vol.escalation === 'string' ? vol.escalation : ''}`,
            '',
            '【最近正文尾部】',
            tailText,
            '',
            '【输出要求】',
            '只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），形如：',
            '',
            '{ "verdicts": [{ "volumeIndex": 0, "volumeTitle": "第 N 卷标题", "verdict": "符合|偏离|信息不足", "note": "一句话说明" }], "overall": "一句话总体判断" }',
            '',
            '说明：',
            '- verdicts 为逐卷结论数组，verdict 只能取「符合/偏离/信息不足」三者之一；',
            '- overall 为一句话总体判断（是否贴合、是否建议重立或修正）；',
            '- note 与 overall 都要简短、中文、可读。',
            '请直接输出最终 JSON。',
        ].join('\n');
        return { system, user };
    }
    /** 归一化 verdict：非法值一律回落为「信息不足」，绝不让渲染/后续逻辑崩溃 */
    function normalizeVerdict(v) {
        if (v === '符合' || v === '偏离' || v === '信息不足')
            return v;
        return '信息不足';
    }
    /** 从模型文本里切出一个 JSON 对象子串（容忍 ``` 围栏与前后杂文本）；找不到返回 null */
    function sliceJsonObject(s) {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start === -1 || end <= start)
            return null;
        return s.slice(start, end + 1);
    }
    /** 解析模型输出的报告文本为 DeviationReviewReport；无法解析或结构非法时抛 ReviewError */
    function parseReport(text, idx, volTitle) {
        const trimmed = text.trim();
        const candidate = sliceJsonObject(trimmed) ?? trimmed;
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 无法把审视报告解析为 JSON：${why}`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 审视报告不是单个 JSON 对象`);
        }
        const obj = parsed;
        const overall = typeof obj.overall === 'string' ? obj.overall : '';
        const verdictsRaw = obj.verdicts;
        if (!Array.isArray(verdictsRaw)) {
            throw new ReviewError(`[${REVIEW_INVALID_REPORT}] 审视报告缺少 verdicts 数组`);
        }
        const verdicts = verdictsRaw.map((r) => {
            const ro = (typeof r === 'object' && r !== null ? r : {});
            const vi = Number.isFinite(Number(ro.volumeIndex)) ? Number(ro.volumeIndex) : idx;
            return {
                volumeIndex: vi,
                volumeTitle: typeof ro.volumeTitle === 'string' ? ro.volumeTitle : '',
                verdict: normalizeVerdict(ro.verdict),
                note: typeof ro.note === 'string' ? ro.note : '',
            };
        });
        return {
            overall,
            verdicts,
            reviewedVolumeIndex: idx,
            reviewedVolumeTitle: volTitle,
        };
    }
    /**
     * 执行一次主线偏差审视（只读，绝不写数据）：
     *   1. 取最近正文尾部（条数取 settings.reviewTailFloors）；
     *   2. 尾部为空 → 抛错（信息不足，无正文可审）；
     *   3. 用 buildReviewPrompt 构建提示词并调用 LLM（可注入）；
     *   4. 解析报告（容忍围栏与杂文本），非法 verdict 归一化为「信息不足」。
     * @throws {ReviewError} 报告无法解析 / 字段非法（code=REVIEW_INVALID_REPORT）
     * @throws {Error}       尾部无正文（信息不足）
     */
    async function runDeviationReview(design, chat, opts = {}) {
        const volumes = Array.isArray(design?.volumes) ? design.volumes : [];
        const idx = clampVolumeIndex(opts.volumeIndex ?? 0, volumes.length);
        const volTitleStr = typeof volumes[idx]?.title === 'string' && volumes[idx].title.trim()
            ? volumes[idx].title
            : `第 ${idx + 1} 卷`;
        const count = Number.isFinite(loadSettings().reviewTailFloors)
            ? Math.floor(loadSettings().reviewTailFloors)
            : 12;
        const tail = extractChatTail(chat, count);
        if (tail.length === 0) {
            throw new Error('没有可审视的正文：当前聊天没有 user/assistant 正文楼层（信息不足），无法进行审视。');
        }
        const prompt = buildReviewPrompt(design, tail, idx);
        const impl = opts.callLLMImpl ??
            ((system, user) => callLLMWithRetry([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0 }));
        const raw = await impl(prompt.system, prompt.user);
        return parseReport(raw, idx, volTitleStr);
    }

    /**
     * src/ui/tabs/review-tab.ts — 「审视」页签（Task 7/7）
     *
     * 面板功能（只读，不改写任何数据）：
     *   1. 打开页签：loadDesignFromChat 载入本聊天已保存的主线设计；无设计 → 空态提示。
     *   2. 卷号下拉选择（默认第 1 卷）；「运行审视」读取宿主 ctx.chat → runDeviationReview
     *      → 渲染报告（总体 + 逐卷 verdict 徽标：符合=绿 / 偏离=橙 / 信息不足=灰 + note）。
     *   3. 运行中 loading；错误红字展示；报告区标注「本次为只读审视，未写入任何聊天数据」。
     *
     * 硬性约束：所有宿主访问判空；UI 文案中文；样式前缀 stml-；绝不写数据。
     */
    /** 注入的面板样式唯一 id，避免重复插入 */
    const STYLE_ID = 'stml-review-style';
    function ensureStyle(doc) {
        if (doc.getElementById(STYLE_ID))
            return;
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
    .stml-review { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-review select {
      padding: 4px 8px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; font-size: 13px;
    }
    .stml-review button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-review button:hover { background: #35353f; }
    .stml-review button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-review .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-review .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-review .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; white-space: pre-wrap; }
    .stml-review .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-review .stml-report { margin-top: 10px; }
    .stml-review .stml-overall {
      padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02); font-size: 13px; white-space: pre-wrap;
    }
    .stml-review .stml-badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px;
      margin-right: 6px; color: #fff;
    }
    .stml-review .stml-badge-ok { background: #2f6f47; }
    .stml-review .stml-badge-off { background: #a86a24; }
    .stml-review .stml-badge-none { background: #5a5a62; }
    .stml-review .stml-verdict { margin-top: 6px; font-size: 12.5px; color: #c8c8d0; }
    .stml-review .stml-verdict-title { font-weight: 600; color: #e8e8ec; }
    .stml-review .stml-verdict-note { margin-top: 2px; color: #a0a0ac; white-space: pre-wrap; }
    .stml-review .stml-readonly {
      margin-top: 10px; font-size: 12px; color: #8a8a94;
    }
    .stml-review .stml-note { margin-top: 6px; color: #b0b0ba; font-size: 12px; }
  `;
        (doc.head ?? doc.documentElement).appendChild(style);
    }
    /** 便捷节点创建 */
    function el(doc, tag, className) {
        const node = doc.createElement(tag);
        if (className)
            node.className = className;
        return node;
    }
    /** verdict 徽标类名 */
    function badgeClass(v) {
        if (v === '符合')
            return 'stml-badge-ok';
        if (v === '偏离')
            return 'stml-badge-off';
        return 'stml-badge-none';
    }
    /** 渲染逐卷 verdict 行列 */
    function renderVerdict(doc, v) {
        const box = el(doc, 'div', 'stml-verdict');
        const badge = el(doc, 'span', `stml-badge ${badgeClass(v.verdict)}`);
        badge.textContent = v.verdict;
        const title = el(doc, 'span', 'stml-verdict-title');
        const volLabel = v.volumeTitle ? `《${v.volumeTitle}》` : `第 ${v.volumeIndex + 1} 卷`;
        title.textContent = `第 ${v.volumeIndex + 1} 卷 ${volLabel}`;
        box.appendChild(badge);
        box.appendChild(title);
        if (v.note) {
            const note = el(doc, 'div', 'stml-verdict-note');
            note.textContent = v.note;
            box.appendChild(note);
        }
        return box;
    }
    /**
     * 审视页签挂载入口。
     */
    function mountReviewTab(container) {
        const doc = container.ownerDocument ?? document;
        ensureStyle(doc);
        const ctx = getHostContext();
        const root = el(doc, 'div', 'stml-review');
        const status = el(doc, 'div', 'stml-status');
        const reportBox = el(doc, 'div', 'stml-report');
        // 载入设计；无设计则空态
        const design = loadDesignFromChat(ctx);
        if (!design) {
            const empty = el(doc, 'div', 'stml-empty');
            empty.textContent = '请先在「设计」页签生成并保存主线，再进行偏差审视。';
            root.appendChild(empty);
            container.replaceChildren(root);
            return;
        }
        // ---- 顶部操作行：卷选择 + 运行审视 ----
        const bar = el(doc, 'div', 'stml-bar');
        const label = doc.createElement('span');
        label.textContent = '审视卷：';
        bar.appendChild(label);
        const select = el(doc, 'select');
        design.volumes.forEach((v, i) => {
            const opt = doc.createElement('option');
            opt.value = String(i);
            opt.textContent = `第 ${i + 1} 卷《${v.title || ''}》`;
            select.appendChild(opt);
        });
        select.value = '0'; // 默认第一卷
        bar.appendChild(select);
        const runBtn = el(doc, 'button');
        runBtn.type = 'button';
        runBtn.textContent = '运行审视';
        bar.appendChild(runBtn);
        root.appendChild(bar);
        root.appendChild(status);
        root.appendChild(reportBox);
        // ---- 底部只读说明 ----
        const readonly = el(doc, 'div', 'stml-readonly');
        readonly.textContent = '本次为只读审视，未写入任何聊天数据，也不修改主线设计。';
        root.appendChild(readonly);
        // ---- 渲染报告 ----
        function renderReport(report) {
            reportBox.replaceChildren();
            const overall = el(doc, 'div', 'stml-overall');
            overall.textContent = report.overall || '（模型未给出总体判断）';
            reportBox.appendChild(overall);
            for (const v of report.verdicts) {
                reportBox.appendChild(renderVerdict(doc, v));
            }
        }
        // ---- 运行审视 ----
        runBtn.addEventListener('click', () => {
            const volumeIndex = Number(select.value || '0');
            status.classList.remove('stml-error');
            status.textContent = '正在审视最近正文与主线设计的贴合情况…';
            runBtn.disabled = true;
            reportBox.replaceChildren();
            void runDeviationReview(design, ctx?.chat, { volumeIndex })
                .then((report) => {
                status.textContent = '';
                renderReport(report);
            })
                .catch((err) => {
                status.classList.add('stml-error');
                status.textContent = `审视失败：${err instanceof Error ? err.message : String(err)}`;
                console.warn('[主线设计] 偏差审视失败', err);
            })
                .finally(() => {
                runBtn.disabled = false;
            });
        });
        container.replaceChildren(root);
    }
    /** 注册「审视」页签 */
    registerTab({ id: 'review', title: '审视', mount: mountReviewTab });

    /**
     * src/index.ts — 「ST·主线设计」插件入口
     *
     * 启动流程：
     *   1. 轮询等待 SillyTavern 宿主就绪（getContext 可用，最长 15s，参照 shujuku
     *      的 waitForTavernHelper 模式；不强制要求 TavernHelper 存在）。
     *   2. 就绪后：detectHost() 记录适配层来源日志。
     *   3. 安装浮动面板（#st-mainline-panel），渲染页签栏（材料包 / API 配置 /
     *      设计 / 转交 / 审视等由各功能模块自行注册）。
     *   4. 注册一个扩展设置项（可开关启用，存 extensionSettings[st_mainline]）。
     *
     * 双端兼容：所有对 window / SillyTavern / __TAURITAVERN__ 的访问都判空/可选访问，
     * 绝不因宿主未提供 API 而崩溃。
     */
    /** 面板唯一的 DOM id，便于后续任务挂载功能与复用注入 */
    const MAINLINE_PANEL_ID = 'st-mainline-panel';
    /** 收起态的小圆钮 id */
    const MAINLINE_TOGGLE_ID = 'st-mainline-toggle';
    /** 扩展在 extensionSettings 中的命名空间键（与 shared/settings.ts 一致） */
    const SETTING_NAMESPACE = 'st_mainline';
    /** 面板标题 */
    const PANEL_TITLE = '主线设计';
    /** 最长等待宿主就绪的时间（毫秒） */
    const MAX_WAIT_MS = 15000;
    /** 面板展开/收起状态在 localStorage 中的键（纯 UI 偏好；v2：默认收起） */
    const COLLAPSED_STORAGE_KEY = 'stml:panel:collapsed:v2';
    /**
     * 等待宿主就绪：轮询 window.SillyTavern.getContext 是否可用（并可读到
     * extensionSettings），最长 MAX_WAIT_MS。与 shujuku 相同，TavernHelper /
     * __TAURITAVERN__ 为可选增强；只要原生 getContext 就绪即可继续。
     */
    async function waitForHost(maxWaitMs) {
        const win = globalThis.window ?? globalThis;
        const start = Date.now();
        let poll = 0;
        while (Date.now() - start < maxWaitMs) {
            try {
                const hasGetContext = typeof win?.SillyTavern?.getContext === 'function';
                if (hasGetContext) {
                    const ctx = win.SillyTavern.getContext();
                    if (ctx && ctx.extensionSettings) {
                        console.log(`[主线设计] 宿主就绪，等待 ${Date.now() - start}ms（轮询 ${poll} 次）`);
                        return true;
                    }
                }
            }
            catch {
                // getContext 抛出异常说明宿主尚未完全初始化，继续轮询
            }
            poll++;
            await new Promise((r) => setTimeout(r, 100));
        }
        console.warn(`[主线设计] 等待宿主就绪超时（${maxWaitMs}ms），getContext 不可用`);
        return false;
    }
    /**
     * 安装可展开/收起的悬浮面板：
     * - 收起态：右下角一个小圆钮（#st-mainline-toggle，文字"主线"）。
     * - 展开态：悬浮窗（#st-mainline-panel，标题栏 + 页签栏，标题右侧「收起」按钮）。
     * 展开/收起偏好存 localStorage（stml:panel:collapsed），刷新后保持一致。
     * 两元素共用同一显隐开关（受设置 enabled 控制）。
     */
    function installPanel() {
        const doc = typeof document !== 'undefined' ? document : undefined;
        if (!doc)
            return;
        // 幂等：已存在则跳过
        if (doc.getElementById(MAINLINE_PANEL_ID) || doc.getElementById(MAINLINE_TOGGLE_ID))
            return;
        // 默认收起（true），只有用户显式展开过（localStorage 存 '0'）才默认展开
        const readCollapsed = () => {
            try {
                return localStorage.getItem(COLLAPSED_STORAGE_KEY) !== '0';
            }
            catch {
                return true;
            }
        };
        const writeCollapsed = (collapsed) => {
            try {
                localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
            }
            catch {
                /* 无痕/禁用 localStorage 时静默忽略 */
            }
        };
        const applyCollapsed = (collapsed) => {
            panel.style.display = collapsed ? 'none' : '';
            toggle.style.display = collapsed ? '' : 'none';
            writeCollapsed(collapsed);
        };
        // ---- 收起态小圆钮 ----
        const toggle = doc.createElement('button');
        toggle.id = MAINLINE_TOGGLE_ID;
        toggle.title = '展开「主线设计」面板';
        toggle.textContent = '主线';
        toggle.style.position = 'fixed';
        toggle.style.bottom = '16px';
        toggle.style.right = '16px';
        toggle.style.zIndex = '9998';
        toggle.style.width = '52px';
        toggle.style.height = '44px';
        toggle.style.borderRadius = '22px';
        toggle.style.border = '1px solid #3a3a40';
        toggle.style.background = 'rgba(24,24,28,0.94)';
        toggle.style.color = '#e8e8ec';
        toggle.style.fontSize = '13px';
        toggle.style.fontFamily = 'inherit';
        toggle.style.cursor = 'pointer';
        toggle.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
        toggle.addEventListener('click', () => applyCollapsed(false));
        (doc.body || doc.documentElement).appendChild(toggle);
        // ---- 展开态悬浮窗 ----
        const panel = doc.createElement('div');
        panel.id = MAINLINE_PANEL_ID;
        panel.style.position = 'fixed';
        panel.style.bottom = '16px';
        panel.style.right = '16px';
        panel.style.zIndex = '9999';
        panel.style.width = '340px';
        panel.style.padding = '12px';
        panel.style.background = 'rgba(24,24,28,0.94)';
        panel.style.color = '#e8e8ec';
        panel.style.border = '1px solid #3a3a40';
        panel.style.borderRadius = '8px';
        panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
        panel.style.fontSize = '13px';
        panel.style.fontFamily = 'inherit';
        // 标题栏：标题（点击也可收起）+ 「收起」按钮
        const titleBar = doc.createElement('div');
        titleBar.style.display = 'flex';
        titleBar.style.alignItems = 'center';
        titleBar.style.justifyContent = 'space-between';
        titleBar.style.marginBottom = '8px';
        const title = doc.createElement('div');
        title.textContent = PANEL_TITLE;
        title.style.fontWeight = 'bold';
        title.style.fontSize = '14px';
        title.style.cursor = 'pointer';
        title.style.userSelect = 'none';
        title.title = '点击收成右下角小圆钮';
        title.addEventListener('click', () => applyCollapsed(true));
        titleBar.appendChild(title);
        const collapseBtn = doc.createElement('button');
        collapseBtn.textContent = '收起';
        collapseBtn.title = '点击收成右下角小圆钮';
        collapseBtn.style.padding = '3px 12px';
        collapseBtn.style.borderRadius = '4px';
        collapseBtn.style.border = '1px solid #5a6a7a';
        collapseBtn.style.background = '#3a4a5a';
        collapseBtn.style.color = '#fff';
        collapseBtn.style.cursor = 'pointer';
        collapseBtn.style.fontSize = '12px';
        collapseBtn.style.fontWeight = 'bold';
        collapseBtn.addEventListener('mouseenter', () => {
            collapseBtn.style.background = '#4a5a6a';
        });
        collapseBtn.addEventListener('mouseleave', () => {
            collapseBtn.style.background = '#3a4a5a';
        });
        collapseBtn.addEventListener('click', () => applyCollapsed(true));
        titleBar.appendChild(collapseBtn);
        panel.appendChild(titleBar);
        // 版本信息栏（便于确认当前运行的是否为最新构建）
        const versionLine = doc.createElement('div');
        versionLine.textContent = 'v0.1.0 · 2026-09-06';
        versionLine.style.fontSize = '11px';
        versionLine.style.color = '#8a8a94';
        versionLine.style.marginBottom = '6px';
        panel.appendChild(versionLine);
        // 页签区独立容器：mountPanel 内部会 replaceChildren，绝不能传整个 panel
        // （否则会把上面的标题栏/版本行清空），必须挂到专属子容器上。
        const panelBody = doc.createElement('div');
        panel.appendChild(panelBody);
        mountPanel(panelBody);
        (doc.body || doc.documentElement).appendChild(panel);
        // 恢复上次展开/收起偏好（默认收起为小圆钮）
        applyCollapsed(readCollapsed());
        console.log(`[主线设计] 悬浮面板已安装（#${MAINLINE_PANEL_ID} / #${MAINLINE_TOGGLE_ID}）`);
    }
    /**
     * 注册扩展设置项：在 SillyTavern「扩展」设置页加入一个开关，
     * 可启用/禁用插件（状态经 shared/settings.ts 持久化）。
     */
    function registerSettings(ctx) {
        if (!ctx || typeof ctx.registerExtensionSetting !== 'function')
            return;
        const setting = ctx.registerExtensionSetting(SETTING_NAMESPACE, 'enabled', '主线设计', '启用「主线设计」外部增量插件（配合 shujuku continuation 的角色卡→主线设计）', loadSettings().enabled, (element) => {
            const onToggle = () => {
                const next = loadSettings();
                next.enabled = !!element?.checked;
                saveSettings(next);
                console.log(`[主线设计] 设置已更新：enabled=${next.enabled}`);
                // 面板 + 收起小圆钮按开关状态一同显示/隐藏
                const panel = document.getElementById(MAINLINE_PANEL_ID);
                const toggle = document.getElementById(MAINLINE_TOGGLE_ID);
                for (const node of [panel, toggle]) {
                    if (node)
                        node.style.display = next.enabled ? undefined : 'none';
                }
            };
            element?.addEventListener('change', onToggle);
            // 打开设置面板时，把开关状态和已保存设置对齐
            element && (element.checked = loadSettings().enabled);
        });
        // 若宿主返回了可用的设置对象，同步一次当前值（防御性，不强依赖）
        return setting;
    }
    /**
     * 安装运行时调试钩子：在浏览器控制台执行 __ST_MAINLINE_DEBUG__() 即可看到
     * 插件自己拿到的宿主上下文全貌（适配层、ctx 键、关键字段），用于排查
     * getHostContext() 在真实宿主中返回了什么东西。
     */
    function installDebugHook() {
        try {
            globalThis.__ST_MAINLINE_DEBUG__ = () => {
                const snapshot = {};
                try {
                    const kind = detectHost();
                    snapshot.kind = kind;
                    const g = globalThis.window ?? globalThis;
                    snapshot.tavernHelper = !!g?.TavernHelper;
                    snapshot.tauritavern = !!g?.__TAURITAVERN__;
                    snapshot.hasSillyTavern = typeof g?.SillyTavern === 'object';
                    snapshot.hasGetContext = typeof g?.SillyTavern?.getContext === 'function';
                    const ctx = getHostContext();
                    snapshot.ctxType = typeof ctx;
                    snapshot.ctxKeys = ctx && typeof ctx === 'object' ? Object.keys(ctx).slice(0, 50) : [];
                    snapshot.ctxName2 = ctx?.name2;
                    snapshot.ctxCharacterId = ctx?.characterId;
                    snapshot.ctxCharsIsArray = Array.isArray(ctx?.characters);
                    snapshot.ctxCharsLen = Array.isArray(ctx?.characters) ? ctx.characters.length : 'NA';
                    snapshot.ctxChatMeta = typeof ctx?.chatMetadata === 'object' ? 'object' : typeof ctx?.chat_metadata;
                    snapshot.ctxExtSettings = typeof ctx?.extensionSettings;
                    // 直接调一次原生 getContext 对照
                    if (typeof g?.SillyTavern?.getContext === 'function') {
                        const raw = g.SillyTavern.getContext();
                        snapshot.rawKeys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 50) : [];
                        snapshot.rawCharsIsArray = Array.isArray(raw?.characters);
                        snapshot.rawCharsLen = Array.isArray(raw?.characters) ? raw.characters.length : 'NA';
                    }
                }
                catch (error) {
                    snapshot.error = error instanceof Error ? error.message : String(error);
                }
                console.log('[主线设计] 调试快照：', snapshot);
                return snapshot;
            };
            console.log('[主线设计] 调试钩子已就绪：控制台执行 __ST_MAINLINE_DEBUG__() 查看宿主上下文快照。');
        }
        catch {
            /* 调试钩子失败不影响主流程 */
        }
    }
    /**
     * 插件主流程：等待宿主就绪 → 探测适配层 → 装面板 → 注册设置。
     */
    async function extensionMain() {
        console.log('[主线设计] 插件启动，等待宿主就绪…');
        const ready = await waitForHost(MAX_WAIT_MS);
        if (!ready) {
            console.warn('[主线设计] 宿主未就绪，跳过初始化（面板与设置暂不注册）。');
            return;
        }
        // 安装运行时调试钩子（浏览器控制台排查用）
        installDebugHook();
        // 记录适配层来源日志
        const adapter = getHostAdapter();
        adapter.logReady();
        // 从统一适配层取上下文（SillyTavern.getContext）
        const ctx = adapter.getContext();
        // 安装浮动面板（受 enabled 设置控制显隐）
        installPanel();
        const settings = loadSettings();
        if (!settings.enabled) {
            const panel = document.getElementById(MAINLINE_PANEL_ID);
            const toggle = document.getElementById(MAINLINE_TOGGLE_ID);
            for (const node of [panel, toggle]) {
                if (node)
                    node.style.display = 'none';
            }
        }
        // 注册设置项
        if (ctx)
            registerSettings(ctx);
        else
            console.warn('[主线设计] getContext 返回空，跳过设置注册。');
        console.log('[主线设计] 初始化完成。');
    }
    // 插件由 script 标签加载，DOM 与宿主观测即可开始，直接调主流程
    void extensionMain();

    exports.MAINLINE_PANEL_ID = MAINLINE_PANEL_ID;
    exports.MAINLINE_TOGGLE_ID = MAINLINE_TOGGLE_ID;
    exports.SETTING_NAMESPACE = SETTING_NAMESPACE;

    return exports;

})({});
