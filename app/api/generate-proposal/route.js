import { createClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib'
import { readFileSync } from 'fs'
import { join } from 'path'

const SENDERS = {
  Cole:  { name: 'Cole Isetts',   title: 'Sales Representative', phone: '651-301-1068', email: 'cole@mdsgcabinets.com' },
  Pam:   { name: 'Pamela Isetts', title: 'President',            phone: '651-301-1063', email: 'pam@mdsgcabinets.com' },
  Blake: { name: 'Blake Isetts',  title: 'Project Manager',      phone: '',             email: 'blake@mdsgcabinets.com' },
}

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )

    const { jobId, sender = 'Cole', notes, markupMultiplier, marginPct, grossCostOverride, salesTaxPct, bidSections = {}, freightPassThrough = null, mfrTaxPassThrough = null, applyDealerDiscount = true, hwPieces = 0, hwRate = 4.00, hideUnitPricing = false, totalOnly = false, brandAs = 'mdsg', dealerDiscountPct = null, literaturePaths = [], priceLeedo = null, priceRta = null, costLeedo = null, sellLeedo = null, costRta = null, sellRta = null, installLeedo = null, installRta = null } = await request.json()

    const DEFAULT_SECTIONS = {
      includedInBid: 'Sales Tax  |  Delivery to Job Site',
      assembly: 'By Greenworks Renovations under separate contract — Contact: Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com',
      notIncluded: [
        'Installation — under separate contract with Greenworks Renovations',
        'Attic stock, locks, labor, shims, screws, supports, grommets, castors, blocking or backing',
        'Crown molding, scribe or base shoe unless included in writing',
        'Recessed linen cabinets, desks, entry benches, floating shelves or undercabinet lighting unless included in writing',
        'Model unit "Out of Phase" delivery',
      ].join('\n'),
      bottomNotes: 'Final price subject to approved shop drawings. The first red-line revision is free — subsequent revisions subject to additional fees.',
    }
    const SEC = {
      includedInBid: (bidSections.includedInBid ?? DEFAULT_SECTIONS.includedInBid),
      assembly:      (bidSections.assembly      ?? DEFAULT_SECTIONS.assembly),
      notIncluded:   (bidSections.notIncluded   ?? DEFAULT_SECTIONS.notIncluded),
      bottomNotes:   (bidSections.bottomNotes   ?? DEFAULT_SECTIONS.bottomNotes),
    }
    const salesTax = (salesTaxPct !== undefined && salesTaxPct !== null) ? Number(salesTaxPct) : 9.15
    if (!jobId) return Response.json({ error: 'Job ID required' }, { status: 400 })

    const { data: job, error: jobError } = await supabase
      .from('jobs').select('*, unit_types(*)').eq('id', jobId).single()
    if (jobError || !job) return Response.json({ error: 'Job not found' }, { status: 404 })

    // ── Merge duplicate unit_type rows (pipeline save + mfr quote upload can
    //    both write rows for the same unit). Group by name; prefer the row
    //    carrying a manufacturer price; normalize total-vs-per-unit cabinet counts.
    // Optional per-job alias map: lines of "QUOTE NAME=TAKEOFF NAME" stored in
    // proposal_sections.aliases — lets a mfr's naming merge into the takeoff's.
    const aliasMap = {}
    const aliasSrc = (bidSections.aliases ?? job.proposal_sections?.aliases ?? '')
    String(aliasSrc).split('\n').forEach(line => {
      const [from, to] = line.split('=').map(s => (s || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      if (from && to) aliasMap[from] = to
    })
    const groups = {}
    ;(job.unit_types || []).forEach(ut => {
      let key = (ut.unit_type_name || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // CAFÉ == CAFE
      if (aliasMap[key]) key = aliasMap[key]
      if (!groups[key]) groups[key] = []
      groups[key].push(ut)
    })
    const perUnitCabs = (ut) => {
      const qty = ut.unit_quantity || 1
      const cnt = ut.cabinet_count || 0
      // Mfr-quote rows sometimes store TOTAL cabinets — normalize to per-unit
      if (qty > 1 && cnt > 0 && cnt % qty === 0 && cnt / qty <= 60) return cnt / qty
      return cnt
    }
    const mergedUnits = Object.values(groups).map(rows => {
      const priced = rows.find(r => (r.manufacturer_price || 0) > 0)
      const base   = priced || rows[0]
      return {
        unit_type_name:     base.unit_type_name,
        unit_quantity:      Math.max(...rows.map(r => r.unit_quantity || 1)),
        cabinet_count:      perUnitCabs(base),
        manufacturer_price: Math.max(...rows.map(r => r.manufacturer_price || 0)),
        sort_order:         Math.min(...rows.map(r => r.sort_order ?? 999)),
      }
    })
    const sortedUnits  = mergedUnits.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    const displayUnits = sortedUnits.slice(0, 13)
    const unitPriceSum = mergedUnits.reduce((s, u) => s + (u.manufacturer_price || 0), 0)

    const senderInfo   = brandAs === 'greenworks'
      ? { name: 'Anthony (Willy) Ramirez', title: 'Greenworks Renovations LLC', phone: '619-718-1578', email: 'greenworksrenovationsllc@gmail.com' }
      : (SENDERS[sender] || SENDERS.Cole)
    // Auto-pull Leedo quote figures from the job's imported cab list when the
    // UI didn't supply them — makes the proposal correct even with empty inputs.
    const leedo        = job.cab_list?.leedo || {}
    const leedoTax     = (leedo.grandTotal > 0 && leedo.grossAmount > 0)
      ? Math.max(0, leedo.grandTotal - leedo.grossAmount - (leedo.freight || 0))
      : 0
    let effHwPieces    = Number(hwPieces) || 0
    if (effHwPieces === 0 && job.cab_list?.unit_types) {
      effHwPieces = job.cab_list.unit_types.reduce((s, u) =>
        s + (u.skus || []).reduce((x, r) => x + (Number(r.hardware_count) || 0) * (Number(r.quantity_per_unit) || 0), 0) * (Number(u.unit_quantity) || 1), 0)
    }
    // Unit / bathroom / amenity counts from the cab list classifications
    const clUnits = job.cab_list?.unit_types || []
    const kindQty = (k) => clUnits.filter(u => (u.kind || 'unit') === k).reduce((s, u) => s + (Number(u.unit_quantity) || 1), 0)
    const nUnits = kindQty('unit'), nBaths = kindQty('bathroom'), nAmen = kindQty('amenity')
    const clCabs = job.cab_list?.sheet_totals?.cabinets
      ?? clUnits.reduce((s, u) => s + (u.skus || []).reduce((x, r) => x + (Number(r.quantity_per_unit) || 0), 0) * (Number(u.unit_quantity) || 1), 0)
    const totalCabsDisplay = clCabs > 0 ? clCabs : (job.total_cabinet_count || 0)
    const amenNames = clUnits.filter(u => (u.kind || 'unit') === 'amenity').map(u => u.unit_type_name)

    // Hardware allowance: pieces × $/piece at OUR cost, marked up with the same margin
    const hwCost       = effHwPieces * (Number(hwRate) || 0)
    const hardware     = 0  // legacy flat allowance replaced by hwCost path below
    const discountPctIn = dealerDiscountPct !== null && dealerDiscountPct !== '' && !isNaN(Number(dealerDiscountPct))
      ? Math.min(Math.max(Number(dealerDiscountPct) / 100, 0), 0.5) : null
    const discount     = applyDealerDiscount ? (discountPctIn ?? job.dealer_discount_pct ?? 0.05) : 0
    if (applyDealerDiscount && discountPctIn !== null && discountPctIn !== job.dealer_discount_pct) {
      await supabase.from('jobs').update({ dealer_discount_pct: discountPctIn }).eq('id', jobId)
    }
    // Cost basis priority: explicit override from UI → job field → Σ unit mfr prices
    const grossCost    = (Number(grossCostOverride) > 0 ? Number(grossCostOverride) : 0)
                       || job.manufacturer_gross_cost || unitPriceSum
    // Freight & manufacturer tax are PASS-THROUGH: added after markup, never margined.
    const freight      = freightPassThrough !== null ? Number(freightPassThrough) : (job.freight_cost || leedo.freight || 0)
    const taxExplicit  = mfrTaxPassThrough !== null && mfrTaxPassThrough !== undefined && String(mfrTaxPassThrough).trim() !== ''
    const mfrTax       = taxExplicit ? (Number(mfrTaxPassThrough) || 0) : (leedoTax || 0)
    const netCost      = grossCost * (1 - discount)
    // TRUE gross-margin pricing on the cabinet gross only
    const mPct         = Number(marginPct)
    const marginize    = (v) => mPct > 0 && mPct < 95
      ? v / (1 - mPct / 100)
      : v * (markupMultiplier || job.markup_multiplier || 1.34)
    const cabsToGC     = marginize(netCost)
    const hwToGC       = hwCost > 0 ? marginize(hwCost) : (job.hardware_allowance || 0)
    // Sales tax applies to the marked-up cabinet price only, not pass-throughs
    const taxZeroed    = taxExplicit && (Number(mfrTaxPassThrough) || 0) === 0
    const taxAmount    = (taxZeroed || mfrTax > 0) ? 0 : (salesTax > 0 ? (cabsToGC + hwToGC) * (salesTax / 100) : 0)
    const totalBid     = cabsToGC + freight + mfrTax + hwToGC + taxAmount
    // Manual pricing model: typed lines are COST; margin marks them up; a
    // typed SELL overrides the math. Legacy priceLeedo/priceRta = sell.
    const n0 = (v) => Number(v) > 0 ? Number(v) : 0
    const mFactor = mPct > 0 && mPct < 95 ? 1 / (1 - mPct / 100) : (markupMultiplier || job.markup_multiplier || 1.34)
    const cL = n0(costLeedo), cR = n0(costRta)
    const sL = n0(sellLeedo) || n0(priceLeedo)
    const sR = n0(sellRta) || n0(priceRta)
    const displayBid = sL > 0 ? sL : (cL > 0 ? Math.round(cL * mFactor) : totalBid)
    const rtaBid = sR > 0 ? sR : (cR > 0 ? Math.round(cR * mFactor) : 0)
    const instL = n0(installLeedo), instR = n0(installRta)

    // Persist OS-side financials — dashboard prefers these over Monday columns
    await supabase.from('jobs').update({
      os_bid_value: Math.round((displayBid + instL) * 100) / 100,
      ...((sL > 0 || cL > 0) ? { price_leedo: displayBid } : {}),
      price_rta: rtaBid > 0 ? rtaBid : null,
      price_leedo_cost: cL > 0 ? cL : null,
      price_rta_cost: cR > 0 ? cR : null,
      price_leedo_install: instL > 0 ? instL : null,
      price_rta_install: instR > 0 ? instR : null,
      os_cost_value: cL > 0 ? cL : Math.round((netCost + hwCost + freight + mfrTax) * 100) / 100,
      os_margin_pct: cL > 0 && displayBid > 0 ? Math.round((1 - cL / displayBid) * 1000) / 10 : (mPct > 0 && mPct < 95 ? mPct : null),
    }).eq('id', jobId)
    // Margin kept internal only — logged to activity but never shown on PDF
    const hardwareCost = hwCost
    const margin       = mPct > 0 && mPct < 95 ? String(mPct) : (totalBid > 0 ? ((1 - netCost / (totalBid / (1 + salesTaxPct/100))) * 100).toFixed(1) : '0')

    const today      = new Date()
    const validUntil = new Date(today)
    validUntil.setDate(validUntil.getDate() + 90)
    const fmtDate  = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString()
    const proposalNum = `${brandAs === 'greenworks' ? 'GW' : 'MDSG'}-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}-${(job.name || 'JOB').substring(0, 3).toUpperCase()}`

    const boxConst = job.box_construction || ''
    const isPlywood = /plywood/i.test(boxConst) || true
    const isFramed  = /framed/i.test(boxConst)  || true

    // ── PDF setup — Greenworks-style bordered grid ────────────────────────
    const pdfDoc  = await PDFDocument.create()
    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const boldIt  = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique)
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const isGW = brandAs === 'greenworks'
    let logo = null
    try {
      if (isGW) logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'greenworks-logo.png')))
      else {
        try { logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo-square.png'))) }
        catch { logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png'))) }
      }
    } catch {}

    const sage  = rgb(0.56, 0.68, 0.55)
    const black = rgb(0, 0, 0)
    const blue  = rgb(0.05, 0.3, 0.6)
    const ML = 30, MR = 582, W = MR - ML

    let page = pdfDoc.addPage(PageSizes.Letter)
    let frameTop = 772
    const mk = () => ({
      txt: (t, x, y, o = {}) => { if (t == null || t === '') return
        page.drawText(String(t), { x, y, size:o.size||7.5, font:o.boldIt?boldIt:(o.bold?bold:regular), color:o.color||black, maxWidth:o.maxWidth }) },
      box: (x, y, w, h, fill = null, t = 0.75) => {
        if (fill) page.drawRectangle({ x, y, width:w, height:h, color:fill })
        page.drawRectangle({ x, y, width:w, height:h, borderColor:black, borderWidth:t }) },
      line2: (x1, y1, x2, y2, t = 0.5) => page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:t, color:black }),
    })
    let { txt, box, line2 } = mk()
    const ctr = (t, x, w, y, o = {}) => { const f = o.boldIt?boldIt:(o.bold?bold:regular)
      const tw = f.widthOfTextAtSize(String(t), o.size||7.5); txt(t, x + (w - tw)/2, y, o) }
    const rgt = (t, rx, y, o = {}) => { const f = o.boldIt?boldIt:(o.bold?bold:regular)
      const tw = f.widthOfTextAtSize(String(t), o.size||7.5); txt(t, rx - tw - 4, y, o) }
    const wrapT = (t, size, max, isBold = false) => {
      const f = isBold ? bold : regular
      const words = String(t).split(' '); const lines = []; let cur = ''
      for (const w2 of words) {
        const cand = cur ? cur + ' ' + w2 : w2
        if (f.widthOfTextAtSize(cand, size) <= max) cur = cand
        else { if (cur) lines.push(cur); cur = w2 }
      }
      if (cur) lines.push(cur)
      return lines.length ? lines : ['']
    }

    let y = 768
    const finalizeFrame = () => page.drawRectangle({ x: ML - 2, y: y - 4, width: W + 4, height: frameTop - (y - 4), borderColor: black, borderWidth: 1.5 })
    const ensure = (h) => { if (y - h < 46) {
      finalizeFrame()
      page = pdfDoc.addPage(PageSizes.Letter); ({ txt, box, line2 } = mk())
      frameTop = 764; y = 760
      box(ML, y - 14, W, 14, sage, 1)
      ctr((isGW ? 'GREENWORKS RENOVATIONS, LLC' : 'MANUFACTURER DIRECT SALES GROUP, LLC') + '  —  CABINET PROPOSAL (cont.)', ML, W, y - 10, { bold:true, size:8 })
      y -= 14
    } }

    // ═ Title band + Date/Proposal strip ═
    box(ML, y - 20, W, 20, sage, 1.25)
    ctr(isGW ? 'GREENWORKS RENOVATIONS, LLC' : 'MANUFACTURER DIRECT SALES GROUP, LLC', ML, W, y - 14, { bold:true, size:12 })
    y -= 20
    box(ML, y - 12, W - 300, 12); box(MR - 300, y - 12, 150, 12); box(MR - 150, y - 12, 150, 12)
    txt('Proposal No. ' + proposalNum, ML + 3, y - 9, { bold:true, size:6.5 })
    txt('Date:', MR - 296, y - 9, { bold:true, size:6.5 })
    rgt(`${today.getMonth()+1}/${today.getDate()}/${today.getFullYear()}`, MR - 150, y - 9, { bold:true, size:6.5 })
    txt('Valid through:', MR - 146, y - 9, { bold:true, size:6.5 })
    rgt(`${validUntil.getMonth()+1}/${validUntil.getDate()}/${validUntil.getFullYear()}`, MR, y - 9, { bold:true, size:6.5 })
    y -= 12

    // ═ Header grid: CONTACT | title+logo | CUSTOMER ═
    const L1 = ML, L1W = 196, C1 = ML + L1W, C1W = 160, R1 = C1 + C1W, R1W = W - L1W - C1W
    const hTop = y, hBot = y - 92
    const si2 = isGW
      ? { name: 'Anthony (Willy) Ramirez', phone: '619/718-1578', email: 'greenworksrenovationsllc@gmail.com', addr1: '5328 S. Jebel Way', addr2: 'Centennial, CO  80015' }
      : { ...senderInfo, addr1: '23463 E. Moraine Place', addr2: 'Aurora, CO  80016' }
    const lrow = (label, value, ry, lw = 58) => {
      box(L1, ry - 11, lw, 11); box(L1 + lw, ry - 11, L1W - lw, 11)
      txt(label, L1 + 2, ry - 8, { bold:true, size:6 }); txt(value, L1 + lw + 2, ry - 8, { size:6.5, maxWidth: L1W - lw - 4 })
    }
    box(L1, hTop - 11, L1W, 11); txt('CONTACT:', L1 + 2, hTop - 8, { bold:true, size:6.5 })
    box(L1, hTop - 22, L1W, 11); txt(si2.name + (si2.title ? ', ' + si2.title : ''), L1 + 2, hTop - 19, { bold:true, size:7 })
    lrow('TELEPHONE:', si2.phone, hTop - 33)
    lrow('EMAIL:', si2.email, hTop - 44)
    lrow('ADDRESS:', si2.addr1, hTop - 55)
    box(L1, hTop - 77, 58, 11); box(L1 + 58, hTop - 77, L1W - 58, 11)
    txt(si2.addr2, L1 + 60, hTop - 74, { size:6.5 })
    box(L1, hBot, L1W, hTop - 77 - hBot)
    box(C1, hTop - 14, C1W, 14)
    ctr('CABINET PROPOSAL', C1, C1W, hTop - 10, { bold:true, size:7.5 })
    box(C1, hBot, C1W, hTop - 14 - hBot)
    if (logo) { const d = logo.scaleToFit(C1W - 12, hTop - 14 - hBot - 8)
      page.drawImage(logo, { x: C1 + (C1W - d.width)/2, y: hBot + ((hTop - 14 - hBot) - d.height)/2, width: d.width, height: d.height }) }
    const rrow = (label, value, ry, o = {}) => {
      box(R1, ry - 11, 68, 11); box(R1 + 68, ry - 11, R1W - 68, 11)
      rgt(label, R1 + 68, ry - 8, { bold:true, size:6 }); txt(value, R1 + 70, ry - 8, { bold:o.bold, size:6.5, color:o.color, maxWidth: R1W - 72 })
    }
    const addrLine = [job.address].filter(Boolean).join('')
    const cszLine  = [job.city, job.state].filter(Boolean).join(', ') + (job.zip ? '  ' + job.zip : '')
    rrow('CUSTOMER:', (job.gc_name || '—').toUpperCase(), hTop, { bold:true })
    rrow('PROJECT:', (job.name || '').toUpperCase(), hTop - 11, { bold:true })
    rrow('ADDRESS:', addrLine, hTop - 22, { bold:true })
    rrow('CITY/STATE/ZIP', cszLine, hTop - 33, { bold:true })
    rrow('CONTACT:', job.gc_contact || '', hTop - 44, { bold:true })
    rrow('TELEPHONE:', job.gc_phone || '', hTop - 55, { bold:true })
    rrow('EMAIL:', job.gc_email || '', hTop - 66, { color: blue })
    box(R1, hBot, R1W, hTop - 66 - hBot)
    y = hBot

    // ═ DESCRIPTION + CABINET LINE bands ═
    box(ML, y - 12, W, 12); ctr('DESCRIPTION', ML, W, y - 9, { bold:true, size:7.5 }); y -= 12
    box(ML, y - 12, W, 12, sage)
    txt('CABINET LINE: ', ML + 2, y - 9, { bold:true, size:7.5 })
    txt(job.manufacturer || 'TBD', ML + 70, y - 9, { bold:true, size:7.5 })
    y -= 12

    // ═ Spec rows: left pairs | right pairs ═
    const specL = [
      ['DOOR STYLE/OVERLAY:', `${job.door_style || 'TBD'} / Full Overlay`],
      ['MATERIAL:',           'Maple'],
      ['COLOR:',              job.finish_color || 'TBD'],
      ['BOX CONSTRUCTION:',   isFramed ? 'Framed' : boxConst],
      ['BOX MATERIAL:',       job.cabinet_construction || (isPlywood ? 'Plywood' : 'Particleboard')],
      ['DRAWER BOX/GLIDE:',   job.drawer_box || 'Dovetail / Undermount Soft Close'],
      ['INTERIOR:',           job.interior_color || 'White'],
      ['SHELF:',              job.shelf_thickness || '3/4"'],
      ['HINGES:',             (job.hinge_type || 'Euro 6 Way') + ' / Soft Close'],
    ]
    const specR = [
      ['NO. OF UNITS:',      String(job.units_override ?? (nUnits > 0 ? nUnits : (job.total_residential_units || '—')))],
      ...(nBaths > 0 ? [['NO. OF BATHROOMS:', String(nBaths)]] : []),
      ['NO. OF AMENITIES:',  String(job.amenities_override ?? (nAmen > 0 ? nAmen : (job.amenity_unit_count || '—')))],
      ['EST. DELIVERY:',     job.est_delivery || '—'],
      ['NO. OF DELIVERIES:', job.deliveries_count || job.num_deliveries || '—'],
      ['TOTAL CABINETS:',    Number(job.total_cabinets_override) > 0 ? Number(job.total_cabinets_override).toLocaleString() : totalCabsDisplay.toLocaleString()],
      ['HARDWARE ALLOW.:',   hwToGC > 0 ? fmtMoney(hwToGC) : 'Not included'],
    ]
    const SLW = 110, SVW = 230, RLW2 = 120
    const nSpec = Math.max(specL.length, specR.length)
    for (let i = 0; i < nSpec; i++) {
      const [ll, lv] = specL[i] || ['', '']
      const [rl, rv] = specR[i] || ['', '']
      box(ML, y - 12, SLW, 12); box(ML + SLW, y - 12, SVW, 12)
      txt(ll, ML + 2, y - 9, { bold:true, size:6.8 }); txt(lv, ML + SLW + 2, y - 9, { size:6.8, maxWidth: SVW - 4 })
      box(ML + SLW + SVW, y - 12, RLW2, 12); box(ML + SLW + SVW + RLW2, y - 12, W - SLW - SVW - RLW2, 12)
      txt(rl, ML + SLW + SVW + 2, y - 9, { bold:true, size:6.8 })
      if (rv) ctr(rv, ML + SLW + SVW + RLW2, W - SLW - SVW - RLW2, y - 9, { bold:true, size:6.8 })
      y -= 12
    }

    // ═ UNIT TYPE BREAKDOWN ═
    const kindOf = (name) => {
      const m = clUnits.find(u => (u.unit_type_name || '').trim().toUpperCase() === (name || '').trim().toUpperCase())
      return m ? (m.kind || 'unit') : 'unit'
    }
    if (hideUnitPricing || totalOnly) {
      box(ML, y - 12, W, 12, sage); txt('PROJECT SCOPE:', ML + 2, y - 9, { bold:true, size:7.5 })
      const bits = []
      if (nUnits > 0) bits.push(`${nUnits} Units`); if (nBaths > 0) bits.push(`${nBaths} Bathrooms`); if (nAmen > 0) bits.push(`${nAmen} Amenities`)
      bits.push(`${totalCabsDisplay.toLocaleString()} Total Cabinets`)
      txt(bits.join('   ·   '), ML + 95, y - 9, { bold:true, size:7 })
      y -= 12
    } else {
      box(ML, y - 12, W, 12, sage); ctr('UNIT TYPE BREAKDOWN', ML, W, y - 9, { bold:true, size:7.5 }); y -= 12
      const CU = MR - 220, CC = MR - 140, CP = MR - 84
      box(ML, y - 11, CU - ML, 11); box(CU, y - 11, 80, 11); box(CC, y - 11, 56, 11); box(CP, y - 11, 84, 11)
      txt('UNIT TYPE', ML + 2, y - 8, { bold:true, size:6.5 }); ctr('UNITS', CU, 80, y - 8, { bold:true, size:6.5 })
      ctr('CABINETS', CC, 56, y - 8, { bold:true, size:6.5 }); ctr('MFR PRICE', CP, 84, y - 8, { bold:true, size:6.5 })
      y -= 11
      const ordered = [...sortedUnits.filter(u => kindOf(u.unit_type_name) !== 'amenity'), ...sortedUnits.filter(u => kindOf(u.unit_type_name) === 'amenity')].slice(0, 40)
      let amenHdr = false
      for (const ut of ordered) {
        ensure(12)
        if (!amenHdr && kindOf(ut.unit_type_name) === 'amenity') {
          box(ML, y - 11, W, 11, rgb(0.90, 0.92, 0.90)); txt('AMENITIES', ML + 2, y - 8, { bold:true, size:6.5 }); y -= 11
          amenHdr = true
        }
        box(ML, y - 11, CU - ML, 11); box(CU, y - 11, 80, 11); box(CC, y - 11, 56, 11); box(CP, y - 11, 84, 11)
        txt(String(ut.unit_type_name || '').substring(0, 58), ML + 2, y - 8, { size:6.8 })
        ctr(String(ut.unit_quantity || 1), CU, 80, y - 8, { size:6.8 })
        ctr(String(ut.cabinet_count || 0), CC, 56, y - 8, { size:6.8 })
        rgt(ut.manufacturer_price ? fmtMoney(ut.manufacturer_price) : '—', MR, y - 8, { size:6.8 })
        y -= 11
      }
      ensure(12)
      box(ML, y - 11, CU - ML, 11, sage); box(CU, y - 11, 80, 11, sage); box(CC, y - 11, 56, 11, sage); box(CP, y - 11, 84, 11, sage)
      txt('TOTALS', ML + 2, y - 8, { bold:true, size:6.8 })
      ctr(String(sortedUnits.reduce((s, u) => s + (Number(u.unit_quantity) || 1), 0)), CU, 80, y - 8, { bold:true, size:6.8 })
      ctr(totalCabsDisplay.toLocaleString(), CC, 56, y - 8, { bold:true, size:6.8 })
      y -= 11
    }

    // ═ PRICING — BASE PRICE blocks ═
    const PRW = 84
    const bandRow = (fill, l, r, o = {}) => {
      ensure(12)
      box(ML, y - 12, W - PRW, 12, fill); box(MR - PRW, y - 12, PRW, 12, fill)
      if (l) txt(l, ML + 2, y - 9, { bold:o.bold, size:o.size || 7 })
      if (o.rl) rgt(o.rl, MR - PRW, y - 9, { bold:o.rlBold, size:7 })
      if (r != null) rgt(r, MR, y - 9, { bold:true, size:7 })
      y -= 12
    }
    const baseBand = (label) => {
      ensure(14)
      box(ML, y - 12, W - PRW, 12, sage); box(MR - PRW, y - 12, PRW, 12, sage)
      txt('BASE PRICE:  ' + label, ML + 2, y - 9, { bold:true, size:7.5 })
      ctr('TOTAL COST', MR - PRW, PRW, y - 9, { bold:true, size:7 })
      y -= 12
    }
    if (rtaBid > 0) {
      baseBand('LEEDO — DOMESTIC MANUFACTURED')
      bandRow(null, 'CABINETS & APPLICABLE SALES TAX', fmtMoney(displayBid), { bold:true })
      if (instL > 0) bandRow(null, null, fmtMoney(instL), { rl: 'INSTALLATION' })
      bandRow(null, null, fmtMoney(displayBid + instL), { rl: 'TOTAL', rlBold: true })
      baseBand('IMPORTED RTA — TO MATCH SPECIFICATIONS ABOVE')
      bandRow(null, 'CABINETS & APPLICABLE SALES TAX', fmtMoney(rtaBid), { bold:true })
      if (instR > 0) bandRow(null, null, fmtMoney(instR), { rl: 'STAGING, ASSEMBLY & INSTALLATION' })
      bandRow(null, null, fmtMoney(rtaBid + instR), { rl: 'TOTAL', rlBold: true })
    } else {
      baseBand((job.manufacturer || 'LEEDO').toUpperCase() + ' — CABINET SUPPLY')
      if (sL > 0 || cL > 0) {
        bandRow(null, 'CABINETS & APPLICABLE SALES TAX', fmtMoney(displayBid), { bold:true })
        if (instL > 0) bandRow(null, null, fmtMoney(instL), { rl: 'INSTALLATION' })
      } else {
        bandRow(null, 'BASE CABINET PRICE', fmtMoney(cabsToGC), { bold:true })
        if (freight > 0) bandRow(null, 'FREIGHT (PASS-THROUGH)', fmtMoney(freight))
        if (mfrTax > 0) bandRow(null, 'SALES TAX — FROM MANUFACTURER QUOTE', fmtMoney(mfrTax))
        if (hwToGC > 0) bandRow(null, `HARDWARE ALLOWANCE${hwCost > 0 ? ` (${effHwPieces.toLocaleString()} PIECES)` : ''}`, fmtMoney(hwToGC))
        if (salesTax > 0 && taxAmount > 0) bandRow(null, `SALES TAX (${salesTax}%)`, fmtMoney(taxAmount))
      }
      ensure(14)
      box(ML, y - 13, W - PRW, 13, sage); box(MR - PRW, y - 13, PRW, 13, sage)
      rgt('TOTAL', MR - PRW, y - 9.5, { bold:true, size:7.5 })
      rgt(fmtMoney(displayBid + instL), MR, y - 9.5, { bold:true, size:8 })
      y -= 13
    }

    // ═ INCLUDED / NOT INCLUDED bands ═
    const half = W - 170
    const bandRows2 = (title, items) => {
      ensure(12 + 11)
      box(ML, y - 12, half, 12, sage); box(ML + half, y - 12, W - half, 12)
      txt(title, ML + 2, y - 9, { bold:true, size:7.5 }); y -= 12
      for (const it of items) {
        for (const wl of wrapT(it, 6.8, half - 14)) {
          ensure(11)
          box(ML, y - 11, half, 11); box(ML + half, y - 11, W - half, 11)
          txt(wl, ML + 8, y - 8, { size:6.8 }); y -= 11
        }
      }
    }
    const taxPctShown = mfrTax > 0 && (grossCost + freight) > 0 ? ((mfrTax / (grossCost + freight)) * 100).toFixed(2).replace(/0$/, '') : (salesTax > 0 ? String(salesTax) : null)
    bandRows2('INCLUDED IN BID:', SEC.includedInBid.split(/\||\n/).map(s => s.trim()).filter(Boolean).map(s => /^sales tax$/i.test(s) && taxPctShown ? `Sales Tax:  ${taxPctShown}%` : s))
    if (!isGW) bandRows2('ASSEMBLY, STAGING & INSTALLATION:', SEC.assembly.split('\n').map(s => s.trim()).filter(Boolean))
    bandRows2('NOT INCLUDED IN BID:', SEC.notIncluded.split('\n').map(s => s.trim()).filter(Boolean).map(s => '- ' + s.replace(/^[-•]\s*/, '')))

    // ═ NOTES (General) box ═
    const gLines = [notes && notes.trim() ? notes.trim() : null].filter(Boolean)
    if (gLines.length) {
      const gH = 14 + gLines.length * 10
      ensure(gH)
      box(ML, y - gH, half, gH); box(ML + half, y - gH, W - half, gH)
      txt('NOTES (General):', ML + 2, y - 10, { bold:true, size:7 })
      let gy = y - 20
      for (const gl of gLines) { txt(gl, ML + 4, gy, { bold:true, size:6.8, maxWidth: half - 8 }); gy -= 10 }
      y -= gH
    }

    // ═ NOTES band ═
    const nLines = wrapT(SEC.bottomNotes, 6.8, W - 215, true)
    const nH = 8 + nLines.length * 9
    ensure(nH)
    box(ML, y - nH, W - 160, nH, sage); box(MR - 160, y - nH, 160, nH)
    txt('NOTES:', ML + 3, y - 11, { boldIt:true, size:8 })
    let ny = y - 11
    for (const nl of nLines) { txt(nl, ML + 40, ny, { bold:true, size:6.8 }); ny -= 9 }
    y -= nH

    // ═ Thank-you + signature ═
    ensure(50)
    const tH = 50
    box(ML, y - tH, half, tH); box(ML + half, y - tH, W - half, tH)
    txt('**Thank you for the opportunity to submit our proposal.**', ML + 2, y - 9, { size:6 })
    txt('Unit pricing will be honored for 90 days from the date of proposal.', ML + 2, y - 17, { size:6 })
    txt('All quantities are estimated, final field measurements and approved Shop Drawings will prevail.', ML + 2, y - 25, { size:6 })
    txt('Any new or increased tariffs enacted after the proposal date are a pass-through cost to the customer.', ML + 2, y - 33, { size:6, bold:true })
    txt('Once materials are delivered, the General Contractor is responsible for any and all damage.', ML + 2, y - 41, { size:6, bold:true })
    line2(ML + half + 10, y - tH + 10, MR - 10, y - tH + 10, 0.5)
    ctr('Customer Signature & Date', ML + half, W - half, y - tH + 3, { size:6.5 })
    y -= tH

    // ═ Corporate footer bands ═
    ensure(30)
    box(ML, y - 16, W, 16, sage, 1.25)
    ctr(isGW ? 'CORPORATE OFFICES: 5328 S. Jebel Way, Centennial, CO  80015'
             : 'CORPORATE OFFICES: 23463 E. Moraine Place, Aurora, CO  80016', ML, W, y - 11, { bold:true, size:9 })
    y -= 16
    box(ML, y - 12, W, 12)
    ctr(isGW ? 'CONTACT: Anthony (Willy) Ramirez, President; Telephone: 619.718-1578; email: greenworksrenovationsllc@gmail.com'
             : 'CONTACT: Pamela Isetts, President; Telephone: 651.301-1063; email: pam@mdsgcabinets.com', ML, W, y - 9, { bold:true, size:7 })
    y -= 12
    finalizeFrame()

    // ── Append selected spec literature PDFs ──────────────────────────────
    for (const litPath of (Array.isArray(literaturePaths) ? literaturePaths.slice(0, 15) : [])) {
      try {
        const { data: fileData, error: dlErr } = await supabase.storage.from('job-files').download(litPath)
        if (dlErr || !fileData) continue
        const litBytes = await fileData.arrayBuffer()
        const litDoc = await PDFDocument.load(litBytes, { ignoreEncryption: true })
        const pages = await pdfDoc.copyPages(litDoc, litDoc.getPageIndices())
        pages.forEach(pg => pdfDoc.addPage(pg))
      } catch { /* skip unreadable literature file */ }
    }

    const pdfBytes = await pdfDoc.save()

    await supabase.from('proposals').insert({
      job_id: jobId,
      proposal_number: proposalNum,
      status: 'Draft',
      total_amount: totalBid,
      valid_until: validUntil.toISOString().split('T')[0],
      sent_from: senderInfo.email,
    }).maybeSingle()

    // Margin is internal only — logged but never shown on PDF
    await supabase.from('activity_log').insert({
      job_id: jobId,
      user_name: sender,
      action: `Proposal generated — ${proposalNum} · ${fmtMoney(totalBid)} · ${margin}% margin (internal)`,
    })

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="MDSG-Proposal-${(job.name || 'Job').replace(/[^a-z0-9]/gi, '-')}.pdf"`,
      },
    })
  } catch (error) {
    console.error('Proposal error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}
