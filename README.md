# dsh-git-ai-attribution

把**任何 AI 编程工具**写的代码，计入 TRAE 企业版的「代码提交 AI 贡献度」——一个独立运行的命令行程序 + 本地网页看板，**不依赖 DSH**。

它不是估算，而是走 TRAE 自己那条链路：提交**前** hook 先把暂存改动声明为 AI 编辑（写 `git-ai` checkpoint），提交后由 `git-ai` daemon 结算——它自己写逐行归属 note（`refs/notes/ai-tob`），并用 TRAE 的登录凭据把 `ai>0` 上报企业后端。**TRAE 不需要常驻**。

> 早期版本是 DSH 插件（对话上方的「AI 归因」标签页）。v0.5.0 起改为独立程序，完全替代插件；插件源码仍保留在 `lib/`，见「从插件迁移」。

## 原理

```
git commit（任何工具写的都一样）
   ├─ pre-commit hook → ai-attr checkpoint --repo <r>（同步：等请求投递给 daemon 才放行）
   │     └─ git-ai checkpoint：声明「本次提交的暂存改动是 AI 写的」
   │        （请求必须在提交发生前抵达 daemon；HEAD 漂移期送达会被拒收）
   ├─ daemon 结算（提交后约 75 秒，一次性）
   │     ├─ 写 refs/notes/ai-tob 逐行归属 note（带行号与 session）
   │     └─ 上报 git_ai_commit_attribution → 企业后端（ai>0）
   └─ post-commit hook → 240 秒后 ai-attr attribute 兜底
        └─ 仅当 note 缺失/缺行时补写（只影响看板，不触发上报）
                ↓
        企业后端 → 控制台「AI 贡献度明细」（T+1 刷新）
```

- **归因发生在提交时刻**，与编辑工具无关：DSH、Trae、Cursor、VS Code、纯 shell 改的都算。
- 前提是「已经完全不手写代码」——checkpoint 把该提交的全部暂存改动声明为 AI。仍手写代码的话不要用 `--any-author` 全量补录。
- pre-commit 是**同步**的：提交会等 checkpoint 请求投递完成（实测每次提交约多 10~15 秒，取决于本机进程启动速度）；请求必须先于提交抵达，晚了会在 HEAD 漂移中被拒收或被结算忽略。
- **daemon 结算是唯一的企业上报通道**：note 只供看板查询，企业侧 ai 行数由结算时收到的 checkpoint 决定。
- **结算必须由 daemon 独占 note**：提交后立即写 note 会打断结算（`preserved note is invalid`），所以 post-commit 只在 240 秒后兜底。
- 结算依赖 serve 在跑（60 秒心跳维持仓库注册）；serve 停了新提交只剩看板兜底，企业侧不计数。

## 依赖

| 组件 | 说明 |
|---|---|
| TRAE CN 客户端 | 安装并**登录过一次**（提供 `git-ai` 运行时与上报凭据），不需要常驻运行 |
| Node.js | ≥ 20 |
| Git | 常规安装即可 |

无需 DSH。`git-ai.exe` 与上报凭据都从本机 TRAE 里自动发现。

## 快速开始

```powershell
# 1. 初始化：扫描根目录下的仓库，装 pre-commit + post-commit hook，起 daemon 并注册
node bin\ai-attr.js init --root D:\work\lowcode

# 2. 启动本地看板（浏览器打开 http://127.0.0.1:7788）
node bin\ai-attr.js serve --open

# 3. 随时看状态
node bin\ai-attr.js status
```

之后正常 `git commit` 即可：pre-commit 在后台声明 AI（提交多等约 4 秒），note 与企业上报由 daemon 自动完成。

### 命令一览

| 命令 | 作用 |
|---|---|
| `init [--root <dir>] [--repo <path>]... [--port N]` | 写配置、给每个仓库装 pre-commit + post-commit hook、起 daemon 并注册 |
| `checkpoint --repo <path>` | 把暂存改动声明为 AI（pre-commit hook 调的就是它） |
| `serve [--port 7788] [--open]` | 本地网页看板 + 后台 daemon 心跳 |
| `attribute --repo <path> [--sha <commit>]` | 归因单个提交（post-commit hook 兜底调用；sha 缺省 HEAD） |
| `sync [--repo <path>]... [--dry-run]` | 全量补录/对账：给缺行的提交补 note，幂等 |
| `status` | 配置 / hook / daemon / 注册状态 + 日志尾部 |
| `uninstall [--repo]...` | 移除 hook 块（不动已有 note） |

也可以 `npm i -g github:gechenlo/dsh-git-ai-attribution` 后直接用 `ai-attr ...`。

## 看板

`serve` 起纯本地页面（默认 `http://127.0.0.1:7788`）：预设 今天 / 近 7 天 / 近 30 天 / 全部；卡片（AI 新增行、总新增行、贡献率、提交数）+ 逐提交 8 列表格（提交、时间、说明、AI 行、总新增、贡献率、模型、归因状态）。数据来自本机 Git notes，不依赖网络；5 分钟缓存 + 后台静默刷新，「刷新」按钮强制重查。

同一项目的多个检出（worktree）合并为一条；查询自动排除 `refs/notes/*`——否则补录产生的 note 提交会占满「最近 200 条」窗口。

