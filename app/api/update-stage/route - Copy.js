import { createClient } from '@supabase/supabase-js'

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const { jobId, stage, user } = await request.json()

    if (!jobId || !stage) {
      return Response.json({ error: 'Job ID and stage required' }, { status: 400 })
    }

    const validStages = ['Bid', 'Awarded', 'Shop Drawings', 'Ordered', 'Delivered', 'Installed', 'Lost']
    if (!validStages.includes(stage)) {
      return Response.json({ error: 'Invalid stage' }, { status: 400 })
    }

    const updateData = { stage }

    // Auto-set dates based on stage
    if (stage === 'Awarded') updateData.bid_submitted_date = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('jobs')
      .update(updateData)
      .eq('id', jobId)
      .select()
      .single()

    if (error) return Response.json({ error: error.message }, { status: 500 })

    await supabase.from('activity_log').insert({
      job_id: jobId,
      user_name: user || 'System',
      action: `Stage updated to "${stage}"`,
    })

    // Auto-create follow-up reminder when moving to Awarded
    if (stage === 'Awarded') {
      const followUp = new Date()
      followUp.setDate(followUp.getDate() + 7)
      await supabase.from('reminders').insert({
        job_id: jobId,
        due_date: followUp.toISOString().split('T')[0],
        reminder_type: 'General',
        message: 'Job awarded — submit shop drawings to manufacturer',
        assigned_to: user || 'Cole',
      })
    }

    return Response.json({ success: true, job: data })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
