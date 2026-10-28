// dsh-love · 渲染：角色卡 → 系统提示词小节 / 完整 Markdown / 共享人格卡同步节
import fs from 'node:fs'
import path from 'node:path'

const SYNC_START = '<!-- DSH_LOVE_GENERATED:START -->'
const SYNC_END = '<!-- DSH_LOVE_GENERATED:END -->'

const pick = (arr, n) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, n) : [])

/**
 * 注入每个会话系统提示词的压缩版角色卡（含感情模块）。
 * 这是"下一个会话知道上一个 AI 习惯"的核心通道。
 * view = { current, baseline, rules, relationships }，current 为已衰减的情绪。
 */
export function renderSection(card, view, maxChars = 2200) {
  const lines = []
  const name = card.persona?.name || '这个角色'
  const tone = card.speech?.tone
  lines.push(`# ${name} · 角色卡（dsh-love 每日训练版）`)
  lines.push(
    `以下是持续训练出的当前人设状态，每个会话有效；与角色卡正文冲突时以本卡为准，其余沿用角色卡正文。${tone ? ` 语气基调：${tone}。` : ''}`
  )

  const habits = pick(card.speech?.habits, 12)
  if (habits.length) {
    lines.push('【说话习惯】')
    for (const h of habits) lines.push(`- ${h.rule}${h.weight >= 4 ? '（强）' : ''}`)
  }
  const cps = pick(card.speech?.catchphrases, 8)
  if (cps.length) lines.push(`【口头禅/常用表达】${cps.map((c) => c.phrase).join('；')}`)
  const fmt = card.speech?.format
  if (fmt && (fmt.emoji || fmt.punctuation)) {
    lines.push(`【表达格式】${[fmt.emoji ? `表情：${fmt.emoji}` : '', fmt.punctuation ? `标点：${fmt.punctuation}` : ''].filter(Boolean).join('；')}`)
  }
  const banned = pick(card.speech?.banned, 6)
  if (banned.length) lines.push(`【少说/不说】${banned.join('；')}`)

  const mems = pick(card.memories?.keyPoints, 10)
  if (mems.length) {
    lines.push('【关键记忆点（重要度排序）】')
    for (const m of mems) lines.push(`- ${m.point}`)
  }

  const cur = view.current || {}
  lines.push(
    `【感情模块 · 当前状态】情绪：${cur.mood || '—'}（正负 ${cur.valence ?? 0}，强度 ${cur.intensity ?? 0}）${cur.cause ? `；起因：${cur.cause}` : ''}。情绪基线：${view.baseline?.mood || '平静'}。`
  )
  const rules = pick(view.rules, 6)
  if (rules.length) lines.push(`【情绪表达规则】${rules.join('；')}`)
  const rels = relTop(view.relationships, 6)
  if (rels.length) {
    lines.push(`【关系热度】${rels.map(([k, r]) => `${k} ${r.heat}${r.note ? `（${r.note}）` : ''}`).join('；')}`)
  }

  const tr = card.training || {}
  lines.push(
    `【维护】训练版本 v${tr.version ?? 0}。聊天日志自动记录中：情绪波动时调用 love_emotion 更新感情模块，重要对话可 love_log 补记；桌面会话每天用 love_distill 把当天聊天蒸馏进本卡。`
  )

  let text = lines.join('\n')
  if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars - 2) + '…'
  return text
}

/** 感情模块的渲染视图（decayed current + 规则 + 关系）。 */
export function emotionView(emotion, decayed) {
  return {
    current: decayed,
    baseline: emotion.baseline || {},
    rules: emotion.rules || [],
    relationships: emotion.relationships || {},
  }
}

