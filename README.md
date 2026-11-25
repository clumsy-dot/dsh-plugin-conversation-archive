# dsh-plugin-conversation-archive

[![test](https://github.com/clumsy-dot/dsh-plugin-conversation-archive/actions/workflows/test.yml/badge.svg)](https://github.com/clumsy-dot/dsh-plugin-conversation-archive/actions/workflows/test.yml)

把每次对话生成的文件收进工作目录下的一个文件夹，而不是散落在根目录：

```
<工作目录>/
  2026-11-22_题库转换/
    题库转换.xlsx
    index.html
```

文件夹名 = `<日期>_<主题>`，主题是一句不超过 12 个字的概括。

## 它怎么工作

1. **先约定**：插件给每个会话的系统提示词加一段「本次对话的产物目录」，要求模型把交付文件放进工作目录下一个 `日期_主题` 文件夹，主题自己用一句短语概括（如 `题库转换`），不要照抄提问原句，临时文件放系统临时目录。
2. **认领文件夹**：本对话用**写类工具**（`write`/`edit`/脚本命令等；读取、搜索不算）产出过内容的 `日期_主题` 目录会被插件认作本次对话的产物目录；从下一轮起提示词直接给出它的绝对路径，模型不会再换名字，漏在根目录的文件也会归拢进它。别的对话在同一目录下建的文件夹不会被误认。
3. **兜底归拢**：对话开始时记录工作目录根层基线；每回合结束把「本回合新出现在根层的新文件」移进该文件夹（完全没有调用工具的回合会跳过扫描）。文本文件用文件服务原子移动，二进制或大文件用系统命令重命名，并带超时。移动失败的文件留到下次重试，不会丢。
4. **随时可用**：`archive_outputs` 工具让模型主动归拢根目录里漏掉的产物，还能用 `topic` 指定主题让插件来建文件夹。
5. **用户的文件也进同一个文件夹**：对话里用户发的附件会进该文件夹——**文件类默认搬入**（`userFileTransfer: copy` 可保留副本），**图片类始终保留副本**；提示词会列出"用户提供的文件 → 目录里的路径"，后续要重读就按新路径读。

## 只动什么

- 只处理**工作目录根层**的文件；子目录、项目源码、仓库文件一律不碰。
- 只处理**本次对话开始后新出现**的文件；对话开始前就存在的文件永远不搬。
- 不覆盖同名文件：目标文件夹已有同名文件时改名成 `名称 (2).扩展名`。
- 会话中途切换工作目录后，在新目录下使用同名文件夹。

## 安装

已发布到 npm，仓库同时带 GitHub 主题 [`dsh-plugin`](https://github.com/topics/dsh-plugin)。

**从 npm 安装**（最省事，需要 DSH 0.2.2 或更新的版本）：在 DSH 的 **Plugins → Add plugin** 里填包名

```
dsh-plugin-conversation-archive
```

或用命令

```
plugin_manager install_bundle target=dsh-plugin-conversation-archive
```

**从 GitHub 安装**：

```
plugin_manager install_bundle target=git+https://github.com/clumsy-dot/dsh-plugin-conversation-archive.git
```

**本地目录安装**：把仓库克隆到任意目录，在 **Plugins → Add plugin** 里填该目录路径，或

```
plugin_manager install_bundle target=<仓库目录的绝对路径>
```

安装成功后会在 Plugins 里出现 `dsh-plugin-conversation-archive` 一行，新开一个对话即可生效。

## 卸载

```
plugin_manager remove_bundle target=dsh-plugin-conversation-archive
```

已经归拢过的文件夹不会被自动搬回。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `conversation-archive` 这一行的 `config`（未写的键用默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoArchive` | `true` | 回合结束自动归拢根目录新文件 |
| `guidance` | `true` | 是否注入「本次对话的产物目录」提示 |
| `baseDir` | `''` | 空 = 会话工作目录；相对路径相对工作目录 |
| `topicMaxChars` | `12` | 主题名最大字符数 |
| `skipDotEntries` | `true` | 跳过 `.` 开头的新文件 |
| `ignorePatterns` | `[".git","node_modules","~$*","*.tmp","*.log"]` | 根层文件名匹配，支持 `*` |
| `maxTextMoveBytes` | `2097152` | 超过此大小的文件改用系统命令移动 |
| `turnEndBudgetMs` | `8000` | 每回合归拢的时间预算 |
| `includeSubagents` | `true` | 子代理会话同样处理 |
| `includeUserFiles` | `true` | 把用户对话中提供的附件放进产物文件夹 |
| `includeUserImages` | `false` | 粘贴的图片是否也算用户提供的文件 |
| `userFileTransfer` | `move` | 文件类附件用 `move`（搬入）还是 `copy`（保留副本）；图片始终 `copy` |
| `maxUserCopyBytes` | `20971520` | 单个用户附件超过此大小则不处理 |

```yaml
- id: conversation-archive
  config:
    autoArchive: false
    topicMaxChars: 10
```

## 已知局限

- 无法区分「模型生成的」和「用户在同一回合里放进根目录的」新文件，两者都会被归拢；用 `ignorePatterns` 或关掉 `autoArchive` 规避。
- 模型若一直不建文件夹且写了根目录文件，兜底会用提示词首句截断出的临时主题建文件夹，名字可能不够好，改个名即可。
- 用脚本（不经文件工具）写出的产物文件夹：只要命令里出现了 `日期_主题/…` 这样的路径就能被认领，认不出时兜底归拢会另建一个文件夹。
- 二进制/大文件依赖 `subprocess` 服务执行系统命令；没有它时这类文件留在原处并在结果里说明。
- 插件重载后的第一个回合只记录目录基线、不搬文件，之后的回合恢复正常。
- 搬移用户附件依赖附件服务给出本机路径（本机存储时可用）；远程存储的附件会跳过并在结果里说明。
- 文件类附件搬走后，会话里那条**原始引用**就失效了：插件会在提示词里给出新路径，模型按新路径重读没问题；但 Harness 自己按引用回读的场景（图片）必须保留副本，因此图片永远复制、不搬。
- 有分叉（fork）的会话共享同一份附件；如果搬走文件类附件，分叉里按引用回读会失败。

## 开发与测试

单文件 Host 插件，无运行时依赖（只用 `node:path`）。构建于 DSH `0.2.2-rc.5`。

```
index.js          插件主体（export name / inject / apply）
cordis.patch.yml  bundle 行
locale/*.json     Plugins 里的标题与说明
docs/DETAIL.md    插件详情页
icon.svg          图标
test/             行为测试
```

```
npm test          # 等价于 node --test test/index.test.js
```

测试用假的 Harness `ctx`（内存文件系统 + 假 Session）直接驱动插件注册的那三处：提示词段落、`archive_outputs` 工具、`agent/created` / `tools/result` / `agent/turn-stopping` 处理器，不碰真实磁盘和真实会话。CI 在 Node 22/24 上跑同一套测试。

MIT License。
