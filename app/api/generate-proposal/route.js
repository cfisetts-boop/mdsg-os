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
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const { jobId, sender = 'Cole', notes, markupMultiplier, marginPct, grossCostOverride, salesTaxPct, bidSections = {}, freightPassThrough = null, mfrTaxPassThrough = 0, applyDealerDiscount = true, hwPieces = 0, hwRate = 4.00 } = await request.json()

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

    const senderInfo   = SENDERS[sender] || SENDERS.Cole
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
    // Hardware allowance: pieces × $/piece at OUR cost, marked up with the same margin
    const hwCost       = effHwPieces * (Number(hwRate) || 0)
    const hardware     = 0  // legacy flat allowance replaced by hwCost path below
    const discount     = applyDealerDiscount ? (job.dealer_discount_pct || 0.05) : 0
    // Cost basis priority: explicit override from UI → job field → Σ unit mfr prices
    const grossCost    = (Number(grossCostOverride) > 0 ? Number(grossCostOverride) : 0)
                       || job.manufacturer_gross_cost || unitPriceSum
    // Freight & manufacturer tax are PASS-THROUGH: added after markup, never margined.
    const freight      = freightPassThrough !== null ? Number(freightPassThrough) : (job.freight_cost || leedo.freight || 0)
    const mfrTax       = Number(mfrTaxPassThrough) || leedoTax || 0
    const netCost      = grossCost * (1 - discount)
    // TRUE gross-margin pricing on the cabinet gross only
    const mPct         = Number(marginPct)
    const marginize    = (v) => mPct > 0 && mPct < 95
      ? v / (1 - mPct / 100)
      : v * (markupMultiplier || job.markup_multiplier || 1.34)
    const cabsToGC     = marginize(netCost)
    const hwToGC       = hwCost > 0 ? marginize(hwCost) : (job.hardware_allowance || 0)
    // Sales tax applies to the marked-up cabinet price only, not pass-throughs
    const taxAmount    = mfrTax > 0 ? 0 : (salesTax > 0 ? (cabsToGC + hwToGC) * (salesTax / 100) : 0)
    const totalBid     = cabsToGC + freight + mfrTax + hwToGC + taxAmount
    // Margin kept internal only — logged to activity but never shown on PDF
    const hardwareCost = hwCost
    const margin       = mPct > 0 && mPct < 95 ? String(mPct) : (totalBid > 0 ? ((1 - netCost / (totalBid / (1 + salesTaxPct/100))) * 100).toFixed(1) : '0')

    const today      = new Date()
    const validUntil = new Date(today)
    validUntil.setDate(validUntil.getDate() + 90)
    const fmtDate  = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString()
    const proposalNum = `MDSG-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}-${(job.name || 'JOB').substring(0, 3).toUpperCase()}`

    const boxConst = job.box_construction || ''
    const isPlywood = /plywood/i.test(boxConst) || true
    const isFramed  = /framed/i.test(boxConst)  || true

    // ── PDF setup ─────────────────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create()
    const page   = pdfDoc.addPage(PageSizes.Letter)
    // Letter = 612 × 792 pts. y=0 is bottom-left.

    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)

    // Logo (white-background PNG — placed in white area above colored bar)
    let logo = null
    try {
      logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png')))
    } catch {}

    // ── MDSG brand colors (sage green from logo) ──────────────────────────
    const brandGreen = rgb(0.44, 0.61, 0.47)   // #709B77 — main sage green
    const darkGreen  = rgb(0.26, 0.40, 0.28)   // header bar / section titles
    const white      = rgb(1.00, 1.00, 1.00)
    const black      = rgb(0.13, 0.13, 0.13)
    const gray       = rgb(0.45, 0.45, 0.45)
    const lgray      = rgb(0.94, 0.94, 0.94)
    const dgray      = rgb(0.60, 0.60, 0.60)
    const mintBg     = rgb(0.94, 0.97, 0.95)   // very light green for alternating rows

    const ML  = 50
    const PW  = 512
    const MR  = ML + PW
    const MID = ML + 256   // midpoint dividing left/right columns

    // ── Helpers ───────────────────────────────────────────────────────────
    const dt = (text, x, y, opts = {}) => {
      if (text === null || text === undefined || text === '') return
      page.drawText(String(text), {
        x, y,
        size:     opts.size  || 9,
        font:     opts.bold  ? bold : regular,
        color:    opts.color || black,
        maxWidth: opts.maxWidth || (MR - x),
      })
    }
    const dline = (y, x1 = ML, x2 = MR) =>
      page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: rgb(0.80, 0.85, 0.81) })
    const drect = (x, y, w, h, color) =>
      page.drawRectangle({ x, y, width: w, height: h, color })
    const rAlign = (text, rightX, y, opts = {}) => {
      const f = opts.bold ? bold : regular
      const w = f.widthOfTextAtSize(String(text), opts.size || 9)
      dt(text, rightX - w, y, opts)
    }
    const labelVal = (label, value, lx, vx, y, opts = {}) => {
      dt(label, lx, y, { size: 7.5, color: gray })
      dt(value, vx, y, { size: 7.5, ...opts })
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HEADER — white logo area + dark green company bar
    // ═══════════════════════════════════════════════════════════════════════

    // White logo area (y=762–792, 30pt)
    drect(ML, 762, PW, 30, white)

    if (logo) {
      const d = logo.scaleToFit(100, 26)
      page.drawImage(logo, { x: ML + 6, y: 764, width: d.width, height: d.height })
    }

    // Company name right of logo
    dt('MANUFACTURER DIRECT SALES GROUP, LLC', ML + 118, 780, { bold: true, size: 11.5, color: darkGreen })
    dt('23463 E. Moraine Pl., Aurora, CO 80016  |  mdsgcabinets.com', ML + 118, 767, { size: 7.5, color: brandGreen })

    // Dark green accent bar (y=744–762, 18pt)
    drect(ML, 744, PW, 18, darkGreen)
    dt('CABINET PROPOSAL', ML + 10, 750, { bold: true, size: 10, color: white })
    rAlign(`Proposal No. ${proposalNum}`, MR - 8, 750, { size: 8, color: rgb(0.80, 0.92, 0.82) })

    // ═══════════════════════════════════════════════════════════════════════
    // CUSTOMER BLOCK — right column only (date/proposal # already in header bar)
    // ═══════════════════════════════════════════════════════════════════════
    const COL_R = MID + 14   // right column x start

    const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ')

    // CUSTOMER block starts 12pt below the bar bottom (y=744), so cap height clears the bar
    dt('CUSTOMER',          COL_R, 730, { size: 6.5, color: gray, bold: true })
    dt(job.gc_name || '—', COL_R, 719, { size: 10,  bold: true, maxWidth: MR - COL_R })
    dt(job.name,            COL_R, 707, { size: 8.5, maxWidth: MR - COL_R })
    if (addr) dt(addr,      COL_R, 696, { size: 7.5, color: gray, maxWidth: MR - COL_R })

    dline(686)   // separator — 10pt below address baseline (696)

    // ═══════════════════════════════════════════════════════════════════════
    // SUBMITTED BY — two columns
    // ═══════════════════════════════════════════════════════════════════════

    dt('SR. PROJECT MANAGER',  ML,    676, { size: 6.5, color: gray, bold: true })
    dt('CONTACT',              COL_R, 676, { size: 6.5, color: gray, bold: true })

    dt(senderInfo.name,        ML,    664, { size: 9, bold: true })
    dt('Tel:',                 COL_R, 664, { size: 7.5, color: gray })
    dt(senderInfo.phone || '—', COL_R + 24, 664, { size: 7.5 })

    dt(senderInfo.title,       ML,    653, { size: 7.5, color: gray })
    dt('Email:',               COL_R, 653, { size: 7.5, color: gray })
    dt(senderInfo.email,       COL_R + 33, 653, { size: 7.5 })

    dt('CSR:',                 COL_R, 642, { size: 7.5, color: gray })
    dt('csr@mdsgcabinets.com', COL_R + 27, 642, { size: 7.5 })

    dline(632)   // separator — 10pt below CSR baseline (642)

    // ═══════════════════════════════════════════════════════════════════════
    // DESCRIPTION — two-column specs
    // ═══════════════════════════════════════════════════════════════════════
    //   Bar occupies y=612 (bottom) to y=624 (top) — 8pt below separator (632)
    drect(ML, 612, PW, 12, darkGreen)
    // Center text: baseline = bar_bottom + (bar_height - font_size) / 2 = 612 + (12-8)/2 = 614
    dt('DESCRIPTION', ML + PW / 2 - bold.widthOfTextAtSize('DESCRIPTION', 8) / 2, 615, { bold: true, size: 8, color: white })

    const specL = [
      ['CABINET LINE:',       job.manufacturer || 'TBD'],
      ['DOOR STYLE/OVERLAY:', `${job.door_style || 'TBD'} / Full Overlay`],
      ['MATERIAL:',           'Maple'],
      ['COLOR:',              job.finish_color || 'TBD'],
      ['BOX CONSTRUCTION:',   isFramed  ? 'Framed'      : boxConst],
      ['BOX MATERIAL:',       isPlywood ? 'Plywood'     : 'Particleboard'],
      ['DRAWER:',             'Dovetail'],
      ['DRAWER GLIDE:',       'Undermount w/Soft Close'],
      ['HINGES:',             'Soft Close'],
    ]
    const specR = [
      ['NO. OF UNITS:',      String(job.total_residential_units || '—')],
      ['NO. OF AMENITIES:',  String(job.amenity_unit_count || '—')],
      ['EST. DELIVERY:',     job.est_delivery || '—'],
      ['NO. OF DELIVERIES:', job.num_deliveries || '—'],
      ['TOTAL CABINETS:',    (job.total_cabinet_count || 0).toLocaleString()],
      ['HARDWARE ALLOW.:',   hardware > 0 ? fmtMoney(hardware) : 'Not included'],
    ]

    const LBL_W  = 108
    const RLBL_W = 92
    let sy = 600
    specL.forEach(([lbl, val]) => {
      dt(lbl, ML, sy, { size: 7.5, color: gray })
      dt(val, ML + LBL_W, sy, { size: 7.5, maxWidth: MID - ML - LBL_W - 8 })
      sy -= 11
    })
    sy = 600   // start below the DESCRIPTION bar, same as left column (was 642 — overlapped CONTACT block and bar)
    specR.forEach(([lbl, val]) => {
      dt(lbl, COL_R, sy, { size: 7.5, color: gray })
      dt(val, COL_R + RLBL_W, sy, { size: 7.5 })
      sy -= 11
    })

    const afterSpecs = 600 - (Math.max(specL.length, specR.length) * 11) - 4
    dline(afterSpecs)

    // ═══════════════════════════════════════════════════════════════════════
    // UNIT TYPE BREAKDOWN
    // ═══════════════════════════════════════════════════════════════════════
    let uy = afterSpecs - 18   // 18pt gap: separator → UNIT TYPE bar (vs. old 13pt which left only 1pt visual gap)
    drect(ML, uy, PW, 12, darkGreen)
    dt('UNIT TYPE BREAKDOWN', ML + PW / 2 - bold.widthOfTextAtSize('UNIT TYPE BREAKDOWN', 8) / 2, uy + 4, { bold: true, size: 8, color: white })
    uy -= 13

    drect(ML, uy, PW, 12, lgray)
    dt('Unit Type',  ML + 6,   uy + 3, { size: 7, bold: true, color: gray })
    dt('Units',      ML + 280, uy + 3, { size: 7, bold: true, color: gray })
    dt('Cabinets',   ML + 330, uy + 3, { size: 7, bold: true, color: gray })
    dt('Mfr Price',  ML + 408, uy + 3, { size: 7, bold: true, color: gray })
    uy -= 12

    displayUnits.forEach((ut, i) => {
      if (i % 2 === 0) drect(ML, uy, PW, 11, mintBg)
      dt(ut.unit_type_name, ML + 6,   uy + 2, { size: 7, maxWidth: 265 })
      dt(String(ut.unit_quantity || 1), ML + 283, uy + 2, { size: 7 })
      dt(String(ut.cabinet_count  || 0), ML + 333, uy + 2, { size: 7 })
      dt(ut.manufacturer_price ? fmtMoney(ut.manufacturer_price) : '—', ML + 411, uy + 2, { size: 7 })
      uy -= 11
    })
    // TOTALS row
    drect(ML, uy, PW, 12, rgb(0.88, 0.95, 0.90))
    dt('TOTALS', ML + 6, uy + 3, { bold: true, size: 7 })
    dt(String(sortedUnits.reduce((s, u) => s + (u.unit_quantity || 1), 0)), ML + 283, uy + 3, { bold: true, size: 7 })
    dt(String(sortedUnits.reduce((s, u) => s + (u.cabinet_count || 0) * (u.unit_quantity || 1), 0).toLocaleString()), ML + 333, uy + 3, { bold: true, size: 7 })
    dt(unitPriceSum > 0 ? fmtMoney(unitPriceSum) : '—', ML + 411, uy + 3, { bold: true, size: 7 })
    uy -= 12

    if (sortedUnits.length > 13) {
      dt(`+ ${sortedUnits.length - 13} more unit types — see attached cabinet schedule`, ML + 6, uy + 2, { size: 7, color: gray })
      uy -= 11
    }

    dline(uy - 3)

    // ═══════════════════════════════════════════════════════════════════════
    // PRICING SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    let py = uy - 12
    drect(ML, py, PW, 12, darkGreen)
    dt('PRICING SUMMARY', ML + PW / 2 - bold.widthOfTextAtSize('PRICING SUMMARY', 8) / 2, py + 4, { bold: true, size: 8, color: white })
    py -= 15

    // Base cabinet price
    dt('Base Cabinet Price', ML + 6, py, { size: 8, color: gray })
    dt(discount > 0 ? '(includes dealer discount & markup)' : '(includes markup)', ML + 6, py - 9, { size: 6.5, color: dgray })
    rAlign(fmtMoney(cabsToGC), MR - 4, py, { size: 8 })
    py -= 20

    if (freight > 0) {
      dt('Freight (pass-through)', ML + 6, py, { size: 8, color: gray })
      rAlign(fmtMoney(freight), MR - 4, py, { size: 8 })
      py -= 14
    }
    if (mfrTax > 0) {
      const effRate = grossCost > 0 ? ((mfrTax / grossCost) * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : null
      dt(`Sales Tax${effRate ? ` (${effRate}%)` : ''} — from manufacturer quote`, ML + 6, py, { size: 8, color: gray })
      rAlign(fmtMoney(mfrTax), MR - 4, py, { size: 8 })
      py -= 14
    }

    // Hardware allowance
    if (hwToGC > 0) {
      dt('Hardware Allowance', ML + 6, py, { size: 8, color: gray })
      if (hwCost > 0) dt(`(${effHwPieces.toLocaleString()} pieces @ margin)`, ML + 6, py - 9, { size: 6.5, color: dgray })
      rAlign(fmtMoney(hwToGC), MR - 4, py, { size: 8 })
      py -= hwCost > 0 ? 18 : 14
    } else {
      dt('Hardware Allowance', ML + 6, py, { size: 8, color: gray })
      rAlign('Not included — see separate quote', MR - 4, py, { size: 7.5, color: dgray })
      py -= 14
    }

    // Sales tax
    if (salesTax > 0) {
      dt(`Sales Tax (${salesTax}%)`, ML + 6, py, { size: 8, color: gray })
      rAlign(fmtMoney(taxAmount), MR - 4, py, { size: 8 })
      py -= 14
    }

    // Notes
    if (notes) {
      dt('Notes: ' + notes, ML + 6, py, { size: 7, color: gray, maxWidth: PW - 12 })
      py -= 12
    }

    py -= 4
    // TOTAL box — brand green
    const boxH = 34
    drect(ML, py - boxH, PW, boxH, brandGreen)
    dt('TOTAL PROJECT PRICE', ML + 10, py - 13, { bold: true, size: 9, color: white })
    rAlign(fmtMoney(totalBid), MR - 10, py - 13, { bold: true, size: 15, color: white })
    dt('Includes cabinets, hardware allowance & applicable sales tax', ML + 10, py - 26, { size: 6, color: rgb(0.88, 0.97, 0.90) })
    py -= boxH + 10

    dline(py)
    py -= 10

    // ═══════════════════════════════════════════════════════════════════════
    // INCLUDED / ASSEMBLY / NOT INCLUDED / NOTES
    // ═══════════════════════════════════════════════════════════════════════
    dt('INCLUDED IN BID:', ML, py, { bold: true, size: 7.5, color: darkGreen })
    py -= 10
    SEC.includedInBid.split('\n').filter(l => l.trim()).forEach(line => {
      dt(line.trim(), ML + 8, py, { size: 7, color: gray, maxWidth: PW - 8 })
      py -= 10
    })
    py -= 3

    dt('ASSEMBLY, STAGING & INSTALLATION:', ML, py, { bold: true, size: 7.5, color: darkGreen })
    py -= 10
    SEC.assembly.split('\n').filter(l => l.trim()).forEach(line => {
      dt(line.trim(), ML + 8, py, { size: 7, color: gray, maxWidth: PW - 8 })
      py -= 10
    })
    py -= 3

    dt('NOT INCLUDED IN BID:', ML, py, { bold: true, size: 7.5, color: darkGreen })
    py -= 10
    SEC.notIncluded.split('\n').filter(l => l.trim()).forEach(line => {
      dt(`• ${line.trim().replace(/^[•\-]\s*/, '')}`, ML + 8, py, { size: 6.5, color: gray, maxWidth: PW - 8 })
      py -= 9
    })

    dline(py - 2)
    py -= 10

    dt('NOTES:', ML, py, { bold: true, size: 7, color: darkGreen })
    dt(SEC.bottomNotes, ML + 36, py, { size: 6.5, color: gray, maxWidth: PW - 36 })
    py -= 11
    dt('Thank you for the opportunity to submit our proposal. Unit pricing honored for 90 days from proposal date. All quantities estimated — field measurements and approved shop drawings will prevail.', ML, py, { size: 6.5, color: gray, maxWidth: PW })
    py -= 14

    // Signature
    dt('Accepted by:', ML, py, { size: 8 })
    page.drawLine({ start: { x: ML + 78, y: py - 2 }, end: { x: ML + 290, y: py - 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
    dt('Date:', MR - 130, py, { size: 8 })
    page.drawLine({ start: { x: MR - 95, y: py - 2 }, end: { x: MR, y: py - 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })

    // Footer
    drect(ML, 30, PW, 2, brandGreen)
    dt('CORPORATE OFFICES: 23463 E. Moraine Pl., Aurora, CO 80016  |  CONTACT: Pamela Isetts, President  |  651/301-1063  |  pam@mdsgcabinets.com  |  csr@mdsgcabinets.com', ML, 20, { size: 6.5, color: gray, maxWidth: PW })

    // ── Save + log ────────────────────────────────────────────────────────
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
