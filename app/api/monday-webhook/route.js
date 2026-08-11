import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BOARD_ID  = '18392215392'
const API_TOKEN = process.env.MONDAY_API_KEY
const SECRET    = process.env.MONDAY_WEBHOOK_SECRET

// Log env var presence at module load (not values — just whether they exist)
console.log('Monday webhook init — API_TOKEN present:', !!API_TOKEN, '| length:', API_TOKEN?.length || 0)

// ── Monday API helper ────────────────────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  console.log('Monday API call — token length:', API_TOKEN?.length, 'starts with:', API_TOKEN?.substring(0,8))
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': API_TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  })
  console.log('Monday API response status:', res.status)
  const text = await res.text()
  console.log('Monday API response:', text.substring(0, 300))
  const json = JSON.parse(text)
  if (json.errors) throw new Error(json.errors[0].message)
  return json.data
}

// ── Column ID → OS field mapping ─────────────────────────────────────────────
// Run once against your board to discover column IDs, then hardcode below.
// Column titles from the screenshot mapped to their typical Monday IDs.
const COL_MAP = {
  // These are discovered at runtime via the item fetch — see mapItem()
  status:          'stage',
  text:            'gc_name',         // General Contractor column
  text4:           'address',         // Address
  date:            'bid_due_date',    // Due
  text1:           'manufacturer',    // Manufacturer
  text2:           'box_construction',// Construction
  text3:           'door_style',      // Door Style
  long_text:       'scope_notes',     // Notes
  text5:           'gc_contact',      // GC Contact
  phone:           'gc_phone',        // Telephone
  email:           'gc_email',        // Email
  numbers:         'manufacturer_gross_cost', // COST
  numbers1:        'bid_value',       // TOTAL
  numbers2:        'gross_margin_pct',// GP%
  checkbox:        'tops_included',   // TOPS?
  date1:           'order_date',      // ORDER DATE
  date2:           'delivery_date',   // Delivery Dates
  numbers3:        'change_order_count', // Change Orders
  dropdown:        'submittal_status',// Submittal Status
}

const STATUS_MAP = {
  'working on':           'Active',
  'rebidding':            'Rebid',
  'rta pricing needed':   'Pricing',
  'sent out for pricing': 'Pricing',
  'proposal sent to gc':  'Proposal Sent',
  'project on hold':      'On Hold',
  'rfq':                  'Bid',
}

// ── Fetch full item from Monday API ─────────────────────────────────────────
async function fetchItem(itemId) {
  const data = await mondayQuery(`
    query($ids: [ID!]!) {
      items(ids: $ids) {
        id name board { id }
        column_values {
          id type text
          ... on StatusValue { label }
          ... on NumbersValue { number }
          ... on DateValue { date }
          ... on CheckboxValue { checked }
          ... on DropdownValue { text }
          ... on TextValue { text }
          ... on LongTextValue { text }
          ... on PhoneValue { phone }
          ... on EmailValue { email }
        }
      }
    }
  `, { ids: [String(itemId)] })
  return data?.items?.[0]
}

// ── Exact column ID → OS field mapping (from your board's real IDs) ─────────
const COLUMN_FIELD_MAP = {
  'text_mkyn4fgr':  'gc_name',
  'color_mkywb1z7': '__status',               // special: needs STATUS_MAP
  'text_mkyns5k1':  'scope_notes',
  'text_mkyny685':  'address',
  'date_mkynm6s6':  'bid_due_date',
  'text_mkyntx29':  'gc_contact',
  'text_mkynxhmm':  'gc_phone',
  'email_mkynvzvp': 'gc_email',
  'text_mkynge5g':  'manufacturer',
  'text_mkynyvvh':  'box_construction',
  'text_mkynnz07':  'door_style',
  'text_mkynvfz2':  '__cost',                 // special: parse as number
  'text_mkynshx0':  '__bid_value',            // special: parse as number
  'text_mkynvsse':  '__gp',                   // special: parse as number
  'text_mkynhpgb':  '__tops',                 // special: "yes"/"no"/checkbox
  'color_mkywg1wh': '__submittal_status',     // special: second status col
  'text_mkyngg0v':  'order_date',
  'text_mkyn1ghz':  'delivery_date',
  'text_mkyndmak':  '__change_orders',        // special: parse as int
}

