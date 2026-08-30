import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/send-email — sends via Resend, logs recipients to the activity log
export async function POST(request) {
  try {
    const { jobId, fromEmail, fromName, to = [], cc = [], subject, body, attachmentName, attachmentB64, senderName } = await request.json()
    if (!process.env.RESEND_API_KEY) return Response.json({ error: 'RESEND_API_KEY not set in Vercel environment variables' }, { status: 500 })
    if (!to.length || !subject) return Response.json({ error: 'Recipient and subject required' }, { status: 400 })

    const payload = {
      from: `${fromName || 'MDSG Cabinets'} <${fromEmail || 'csr@mdsgcabinets.com'}>`,
      to, subject,
      text: body || '',
      ...(cc.length ? { cc } : {}),
      ...(attachmentB64 ? { attachments: [{ filename: attachmentName || 'attachment.xlsx', content: attachmentB64 }] } : {}),
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json()
    if (!res.ok) return Response.json({ error: json.message || 'Send failed' }, { status: 502 })

    if (jobId) {
      await supabase.from('activity_log').insert({
        job_id: jobId, user_name: senderName || 'MDSG',
        action: `✉ Emailed ${to.join(', ')}${cc.length ? ' (cc: ' + cc.join(', ') + ')' : ''} — "${subject}"${attachmentName ? ' + ' + attachmentName : ''}`,
      })
    }
    return Response.json({ success: true, id: json.id })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
