# 背包地牢 修改器

基于 Chrome DevTools 协议的运行时修改器：**不改游戏文件**，通过 CDP 读写 `BattleManager` 实例和 Pinia store，
并提供背包布局评分 / 求解 / 一键应用。

## 环境

- Windows 10 / 11
- Node.js ≥ 22（使用内置 `WebSocket` / `fetch`，无需 `npm install`；开发环境 v24）
- 游戏：Backpack Dungeon **2.4.2**（Electron 41.7.1）

## Clone 后首次配置

仓库不包含两个从游戏包里解出的大文件（`idx.js`、`game.js`），需要用自带的 `asar-tool.mjs` 本地生成。

```powershell
# 按实际安装路径修改
$asar = "D:\steam\steamapps\common\背包地牢\resources\app.asar"

# 1) 主渲染 bundle（文件名带 hash，版本不同会变，先 ls 查真实文件名）
node asar-tool.mjs ls $asar "out/renderer/public/index-.*\.js$"
node asar-tool.mjs cat $asar out/renderer/public/index-BMaoztIh.js idx.js

# 2) 仅当游戏更新、需要重建道具库时执行
node asar-tool.mjs ls $asar "out/renderer/public/containerResize-.*\.js$"
node asar-tool.mjs cat $asar out/renderer/public/containerResize-D1RrDUGu.js game.js
node build-itemdb.mjs
```

> - `idx.js` **必须补齐**：`① 抓取战斗实例` 靠它计算断点位置。
> - `game.js` 只在重建 `itemdb.json` 时需要；`itemdb.json` 已入库，日常不用跑第 2 步。

## 启动

1. Steam → 库 → 右键游戏 → 属性 → 启动选项，填 `--remote-debugging-port=9222`
2. 双击 `启动面版.bat`（等价于 `node bd-ui.mjs`），浏览器打开 <http://127.0.0.1:8787>
3. **进入一场战斗** → 点「① 抓取战斗实例」

## 常用命令

```powershell
node bd-trainer.mjs status              # 查看金币 / 魂 / 楼层
node bd-layout.mjs dump                 # 导出当前背包布局
node score.mjs layout.json              # 布局评分
node solve.mjs layout.json itemdb.json  # 求解最优布局（输出 plan.json，不自动应用）
node bd-layout.mjs apply plan.json      # 应用（自动备份 + 回读校验）
node bd-layout.mjs undo                 # 回滚
```

## 文件

| 文件 | 说明 |
|---|---|
| `启动面版.bat` / `bd-ui.mjs` | 可视化面板（8787） |
| `bd-inject.mjs` | 战斗引擎层 CLI |
| `bd-trainer.mjs` | Pinia store 层 CLI |
| `bd-layout.mjs` | 布局导出 / 应用 / 回滚 |
| `layout-lib.mjs` | 引擎几何与轨道模型（与游戏 `trackPath` 逐项一致） |
| `score.mjs` / `solve.mjs` | 布局评分 / 求解 |
| `build-itemdb.mjs` / `itemdb.json` | 道具库生成与数据 |
| `asar-tool.mjs` | 轻量 asar 读取器（ls / cat） |
| `idx.js` / `game.js` | 从游戏解包，体积大，**不入库** |

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板「未连接」 | 游戏是否带 `--remote-debugging-port=9222`；8787 是否被旧 node 占用 |
| 抓实例超时 | 必须先进入战斗 |
| `bundle 找不到目标方法` | `idx.js` 与游戏版本不匹配，按上面步骤重新解包 |
| 刷新页面后功能失效 | 点任意功能按钮即可重装钩子 |