// ── Map a Monday item to an OS job object ────────────────────────────────────
function mapItem(item) {
  const job = {
    name:            item.name,
    monday_item_id:  String(item.id),
    monday_board_id: String(item.board?.id || BOARD_ID),
    stage:           'Bid',  // default
  }

  for (const col of (item.column_values || [])) {
    const field = COLUMN_FIELD_MAP[col.id]
    if (!field) continue

    const val = (col.text || '').trim()
    const label = (col.label || val || '').toLowerCase().trim()

    if (field === '__status') {
      job.stage = STATUS_MAP[label] || 'Bid'
    } else if (field === '__submittal_status') {
      job.submittal_status = col.label || val || null
    } else if (field === '__cost') {
      const n = parseFloat(val.replace(/[$,]/g, ''))
      if (n > 0) job.manufacturer_gross_cost = n
    } else if (field === '__bid_value') {
      const n = parseFloat(val.replace(/[$,]/g, ''))
      if (n > 0) job.bid_value = n
    } else if (field === '__gp') {
      const n = parseFloat(val.replace(/[%,]/g, ''))
      if (n > 0) job.gross_margin_pct = n
    } else if (field === '__tops') {
      job.tops_included = /yes|true|1/i.test(val)
    } else if (field === '__change_orders') {
      const n = parseInt(val)
      if (!isNaN(n)) job.change_order_count = n
    } else if (val) {
      job[field] = val
    }
  }

  return job
}

// ── Upsert job into Supabase ─────────────────────────────────────────────────
async function upsertJob(jobData) {
  const { data: existing } = await supabase
    .from('jobs').select('id').eq('monday_item_id', jobData.monday_item_id).maybeSingle()

  if (existing) {
    // Update existing
    const { error } = await supabase.from('jobs').update(jobData).eq('id', existing.id)
    if (error) throw error
    await supabase.from('activity_log').insert({
      job_id: existing.id, user_name: 'Monday',
      action: `Synced from Monday — stage: ${jobData.stage || '?'}`,
    })
    return { action: 'updated', id: existing.id }
  } else {
    // Create new
    const { data, error } = await supabase.from('jobs')
      .insert({ ...jobData, owner: 'Cole', city: 'Denver', state: 'CO' })
      .select('id').single()
    if (error) throw error
    await supabase.from('activity_log').insert({
      job_id: data.id, user_name: 'Monday',
      action: `Job created from Monday — ${jobData.name}`,
    })
    return { action: 'created', id: data.id }
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function POST(request) {
  const body = await request.text()

  // Monday challenge handshake (required on webhook setup)
  let parsed
  try { parsed = JSON.parse(body) } catch { return Response.json({ error: 'bad json' }, { status: 400 }) }

  if (parsed.challenge) {
    return new Response(JSON.stringify({ challenge: parsed.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const event    = parsed.event
  const itemId   = event?.pulseId || event?.itemId
  const boardId  = String(event?.boardId || '')

  // Always return 200 to Monday — non-200 marks automation as failed
  // Log everything so we can debug from Vercel logs
  console.log('Monday event received:', JSON.stringify({ event: parsed.event?.type, itemId, boardId, keys: Object.keys(parsed) }))

  if (!itemId) {
    console.log('No itemId in event — skipping')
    return Response.json({ ok: true })
  }
  if (boardId && boardId !== BOARD_ID) {
    console.log('Wrong board:', boardId, '— expected', BOARD_ID)
    return Response.json({ ok: true })
  }

  // Fire-and-forget so we always respond 200 immediately
  ;(async () => {
    try {
      console.log('Fetching Monday item:', itemId)
      const item = await fetchItem(itemId)
      console.log('Item fetched:', item ? item.name : 'NOT FOUND')
      if (!item) { console.log('Item not found:', itemId); return }
      const jobData = mapItem(item)
      console.log('Job data mapped:', JSON.stringify(Object.keys(jobData)))
      const result  = await upsertJob(jobData)
      console.log('Monday sync SUCCESS:', result.action, 'job', result.id, 'item', itemId)
    } catch (err) {
      console.error('Monday sync FAILED:', err.message)
      console.error('Stack:', err.stack)
    }
  })()

  return Response.json({ ok: true })
}

// Monday verification: GET with challenge param must echo it back
// Without a challenge, return 200 so Monday knows endpoint is alive
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const challenge = searchParams.get('challenge')
  if (challenge) {
    return new Response(JSON.stringify({ challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}
