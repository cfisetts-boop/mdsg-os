import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/parse-rfq — read a BuildingConnected RFQ / bid invite PDF, create the job
export async function POST(request) {
  try {
    const owner = request.headers.get('x-user-name') || null
    const fileName = request.headers.get('x-file-name') || 'rfq.pdf'
    const buf = await request.arrayBuffer()
    if (!buf || buf.byteLength === 0) return Response.json({ error: 'No file data' }, { status: 400 })

    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buf).toString('base64') } },
          { type: 'text', text: `This is a construction bid invitation / RFQ (often from BuildingConnected). Extract as JSON only, no prose or fences:
{
  "name": "project name",
  "gc_name": "general contractor company",
  "gc_contact": "contact person name",
  "gc_email": "",
  "gc_phone": "",
  "address": "street address",
  "city": "", "state": "", "zip": "",
  "bid_due_date": "YYYY-MM-DD or empty",
  "notes": "scope highlights, trade/division info, walk-through dates, anything else useful (2-3 lines max)"
}
Empty string for anything absent. bid_due_date must be YYYY-MM-DD format.` },
        ],
      }],
    })
    const msg = await stream.finalMessage()
    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
    let q
    try { q = JSON.parse(raw.replace(/```json|```/g, '').trim()) }
    catch { return Response.json({ error: 'Could not read this PDF as an RFQ' }, { status: 422 }) }
    if (!q.name) return Response.json({ error: 'No project name found in the RFQ' }, { status: 422 })

    const { data: job, error } = await supabase.from('jobs').insert({
      name: q.name, stage: 'RFQ', owner,
      gc_name: q.gc_name || null, gc_contact: q.gc_contact || null,
      gc_email: q.gc_email || null, gc_phone: q.gc_phone || null,
      address: q.address || null, city: q.city || null, state: q.state || null, zip: q.zip || null,
      bid_due_date: q.bid_due_date || null,
      notes: q.notes || null,
    }).select().single()
    if (error) return Response.json({ error: error.message }, { status: 500 })

    await supabase.from('activity_log').insert({ job_id: job.id, user_name: owner || 'MDSG', action: `Job created from RFQ import (${fileName})` })
    return Response.json({ success: true, job })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
