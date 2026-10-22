import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/assign-owner { jobId, owner, user } — reassign server-side so RLS
// row-visibility rules never block a handoff (e.g. taking a job off Vicki).
export async function POST(request) {
  try {
    const { jobId, owner = null, user = 'MDSG' } = await request.json()
    if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })
    const { error } = await supabase.from('jobs').update({ owner }).eq('id', jobId)
    if (error) return Response.json({ error: error.message }, { status: 500 })
    await supabase.from('activity_log').insert({
      job_id: jobId, user_name: user,
      action: owner ? `Owner changed to ${owner}` : 'Owner unassigned',
    })
    return Response.json({ success: true })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
