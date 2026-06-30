import { createClient } from '@supabase/supabase-js'

export async function GET(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const today = new Date().toISOString().split('T')[0]
    const nextWeek = new Date()
    nextWeek.setDate(nextWeek.getDate() + 7)

    const { data, error } = await supabase
      .from('reminders')
      .select('*, jobs(name, gc_name, stage)')
      .eq('completed', false)
      .lte('due_date', nextWeek.toISOString().split('T')[0])
      .order('due_date', { ascending: true })

    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json(data || [])
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const body = await request.json()
    const { action } = body

    if (action === 'complete') {
      const { data, error } = await supabase
        .from('reminders')
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq('id', body.id)
        .select()
        .single()
      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json({ success: true, reminder: data })
    }

    if (action === 'create') {
      const { data, error } = await supabase
        .from('reminders')
        .insert({
          job_id: body.job_id,
          due_date: body.due_date,
          reminder_type: body.reminder_type || 'General',
          message: body.message,
          assigned_to: body.assigned_to || 'Cole',
        })
        .select()
        .single()
      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json({ success: true, reminder: data })
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
