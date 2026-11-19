# 角色卡编辑器

给自己和小圈子用的 SillyTavern 角色卡编辑器（Web/PWA），纯前端，数据只存在浏览器本地。

需求文档：[酒馆角色卡编辑器 · 需求文档](https://claude.ai/artifact/E4Mw4NXB232hwg4EmWXWpQ)

## 开发

```bash
npm install
npm run dev        # 本地开发，http://localhost:5173
npm test           # 单元测试（含样本卡往返测试）
npm run typecheck  # 类型检查
npm run lint       # 代码检查（oxlint）
npm run build      # 打包到 dist/
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/core/` | 核心逻辑，纯 TypeScript，不依赖浏览器 API，可单独测试 |
| `src/core/png/` | PNG 块读写（tEXt、CRC32） |
| `src/core/card/` | 角色卡类型定义、导入导出（V1/V2/V3 统一转 V3） |
| `src/components/ui/` | shadcn/ui 组件 |
| `tests/` | Vitest 测试 |
| `samples/` | 测试用样本卡 |

## 约定

- 无损往返：整张卡原样保存，未知字段全部保留；导出 PNG 同时写 `chara`（V2 标识）和 `ccv3`（V3）。
- `src/core/` 只能用浏览器和 Node 都有的 API，由 `tsconfig.test.json`（不含 DOM 类型）保证。
