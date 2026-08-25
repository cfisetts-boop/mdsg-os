// One-time diagnostic: dumps every column on the board (id, title, type)
// plus sample values from a few filled-in items, so the field mapping can be
// locked to column TITLES instead of positional guesses.
const BOARD_ID = '18392215392'

export async function GET() {
  const token = process.env.MONDAY_API_KEY
  if (!token) return Response.json({ error: 'MONDAY_API_KEY not set' }, { status: 500 })

  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-01' },
    body: JSON.stringify({
      query: `query {
        boards(ids: ${BOARD_ID}) {
          columns { id title type }
          items_page(limit: 12) {
            items { id name group { title } column_values { id text } }
          }
        }
      }`
    }),
  })
  const json = await res.json()
  if (json.errors) return Response.json({ error: json.errors[0].message }, { status: 500 })

  const board = json.data?.boards?.[0]
  const cols  = board?.columns || []
  const items = board?.items_page?.items || []

  // Pick the item with the most filled columns as the sample
  let best = null, bestCount = -1
  for (const it of items) {
    const filled = (it.column_values || []).filter(c => (c.text || '').trim()).length
    if (filled > bestCount) { best = it; bestCount = filled }
  }
  const sampleVals = {}
  ;(best?.column_values || []).forEach(c => { sampleVals[c.id] = c.text || '' })

  const rows = cols.map(c => ({
    id: c.id, title: c.title, type: c.type,
    sample: sampleVals[c.id] || '',
  }))

  const html = `<!DOCTYPE html><html><head><title>Monday Columns</title>
    <style>body{font-family:-apple-system,sans-serif;max-width:900px;margin:40px auto;padding:16px}
    h1{color:#3C3489}table{width:100%;border-collapse:collapse;font-size:12px}
    td,th{padding:5px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
    th{background:#f5f5f3}code{background:#f5f5f3;padding:1px 5px;border-radius:4px;font-size:11px}
    .cp{background:#EEEDFE;border:1px solid #3C3489;border-radius:8px;padding:12px;margin:14px 0;font-size:12px}</style></head><body>
    <h1>Monday Board Columns</h1>
    <p>Sample item: <strong>${best?.name || '—'}</strong> (group: ${best?.group?.title || '—'})</p>
    <div class="cp"><strong>Copy this entire block and paste it into the chat:</strong><br/><br/>
    <pre style="white-space:pre-wrap;font-size:11px">${JSON.stringify({ sampleItem: best?.name, group: best?.group?.title, columns: rows }, null, 1)}</pre></div>
    <table><tr><th>Title</th><th>ID</th><th>Type</th><th>Sample Value</th></tr>
    ${rows.map(r => `<tr><td><strong>${r.title}</strong></td><td><code>${r.id}</code></td><td>${r.type}</td><td>${r.sample}</td></tr>`).join('')}
    </table></body></html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
