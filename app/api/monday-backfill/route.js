import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BOARD_ID  = '18392215392'
const API_TOKEN = process.env.MONDAY_API_KEY

const GROUP_MAP = {
  'rfq':            'RFQ',
  'open proposals': 'Open Proposals',
  'on hold':        'On Hold',
  'awarded':        'Awarded',
  'shop drawings':  'Shop Drawings',
  'ordered':        'Ordered',
  'delivered':      'Delivered',
  'closeout':       'Closeout',
  'lost':           'Lost',
}

function resolveGroupStage(title) {
  const t = (title || '').toLowerCase().trim()
  if (GROUP_MAP[t]) return GROUP_MAP[t]
  // Fuzzy fallbacks for name variants
  if (/lost|no.?go/.test(t))        return 'Lost'
  if (/rfq|proposal.?\/|pricing/.test(t) && /rfq/.test(t)) return 'RFQ'
  if (/open.?proposal/.test(t))     return 'Open Proposals'
  if (/hold/.test(t))               return 'On Hold'
  if (/award/.test(t))              return 'Awarded'
  if (/shop|drawing/.test(t))       return 'Shop Drawings'
  if (/order/.test(t))              return 'Ordered'
  if (/deliver/.test(t))            return 'Delivered'
  if (/close/.test(t))              return 'Closeout'
  return null
}

const STATUS_MAP = {
  'working on':           'RFQ',
  'rebidding':            'RFQ',
  'rta pricing needed':   'RFQ',
  'sent out for pricing': 'RFQ',
  'proposal sent to gc':  'Open Proposals',
  'project on hold':      'On Hold',
  'rfq':                  'RFQ',
  'awarded':              'Awarded',
  'lost':                 'Lost',
}

const COLUMN_FIELD_MAP = {
  'text_mkyn4fgr':  'gc_name',
  'color_mkywb1z7': '__status',
  'text_mkyns5k1':  'scope_notes',
  'text_mkyny685':  'address',
  'date_mkynm6s6':  'bid_due_date',
  'text_mkyntx29':  'gc_contact',
  'text_mkynxhmm':  'gc_phone',
  'email_mkynvzvp': 'gc_email',
  'text_mkynge5g':  'manufacturer',
  'text_mkynyvvh':  'box_construction',
  'text_mkynnz07':  'door_style',
  'text_mkynvfz2':  '__cost',
  'text_mkynshx0':  '__bid_value',
  'text_mkynvsse':  '__gp',
  'text_mkynhpgb':  '__tops',
  'color_mkywg1wh': '__submittal_status',
  'text_mkyngg0v':  'order_date',
  'text_mkyn1ghz':  'delivery_date',
  'text_mkyndmak':  '__change_orders',
}

function mapItem(item) {
  const groupTitle = (item.group?.title || '').toLowerCase().trim()
  const stageFromGroup = resolveGroupStage(groupTitle)

  const job = {
    name:            item.name,
    monday_item_id:  String(item.id),
    monday_board_id: BOARD_ID,
    stage:           stageFromGroup || 'RFQ',
  }
  const hasGroupStage = !!stageFromGroup

  for (const col of (item.column_values || [])) {
    const field = COLUMN_FIELD_MAP[col.id]
    if (!field) continue
    const val = (col.text || '').trim()

    if (field === '__status') {
      if (!hasGroupStage) job.stage = STATUS_MAP[val.toLowerCase()] || 'RFQ'
    } else if (field === '__submittal_status') {
      if (val) job.submittal_status = val
    } else if (field === '__cost') {
      const n = parseFloat(val.replace(/[$,]/g, '')); if (n > 0) job.manufacturer_gross_cost = n
    } else if (field === '__bid_value') {
      const n = parseFloat(val.replace(/[$,]/g, '')); if (n > 0) job.bid_value = n
    } else if (field === '__gp') {
      const n = parseFloat(val.replace(/[%,]/g, '')); if (n > 0) job.gross_margin_pct = n
    } else if (field === '__tops') {
      if (val) job.tops_included = /yes|true|1|v/i.test(val)
    } else if (field === '__change_orders') {
      const n = parseInt(val); if (!isNaN(n)) job.change_order_count = n
    } else if (val) {
      job[field] = val
    }
  }
  return job
}

async function upsertJob(jobData) {
  const { data: rows } = await supabase
    .from('jobs').select('id')
    .eq('monday_item_id', jobData.monday_item_id)
    .order('created_at', { ascending: true }).limit(1)
  const existing = rows?.[0]

  if (existing) {
    const { error } = await supabase.from('jobs').update(jobData).eq('id', existing.id)
    if (error) throw new Error(error.message)
    return 'updated'
  } else {
    const { error } = await supabase.from('jobs')
      .insert({ ...jobData, owner: 'Cole', city: jobData.city || 'Denver', state: jobData.state || 'CO' })
    if (error) throw new Error(error.message)
    return 'created'
  }
}

export async function GET() {
  if (!API_TOKEN) return Response.json({ error: 'MONDAY_API_KEY not set' }, { status: 500 })

  const results = []
  let cursor = null
  let page = 0

  try {
    do {
      page++
      const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': API_TOKEN, 'API-Version': '2024-01' },
        body: JSON.stringify({
          query: `query { boards(ids: ${BOARD_ID}) { items_page(limit: 100${cursorArg}) { cursor items { id name group { title } column_values { id type text } } } } }`
        }),
      })
      const json = await res.json()
      if (json.errors) throw new Error(json.errors[0].message)

      const pageData = json.data?.boards?.[0]?.items_page
      const items = pageData?.items || []
      cursor = pageData?.cursor || null

      for (const item of items) {
        try {
          const jobData = mapItem(item)
          const action = await upsertJob(jobData)
          results.push({ name: item.name, stage: jobData.stage, action, success: true })
        } catch (err) {
          results.push({ name: item.name, error: err.message, success: false })
        }
      }
    } while (cursor && page < 10)

    const created = results.filter(r => r.action === 'created').length
    const updated = results.filter(r => r.action === 'updated').length
    const failed  = results.filter(r => !r.success).length

    const html = `<!DOCTYPE html><html><head><title>Monday Backfill</title>
      <style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:50px auto;padding:20px}
      h1{color:#3C3489}table{width:100%;border-collapse:collapse;font-size:13px}
      td,th{padding:6px 10px;border-bottom:1px solid #eee;text-align:left}
      .ok{color:#2D7A3A}.err{color:#A32D2D}
      .summary{background:#f5f5f3;border-radius:8px;padding:14px;margin:16px 0;font-size:14px}</style></head><body>
      <h1>Monday Backfill Complete</h1>
      <div class="summary"><strong>${results.length}</strong> items processed —
        <span class="ok">${created} created</span>, <span class="ok">${updated} updated</span>${failed ? `, <span class="err">${failed} failed</span>` : ''}</div>
      <table><tr><th>Item</th><th>Stage</th><th>Result</th></tr>
      ${results.map(r => `<tr><td>${r.name}</td><td>${r.stage || '—'}</td>
        <td class="${r.success ? 'ok' : 'err'}">${r.success ? r.action : r.error}</td></tr>`).join('')}
      </table></body></html>`

    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  } catch (err) {
    return Response.json({ error: err.message, processed: results.length }, { status: 500 })
  }
}
