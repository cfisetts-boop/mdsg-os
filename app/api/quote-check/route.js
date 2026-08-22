import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const norm = (s) => String(s || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

// GET /api/quote-check?jobId=... → diff between the job's Cabinet List and
// the most recent uploaded manufacturer quote. Advisory only.
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })

  const { data: job } = await supabase.from('jobs').select('cab_list').eq('id', jobId).single()
  const { data: quotes } = await supabase.from('manufacturer_quotes')
    .select('raw_extracted_json, manufacturer, quote_number, created_at')
    .eq('job_id', jobId).order('created_at', { ascending: false }).limit(1)

  const cabList = job?.cab_list
  const quote   = quotes?.[0]
  if (!cabList?.unit_types?.length) return Response.json({ error: 'No cabinet list on this job' }, { status: 422 })
  if (!quote?.raw_extracted_json)   return Response.json({ error: 'No manufacturer quote uploaded for this job' }, { status: 422 })

  // Index the cabinet list: unit name → { qty, skus: {SKU → qty/unit} }
  const listUnits = {}
  cabList.unit_types.forEach(ut => {
    const skus = {}
    ;[...(ut.skus || []), ...(ut.fillers || [])].forEach(r => {
      const k = norm(r.sku); if (!k) return
      skus[k] = (skus[k] || 0) + (Number(r.quantity_per_unit) || 0)
    })
    listUnits[norm(ut.unit_type_name)] = { name: ut.unit_type_name, qty: ut.unit_quantity || 1, skus }
  })

  // Index the quote the same way (handles compact triplets and legacy objects)
  const q = quote.raw_extracted_json
  const quoteUnits = {}
  ;(q.unit_types || []).forEach(ut => {
    const skus = {}
    ;(ut.line_items || []).forEach(item => {
      const sku = Array.isArray(item) ? item[0] : item.sku
      const qty = Array.isArray(item) ? item[1] : item.quantity
      const k = norm(sku); if (!k) return
      skus[k] = (skus[k] || 0) + (Number(qty) || 0)
    })
    quoteUnits[norm(ut.unit_type_name)] = { name: ut.unit_type_name, qty: ut.unit_quantity || 1, skus }
  })

  const issues = []
  const allUnitKeys = new Set([...Object.keys(listUnits), ...Object.keys(quoteUnits)])

  for (const key of allUnitKeys) {
    const L = listUnits[key], Q = quoteUnits[key]
    if (L && !Q) { issues.push({ level: 'unit', unit: L.name, type: 'missing_in_quote', detail: `In cabinet list (${L.qty} units) but NOT in the quote` }); continue }
    if (!L && Q) { issues.push({ level: 'unit', unit: Q.name, type: 'missing_in_list', detail: `In quote (${Q.qty} units) but NOT in the cabinet list` }); continue }
    if (L.qty !== Q.qty) issues.push({ level: 'unit', unit: L.name, type: 'unit_qty', detail: `Unit qty differs — list: ${L.qty}, quote: ${Q.qty}` })

    const skuKeys = new Set([...Object.keys(L.skus), ...Object.keys(Q.skus)])
    for (const sk of skuKeys) {
      const lq = L.skus[sk] || 0, qq = Q.skus[sk] || 0
      if (lq > 0 && qq === 0)      issues.push({ level: 'sku', unit: L.name, sku: sk, type: 'sku_missing_in_quote', detail: `${sk} ×${lq} in list, missing from quote` })
      else if (lq === 0 && qq > 0) issues.push({ level: 'sku', unit: L.name, sku: sk, type: 'sku_missing_in_list', detail: `${sk} ×${qq} in quote, missing from list` })
      else if (lq !== qq)          issues.push({ level: 'sku', unit: L.name, sku: sk, type: 'sku_qty', detail: `${sk} qty differs — list: ${lq}, quote: ${qq}` })
    }
  }

  const unitIssues = issues.filter(i => i.level === 'unit').length
  const skuIssues  = issues.filter(i => i.level === 'sku').length

  return Response.json({
    ok: true,
    quoteInfo: { manufacturer: quote.manufacturer, quote_number: quote.quote_number, uploaded: quote.created_at },
    clean: issues.length === 0,
    summary: issues.length === 0
      ? 'Cabinet list and manufacturer quote match — no differences found.'
      : `${unitIssues} unit-level and ${skuIssues} SKU-level differences found.`,
    issues,
  })
}
