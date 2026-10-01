import { createClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, PageSizes, rgb } from 'pdf-lib'
import { readFileSync } from 'fs'
import { join } from 'path'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SENDERS = {
  Cole: { name: 'Cole Isetts',   title: 'Sales Representative', phone: '651-301-1068', email: 'cole@mdsgcabinets.com' },
  Pam:  { name: 'Pamela Isetts', title: 'President',            phone: '651-301-1063', email: 'pam@mdsgcabinets.com' },
  MDSG: { name: 'MDSG Team',     title: 'Manufacturer Direct Sales Group', phone: '', email: 'csr@mdsgcabinets.com' },
}

// ─── Greenworks-style bordered grid proposal ─────────────────────────────────
export async function POST(request) {
  try {
    const {
      jobId, totals = {}, propConfig = {}, sender = 'Cole', bidSections = {},
      marginPct = 20, grossCostOverride = 0, notes = '', brandAs = 'mdsg',
      ctLocalMaterial = null, ctLocalInstall = null, ctImportMaterial = null, ctImportInstall = null,
    } = await request.json()

    let job = null
    if (jobId) {
      const { data } = await supabase.from('jobs').select('*').eq('id', jobId).single()
      job = data
    }

    const SEC = {
      includedInBid: bidSections.includedInBid ?? 'Sales Tax  |  Delivery to Job Site  |  Sink cutouts per sink specifications',
      notIncluded: bidSections.notIncluded ?? 'Material Storage',
      generalNotes: bidSections.generalNotes ?? '- Installation:\n- Davis Bacon Wages are NOT Included\n- OCIP/CCIP Insurance NOT Included\n- Backing of any kind is NOT Included',
      bottomNotes: bidSections.bottomNotes ?? 'Final Price subject to Approved Shop Drawings',
    }

    // ── Pricing ─────────────────────────────────────────────────────────────
    const num = (v) => Number(v) > 0 ? Number(v) : 0
    const locMat = num(ctLocalMaterial), locIns = num(ctLocalInstall)
    const impMat = num(ctImportMaterial), impIns = num(ctImportInstall)
    const manualMode = locMat > 0 || impMat > 0
    const cost = Number(grossCostOverride) || 0
    const margin = Math.min(Math.max(Number(marginPct) || 0, 0), 60)
    const sell = cost > 0 ? Math.round((cost / (1 - margin / 100)) * 100) / 100 : 0
    if (!manualMode && !sell) return Response.json({ error: 'No countertop pricing — fill in the pricing lines first' }, { status: 422 })
    const headline = manualMode ? ((locMat + locIns) || (impMat + impIns)) : sell

    const isGW = brandAs === 'greenworks'
    const today = new Date()
    const fmtMoney = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const dateStr = `${today.getMonth()+1}/${today.getDate()}/${today.getFullYear()}`
    const proposalNum = `${isGW ? 'GW' : 'MDSG'}-CT-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}${job ? '-' + (job.name || 'JOB').substring(0,3).toUpperCase() : ''}`

    const pdfDoc  = await PDFDocument.create()
    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const boldIt  = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique)
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
    let logo = null
    try {
      if (isGW) logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'greenworks-logo.png')))
      else {
        try { logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo-square.png'))) }
        catch { logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png'))) }
      }
    } catch {}

    const sage   = rgb(0.56, 0.68, 0.55)     // Greenworks band green
    const black  = rgb(0, 0, 0)
    const white  = rgb(1, 1, 1)
    const blue   = rgb(0.05, 0.3, 0.6)

    const page = pdfDoc.addPage(PageSizes.Letter)
    const ML = 30, MR = 582, W = MR - ML      // full grid width 552
    const line = (x1, y1, x2, y2, t = 0.75) => page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:t, color:black })
    const box  = (x, y, w, h, fill = null, t = 0.75) => {
      if (fill) page.drawRectangle({ x, y, width:w, height:h, color:fill })
      page.drawRectangle({ x, y, width:w, height:h, borderColor:black, borderWidth:t })
    }
    const txt = (t, x, y, o = {}) => { if (t == null || t === '') return
      const f = o.boldIt ? boldIt : (o.bold ? bold : regular)
      page.drawText(String(t), { x, y, size:o.size||7.5, font:f, color:o.color||black, maxWidth:o.maxWidth }) }
    const ctr = (t, x, w, y, o = {}) => { const f = o.boldIt ? boldIt : (o.bold ? bold : regular)
      const tw = f.widthOfTextAtSize(String(t), o.size||7.5); txt(t, x + (w - tw)/2, y, o) }
    const rgt = (t, rx, y, o = {}) => { const f = o.boldIt ? boldIt : (o.bold ? bold : regular)
      const tw = f.widthOfTextAtSize(String(t), o.size||7.5); txt(t, rx - tw - 4, y, o) }

    // ═ Title band ═
    let y = 768
    box(ML, y - 20, W, 20, sage, 1.25)
    ctr(isGW ? 'GREENWORKS RENOVATIONS, LLC' : 'MANUFACTURER DIRECT SALES GROUP, LLC', ML, W, y - 14, { bold:true, size:12 })
    y -= 20

    // ═ Date strip (right) ═
    box(MR - 150, y - 12, 150, 12)
    txt('Date:', MR - 146, y - 9, { bold:true, size:6.5 })
    rgt(dateStr, MR, y - 9, { bold:true, size:6.5 })
    y -= 12

    // ═ Header grid: CONTACT (left) | title+logo (center) | CUSTOMER (right) ═
    const L1 = ML, L1W = 196, C1 = ML + L1W, C1W = 160, R1 = C1 + C1W, R1W = W - L1W - C1W
    const hTop = y, hBot = y - 92
    const si = isGW
      ? { name: 'Anthony (Willy) Ramirez', phone: '619/718-1578', email: 'greenworksrenovationsllc@gmail.com', addr1: '5328 S. Jebel Way', addr2: 'Centennial, CO  80015' }
      : { ...(SENDERS[sender] || SENDERS.Cole), addr1: '23463 E. Moraine Place', addr2: 'Aurora, CO  80016' }

    // left CONTACT block rows
    const lrow = (label, value, ry, lw = 58) => {
      box(L1, ry - 11, lw, 11); box(L1 + lw, ry - 11, L1W - lw, 11)
      txt(label, L1 + 2, ry - 8, { bold:true, size:6 }); txt(value, L1 + lw + 2, ry - 8, { size:6.5, maxWidth: L1W - lw - 4 })
    }
    box(L1, hTop - 11, L1W, 11); txt('CONTACT:', L1 + 2, hTop - 8, { bold:true, size:6.5 })
    box(L1, hTop - 22, L1W, 11); txt(si.name, L1 + 2, hTop - 19, { bold:true, size:7.5 })
    lrow('TELEPHONE:', si.phone, hTop - 33)
    lrow('EMAIL:', si.email, hTop - 44)
    lrow('ADDRESS:', si.addr1, hTop - 55)
    box(L1, hTop - 77, 58, 11); box(L1 + 58, hTop - 77, L1W - 58, 11)
    txt(si.addr2, L1 + 60, hTop - 74, { size:6.5 })
    box(L1, hBot, L1W, hTop - 77 - hBot)

    // center title + logo
    box(C1, hTop - 14, C1W, 14)
    ctr('COUNTERTOP MATERIALS & INSTALLATION', C1, C1W, hTop - 10, { bold:true, size:6.8 })
    box(C1, hBot, C1W, hTop - 14 - hBot)
    if (logo) { const d = logo.scaleToFit(C1W - 12, hTop - 14 - hBot - 8); page.drawImage(logo, { x: C1 + (C1W - d.width)/2, y: hBot + ((hTop - 14 - hBot) - d.height)/2, width: d.width, height: d.height }) }

    // right CUSTOMER block rows
    const rrow = (label, value, ry, o = {}) => {
      box(R1, ry - 11, 68, 11); box(R1 + 68, ry - 11, R1W - 68, 11)
      rgt(label, R1 + 68, ry - 8, { bold:true, size:6 }); txt(value, R1 + 70, ry - 8, { bold: o.bold, size:6.5, color: o.color, maxWidth: R1W - 72 })
    }
    const addr = job ? [job.address].filter(Boolean).join('') : ''
    const csz  = job ? [job.city, job.state].filter(Boolean).join(', ') + (job.zip ? '  ' + job.zip : '') : ''
    rrow('CUSTOMER:', (job?.gc_name || '—').toUpperCase(), hTop, { bold:true })
    rrow('PROJECT:', (job?.name || '').toUpperCase(), hTop - 11, { bold:true })
    rrow('ADDRESS:', addr, hTop - 22, { bold:true })
    rrow('CITY/STATE/ZIP', csz, hTop - 33, { bold:true })
    rrow('CONTACT:', job?.gc_contact || '', hTop - 44, { bold:true })
    rrow('TELEPHONE:', job?.gc_phone || '', hTop - 55, { bold:true })
    rrow('EMAIL:', job?.gc_email || '', hTop - 66, { color: blue })
    box(R1, hBot, R1W, hTop - 66 - hBot)
    y = hBot

    // ═ DESCRIPTION band ═
    box(ML, y - 12, W, 12)
    ctr('DESCRIPTION', ML, W, y - 9, { bold:true, size:7.5 })
    y -= 12

    // ═ CABINET LINE band ═
    box(ML, y - 12, W, 12, sage)
    txt('CABINET LINE: ', ML + 2, y - 9, { bold:true, size:7.5 })
    txt(propConfig.cabinetLine || job?.manufacturer || '', ML + 70, y - 9, { bold:true, size:7.5 })
    y -= 12

    // ═ SPEC rows: left spec | right units/amenities ═
    const SL = 108, SV = 230, RU = ML + SL + SV, RUW = 120, RVW = W - SL - SV - RUW
    const specRow = (label, value, rLabel, rValue, rBold = true) => {
      box(ML, y - 12, SL, 12); box(ML + SL, y - 12, SV, 12)
      txt(label, ML + 2, y - 9, { bold:true, size:7 }); txt(value, ML + SL + 2, y - 9, { size:7, maxWidth: SV - 4 })
      box(RU, y - 12, RUW, 12); box(RU + RUW, y - 12, RVW, 12)
      txt(rLabel, RU + 2, y - 9, { bold:true, size:7 })
      if (rValue) ctr(rValue, RU + RUW, RVW, y - 9, { bold: rBold, size:7 })
      y -= 12
    }
    const units = job?.units_override ?? propConfig.units ?? ''
    const amenLines = String(propConfig.amenities || job?.amenities_text || '').split(/\n|,/).map(s => s.trim()).filter(Boolean)
    specRow('SPECIFICATIONS:', '', 'NO. OF UNITS:', units !== '' ? String(units) : '—')
    specRow('MATERIAL SPEC:', propConfig.material || '', 'AMENITIES:', amenLines[0] || '—')
    specRow('COLOR:', propConfig.color || job?.finish_color || '', '', amenLines[1] || '')
    if (amenLines[2]) specRow('', '', '', amenLines[2])

    // ═ BASE PRICE blocks ═
    const priceBlock = (rowLabel, mat, ins) => {
      box(ML, y - 12, W - 84, 12, sage); box(MR - 84, y - 12, 84, 12, sage)
      txt('BASE PRICE:', ML + 2, y - 9, { bold:true, size:7.5 })
      ctr('TOTAL COST', MR - 84, 84, y - 9, { bold:true, size:7 })
      y -= 12
      box(ML, y - 12, W - 84, 12); box(MR - 84, y - 12, 84, 12)
      txt(rowLabel, ML + 2, y - 9, { bold:true, size:7 })
      rgt(fmtMoney(mat), MR, y - 9, { bold:true, size:7 })
      y -= 12
      if (ins > 0) {
        box(ML, y - 12, W - 84, 12); box(MR - 84, y - 12, 84, 12)
        rgt('INSTALLATION', MR - 84, y - 9, { size:7 })
        rgt(fmtMoney(ins), MR, y - 9, { bold:true, size:7 })
        y -= 12
      }
      box(ML, y - 12, W - 84, 12); box(MR - 84, y - 12, 84, 12)
      rgt('TOTAL', MR - 84, y - 9, { bold:true, size:7 })
      rgt(fmtMoney(mat + ins), MR, y - 9, { bold:true, size:7.5 })
      y -= 12
    }
    if (manualMode) {
      if (locMat > 0) priceBlock('LOCAL FABRICATOR - MATERIAL', locMat, locIns)
      if (impMat > 0) priceBlock('IMPORT MATERIAL to MATCH MATERIAL SPEC ABOVE', impMat, impIns)
    } else {
      priceBlock('COUNTERTOP MATERIAL, FABRICATION & DELIVERY', sell, 0)
    }

    // ═ INCLUDED / NOT INCLUDED ═
    const half = W - 170
    const bandRows = (title, items) => {
      box(ML, y - 12, half, 12, sage); box(ML + half, y - 12, W - half, 12)
      txt(title, ML + 2, y - 9, { bold:true, size:7.5 })
      y -= 12
      for (const it of items) {
        box(ML, y - 11, half, 11); box(ML + half, y - 11, W - half, 11)
        txt(it, ML + 8, y - 8, { size:7 })
        y -= 11
      }
    }
    bandRows('INCLUDED IN BID:', SEC.includedInBid.split(/\||\n/).map(s => s.trim()).filter(Boolean))
    bandRows('NOT INCLUDED IN BID:', SEC.notIncluded.split(/\||\n/).map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase()))

    // ═ NOTES (General) box ═
    const gLines = (SEC.generalNotes + (notes && notes.trim() ? '\n' + notes.trim() : '') + (!isGW ? '\n- Installation by Greenworks Renovations under separate contract — Willy Ramirez 619-718-1578' : '')).split('\n').filter(Boolean)
    const gH = 12 + gLines.length * 10 + 6
    box(ML, y - gH, half, gH); box(ML + half, y - gH, W - half, gH)
    txt('NOTES (General):', ML + 2, y - 10, { bold:true, size:7 })
    let gy = y - 20
    for (const gl of gLines) { txt(gl, ML + 4, gy, { bold:true, size:6.8, maxWidth: half - 8 }); gy -= 10 }
    y -= gH

    // ═ NOTES band (shop drawings) ═
    y -= 6
    box(ML, y - 16, W - 160, 16, sage); box(MR - 160, y - 16, 160, 16)
    txt('NOTES:', ML + 3, y - 11, { boldIt:true, size:8 })
    txt(SEC.bottomNotes, ML + 40, y - 11, { bold:true, size:7.5, maxWidth: W - 210 })
    y -= 16

    // ═ Thank-you + signature cell ═
    const tH = 34
    box(ML, y - tH, half, tH); box(ML + half, y - tH, W - half, tH)
    txt('**Thank you for the opportunity to submit our proposal.**', ML + 2, y - 9, { size:6 })
    txt('Unit pricing will be honored for 90 days from the date of proposal.', ML + 2, y - 17, { size:6 })
    txt('All quantities are estimated, final field measurements and approved Shop Drawings will prevail.', ML + 2, y - 25, { size:6 })
    line(ML + half + 10, y - tH + 10, MR - 10, y - tH + 10, 0.5)
    ctr('Customer Signature & Date', ML + half, W - half, y - tH + 3, { size:6.5 })
    y -= tH

    // ═ Corporate footer bands ═
    box(ML, y - 16, W, 16, sage, 1.25)
    ctr(isGW ? 'CORPORATE OFFICES: 5328 S. Jebel Way, Centennial, CO  80015'
             : 'CORPORATE OFFICES: 23463 E. Moraine Place, Aurora, CO  80016', ML, W, y - 11, { bold:true, size:9 })
    y -= 16
    box(ML, y - 12, W, 12)
    ctr(isGW ? 'CONTACT: Anthony (Willy) Ramirez, President; Telephone: 619.718-1578; email: greenworksrenovationsllc@gmail.com'
             : `CONTACT: Pamela Isetts, President; Telephone: 651.301-1063; email: pam@mdsgcabinets.com`, ML, W, y - 9, { bold:true, size:7 })
    y -= 12
    // outer frame
    page.drawRectangle({ x: ML - 2, y: y - 2, width: W + 4, height: 770 - y, borderColor: black, borderWidth: 1.5 })

    const bytes = await pdfDoc.save()
    if (jobId) {
      if (manualMode) await supabase.from('jobs').update({
        ct_local_material: locMat || null, ct_local_install: locIns || null,
        ct_import_material: impMat || null, ct_import_install: impIns || null,
      }).eq('id', jobId)
      const who = isGW ? 'Greenworks' : (SENDERS[sender] || SENDERS.Cole).name
      await supabase.from('activity_log').insert({ job_id: jobId, user_name: who, action: `CT proposal generated — ${proposalNum} · ${fmtMoney(headline)}${isGW ? ' · Greenworks-branded' : ''}` })
    }
    return new Response(Buffer.from(bytes), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${proposalNum}.pdf"` },
    })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
