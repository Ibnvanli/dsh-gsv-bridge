// dsh-gsv-bridge · 客户端半边（每条助手回复下面的 🔊 朗读按钮）
// 走同源 fetch 问宿主：POST /dsh-gsv-bridge/speak { sessionId, messageId }
// 宿主取原文 → 合成 → 返回 audioUrl → 这里用 <audio> 播。
window.__ModuleLoader__.load({
  id: 'dsh-gsv-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const inject = ['slots']
    const B = '/dsh-gsv-bridge'

    const CSS =
      '.gsv-say{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;' +
      'background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;' +
      'padding:6px;display:inline-flex;transition:color .15s,background .15s}' +
      '.gsv-say:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);' +
      'color:var(--dsw-alias-label-secondary,#5f6875)}' +
      '.gsv-say:disabled{cursor:default;opacity:.45}' +
      '.gsv-say--busy{animation:gsvPulse 1.1s ease-in-out infinite}' +
      '@keyframes gsvPulse{0%,100%{opacity:.35}50%{opacity:1}}'

    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const speakerIcon = () =>
      React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round' },
        React.createElement('path', { d: 'M3.2 6.1h2.1l3.1-2.4v8.6L5.3 9.9H3.2z' }),
        React.createElement('path', { d: 'M10.6 5.9c.8.7 1.2 1.5 1.2 2.1s-.4 1.4-1.2 2.1' }),
        React.createElement('path', { d: 'M12.2 4.3c1.2 1.1 1.8 2.3 1.8 3.7s-.6 2.6-1.8 3.7' }),
      )

    const stopIcon = () =>
      React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'currentColor' },
        React.createElement('rect', { x: 5, y: 5, width: 6, height: 6, rx: 1 }),
      )

    // 单例播放器：同时只放一条，点哪条停哪条
    const player = { audio: null, id: '', subs: new Set() }
    const notify = () => player.subs.forEach((fn) => { try { fn() } catch (e) { /* noop */ } })

    const stopAll = () => {
      if (player.audio) {
        try { player.audio.pause() } catch (e) { /* noop */ }
        player.audio = null
      }
      player.id = ''
      notify()
    }

    const play = (url, id) => {
      stopAll()
      const a = new Audio(url)
      player.audio = a
      player.id = id
      a.onended = () => { player.audio = null; player.id = ''; notify() }
      a.onerror = () => { player.audio = null; player.id = ''; notify() }
      void a.play().catch(() => { player.audio = null; player.id = ''; notify() })
      notify()
    }

    function SayButton(props) {
      const messageId = String((props && props.messageId) || '')
      const sessionId = String((props && props.sessionId) || '')
      const [, force] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')

      React.useEffect(() => {
        const fn = () => force((n) => n + 1)
        player.subs.add(fn)
        return () => { player.subs.delete(fn) }
      }, [])

      if (!messageId) return null
      const playing = player.id === messageId

      const onClick = async () => {
        if (playing) { stopAll(); return }
        setErr('')
        setBusy(true)
        try {
          const r = await post('/speak', { sessionId, messageId })
          if (r && r.ok && r.audioUrl) play(B + '/audio?file=' + encodeURIComponent(r.file), messageId)
          else setErr((r && r.error) || '合成失败')
        } finally {
          setBusy(false)
        }
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'gsv-say' + (busy ? ' gsv-say--busy' : ''),
          title: err || (playing ? '停止' : '用祀栖的声音读这条（要等十几秒）'),
          'aria-label': playing ? '停止朗读' : '朗读这条回复',
          'aria-pressed': playing,
          disabled: busy,
          onClick,
        },
        playing ? stopIcon() : speakerIcon(),
      )
    }

    const apply = (ctx) => {
      try {
        if (typeof document !== 'undefined') {
          const id = 'gsv-say-style'
          if (!document.getElementById(id)) {
            const el = document.createElement('style')
            el.id = id
            el.textContent = CSS
            document.head.appendChild(el)
          }
        }
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('conversation.chat.assistant-actions', () =>
          slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'gsv-bridge', order: 31 },
            SayButton,
          ),
        )
      } catch (e) {
        console.warn('[gsv-bridge] client apply 失败：' + (e && e.message))
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
