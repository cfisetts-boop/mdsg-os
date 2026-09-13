import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/resend-webhook?key=... — Resend event receiver (opened/delivered/bounced)
export async function POST(request) {
  try {
    const { searchParams } = new URL(request.url)
    if (process.env.RESEND_WEBHOOK_KEY && searchParams.get('key') !== process.env.RESEND_WEBHOOK_KEY)
      return Response.json({ error: 'unauthorized' }, { status: 401 })

    const payload = await request.json()
    const type = payload?.type || ''                       // e.g. email.opened
    const emailId = payload?.data?.email_id || payload?.data?.id || null
    const event = type.replace('email.', '')
    if (!emailId || !['opened', 'delivered', 'bounced', 'complained', 'clicked'].includes(event))
      return Response.json({ ok: true, ignored: type })

    // find the original 'sent' record for job + subject correlation
    const { data: orig } = await supabase.from('email_events')
      .select('job_id, subject, recipients').eq('email_id', emailId).eq('event', 'sent').limit(1).single()

    await supabase.from('email_events').insert({
      email_id: emailId, event,
      job_id: orig?.job_id || null, subject: orig?.subject || null, recipients: orig?.recipients || null,
    })
    if (orig?.job_id && ['opened', 'bounced'].includes(event)) {
      const icon = event === 'opened' ? '📬' : '⚠️'
      await supabase.from('activity_log').insert({
        job_id: orig.job_id, user_name: 'Resend',
        action: `${icon} Email ${event}${orig.recipients ? ' — ' + orig.recipients : ''}${orig.subject ? ' · "' + orig.subject + '"' : ''}`,
      })
    }
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
