import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  const { method } = req

  // ─── GET all jobs ──────────────────────────────────────────────────────
  if (method === 'GET') {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        *,
        unit_types ( id, unit_type_name, unit_quantity, cabinet_count, manufacturer_price ),
        reminders ( id, due_date, reminder_type, message, completed ),
        activity_log ( id, created_at, user_name, action )
      `)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  // ─── POST create new job ───────────────────────────────────────────────
  if (method === 'POST') {
    const {
      name, address, city, state, zip,
      gc_name, owner, stage,
      bid_due_date, manufacturer, notes,
    } = req.body

    if (!name) return res.status(400).json({ error: 'Job name is required' })

    const { data, error } = await supabase
      .from('jobs')
      .insert({
        name, address, city, state: state || 'CO', zip,
        gc_name, owner: owner || 'Cole',
        stage: stage || 'Bid',
        bid_due_date, manufacturer: manufacturer || 'TBD', notes,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // Log creation
    await supabase.from('activity_log').insert({
      job_id: data.id,
      user_name: owner || 'Cole',
      action: `Job created — ${name}`,
    })

    return res.status(201).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
