# dsh-love

把 **每天的聊天过程** 蒸馏成 **可更新的角色卡** 与 **跨会话感情模块**，持续训练角色卡（重点是保留说话习惯、保住关键记忆点）。

DeepSeek Harness（Cordis）插件。装好之后：

- **自动记录**：AI 的 QQ 发言、读到的对话上下文会自动写进 `logs/YYYY-MM-DD.jsonl`（不记录 token 等敏感字段，量有上限，只存本机）。
- **每天蒸馏（训练）**：桌面会话里调用 `love_distill`，把当天聊天提炼成说话习惯（带权重）、口头禅、关键记忆点，合并进角色卡——自动去重、限量、备份旧版、可回滚。
- **每个会话生效**：压缩版角色卡 + 感情模块被注册成全局系统提示词小节，**所有会话（含 QQ 仿真会话）每次装配都会带上**，所以下一个 AI 一定知道上一个 AI 的习惯。
- **独立感情模块**：情绪状态（正负/强度/起因）、情绪表达规则、关系热度单独存一份 `emotion.json`，跨会话持久，按半衰期衰减回基线；QQ 聊天里就能用 `love_emotion` 更新。
- **训练共享人格卡**：蒸馏后自动把生成节同步进共享人格卡文件（标记替换、留 `.dsh-love.bak` 备份），douyin 人格卡等读它的系统立刻拿到新习惯。

## 安装

本插件是一个 Host-only bundle。在 DSH 里：

```
plugin_manager  install_bundle  <本仓库绝对路径>
```

（或把仓库目录作为 `install_bundle` 的 `target`。）不需要构建、没有依赖。

## 数据目录

默认 `<DSH_HOME>/dsh-love/`（Windows 上是 `C:\Users\<你>\.dsh\dsh-love\`）：

| 文件 | 内容 |
| --- | --- |
| `card.json` | 角色卡：说话习惯 / 口头禅 / 语气 / 黑名单表达 / 关键记忆 / 按人印象 / 训练版本 |
| `emotion.json` | 感情模块：基线、当前情绪、衰减参数、表达规则、事件史、关系热度 |
| `logs/YYYY-MM-DD.jsonl` | 每天聊天日志（自动捕获 + `love_log` 补记），保留 30 天 |
| `training/backups/card-v<N>.json` | 每次蒸馏前的旧卡备份（`love_card rollback` 回滚用） |
| `role-card.md` | 渲染出的完整角色卡（可人工查看 / 复制到别处） |

## 工具

| 工具 | 用途 |
| --- | --- |
| `love_status` | 看训练版本、今日样本统计、当前情绪 |
| `love_log` | 补记一段重要对话到今天的日志 |
| `love_distill` | **每日训练**：把一天聊天蒸馏进角色卡 + 更新感情模块 + 同步共享人格卡 |
| `love_emotion` | 读/更新感情模块（情绪、事件、关系热度、表达规则、基线） |
| `love_card` | 直接读/改角色卡节，或回滚到历史版本 |
| `love_export` | 把整卡+感情模块导出成 Markdown / JSON |

## 每日工作流（训练循环）

1. 白天：QQ 聊天自动落日志；AI 情绪波动时自己调 `love_emotion`。
2. 每天结束（桌面会话）：调 `love_distill`，带上当天提炼出的：
   - `speechHabits`（说话习惯，重要度 1~5）与过时习惯的 `dropHabits`
   - `catchphrases`、`tone`、`banned`
   - `keyMemories`（关键记忆点，重要度 1~5）与 `dropMemories`
   - `people`（对群友/群组的印象、关系热度）、`emotion`（当天情绪总结）
3. 插件自动：统计当天样本（平均句长、表情频率、高频词）→ 合并去重限量 → 备份旧卡 → 版本 +1 → 重渲染 `role-card.md` → 同步共享人格卡。
4. 下一个会话开始时，系统提示词里自动带上新卡（说话习惯、关键记忆、当前情绪）。

## 与 QQ 桥接（SnowLuma）配合

QQ 仿真会话（`qq-chat-v2` 等预设）是普通 DSH 会话，因此本插件的系统提示词小节会自动进入每个 QQ 会话 —— 角色卡与感情模块随每次装配生效，不占桥接每消息 6000 字符的人格卡预算。

要在 QQ 会话**内**更新感情模块，桥接守卫需要放行三个只读/只写本店数据的工具。在 `qq-tool-restrict` 的 `SAFE_EXACT` 里加：

```js
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'love_status', 'love_emotion', 'love_log', // dsh-love
])
```

并建议在守卫里把训练工具留在桌面会话：

```js
try { ctx.tools.restrict({ deny: ['love_distill', 'love_card', 'love_export'] }) } catch {}
```

## 配置（cordis.patch.yml 行 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `''` | 数据目录，空 = `<DSH_HOME>/dsh-love` |
| `captureSends` | `true` | 自动记录 AI 的 QQ 发言 |
| `captureReads` | `true` | 自动记录读到的对话上下文 |
| `autoSync` | `true` | 蒸馏后同步共享人格卡 |
| `syncTargets` | `[]` | 同步目标文件列表；空 = 自动找 `<DSH_HOME>/douyin-browser/memory/persona/role-card.md` |
| `sectionOrder` | `300` | 系统提示词小节顺序（0 与 500 之间 = 人格前缀之后） |
| `maxInjectedChars` | `2200` | 注入每个会话的最大字符数 |
| `logKeepDays` | `30` | 聊天日志保留天数 |

## 隐私与安全

- 聊天日志只写本机 `<DSH_HOME>/dsh-love/`，不上传任何地方。
- 捕获时会剔除 `token` / `password` / `secret` 等敏感字段。
- 每份日志有大小/条数上限，超限自动剪头保尾。
- 蒸馏只做本机文件读写，不调用任何模型 API；提炼由调用 `love_distill` 的 AI 完成。

## License

MIT
