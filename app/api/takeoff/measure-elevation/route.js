/**
 * POST /api/takeoff/measure-elevation
 * Accepts 1-4 images (JPEG/PNG) of elevation drawings.
 * Returns kitchen_lf, vanity_lf, sink_cutouts.
 * Simple, dedicated, no PDF pipeline complexity.
 */
export const maxDuration = 120

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Convert "2'-9"" → decimal feet
function toFt(str) {
  if (!str) return 0
  const s = str.toString().trim()
  // X'-Y" or X'-Y/Z"
  const m1 = s.match(/(\d+)['']\s*[-–]?\s*(\d+(?:[\/\-]\d+)?)\s*[""]/)
  if (m1) {
    const ft = parseInt(m1[1])
    const ins = m1[2].includes('/') ? eval(m1[2]) : parseInt(m1[2])
    return ft + ins / 12
  }
  // X' only
  const m2 = s.match(/^(\d+(?:\.\d+)?)['']\s*$/)
  if (m2) return parseFloat(m2[1])
  // pure decimal
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

// Extract all X'-Y" patterns from a string
function allDims(str) {
  const re = /(\d+)['']\s*[-–]?\s*(\d+(?:[\/\-]\d+)?)\s*[""]/g
  const results = []
  let m
  while ((m = re.exec(str)) !== null) {
    const ft = parseInt(m[1])
    const ins = m[2].includes('/') ? eval(m[2]) : parseInt(m[2])
    results.push(ft + ins / 12)
  }
  return results
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files')
    const typeName = formData.get('typeName') || 'Unit'

    if (!files.length) return Response.json({ error: 'No files uploaded' }, { status: 400 })

    // Build image content blocks
    const imageBlocks = await Promise.all(files.map(async f => {
      const buf = Buffer.from(await f.arrayBuffer())
      const mt  = (f.type || '').startsWith('image/') ? f.type : 'image/jpeg'
      return { type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } }
    }))

    const wallHint = formData.get('wallHint') || ''

    const KITCHEN_PROMPT = `This is a kitchen interior elevation drawing. Scale: 1/2" = 1'-0" unless noted.
Measure the KITCHEN COUNTERTOP linear footage.

Read the BOTTOM dimension string only (ignore any identical string at the top of the drawing).
Go left to right. For each segment apply these rules:

RULE 1 — FILLER STRIPS: Any segment labeled "3/4" FILLER", "FILLER", or any filler strip is a cabinet filler only — it is NOT countertop surface. EXCLUDE it completely from the LF measurement.

RULE 2 — APPLIANCE OPENINGS: Any segment labeled "RANGE", "RANGE FRONT CONTROLS", "OVEN", "COOKTOP", or "RBI" (refrigerator/appliance) must be completely excluded from the countertop LF. These are openings only — no countertop surface exists there.

RULE 3 — QT01 SPANS ONLY: Only include segments that sit directly below the QT01 countertop label or are clearly part of the countertop run. If QT01 does not span a section, do not count that section.
  ADD: base cabinet, sink base, dishwasher opening (counter runs over DW — include it)
  SKIP: range, oven, cooktop, refrigerator (RBI), any filler strip

RULE 4 — DOUBLE-CHECK: After summing, verify your total does not include any appliance openings or filler strips. If it does, subtract them.

If a range splits the counter: measure the left run + right run separately, add both runs together.
Unlabeled cabinet section: use cabinet code if visible (B18 = 18" = 1.50 ft) or estimate from scale. Mark ESTIMATED.

Show your work segment by segment, applying each rule, then:
SURFACE: KITCHEN
LF: [decimal feet]
SINKS: [count]
ESTIMATED: [yes/no]`

    const VANITY_PROMPT = `This is a bathroom/vanity interior elevation drawing. Scale: 1/2" = 1'-0" unless noted.

Answer these questions in order:

Q1: At the bottom of the drawing, do you see an overall span dimension with an extension line that covers the FULL width of the vanity cabinet section (not the toilet)? Write the value you see (e.g. "4'-8"") or "none".

Q2: What individual segment dimensions appear in the vanity section? List them.

Q3: Based on Q1 and Q2, what is the total vanity countertop LF?
- If Q1 found an overall span: use that value directly as the answer.
- If Q1 found none: sum the segments from Q2, including any 1" or 2" edge strips.

Then output:
SURFACE: VANITY
LF: [answer from Q3 in decimal feet]
SINKS: [number of sinks]
ESTIMATED: [yes/no]`

    // Pick focused prompt based on hint, or auto-detect with a quick Haiku call
    let prompt
    const hintIsKitchen = /kitchen|kit\b/i.test(wallHint)
    const hintIsVanity  = /vanity|bath|lav/i.test(wallHint)

    if (hintIsKitchen) {
      prompt = KITCHEN_PROMPT
    } else if (hintIsVanity) {
      prompt = VANITY_PROMPT
    } else {
      // Quick Haiku classification, then use the right prompt
      try {
        const cr = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{ role: 'user', content: [imageBlocks[0], { type: 'text', text: 'Is the drawing title KITCHEN or VANITY/BATH? Answer with one word only.' }] }],
        })
        prompt = /vanity|bath|lav/i.test(cr.content[0].text) ? VANITY_PROMPT : KITCHEN_PROMPT
      } catch { prompt = KITCHEN_PROMPT }
    }

    const res = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 600,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
    })

    const raw = res.content[0].text
    console.log(`measure-elevation for "${typeName}":\n${raw}`)

    // Extract the LF value Claude calculated
    const lfMatch    = raw.match(/\bLF\s*:\s*([\d.]+)/i)
    const sinksMatch = raw.match(/SINKS?\s*:\s*(\d+)/i)
    const estimated  = /ESTIMATED\s*:\s*yes/i.test(raw)
    const lf         = lfMatch ? parseFloat(lfMatch[1]) : null

    // THE FIX: when the user explicitly clicked a button (wallHint is set),
    // trust the button — ignore whatever Claude wrote for SURFACE.
    // Claude sometimes outputs the wrong surface label; the button press is authoritative.
    let kLF = null
    let vLF = null

    if (hintIsKitchen) {
      kLF = lf   // user pressed "+ Kitchen Wall" → LF always goes to kitchen
    } else if (hintIsVanity) {
      vLF = lf   // user pressed "+ Vanity" → LF always goes to vanity
    } else {
      // No hint (auto-detect path) — trust Claude's SURFACE label
      const surfaceMatch = raw.match(/SURFACE\s*:\s*(KITCHEN|VANITY|BATH|KIT)/i)
      const surfaceType  = surfaceMatch ? surfaceMatch[1].toUpperCase() : null
      if (/KITCHEN|KIT/.test(surfaceType || '')) kLF = lf
      else if (/VANITY|BATH|LAV/.test(surfaceType || '')) vLF = lf
      else if (lf != null) kLF = lf  // default to kitchen if unknown
    }

    const sinks = sinksMatch ? parseInt(sinksMatch[1]) : (vLF ? 1 : 0)

    if (!kLF && !vLF) {
      return Response.json({
        error: `Claude response:\n\n${raw}`,
      }, { status: 422 })
    }

    const klfSafe = (kLF && kLF > 0) ? kLF : 0
    const vlfSafe = (vLF && vLF > 0) ? vLF : 0

    const result = {
      unit_type:     typeName,
      kitchen_lf:    klfSafe > 0 ? +klfSafe.toFixed(4) : null,
      vanity_lf:     vlfSafe > 0 ? +vlfSafe.toFixed(4) : null,
      kitchen_sf:    klfSafe > 0 ? +(klfSafe * 2.125).toFixed(2) : null,
      vanity_sf:     vlfSafe > 0 ? +(vlfSafe * 1.875).toFixed(2) : null,
      backsplash_lf: +(klfSafe + vlfSafe).toFixed(4),
      sink_cutouts:  sinks,
      has_estimates: estimated,   // true if any section was estimated from scale/cabinet code
      raw_response:  raw,
    }

    console.log(`Result: kitchen=${result.kitchen_lf} ft, vanity=${result.vanity_lf} ft`)
    return Response.json({ success: true, ...result })

  } catch (err) {
    console.error('measure-elevation error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
