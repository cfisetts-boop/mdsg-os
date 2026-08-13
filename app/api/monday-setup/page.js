export async function GET(request) {
  const token   = process.env.MONDAY_API_KEY
  const boardId = '18392215392'
  const webhookUrl = 'https://mdsg-os.vercel.app/api/monday-webhook'

  if (!token) return Response.json({ error: 'MONDAY_API_KEY not set' }, { status: 500 })

  async function mq(query) {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-01' },
      body: JSON.stringify({ query }),
    })
    return res.json()
  }

  const results = []

  // 1. List and DELETE every existing webhook on the board (clears duplicates)
  const listRes = await mq(`query { webhooks(board_id: ${boardId}) { id event } }`)
  const existing = listRes.data?.webhooks || []
  for (const wh of existing) {
    const del = await mq(`mutation { delete_webhook(id: ${wh.id}) { id } }`)
    results.push({ step: `deleted old webhook ${wh.id} (${wh.event})`, success: !del.errors })
  }

  // 2. Register exactly ONE webhook per event
  for (const event of ['create_item', 'change_column_value', 'change_name', 'item_moved_to_any_group']) {
    const create = await mq(`mutation { create_webhook(board_id: ${boardId}, url: "${webhookUrl}", event: ${event}) { id } }`)
    if (create.errors) results.push({ step: `register ${event}`, success: false, error: create.errors[0].message })
    else results.push({ step: `register ${event}`, success: true, id: create.data?.create_webhook?.id })
  }

  const html = `<!DOCTYPE html><html><head><title>Monday Webhook Setup</title>
    <style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:20px}
    h1{color:#3C3489}.ok{background:#e8f5e9;border:1px solid #4caf50;border-radius:8px;padding:10px 14px;margin:8px 0}
    .err{background:#fdecea;border:1px solid #f44336;border-radius:8px;padding:10px 14px;margin:8px 0}</style></head><body>
    <h1>Monday Webhook Setup</h1>
    <p>Cleans duplicate webhooks, then registers exactly one per event.</p>
    ${results.map(r => `<div class="${r.success ? 'ok' : 'err'}">${r.success ? '✓' : '✗'} ${r.step}${r.id ? ' — ID ' + r.id : ''}${r.error ? ' — ' + r.error : ''}</div>`).join('')}
    <p><strong>Done.</strong> Each Monday event now fires exactly once.</p>
    </body></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
