/**
 * rollup.config.js — SG·主线设计插件构建配置
 *
 * 目标：把 src/index.ts（及其导入的 src/host/host-compat.ts 等纯 TS 模块）
 * 打包成单文件 IIFE 产物，输出到插件根目录的 index.js（与 manifest.json 的
 * js 字段保持一致），供 SillyTavern / TauriTavern 加载。
 *
 * 依赖极简：仅 @rollup/plugin-typescript 做 TS 转译，不引入任何框架；
 * 产物为浏览器环境可直接运行的 IIFE。
 */
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: {
    file: 'index.js',      // 单文件产物，落到插件根目录
    format: 'iife',         // 浏览器 IIFE，SillyTavern 通过 script 标签加载
    name: 'MainlineDesign', // 全局命名空间（避免污染全局，内部逻辑尽量不挂 window）
    sourcemap: false,
    compact: false,
  },
  plugins: [
    typescript({
      // 构建时指定的 TS 编译选项（与 tsconfig.json 保持一致但允许程序化覆盖）
      tsconfig: './tsconfig.json',
      // noEmit 会阻止 rollup 产物生成，这里显式允许输出；
      // outDir 不设置——产物由下方 output.file 直接落到插件根目录 index.js，
      // 由此规避 @rollup/plugin-typescript 的 outDir/rollup file 路径校验冲突。
      noEmit: false,
      module: 'ESNext',
      declaration: false,
      declarationMap: false,
    }),
  ],
};