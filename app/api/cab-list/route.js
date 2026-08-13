import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// GET /api/cab-list?jobId=... → the job's editable cabinet list
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })

  const { data, error } = await supabase
    .from('jobs')
    .select('cab_list, cab_list_updated_at')
    .eq('id', jobId)
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ cabList: data?.cab_list || null, updatedAt: data?.cab_list_updated_at || null })
}

// PUT /api/cab-list  { jobId, cabList, source } → save the list
export async function PUT(request) {
  try {
    const { jobId, cabList, source = 'editor' } = await request.json()
    if (!jobId || !cabList) return Response.json({ error: 'jobId and cabList required' }, { status: 400 })

    const { error } = await supabase.from('jobs').update({
      cab_list: cabList,
      cab_list_updated_at: new Date().toISOString(),
    }).eq('id', jobId)
    if (error) throw new Error(error.message)

    const unitCount = (cabList.unit_types || []).reduce((s, u) => s + (u.unit_quantity || 1), 0)
    await supabase.from('activity_log').insert({
      job_id: jobId, user_name: 'Cole',
      action: `Cab list saved (${source}) — ${cabList.unit_types?.length || 0} unit types · ${unitCount} units`,
    })
    return Response.json({ success: true })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
