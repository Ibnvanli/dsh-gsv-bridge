// DSH ↔ GPT-SoVITS 桥 · 宿主半边  (v0.2.0)
//
// 2026-11-16 二次核对后的修正：
//  - 本机 9880 起的其实是 api_v2.py（路由 /tts、/set_refer_audio…），不是 api.py。
//    api_v2 没有 `/`，GET / 只回 404 JSON。上一版把「任何 application/json」
//    都当成 api.py 在线，于是会显示「已连接」但一合成就 404 —— 正是那些插件
//    失败的老毛病。这一版用 openapi.json 的路由表来判定方言，不再靠猜。
//  - 9872 / 9874 是 WebUI（text/html），明确排除。
//  - 两套方言都支持：api.py(POST /) 与 api_v2.py(POST|GET /tts)，自动识别。
//
// 接口（同源）：
//   GET  /dsh-gsv-bridge/status
//   GET  /dsh-gsv-bridge/probe
//   POST /dsh-gsv-bridge/say  {text, ...}
//   GET  /dsh-gsv-bridge/audio?file=xxx.wav
//   GET  /dsh-gsv-bridge/ping
//
// 只转发与落盘，不启动 GPT-SoVITS、不改系统、不注入界面。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

export const name = 'gsv-bridge'
export const inject = ['webServer', 'sessions']

