import { createClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/parse-ct-quote — deterministic parser for West USA countertop
// quote workbooks (one sheet per material; unit-type sets with per-set pricing)
export async function POST(request) {
  try {
    const jobId = request.headers.get('x-job-id')
    const formData = await request.formData()
    const file = formData.get('file')
    if (!file) return Response.json({ error: 'No file' }, { status: 400 })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()))

    const val = (ws, r, c) => {
      const v = ws.getCell(r, c).value
      if (v == null) return ''
      if (typeof v === 'object') return v.result ?? v.text ?? ''
      return v
    }
    const num = (x) => { const n = parseFloat(String(x).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n }

    const materials = []
    wb.eachSheet(ws => {
      // find header row
      let hr = 0
      for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
        if (String(val(ws, r, 1)).trim().toUpperCase() === 'ITEM #') { hr = r; break }
      }
      if (!hr) return
      const items = []
      let sheetTotal = 0, sheetSqft = 0
      for (let r = hr + 1; r <= ws.rowCount; r++) {
        const c1 = String(val(ws, r, 1)).trim()
        const c13 = String(val(ws, r, 13)).trim().toUpperCase()
        if (c13 === 'TOTAL') { sheetTotal = num(val(ws, r, 14)); continue }
        if (c13.startsWith('TOTAL SQFT')) { sheetSqft = num(val(ws, r, 14)); continue }
        if (/^\d+$/.test(c1)) {
          const total = num(val(ws, r, 14))
          if (total > 0 || num(val(ws, r, 12)) > 0) {
            items.push({
              item: Number(c1),
              category: String(val(ws, r, 2)).trim(),
              material: String(val(ws, r, 3)).trim(),
              unit_type: String(val(ws, r, 4)).trim(),
              sets: num(val(ws, r, 12)),
              unit_price: Math.round(num(val(ws, r, 13)) * 100) / 100,
              total: Math.round(total * 100) / 100,
            })
          }
        }
      }
      if (items.length) {
        if (!sheetTotal) sheetTotal = items.reduce((s, i) => s + i.total, 0)
        materials.push({ material_code: ws.name, items, total: Math.round(sheetTotal * 100) / 100, sqft: sheetSqft })
      }
    })

    if (!materials.length) return Response.json({ error: 'No countertop pricing found — is this a West USA quote workbook?' }, { status: 422 })

    const grandTotal = Math.round(materials.reduce((s, m) => s + m.total, 0) * 100) / 100
    const totalSqft  = materials.reduce((s, m) => s + m.sqft, 0)
    const totalSets  = materials.reduce((s, m) => s + m.items.reduce((x, i) => x + i.sets, 0), 0)
    const unitTypes  = materials.flatMap(m => m.items.filter(i => i.unit_type).map(i => i.unit_type))

    let recorded = false
    if (jobId) {
      const { error } = await supabase.from('manufacturer_quotes').insert({
        job_id: jobId, manufacturer: 'West USA International', quote_type: 'countertops',
        gross_amount: grandTotal, grand_total: grandTotal,
        total_units: totalSets, raw_extracted_json: { materials, grandTotal, totalSqft },
        file_name: file.name || 'CT Quote', parsed_at: new Date().toISOString(),
      })
      recorded = !error
      if (error) console.error('CT quote insert FAILED:', error.message)
      await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'MDSG', action: `CT quote parsed — ${materials.length} material(s) · ${fmtM(grandTotal)} · ${totalSqft.toLocaleString()} sqft` })
    }

    return Response.json({
      success: true, recorded,
      summary: {
        materials: materials.map(m => ({ code: m.material_code, items: m.items.length, total: m.total, sqft: m.sqft })),
        grandTotal, totalSqft, totalSets, unitTypeCount: new Set(unitTypes).size,
      },
    })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

const fmtM = (n) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
