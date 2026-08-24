import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// GET /api/leedo-catalog?line=framed&q=SB3 → up to 30 matching SKUs
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const line = searchParams.get('line') === 'frameless' ? 'frameless' : 'framed'
  const q = (searchParams.get('q') || '').trim().toUpperCase()
  if (q.length < 2) return Response.json({ items: [] })

  const { data, error } = await supabase
    .from('leedo_catalog')
    .select('sku, description')
    .eq('product_line', line)
    .ilike('sku', q + '%')
    .order('sku')
    .limit(30)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ items: data || [] })
}
