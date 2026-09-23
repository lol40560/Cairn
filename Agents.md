# Cairn

## 项目目标
多人 + 多 AI 实时协作代码同步工具。局域网 P2P Swarm，影子 Git，最终一键导出 GitHub PR。
用户不需要装编辑器插件，只需运行本桌面 App 并选择项目文件夹。

## 技术栈
- Electron + React + TypeScript + Vite
- 状态：Zustand
- UI：Tailwind + shadcn/ui
- 文件监控：chokidar
- P2P 发现：bonjour-service (mDNS)
- P2P 传输：Node net (TCP)
- 存储：better-sqlite3 + `.cairn/objects/`
- diff：`diff` npm 包
- 三方合并：`node-diff3`
- 影子 Git：isomorphic-git
- GitHub PR：@octokit/rest

## 项目结构
- `electron/main.ts` — Electron 主进程入口
- `electron/preload.ts` — IPC 桥，暴露安全 API 给渲染进程
- `electron/core/oplog/` — 操作日志与内容寻址
- `electron/core/watcher/` — 文件监控与 diff 生成
- `electron/core/sync/` — mDNS 发现 + TCP 传输 + 协议（v2）
- `electron/core/merge/` — 分层冲突合并（v3）
- `electron/core/git/` — 影子 Git 与 PR 导出（v3）
- `electron/core/room/` — 房间管理（v2）
- `src/` — React 前端

## 开发命令
- `npm run dev` — 启动 Electron + Vite
- `npm test` — Vitest 单元测试
- `npm run lint` — ESLint

## 约束
- 所有核心逻辑放在 `electron/core/`，不要写在 React 组件里。
- 渲染进程只能通过 `preload.ts` 暴露的 IPC 访问核心逻辑，禁止直接 require Node 模块。
- 所有 op 必须包含：id、hash、author、parentHashes、timestamp、filePath、diff。
- hash 用 SHA-256，存储路径 `.cairn/objects/<hash[0:2]>/<hash>`。
- 文件监控 debounce 默认 300ms，可配置。
- 忽略 `.git/`、`.vibeswarm/`、`.cairn/`、`node_modules/`、`dist/`、`build/`。

## 数据目录约定
- 新项目统一使用 `.cairn/` 保存 oplog、快照和影子 Git 数据。
- 为兼容旧项目，创建 oplog 或影子 Git 时，若仅存在 `.vibeswarm/`，会尝试原子重命名为 `.cairn/`。
- 迁移失败不会阻塞项目打开；Cairn 会创建新的 `.cairn/`，且不会读取旧目录中的数据。
- watcher 同时忽略 `.vibeswarm/` 和 `.cairn/`，避免内部数据触发协作 op。
- P2P 必须支持断线重连，重连后自动交换缺失 op。
- 不要引入不必要的依赖。优先用已有 npm 包。

### better-sqlite3 native module
- 安装依赖后必须用 `@electron/rebuild` 为 Electron ABI 重新编译 `better-sqlite3`。
- `package.json` 必须包含 `"postinstall": "electron-rebuild -f -w better-sqlite3"`。
- `electron.vite.config.ts` 必须将 `better-sqlite3` 标记为 external。
- Vitest 使用 Node ABI，Electron 使用 Electron ABI；两个环境的 native module 产物不得互相污染。
- 脚手架阶段必须验证 Electron 主进程可以 `require('better-sqlite3')` 并成功打开内存数据库。

### shadcn/ui 依赖范围
- 只允许引入 `button`、`badge`、`table` 三个 shadcn/ui 组件。
- shadcn/ui 相关运行时依赖只允许：`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`tailwindcss-animate`。

### selectFolder 取消语义
- `selectFolder()` 返回空字符串 `''` 表示用户取消选择。
- UI 收到 `''` 时不更改任何状态，也不得将其传给 `startWatching`。

## 完成标准
- 每个模块有 Vitest 单元测试
- `npm test` 和 `npm run lint` 通过
- 关键路径有日志输出
- 前端组件不直接处理业务逻辑，只调用 IPC API
