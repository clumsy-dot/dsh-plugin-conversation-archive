# dsh-conversation-archive

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
2. **认领文件夹**：本对话用文件工具写进去的 `2026-11-22_xxx` 目录会被插件认作本次对话的产物目录；从下一轮起提示词直接给出它的绝对路径，模型不会再换名字，漏在根目录的文件也会归拢进它。别的对话在同一目录下建的文件夹不会被误认。
3. **兜底归拢**：对话开始时记录工作目录根层基线；每回合结束把「本回合新出现在根层的新文件」移进该文件夹。文本文件用文件服务原子移动，二进制或大文件用系统命令重命名。移动失败的文件留到下次重试，不会丢。
4. **随时可用**：`archive_outputs` 工具让模型主动归拢根目录里漏掉的产物，还能用 `topic` 指定主题让插件来建文件夹。

## 只动什么

- 只处理**工作目录根层**的文件；子目录、项目源码、仓库文件一律不碰。
- 只处理**本次对话开始后新出现**的文件；对话开始前就存在的文件永远不搬。
- 不覆盖同名文件：目标文件夹已有同名文件时改名成 `名称 (2).扩展名`。
- 会话中途切换工作目录后，在新目录下使用同名文件夹。

## 安装

插件包已发布在本仓库根目录，仓库带 GitHub 主题 [`dsh-plugin`](https://github.com/topics/dsh-plugin)。

**从插件市场/插件管理器安装**（需要 DSH 0.2.2 或更新的版本）：

```
plugin_manager install_bundle target=git+https://github.com/clumsy-dot/dsh-conversation-archive.git
```

**本地目录安装**：把仓库克隆到任意目录，然后在 DSH 的 **Plugins → Add plugin** 里选择该目录，或

```
plugin_manager install_bundle target=<仓库目录的绝对路径>
```

安装成功后会在 Plugins 里出现「对话产物归档」一行，新开一个对话即可生效。

## 卸载

```
plugin_manager remove_bundle target=dsh-conversation-archive
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

```yaml
- id: conversation-archive
  config:
    autoArchive: false
    topicMaxChars: 10
```

## 已知局限

- 无法区分「模型生成的」和「用户在同一回合里放进根目录的」新文件，两者都会被归拢；用 `ignorePatterns` 或关掉 `autoArchive` 规避。
- 模型若一直不建文件夹且写了根目录文件，兜底会用提示词首句截断出的临时主题建文件夹，名字可能不够好，改个名即可。
- 用脚本（不经文件工具）写出的产物文件夹不会被认领，此时兜底归拢会另建一个文件夹。
- 二进制/大文件依赖 `subprocess` 服务执行系统命令；没有它时这类文件留在原处并在结果里说明。
- 插件重载后的第一个回合只记录目录基线、不搬文件，之后的回合恢复正常。

## 开发

单文件 Host 插件，无运行时依赖（只用 `node:path`）。构建于 DSH `0.2.2-rc.5`。

```
index.js          插件主体（export name / inject / apply）
cordis.patch.yml  bundle 行
locale/*.json     Plugins 里的标题与说明
docs/DETAIL.md    插件详情页
icon.svg          图标
```

MIT License。
