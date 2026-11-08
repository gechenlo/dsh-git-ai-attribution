# dsh-git-ai-attribution

把 DSH（DeepSeek Harness）里 AI 写的代码，计入 TRAE 企业版的「代码提交 AI 贡献度」。

它不是估算，而是走 TRAE 自己那条链路：用 `git-ai` 记录编辑前的基线、编辑后的增量，提交时结算成 Git note，再由 `git-ai` daemon 用 TRAE 的登录凭据上报给企业后端。**TRAE 不需要常驻**。

## 原理

```
DSH 调用 write/edit
   ├─ 编辑前：git-ai checkpoint (human)   ← 标记"此前的内容是人工的"
   ├─ 执行编辑
   └─ 编辑后：git-ai checkpoint (ai_agent) ← 只标记本次改动的文件
                    ↓
            仓库内 .git/trae-ai-tob（工作日志）
                    ↓  git commit
            refs/notes/ai-tob（逐行归属）
                    ↓  daemon 结算
            企业后端上报 → 控制台「AI 贡献度明细」
```

只统计 **DSH 自己成功执行的 `write` / `edit`**：PowerShell 等外部命令改的文件、插件加载前就存在的未提交改动，一律不计入，避免把人工代码算成 AI。

## 依赖

| 组件 | 说明 |
|---|---|
| DSH | 桌面版或 Web 版，profile 支持外置插件 |
| TRAE CN 客户端 | 只需安装并登录过一次（提供 `git-ai` 运行时和上报凭据），**不需要常驻运行** |
| Node.js | ≥ 20 |

`git-ai` 可执行文件和上报凭据都从本机 TRAE 里自动发现，不用手工配置。

## 安装

两步：**登记依赖**（让插件出现在插件市场）+ **挂载**（让 DSH 真正加载它）。

### 1. 登记依赖

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add github:gechenlo/dsh-git-ai-attribution#v0.3.0
```

开发调试时改用本地链接，改完源码重启即生效：

```powershell
pnpm add file:D:\work\dsh-git-ai-attribution
```

> `dsh plugin add` 在 desktop profile 上会被拒绝（该 profile 由 Electron 独占管理），所以直接用 `pnpm add`。自定义 `DSH_HOME` 时把路径里的 `.dsh` 换成实际目录。

### 2. 挂载

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: git-ai-attribution
      name: dsh-git-ai-attribution
      config:
        enabled: true
```

重启 DSH。

这条路径已经在 Windows + DSH 桌面版上反复验证过。**热重载注意**：该文件被修改时 DSH 会立即重载插件树，所以增删这个 `insert` 会即时生效，不需要重启。

### 可选：bundle 自动挂载（未充分验证）

包内自带 `cordis.patch.yml` 并声明了 `dsh.bundle`，理论上把包名写进 `dsh.profile.bundles` 就能免去第 2 步：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-git-ai-attribution"]
```

**但这条路径尚未在干净重启中验证**。如果采用它，务必不要同时保留上面的 `insert`——同一个 `id` 注册两次会被 loader 拒绝。

> 手动把目录拷进 `node_modules` 也能加载，但插件市场的「已安装」列表读的是 `package.json` 依赖，拷进去不会出现在列表里。


## 验证

不启动 DSH 也能自检：

```powershell
node scripts\check.mjs D:\path\to\a\git\repo
```

全部为 `true` 表示链路就绪：

```json
{"traeBundle":true,"appKey":true,"gitAi":true,"daemon":true,"registered":true}
```

然后在 DSH 里让 AI 改一个文件，看日志：

```powershell
Get-Content "$env:USERPROFILE\.dsh\git-ai-attribution.log" -Tail 5
```

期望出现：

```
attribution recorded repo=...\your-repo file=src/foo.ts ai_lines=12
```

提交后约 1 分钟结算：

```powershell
git notes --ref=ai-tob show HEAD
```

## 配置项

全部可选，一般不用写。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后完全不介入 |
| `agentName` | `dsh` | 写进 Git note 的工具名 |
| `traeBundlePath` | 自动发现 | TRAE 的 `resources/app/out/main.js` |
| `traeStoragePath` | 自动发现 | `%APPDATA%\Trae CN\User\globalStorage\storage.json` |
| `gitAiBinaryPath` | 取最新版本 | `git-ai.exe` 路径 |
| `daemonHome` | `$DSH_HOME/git-ai-daemon` | daemon 工作目录，与 TRAE 的互不干扰 |
| `commitLimit` | `200` | 面板最多显示多少提交 |
| `cacheTtlMs` | `30000` | 面板数据缓存时长 |
| `logPath` | `$DSH_HOME/git-ai-attribution.log` | 诊断日志 |

## 界面

DSH 对话上方会多一个「AI 归因」标签页：按仓库、按日期范围（默认今天）列出提交的 AI 行、总新增行、贡献率和模型。数据来自本机 Git notes，不依赖网络。

## 排查

| 现象 | 处理 |
|---|---|
| 日志 `daemon unavailable` | TRAE 没装或没登录过；先装一次并登录 |
| 日志 `skip attribution: daemon unavailable` | daemon 起不来，检查 `git-ai.exe` 是否被杀软拦截 |
| 日志 `attribution unconfirmed` | checkpoint 没落盘，通常是 15 秒超时；重试一次编辑 |
| 提交后 note 为空 | 该轮编辑发生在插件加载前，或仓库不在会话目录下 |
| 面板没有「AI 归因」标签 | 插件未加载，检查 `cordis.patch.yml` 的 `insert` 条目和 DSH 重启 |

`git-ai` 的客户端超时是 15 秒，而实际处理可能要 8~15 秒，所以命令返回非 0 **不代表失败**。插件用 `git-ai status --json` 复核真实结果，不靠退出码判断。

## 已知限制

- **只认 DSH 的 `write` / `edit`**：通过 PowerShell、后台任务、外部编辑器改的文件不会归因。
- **必须提交才有数据**：企业口径按 commit 统计，工作区改动不算。
- **凭据来自 TRAE 登录态**：长期不登录 TRAE、凭据过期后会上报失败，重新登录一次即可。
- **历史提交无法补录**：归因发生在编辑时刻，事后无法追溯。
- **合并提交通常没有 note**：`git-ai` 对 merge commit 的结算有限制。
- 企业看板的刷新时间官方没有明确承诺，实测当天数据在次日凌晨之后才出现。

## 许可

MIT
