# ST·主线设计（st-mainline-plugin）

SillyTavern / TauriTavern 双端兼容的**外部增量插件**。定位为 shujuku（SP·数据库）
continuation 方案的补充：将「角色卡」进一步推进为「主线设计」。

> 这是任务 1/7 的工程骨架。当前插件**可加载但功能为占位**：提供浮动面板与扩展
> 设置项，具体的主线设计功能由后续任务填充。

---

## 目录结构

```
st-mainline-plugin/
├── manifest.json            # 扩展声明（display_name / loading_order / js 入口）
├── package.json             # npm 包与脚本（build / test / typecheck）
├── tsconfig.json            # TS 编译配置（strict）
├── rollup.config.js         # 打包 src/index.ts → 根目录 index.js（IIFE 单文件）
├── .gitignore
├── src/
│   ├── index.ts             # 插件入口：等待宿主就绪 → 探测适配层 → 面板/设置占位
│   └── host/
│       └── host-compat.ts   # 宿主适配层（Tri-host 探测 + 统一接口类型）
├── tests/
│   └── host-compat.test.ts  # vitest：detectHost 三种优先级用例
└── README.md
```

## 宿主兼容

插件通过 `src/host/host-compat.ts` 统一抽象三套宿主，所有访问均判空/可选访问：

| 优先级 | 判定依据              | HostKind         |
| ------ | --------------------- | ---------------- |
| 1      | `window.TavernHelper` | `tavern-helper`  |
| 2      | `window.__TAURITAVERN__` | `tauritavern`  |
| 3      | `SillyTavern.getContext` | `sillytavern`  |

入口 `src/index.ts` 参照 shujuku 的 `waitForTavernHelper` 模式，轮询等待
`SillyTavern.getContext` 可用（最长 15s），随后注册 `#st-mainline-panel`
浮动面板与 `st_mainline.enabled` 扩展设置项。

## 构建 / 测试命令

```bash
npm install        # 安装依赖
npm run build       # rollup 打包 → 根目录生成 index.js（manifest 的 js 指向它）
npm test            # vitest 运行 host-compat 优先级用例
npm run typecheck   # tsc --noEmit 类型检查
```

产物形态为标准 ST 扩展：`manifest.json` + 根目录 `index.js`，直接放入
`data/default-user/extensions/`（local）或 `data/extensions/third-party/`
（global）即可被 SillyTavern / TauriTavern 加载。