export const maxDuration = 300

import Anthropic from '@anthropic-ai/sdk'
import { PDFDocument } from 'pdf-lib'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function safeParseJSON(raw) {
  if (!raw) return null
  const c = raw.trim().replace(/^```[a-z]*\n?/gm,'').replace(/^```\n?/gm,'').trim()
  try { return JSON.parse(c) } catch(_) {}
  const fo=c.indexOf('{'), lo=c.lastIndexOf('}')
  if (fo!==-1&&lo>fo) try { return JSON.parse(c.substring(fo,lo+1)) } catch(_) {}
  const fa=c.indexOf('['), la=c.lastIndexOf(']')
  if (fa!==-1&&la>fa) try { return JSON.parse(c.substring(fa,la+1)) } catch(_) {}
  return null
}

async function mergePDFs(buffers) {
  const merged = await PDFDocument.create()
  for (const buf of buffers) {
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true })
      const pgs = await merged.copyPages(src, src.getPageIndices())
      pgs.forEach(p => merged.addPage(p))
    } catch {}
  }
  return Buffer.from(await merged.save())
}

// Build a chunk PDF from specific page indices of a source doc
async function buildChunk(srcDoc, pageIndices) {
  const chunk = await PDFDocument.create()
  const valid = pageIndices.filter(i => i >= 0 && i < srcDoc.getPageCount())
  const pgs = await chunk.copyPages(srcDoc, valid)
  pgs.forEach(p => chunk.addPage(p))
  return Buffer.from(await chunk.save()).toString('base64')
}

