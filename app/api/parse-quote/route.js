import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
    const jobId = request.headers.get('x-job-id')
    const fileName = request.headers.get('x-file-name') || 'quote.pdf'
    const isExcel = /\.(xlsx|xlsm)$/i.test(fileName)
    const pdfBuffer = await request.arrayBuffer()
    if (!pdfBuffer || pdfBuffer.byteLength === 0) {
      return Response.json({ error: 'No PDF data received' }, { status: 400 })
    }
    // ── Deterministic NexGen branch: known container-pricing layout ──────────
    if (isExcel) {
      try {
        const wbN = new ExcelJS.Workbook()
        await wbN.xlsx.load(Buffer.from(pdfBuffer))
        const val = (ws, r, cx) => { const v = ws.getCell(r, cx).value; if (v == null) return ''; if (typeof v === 'object') return v.result ?? v.text ?? ''; return v }
        const num = (x) => { const n = parseFloat(String(x).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n }
        let items = [], seaFreight = 0, landFreight = 0, tariff = 0, isNexGen = false
        wbN.eachSheet(ws => {
          if (items.length) return
          let hr = 0, colSku = 0, colPcs = 0, colTotal = 0
          for (let r = 1; r <= Math.min(ws.rowCount, 25) && !hr; r++) {
            for (let cx = 1; cx <= Math.min(ws.columnCount, 22); cx++) {
              if (String(val(ws, r, cx)).toUpperCase().includes('NEXGEN')) { hr = r; colSku = cx; isNexGen = true }
            }
          }
          if (!hr) return
          for (let cx = 1; cx <= Math.min(ws.columnCount, 24); cx++) {
            const hh = (String(val(ws, hr, cx)) + ' ' + String(val(ws, hr + 1, cx))).replace(/\s+/g, ' ').toUpperCase()
            if (hh.includes('PCS')) colPcs = cx
            if (!colTotal && (hh.includes('TOTAL AMOUNT') || (hh.includes('TOTAL') && hh.includes('USD')))) colTotal = cx
          }
          if (!colPcs) colPcs = colSku + 5
          if (!colTotal) colTotal = colPcs + 2
          for (let r = hr + 1; r <= ws.rowCount; r++) {
            const sku = String(val(ws, r, colSku)).trim()
            const pcs = num(val(ws, r, colPcs))
            const ext = num(val(ws, r, colTotal))
            if (sku && sku !== '-' && pcs > 0 && ext > 0) items.push([sku.toUpperCase(), pcs, Math.round(ext * 100) / 100])
          }
          for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
            let rowText = []
            for (let cx = 1; cx <= Math.min(ws.columnCount, 24); cx++) rowText.push(String(val(ws, r, cx)))
            const joined = rowText.join(' ').toUpperCase()
            const rowMax = Math.max(0, ...rowText.map(num))
            if (joined.includes('SEA FREIGHT')) seaFreight = rowMax
            else if (joined.includes('LAND FREIGHT')) landFreight = rowMax
            else if (joined.includes('TARRIF') || joined.includes('TARIFF')) tariff = rowMax
          }
        })
        if (isNexGen && items.length) {
          const gross = Math.round(items.reduce((s, [, , e]) => s + e, 0) * 100) / 100
          const freightTotal = Math.round((seaFreight + landFreight) * 100) / 100
          const grand = Math.round((gross + freightTotal + tariff) * 100) / 100
          const totalPieces = items.reduce((s, [, q]) => s + q, 0)
          const quoteShape = { manufacturer: 'NexGen', quote_number: '', totals: { gross_amount: gross, freight_amount: freightTotal, tax_amount: tariff, grand_total: grand }, unit_types: [{ unit_type_name: 'ALL UNITS', unit_quantity: 1, line_items: items }] }
          let histErrN = null
          if (jobId) {
            const ins = await supabase.from('manufacturer_quotes').insert({
              job_id: jobId, manufacturer: 'NexGen', quote_type: 'cabinets', raw_extracted_json: quoteShape,
              gross_amount: gross, freight_amount: freightTotal, tax_amount: tariff, grand_total: grand,
              total_cabinets: totalPieces, file_name: fileName, parsed_at: new Date().toISOString(),
            })
            histErrN = ins.error
            if (histErrN) console.error('NexGen quote insert FAILED:', histErrN.message)
            await supabase.from('jobs').update({ manufacturer_gross_cost: gross }).eq('id', jobId)
            await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'MDSG', action: `NexGen quote parsed — ${items.length} SKUs · ${totalPieces.toLocaleString()} pcs · $${grand.toLocaleString()}` })
          }
          return Response.json({
            success: true, quote_recorded: !histErrN, quote_record_error: histErrN?.message || null,
            summary: { manufacturer: 'NexGen', unit_type_count: items.length, total_cabinets: totalPieces, grand_total: grand },
          })
        }
      } catch (e) { console.error('NexGen deterministic parse skipped:', e.message) }
    }

    let docBlock
    if (isExcel) {
      // Excel quote: flatten every sheet to text and let Opus read that —
      // works for any manufacturer's spreadsheet layout without assumptions.
      const ExcelJS = (await import('exceljs')).default
      const wbIn = new ExcelJS.Workbook()
      await wbIn.xlsx.load(Buffer.from(pdfBuffer))
      let text = ''
      wbIn.worksheets.forEach(ws => {
        text += `\n=== SHEET: ${ws.name} ===\n`
        ws.eachRow((row, n) => {
          const cells = []
          row.eachCell({ includeEmpty: false }, cell => {
            const v = cell.value
            cells.push(typeof v === 'object' && v?.result !== undefined ? v.result : v)
          })
          if (cells.length) text += cells.join(' | ') + '\n'
        })
      })
      if (text.length > 150000) text = text.substring(0, 150000) + '\n[TRUNCATED]'
      docBlock = { type: 'text', text: `MANUFACTURER QUOTE SPREADSHEET CONTENT:\n${text}` }
    } else {
      const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
      docBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }
    }
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-5',
      max_tokens: 30000,
      messages: [{
        role: 'user',
        content: [
          docBlock,
          { type: 'text', text: `Parse this cabinet manufacturer quote PDF and return ONLY a JSON object, no markdown, no explanation. Use this structure:
CRITICAL: include EVERY unit type section — do not stop early; merge sections that continue across pages. Keep line items COMPACT: each is a 3-element array [sku, qty, extendedPrice]. Use exact SKU text including commas/suffixes (e.g. "HCB12R,AD21"). gross_price is the PER-UNIT gross for that unit type.
{"manufacturer":"Leedo","quote_number":"","rep_name":"","quote_date":null,"expiry_date":null,"project_name":"","totals":{"gross_amount":0,"freight_amount":0,"tax_amount":0,"grand_total":0,"freight_load_count":0},"unit_types":[{"unit_type_name":"","unit_quantity":1,"cabinet_count":0,"total_cubes":0,"gross_price":0,"line_items":[["B18L",1,111.01]]}]}` }
        ]
      }]
    })
    const extraction = await stream.finalMessage()
    const rawText = extraction.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    let parsedQuote
    try {
      const firstBrace = rawText.indexOf('{')
      const lastBrace = rawText.lastIndexOf('}')
      parsedQuote = JSON.parse(rawText.substring(firstBrace, lastBrace + 1))
    } catch (e) {
console.log('RAW CLAUDE RESPONSE:', rawText.substring(0, 1000))
      return Response.json({ error: 'Could not parse AI response', raw: rawText.substring(0, 500) }, { status: 422 })
    }
    if (jobId) {
      const { error: histErr } = await supabase.from('manufacturer_quotes').insert({
        job_id: jobId, manufacturer: parsedQuote.manufacturer,
        quote_number: parsedQuote.quote_number, rep_name: parsedQuote.rep_name,
        quote_date: parsedQuote.quote_date || null, expiry_date: parsedQuote.expiry_date || null,
        raw_extracted_json: parsedQuote,
        gross_amount: parsedQuote.totals?.gross_amount || 0,
        freight_amount: parsedQuote.totals?.freight_amount || 0,
        grand_total: parsedQuote.totals?.grand_total || 0,
        total_units: parsedQuote.unit_types?.reduce((s,u)=>s+(u.unit_quantity||0),0)||0,
        total_cabinets: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        file_name: fileName, parsed_at: new Date().toISOString(),
      })
      if (histErr) console.error('Quote history insert FAILED:', histErr.message)
      // ── UPSERT unit types: match existing rows (from the takeoff save) by
      //    normalized name and add pricing to them; only INSERT rows that
      //    don't exist yet. Never blind-append — that created duplicate rows.
      const norm = (s) => (s || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      const { data: existingUts } = await supabase.from('unit_types').select('id, unit_type_name').eq('job_id', jobId)
      const existingByName = {}
      ;(existingUts || []).forEach(row => { existingByName[norm(row.unit_type_name)] = row })

      for (let i = 0; i < (parsedQuote.unit_types||[]).length; i++) {
        const ut = parsedQuote.unit_types[i]
        const match = existingByName[norm(ut.unit_type_name)]
        let utId = null
        if (match) {
          // Existing takeoff row — attach pricing, keep the takeoff's cabinet data
          await supabase.from('unit_types').update({
            manufacturer_price: ut.gross_price || 0,
            total_cubes: ut.total_cubes || 0,
          }).eq('id', match.id)
          utId = match.id
          // Replace this unit's mfr line items so re-uploads don't stack
          await supabase.from('cabinet_line_items').delete().eq('unit_type_id', match.id)
        } else {
          const { data: utData } = await supabase.from('unit_types').insert({
            job_id: jobId, unit_type_name: ut.unit_type_name,
            unit_quantity: ut.unit_quantity||1, cabinet_count: ut.cabinet_count||0,
            total_cubes: ut.total_cubes||0, manufacturer_price: ut.gross_price||0, sort_order: 100 + i,
          }).select().single()
          utId = utData?.id || null
        }
        if (utId && ut.line_items?.length > 0) {
          await supabase.from('cabinet_line_items').insert(
            ut.line_items.map((item, j) => {
              const isArr = Array.isArray(item)  // compact triplet [sku, qty, ext]
              return {
                unit_type_id: utId, job_id: jobId,
                sku:            isArr ? String(item[0] || '') : item.sku,
                description:    isArr ? '' : (item.description || ''),
                door_style:     isArr ? '' : (item.door_style || ''),
                finish:         isArr ? '' : (item.finish || ''),
                hinge_side:     isArr ? '' : (item.hinge_side || ''),
                quantity:       isArr ? (Number(item[1]) || 1) : (item.quantity || 1),
                extended_price: isArr ? (Number(item[2]) || 0) : (item.extended_price || 0),
                sort_order: j,
              }
            })
          )
        }
      }
      await supabase.from('jobs').update({
        manufacturer: parsedQuote.manufacturer,
        manufacturer_quote_number: parsedQuote.quote_number,
        manufacturer_rep: parsedQuote.rep_name,
        manufacturer_gross_cost: parsedQuote.totals?.gross_amount||0,
        freight_cost: parsedQuote.totals?.freight_amount||0,
        total_cabinet_count: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        unit_type_count: parsedQuote.unit_types?.length||0,
      }).eq('id', jobId)
      await supabase.from('activity_log').insert({
        job_id: jobId, user_name: 'System',
        action: `Quote parsed — ${parsedQuote.manufacturer} #${parsedQuote.quote_number} · $${parsedQuote.totals?.grand_total?.toLocaleString()} grand total`,
      })
    }
    return Response.json({
      success: true,
      quote_recorded: typeof histErr === 'undefined' ? null : !histErr,
      quote_record_error: typeof histErr === 'undefined' ? null : (histErr?.message || null), parsed: parsedQuote,
      summary: {
        manufacturer: parsedQuote.manufacturer,
        quote_number: parsedQuote.quote_number,
        unit_type_count: parsedQuote.unit_types?.length||0,
        total_cabinets: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        grand_total: parsedQuote.totals?.grand_total||0,
      },
    })
  } catch (error) {
    console.error('Parse quote error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}
