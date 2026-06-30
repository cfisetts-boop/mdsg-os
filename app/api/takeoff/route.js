import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { PDFDocument } from 'pdf-lib'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const APPLIANCE_RE = /^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|WASH|DRYER|OVEN|HOOD|VENT)/i
function stripAppliances(data) {
  if (!data?.unit_types) return data
  return {
    ...data,
    unit_types: data.unit_types.map(ut => ({
      ...ut,
      skus: (ut.skus || []).filter(s => !APPLIANCE_RE.test(s.sku || '')),
    })),
  }
}

function safeParseJSON(raw, isTakeoff = false) {
  try { return JSON.parse(raw) } catch (_) {}
  let depth = 0, inString = false, escaped = false, lastSafeEnd = -1
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') { depth--; if (depth === 0) lastSafeEnd = i }
  }
  if (lastSafeEnd > 0) { try { return JSON.parse(raw.substring(0, lastSafeEnd + 1)) } catch (_) {} }
  let repaired = raw; inString = false; escaped = false; const stack = []
  for (const ch of repaired) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop()
  }
  if (inString) repaired += '"'
  repaired += stack.reverse().join('')
  try {
    const parsed = JSON.parse(repaired)
    if (isTakeoff) {
      parsed.flags = parsed.flags || []
      parsed.flags.push('WARNING: Opus response was truncated — some unit types may be incomplete.')
      parsed.extraction_confidence = parsed.extraction_confidence || 'low'
    }
    return parsed
  } catch (err) { throw new Error(`JSON parse failed: ${err.message}`) }
}

const CHUNK_SIZE = 5
const BATCH_SIZE = 4
const MAX_EXTRACT_PAGES = 25

async function extractPageRange(fullPdfBytes, startPage, endPage) {
  const srcDoc = await PDFDocument.load(fullPdfBytes, { ignoreEncryption: true })
  const newDoc = await PDFDocument.create()
  const indices = []
  for (let i = startPage; i <= endPage && i < srcDoc.getPageCount(); i++) indices.push(i)
  const copied = await newDoc.copyPages(srcDoc, indices)
  copied.forEach(p => newDoc.addPage(p))
  return await newDoc.save()
}

async function extractSpecificPages(fullPdfBytes, pageNumbers) {
  const srcDoc = await PDFDocument.load(fullPdfBytes, { ignoreEncryption: true })
  const total = srcDoc.getPageCount()
  const valid = [...new Set(pageNumbers)].filter(n => n >= 0 && n < total).sort((a, b) => a - b)
  if (valid.length === 0) return null
  const newDoc = await PDFDocument.create()
  const copied = await newDoc.copyPages(srcDoc, valid)
  copied.forEach(p => newDoc.addPage(p))
  return { bytes: await newDoc.save(), pageNumbers: valid }
}

async function scanChunk(chunkBytes, startPage, chunkCount) {
  const base64 = Buffer.from(chunkBytes).toString('base64')
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 600,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: `These are pages ${startPage + 1}-${startPage + chunkCount} of an architectural plan set.
Identify pages containing: unit_schedule, floor_plan, kitchen_elevation, bathroom_elevation, finish_schedule, amenity, sheet_index.
Return ONLY a JSON array. Page numbers start at ${startPage + 1}.
Example: [{"page":${startPage + 1},"type":"kitchen_elevation","description":"Unit 1A kitchen"}]
If no relevant pages: []` }
    ]}]
  })
  try {
    const t = res.content[0].text, s = t.indexOf('['), e = t.lastIndexOf(']')
    if (s === -1) return []
    return JSON.parse(t.substring(s, e + 1))
  } catch { return [] }
}