## 配置

配置文件 `~/.ai-attr/config.json`（环境变量 `AI_ATTR_HOME` 可改目录）：

| 键 | 说明 |
|---|---|
| `repos` | 登记的仓库列表 |
| `port` | 看板端口（默认 7788） |
| `lastRepo` | 看板上次选中的仓库 |

日志：`~/.ai-attr/ai-attr.log`。

## 历史提交补录

装 hook 之前的提交没有归属，用 `sync` 一次性补齐：

```powershell
node bin\ai-attr.js sync --repo D:\work\lowcode\hyrule-solo
node bin\ai-attr.js sync --dry-run        # 对全部登记仓库，先看不动手
```

`sync` 底层是 `scripts/backfill-notes.mjs`，也可以单独使用：

```powershell
node scripts\backfill-notes.mjs --repo <path> [--repo <path> ...] [--author <substr>] [--dry-run]
node scripts\backfill-notes.mjs --repo <path> --any-author    # 不按作者过滤
node scripts\backfill-notes.mjs --repo <path> --only <sha>    # 单提交（hook 快路径）
node scripts\backfill-notes.mjs --repo <path> --repair        # 只清洗写坏的 note
```

- 作者过滤默认取该仓库的 `git config user.email` / `user.name`，**别人的提交不会被改**。
- 已有 note 保留原行映射，只补缺失的行（`custom_attributes.backfilled: true` 标记来源）；纯修复不新增 session。
- 每条提交都用 `--numstat` 复核补丁解析出的新增行数，大偏差跳过，避免写错 note。
- 补丁按 500 提交分页拉取（大仓库全量 `-p` 输出可达 865MB，单次会撞 `maxBuffer`）。
- 补完后看板立即生效；**note 不触发企业上报**（企业侧按结算时的 checkpoint 计数，见「已知限制」）。

## 排查

| 现象 | 处理 |
|---|---|
| 提交后没有 note | `ai-attr status` 看 hook 是否安装；看 `~/.ai-attr/ai-attr.log` |
| 提交在企业侧仍是 0 | daemon 日志（`~/.ai-attr/daemon/**/logs/*.log`）看 `note written … attestations=`：0 说明 checkpoint 没送达；确认 serve 在跑（心跳维持注册） |
| pre-commit 后提交变慢 | 每次提交约多 10~15 秒（同步等请求投递 + 3 秒响应上限）；exit≠0 不代表失败，请求已投递，以 daemon 日志 `checkpoint: saved` 为准 |
| daemon 起不来 / 不上报 | TRAE 没装或没登录过；装一次并登录（凭据自动读取） |
| `status` 里 daemon 无凭据 | 默认 home 的 daemon 不带 DataFinder 配置；本程序用自带凭据的 home 起，别混用 |
| 看板打开很慢 | 冷查询要跑多个 git 进程（本机每次启动约 1.3 秒）；已缓存 5 分钟并后台刷新 |
| 端口被占 | `serve --port <其他端口>` |
| 公司网络 | 上报走 DataFinder 通道，代理环境按 TRAE 登录态里的代理配置 |

## 从插件迁移（v0.5.0）

独立版**完全替代** DSH 插件：

1. 删除 `cordis.patch.yml` 里 `id: git-ai-attribution` 的 insert 块（保存即热重载卸载）。
2. 重启 DSH——插件的 heartbeat 定时器没有 dispose，重启才彻底停。
3. 可选清理：
   ```powershell
   $env:GIT_AI_DAEMON_HOME = "$env:USERPROFILE\.dsh\git-ai-daemon"; git-ai bg shutdown
   Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-git-ai-attribution"
   ```
4. 用 `init` 重新登记仓库（配置在 `~/.ai-attr/`，与插件的 `$DSH_HOME` 互不干扰）。

插件源码仍在 `lib/index.js` / `lib/client.js`；核心逻辑已抽到 `lib/core.js`，两边共用。

## 推送（github.com 的 TLS 被重置时）

直连 `github.com:443` 会在 TLS 握手时被重置（`api.github.com` 正常），`git push` 报
`Send failure: Connection was reset`。此时用 REST API 推送，本地与远端会得到**字节级相同**的
commit 对象，无需事后对账：

```powershell
pwsh -NoProfile -File scripts/push-via-api.ps1
```

脚本取本机保存的 GitHub 凭据（`git credential fill`），逐个上传变更文件、生成 tree/commit、
更新 `refs/heads/master`，并把本地分支同步到同一个 sha。

## 已知限制

- **口径 = 提交时全量记 AI**：为「已完全不手写代码、缺口纯粹是工具误差」的场景设计。
- **必须提交才有数据**：企业口径按 commit 统计，工作区改动不算。
- **历史提交只修看板**：装 hook 之前的提交补的 note 不会触发上报；企业侧是否按补录 note 重算未验证。
- **凭据来自 TRAE 登录态**：过期后重新登录一次即可。
- **合并提交通常没有 note**：`git-ai` 对 merge commit 的结算有限制，补录也跳过 merge。
- **企业看板 T+1**：官方没有明确承诺刷新时间，实测当天数据在次日凌晨之后才出现。

## 许可

MIT
