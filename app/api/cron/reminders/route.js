import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// GET /api/cron/reminders — daily digest per owner (Vercel Cron, 8am Denver)
export async function GET() {
  try {
    if (!process.env.RESEND_API_KEY) return Response.json({ skipped: 'no RESEND_API_KEY' })
    const today = new Date().toISOString().split('T')[0]
    const isFriday = new Date().getDay() === 5
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

    const { data: jobs } = await supabase.from('jobs').select('*')
    const { data: profiles } = await supabase.from('user_profiles').select('*')
    if (!jobs?.length || !profiles?.length) return Response.json({ sent: 0 })

    const byOwner = {}
    const add = (owner, section, line) => {
      if (!owner) return
      byOwner[owner] = byOwner[owner] || {}
      byOwner[owner][section] = byOwner[owner][section] || []
      byOwner[owner][section].push(line)
    }

    for (const j of jobs) {
      if (['Lost', 'Closeout'].includes(j.stage)) continue
      // Scheduled follow-ups due
      if (j.next_followup_date && j.next_followup_date <= today)
        add(j.owner, '⏰ Follow-ups due', `${j.name} — scheduled ${j.next_followup_date}${j.gc_name ? ' · ' + j.gc_name : ''}`)
      // Bid milestones (7/30/60d past bid due, not contacted since)
      if (j.bid_due_date && ['RFQ', 'Open Proposals', 'On Hold'].includes(j.stage)) {
        const days = Math.floor((Date.now() - new Date(j.bid_due_date)) / 86400000)
        const ms = [60, 30, 7].find(m => days >= m)
        if (ms && (!j.last_contacted_at || Math.floor((Date.now() - new Date(j.last_contacted_at)) / 86400000) >= 7))
          add(j.owner, '📞 Bid follow-ups', `${j.name} — ${days}d past bid date${j.gc_name ? ' · ' + j.gc_name : ''}`)
      }
      // Deliveries approaching → Willy call-ahead nudge
      if (j.est_delivery && j.est_delivery <= in14 && j.est_delivery >= today && ['Ordered', 'Shop Drawings', 'Awarded'].includes(j.stage))
        add(j.owner, '🚚 Deliveries within 14 days — confirm Willy call-ahead', `${j.name} — ETA ${j.est_delivery}`)
      // Friday weekly GC check for in-flight production
      if (isFriday && ['Shop Drawings', 'Ordered', 'Delivered'].includes(j.stage))
        add(j.owner, '📋 Weekly GC check (Fridays)', `${j.name} — ${j.stage}${j.gc_name ? ' · ' + j.gc_name : ''}`)
    }

    // ── External delivery notices: GC + Willy, weekly (Mon) + 2 days prior ──
    const isMonday = new Date().getDay() === 1
    const tMinus2 = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
    let deliveryNotices = 0
    for (const j of jobs) {
      if (!j.notify_delivery || !j.est_delivery) continue
      if (['Delivered', 'Closeout', 'Lost'].includes(j.stage)) continue
      if (j.last_delivery_notice === today) continue
      const twoDayHit = j.est_delivery === tMinus2
      if (!isMonday && !twoDayHit) continue
      const to = []
      if (j.gc_email) to.push(j.gc_email)
      to.push('greenworksrenovationsllc@gmail.com')
      const ownerProf = profiles.find(pr => pr.name === j.owner)
      const subject = twoDayHit
        ? `Delivery in 2 days — ${j.name} (${j.est_delivery})`
        : `Delivery schedule update — ${j.name}`
      const bodyLines = [
        `Project: ${j.name}`,
        j.address ? `Address: ${[j.address, j.city, j.state].filter(Boolean).join(', ')}` : null,
        j.ship_date ? `Ship date: ${j.ship_date}` : null,
        `Estimated delivery: ${j.est_delivery}`,
        '',
        twoDayHit
          ? 'Delivery is scheduled in 2 days. Willy — please confirm crew scheduling and site access. Call-ahead requested.'
          : 'Weekly delivery schedule confirmation. Reply to this email with any changes to site readiness or timing.',
        '',
        `MDSG Cabinets${ownerProf ? ' — ' + ownerProf.name + ' (' + ownerProf.email + ')' : ''}`,
      ].filter(l => l !== null)
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'MDSG Cabinets <csr@mdsgcabinets.com>',
          to,
          ...(ownerProf ? { cc: [ownerProf.email] } : {}),
          subject,
          text: bodyLines.join('\n'),
        }),
      })
      if (res.ok) {
        deliveryNotices++
        await supabase.from('jobs').update({ last_delivery_notice: today }).eq('id', j.id)
        await supabase.from('activity_log').insert({ job_id: j.id, user_name: 'MDSG OS', action: `Delivery notice emailed to ${to.join(', ')} (${twoDayHit ? '2-day' : 'weekly'})` })
      }
    }

    let sent = 0
    for (const prof of profiles) {
      const sections = byOwner[prof.name]
      if (!sections) continue
      const bodyText = Object.entries(sections)
        .map(([sec, lines]) => `${sec}\n${lines.map(l => '  • ' + l).join('\n')}`)
        .join('\n\n')
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'MDSG OS <csr@mdsgcabinets.com>',
          to: [prof.email],
          subject: `MDSG OS Daily — ${Object.values(sections).reduce((s, a) => s + a.length, 0)} items need attention`,
          text: `Good morning ${prof.name},\n\n${bodyText}\n\nOpen the OS: https://mdsg-os.vercel.app`,
        }),
      })
      if (res.ok) sent++
    }
    return Response.json({ sent, deliveryNotices, owners: Object.keys(byOwner) })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
