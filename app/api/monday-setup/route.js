import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BOARD_ID  = '18392215392'
const API_TOKEN = process.env.MONDAY_API_KEY
const SECRET    = process.env.MONDAY_WEBHOOK_SECRET

// ── Monday API helper ────────────────────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_TOKEN },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
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

// ── Map a Monday item to an OS job object ────────────────────────────────────
function mapItem(item) {
  const job = {
    name:             item.name,
    monday_item_id:   String(item.id),
    monday_board_id:  String(item.board?.id || BOARD_ID),
  }

  for (const col of (item.column_values || [])) {
    const val = col.text || ''
    const id  = col.id

    // Status → stage
    if (col.type === 'color' || col.type === 'status') {
      const key = (col.label || val || '').toLowerCase().trim()
      job.stage = STATUS_MAP[key] || 'Bid'
      continue
    }

    // Map by column ID patterns (Monday generates these — we match by position)
    // We discover real IDs on first run via logs, but common patterns:
    if (id.startsWith('name'))      { /* item.name already set */ continue }
    if (col.type === 'text' && !job.gc_name && val)          job.gc_name = val
    else if (col.type === 'text' && !job.address && val && /\d/.test(val)) job.address = val

    if (col.type === 'date' && !job.bid_due_date && val)     job.bid_due_date = val
    if (col.type === 'phone' && val)                         job.gc_phone = val
    if (col.type === 'email' && val)                         job.gc_email = val
    if (col.type === 'long-text' && val)                     job.scope_notes = val
    if (col.type === 'dropdown' && val)                      job.submittal_status = val
    if (col.type === 'checkbox')                             {
      if (!('tops_included' in job)) job.tops_included = col.checked === true
    }

    // Numbers: COST, TOTAL, GP%
    if (col.type === 'numbers') {
      const n = parseFloat(val) || 0
      if (n > 0) {
        if (!job.manufacturer_gross_cost)      job.manufacturer_gross_cost = n
        else if (!job.bid_value)               job.bid_value = n
        else if (!job.gross_margin_pct && n < 100) job.gross_margin_pct = n
      }
    }

    // Dates: ORDER DATE, Delivery
    if (col.type === 'date') {
      if (!job.order_date)        job.order_date = val || null
      else if (!job.delivery_date) job.delivery_date = val || null
    }
  }

  // Log column IDs for first-run calibration
  console.log('Monday columns:', JSON.stringify(item.column_values?.map(c => ({
    id: c.id, type: c.type, text: c.text?.substring(0,30)
  }))))

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
    return Response.json({ challenge: parsed.challenge })
  }

  const event    = parsed.event
  const itemId   = event?.pulseId || event?.itemId
  const boardId  = String(event?.boardId || '')

  if (!itemId) return Response.json({ ok: true })
  if (boardId && boardId !== BOARD_ID) return Response.json({ ok: true }) // wrong board

  try {
    const item = await fetchItem(itemId)
    if (!item) return Response.json({ ok: true })
    const jobData = mapItem(item)
    const result  = await upsertJob(jobData)
    console.log(`Monday sync: ${result.action} job ${result.id} for item ${itemId}`)
    return Response.json({ ok: true, ...result })
  } catch (err) {
    console.error('Monday webhook error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// Challenge also comes as GET on some Monday setups
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const challenge = searchParams.get('challenge')
  if (challenge) return Response.json({ challenge })
  return Response.json({ ok: true, message: 'Monday webhook endpoint active' })
}
