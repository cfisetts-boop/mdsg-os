import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { FILLER_RE, isApplianceSku } from '@/lib/skuRules'
import { getSection, calculateHardware } from '@/lib/hardwareUtils'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase  = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export const maxDuration = 120

// Map hardwareUtils sections onto cab-list categories
function sectionToCategory(section) {
  const s = (section || '').toLowerCase()
  if (s.startsWith('base'))    return 'BASES'
  if (s.startsWith('vanity'))  return 'VANITIES'
  if (s.startsWith('wall'))    return 'WALLS'
  if (s.startsWith('tall'))    return 'TALLS'
  if (s.includes('trim') || s.includes('molding')) return 'TRIM'
  return 'ACCESSORIES'
}

// Salvage a truncated JSON response by trimming to the last complete object
function safeParseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  for (let i = cleaned.length; i > 100; i--) {
    const candidate = cleaned.substring(0, i)
    const open  = (candidate.match(/[{[]/g) || []).length
    const close = (candidate.match(/[}\]]/g) || []).length
    if (open === close) { try { return JSON.parse(candidate) } catch {} }
  }
  return null
}

export async function POST(request) {
  try {
    const jobId = request.headers.get('x-job-id') || null
    const pdfBuffer = await request.arrayBuffer()
    if (!pdfBuffer || pdfBuffer.byteLength === 0) {
      return Response.json({ error: 'No file received' }, { status: 400 })
    }
    const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')

    // Compact extraction: ONLY what the cab list needs. Arrays, not objects,
    // keep the response small enough that 13+ unit types never truncate.
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 30000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This is a Leedo "Quote Summary" (Printable Summary) report.

EXTRACT TWO THINGS:

1. The "Unit Quantity Breakdown" table (usually page 2): every row's unit type name, unit qty, cabinet qty, total cubes, and gross price. Also the totals row and the Total Gross Amount, freight, and GRAND TOTAL beneath it.

2. The "Per Unit Breakdown" sections (remaining pages): for EVERY unit type section (e.g. 1DC, 1DC-A, 1DO, 1GC, ... SO), list every Order SKU row with its Qty. Use the EXACT SKU text including commas and suffixes (e.g. "HCB12R,AD21", "UFASIOHCSB36"). Do NOT skip any unit type. Do NOT include the per-section count/total row. If the same unit section continues onto a following page, merge its rows.

Respond with ONLY this JSON, no markdown, no commentary:
{
 "summary": {
   "units": [["1DC", 30, 450, 5447, 79188.90], ...],   // [name, unitQty, cabinetQty, cubes, grossPrice]
   "totalUnits": 340, "totalCabinets": 5202, "totalCubes": 66473,
   "grossAmount": 906719.23, "freight": 67099.80, "grandTotal": 1068471.51,
   "quoteNumber": "", "expires": "", "rep": ""
 },
 "unitDetails": [
   ["1DC", [["B18L",1],["B18R",1],["B24BD",1], ...]],   // [unitName, [[sku, qty], ...]]
   ...
 ]
}` },
        ],
      }],
    })

    const raw = extraction.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    const parsed = safeParseJSON(raw)
    if (!parsed || !parsed.unitDetails) {
      return Response.json({ error: 'Could not parse the Leedo summary structure' }, { status: 422 })
    }

    // Build the cab_list structure, classifying rows exactly like the Excel parser
    const summaryByName = {}
    ;(parsed.summary?.units || []).forEach(([name, uq, cq, cubes, gross]) => {
      summaryByName[String(name).trim().toUpperCase()] = { unitQty: uq, cabinetQty: cq, cubes, gross }
    })

    const unit_types = (parsed.unitDetails || []).map(([name, rows]) => {
      const meta = summaryByName[String(name).trim().toUpperCase()] || {}
      const skus = [], fillers = []
      ;(rows || []).forEach(([sku, qty]) => {
        const s = String(sku || '').trim()
        const q = Number(qty) || 0
        if (!s || q < 1) return
        if (isApplianceSku(s)) return
        if (FILLER_RE.test(s)) {
          fillers.push({ sku: s, description: s, quantity_per_unit: q, location: 'kitchen', category: 'ACCESSORIES' })
        } else {
          const section = getSection(s)
          const hw = calculateHardware(s)
          skus.push({
            sku: s, quantity_per_unit: q,
            category: sectionToCategory(section),
            hardware_count: hw.hardware ?? 0,
            location: 'kitchen', hinge_side: 'L/R', description: '', notes: '',
          })
        }
      })
      return {
        unit_type_name: String(name).trim(),
        unit_quantity: meta.unitQty || 1,
        is_ada: /-A$|\bADA\b|\bHC\b/i.test(String(name)),
        skus, fillers,
        manufacturer_price: meta.gross || 0,
        total_cubes: meta.cubes || 0,
        leedo_cabinet_qty: meta.cabinetQty || null,
        countertop_sf: 0, excelSubtotalSF: null, excelSubtotalHW: null,
      }
    })

    // Verification: our parsed counts vs Leedo's own summary table
    const parsedUnits = unit_types.reduce((s, u) => s + (u.unit_quantity || 1), 0)
    const parsedCabs  = unit_types.reduce((s, u) =>
      s + (u.skus.reduce((x, r) => x + r.quantity_per_unit, 0) + u.fillers.reduce((x, r) => x + r.quantity_per_unit, 0)) * (u.unit_quantity || 1), 0)

    const cabList = {
      project_name: parsed.summary?.quoteNumber || 'Leedo Import',
      source: 'leedo-printable-summary',
      unit_types,
      sheet_totals: {
        cabinets: parsed.summary?.totalCabinets ?? null,
        hardware: null, netSF: null, splashSF: null, totalSF: null,
      },
      leedo: {
        grossAmount: parsed.summary?.grossAmount ?? null,
        freight: parsed.summary?.freight ?? null,
        grandTotal: parsed.summary?.grandTotal ?? null,
        totalCubes: parsed.summary?.totalCubes ?? null,
        rep: parsed.summary?.rep || '',
        expires: parsed.summary?.expires || '',
      },
      verification: {
        leedoUnits: parsed.summary?.totalUnits ?? null,
        leedoCabinets: parsed.summary?.totalCabinets ?? null,
        parsedUnits, parsedCabs,
        unitsMatch: parsed.summary?.totalUnits === parsedUnits,
      },
    }

    // Optionally attach gross to the job for proposal pricing
    if (jobId && parsed.summary?.grossAmount > 0) {
      await supabase.from('jobs').update({ manufacturer_gross_cost: parsed.summary.grossAmount }).eq('id', jobId)
      await supabase.from('activity_log').insert({
        job_id: jobId, user_name: 'System',
        action: `Leedo summary imported — ${unit_types.length} unit types · ${parsedUnits} units · gross $${Math.round(parsed.summary.grossAmount).toLocaleString()}`,
      })
    }

    return Response.json({ success: true, cabList })
  } catch (err) {
    console.error('Leedo parse error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