function buildExtractionPrompt(specs, context, matrixContext) {
  return `You are an expert cabinet takeoff specialist for MDSG (Manufacturer Direct Sales Group).
${context}${matrixContext}

Extract a complete cabinet list from these elevation drawings.

STEP 1 — UNIT TYPES
If a UNIT MATRIX is provided above, USE those names and quantities exactly.
CRITICAL: Never merge ADA/accessible units with standard units — separate unit type required.

STEP 2 — SKU NAMING
W=Wall/Upper W[w][h], WO=Wall Open, WBC=Wall Bridge, B=Base B[w], DB=Drawer Base DB[w]-[drawers],
SB=Sink Base SB[w], BB=Blind Base, BMC=Base Microwave, T=Tall T[w][h][d], PT=Pantry Tall,
LT=Linen Tall, LC=Linen, VB=Vanity Base VB[w], VDB=Vanity Drawer VDB[w]-[drawers],
VSB=Vanity Sink VSB[w] (add door notation e.g. VSB48LDRD), TSK=Shelf Kit TSK[w][h]
ADA units: add -32.5 suffix e.g. B18-32.5, DB18-4-32.5 — copy EXACTLY, do NOT drop suffix.

STEP 3 — FILLERS (fillers array, not skus)
WF330=wall filler 3x30h, WF342=wall filler 3x42h, TF396=tall filler 3x96h,
BEP3=base end panel 3in, TK8=toe kick board

STEP 4 — TOE KICKS
Sum base widths (B/DB/SB/BMC) in inches, exclude fridge/stove/DW, divide by 12, x1.10, round up to 0.5 LF.

STEP 5 — SPECS: ${specs || 'Mark TBD'}

RETURN ONLY VALID JSON:
{"project_name":null,"gc_name":null,"address":null,"specs":{"cabinet_line":"TBD","door_style":"TBD","finish":"TBD","box_construction":"TBD","hardware":"TBD"},"unit_types":[{"unit_type_name":"Plan A1","unit_quantity":5,"is_amenity":false,"sheet_reference":"A410","skus":[{"sku":"W3042","description":"Wall 30x42","quantity_per_unit":1,"hinge_side":"L/R","location":"kitchen","notes":""}],"fillers":[{"sku":"WF330","description":"Wall filler 3x30","quantity_per_unit":1,"location":"kitchen wall end"}],"toe_kick_lf":8.5,"toe_kick_notes":"calc","total_cabinets_per_unit":0}],"flags":[],"extraction_confidence":"medium","extraction_notes":""}`
}

// ── IMAGE-BASED extraction (JPEGs/PNGs sent directly to Opus) ─────────────────
async function imageExtraction(imageFiles, specs, unitMatrix = null) {
  const matrixContext = unitMatrix?.length > 0
    ? `\nUNIT MATRIX (USE THESE EXACT NAMES AND QUANTITIES):\n` +
      unitMatrix.map(u => `  ${u.name}: ${u.quantity} units`).join('\n') + '\n'
    : ''

  // Batch images — max 20 per call to stay within limits
  const BATCH = 50
  let allResults = []

  for (let i = 0; i < imageFiles.length; i += BATCH) {
    const batch = imageFiles.slice(i, i + BATCH)
    const contentBlocks = []

    for (const file of batch) {
      const buf = Buffer.from(await file.arrayBuffer())
      const base64 = buf.toString('base64')
      const mediaType = file.type?.startsWith('image/') ? file.type : 'image/jpeg'
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } })
    }

    const batchLabel = imageFiles.length > BATCH
      ? `\nIMAGE BATCH ${Math.floor(i/BATCH)+1} of ${Math.ceil(imageFiles.length/BATCH)} (images ${i+1}-${Math.min(i+BATCH, imageFiles.length)} of ${imageFiles.length})\n`
      : ''

    const prompt = buildExtractionPrompt(specs, batchLabel, matrixContext)
    contentBlocks.push({ type: 'text', text: prompt })

    const res = await anthropic.messages.create({
      model: 'claude-opus-4-5', max_tokens: 8000,
      messages: [{ role: 'user', content: contentBlocks }]
    })

    const raw = res.content[0].text
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
    if (s !== -1 && e !== -1) {
      try {
        const parsed = safeParseJSON(raw.substring(s, e + 1), true)
        allResults.push(parsed)
      } catch (err) { console.error('Image batch parse error:', err.message) }
    }
  }

  if (allResults.length === 0) throw new Error('No data extracted from images')
  if (allResults.length === 1) return allResults[0]

  // Merge multiple batch results
  const merged = allResults[0]
  for (let i = 1; i < allResults.length; i++) {
    const batch = allResults[i]
    if (!batch.unit_types) continue
    batch.unit_types.forEach(newUt => {
      const existing = merged.unit_types?.find(u =>
        u.unit_type_name?.toLowerCase().replace(/\s+/g,'') === newUt.unit_type_name?.toLowerCase().replace(/\s+/g,'')
      )
      if (existing) {
        const existingSkus = existing.skus?.map(s => s.sku) || []
        existing.skus = [...(existing.skus||[]), ...(newUt.skus||[]).filter(s => !existingSkus.includes(s.sku))]
        const existingFillers = existing.fillers?.map(f => f.sku) || []
        existing.fillers = [...(existing.fillers||[]), ...(newUt.fillers||[]).filter(f => !existingFillers.includes(f.sku))]
        if (!existing.toe_kick_lf && newUt.toe_kick_lf) existing.toe_kick_lf = newUt.toe_kick_lf
      } else {
        merged.unit_types = [...(merged.unit_types||[]), newUt]
      }
    })
  }
  return merged
}