function classifySku(sku) {
  const u = (sku || '').toUpperCase().trim()
  if (/^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|OVEN|HOOD|VENT)/.test(u)) return 'appliance'
  if (/^(EPT|EPB|PLYS|AD21)/.test(u))                                               return 'end_panel'
  if (/^(TKPW|TKC|TK8|TSK)/.test(u))                                               return 'toe_kick'
  if (/^SCM/.test(u))                                                                return 'scribe'
  if (/^(F[0-9]|F3[0-9]|TRP|BRP|OCM|WF|TF|BEP|BF)/.test(u))                      return 'filler'
  return 'cabinet'
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files')
    if (!files.length) return Response.json({ error: 'No files uploaded' }, { status: 400 })

    const buffers = await Promise.all(files.map(f => f.arrayBuffer().then(ab => Buffer.from(ab))))
    const mergedBuf = await mergePDFs(buffers)
    const srcDoc = await PDFDocument.load(mergedBuf, { ignoreEncryption: true })
    const totalPages = srcDoc.getPageCount()
    console.log(`Cabinet summary: ${totalPages} pages`)

    // ── Step 1: Get unit type summary from first 3 pages (Haiku, fast) ─────
    const summaryB64 = await buildChunk(srcDoc, [0,1,2])
    const summaryRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: summaryB64 }},
          { type: 'text', text: 'Find any table listing unit types and their counts (e.g. "1BR 1: 45 units"). Return ONLY a JSON array: [{"name":"1BR 1","quantity":45}]. If no such table exists return [].' },
        ],
      }],
    })
    const unitTypeSummary = safeParseJSON(summaryRes.content[0].text) || []
    const summaryCountMap = {}
    ;(Array.isArray(unitTypeSummary) ? unitTypeSummary : []).forEach(u => {
      if (u.name) summaryCountMap[u.name.trim().toUpperCase()] = u.quantity
    })
    console.log(`Summary unit types found: ${unitTypeSummary.length}`)

    // ── Step 2: Process overlapping 3-page chunks with Opus ─────────────────
    // Overlap ensures cross-page unit type sections are always captured whole
    const CHUNK_SIZE = 3
    const OVERLAP    = 1
    const CHUNK_PROMPT = `You are reading pages from a Leedo cabinet quote (PrintableSummary format).

The document lists cabinet SKUs organized by unit type (apartment type). Each unit type section has:
- A header showing the unit type name and how many apartments of that type exist
- A table of SKU codes with quantities per apartment

Your job: for EVERY unit type section visible on these pages, extract ALL SKUs.

IMPORTANT RULES:
1. qty = quantity per ONE apartment (per-unit), NOT total across all apartments
2. unit_qty = number of apartments of this type
3. If the same unit type continues across pages, collect all its SKUs
4. If this appears to be a continuation (no new header), carry forward the last visible unit type name

CLASSIFICATION — classify EVERY item:
- cabinet: W, B, SB, DB, BB, HC (all HC variants), EB, BLS, VSB, VDB, CVDB, CVSDB, P, LC, LT, PT, CW, WO, BMC
- filler: F330, F342, F396, F330.5, F330LPW, F342LPW, F396LPW, F330.5LPW, BRP, TRP, OCM, WF, TF, BEP, BF
- toe_kick: TKPW, TKC, TK8, TSK
- end_panel: EPT96, EPT90, EPT, EPB, EPB24, PLYS, AD21
- SKIP (do not include): RANGE, DISHW, DW, DISH, REF, MICRO, OTR

OUTPUT RULES — CRITICAL:
- Output ONLY a valid JSON array. No prose, no markdown, no explanation before or after.
- Start your response with [ and end with ]
- If pages are a cover/summary table with no SKU details, output exactly: []

Example output:
[{"unit_type":"1BR 1","unit_qty":45,"items":[{"sku":"W3030","qty":1,"type":"cabinet"},{"sku":"F330.5LPW","qty":2,"type":"filler"}]}]`

    const chunkResults = []
    const starts = []
    for (let i = 0; i < totalPages; i += CHUNK_SIZE - OVERLAP) {
      starts.push(i)
    }

    // Process in parallel batches of 4
    const BATCH = 4
    for (let b = 0; b < starts.length; b += BATCH) {
      const batch = starts.slice(b, b + BATCH)
      const batchRes = await Promise.all(batch.map(async start => {
        const indices = Array.from({ length: CHUNK_SIZE }, (_, k) => start + k).filter(i => i < totalPages)
        const b64 = await buildChunk(srcDoc, indices)
        try {
          const res = await anthropic.messages.create({
            model: 'claude-opus-4-7',
            max_tokens: 4000,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }},
                { type: 'text', text: CHUNK_PROMPT },
              ],
            }],
          })
          const raw = res.content[0].text
          const parsed = safeParseJSON(raw)
          const arr = Array.isArray(parsed) ? parsed : (parsed?.length ? [parsed] : [])
          console.log(`  Pages ${indices[0]+1}-${indices[indices.length-1]+1}: ${arr.length} unit types, ${arr.reduce((s,u)=>s+(u.items?.length||0),0)} items`)
          return arr
        } catch (err) {
          console.error(`  Pages ${indices[0]+1}-${indices[indices.length-1]+1} error:`, err.message)
          return []
        }
      }))
      batchRes.forEach(arr => chunkResults.push(...arr))
    }

    // ── Step 3: Merge all chunk results ─────────────────────────────────────
    const APPLIANCE_RE = /^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|OVEN|HOOD|VENT)/i
    const unitMap = {}

    chunkResults.forEach(ut => {
      if (!ut.unit_type || !ut.items?.length) return
      const key = ut.unit_type.trim()
      if (!unitMap[key]) unitMap[key] = { unit_type_name: key, unit_qty: 0, items: [] }
      if ((ut.unit_qty || 0) > unitMap[key].unit_qty) unitMap[key].unit_qty = ut.unit_qty || 0

      ;(ut.items || []).forEach(item => {
        const sku = (item.sku || '').trim()
        if (!sku || APPLIANCE_RE.test(sku)) return

        // Split comma-separated SKUs (e.g. "HCSDBC42FHR,AD21")
        const skuList = sku.includes(',') ? sku.split(',').map(s=>s.trim()).filter(Boolean) : [sku]
        skuList.forEach((s, idx) => {
          if (APPLIANCE_RE.test(s)) return
          const type = classifySku(s)
          if (type === 'appliance') return
          const ex = unitMap[key].items.find(e => e.sku.toUpperCase() === s.toUpperCase())
          if (ex) {
            ex.qty = Math.max(ex.qty, item.qty || 1)
          } else {
            unitMap[key].items.push({ sku: s, qty: item.qty || 1, type, description: item.description || '', hinge_side: item.hinge_side || '' })
          }
        })
      })
    })

    const allUnitTypes = Object.values(unitMap).filter(u => u.items.length > 0)
    if (!allUnitTypes.length) {
      return Response.json({ error: 'No cabinet items found. Make sure this is a Leedo PrintableSummary or cabinet quote PDF.' }, { status: 422 })
    }

    // ── Step 4: Apply authoritative unit counts from summary ─────────────────
    const flatItems = []
    const unitTypesOut = []

    allUnitTypes.forEach(ut => {
      const nameKey = ut.unit_type_name.toUpperCase()
      const authQty = summaryCountMap[nameKey] ?? ut.unit_qty ?? 1
      unitTypesOut.push({ name: ut.unit_type_name, quantity: authQty })

      ut.items.forEach(item => {
        flatItems.push({
          sku:        item.sku,
          description: item.description,
          qty:        item.qty,
          unit_qty:   authQty,
          type:       classifySku(item.sku),
          hinge_side: item.hinge_side,
          unit_type:  ut.unit_type_name,
        })
      })
    })

    const byType = (t) => flatItems.filter(i => i.type === t)
    const totalQty = (arr) => arr.reduce((s,i) => s + (i.qty||0) * (i.unit_qty||1), 0)

    const cabTotal  = totalQty(byType('cabinet'))
    const units     = unitTypesOut.reduce((s,u) => s+u.quantity, 0)
    console.log(`Result: ${unitTypesOut.length} unit types, ${units} units, ${cabTotal} cabinets`)

    return Response.json({
      success:    true,
      items:      flatItems,
      unit_types: unitTypesOut,
      project_name: null,
      manufacturer: 'Leedo',
      totals: {
        cabinets:   cabTotal,
        fillers:    totalQty(byType('filler')),
        toe_kicks:  totalQty(byType('toe_kick')),
        end_panels: totalQty(byType('end_panel')),
      },
    })
  } catch (err) {
    console.error('Cabinet summary extraction error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
