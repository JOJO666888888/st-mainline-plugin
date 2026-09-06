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
import { detectHost, getHostAdapter, getHostContext } from './host/host-compat';
import { loadSettings, saveSettings } from './shared/settings';
import { mountPanel } from './ui/panel';
// 各功能页签模块：import 即注册（registerTab）
import './ui/tabs/material-tab';
import './ui/tabs/api-tab';
import './ui/tabs/design-tab';
import './ui/tabs/handoff-tab';
import './ui/tabs/review-tab';

/** 面板唯一的 DOM id，便于后续任务挂载功能与复用注入 */
export const MAINLINE_PANEL_ID = 'st-mainline-panel';

/** 收起态的小圆钮 id */
export const MAINLINE_TOGGLE_ID = 'st-mainline-toggle';

/** 扩展在 extensionSettings 中的命名空间键（与 shared/settings.ts 一致） */
export const SETTING_NAMESPACE = 'st_mainline';

/** 面板标题 */
const PANEL_TITLE = '主线设计';

/** 最长等待宿主就绪的时间（毫秒） */
const MAX_WAIT_MS = 15000;

/**
 * 等待宿主就绪：轮询 window.SillyTavern.getContext 是否可用（并可读到
 * extensionSettings），最长 MAX_WAIT_MS。与 shujuku 相同，TavernHelper /
 * __TAURITAVERN__ 为可选增强；只要原生 getContext 就绪即可继续。
 */
