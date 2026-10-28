// dsh-love · 持久化与状态核心
// 数据模型：
//   <dataDir>/card.json      —— 角色卡（说话习惯 / 关键记忆 / 训练版本）
//   <dataDir>/emotion.json   —— 独立感情模块（情绪状态 / 衰减 / 关系热度 / 表达规则）
//   <dataDir>/logs/YYYY-MM-DD.jsonl —— 每天聊天日志（自动捕获 + love_log 补记）
//   <dataDir>/training/backups/card-v<N>.json —— 每次蒸馏前的旧卡备份（回滚用）
//   <dataDir>/role-card.md   —— 渲染出的完整角色卡（可复制给其它系统）
import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1

export function defaultCard() {
  return {
    schemaVersion: SCHEMA_VERSION,
    persona: { name: '', role: '', likes: [], dislikes: [] },
    speech: {
      tone: '',
      habits: [], // [{ rule, weight(1~5), source, at }]
      catchphrases: [], // [{ phrase, context, at }]
      format: { burst: null, avgLength: null, emoji: '', punctuation: '' },
      banned: [], // 少说/不说
      stats: { samples: 0, avgLength: 0, emojiRatio: 0, topWords: [] },
    },
    memories: {
      keyPoints: [], // [{ point, importance(1~5), at, source }]
      facts: [], // [{ fact, confidence, at }]
      people: {}, // key -> { impression, facts: [], heat, lastSeen }
    },
    training: { version: 0, lastDistillAt: null, sessionCount: 0, log: [] },
  }
}

export function defaultEmotion() {
  return {
    schemaVersion: SCHEMA_VERSION,
    baseline: { mood: '平静', valence: 0.5, intensity: 0.2 },
    current: { mood: '平静', valence: 0.5, intensity: 0.2, since: Date.now(), cause: '' },
    decay: { halfLifeHours: 8, floor: 0.05 },
    rules: [], // 情绪表达规则（跨会话有效）
    events: [], // [{ t, mood, valence, intensity, text }] 最近 100 条
    relationships: {}, // key -> { heat(0~1), note, lastAt }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

export const clamp = (v, lo, hi, fallback) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback

export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function todayOf(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const EMOJI_RE = (() => {
  try {
    return new RegExp('\\p{Extended_Pictographic}', 'gu')
  } catch {
    return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu
  }
})()

/** 递归清洗：去敏感键、截断字符串、限制数组长度。 */
export function sanitize(value, depth = 0) {
  if (value === null || typeof value === 'undefined') return undefined
  if (typeof value === 'string') return value.slice(0, 600)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth > 6) return []
    return value.slice(0, 60).map((v) => sanitize(v, depth + 1)).filter((v) => v !== undefined)
  }
  if (isPlainObject(value)) {
    if (depth > 6) return {}
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|password|secret|authorization|credential)$/i.test(k)) continue
      const clean = sanitize(v, depth + 1)
      if (clean !== undefined) out[k] = clean
    }
    return out
  }
  return undefined
}

// ── Store ─────────────────────────────────────────────────────────────────

export class Store {
  constructor(cfg = {}) {
    this.dir = cfg.dataDir
    this.logsDir = path.join(this.dir, 'logs')
    this.trainingDir = path.join(this.dir, 'training')
    this.backupDir = path.join(this.trainingDir, 'backups')
    this.cardLoadedAt = 0
    this.emotionLoadedAt = 0
    this.reloadCheckedAt = 0
    this._logQueue = Promise.resolve()
    this._seen = new Map() // day -> Set(去重键)
    this.card = this.loadJson('card.json', defaultCard())
    this.emotion = this.loadJson('emotion.json', defaultEmotion())
    this.cardLoadedAt = this.emotionLoadedAt = Date.now()
    // 结构自愈：旧文件缺字段时补默认值
    this.card = deepMerge(defaultCard(), this.card)
    this.emotion = deepMerge(defaultEmotion(), this.emotion)
  }

  file(name) {
    return path.join(this.dir, name)
  }

  today() {
    return todayOf()
  }

