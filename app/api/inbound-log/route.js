import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/inbound-log?key=... — receives forwarded/CC'd emails and logs them
// on the matching job (matched by job name appearing in the subject).
export async function POST(request) {
  try {
    const { searchParams } = new URL(request.url)
    if (!process.env.INBOUND_RFQ_KEY || searchParams.get('key') !== process.env.INBOUND_RFQ_KEY)
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    const raw = await request.text()
    let subject = '', from = ''
    try { const j = JSON.parse(raw); subject = j.subject || ''; from = j.from || '' }
    catch {
      const sm = raw.match(/^SUBJECT:\s*(.*)$/m); const fm = raw.match(/^FROM:\s*(.*)$/m)
      subject = sm ? sm[1].trim() : ''; from = fm ? fm[1].trim() : ''
    }
    if (!subject) return Response.json({ ok: true, matched: false })

    const { data: jobs } = await supabase.from('jobs').select('id, name')
    const subL = subject.toLowerCase()
    const match = (jobs || []).find(j => j.name && j.name.length > 4 && subL.includes(j.name.toLowerCase()))
    if (!match) return Response.json({ ok: true, matched: false })

    await supabase.from('activity_log').insert({
      job_id: match.id, user_name: 'Email',
      action: `✉ Logged email${from ? ' from ' + from : ''} — "${subject.substring(0, 120)}"`,
    })
    return Response.json({ ok: true, matched: true, job: match.name })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