async function fullExtraction(pdfBytes, specs, pageManifest, unitMatrix = null) {
  const base64 = Buffer.from(pdfBytes).toString('base64')
  const context = pageManifest.length > 0
    ? '\nPAGE CONTEXT:\n' + pageManifest.map(p => `Page ${p.page}: ${p.type} — ${p.description}`).join('\n')
    : ''
  const matrixContext = unitMatrix?.length > 0
    ? `\nUNIT MATRIX (USE THESE EXACT NAMES AND QUANTITIES):\n` +
      unitMatrix.map(u => `  ${u.name}: ${u.quantity} units${u.sheet ? ` (Sheet ${u.sheet})` : ''}`).join('\n') + '\n'
    : ''

  const prompt = buildExtractionPrompt(specs, context, matrixContext)
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 8000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: prompt }
    ]}]
  })
  const raw = res.content[0].text
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
  return safeParseJSON(raw.substring(s, e + 1), true)
}

function isImageFile(file) {
  return file.type?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(file.name || '')
}

export async function POST(request) {
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    const formData = await request.formData()
    const jobId = formData.get('jobId')
    const specs = formData.get('specs') || ''
    const unitMatrixRaw = formData.get('unitMatrix')
    const unitMatrix = unitMatrixRaw ? JSON.parse(unitMatrixRaw) : null
    const files = formData.getAll('files')

    if (!files || files.length === 0) return Response.json({ error: 'No files uploaded' }, { status: 400 })

    // ── IMAGE PATH: all images → send directly to Opus ────────────────────
    const imageFiles = files.filter(f => isImageFile(f))
    const pdfFiles   = files.filter(f => !isImageFile(f))

    if (imageFiles.length > 0 && pdfFiles.length === 0) {
      console.log(`Image extraction: ${imageFiles.length} images → Opus`)
      const extractedData = await imageExtraction(imageFiles, specs, unitMatrix)
      if (extractedData.unit_types) {
        extractedData.unit_types = extractedData.unit_types.map(ut => ({
          ...ut,
          total_cabinets_per_unit:
            (ut.skus?.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0) || 0) +
            (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0),
        }))
      }
      if (jobId) {
        await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'System',
          action: `AI Takeoff (images): ${imageFiles.length} elevation images → ${extractedData.unit_types?.length || 0} unit types` })
      }
      return Response.json({
        success: true, data: stripAppliances(extractedData),
        processing: { total_pages: imageFiles.length, relevant_pages_found: imageFiles.length, pages_extracted: imageFiles.length, method: 'image_direct' },
        summary: { unit_type_count: extractedData.unit_types?.length || 0, total_units: extractedData.unit_types?.reduce((s, u) => s + (u.unit_quantity || 0), 0) || 0, confidence: extractedData.extraction_confidence },
      })
    }

    // ── PDF PATH: existing pipeline ───────────────────────────────────────
    let fullPdfBytes
    if (pdfFiles.length === 1) {
      fullPdfBytes = Buffer.from(await pdfFiles[0].arrayBuffer())
    } else {
      const merged = await PDFDocument.create()
      for (const f of pdfFiles) {
        const buf = Buffer.from(await f.arrayBuffer())
        const src = await PDFDocument.load(buf, { ignoreEncryption: true })
        const indices = Array.from({ length: src.getPageCount() }, (_, i) => i)
        const pages = await merged.copyPages(src, indices)
        pages.forEach(p => merged.addPage(p))
      }
      fullPdfBytes = await merged.save()
    }

    let srcDoc
    try { srcDoc = await PDFDocument.load(fullPdfBytes, { ignoreEncryption: true }) }
    catch (pdfErr) { return Response.json({ error: `Failed to parse PDF: ${pdfErr.message}` }, { status: 400 }) }
    const totalPages = srcDoc.getPageCount()
    console.log(`Smart pre-processor: ${totalPages} pages`)

    const chunks = []
    for (let s = 0; s < totalPages; s += CHUNK_SIZE) chunks.push({ start: s, end: Math.min(s + CHUNK_SIZE - 1, totalPages - 1) })

    const allRelevantPages = []
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(async ({ start, end }) => {
        try {
          const chunkBytes = await extractPageRange(fullPdfBytes, start, end)
          const results = await scanChunk(chunkBytes, start, end - start + 1)
          results.forEach(r => allRelevantPages.push({ ...r, pageIndex: r.page - 1 }))
        } catch (err) { console.error(`Chunk ${start}-${end} error:`, err.message) }
      }))
      if (i + BATCH_SIZE < chunks.length) await new Promise(resolve => setTimeout(resolve, 2000))
    }

    console.log(`Scan complete: ${allRelevantPages.length} relevant pages found`)

    if (allRelevantPages.length === 0 && totalPages <= MAX_EXTRACT_PAGES) {
      const extractedData = await fullExtraction(fullPdfBytes, specs, [], unitMatrix)
      if (extractedData.unit_types) {
        extractedData.unit_types = extractedData.unit_types.map(ut => ({
          ...ut,
          total_cabinets_per_unit: (ut.skus?.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0) || 0) + (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0),
        }))
      }
      return Response.json({ success: true, data: stripAppliances(extractedData),
        processing: { total_pages: totalPages, relevant_pages_found: totalPages, pages_extracted: totalPages, method: 'full_small_document' },
        summary: { unit_type_count: extractedData.unit_types?.length || 0, total_units: extractedData.unit_types?.reduce((s, u) => s + (u.unit_quantity || 0), 0) || 0, confidence: extractedData.extraction_confidence },
      })
    }

    if (allRelevantPages.length === 0) return Response.json({ error: 'No relevant cabinet pages found.' }, { status: 422 })

    const uniqueIndices = [...new Set(allRelevantPages.map(p => p.pageIndex))].sort((a, b) => a - b)
    let finalIndices = uniqueIndices
    if (uniqueIndices.length > MAX_EXTRACT_PAGES) {
      const priority = ['unit_schedule', 'sheet_index', 'finish_schedule', 'kitchen_elevation', 'bathroom_elevation', 'amenity', 'floor_plan']
      const sorted = [...allRelevantPages].sort((a, b) => priority.indexOf(a.type) - priority.indexOf(b.type))
      finalIndices = [...new Set(sorted.slice(0, MAX_EXTRACT_PAGES).map(p => p.pageIndex))].sort((a, b) => a - b)
    }

    const extracted = await extractSpecificPages(fullPdfBytes, finalIndices)
    if (!extracted) return Response.json({ error: 'Failed to extract pages' }, { status: 500 })

    const pageManifest = finalIndices.map(idx => {
      const found = allRelevantPages.find(p => p.pageIndex === idx)
      return { page: idx + 1, type: found?.type || 'unknown', description: found?.description || '' }
    })

    console.log(`Sending ${finalIndices.length} pages to Opus`)
    const extractedData = await fullExtraction(extracted.bytes, specs, pageManifest, unitMatrix)

    if (extractedData.unit_types) {
      extractedData.unit_types = extractedData.unit_types.map(ut => ({
        ...ut,
        total_cabinets_per_unit: (ut.skus?.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0) || 0) + (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0),
      }))
    }

    if (jobId) {
      await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'System',
        action: `AI Takeoff: scanned ${totalPages} pages → ${allRelevantPages.length} relevant → ${finalIndices.length} extracted → ${extractedData.unit_types?.length || 0} unit types` })
    }

    return Response.json({ success: true, data: extractedData,
      processing: { total_pages: totalPages, relevant_pages_found: allRelevantPages.length, pages_extracted: finalIndices.length, method: 'smart_preprocessor', page_manifest: pageManifest },
      summary: { unit_type_count: extractedData.unit_types?.length || 0, total_units: extractedData.unit_types?.reduce((s, u) => s + (u.unit_quantity || 0), 0) || 0, confidence: extractedData.extraction_confidence },
    })
  } catch (error) {
    console.error('Takeoff error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}