  loadJson(name, fallback) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
      return isPlainObject(raw) ? raw : structuredClone(fallback)
    } catch {
      return structuredClone(fallback)
    }
  }

  /** 外部改动检测（节流 10s）：角色卡文件可被人工编辑，渲染时跟进。 */
  maybeReload() {
    const now = Date.now()
    if (now - this.reloadCheckedAt < 10000) return
    this.reloadCheckedAt = now
    try {
      const c = fs.statSync(this.file('card.json'))
      if (c.mtimeMs > this.cardLoadedAt) {
        this.card = deepMerge(defaultCard(), this.loadJson('card.json', defaultCard()))
        this.cardLoadedAt = Date.now()
      }
      const e = fs.statSync(this.file('emotion.json'))
      if (e.mtimeMs > this.emotionLoadedAt) {
        this.emotion = deepMerge(defaultEmotion(), this.loadJson('emotion.json', defaultEmotion()))
        this.emotionLoadedAt = Date.now()
      }
    } catch {
      /* 文件尚不存在：用内存态 */
    }
  }

  async save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch {}
    await this.atomicWrite(this.file('card.json'), JSON.stringify(this.card, null, 2))
    await this.atomicWrite(this.file('emotion.json'), JSON.stringify(this.emotion, null, 2))
    this.cardLoadedAt = this.emotionLoadedAt = Date.now()
  }

  async atomicWrite(file, text) {
    const tmp = file + '.tmp'
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(tmp, text, 'utf8')
    await fs.promises.rename(tmp, file)
  }

  // ── 聊天日志 ──────────────────────────────────────────────────────────

  logFile(day) {
    return path.join(this.logsDir, `${day}.jsonl`)
  }

  appendLog(day, entry) {
    const task = async () => {
      try {
        await fs.promises.mkdir(this.logsDir, { recursive: true })
        await fs.promises.appendFile(this.logFile(day), JSON.stringify(entry) + '\n', 'utf8')
        try {
          const st = await fs.promises.stat(this.logFile(day))
          if (st.size > 8 * 1024 * 1024) this.trimLog(day)
        } catch {}
      } catch {}
    }
    this._logQueue = this._logQueue.then(task, task)
    return this._logQueue
  }

  trimLog(day) {
    try {
      const lines = fs.readFileSync(this.logFile(day), 'utf8').split('\n').filter(Boolean)
      if (lines.length > 8000) {
        fs.writeFileSync(this.logFile(day), [...lines.slice(0, 1500), ...lines.slice(-6500)].join('\n') + '\n', 'utf8')
      }
    } catch {}
  }

  readLog(day) {
    try {
      return fs
        .readFileSync(this.logFile(day), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l) } catch { return null }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** 捕获去重：同一段对话反复读取/等待时不重复记账。 */
  seenKey(day, seed) {
    let set = this._seen.get(day)
    if (!set) {
      set = new Set()
      this._seen.set(day, set)
      const keys = [...this._seen.keys()]
      if (keys.length > 7) this._seen.delete(keys[0])
    }
    if (set.size > 8000) set.clear()
    if (set.has(seed)) return false
    set.add(seed)
    return true
  }

  /** 从当日日志算确定性统计：样本数、平均句长、表情频率、高频词。 */
  statsFor(day) {
    const lines = this.readLog(day)
    const msgs = []
    for (const l of lines) {
      if (l.kind === 'send') {
        for (const m of l.messages || []) if (typeof m === 'string' && m.trim()) msgs.push(m.trim())
      } else if (l.kind === 'log') {
        for (const m of l.outgoing || []) if (m && typeof m.text === 'string' && m.text.trim()) msgs.push(m.text.trim())
      }
    }
    let total = 0
    let emoji = 0
    const bigram = new Map()
    for (const m of msgs) {
      total += m.length
      emoji += (m.match(EMOJI_RE) || []).length
      const chars = m.match(/[\u4e00-\u9fff]/g) || []
      for (let i = 0; i < chars.length - 1; i++) {
        const g = chars[i] + chars[i + 1]
        bigram.set(g, (bigram.get(g) || 0) + 1)
      }
    }
    const n = msgs.length
    const topWords = [...bigram.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .filter(([, c]) => c >= 2)
      .map(([w, c]) => `${w}×${c}`)
    return {
      samples: n,
      sends: lines.filter((l) => l.kind === 'send').length,
      incoming: lines.filter((l) => l.kind === 'in').length,
      avgLength: n ? Math.round(total / n) : 0,
      emojiRatio: n ? Number((emoji / n).toFixed(2)) : 0,
      topWords,
    }
  }

  cleanupOldLogs(keepDays) {
    try {
      const files = fs.readdirSync(this.logsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      const cutoff = Date.now() - keepDays * 24 * 3600 * 1000
      for (const f of files) {
        const day = f.slice(0, 10)
        const t = new Date(day + 'T00:00:00')
        if (!Number.isNaN(t.getTime()) && t.getTime() < cutoff) {
          try { fs.unlinkSync(path.join(this.logsDir, f)) } catch {}
        }
      }
    } catch {}
  }

  // ── 感情模块 ──────────────────────────────────────────────────────────

  /** 情绪按半衰期向基线衰减（惰性计算，不落盘）。 */
  decayedEmotion(now = Date.now()) {
    const cur = this.emotion.current
    const base = this.emotion.baseline
    const hl = clamp(this.emotion.decay?.halfLifeHours, 0.5, 72, 8)
    const dt = Math.max(0, (now - (cur.since || now)) / 3600e3)
    const k = Math.pow(0.5, dt / hl)
    const floor = clamp(this.emotion.decay?.floor, 0, 0.5, 0.05)
    const mix = (a, b) => {
      const v = b + (a - b) * k
      return Math.abs(v - b) < floor ? b : v
    }
    return {
      mood: cur.mood,
      valence: Number(mix(cur.valence, base.valence).toFixed(3)),
      intensity: Number(mix(cur.intensity, base.intensity).toFixed(3)),
      since: cur.since,
      cause: cur.cause || '',
    }
  }

  // ── 蒸馏（训练）───────────────────────────────────────────────────────

  applyDistill(input, day, now = Date.now()) {
    const card = this.card
    const emotion = this.emotion
    const version = (card.training?.version ?? 0) + 1
    const s = {
      version,
      day,
      added: { habits: 0, catchphrases: 0, banned: 0, memories: 0, facts: 0, people: 0 },
      merged: { habits: 0, catchphrases: 0, memories: 0 },
      dropped: { habits: 0, memories: 0 },
      stats: this.statsFor(day),
      emotion: null,
      synced: [],
    }

    // 备份旧卡（可回滚）
    try {
      fs.mkdirSync(this.backupDir, { recursive: true })
      fs.writeFileSync(path.join(this.backupDir, `card-v${version - 1}.json`), JSON.stringify(card, null, 2), 'utf8')
      const backups = fs.readdirSync(this.backupDir).filter((f) => /^card-v\d+\.json$/.test(f))
      backups.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
      for (const old of backups.slice(30)) {
        try { fs.unlinkSync(path.join(this.backupDir, old)) } catch {}
      }
    } catch {}

    // ── 说话习惯 ──
    const speech = card.speech
    let habits = Array.isArray(speech.habits)
      ? speech.habits.filter((h) => h && typeof h.rule === 'string' && h.rule.trim()).slice(0, 60)
      : []
    for (const item of input.speechHabits || []) {
      const rule = str(item?.rule, 200)
      if (!rule) continue
      const weight = clamp(item?.weight, 1, 5, 3)
      const norm = rule.replace(/\s+/g, '')
      const found = habits.find((h) => h.rule.replace(/\s+/g, '') === norm)
      if (found) {
        found.weight = Math.max(found.weight, weight)
        found.at = now
        found.source = `distill#${version}`
        s.merged.habits++
      } else {
        habits.push({ rule, weight, at: now, source: `distill#${version}` })
        s.added.habits++
      }
    }
    habits.sort((a, b) => b.weight - a.weight || b.at - a.at)
    for (const r of input.dropHabits || []) {
      const before = habits.length
      habits = habits.filter((h) => h.rule !== r)
      s.dropped.habits += before - habits.length
    }
    speech.habits = habits.slice(0, 60)

    // ── 口头禅 ──
    let cps = Array.isArray(speech.catchphrases)
      ? speech.catchphrases.filter((c) => c && typeof c.phrase === 'string' && c.phrase.trim())
      : []
    for (const item of input.catchphrases || []) {
      const phrase = str(item?.phrase, 80)
      if (!phrase) continue
      const found = cps.find((c) => c.phrase === phrase)
      if (found) {
        found.at = now
        if (str(item?.context, 120)) found.context = str(item.context, 120)
        s.merged.catchphrases++
      } else {
        cps.push({ phrase, context: str(item?.context, 120), at: now })
        s.added.catchphrases++
      }
    }
    cps.sort((a, b) => b.at - a.at)
    speech.catchphrases = cps.slice(0, 40)

    // ── 语气 / 格式 ──
    if (typeof input.tone === 'string' && input.tone.trim()) speech.tone = str(input.tone, 200)
    if (isPlainObject(input.format)) {
      const fmt = speech.format
      for (const k of ['burst', 'avgLength', 'emoji', 'punctuation']) {
        const v = input.format[k]
        if (v === undefined) continue
        if (k === 'burst') fmt.burst = typeof v === 'boolean' ? v : null
        else if (k === 'avgLength') fmt.avgLength = clamp(v, 1, 200, null)
        else fmt[k] = str(v, 100)
      }
    }

    // ── 黑名单表达 ──
    const banned = Array.isArray(speech.banned) ? speech.banned.slice(0, 30) : []
    for (const item of input.banned || []) {
      const b = str(item, 200)
      if (b && !banned.includes(b)) {
        banned.push(b)
        s.added.banned++
      }
    }
    speech.banned = banned.slice(0, 30)

    // ── 关键记忆点 ──
    let mems = Array.isArray(card.memories?.keyPoints)
      ? card.memories.keyPoints.filter((m) => m && typeof m.point === 'string' && m.point.trim())
      : []
    for (const item of input.keyMemories || []) {
      const point = str(item?.point, 300)
      if (!point) continue
      const importance = clamp(item?.importance, 1, 5, 3)
      const found = mems.find((m) => m.point === point)
      if (found) {
        found.importance = Math.max(found.importance, importance)
        found.at = now
        s.merged.memories++
      } else {
        mems.push({ point, importance, at: now, source: `distill#${version}` })
        s.added.memories++
      }
    }
    mems.sort((a, b) => b.importance - a.importance || b.at - a.at)
    for (const r of input.dropMemories || []) {
      const before = mems.length
      mems = mems.filter((m) => m.point !== r)
      s.dropped.memories += before - mems.length
    }
    card.memories.keyPoints = mems.slice(0, 40)

    // ── 事实 ──
    const facts = Array.isArray(card.memories?.facts)
      ? card.memories.facts.filter((f) => f && typeof f.fact === 'string' && f.fact.trim())
      : []
    for (const item of input.facts || []) {
      const fact = str(item?.fact, 300)
      if (!fact) continue
      const found = facts.find((f) => f.fact === fact)
      if (!found) {
        facts.push({ fact, confidence: str(item?.confidence, 40) || 'medium', at: now })
        s.added.facts++
      }
    }
    facts.sort((a, b) => b.at - a.at)
    card.memories.facts = facts.slice(0, 30)

    // ── 按人印象 ──
    const people = isPlainObject(card.memories?.people) ? card.memories.people : {}
    if (isPlainObject(input.people)) {
      for (const [key, raw] of Object.entries(input.people).slice(0, 20)) {
        if (!isPlainObject(raw)) continue
        const k = str(key, 80)
        if (!k) continue
        const entry = (people[k] ??= { impression: '', facts: [], heat: 0.5 })
        const wasNew = !entry.impression && !(entry.facts || []).length
        if (typeof raw.impression === 'string' && raw.impression.trim()) entry.impression = str(raw.impression, 300)
        if (typeof raw.heat === 'number') entry.heat = clamp(raw.heat, 0, 1, entry.heat)
        if (Array.isArray(raw.facts)) {
          entry.facts = [...new Set([...(entry.facts || []), ...raw.facts.map((f) => str(f, 200)).filter(Boolean)])].slice(0, 20)
        }
        entry.lastSeen = now
        if (wasNew) s.added.people++
      }
      const keys = Object.keys(people)
      if (keys.length > 50) {
        keys.sort((a, b) => (people[b].lastSeen || 0) - (people[a].lastSeen || 0))
        for (const k of keys.slice(50)) delete people[k]
      }
    }

    // ── 感情模块：先衰减落盘，再应用更新 ──
    const decayed = this.decayedEmotion(now)
    emotion.current = { ...decayed, since: now }
    const emo = input.emotion
    if (isPlainObject(emo)) {
      if (typeof emo.mood === 'string' && emo.mood.trim()) emotion.current.mood = str(emo.mood, 40)
      if (typeof emo.valence === 'number') emotion.current.valence = clamp(emo.valence, -1, 1, 0)
      if (typeof emo.intensity === 'number') emotion.current.intensity = clamp(emo.intensity, 0, 1, 0.5)
      if (typeof emo.cause === 'string') emotion.current.cause = str(emo.cause, 120)
      const ev = str(emo.event, 200)
      if (ev) {
        emotion.events = [
          ...(Array.isArray(emotion.events) ? emotion.events : []),
          { t: now, mood: emotion.current.mood, valence: emotion.current.valence, intensity: emotion.current.intensity, text: ev },
        ].slice(-100)
      }
    }
    s.emotion = this.decayedEmotion(now)

    // ── 训练记录 ──
    const training = card.training
    training.version = version
    training.lastDistillAt = now
    training.log = [
      ...(Array.isArray(training.log) ? training.log : []),
      {
        v: version,
        at: now,
        day,
        summary: str(input.summary, 200) || null,
        stats: s.stats,
        added: s.added,
        merged: s.merged,
        dropped: s.dropped,
      },
    ].slice(-50)
    if (s.stats.samples) {
      const stats = speech.stats ??= { samples: 0, avgLength: 0, emojiRatio: 0, topWords: [] }
      stats.samples += s.stats.samples
      stats.avgLength = Math.round(((stats.avgLength || 0) * Math.max(0, stats.samples - s.stats.samples) + s.stats.avgLength * s.stats.samples) / stats.samples) || s.stats.avgLength
      stats.emojiRatio = s.stats.emojiRatio
      stats.topWords = s.stats.topWords
    }
    return s
  }
}

/** 深度合并默认结构（仅补缺失字段，不覆盖已有值）。 */
function deepMerge(base, extra) {
  if (!isPlainObject(base)) return isPlainObject(extra) ? extra : base
  const out = isPlainObject(extra) ? { ...base, ...extra } : { ...base }
  for (const [k, v] of Object.entries(out)) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v)
  }
  return out
}
