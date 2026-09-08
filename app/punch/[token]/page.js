'use client'
import { useState, useEffect, use } from 'react'

export default function PunchPage({ params }) {
  const { token } = use(params)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [by, setBy] = useState('')
  const [newItem, setNewItem] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`/api/punch?token=${token}`).then(r => r.json()).then(d => d.error ? setErr(d.error) : setData(d)).catch(() => setErr('Could not load'))
  }, [token])

  async function post(body) {
    setBusy(true)
    const r = await fetch('/api/punch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, by, ...body }) })
    const d = await r.json()
    if (!d.error) setData(prev => ({ ...prev, items: d.items }))
    setBusy(false)
  }

  if (err) return <div style={S.wrap}><div style={S.card}>⚠ {err}</div></div>
  if (!data) return <div style={S.wrap}><div style={S.card}>Loading…</div></div>
  const doneCount = data.items.filter(i => i[1]).length

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#709B77', letterSpacing: 1, textTransform: 'uppercase' }}>MDSG · Punch List</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{data.name}</div>
        {data.address && <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>{data.address}</div>}
        <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>{doneCount}/{data.items.length} complete</div>
        <input value={by} onChange={e => setBy(e.target.value)} placeholder="Your name (shows on check-offs)" style={S.input} />
      </div>

      {data.items.map((it, i) => (
        <div key={i} onClick={() => !busy && post({ action: 'toggle', index: i })} style={{ ...S.item, opacity: busy ? 0.6 : 1 }}>
          <div style={{ ...S.box, background: it[1] ? '#2D7A3A' : '#fff', borderColor: it[1] ? '#2D7A3A' : '#bbb' }}>{it[1] ? '✓' : ''}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, textDecoration: it[1] ? 'line-through' : 'none', color: it[1] ? '#999' : '#1a1a1a' }}>{it[0]}</div>
            {it[1] && <div style={{ fontSize: 11, color: '#aaa' }}>{it[3] ? it[3] + ' · ' : ''}{it[2]}</div>}
          </div>
        </div>
      ))}
      {data.items.length === 0 && <div style={{ ...S.card, color: '#999', fontSize: 14 }}>No punch items yet — add the first one below.</div>}

      <div style={S.card}>
        <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Add punch item…" style={S.input} />
        <button disabled={busy || !newItem.trim()} onClick={async () => { await post({ action: 'add', text: newItem }); setNewItem('') }} style={S.btn}>+ Add Item</button>
      </div>
      <div style={{ textAlign: 'center', fontSize: 11, color: '#bbb', padding: 16 }}>Manufacturer Direct Sales Group</div>
    </div>
  )
}

const S = {
  wrap: { minHeight: '100vh', background: '#f0efe9', padding: 12, fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '0 auto' },
  card: { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' },
  item: { background: '#fff', borderRadius: 12, padding: '14px 16px', marginBottom: 8, display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' },
  box: { width: 26, height: 26, borderRadius: 8, border: '2px solid #bbb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, flexShrink: 0 },
  input: { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, marginTop: 10, boxSizing: 'border-box' },
  btn: { width: '100%', padding: 12, marginTop: 8, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
}
