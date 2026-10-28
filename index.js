// dsh-love · DeepSeek Harness 插件
//
// 功能：
//  1. 自动捕获聊天过程 —— 监听 tools/result，记录 AI 的 QQ 发言（send 工具）
//     与读取到的对话上下文（get/wait 工具），写入 <dataDir>/logs/YYYY-MM-DD.jsonl。
//  2. 每日蒸馏（训练）—— love_distill 把当天聊天提炼成说话习惯/口头禅/关键记忆，
//     合并进角色卡 card.json（去重、权重、限量、自动备份、可回滚），
//     并更新独立感情模块 emotion.json（情绪状态 + 半衰期衰减 + 关系热度）。
//  3. 跨会话生效 —— 把压缩版角色卡 + 感情模块注册为全局系统提示词小节，
//     每个会话（包括 QQ 仿真会话）每次装配都会带上，保证下一个 AI 知道上一个的习惯。
//  4. 共享人格卡同步 —— 蒸馏后把生成节写入配置的共享人格卡文件（标记替换，可回滚）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store, clamp, str, sanitize, todayOf } from './lib/store.js'
import { renderSection, renderFullMarkdown, syncToFile, emotionView, discoverSyncTargets } from './lib/render.js'

export const name = 'dsh-love'
export const inject = ['tools', 'systemPrompt']

const SEND_TOOLS = new Set([
  'mcp__snowluma__qq_send_message',
  'mcp__snowluma__qq_send_burst',
  'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_private_message',
  'mcp__snowluma__qq_reply',
  'mcp__snowluma__qq_send_sticker',
  'mcp__snowluma__qq_send_poke',
])

const READ_TOOLS = new Set([
  'mcp__snowluma__qq_get_recent_messages',
  'mcp__snowluma__qq_get_unread_messages',
  'mcp__snowluma__qq_wait_for_messages',
  'mcp__snowluma__qq_get_group_history',
  'mcp__snowluma__qq_get_message_detail',
  'mcp__snowluma__qq_get_my_recent_messages',
])

function resolveDataDir(config) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim()) return path.resolve(config.dataDir.trim())
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-love')
}

// ── 捕获 ──────────────────────────────────────────────────────────────────

function chatKeyOf(args) {
  if (!args || typeof args !== 'object') return undefined
  if (typeof args.key === 'string' && args.key) return args.key
  if (args.groupId !== undefined) return `group:${args.groupId}`
  if (args.userId !== undefined) return `private:${args.userId}`
  return undefined
}

function extractOutgoing(name, args) {
  const out = []
  const push = (m) => {
    if (typeof m === 'string' && m.trim()) out.push(m.trim().slice(0, 1000))
  }
  if (!args || typeof args !== 'object') return out
  if (name.endsWith('qq_send_sticker')) {
    out.push(`[表情:${typeof args.stickerId === 'string' ? args.stickerId.slice(0, 40) : 'sticker'}]`)
    return out
  }
  if (name.endsWith('qq_send_poke')) {
    out.push('[拍一拍]')
    return out
  }
  let ms = args.messages
  if (typeof ms === 'string' && ms.startsWith('[')) {
    try {
      const parsed = JSON.parse(ms)
      if (Array.isArray(parsed)) ms = parsed
    } catch {}
  }
  if (Array.isArray(ms)) {
    for (const m of ms) push(m)
    return out
  }
  if (typeof ms === 'string') {
    push(ms)
    return out
  }
  push(args.message)
  return out
}

function extractIncoming(result) {
  const items = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (depth > 6 || items.length >= 40) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1)
      return
    }
    if (node && typeof node === 'object') {
      const text = typeof node.text === 'string' ? node.text : undefined
      if (text && text.trim()) {
        const who =
          node.who ?? node.from ?? node.sender ?? node.userName ?? node.nickname ?? (node.userId !== undefined ? String(node.userId) : undefined)
        const id = node.messageId ?? node.seq ?? node.id
        const key = String(id ?? '') + '|' + text.slice(0, 80)
        if (!seen.has(key)) {
          seen.add(key)
          items.push({ who: who ? String(who).slice(0, 60) : undefined, text: text.slice(0, 240) })
        }
      }
      for (const v of Object.values(node)) walk(v, depth + 1)
    }
  }
  const texts = []
  if (result?.value !== undefined) {
    try {
      texts.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value).slice(0, 20000))
    } catch {}
  }
  for (const block of result?.content || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text.slice(0, 20000))
  }
  for (const t of texts) {
    try {
      walk(JSON.parse(t), 0)
    } catch {
      /* 非 JSON 文本：跳过 */
    }
  }
  return items.slice(0, 40)
}

