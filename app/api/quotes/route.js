import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// GET /api/quotes?jobId= → saved quote history for the job
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })
  const { data, error } = await supabase.from('manufacturer_quotes')
    .select('id, manufacturer, quote_type, quote_number, gross_amount, freight_amount, tax_amount, grand_total, total_units, total_cabinets, file_name, created_at')
    .eq('job_id', jobId).order('created_at', { ascending: false })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ quotes: data || [] })
}

// PATCH /api/quotes { id, jobId, gross_amount, grand_total } → edit amounts after upload
export async function PATCH(request) {
  const { id, jobId, gross_amount, freight_amount, tax_amount, grand_total } = await request.json()
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const upd = {}
  if (gross_amount !== undefined) upd.gross_amount = gross_amount
  if (freight_amount !== undefined) upd.freight_amount = freight_amount
  if (tax_amount !== undefined) upd.tax_amount = tax_amount
  if (grand_total !== undefined) upd.grand_total = grand_total
  const { error } = await supabase.from('manufacturer_quotes').update(upd).eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (jobId) await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'MDSG', action: `Saved quote amounts edited — gross $${Number(gross_amount||0).toLocaleString()}` })
  return Response.json({ success: true })
}

// DELETE /api/quotes { id, jobId } → remove one saved quote
export async function DELETE(request) {
  const { id, jobId } = await request.json()
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const { error } = await supabase.from('manufacturer_quotes').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (jobId) await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'MDSG', action: 'Saved quote deleted from history' })
  return Response.json({ success: true })
}
