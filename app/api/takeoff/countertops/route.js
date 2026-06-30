export const maxDuration = 300

import Anthropic from '@anthropic-ai/sdk'
import { PDFDocument } from 'pdf-lib'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Match unit type names: exact → normalized (no spaces/dashes) → 5+ char substring
// Avoids the "UNIT" false-match from substring(0,4) that assigned one count to every type
function namesMatch(a, b) {
  const au = (a || '').toUpperCase().trim()
  const bu = (b || '').toUpperCase().trim()
  if (!au || !bu) return false
  if (au === bu) return true
  const an = au.replace(/[\s\-_.]/g, '')
  const bn = bu.replace(/[\s\-_.]/g, '')
  if (an === bn) return true
  const shorter = an.length < bn.length ? an : bn
  if (shorter.length >= 5 && (an.includes(bn) || bn.includes(an))) return true
  return false
}

function safeParseJSON(raw) {
  if (!raw) return null
  const clean = raw.trim().replace(/^```[a-z]*\n?/gm,'').replace(/^```\n?/gm,'').trim()
  try { return JSON.parse(clean) } catch (_) {}
  const fo = clean.indexOf('{'), lo = clean.lastIndexOf('}')
  if (fo !== -1 && lo > fo) try { return JSON.parse(clean.substring(fo, lo + 1)) } catch (_) {}
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

async function splitToSinglePages(pdfBuf) {
  const src = await PDFDocument.load(pdfBuf, { ignoreEncryption: true })
  const pages = []
  for (let i = 0; i < src.getPageCount(); i++) {
    const single = await PDFDocument.create()
    const [pg] = await single.copyPages(src, [i])
    single.addPage(pg)
    pages.push({ idx: i + 1, b64: Buffer.from(await single.save()).toString('base64') })
  }
  return pages
}

async function buildChunk(srcDoc, indices) {
  const chunk = await PDFDocument.create()
  const valid = indices.filter(i => i >= 0 && i < srcDoc.getPageCount())
  const pgs = await chunk.copyPages(srcDoc, valid)
  pgs.forEach(p => chunk.addPage(p))
  return Buffer.from(await chunk.save()).toString('base64')
}

export async function POST(request) {
  try {
    const formData       = await request.formData()
    const files          = formData.getAll('files')
    const ctLabels       = formData.get('ctLabels')       || ''
    const elevationScale = formData.get('elevationScale') || '1/2" = 1\'-0"'
    const planScale      = formData.get('planScale')      || '1/4" = 1\'-0"'
    const unitMatrixRaw  = formData.get('unitMatrix')     || '[]'
    const unitMatrix     = JSON.parse(unitMatrixRaw)
    // directExtract=true skips the Haiku scan — used for per-unit uploads where
    // the user has already selected exactly the right elevation pages
    const directExtract  = formData.get('directExtract') === 'true' || unitMatrix.length === 1
    if (!files.length) return Response.json({ error: 'No files uploaded' }, { status: 400 })

    // Separate images from PDFs
    const imageFiles = files.filter(f => {
      const mt = f.type || ''
      const nm = (f.name || '').toLowerCase()
      return mt.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/.test(nm)
    })
    const pdfFiles   = files.filter(f => !imageFiles.includes(f))

    const buffers    = await Promise.all(pdfFiles.map(f => f.arrayBuffer().then(ab => Buffer.from(ab))))
    const mergedBuf  = buffers.length ? await mergePDFs(buffers) : null
    // Build image content blocks for any uploaded images
    const imageContentBlocks = await Promise.all(imageFiles.map(async f => {
      const buf = Buffer.from(await f.arrayBuffer())
      const mt  = f.type?.startsWith('image/') ? f.type : 'image/jpeg'
      return { type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } }
    }))

    const srcDoc = mergedBuf
      ? await PDFDocument.load(mergedBuf, { ignoreEncryption: true })
      : null
    const totalPages = srcDoc ? srcDoc.getPageCount() : 0

    // ── Step 1: Page classification ───────────────────────────────────────
    // directExtract skips Haiku scan entirely — all uploaded pages treated as
    // elevation sheets. Used by per-unit upload flow where user pre-selected pages.
    const singlePages = srcDoc ? await splitToSinglePages(mergedBuf) : []

    // Image pages — each image is its own "elevation page" with a pre-built content block
    const imagePseudoPages = imageContentBlocks.map((block, i) => ({
      idx: totalPages + i + 1,
      b64: null,
      _imageBlock: block,   // carry the image content block directly
      meta: { type: 'elevation', unit_type: unitMatrix[0]?.name || '' },
    }))

    let elevationPages, planPages

    if (directExtract) {
      // Trust the user — every uploaded page/image is a relevant elevation
      const pdfElevPages = singlePages.map(pg => ({ ...pg, meta: { type: 'elevation', unit_type: unitMatrix[0]?.name || '' } }))
      elevationPages = [...pdfElevPages, ...imagePseudoPages]
      planPages      = []
      console.log(`Countertop direct extract: ${pdfElevPages.length} PDF pages + ${imagePseudoPages.length} images → all elevations for "${unitMatrix[0]?.name}"`)
    } else {
      // Bulk upload — run Haiku scan to classify pages
      const SCAN_PROMPT = `This is a page from an architectural drawing set. Elevation sheets are typically at ${elevationScale} scale; floor plan sheets are typically at ${planScale} scale. Classify this page:
- "elevation": interior elevation — horizontal/front view of cabinets showing counter height, wall cabinets, base cabinets, dimension strings${ctLabels ? `, label callouts (${ctLabels})` : ''}. Scale: ${elevationScale}.
- "plan": top-down floor plan — bird's-eye view of room outlines, walls, plumbing fixtures, overall room dimensions. Scale: ${planScale}.
- "detail": construction detail, section cut, or specification.
- "cover": title sheet, index, legend, or notes.
- "other": structural, MEP, exterior, or non-relevant page.

TO FIND THE UNIT TYPE NAME look in these three locations:
1. TITLE BLOCK — bottom-right corner: "2 BED 2B UNIT PLAN" or "1 BED UNIT 1A"
2. PLAN TITLE — below each floor plan: "2 BED UNIT 2B FINISH PLAN"
3. ELEVATION LABELS — below each elevation: "2 BED BLV - 2B BATH ELEV B"
Strip suffixes (ELEV A, FINISH PLAN, UNIT PLAN) to get the unit designation.

Respond ONLY with JSON: {"type":"elevation","has_kitchen":true,"has_bathroom":false,"unit_type":"2 BED 2B","reason":"elevation label reads 2 BED BLV - 2B KITCHEN ELEV A"}`

      const scanResults = await Promise.all(singlePages.map(pg =>
        anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role:'user', content:[
            { type:'document', source:{ type:'base64', media_type:'application/pdf', data: pg.b64 }},
            { type:'text', text: SCAN_PROMPT }
          ]}],
        }).then(r => ({ ...pg, meta: safeParseJSON(r.content[0].text) || { type:'other' } }))
         .catch(() => ({ ...pg, meta: { type:'other' } }))
      ))

      elevationPages = [...scanResults.filter(p => p.meta.type === 'elevation'), ...imagePseudoPages]
      planPages      = scanResults.filter(p => p.meta.type === 'plan')
      const usefulPages = [...elevationPages, ...planPages]

      console.log(`Countertop scan: ${totalPages} PDF pages + ${imagePseudoPages.length} images → ${elevationPages.length} elevations, ${planPages.length} plans`)

      if (!usefulPages.length) {
        return Response.json({ error: 'No elevation or floor plan pages found. If uploading per-unit elevation sheets, this should resolve automatically.' }, { status: 422 })
      }
    }

    // ── Step 2: ELEV_PROMPT — verbatim from MDSG brief ───────────────────
    const matrixHint = unitMatrix.length
      ? `\nUnit types to find (from unit schedule): ${unitMatrix.map(u => u.name).join(', ')}\nAny unit type listed here but not found in the elevations MUST appear in "not_found".`
      : ''

    const ELEV_PROMPT = `You are extracting countertop measurements from architectural elevation drawings.
Drawing scale — elevations: ${elevationScale} · floor plans: ${planScale}
${ctLabels ? `Countertop surface labels: ${ctLabels}` : ''}
${matrixHint}

CRITICAL RULES:
- Search EVERY elevation sheet provided for unit types
- Every unique unit type listed in the unit schedule MUST have measurements extracted
- If you cannot find a unit type in the elevations, list it under "not_found" — do NOT skip it
- Output ALL measurements in FEET and DECIMAL FEET only (e.g. 7'9" = 7.75, never output 93 inches)
- Kitchen counter depth = 2.125 feet (25.5 inches)
- Bathroom vanity depth = 1.875 feet (22.5 inches)
- SF formula = LF × depth in feet (e.g. 7.75 × 2.125 = 16.47 SF)
- Output per unit quantities only — do NOT multiply by unit count
- Flag anything unclear with VERIFY
- You must extract measurements for EVERY unit type listed in the unit matrix. If a unit type shares the same floor plan as another unit type, copy those measurements and flag it as 'same layout as Unit X'. Do not stop after finding a few unit types — process every single one before returning results.

FIX 1 — MISSING UNITS:
You must find and extract measurements for ALL unit types in the unit schedule. A typical apartment building has multiple elevation sheets per unit type — check EVERY sheet. Do not stop until every unit type has been processed. If you finish and have fewer unit types than the unit schedule shows, go back and look again.

FIX 2 — MULTI-WALL KITCHENS:
Many kitchens have countertops on more than one wall shown across multiple elevation drawings (labeled Elev A, Elev B, Elev C etc). For each unit type, find ALL kitchen elevation views. Add the LF from every wall together to get the total kitchen counter LF. For example if Elev A shows 4'6" and Elev B shows 12'3", the total kitchen LF is 16'9" (16.75 LF). Never use only one elevation wall if multiple exist for the same unit.

FIX 3 — EXCLUDE RANGE AND APPLIANCE OPENINGS:
When measuring countertop linear footage, DO NOT include the width of any range, oven, cooktop, or appliance opening. These openings are NOT countertop. Subtract them from the run. A standard range opening is 30 inches (2.5 LF). Only measure the actual countertop surface shown highlighted or labeled as QT01 or countertop material.

KITCHEN VS BATHROOM ELEVATION IDENTIFICATION:
The uploaded pages will contain BOTH kitchen elevations and bathroom/vanity elevations for the same unit type.
You MUST separate them correctly:

KITCHEN ELEVATIONS — any elevation sheet whose label contains:
  KITCHEN, KIT, KITCH, KITCHEN ELEV, KITCHEN ELEVATION, "K ELEV", "UNIT KITCHEN"
  OR shows a range/cooktop symbol, dishwasher, refrigerator, upper wall cabinets over base cabinets
  → Measure kitchen_lf from these sheets only

BATHROOM / VANITY ELEVATIONS — any elevation sheet whose label contains:
  BATH, BATHROOM, VANITY, VAN, LAV, LAVATORY, TUB, SHOWER, "B ELEV", "BATH ELEV"
  OR shows a toilet, tub surround, vanity mirror, or medicine cabinet
  → Measure vanity_lf from these sheets only

NEVER mix kitchen LF into vanity_lf or vice versa.
If a sheet shows BOTH (e.g. a combined kitchen/bath sheet), measure each surface separately by what is shown.

HOW TO IDENTIFY THE UNIT TYPE ON EACH SHEET:
Look in these three specific locations — use whichever is clearest:
  1. TITLE BLOCK — bottom-right corner of the sheet: large text box showing e.g. "2 BED 2B UNIT PLAN" or "1 BED UNIT 1A"
  2. PLAN TITLE — text label directly below each floor plan view: e.g. "2 BED UNIT 2B FINISH PLAN" at scale "1/4\" = 1'-0\""
  3. ELEVATION LABELS — text below each interior elevation drawing: e.g. "2 BED BLV - 2B KITCHEN ELEV A" or "1 BED UNIT 1A BATH ELEV B"
Strip direction/view suffixes (ELEV A, ELEV B, FINISH PLAN, UNIT PLAN) to get the apartment designation like "2B", "1A", "Unit 2B".

HOW TO READ KITCHEN DIMENSIONS:
- Read the horizontal dimension string at the top or bottom of the elevation
- Include: base cabinet segments, sink base, dishwasher opening (counter runs over DW)
- Exclude: range/cooktop gap, oven opening, refrigerator space, upper wall cabinets, filler strips — these are NOT countertop
- Add all walls together: if Elev A = 4.5 LF and Elev B = 12.25 LF, kitchen_lf = 16.75
- Convert feet-inches to decimal: 7'-9" = 7.75, 4'-6" = 4.5, 2'-9" = 2.75, 1'-8" = 1.67
- kitchen_lf = total of ALL counter surfaces across ALL walls in the kitchen
- backsplash_lf = total kitchen counter LF + vanity LF (everything that gets tile or material behind it)

OUTPUT FORMAT — return ONLY this JSON structure, no markdown:
{
  "unit_types": [
    {
      "unit_type": "Unit 1A",
      "kitchen_lf": 7.75,
      "kitchen_sf": 16.47,
      "vanity_lf": 4.5,
      "vanity_sf": 8.44,
      "backsplash_lf": 12.25,
      "sink_cutouts": 1,
      "flags": []
    }
  ],
  "not_found": ["Unit 1C", "Unit 1D"]
}`

    // Convert flat extraction format → nested format the component expects
    function flatToNested(flat) {
      const kLF  = typeof flat.kitchen_lf === 'number' ? flat.kitchen_lf : null
      const vLF  = typeof flat.vanity_lf  === 'number' ? flat.vanity_lf  : null
      const kSF  = typeof flat.kitchen_sf === 'number' ? flat.kitchen_sf : (kLF ? +(kLF * 2.125).toFixed(2) : null)
      const vSF  = typeof flat.vanity_sf  === 'number' ? flat.vanity_sf  : (vLF ? +(vLF * 1.875).toFixed(2) : null)
      const bLF  = typeof flat.backsplash_lf === 'number' ? flat.backsplash_lf : ((kLF||0) + (vLF||0))
      const cuts = flat.sink_cutouts || (vLF ? 1 : 0)
      const flags = flat.flags || []

      const kRuns = kLF !== null ? [{
        label:         'Kitchen counter',
        lf:            String(flat.kitchen_lf).toUpperCase() === 'VERIFY' ? 'VERIFY' : kLF,
        depth_in:      25.5,
        backsplash_lf: bLF - (vLF||0),
        has_sink:      cuts > 0,
        sf:            String(flat.kitchen_sf).toUpperCase() === 'VERIFY' ? 'VERIFY' : kSF,
      }] : (flags.includes('kitchen_lf') ? [{ label:'Kitchen counter', lf:'VERIFY', depth_in:25.5, backsplash_lf:'VERIFY', has_sink:false, sf:'VERIFY' }] : [])

      const vRuns = vLF !== null ? [{
        label:         'Bathroom vanity',
        lf:            String(flat.vanity_lf).toUpperCase() === 'VERIFY' ? 'VERIFY' : vLF,
        depth_in:      22.5,
        backsplash_lf: vLF,
        has_sink:      true,
        sf:            String(flat.vanity_sf).toUpperCase() === 'VERIFY' ? 'VERIFY' : vSF,
      }] : (flags.includes('vanity_lf') ? [{ label:'Bathroom vanity', lf:'VERIFY', depth_in:22.5, backsplash_lf:'VERIFY', has_sink:true, sf:'VERIFY' }] : [])

      return {
        unit_type_name: flat.unit_type,
        unit_quantity:  1,
        _flags:         flags,
        kitchen: { runs: kRuns, backsplash_lf: bLF - (vLF||0), side_splashes: [] },
        vanity:  { runs: vRuns },
      }
    }

    // ── Step 2a: Group elevation pages by unit type ───────────────────────
    const unitTypeGroups = {}
    const unclaimedElevs = []

    elevationPages.forEach(pg => {
      const utName = (pg.meta.unit_type || '').trim()
      if (utName) {
        if (!unitTypeGroups[utName]) unitTypeGroups[utName] = []
        unitTypeGroups[utName].push(pg)
      } else {
        unclaimedElevs.push(pg)
      }
    })

    if (Object.keys(unitTypeGroups).length === 0 && unclaimedElevs.length > 0) {
      for (let i = 0; i < unclaimedElevs.length; i += 3) {
        unitTypeGroups[`batch_${i}`] = unclaimedElevs.slice(i, i + 3)
      }
    } else if (unclaimedElevs.length > 0) {
      unitTypeGroups['__unclaimed__'] = unclaimedElevs
    }

    const nearestPlan = (pages) => {
      if (!planPages.length) return null
      const mid = pages[Math.floor(pages.length / 2)]?.idx || 0
      return planPages.reduce((best, pg) =>
        Math.abs(pg.idx - mid) < Math.abs((best?.idx || 9999) - mid) ? pg : best
      , null)
    }

    // ── Step 2b: One Opus call per unit type group ────────────────────────
    const allUnitTypes           = []
    const allNotes               = []
    const notFoundFromExtraction = []
    const groupEntries           = Object.entries(unitTypeGroups)

    // Simple read-only prompt — Claude copies dimension strings, code does all math
    const DIRECT_PROMPT = () => `Look at these elevation drawings and copy the dimension strings you see.

For each elevation view (Kitchen Elev A, Kitchen Elev B, Bath Elev, Vanity Elev, etc.):
- Find the row of dimension numbers printed along the bottom of the base cabinets
- Copy every number from left to right exactly as printed
- Note what each dimension is over (cabinet, range, refrigerator, filler)

Also note:
- Which dimension is the RANGE or COOKTOP opening (if any)
- Which dimension is the REFRIGERATOR space (if any)
- How many sinks are visible

Output format — copy this exactly, one elevation per block:

ELEV: [elevation name from drawing label]
DIMS: [list every dimension left to right, comma separated, exactly as printed]
RANGE: [dimension of range opening, or NONE]
REF: [dimension of refrigerator space, or NONE]

ELEV: [next elevation name]
DIMS: [...]
RANGE: [...]
REF: [...]

SINK_CUTOUTS: [number]

Do not do any math. Just copy what you see.`

    // ── Dimension string parser — converts "2'-9"" → 2.75 ft ─────────────
    function parseDimToFt(str) {
      if (!str) return null
      const s = str.trim().replace(/["""]/g, '"').replace(/[''']/g, "'")
      // Feet + inches: 2'-9", 1'-3", 2'-6"
      const fi = s.match(/^(\d+)'\s*[\-–]?\s*(\d+(?:[\/\-]\d+)?)"?/)
      if (fi) {
        const ft = parseInt(fi[1], 10)
        let inches = fi[2]
        if (inches.includes('/')) {
          const [n, d] = inches.split('/').map(Number)
          return ft + n/d/12
        }
        if (inches.includes('-')) {
          const parts = inches.split('-')
          const whole = parseInt(parts[0], 10)
          const [n, d] = parts[1].split('/').map(Number)
          return ft + (whole + n/d) / 12
        }
        return ft + parseInt(inches, 10) / 12
      }
      // Feet only: 3'
      const fo = s.match(/^(\d+(?:\.\d+)?)'$/)
      if (fo) return parseFloat(fo[1])
      // Inches only: 3", 2-1/2", 2½"
      const io = s.match(/^(\d+(?:\.\d+)?(?:[\/\-½¼¾]\d*)?)"?$/)
      if (io) {
        const raw = io[1]
        if (raw === '½') return 0.5/12
        if (raw.includes('/')) {
          const [n, d] = raw.split('/').map(Number)
          return n/d/12
        }
        if (raw.includes('-')) {
          const [w, frac] = raw.split('-')
          const [n, d] = frac.split('/').map(Number)
          return (parseInt(w, 10) + n/d) / 12
        }
        return parseFloat(raw) / 12
      }
      return null
    }

    // Parse the simple ELEV/DIMS/RANGE/REF output from DIRECT_PROMPT
    function parseSimpleOutput(raw, typeName) {
      if (!raw) return null
      const IS_VANITY = /bath|vanity|lav/i
      const IS_KITCHEN = /kitchen|kit\b/i
      const IS_SKIP = /range|cooktop|refrigerator|\bref\b|fridge/i
      const IS_FILLER = /filler/i

      // Split into elevation blocks
      const blocks = raw.split(/(?=ELEV\s*:)/i).filter(b => b.trim())
      let kitchenFt = 0, vanityFt = 0, sinkCutouts = 0
      let hasKitchen = false, hasVanity = false

      for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
        if (!lines.length) continue

        // Identify elevation type
        const header = lines[0].replace(/^ELEV\s*:\s*/i, '').trim()
        const isKitchen = IS_KITCHEN.test(header)
        const isVanity  = IS_VANITY.test(header)
        if (!isKitchen && !isVanity) continue

        // Find DIMS line
        const dimsLine = lines.find(l => /^DIMS\s*:/i.test(l))
        if (!dimsLine) continue
        const dimsStr = dimsLine.replace(/^DIMS\s*:\s*/i, '')

        // Find what to subtract
        const rangeLine = lines.find(l => /^RANGE\s*:/i.test(l))
        const refLine   = lines.find(l => /^REF\s*:/i.test(l))
        const rangeStr  = rangeLine ? rangeLine.replace(/^RANGE\s*:\s*/i, '').trim() : 'NONE'
        const refStr    = refLine   ? refLine.replace(/^REF\s*:\s*/i, '').trim()   : 'NONE'

        // Parse all dimensions from the DIMS line
        const dimTokens = dimsStr.split(/,\s*/).map(s => s.trim()).filter(Boolean)
        let wallFt = 0
        for (const tok of dimTokens) {
          const ft = parseDimToFt(tok)
          if (ft != null) wallFt += ft
        }

        // Subtract range and refrigerator
        if (rangeStr && rangeStr.toUpperCase() !== 'NONE') {
          const rf = parseDimToFt(rangeStr)
          if (rf) wallFt -= rf
        }
        if (refStr && refStr.toUpperCase() !== 'NONE') {
          const rf = parseDimToFt(refStr)
          if (rf) wallFt -= rf
        }

        wallFt = Math.max(0, wallFt)

        if (isKitchen) { kitchenFt += wallFt; hasKitchen = true }
        if (isVanity)  { vanityFt  += wallFt; hasVanity  = true }
      }

      // Sink cutouts
      const sinkMatch = raw.match(/SINK_CUTOUTS?\s*:\s*(\d+)/i)
      if (sinkMatch) sinkCutouts = parseInt(sinkMatch[1], 10)
      else if (hasVanity) sinkCutouts = 1

      if (!hasKitchen && !hasVanity) return null

      const kLF = hasKitchen ? +kitchenFt.toFixed(4) : null
      const vLF = hasVanity  ? +vanityFt.toFixed(4)  : null
      console.log(`Simple parse for "${typeName}": kitchen=${kLF}, vanity=${vLF}`)
      return {
        unit_type: typeName, kitchen_lf: kLF, vanity_lf: vLF,
        kitchen_sf: kLF != null ? +(kLF * 2.125).toFixed(2) : null,
        vanity_sf:  vLF != null ? +(vLF * 1.875).toFixed(2) : null,
        backsplash_lf: (kLF||0) + (vLF||0),
        sink_cutouts: sinkCutouts, flags: [],
      }
    }

    // Parse the structured ELEV: / segment output from DIRECT_PROMPT
    // Returns {kitchen_lf, vanity_lf, kitchen_sf, vanity_sf, backsplash_lf, sink_cutouts}
    function parseStructuredOutput(raw, typeName) {
      if (!raw) return null

      const SKIP_LABELS = ['RANGE', 'COOKTOP', 'REFRIGERATOR', 'REF', 'FRIDGE', 'FILLER', 'DECORATIVE']
      const VANITY_ELEV = /bath|vanity|lav|lavatory/i
      const KITCHEN_ELEV = /kitchen|kit\b/i

      let kitchenTotalFt = 0
      let vanityTotalFt  = 0
      let sinkCutouts    = 0
      let hasKitchen     = false
      let hasVanity      = false

      // Split into elevation blocks
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
      let currentType = null  // 'kitchen' | 'vanity' | null

      for (const line of lines) {
        // Detect elevation header: "ELEV: Kitchen Elev B" or "=== Elev A ==="
        const elevHeader = line.match(/^(?:ELEV:|===?\s*)(.+?)(?:\s*===?)?$/i)
        if (elevHeader) {
          const label = elevHeader[1].trim()
          currentType = VANITY_ELEV.test(label) ? 'vanity' : KITCHEN_ELEV.test(label) ? 'kitchen' : null
          continue
        }

        // Sink cutouts
        const sinkMatch = line.match(/SINK_CUTOUTS?\s*:\s*(\d+)/i)
        if (sinkMatch) { sinkCutouts = parseInt(sinkMatch[1], 10); continue }

        // Segment line: "2'-6" | RANGE" or "1'-3" | BASE CABINET"
        const segMatch = line.match(/^([^|]+)\|\s*(.+)$/)
        if (segMatch && currentType) {
          const dimStr  = segMatch[1].trim()
          const label   = segMatch[2].trim().toUpperCase()
          const skip    = SKIP_LABELS.some(s => label.includes(s))
          if (!skip) {
            const ft = parseDimToFt(dimStr)
            if (ft != null) {
              if (currentType === 'kitchen') { kitchenTotalFt += ft; hasKitchen = true }
              if (currentType === 'vanity')  { vanityTotalFt  += ft; hasVanity  = true }
            }
          }
        }
      }

      if (!hasKitchen && !hasVanity) return null

      const kLF = hasKitchen ? +kitchenTotalFt.toFixed(4) : null
      const vLF = hasVanity  ? +vanityTotalFt.toFixed(4)  : null
      const kSF = kLF != null ? +(kLF * 2.125).toFixed(2) : null
      const vSF = vLF != null ? +(vLF * 1.875).toFixed(2) : null

      console.log(`Structured parse for "${typeName}": kitchen=${kLF} ft, vanity=${vLF} ft`)

      return {
        unit_type:     typeName,
        kitchen_lf:    kLF,
        vanity_lf:     vLF,
        kitchen_sf:    kSF,
        vanity_sf:     vSF,
        backsplash_lf: (kLF||0) + (vLF||0),
        sink_cutouts:  sinkCutouts || (hasVanity ? 1 : 0),
        flags: [],
      }
    }

    // Flexible response parser — handles any format Opus returns including "show your work"
    function parseAnyResponse(raw, typeName) {
      if (!raw) return null
      const txt = raw.toLowerCase().replace(/\r\n/g, '\n')

      // Find a labeled number — prefers the LAST match (totals come after individual walls)
      const findNum = (...patterns) => {
        let lastVal = null
        for (const p of patterns) {
          const re  = new RegExp(p + '[^\\d\\n]*(\\d+\\.?\\d*)', 'gi')
          let m
          while ((m = re.exec(txt)) !== null) lastVal = parseFloat(m[1])
          if (lastVal != null) return lastVal
        }
        return null
      }

      // For kitchen LF: explicit total preferred, then sum individual walls
      const findKitchenLF = () => {
        // 1. Explicit kitchen_lf total line
        const totalLine = findNum(
          'kitchen_lf\\s*:',
          'total kitchen lf\\s*:',
          'total kitchen\\s*:',
          'kitchen total\\s*:',
          'combined kitchen\\s*:'
        )
        if (totalLine != null) return totalLine

        // 2. Sum all "Elev X kitchen: Y.YY LF" lines (output format we ask for)
        //    Matches: "Elev B kitchen: 12.25" or "Elev A kitchen: 4.75"
        const wallLines = [...txt.matchAll(/elev\s*[a-z0-9]+\s+kitchen\s*:\s*([\d.]+)/gi)]
        if (wallLines.length > 0) {
          const sum = wallLines.reduce((s, m) => s + parseFloat(m[1]), 0)
          console.log(`Summed ${wallLines.length} kitchen walls from labeled lines: ${sum.toFixed(2)} LF`)
          return +sum.toFixed(2)
        }

        // 3. Sum all "Elev X: Y.YY LF" or "Elev X: Y.YY" lines (fallback)
        const elevLines = [...txt.matchAll(/elev\s*[a-z0-9]+\s*[:\-]\s*([\d.]+)/gi)]
        if (elevLines.length > 1) {
          const sum = elevLines.reduce((s, m) => s + parseFloat(m[1]), 0)
          console.log(`Summed ${elevLines.length} elevation lines: ${sum.toFixed(2)} LF`)
          return +sum.toFixed(2)
        }
        if (elevLines.length === 1) return parseFloat(elevLines[0][1])

        // 4. Look for "left section X + right section Y" pattern and sum
        const splitMatch = txt.match(/left\s+section\s+([\d.]+).*right\s+section\s+([\d.]+)/i)
        if (splitMatch) {
          const sum = parseFloat(splitMatch[1]) + parseFloat(splitMatch[2])
          console.log(`Split counter: left ${splitMatch[1]} + right ${splitMatch[2]} = ${sum}`)
          return +sum.toFixed(2)
        }

        // 5. Generic fallback
        return findNum('kitchen\\s*:', 'kitchen counter\\s*:', 'kitchen lf\\s*:')
      }

      const kLF  = findKitchenLF()
      const vLF  = findNum('vanity_lf\\s*:', 'vanity lf\\s*:', 'bathroom lf\\s*:', 'bath lf\\s*:', 'vanity\\s*:', 'bath\\s*:')
      const kSF  = findNum('kitchen_sf\\s*:', 'kitchen sf\\s*:') ?? (kLF != null ? +(kLF * 2.125).toFixed(2) : null)
      const vSF  = findNum('vanity_sf\\s*:', 'vanity sf\\s*:', 'bath sf\\s*:') ?? (vLF != null ? +(vLF * 1.875).toFixed(2) : null)
      const bLF  = findNum('backsplash_lf\\s*:', 'backsplash lf\\s*:', 'backsplash\\s*:') ?? ((kLF||0) + (vLF||0))
      const cuts = findNum('sink_cutouts\\s*:', 'sink cutouts\\s*:', 'cutouts\\s*:', 'sinks\\s*:') ?? (vLF != null ? 1 : 0)

      if (kLF == null && vLF == null) return null
      return {
        unit_type:     typeName,
        kitchen_lf:    kLF,
        vanity_lf:     vLF,
        kitchen_sf:    kSF,
        vanity_sf:     vSF,
        backsplash_lf: bLF,
        sink_cutouts:  Math.round(cuts || 0),
        flags: [],
      }
    }

    // ── Direct extraction via Haiku + regex — format-agnostic ───────────────
    // Strategy: ask Haiku to answer two simple questions, extract numbers with regex.
    // No format dependency — works regardless of how Haiku phrases its answer.
    async function extractDirect(docs, typeName) {
      const HAIKU_PROMPT = `These images show kitchen and/or bathroom elevation drawings.

Answer these questions:

1. KITCHEN: What dimension numbers appear at the BOTTOM of the kitchen elevation (below the base cabinets)? List them all left to right. What is the range/cooktop width? What is the refrigerator width?

2. VANITY: What dimension numbers appear at the bottom of the bathroom vanity? List them all.

3. SINKS: How many sink symbols are visible?

Just answer — no explanation needed.`

      try {
        const res = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{ role: 'user', content: [...docs, { type: 'text', text: HAIKU_PROMPT }] }],
        })
        const raw = res.content[0].text
        console.log(`Direct Haiku response for "${typeName}":\n${raw}`)
        return regexExtract(raw, typeName)
      } catch (err) {
        console.error('Direct Haiku extraction error:', err.message)
        return null
      }
    }

    // Extract measurements from ANY text using regex — no format dependency
    function regexExtract(raw, typeName) {
      if (!raw) return null

      // Find all feet-inch dimensions in the text: 2'-9", 1'-6", 3'-0" etc.
      const DIM_RE = /(\d+)'\s*[-–]?\s*(\d+(?:[\/\-]\d+)?)\s*"/g

      // Convert a regex match to decimal feet
      const matchToFt = (m) => {
        const ft = parseInt(m[1], 10)
        let ins = m[2]
        if (ins.includes('/')) { const [n,d]=ins.split('/'); return ft + parseInt(n)/parseInt(d)/12 }
        if (ins.includes('-')) { const [w,f]=ins.split('-'); const [n,d]=f.split('/'); return ft + (parseInt(w)+parseInt(n)/parseInt(d))/12 }
        return ft + parseInt(ins,10)/12
      }

      // Split text into kitchen section and vanity section by keywords
      const txt = raw.toLowerCase()
      const vanityKeywords = /bath|vanity|lav/i
      const kitchenKeywords = /kitchen|kit\b/i
      const rangeKeywords = /range|cooktop/i
      const refKeywords = /refrigerator|\bref\b|fridge/i

      // Find the split point between kitchen and vanity sections
      let kitchenText = raw, vanityText = ''
      const vanityMatch = raw.search(/\b(vanity|bath|bathroom|lavatory)\b/i)
      if (vanityMatch > 50) {
        kitchenText = raw.substring(0, vanityMatch)
        vanityText  = raw.substring(vanityMatch)
      }

      // Extract all dims from kitchen section
      const kitchenDims = [...kitchenText.matchAll(DIM_RE)].map(matchToFt)

      // Find range and ref widths to subtract
      let rangeWidth = 0, refWidth = 0
      const lines = kitchenText.split('\n')
      for (const line of lines) {
        if (rangeKeywords.test(line)) {
          const m = line.match(/(\d+)'\s*[-–]?\s*(\d+(?:[\/\-]\d+)?)\s*"/)
          if (m) rangeWidth = matchToFt(m)
        }
        if (refKeywords.test(line)) {
          const m = line.match(/(\d+)'\s*[-–]?\s*(\d+(?:[\/\-]\d+)?)\s*"/)
          if (m) refWidth = matchToFt(m)
        }
      }

      // Kitchen LF = sum all dims - range - ref
      let kLF = kitchenDims.reduce((s, v) => s + v, 0) - rangeWidth - refWidth
      kLF = kLF > 0 ? +kLF.toFixed(4) : null

      // Vanity dims
      const vanityDims = [...vanityText.matchAll(DIM_RE)].map(matchToFt)
      const vLF = vanityDims.length > 0 ? +vanityDims.reduce((s,v)=>s+v,0).toFixed(4) : null

      // Sinks
      const sinkMatch = raw.match(/(\d+)\s+sink/i) || raw.match(/sink[s]?\s*:\s*(\d+)/i)
      const sinks = sinkMatch ? parseInt(sinkMatch[1], 10) : (vLF ? 1 : 0)

      if (!kLF && !vLF) {
        console.error('regexExtract: no dimensions found in:', raw.substring(0, 400))
        return null
      }

      console.log(`regexExtract for "${typeName}": kitchen=${kLF} ft (range=${rangeWidth.toFixed(2)}), vanity=${vLF} ft`)
      return {
        unit_type: typeName,
        kitchen_lf: kLF, vanity_lf: vLF,
        kitchen_sf: kLF ? +(kLF * 2.125).toFixed(2) : null,
        vanity_sf:  vLF ? +(vLF * 1.875).toFixed(2) : null,
        backsplash_lf: (kLF||0) + (vLF||0),
        sink_cutouts: sinks, flags: [],
      }
    }

    // Extract unit types — tries direct Haiku first, then falls back to Opus parsers
    function extractUnitTypes(raw, typeName) {
      if (!raw) return []
      console.log(`CT extraction for "${typeName}" (first 600):\n${raw.substring(0, 600)}`)
      const clean = raw.trim().replace(/^```[a-z]*\n?/gm,'').replace(/^```\n?/gm,'').trim()

      // Try JSON first (bulk path)
      const parsed = safeParseJSON(clean)
      if (parsed) {
        if (Array.isArray(parsed.unit_types) && parsed.unit_types.length) return parsed.unit_types
        if (parsed.unit_type !== undefined) return [parsed]
        if (Array.isArray(parsed) && parsed.length) return parsed
        if (parsed.kitchen_lf != null || parsed.vanity_lf != null)
          return [{ unit_type: typeName || 'Unit', ...parsed }]
      }

      // Try structured text parsers
      if (typeName && raw.match(/^ELEV\s*:/im) && raw.match(/^DIMS\s*:/im)) {
        const r = parseSimpleOutput(raw, typeName); if (r) return [r]
      }
      if (typeName && raw.match(/^ELEV:/im) && raw.match(/\|\s*(BASE|SINK|RANGE|VANITY)/im)) {
        const r = parseStructuredOutput(raw, typeName); if (r) return [r]
      }

      // Regex fallback — extracts dims from ANY text format
      if (typeName) {
        const r = regexExtract(raw, typeName); if (r) return [r]
      }

      // Flexible text parsing
      const textResult = parseAnyResponse(raw, typeName || 'Unit')
      if (textResult) return [textResult]

      console.error('extractUnitTypes: nothing parseable. Raw:\n', raw.substring(0, 500))
      return []
    }

    const PARALLEL = 4
    for (let b = 0; b < groupEntries.length; b += PARALLEL) {
      const batch = groupEntries.slice(b, b + PARALLEL)
      await Promise.all(batch.map(async ([groupName, elevPages]) => {
        const plan = nearestPlan(elevPages)
        const docs = [
          ...elevPages.map(p =>
            p._imageBlock
              ? p._imageBlock   // already-built image content block
              : { type:'document', source:{ type:'base64', media_type:'application/pdf', data: p.b64 }}
          ),
          ...(plan && !plan._imageBlock ? [{ type:'document', source:{ type:'base64', media_type:'application/pdf', data: plan.b64 }}] : []),
        ]
        if (!docs.length) return

        const matrixEntry = unitMatrix.find(u =>
          groupName !== '__unclaimed__' && !groupName.startsWith('batch_') &&
          namesMatch(u.name, groupName)
        )

        try {
          // ── Direct per-unit upload: Haiku reads dims, regex does math ──
          // ── Bulk upload: Opus with full ELEV_PROMPT ────────────────────
          let units = []
          if (directExtract && matrixEntry) {
            const result = await extractDirect(docs, matrixEntry.name)
            if (result) units = [result]
          } else {
            const prompt = ELEV_PROMPT + (matrixEntry
              ? `\nTARGET UNIT TYPE: "${matrixEntry.name}" (${matrixEntry.quantity} units).`
              : groupName.startsWith('batch_') || groupName === '__unclaimed__'
                ? `\nExtract ALL unit types visible on these pages.`
                : `\nTARGET UNIT TYPE: "${groupName}"`)
            const res = await anthropic.messages.create({
              model: 'claude-opus-4-7',
              max_tokens: 4000,
                  messages: [{ role:'user', content: [...docs, { type:'text', text: prompt }] }],
            })
            units = extractUnitTypes(res.content[0].text, matrixEntry?.name)
          }

          if (!units.length) {
            console.error(`Group "${groupName}": no unit types extracted`)
          }
        } catch (err) {
          console.error(`Group "${groupName}" extraction error:`, err.message)
        }
      }))
    }

    // Plan-only fallback
    if (allUnitTypes.length === 0 && planPages.length > 0) {
      try {
        const docs = planPages.slice(0, 4).map(p => ({ type:'document', source:{ type:'base64', media_type:'application/pdf', data: p.b64 }}))
        const res = await anthropic.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 4000,
          messages: [{ role:'user', content: [...docs, { type:'text', text: ELEV_PROMPT }] }],
        })
        const units = extractUnitTypes(res.content[0].text, null)
        if (units.length) allUnitTypes.push(...units)
      } catch (err) {
        console.error('Plan-only fallback error:', err.message)
      }
    }

    // ── Step 3: Normalise + merge unit types ─────────────────────────────
    // Convert flat format → nested if needed, then deduplicate
    const normalisedTypes = allUnitTypes.map(ut => {
      if (ut.unit_type !== undefined) {
        // New flat format — convert to nested
        if (ut.not_found?.length) notFoundFromExtraction.push(...ut.not_found)
        return flatToNested(ut)
      }
      return ut  // already nested from older pass
    })

    const unitMap = {}
    normalisedTypes.forEach(ut => {
      const key = ut.unit_type_name?.trim() || 'Unit'
      if (!unitMap[key]) {
        unitMap[key] = { ...ut }
      } else {
        const existing = unitMap[key]
        ;(ut.kitchen?.runs || []).forEach(run => {
          const dup = existing.kitchen?.runs?.find(r =>
            Math.abs((r.lf||0) - (run.lf||0)) < 0.1 && r.label === run.label
          )
          if (!dup && existing.kitchen) existing.kitchen.runs.push(run)
        })
        ;(ut.vanity?.runs || []).forEach(run => {
          const dup = existing.vanity?.runs?.find(r =>
            Math.abs((r.lf||0) - (run.lf||0)) < 0.1 && r.label === run.label
          )
          if (!dup && existing.vanity) existing.vanity.runs.push(run)
        })
        if (ut.kitchen?.side_splashes?.length && existing.kitchen) {
          existing.kitchen.side_splashes = [
            ...(existing.kitchen.side_splashes || []),
            ...ut.kitchen.side_splashes,
          ]
        }
        if ((ut.unit_quantity || 1) > (existing.unit_quantity || 1)) {
          existing.unit_quantity = ut.unit_quantity
        }
      }
    })

    const unitTypes = Object.values(unitMap)
    if (!unitTypes.length) {
      const hint = directExtract
        ? 'Claude could not find countertop dimensions on these pages. Make sure the PDF shows the actual elevation drawing with dimension strings (e.g. 2\'-0"  2\'-9"  1\'-6") at the top or bottom of the elevation view. Try uploading just the elevation sheet, not a full plan set.'
        : 'No countertop measurements found. Upload the interior elevation sheets that show kitchen and bathroom cabinet layouts with dimension callouts.'
      return Response.json({ error: hint }, { status: 422 })
    }

    // ── Flag missing unit types (from matrix + Claude's not_found) ───────
    const foundNames = unitTypes.map(u => u.unit_type_name.toUpperCase())
    const flaggedFromMatrix = unitMatrix
      .filter(m => !foundNames.some(f => namesMatch(f, m.name)))
      .map(m => m.name)

    const flaggedUnitTypes = [...new Set([...flaggedFromMatrix, ...notFoundFromExtraction])]

    // Apply authoritative unit counts from the locked matrix
    unitTypes.forEach(ut => {
      const match = unitMatrix.find(m => namesMatch(ut.unit_type_name, m.name))
      if (match && match.quantity > 0) ut.unit_quantity = match.quantity
    })

    return Response.json({
      success: true,
      unit_types: unitTypes,
      flagged_unit_types: flaggedUnitTypes,
      notes: allNotes.join(' | ') || null,
      extraction_detail: {
        elevation_pages: elevationPages.length,
        plan_pages: planPages.length,
        unit_types_found: unitTypes.length,
      }
    })
  } catch (err) {
    console.error('Countertop extraction error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