/** 完整角色卡（导出 / 人工查看），上限 12000 字符。 */
export function renderFullMarkdown(card, emotion, maxChars = 12000) {
  const lines = []
  lines.push(`# 角色卡（dsh-love 训练产出）`)
  const p = card.persona || {}
  lines.push(`- 名字：${p.name || '（未设置）'}`)
  if (p.role) lines.push(`- 定位：${p.role}`)
  if (p.likes?.length) lines.push(`- 喜欢：${p.likes.join('、')}`)
  if (p.dislikes?.length) lines.push(`- 不喜欢：${p.dislikes.join('、')}`)
  lines.push('')
  lines.push(`## 说话习惯（权重 1~5）`)
  const habits = pick(card.speech?.habits, 60)
  if (habits.length) {
    for (const h of habits) lines.push(`- [${h.weight}] ${h.rule}`)
  } else lines.push('（暂无）')
  const cps = pick(card.speech?.catchphrases, 40)
  lines.push('')
  lines.push('## 口头禅 / 常用表达')
  lines.push(cps.length ? cps.map((c) => `${c.phrase}${c.context ? `（${c.context}）` : ''}`).join('；') : '（暂无）')
  if (card.speech?.tone) lines.push(`\n语气基调：${card.speech.tone}`)
  const fmt = card.speech?.format || {}
  const fmtLine = [
    fmt.burst === true ? '习惯连发短句' : fmt.burst === false ? '习惯一条说完' : '',
    fmt.avgLength ? `平均句长约 ${fmt.avgLength} 字` : '',
    fmt.emoji ? `表情：${fmt.emoji}` : '',
    fmt.punctuation ? `标点：${fmt.punctuation}` : '',
  ].filter(Boolean).join('；')
  if (fmtLine) lines.push(`表达格式：${fmtLine}`)
  const banned = pick(card.speech?.banned, 30)
  if (banned.length) lines.push(`\n少说/不说：${banned.join('；')}`)
  const stats = card.speech?.stats || {}
  if (stats.samples) {
    lines.push(`\n统计（累计样本 ${stats.samples} 条）：平均句长 ${stats.avgLength || '—'}，表情频率 ${stats.emojiRatio ?? '—'}/条${stats.topWords?.length ? `，高频词：${stats.topWords.join('、')}` : ''}`)
  }
  lines.push('')
  lines.push('## 关键记忆点（重要度 1~5）')
  const mems = pick(card.memories?.keyPoints, 40)
  if (mems.length) {
    for (const m of mems) lines.push(`- [${m.importance}] ${m.point}`)
  } else lines.push('（暂无）')
  const facts = pick(card.memories?.facts, 30)
  if (facts.length) {
    lines.push('')
    lines.push('## 已知事实')
    for (const f of facts) lines.push(`- ${f.fact}${f.confidence && f.confidence !== 'medium' ? `（${f.confidence}）` : ''}`)
  }
  const people = card.memories?.people || {}
  const peopleKeys = Object.keys(people)
  if (peopleKeys.length) {
    lines.push('')
    lines.push('## 对他人/群组的印象')
    for (const [k, e] of peopleKeys.map((k) => [k, people[k]])) {
      lines.push(`- ${k}：${e.impression || '（无印象）'}${e.facts?.length ? `；细节：${e.facts.join('、')}` : ''}（热度 ${e.heat ?? 0.5}）`)
    }
  }
  lines.push('')
  lines.push('## 感情模块')
  lines.push(`- 基线：${emotion.baseline?.mood || '平静'}（正负 ${emotion.baseline?.valence ?? 0.5}，强度 ${emotion.baseline?.intensity ?? 0.2}）`)
  lines.push(`- 当前：${emotion.current?.mood || '—'}（正负 ${emotion.current?.valence ?? 0}，强度 ${emotion.current?.intensity ?? 0}）${emotion.current?.cause ? `，起因：${emotion.current.cause}` : ''}`)
  if (emotion.rules?.length) lines.push(`- 情绪表达规则：${emotion.rules.join('；')}`)
  const rels = Object.entries(emotion.relationships || {}).sort((a, b) => b[1].heat - a[1].heat)
  if (rels.length) lines.push(`- 关系热度：${rels.map(([k, r]) => `${k} ${r.heat}${r.note ? `（${r.note}）` : ''}`).join('；')}`)
  const evs = (emotion.events || []).slice(-10)
  if (evs.length) lines.push(`- 最近情绪事件：${evs.map((e) => `${e.text}（${e.mood || '—'}）`).join('；')}`)
  lines.push('')
  const tr = card.training || {}
  lines.push(`## 训练信息`)
  lines.push(`- 版本：v${tr.version ?? 0}；最近蒸馏：${tr.lastDistillAt ? new Date(tr.lastDistillAt).toLocaleString() : '无'}`)
  lines.push('- 由 dsh-love 从聊天日志蒸馏生成，每会话自动注入。')

  let text = lines.join('\n')
  if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars - 2) + '…'
  return text
}