async function waitForHost(maxWaitMs: number): Promise<boolean> {
  const win: any = (globalThis as any).window ?? globalThis;
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
    } catch {
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
 * - 收起态（默认）：右下角一个小圆钮（#st-mainline-toggle，文字"主线"）。
 * - 展开态：悬浮窗（#st-mainline-panel，标题栏 + 页签栏，标题右侧「收起」按钮）。
 * 每次加载页面固定默认收起为小球（不持久化展开状态）。
 * 两元素共用同一显隐开关（受设置 enabled 控制）。
 */
function installPanel(): void {
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (!doc) return;

  // 幂等：已存在则跳过
  if (doc.getElementById(MAINLINE_PANEL_ID) || doc.getElementById(MAINLINE_TOGGLE_ID)) return;

  // 展开/收起只改显隐，不持久化：每次加载页面一律默认收起成小球（用户要求的行为）
  const applyCollapsed = (collapsed: boolean): void => {
    panel.style.display = collapsed ? 'none' : '';
    toggle.style.display = collapsed ? '' : 'none';
  };

  // ---- 收起态小圆钮（支持自由拖拽）----
  const toggle = doc.createElement('button');
  toggle.id = MAINLINE_TOGGLE_ID;
  toggle.title = '点击展开「主线设计」面板，可拖拽移动';
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
  toggle.style.cursor = 'grab';
  toggle.style.userSelect = 'none';
  toggle.style.touchAction = 'none';
  toggle.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';

  // 小球位置记忆（仅球的位置，不影响“默认收起”行为；不可用时忽略）
  const BALL_POS_KEY = 'stml:ball:pos';
  const readBallPos = (): { x: number; y: number } | null => {
    try {
      const raw = localStorage.getItem(BALL_POS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed as { x: number; y: number };
      return null;
    } catch {
      return null;
    }
  };
  const writeBallPos = (x: number, y: number): void => {
    try {
      localStorage.setItem(BALL_POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      /* 不可用时静默忽略 */
    }
  };
  /** 用 left/top 定位小球（此后 bottom/right 不再生效）。 */
  const positionToggle = (x: number, y: number): void => {
    toggle.style.left = `${x}px`;
    toggle.style.top = `${y}px`;
    toggle.style.bottom = 'auto';
    toggle.style.right = 'auto';
    writeBallPos(x, y);
  };

  // 恢复上次拖拽位置；无记录时保持右下角（bottom/right 定位）
  const savedPos = readBallPos();
  if (savedPos) positionToggle(savedPos.x, savedPos.y);

  // 拖拽实现：pointer 事件 + setPointerCapture。
  // 按下→移动超过阈值算拖拽（只移动不展开）；松开且位移很小视为点击（展开面板）。
  let dragging = false;
  let moved = false;
  let startClientX = 0;
  let startClientY = 0;
  let startLeft = 0;
  let startTop = 0;
  const DRAG_THRESHOLD = 5; // 位移超过 5px 判定为拖拽，否则是点击

  toggle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return; // 只响应左键
    const rect = toggle.getBoundingClientRect();
    startClientX = event.clientX;
    startClientY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    // 第一次按下就把元素切换为 left/top 定位，保证拖拽流畅
    toggle.style.left = `${startLeft}px`;
    toggle.style.top = `${startTop}px`;
    toggle.style.bottom = 'auto';
    toggle.style.right = 'auto';
    dragging = true;
    moved = false;
    toggle.style.cursor = 'grabbing';
    try {
      toggle.setPointerCapture(event.pointerId);
    } catch {
      /* 个别环境不支持 capture，仍可拖拽 */
    }
    event.preventDefault();
  });

  toggle.addEventListener('pointermove', (event: PointerEvent) => {
    if (!dragging) return;
    const dx = event.clientX - startClientX;
    const dy = event.clientY - startClientY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
    const x = startLeft + dx;
    const y = startTop + dy;
    // 限制在视口内，避免拖出屏幕
    const maxX = Math.max(0, window.innerWidth - toggle.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - toggle.offsetHeight);
    toggle.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    toggle.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
    event.preventDefault();
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    toggle.style.cursor = 'grab';
    try {
      toggle.releasePointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }
    const rect = toggle.getBoundingClientRect();
    if (moved) {
      // 拖拽结束：把当前位置交给定位函数并记住
      positionToggle(rect.left, rect.top);
    } else {
      // 位移很小视为点击：展开面板
      applyCollapsed(false);
    }
  };
  toggle.addEventListener('pointerup', endDrag);
  toggle.addEventListener('pointercancel', endDrag);

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

  // 每次加载页面固定默认收起：只显示右下角「主线」小球（用户要求）
  applyCollapsed(true);
  console.log('[主线设计] 初始状态=收起（右下角「主线」悬浮球），点击展开面板。');
  console.log(`[主线设计] 悬浮面板已安装（#${MAINLINE_PANEL_ID} / #${MAINLINE_TOGGLE_ID}）`);
}

/**
 * 注册扩展设置项：在 SillyTavern「扩展」设置页加入一个开关，
 * 可启用/禁用插件（状态经 shared/settings.ts 持久化）。
 */
function registerSettings(ctx: any): void {
  if (!ctx || typeof ctx.registerExtensionSetting !== 'function') return;

  const setting = ctx.registerExtensionSetting(
    SETTING_NAMESPACE,
    'enabled',
    '主线设计',
    '启用「主线设计」外部增量插件（配合 shujuku continuation 的角色卡→主线设计）',
    loadSettings().enabled,
    (element: any) => {
      const onToggle = () => {
        const next = loadSettings();
        next.enabled = !!element?.checked;
        saveSettings(next);
        console.log(`[主线设计] 设置已更新：enabled=${next.enabled}`);
        // 面板 + 收起小圆钮按开关状态一同显示/隐藏
        const panel = (document as any).getElementById(MAINLINE_PANEL_ID);
        const toggle = (document as any).getElementById(MAINLINE_TOGGLE_ID);
        for (const node of [panel, toggle]) {
          if (node) node.style.display = next.enabled ? undefined : 'none';
        }
      };
      element?.addEventListener('change', onToggle);
      // 打开设置面板时，把开关状态和已保存设置对齐
      element && (element.checked = loadSettings().enabled);
    },
  );

  // 若宿主返回了可用的设置对象，同步一次当前值（防御性，不强依赖）
  return setting as unknown as void;
}

/**
 * 安装运行时调试钩子：在浏览器控制台执行 __ST_MAINLINE_DEBUG__() 即可看到
 * 插件自己拿到的宿主上下文全貌（适配层、ctx 键、关键字段），用于排查
 * getHostContext() 在真实宿主中返回了什么东西。
 */
function installDebugHook(): void {
  try {
    (globalThis as any).__ST_MAINLINE_DEBUG__ = () => {
      const snapshot: Record<string, unknown> = {};
      try {
        const kind = detectHost();
        snapshot.kind = kind;
        const g: any = (globalThis as any).window ?? globalThis;
        snapshot.tavernHelper = !!g?.TavernHelper;
        snapshot.tauritavern = !!g?.__TAURITAVERN__;
        snapshot.hasSillyTavern = typeof g?.SillyTavern === 'object';
        snapshot.hasGetContext = typeof g?.SillyTavern?.getContext === 'function';
        const ctx: any = getHostContext();
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
      } catch (error) {
        snapshot.error = error instanceof Error ? error.message : String(error);
      }
      console.log('[主线设计] 调试快照：', snapshot);
      return snapshot;
    };
    console.log('[主线设计] 调试钩子已就绪：控制台执行 __ST_MAINLINE_DEBUG__() 查看宿主上下文快照。');
  } catch {
    /* 调试钩子失败不影响主流程 */
  }
}

/**
 * 插件主流程：等待宿主就绪 → 探测适配层 → 装面板 → 注册设置。
 */
async function extensionMain(): Promise<void> {
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
  const ctx: any = adapter.getContext();

  // 安装浮动面板（受 enabled 设置控制显隐）
  installPanel();
  const settings = loadSettings();
  if (!settings.enabled) {
    const panel = (document as any).getElementById(MAINLINE_PANEL_ID);
    const toggle = (document as any).getElementById(MAINLINE_TOGGLE_ID);
    for (const node of [panel, toggle]) {
      if (node) node.style.display = 'none';
    }
  }

  // 注册设置项
  if (ctx) registerSettings(ctx);
  else console.warn('[主线设计] getContext 返回空，跳过设置注册。');

  console.log('[主线设计] 初始化完成。');
}

// 插件由 script 标签加载，DOM 与宿主观测即可开始，直接调主流程
void extensionMain();