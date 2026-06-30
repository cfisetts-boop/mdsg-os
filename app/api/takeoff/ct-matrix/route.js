/**
 * POST /api/takeoff/ct-matrix
 * Accepts one or more PDFs and/or images of a unit schedule.
 * Merges all PDFs into one document, processes images individually,
 * then sends everything to Claude to enumerate every row.
 * Code does the counting — reliable for 100+ units.
 */
import Anthropic from '@anthropic-ai/sdk'
import { PDFDocument } from 'pdf-lib'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function safeParseJSON(raw) {
  if (!raw) return null
  const c = raw.trim().replace(/^```[a-z]*\n?/gm,'').replace(/^```\n?/gm,'').trim()
  try { return JSON.parse(c) } catch(_) {}
  const fa = c.indexOf('['), la = c.lastIndexOf(']')
  if (fa !== -1 && la > fa) try { return JSON.parse(c.substring(fa, la+1)) } catch(_) {}
  return null
}

function stripLevel(name) {
  return (name || '')
    .replace(/\s*(LEVEL|FLOOR|FL|LVL|L)\s*\d+\s*$/i, '')
    .replace(/\s*-\s*$/, '')
    .trim()
}

const ROW_PROMPT = `This is a unit schedule table. Each row is ONE individual apartment unit with its type name and floor/level.

READ EVERY SINGLE ROW from top to bottom, left to right — including ALL sections, levels, and columns across every page/image provided.

Return a JSON array with one string entry PER ROW — just the unit type name, strip the floor/level column.

Rules:
- "UNIT 1A  LEVEL 1" → "UNIT 1A"
- "UNIT 2G - TYPE A  LEVEL 3" → "UNIT 2G - TYPE A"
- Keep variants like "UNIT 4A - TYPE A" separate from "UNIT 4A"
- "UNIT 3B - TYPE A" is a separate type from "UNIT 3B"
- If a type appears 18 times across all floors, include it 18 times in the array
- Do NOT group, do NOT count, do NOT deduplicate — one entry per physical row
- Read ALL pages/sections/images provided

Return ONLY the JSON array, nothing else:
["UNIT 1A","UNIT 2B","UNIT 1B","UNIT 1A","UNIT 2A",...]`

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files    = formData.getAll('files')   // multiple files
    if (!files.length) return Response.json({ error: 'No files uploaded' }, { status: 400 })

    // ── Separate PDFs from images ────────────────────────────────────────
    const pdfBuffers   = []
    const imageBlocks  = []

    for (const file of files) {
      const buffer   = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || 'application/octet-stream'
      const fileName = (file.name || '').toLowerCase()
      const isImage  = mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/.test(fileName)
      const isPDF    = mimeType === 'application/pdf' || fileName.endsWith('.pdf')

      if (isImage) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType.startsWith('image/') ? mimeType : 'image/jpeg',
            data: buffer.toString('base64'),
          },
        })
      } else if (isPDF) {
        pdfBuffers.push(buffer)
      }
    }

    if (!pdfBuffers.length && !imageBlocks.length) {
      return Response.json({ error: 'No supported files found. Upload PDF or image (JPEG/PNG).' }, { status: 400 })
    }

    // ── Merge all PDFs into one document ─────────────────────────────────
    const contentBlocks = [...imageBlocks]

    if (pdfBuffers.length > 0) {
      const merged = await PDFDocument.create()
      for (const buf of pdfBuffers) {
        try {
          const src   = await PDFDocument.load(buf, { ignoreEncryption: true })
          const pages = await merged.copyPages(src, src.getPageIndices())
          pages.forEach(p => merged.addPage(p))
        } catch (_) {}
      }
      const mergedBuf = Buffer.from(await merged.save())
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: mergedBuf.toString('base64') },
      })
    }

    console.log(`CT matrix: ${pdfBuffers.length} PDFs + ${imageBlocks.length} images`)

    // ── Single Claude call: enumerate every row ──────────────────────────
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [...contentBlocks, { type: 'text', text: ROW_PROMPT }],
      }],
    })

    const rows = safeParseJSON(res.content[0].text)
    if (!Array.isArray(rows) || !rows.length) {
      return Response.json({
        error: 'Could not read rows. Make sure the files show a unit schedule table with type names and floor/level columns.',
      }, { status: 422 })
    }

    // ── Code counts — 100% reliable ───────────────────────────────────────
    const countMap = new Map()
    for (const rawName of rows) {
      if (typeof rawName !== 'string') continue
      const name = stripLevel(rawName.trim())
      if (!name) continue
      const key = name.toUpperCase()
      if (!countMap.has(key)) countMap.set(key, { name, count: 0 })
      countMap.get(key).count++
    }

    const units = Array.from(countMap.values())
      .filter(u => u.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(u => ({ name: u.name, quantity: u.count }))

    const total = units.reduce((s, u) => s + u.quantity, 0)
    console.log(`CT matrix result: ${rows.length} rows read → ${units.length} types, ${total} total units`)

    return Response.json({ success: true, units, total, rows_read: rows.length })
  } catch (err) {
    console.error('CT matrix extraction error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
