import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/inbound-rfq?key=... — receives forwarded RFQ/ITB emails from a mail
// automation (Power Automate / Zapier). Creates a PENDING job shell for approval.
// Body JSON: { subject, from, body, attachment_b64?, attachment_name? }
export async function POST(request) {
  try {
    const { searchParams } = new URL(request.url)
    if (!process.env.INBOUND_RFQ_KEY || searchParams.get('key') !== process.env.INBOUND_RFQ_KEY)
      return Response.json({ error: 'unauthorized' }, { status: 401 })

    // Accept JSON or plain text (SUBJECT:/FROM:/BODY: delimited) — plain text
    // sidesteps all JSON-escaping problems with HTML email bodies.
    let subject = '', from = '', body = '', attachment_b64 = null
    const rawText = await request.text()
    try {
      const j = JSON.parse(rawText)
      subject = j.subject || ''; from = j.from || ''; body = j.body || ''; attachment_b64 = j.attachment_b64 || null
    } catch {
      const sm = rawText.match(/^SUBJECT:\s*(.*)$/m)
      const fm = rawText.match(/^FROM:\s*(.*)$/m)
      const bi = rawText.indexOf('BODY:')
      subject = sm ? sm[1].trim() : ''
      from = fm ? fm[1].trim() : ''
      body = bi > -1 ? rawText.substring(bi + 5).trim() : rawText
    }
    // strip HTML to text for the parser
    body = String(body).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (!subject && !body) return Response.json({ error: 'empty message' }, { status: 400 })

    const content = []
    if (attachment_b64) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: attachment_b64 } })
    content.push({ type: 'text', text: `This is a bid invitation / RFQ / ITB email received by a commercial cabinet supplier.
FROM: ${from}
SUBJECT: ${subject}
BODY:
${String(body).substring(0, 6000)}

Extract as JSON only, no prose or fences:
{
  "name": "project name",
  "gc_name": "general contractor company",
  "gc_contact": "person name", "gc_email": "", "gc_phone": "",
  "address": "", "city": "", "state": "", "zip": "",
  "bid_due_date": "YYYY-MM-DD or empty",
  "notes": "scope/trade highlights, walk-through dates (2-3 lines max)"
}
Use the sender for gc fields if not otherwise stated. Empty strings for unknowns.` })

    const stream = anthropic.messages.stream({ model: 'claude-opus-4-5', max_tokens: 1500, messages: [{ role: 'user', content }] })
    const msg = await stream.finalMessage()
    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
    let q
    try { q = JSON.parse(raw.replace(/```json|```/g, '').trim()) } catch { q = null }
    if (!q?.name) { q = { name: subject.substring(0, 80) || 'Inbound RFQ', gc_name: from, notes: 'Auto-parse failed — review email manually.' } }

    // Dedupe: same name pending already? skip
    const { data: dup } = await supabase.from('jobs').select('id').eq('name', q.name).eq('pending_review', true).limit(1)
    if (dup?.length) return Response.json({ ok: true, deduped: true })

    const { data: job, error } = await supabase.from('jobs').insert({
      name: q.name, stage: 'RFQ', pending_review: true,
      gc_name: q.gc_name || null, gc_contact: q.gc_contact || null,
      gc_email: q.gc_email || null, gc_phone: q.gc_phone || null,
      address: q.address || null, city: q.city || null, state: q.state || null, zip: q.zip || null,
      bid_due_date: q.bid_due_date || null, notes: q.notes || null,
    }).select().single()
    if (error) return Response.json({ error: error.message }, { status: 500 })
    await supabase.from('activity_log').insert({ job_id: job.id, user_name: 'Bids Inbox', action: `Inbound RFQ captured from ${from || 'email'} — awaiting review` })
    return Response.json({ ok: true, job_id: job.id })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