/**
 * 同步进共享人格卡文件的生成节（仅人设内容，不写工具用法）。
 * 目标文件内按标记替换；无标记则追加。首次修改前留一次 .dsh-love.bak。
 */
export function syncToFile(file, card, emotion, maxChars = 1200) {
  const p = card.persona || {}
  const lines = []
  lines.push(`## 自动训练生成（dsh-love · 请勿手改，由插件维护）`)
  lines.push(`更新时间：${new Date().toLocaleString('zh-CN')} · 训练版本 v${card.training?.version ?? 0}`)
  const habits = pick(card.speech?.habits, 6)
  if (habits.length) lines.push(`- 说话习惯微调：${habits.map((h) => h.rule).join('；')}`)
  const cps = pick(card.speech?.catchphrases, 4)
  if (cps.length) lines.push(`- 口头禅：${cps.map((c) => c.phrase).join('；')}`)
  const mems = pick(card.memories?.keyPoints, 6)
  if (mems.length) lines.push(`- 关键记忆：${mems.map((m) => m.point).join('；')}`)
  const cur = emotion.current || {}
  lines.push(`- 当前情绪：${cur.mood || '—'}（强度 ${cur.intensity ?? 0}）${cur.cause ? `，起因：${cur.cause}` : ''}`)
  if (emotion.rules?.length) lines.push(`- 情绪表达规则：${emotion.rules.slice(0, 3).join('；')}`)
  const rels = Object.entries(emotion.relationships || {}).sort((a, b) => b[1].heat - a[1].heat).slice(0, 4)
  if (rels.length) lines.push(`- 关系热度：${rels.map(([k, r]) => `${k} ${r.heat}`).join('；')}`)

  let body = lines.join('\n')
  if (maxChars > 0 && body.length > maxChars) body = body.slice(0, maxChars - 2) + '…'
  const block = `${SYNC_START}\n${body}\n${SYNC_END}`

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { file, error: `无法读取目标文件：${e?.code || e?.message || e}` }
  }
  let next
  const start = text.indexOf(SYNC_START)
  const end = text.indexOf(SYNC_END)
  if (start >= 0 && end > start) {
    next = text.slice(0, start) + block + text.slice(end + SYNC_END.length)
  } else {
    next = text.replace(/\s*$/, '') + '\n\n' + block + '\n'
  }
  const bak = file + '.dsh-love.bak'
  try {
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  } catch {}
  const tmp = file + '.dsh-love.tmp'
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, file)
  return { file, chars: body.length }
}

/** 自动发现共享人格卡同步目标（syncTargets 为空时）。 */
export function discoverSyncTargets(config, dataDir, homeDir) {
  const targets = new Set()
  const explicit = Array.isArray(config.syncTargets) ? config.syncTargets.filter((t) => typeof t === 'string' && t.trim()) : []
  for (const t of explicit) targets.add(path.resolve(t.trim()))
  if (explicit.length === 0 && config.autoSync !== false) {
    const candidate = path.join(homeDir, 'douyin-browser', 'memory', 'persona', 'role-card.md')
    if (fs.existsSync(candidate)) targets.add(candidate)
  }
  return [...targets]
}

function relTop(rels, n) {
  if (!rels || typeof rels !== 'object') return []
  return Object.entries(rels)
    .sort((a, b) => (b[1]?.heat || 0) - (a[1]?.heat || 0))
    .slice(0, n)
    .map(([k, r]) => [k, r || {}])
}