const P = '/dsh-gsv-bridge'
const DEFAULT_PORTS = [9880, 9872, 9874]
const HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store',
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 0,
  extraPorts: [],
  dialect: 'auto',      // auto | api | api_v2
  referWavPath: '',
  promptText: '',
  promptLanguage: 'zh',
  textLanguage: 'zh',
  timeoutMs: 120000,
  outDir: '',
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }
  const log = (m) => {
    try { ctx.logger?.(name)?.info?.(m) } catch { /* noop */ }
    console.log('[gsv-bridge] ' + m)
  }
  const outDir = cfg.outDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'gsv-bridge-out')
  try { mkdirSync(outDir, { recursive: true }) } catch (e) { log('建输出目录失败：' + e.message) }

  let activePort = 0
  let activeDialect = ''   // 'api' | 'api_v2'
  let probeNote = '未探测'

  const reply = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { ...HEADERS, 'content-type': type })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }

  // ---- 判定方言：读 FastAPI 的 openapi.json，看有没有 /tts ----
  // api.py 只暴露 /、/set_model、/control、/change_refer；
  // api_v2.py 暴露 /tts、/set_refer_audio、/set_gpt_weights、/set_sovits_weights。
  // 读不到 openapi 时退回旧的「试一次真请求」逻辑，但绝不把 404 JSON 当成功。
  const detectDialect = async (port) => {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 4000)
      let r
      try { r = await fetch(`http://${cfg.host}:${port}/openapi.json`, { signal: ctl.signal }) }
      finally { clearTimeout(timer) }
      if (!r.ok) return null
      const j = await r.json()
      const paths = Object.keys(j.paths || {})
      if (paths.includes('/tts')) return 'api_v2'
      if (paths.includes('/') || paths.includes('/change_refer')) return 'api'
      return null
    } catch { return null }
  }

  // ---- 探针：只认「确实能出音频」或「业务语义明确的在线」 ----
  const probeOne = async (port) => {
    const dialect = await detectDialect(port)
    if (!dialect) {
      // 读不到 openapi：做一次真实请求兜底，但 404 / HTML 一律不算
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 4000)
      try {
        const url = `http://${cfg.host}:${port}/?text=%E6%A1%A5&text_language=zh`
        const r = await fetch(url, { signal: ctl.signal })
        const ct = (r.headers.get('content-type') || '').toLowerCase()
        const buf = Buffer.from(await r.arrayBuffer())
        if (ct.includes('audio/') || buf.slice(0, 4).toString('ascii') === 'RIFF') {
          return { ok: true, dialect: 'api', reason: '返回音频（api.py）' }
        }
        if (ct.includes('application/json')) {
          const s = buf.toString('utf8')
          // 只有 api.py 自己的业务错误才算在线；FastAPI 的 404 detail 不算
          if (/未指定参考音频|接口无预设|缺少任意一项|refer|prompt/i.test(s)) {
            return { ok: true, dialect: 'api', reason: 'api.py 在线：' + s.slice(0, 120) }
          }
          return { ok: false, reason: `不是 api.py 推理接口（HTTP ${r.status} JSON：${s.slice(0, 100)}）` }
        }
        if (ct.includes('text/html')) return { ok: false, reason: '这是 WebUI / 网页，不是推理接口' }
        return { ok: false, reason: '未知响应 ' + ct }
      } catch (e) {
        return { ok: false, reason: '连不上：' + (e.name === 'AbortError' ? '超时' : e.message) }
      } finally { clearTimeout(timer) }
    }
    return { ok: true, dialect, reason: dialect === 'api_v2' ? 'api_v2.py（/tts）' : 'api.py（/）' }
  }

  const probe = async () => {
    const ports = Number(cfg.port) > 0
      ? [Number(cfg.port)]
      : [...new Set([...DEFAULT_PORTS, ...(Array.isArray(cfg.extraPorts) ? cfg.extraPorts : [])])]
    const report = []
    activePort = 0
    activeDialect = ''
    for (const p of ports) {
      const r = await probeOne(p)
      report.push({ port: p, ...r })
      if (r.ok) { activePort = p; activeDialect = r.dialect; break }
    }
    if (cfg.dialect === 'api' || cfg.dialect === 'api_v2') activeDialect = cfg.dialect
    probeNote = activePort
      ? `已连接 ${cfg.host}:${activePort} · ${activeDialect}`
      : '没找到推理接口（' + report.map((x) => `${x.port}:${x.reason}`).join('；') + '）'
    log(probeNote)
    return { activePort, dialect: activeDialect, note: probeNote, report, configReady: !!cfg.referWavPath && !!cfg.promptText }
  }

  // ---- 合成：按方言构造请求 ----
  const synth = async (body) => {
    if (!activePort) await probe()
    if (!activePort) throw new Error(probeNote + '。请先启动 api.py 或 api_v2.py，或改 port 配置。')

    const text = String(body.text || '').trim()
    if (!text) throw new Error('text 不能为空')

    const refer = body.referWavPath || body.refAudioPath || cfg.referWavPath
    const promptText = body.promptText || cfg.promptText
    const promptLanguage = body.promptLanguage || body.promptLang || cfg.promptLanguage
    const textLanguage = body.textLanguage || body.textLang || cfg.textLanguage
    if (!refer || !promptText) {
      throw new Error('缺参考音频：在 cordis.patch.yml 配 referWavPath/promptText，或请求里带 referWavPath/refAudioPath/promptText')
    }

    const useV2 = activeDialect === 'api_v2'
    const url = `http://${cfg.host}:${activePort}${useV2 ? '/tts' : '/'}`
    const payload = useV2
      ? {
          text,
          text_lang: textLanguage,
          ref_audio_path: refer,
          prompt_text: promptText,
          prompt_lang: promptLanguage,
          media_type: 'wav',
          streaming_mode: false,
          text_split_method: 'cut5',
        }
      : {
          text,
          text_language: textLanguage,
          refer_wav_path: refer,
          prompt_text: promptText,
          prompt_language: promptLanguage,
        }

    const extra = useV2
      ? { top_k: 'top_k', top_p: 'top_p', temperature: 'temperature', speed: 'speed_factor', batch_size: 'batch_size' }
      : { top_k: 'top_k', top_p: 'top_p', temperature: 'temperature', speed: 'speed', cut_punc: 'cut_punc' }
    for (const [src, dst] of Object.entries(extra)) if (body[src] !== undefined) payload[dst] = body[src]

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), Number(cfg.timeoutMs) || 120000)
    let r
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      })
    } finally { clearTimeout(timer) }

    const ct = (r.headers.get('content-type') || '').toLowerCase()
    const buf = Buffer.from(await r.arrayBuffer())
    const isAudio = ct.includes('audio/') || buf.slice(0, 4).toString('ascii') === 'RIFF'
    if (!r.ok || ct.includes('application/json') || ct.includes('text/plain') || !isAudio) {
      throw new Error(`推理失败 HTTP ${r.status}（${ct}）：${buf.toString('utf8').slice(0, 300)}`)
    }

    const file = `${Date.now()}-${randomBytes(3).toString('hex')}.wav`
    writeFileSync(join(outDir, file), buf)
    return { file, bytes: buf.length, audioUrl: `${P}/audio?file=${encodeURIComponent(file)}`, port: activePort, dialect: activeDialect }
  }

  // ---- 路由 ----
  const route = (path, handler) => ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS); res.end(); return }
        try { await handler(req, res) }
        catch (e) { reply(res, 500, { ok: false, error: String(e && e.message) }) }
      },
    }))

  const readBody = (req) => new Promise((resolve) => {
    let s = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      s += c
      if (s.length > 1e6) { finish({}); req.destroy() }
    })
    req.on('end', () => { try { finish(s ? JSON.parse(s) : {}) } catch { finish({}) } })
    req.on('error', () => finish({}))
    req.on('aborted', () => finish({}))
  })

  route(P + '/ping', (_req, res) => reply(res, 200, { ok: true, name }))

  route(P + '/status', (_req, res) => reply(res, 200, {
    ok: true,
    activePort,
    dialect: activeDialect,
    note: probeNote,
    configReady: !!cfg.referWavPath && !!cfg.promptText,
    referWavPath: cfg.referWavPath || null,
    outDir,
    hint: activePort ? null : 'API 没起：cd ~/GPT-SoVITS && python api_v2.py -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml（或 python api.py -p 9880 ...）',
  }))

  route(P + '/probe', async (_req, res) => reply(res, 200, { ok: !!activePort, ...(await probe()) }))

  route(P + '/say', async (req, res) => {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })
    reply(res, 200, { ok: true, ...(await synth(await readBody(req))) })
  })

  // ---- 最近成功/失败记录（给 /logs 看） ----
  const LOG_MAX = 60
  const recent = []
  const pushLog = (entry) => {
    recent.unshift({ at: Date.now(), ...entry })
    if (recent.length > LOG_MAX) recent.length = LOG_MAX
  }
  const recordOk = (e) => pushLog({ ok: true, ...e })
  const recordFail = (err, ctx2) => pushLog({ ok: false, error: String(err).slice(0, 300), ...(ctx2 || {}) })

  // ---- 朗读按钮：按 messageId 取回复原文 → 合成 ----
  // 客户端 slot 只给 messageId / sessionId，不给文本，所以这里自己解。
  // 清洗：颜文字、emoji、括号里的非文字块念不出来，先剥掉再送 TTS。
  const cleanForSpeech = (t) => {
    let s = String(t == null ? '' : t)
    s = s.replace(/[（(][^（()）]{0,30}[)）]/g, (m) =>
      /[\u4e00-\u9fa5A-Za-z0-9]/.test(m.replace(/[（()）]/g, '')) ? m : ' ')
    s = s.replace(/`{1,3}[\s\S]*?`{1,3}/g, ' ')          // 代码块不念
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')       // markdown 链接留文字
    s = s.replace(/https?:\/\/\S+/g, ' ')                 // 裸链接不念
    s = s.replace(/\|/g, ' ')                             // 表格竖线
    s = s.replace(/[*_~#>]/g, '')
    s = s.replace(/[^\u4e00-\u9fa5A-Za-z0-9，。！？、；：,.!?;:\s]/g, ' ')
    s = s.replace(/\s{2,}/g, ' ').trim()
    return s.slice(0, 800)
  }

  const textOfMessage = (sessionId, messageId) => {
    if (!sessionId || !messageId) return ''
    let s
    try { s = ctx.sessions?.get?.(sessionId) } catch { return '' }
    if (!s) return ''
    try {
      if (typeof s.deriveMessages === 'function') {
        const list = s.deriveMessages() || []
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i]
          if (!m || String(m.id) !== String(messageId)) continue
          const parts = Array.isArray(m.content) ? m.content : []
          return parts.filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
            .map((p) => p.text || '').join('\n')
        }
      }
    } catch { /* 落到下面 */ }
    return ''
  }

  const locate = (sessionId, messageId) => {
    const tried = []
    const add = (id) => { const v = String(id || ''); if (v && !tried.includes(v)) tried.push(v) }
    add(sessionId)
    try { for (const s of ctx.sessions?.list?.() || []) add(s.id) } catch { /* ignore */ }
    for (const id of tried) {
      const raw = textOfMessage(id, messageId)
      if (raw) return { sessionId: id, raw }
    }
    return null
  }

  route(P + '/speak', async (req, res) => {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })
    const body = await readBody(req)
    let text = String(body.text || '').trim()
    let from = 'body'
    if (!text) {
      const hit = locate(String(body.sessionId || ''), String(body.messageId || ''))
      if (!hit) {
        recordFail('speak: 没找到这条回复的原文', body)
        return reply(res, 200, { ok: false, error: '没找到这条回复的原文' })
      }
      text = cleanForSpeech(hit.raw)
      from = 'message:' + hit.sessionId
    }
    if (!text) {
      recordFail('speak: 清洗后没有可念的文字', body)
      return reply(res, 200, { ok: false, error: '这条里没有可念的文字' })
    }
    try {
      const out = await synth({ ...body, text })
      recordOk({ text: text.slice(0, 60), from, file: out.file, sec: out.seconds ?? null })
      reply(res, 200, { ok: true, ...out, from })
    } catch (e) {
      recordFail(String(e?.message || e), { text: text.slice(0, 60), from })
      throw e
    }
  })

  route(P + '/logs', (req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const n = Math.min(Number(u.searchParams.get('n')) || 20, LOG_MAX)
    reply(res, 200, { ok: true, count: recent.length, items: recent.slice(0, n) })
  })

  route(P + '/audio', (req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const file = basename(String(u.searchParams.get('file') || ''))
    if (!/^[0-9a-z-]+\.wav$/i.test(file)) return reply(res, 400, { ok: false, error: 'bad filename' })
    const p = join(outDir, file)
    if (!existsSync(p)) return reply(res, 404, { ok: false, error: 'not found' })
    const buf = readFileSync(p)
    res.writeHead(200, { ...HEADERS, 'content-type': 'audio/wav', 'content-length': buf.length })
    res.end(buf)
  })

  void probe().catch((e) => log('启动探测失败：' + e.message))
  log(`接口已挂载 ${P}（端口 ${Number(cfg.port) || '自动'} · 方言 ${cfg.dialect}）`)
}
