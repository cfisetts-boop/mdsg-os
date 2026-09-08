import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Public punch-list API — auth is the unguessable share token itself.
// Exposes ONLY: job name, address, punch items. No financials, no contacts.

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  if (!token || token.length < 20) return Response.json({ error: 'Invalid link' }, { status: 400 })
  const { data: job } = await supabase.from('jobs')
    .select('name, address, city, state, punch_list')
    .eq('share_token', token).single()
  if (!job) return Response.json({ error: 'Link not found or revoked' }, { status: 404 })
  return Response.json({
    name: job.name,
    address: [job.address, job.city, job.state].filter(Boolean).join(', '),
    items: Array.isArray(job.punch_list) ? job.punch_list : [],
  })
}

export async function POST(request) {
  try {
    const { token, action, index, text, by } = await request.json()
    if (!token || token.length < 20) return Response.json({ error: 'Invalid link' }, { status: 400 })
    const { data: job } = await supabase.from('jobs')
      .select('id, name, punch_list').eq('share_token', token).single()
    if (!job) return Response.json({ error: 'Link not found' }, { status: 404 })
    let items = Array.isArray(job.punch_list) ? job.punch_list : []
    const stamp = new Date().toISOString().split('T')[0]
    const who = (by || '').trim().substring(0, 40)

    if (action === 'toggle' && items[index]) {
      const done = !items[index][1]
      items[index] = [items[index][0], done, done ? stamp : null, done ? who : '']
      await supabase.from('activity_log').insert({ job_id: job.id, user_name: who || 'Site', action: `Punch item ${done ? 'completed' : 'reopened'}: ${items[index][0]}` })
    } else if (action === 'add' && text && text.trim()) {
      items.push([text.trim().substring(0, 200), false, null, ''])
      await supabase.from('activity_log').insert({ job_id: job.id, user_name: who || 'Site', action: `Punch item added: ${text.trim().substring(0, 80)}` })
    } else {
      return Response.json({ error: 'Bad request' }, { status: 400 })
    }
    await supabase.from('jobs').update({ punch_list: items }).eq('id', job.id)
    return Response.json({ items })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
