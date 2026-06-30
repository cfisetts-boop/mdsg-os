/**
 * POST /api/takeoff/matrix
 * Reads unit schedule pages from a PDF and returns unit types + counts + sheet refs
 * Fast — uses Haiku, no chunking needed (unit schedule is usually 1-4 pages)
 */

import Anthropic from '@anthropic-ai/sdk'
import { PDFDocument } from 'pdf-lib'

export const config = {
  api: {
    bodyParser: { sizeLimit: '50mb' },
    responseLimit: '50mb',
  },
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function safeParseJSON(raw) {
  try { return JSON.parse(raw) } catch (_) {}
  const s = raw.indexOf('['), e = raw.lastIndexOf(']')
  if (s !== -1 && e !== -1) {
    try { return JSON.parse(raw.substring(s, e + 1)) } catch (_) {}
  }
  const so = raw.indexOf('{'), eo = raw.lastIndexOf('}')
  if (so !== -1 && eo !== -1) {
    try {
      const parsed = JSON.parse(raw.substring(so, eo + 1))
      if (parsed.units) return parsed.units
    } catch (_) {}
  }
  return null
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files')

    if (!files || files.length === 0) {
      return Response.json({ error: 'No files uploaded' }, { status: 400 })
    }

    // Merge all uploaded PDFs into one
    let pdfBytes
    if (files.length === 1) {
      pdfBytes = Buffer.from(await files[0].arrayBuffer())
    } else {
      const merged = await PDFDocument.create()
      for (const f of files) {
        const buf = Buffer.from(await f.arrayBuffer())
        const src = await PDFDocument.load(buf, { ignoreEncryption: true })
        const indices = Array.from({ length: src.getPageCount() }, (_, i) => i)
        const pages = await merged.copyPages(src, indices)
        pages.forEach(p => merged.addPage(p))
      }
      pdfBytes = await merged.save()
    }

    const base64 = Buffer.from(pdfBytes).toString('base64')

    const prompt = `You are reading cabinet shop drawings or unit schedule pages. Extract ALL unit types and their quantities.

CYNCLY SHOP DRAWING FORMAT (most common):
Each page has a title block at the bottom. Look for patterns like:
  - "30 BLUFF-1BR1,3,4-45 UNITS" → unit type "1BR1, 3, 4", quantity 45
  - "PROJECT-UNITTYPE-COUNT UNITS" → parse unit type and count from this
  - A label on the drawing itself like "1BR1, 3, 4 (45)" → unit type with count in parentheses
  - "Drawing #: 1" or page numbers in the title block

Each unique shop drawing page represents one unit type. The unit type name and count appear in:
  1. The title block at the bottom: "PROJECT NAME - UNIT TYPE - COUNT UNITS"
  2. A label in the upper portion: "UNIT TYPE (COUNT)"
  3. Both locations — use whichever is clearest

ARCHITECTURAL UNIT SCHEDULE FORMAT:
Tables showing plan types with quantities per floor — sum across all floors.

EXTRACTION RULES:
- Extract EVERY distinct unit type found across ALL pages
- The number in parentheses OR after the dash before "UNITS" is the count
- Unit type names may include commas for multiple similar units: "1BR1, 3, 4" means unit types 1BR1, 1BR3, and 1BR4 share this layout, count = 45 total
- Sheet references look like "A410", "A411" — leave null if not shown

Return ONLY a JSON array, no markdown:
[
  { "name": "1BR1, 3, 4", "quantity": 45, "sheet": null },
  { "name": "2BR2", "quantity": 12, "sheet": null }
]`

    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })

    const raw = res.content[0].text
    const units = safeParseJSON(raw)

    if (!units || !Array.isArray(units)) {
      return Response.json({ error: 'Could not parse unit schedule — try cleaner pages', raw }, { status: 422 })
    }

    // Normalize and deduplicate — sum quantities for same plan type across floors
    const merged = {}
    units.forEach(u => {
      const key = (u.name || '').trim()
      if (!key) return
      if (!merged[key]) merged[key] = { name: key, quantity: 0, sheet: u.sheet || null }
      merged[key].quantity += Number(u.quantity) || 0
      if (!merged[key].sheet && u.sheet) merged[key].sheet = u.sheet
    })

    const result = Object.values(merged).sort((a, b) => a.name.localeCompare(b.name))
    const total = result.reduce((s, u) => s + u.quantity, 0)

    console.log(`Matrix extraction: ${result.length} unit types, ${total} total units`)

    return Response.json({ success: true, units: result, total })
  } catch (err) {
    console.error('Matrix extraction error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