function captureResult(store, config, exec, result) {
  try {
    const toolName = exec?.name
    if (!toolName || !toolName.startsWith('mcp__snowluma__')) return
    if (config.captureSends !== false && SEND_TOOLS.has(toolName)) {
      const args = sanitize(exec?.arguments)
      const messages = extractOutgoing(toolName, args || {})
      if (messages.length) {
        store.appendLog(store.today(), {
          t: Date.now(),
          kind: 'send',
          via: toolName.replace('mcp__snowluma__', ''),
          chat: chatKeyOf(args),
          messages,
        })
      }
      return
    }
    if (config.captureReads !== false && READ_TOOLS.has(toolName)) {
      if (result?.isError) return
      const args = sanitize(exec?.arguments)
      const items = extractIncoming(result)
      // 去重：同一段对话反复读取不重复记账
      const fresh = items.filter((it) => store.seenKey(store.today(), `${toolName}|${it.who ?? ''}|${it.text}`))
      if (fresh.length) {
        store.appendLog(store.today(), {
          t: Date.now(),
          kind: 'in',
          via: toolName.replace('mcp__snowluma__', ''),
          chat: chatKeyOf(args),
          items: fresh,
        })
      }
    }
  } catch {
    /* 捕获永不破坏工具管线 */
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

const textOf = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

const normMsgs = (list, max) =>
  Array.isArray(list)
    ? list
        .slice(0, max)
        .map((m) => {
          if (typeof m === 'string') return { who: undefined, text: str(m, 1000) }
          if (m && typeof m === 'object') return { who: str(m.who, 60) || undefined, text: str(m.text, 1000) }
          return null
        })
        .filter((m) => m && m.text)
    : []

function toolDefs(store, config) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

  const loveStatus = {
    name: 'love_status',
    description:
      '查看 dsh-love 角色卡与感情模块的最新状态：训练版本、今日已自动记录的聊天样本统计、当前情绪与维护提示。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute() {
      store.maybeReload()
      const day = store.today()
      const stats = store.statsFor(day)
      const cur = store.decayedEmotion()
      return {
        dataDir: store.dir,
        cardVersion: store.card.training?.version ?? 0,
        persona: store.card.persona?.name || null,
        today: { day, loggedLines: store.readLog(day).length, ...stats },
        emotion: {
          current: { mood: cur.mood, valence: cur.valence, intensity: cur.intensity, cause: cur.cause || null },
          baseline: store.emotion.baseline,
        },
        habits: (store.card.speech?.habits || []).length,
        keyMemories: (store.card.memories?.keyPoints || []).length,
        lastDistillAt: store.card.training?.lastDistillAt ?? null,
        hint: '情绪波动时调用 love_emotion；重要对话可 love_log 补记；桌面会话每天用 love_distill 蒸馏训练。',
      }
    },
  }

  const loveLog = {
    name: 'love_log',
    description:
      '把一段值得保留的聊天片段记入今天的聊天日志（供蒸馏使用）。自动捕获漏掉的对话、或想强调的交流可调用它补记。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '会话标识，如 group:群号 或 private:QQ号' },
        platform: { type: 'string', description: '可选，如 qq / douyin / dsh' },
        incoming: {
          type: 'array',
          description: '对方说的话',
          items: {
            type: 'object',
            properties: { who: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
          },
        },
        outgoing: {
          type: 'array',
          description: '自己（AI）说的话',
          items: {
            type: 'object',
            properties: { who: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
          },
        },
        note: { type: 'string', description: '为什么记这段（情绪、梗、重要事实等），最多 300 字' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute(args = {}) {
      const incoming = normMsgs(args.incoming, 30)
      const outgoing = normMsgs(args.outgoing, 30)
      const note = str(args.note, 300)
      if (!incoming.length && !outgoing.length && !note) return { ok: false, reason: '没有可记录的内容' }
      await store.appendLog(store.today(), {
        t: Date.now(),
        kind: 'log',
        chat: str(args.chat, 80) || undefined,
        platform: str(args.platform, 20) || undefined,
        incoming,
        outgoing,
        note: note || undefined,
      })
      return { ok: true, day: store.today(), recorded: { incoming: incoming.length, outgoing: outgoing.length } }
    },
  }

  const loveDistill = {
    name: 'love_distill',
    description:
      '把一天（默认今天）的聊天日志蒸馏成角色卡更新，这是一次“训练”：' +
      '读取当日聊天样本计算统计（平均句长、表情频率、高频词）；把你提炼的说话习惯/口头禅/关键记忆合并进角色卡（带权重、去重、限量，旧版自动备份可回滚）；' +
      '更新独立感情模块（先做情绪衰减再应用你给的情绪更新）；重新渲染角色卡并同步到共享人格卡文件。返回新版本号与合并/裁剪结果。',
    parameters: {
      type: 'object',
      properties: {
        day: { type: 'string', description: '要蒸馏的日志日期 YYYY-MM-DD，默认今天' },
        speechHabits: {
          type: 'array',
          description: '从今天的对话里提炼出的说话习惯（越具体越好）',
          items: {
            type: 'object',
            properties: {
              rule: { type: 'string', description: '一条说话习惯/风格规则' },
              weight: { type: 'integer', description: '重要度 1~5，默认 3' },
            },
            required: ['rule'],
          },
        },
        dropHabits: { type: 'array', items: { type: 'string' }, description: '已过时、要删除的旧习惯（原文精确匹配）' },
        catchphrases: {
          type: 'array',
          description: '口头禅/常用表达',
          items: {
            type: 'object',
            properties: { phrase: { type: 'string' }, context: { type: 'string' } },
            required: ['phrase'],
          },
        },
        tone: { type: 'string', description: '更新的语气基调描述（可选）' },
        banned: { type: 'array', items: { type: 'string' }, description: '新增的“少说/不说”表达' },
        keyMemories: {
          type: 'array',
          description: '必须跨会话记住的关键记忆点（事实、梗、关系、约定）',
          items: {
            type: 'object',
            properties: {
              point: { type: 'string', description: '一条关键记忆点' },
              importance: { type: 'integer', description: '重要度 1~5，默认 3' },
            },
            required: ['point'],
          },
        },
        dropMemories: { type: 'array', items: { type: 'string' }, description: '要删除的旧记忆（原文匹配）' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { fact: { type: 'string' }, confidence: { type: 'string' } },
            required: ['fact'],
          },
        },
        people: {
          type: 'object',
          description: '按人更新的印象：{ "group:1234": { "impression": "...", "heat": 0.7, "facts": ["..."] } }',
        },
        emotion: {
          type: 'object',
          properties: {
            mood: { type: 'string', description: '情绪词，如 开心/烦躁/平静' },
            valence: { type: 'number', description: '-1(负面)~1(正面)' },
            intensity: { type: 'number', description: '0~1 强度' },
            cause: { type: 'string', description: '起因' },
            event: { type: 'string', description: '情绪事件描述，记入感情模块历史' },
          },
        },
        summary: { type: 'string', description: '一句话蒸馏摘要，写入训练日志' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute(args = {}) {
      store.maybeReload()
      const day = /^\d{4}-\d{2}-\d{2}$/.test(args.day || '') ? args.day : store.today()
      const summary = store.applyDistill(args || {}, day, Date.now())
      await store.save()
      // 自己的完整卡渲染
      try {
        fs.mkdirSync(store.dir, { recursive: true })
        fs.writeFileSync(path.join(store.dir, 'role-card.md'), renderFullMarkdown(store.card, store.emotion), 'utf8')
      } catch {}
      // 共享人格卡同步
      const targets = discoverSyncTargets(config, store.dir, home)
      summary.synced = []
      for (const file of targets) {
        try {
          summary.synced.push(syncToFile(file, store.card, store.emotion, 1200))
        } catch (e) {
          summary.synced.push({ file, error: String(e?.message ?? e) })
        }
      }
      return summary
    },
  }

  const loveEmotion = {
    name: 'love_emotion',
    description:
      '读取或更新 dsh-love 独立感情模块：情绪状态跨会话持久、按半衰期衰减回基线，并注入每个会话。' +
      'QQ 聊天中情绪有明显波动（被夸/被惹/安慰人等）就调用它记录；action=read 只读当前状态。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'update', 'event', 'relation', 'rule', 'baseline'],
          description:
            'read=只读当前状态；update=更新情绪(mood/valence/intensity/cause)；event=记一条情绪事件(cause)；relation=更新与某会话/某人的关系热度(key/heat/note)；rule=添加/删除情绪表达规则(rule/remove)；baseline=调整情绪基线',
        },
        mood: { type: 'string', description: '情绪词，如 开心/烦躁/平静' },
        valence: { type: 'number', description: '-1(负面)~1(正面)' },
        intensity: { type: 'number', description: '0~1 强度' },
        cause: { type: 'string', description: 'update/event 时：起因或事件描述' },
        key: { type: 'string', description: 'relation 时：会话标识 group:群号 / private:QQ号 / 人名' },
        heat: { type: 'number', description: 'relation 时：0~1 关系热度' },
        note: { type: 'string', description: 'relation 时：关系备注' },
        rule: { type: 'string', description: 'rule 时：要添加或删除的情绪表达规则原文' },
        remove: { type: 'boolean', description: 'rule 时：true 表示删除该规则' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute(args = {}) {
      store.maybeReload()
      const now = Date.now()
      const action = args.action || 'read'
      const emo = store.emotion
      let changed = false
      if (action === 'update') {
        if (typeof args.mood === 'string' && args.mood.trim()) {
          emo.current.mood = str(args.mood, 40)
          changed = true
        }
        if (typeof args.valence === 'number') {
          emo.current.valence = clamp(args.valence, -1, 1, 0)
          changed = true
        }
        if (typeof args.intensity === 'number') {
          emo.current.intensity = clamp(args.intensity, 0, 1, 0.5)
          changed = true
        }
        if (changed) {
          emo.current.since = now
          emo.current.cause = str(args.cause, 120)
        }
      } else if (action === 'event') {
        const text = str(args.cause, 200)
        if (!text) return { ok: false, reason: 'event 需要 cause 描述事件' }
        const cur = store.decayedEmotion(now)
        emo.events = [
          ...(Array.isArray(emo.events) ? emo.events : []),
          { t: now, mood: cur.mood, valence: cur.valence, intensity: cur.intensity, text },
        ].slice(-100)
        changed = true
      } else if (action === 'relation') {
        const key = str(args.key, 80)
        if (!key) return { ok: false, reason: 'relation 需要 key' }
        const rel = (emo.relationships[key] ??= { heat: 0.5, note: '', lastAt: now })
        if (typeof args.heat === 'number') rel.heat = clamp(args.heat, 0, 1, rel.heat)
        if (typeof args.note === 'string' && args.note.trim()) rel.note = str(args.note, 200)
        rel.lastAt = now
        changed = true
      } else if (action === 'rule') {
        const rule = str(args.rule, 200)
        if (!rule) return { ok: false, reason: 'rule 需要规则原文' }
        const rules = (emo.rules ??= [])
        if (args.remove) {
          const before = rules.length
          emo.rules = rules.filter((r) => r !== rule)
          changed = before !== emo.rules.length
        } else if (!rules.includes(rule)) {
          rules.push(rule)
          if (rules.length > 30) rules.shift()
          changed = true
        }
      } else if (action === 'baseline') {
        if (typeof args.mood === 'string' && args.mood.trim()) {
          emo.baseline.mood = str(args.mood, 40)
          changed = true
        }
        if (typeof args.valence === 'number') {
          emo.baseline.valence = clamp(args.valence, -1, 1, emo.baseline.valence)
          changed = true
        }
        if (typeof args.intensity === 'number') {
          emo.baseline.intensity = clamp(args.intensity, 0, 1, emo.baseline.intensity)
          changed = true
        }
      }
      if (changed) await store.save()
      const fresh = store.decayedEmotion()
      return {
        ok: true,
        action,
        changed,
        current: { mood: fresh.mood, valence: fresh.valence, intensity: fresh.intensity, cause: fresh.cause || null, since: fresh.since },
        baseline: emo.baseline,
        rules: emo.rules,
        relationships: emo.relationships,
        recentEvents: (emo.events || []).slice(-5),
      }
    },
  }

  const loveCard = {
    name: 'love_card',
    description:
      '直接读写角色卡（人工微调入口）：read 查看整卡或某节；edit 把 JSON 合并进 persona/speech/memories 节；rollback 回滚到历史版本备份。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'edit', 'rollback'] },
        section: { type: 'string', enum: ['persona', 'speech', 'memories', 'all'], description: 'read/edit 时指定节' },
        patch: { type: 'object', description: 'edit 时：要合并进该节的 JSON 对象' },
        version: { type: 'integer', description: 'rollback 时：回滚到的版本号，默认上一个版本' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute(args = {}) {
      store.maybeReload()
      const action = args.action || 'read'
      if (action === 'read') {
        return {
          cardVersion: store.card.training?.version ?? 0,
          persona: store.card.persona,
          speech: store.card.speech,
          memories: store.card.memories,
          training: store.card.training,
          emotionCurrent: store.decayedEmotion(),
          emotionModule: { baseline: store.emotion.baseline, rules: store.emotion.rules, relationships: store.emotion.relationships },
        }
      }
      if (action === 'edit') {
        const section = args.section
        if (!section || !['persona', 'speech', 'memories', 'all'].includes(section)) {
          return { ok: false, reason: 'edit 需要 section（persona/speech/memories/all）' }
        }
        if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
          return { ok: false, reason: 'edit 需要 JSON 对象 patch' }
        }
        const clean = sanitize(args.patch)
        if (section === 'all') {
          if (clean?.persona && typeof clean.persona === 'object') Object.assign(store.card.persona, clean.persona)
          if (clean?.speech && typeof clean.speech === 'object') Object.assign(store.card.speech, clean.speech)
          if (clean?.memories && typeof clean.memories === 'object') Object.assign(store.card.memories, clean.memories)
        } else {
          Object.assign(store.card[section], clean || {})
        }
        await store.save()
        return { ok: true, action: 'edit', section, cardVersion: store.card.training?.version ?? 0 }
      }
      if (action === 'rollback') {
        const version = Number.isInteger(args.version) ? args.version : (store.card.training?.version ?? 1) - 1
        const file = path.join(store.backupDir, `card-v${version}.json`)
        try {
          const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
          const currentVersion = store.card.training?.version ?? 0
          fs.mkdirSync(store.backupDir, { recursive: true })
          fs.writeFileSync(path.join(store.backupDir, `card-v${currentVersion}.json`), JSON.stringify(store.card, null, 2), 'utf8')
          store.card = prev
          await store.save()
          return { ok: true, action: 'rollback', fromVersion: currentVersion, toVersion: version }
        } catch (e) {
          return { ok: false, reason: `回滚失败（版本 ${version} 备份不存在或损坏）：${e?.message ?? e}` }
        }
      }
      return { ok: false, reason: `未知 action：${action}` }
    },
  }

  const loveExport = {
    name: 'love_export',
    description:
      '把角色卡+感情模块渲染成完整 Markdown 或 JSON 导出到文件（默认写到 dsh-love 数据目录，也可给绝对路径），便于人工查看、备份或喂给其它系统。',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['md', 'json'], description: '导出格式，默认 md' },
        path: { type: 'string', description: '输出文件绝对路径（可选）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => textOf(value) },
    async execute(args = {}) {
      store.maybeReload()
      const fmt = args.format === 'json' ? 'json' : 'md'
      const outFile =
        typeof args.path === 'string' && args.path.trim()
          ? path.resolve(args.path.trim())
          : path.join(store.dir, fmt === 'md' ? 'role-card.export.md' : 'card.export.json')
      const text =
        fmt === 'md'
          ? renderFullMarkdown(store.card, store.emotion)
          : JSON.stringify({ card: store.card, emotion: store.emotion }, null, 2)
      await fs.promises.mkdir(path.dirname(outFile), { recursive: true })
      await fs.promises.writeFile(outFile, text, 'utf8')
      return { ok: true, file: outFile, chars: text.length }
    },
  }

  return { loveStatus, loveLog, loveDistill, loveEmotion, loveCard, loveExport }
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const store = new Store({ ...config, dataDir: resolveDataDir(config) })
  const defs = toolDefs(store, config)

  // 1) 每个会话注入：角色卡 + 感情模块（全局小节，QQ 仿真会话同样生效）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'dsh-love:persona-card',
        order: Number.isFinite(config.sectionOrder) ? config.sectionOrder : 300,
        interpolate: false,
        text: () => {
          store.maybeReload()
          return renderSection(store.card, emotionView(store.emotion, store.decayedEmotion()), config.maxInjectedChars ?? 2200)
        },
      }),
    'dsh-love.section()',
  )

  // 2) 聊天过程自动捕获
  ctx.on('tools/result', (exec, result) => captureResult(store, config, exec, result))

  // 3) 工具注册
  for (const def of Object.values(defs)) ctx.effect(() => ctx.tools.register(def), `dsh-love.${def.name}()`)

  // 4) 过期日志清理
  try {
    store.cleanupOldLogs(typeof config.logKeepDays === 'number' ? config.logKeepDays : 30)
  } catch {}
}
