window.__ModuleLoader__.load({
  id: 'dsh-git-ai-attribution',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const ENDPOINT = '/git-ai-attribution.json'

    // Theme-agnostic styling: inherit the host text colour and vary only
    // weight/opacity, so light and dark themes both stay legible.
    const styles = {
      wrap: { padding: '20px 24px', fontSize: '13px', lineHeight: 1.6, color: 'inherit' },
      head: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      spacer: { flex: '1 1 auto' },
      control: {
        fontSize: '12px', padding: '4px 8px', borderRadius: '6px', color: 'inherit',
        background: 'transparent', border: '1px solid rgba(128,128,128,.5)', cursor: 'pointer',
      },
      sub: { opacity: 0.62, fontSize: '12px', marginTop: '4px' },
      cards: { display: 'flex', gap: '12px', flexWrap: 'wrap', margin: '16px 0 18px' },
      card: { border: '1px solid rgba(128,128,128,.35)', borderRadius: '10px', padding: '12px 16px', minWidth: '132px' },
      cardKey: { opacity: 0.62, fontSize: '12px' },
      cardValue: { fontSize: '22px', fontWeight: 600, marginTop: '2px' },
      table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' },
      th: { textAlign: 'left', fontWeight: 500, fontSize: '12px', opacity: 0.62, padding: '8px 10px', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(128,128,128,.35)' },
      td: { padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,.15)', verticalAlign: 'top' },
      num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      nowrap: { whiteSpace: 'nowrap' },
      mono: { fontFamily: 'Consolas,monospace' },
      muted: { opacity: 0.6 },
      ok: { color: '#1a7f37' },
      warn: { color: '#b45309' },
      error: { color: '#b42318', marginTop: '10px' },
      hint: { opacity: 0.55, fontSize: '12px', marginTop: '14px' },
    }

    /** Local calendar day as YYYY-MM-DD; toISOString would shift across midnight. */
    function isoDay(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return date.getFullYear() + '-' + month + '-' + day
    }

    /** Attribution state is read from Git notes; delivery is verified in the TRAE console. */
    function statusCell(commit) {
      if (commit.ai_lines > 0) return h('span', { style: styles.ok }, '已记录 ' + commit.ai_lines + ' 行')
      if (commit.has_note) return h('span', { style: styles.muted }, '已结算，无 AI 行')
      return h('span', { style: styles.muted }, '无归因')
    }

    function AttributionView() {
      const [repos, setRepos] = React.useState([])
      const [repo, setRepo] = React.useState('')
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [nonce, setNonce] = React.useState(0)
      const [range, setRange] = React.useState(() => {
        const today = isoDay(new Date())
        return { since: today, until: today }
      })

      React.useEffect(() => {
        let cancelled = false
        fetch(ENDPOINT + '?list=1', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            if (cancelled || !body) return
            setRepos(body.repos || [])
            setRepo((current) => current || body.current || '')
          })
          .catch(() => { /* The picker just stays empty; the data request still reports the real error. */ })
        return () => { cancelled = true }
      }, [])

      React.useEffect(() => {
        if (!repo) return undefined
        let cancelled = false
        setState((previous) => ({ status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }))
        const query = ['repo=' + encodeURIComponent(repo)]
        if (range.since) query.push('since=' + range.since)
        if (range.until) query.push('until=' + range.until)
        // Projects that own worktrees merge every local branch, so their
        // worktree commits appear under the project entry.
        const selected = repos.find((item) => item && item.path === repo)
        if (selected && selected.all) query.push('all=1')
        if (nonce > 0) query.push('refresh=1')
        fetch(ENDPOINT + '?' + query.join('&'), { cache: 'no-store' })
          .then(async (response) => {
            const body = await response.json().catch(() => null)
            if (cancelled) return
            if (!response.ok) {
              setState({ status: 'error', data: null, error: (body && body.error) || 'HTTP ' + response.status })
              return
            }
            setState({ status: 'ready', data: body, error: null })
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'error', data: null, error: String(error && error.message ? error.message : error) })
          })
        return () => { cancelled = true }
      }, [repo, range.since, range.until, nonce, repos])

      const normalize = (item) => (typeof item === 'string' ? { path: item, label: item.split('\\').pop() } : item)
      const options = (repos.length > 0 ? repos : (repo ? [repo] : [])).map(normalize)
      const picker = h('select', {
        style: styles.control,
        value: repo,
        onChange: (event) => setRepo(event.target.value),
        disabled: options.length === 0,
      }, options.map((item) => h('option', { key: item.path, value: item.path }, item.label)))

      const dateInput = (value, onChange) => h('input', {
        type: 'date',
        value,
        style: Object.assign({}, styles.control, { colorScheme: 'light dark' }),
        onChange: (event) => onChange(event.target.value),
      })

      const preset = (label, days) => h('button', {
        style: styles.control,
        onClick: () => {
          const end = new Date()
          const start = new Date()
          if (days > 0) start.setDate(start.getDate() - (days - 1))
          setRange(days > 0
            ? { since: isoDay(start), until: isoDay(end) }
            : { since: '', until: '' })
        },
      }, label)

      const head = h('div', { style: styles.head },
        h('div', { style: styles.title }, 'AI 贡献归因'),
        h('div', { style: styles.spacer }),
        preset('今天', 1),
        preset('近 7 天', 7),
        preset('全部', 0),
        dateInput(range.since, (value) => setRange((current) => ({ ...current, since: value }))),
        h('span', { style: styles.muted }, '至'),
        dateInput(range.until, (value) => setRange((current) => ({ ...current, until: value }))),
        picker,
        h('button', { style: styles.control, onClick: () => setNonce((value) => value + 1) }, '刷新')
      )

      if (state.status === 'loading') {
        return h('div', { style: styles.wrap }, head, h('div', { style: styles.sub }, '正在读取归因数据…'))
      }
      if (state.status === 'error') {
        return h('div', { style: styles.wrap }, head, h('div', { style: styles.sub }, '暂时拿不到数据。'), h('div', { style: styles.error }, state.error))
      }

      const data = state.data
      const commits = (data && data.commits) || []
      const totals = (data && data.totals) || { ai_lines: 0, added_lines: 0 }
      const rate = totals.added_lines > 0 ? Math.round((totals.ai_lines * 1000) / totals.added_lines) / 10 : 0
      const card = (label, value) => h('div', { style: styles.card },
        h('div', { style: styles.cardKey }, label),
        h('div', { style: styles.cardValue }, String(value))
      )

      const rows = commits.map((commit) => h('tr', { key: commit.sha },
        h('td', { style: Object.assign({}, styles.td, styles.mono, styles.nowrap) }, commit.short),
        h('td', { style: Object.assign({}, styles.td, styles.mono, styles.nowrap, styles.muted) }, commit.time),
        h('td', { style: styles.td }, commit.subject),
        h('td', { style: Object.assign({}, styles.td, styles.num) }, String(commit.ai_lines)),
        h('td', { style: Object.assign({}, styles.td, styles.num) }, String(commit.added_lines)),
        h('td', { style: Object.assign({}, styles.td, styles.num) }, commit.rate === null ? '—' : commit.rate + '%'),
        h('td', { style: Object.assign({}, styles.td, styles.mono, styles.nowrap) }, (commit.models || []).join('、') || '—'),
        h('td', { style: Object.assign({}, styles.td, styles.nowrap) }, statusCell(commit))
      ))

      return h('div', { style: styles.wrap },
        head,
        h('div', { style: styles.sub }, (data.repo || '') + '　·　最近 ' + commits.length + ' 次提交　·　' + (data.generated || '')),
        h('div', { style: styles.cards },
          card('AI 新增行', totals.ai_lines),
          card('总新增行', totals.added_lines),
          card('AI 贡献率', rate + '%'),
          card('提交数', commits.length)
        ),
        h('table', { style: styles.table },
          h('thead', null, h('tr', null,
            h('th', { style: styles.th }, '提交'),
            h('th', { style: styles.th }, '时间'),
            h('th', { style: styles.th }, '说明'),
            h('th', { style: Object.assign({}, styles.th, styles.num) }, 'AI 行'),
            h('th', { style: Object.assign({}, styles.th, styles.num) }, '总新增'),
            h('th', { style: Object.assign({}, styles.th, styles.num) }, '贡献率'),
            h('th', { style: styles.th }, '模型'),
            h('th', { style: styles.th }, '归因')
          )),
          h('tbody', null, rows)
        ),
        h('div', { style: styles.hint }, '数据来自本机 Git notes（refs/notes/ai-tob）；企业看板是否入账，请在 TRAE 控制台按提交时间核对。')
      )
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'git-ai-attribution',
        order: 90,
        label: 'AI 归因',
      }, AttributionView))
    }

    exports.name = 'git-ai-attribution-client'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
