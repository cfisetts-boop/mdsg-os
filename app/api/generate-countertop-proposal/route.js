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

export async function POST(request) {
  try {
    const {
      jobId, unitTypes = [], totals = {}, wastePct = 10, propConfig = {},
      sender = 'Cole', bidSections = {}, marginPct = 20, grossCostOverride = 0,
      notes = '', hideUnitPricing = false, totalOnly = false, brandAs = 'mdsg',
    } = await request.json()

    let job = null
    if (jobId) {
      const { data } = await supabase.from('jobs').select('*').eq('id', jobId).single()
      job = data
    }

    const SEC = {
      includedInBid: bidSections.includedInBid ?? 'Sales Tax  |  Delivery to Job Site  |  Sink cutouts per sink specifications',
      assembly: bidSections.assembly ?? 'By Greenworks Renovations under separate contract — Contact: Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com',
      notIncluded: bidSections.notIncluded ?? 'Installation — under separate contract with Greenworks Renovations\nPlumbing connections, faucets, undermount sink brackets\nTile backsplash installation or materials',
      bottomNotes: bidSections.bottomNotes ?? 'Final price subject to approved shop drawings. All quantities are estimated — field measurements and approved shop drawings will prevail.',
    }

    // ── Pricing ───────────────────────────────────────────────────────────
    const cost   = Number(grossCostOverride) || Number(propConfig.materialCost) || 0
    const margin = Math.min(Math.max(Number(marginPct) || 0, 0), 60)
    const sell   = cost > 0 ? Math.round((cost / (1 - margin / 100)) * 100) / 100 : 0
    if (!sell) return Response.json({ error: 'No countertop cost — upload/pick a CT quote or enter material cost first' }, { status: 422 })

    const isGW = brandAs === 'greenworks'
    const today = new Date()
    const validUntil = new Date(today); validUntil.setDate(validUntil.getDate() + 90)
    const fmtDate  = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const fmtMoney = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const proposalNum = `${isGW ? 'GW' : 'MDSG'}-CT-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}${job ? '-' + (job.name || 'JOB').substring(0,3).toUpperCase() : ''}`

    const pdfDoc  = await PDFDocument.create()
    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
    let logo = null
    try { if (!isGW) logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png'))) } catch {}

    const brandGreen = rgb(0.44, 0.61, 0.47), darkGreen = rgb(0.26, 0.40, 0.28)
    const white = rgb(1,1,1), black = rgb(0.13,0.13,0.13)
    const gray = rgb(0.45,0.45,0.45), lgray = rgb(0.94,0.94,0.94), dgray = rgb(0.60,0.60,0.60)
    const mintBg = rgb(0.94, 0.97, 0.95)
    const ML = 50, PW = 512, MR = ML + PW

    let page = pdfDoc.addPage(PageSizes.Letter)
    const mk = () => ({
      dt: (t, x, y, o = {}) => { if (t == null) return; page.drawText(String(t), { x, y, size: o.size||9, font: o.bold?bold:regular, color: o.color||black, maxWidth: o.maxWidth||(MR-x) }) },
      dline: (y) => page.drawLine({ start:{x:ML,y}, end:{x:MR,y}, thickness:0.5, color:rgb(0.80,0.85,0.81) }),
      drect: (x,y,w,h,c) => page.drawRectangle({x,y,width:w,height:h,color:c}),
      rAlign: (t,rx,y,o={}) => { const f=o.bold?bold:regular; page.drawText(String(t), { x: rx - f.widthOfTextAtSize(String(t), o.size||9), y, size:o.size||9, font:f, color:o.color||black }) },
    })
    let { dt, dline, drect, rAlign } = mk()

    const header = () => {
      if (logo) { const d = logo.scaleToFit(100, 26); page.drawImage(logo, { x: ML+6, y: 764, width: d.width, height: d.height }) }
      const coX = isGW ? ML + 6 : ML + 118
      dt(isGW ? 'GREENWORKS RENOVATIONS LLC' : 'MANUFACTURER DIRECT SALES GROUP, LLC', coX, 780, { bold:true, size:11.5, color:darkGreen })
      dt(isGW ? 'Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com' : '23463 E. Moraine Pl., Aurora, CO 80016  |  mdsgcabinets.com', coX, 767, { size:7.5, color:brandGreen })
      drect(ML, 744, PW, 18, darkGreen)
      dt('COUNTERTOP PROPOSAL', ML+10, 750, { bold:true, size:10, color:white })
      rAlign(`Proposal No. ${proposalNum}`, MR-8, 750, { size:8, color:rgb(0.80,0.92,0.82) })
    }
    header()

    let y = 726
    // Customer block
    dt('CUSTOMER', ML, y, { size:6.5, color:gray, bold:true })
    rAlign(`Date: ${fmtDate(today)}`, MR, y, { size:8, color:gray })
    y -= 12
    dt(job?.gc_name || '—', ML, y, { size:10, bold:true }); y -= 12
    dt(job?.name || '', ML, y, { size:8.5 }); y -= 11
    const addr = job ? [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ') : ''
    if (addr) { dt(addr, ML, y, { size:7.5, color:gray }); y -= 11 }
    y -= 4; dline(y); y -= 16

    // Scope band
    const sqft = Number(totals.totalSqft) || 0
    const sqftWaste = sqft > 0 ? Math.round(sqft * (1 + (Number(wastePct)||0)/100)) : 0
    drect(ML, y-6, PW, 20, mintBg)
    dt('PROJECT SCOPE', ML+8, y, { bold:true, size:8, color:darkGreen })
    const scopeBits = []
    if (unitTypes.length) scopeBits.push(`${unitTypes.length} unit types`)
    if (Number(totals.totalSets) > 0) scopeBits.push(`${Number(totals.totalSets).toLocaleString()} sets`)
    if (sqft > 0) scopeBits.push(`${sqft.toLocaleString()} SF net · ~${sqftWaste.toLocaleString()} SF w/ ${wastePct}% waste`)
    if (propConfig.material) scopeBits.push(propConfig.material)
    rAlign(scopeBits.join('   ·   ') || 'Countertop supply per plans & specifications', MR-8, y, { size:8, color:darkGreen })
    y -= 26

    // Unit table (skippable)
    if (!hideUnitPricing && !totalOnly && unitTypes.length) {
      drect(ML, y-4, PW, 14, darkGreen)
      dt('UNIT TYPE', ML+8, y, { bold:true, size:7, color:white })
      dt('SETS', ML+300, y, { bold:true, size:7, color:white })
      dt('SQFT', ML+380, y, { bold:true, size:7, color:white })
      y -= 15
      let alt = false
      for (const ut of unitTypes.slice(0, 24)) {
        if (y < 210) break
        if (alt) drect(ML, y-3.5, PW, 12, mintBg)
        alt = !alt
        dt(String(ut.name || ut.unit_type || '—').substring(0, 52), ML+8, y, { size:7.5 })
        dt(String(ut.sets ?? ut.quantity ?? ''), ML+300, y, { size:7.5 })
        dt(ut.sqft ? Number(ut.sqft).toLocaleString() : '', ML+380, y, { size:7.5 })
        y -= 12
      }
      y -= 8; dline(y); y -= 16
    }

    // Pricing
    if (totalOnly) {
      drect(ML, y-14, PW, 30, darkGreen)
      dt('TOTAL — COUNTERTOP SUPPLY', ML+10, y-4, { bold:true, size:10, color:white })
      rAlign(fmtMoney(sell), MR-10, y-4, { bold:true, size:13, color:white })
      y -= 38
    } else {
      drect(ML, y-4, PW, 14, darkGreen)
      dt('PRICING', ML+8, y, { bold:true, size:7, color:white })
      y -= 17
      dt('Countertop Material, Fabrication & Delivery', ML+8, y, { size:8.5 })
      rAlign(fmtMoney(sell), MR-8, y, { size:8.5 })
      y -= 13
      dt(`Includes ${wastePct}% waste factor on ordered quantities`, ML+8, y, { size:6.5, color:dgray })
      y -= 20
      drect(ML, y-8, PW, 20, darkGreen)
      dt('TOTAL', ML+10, y-2, { bold:true, size:9, color:white })
      rAlign(fmtMoney(sell), MR-10, y-2, { bold:true, size:11, color:white })
      y -= 30
    }

    // Sections
    const section = (label, text) => {
      if (!text || !text.trim()) return
      const lines = text.split('\n').filter(Boolean)
      const need = 16 + lines.length * 10
      if (y - need < 120) { page = pdfDoc.addPage(PageSizes.Letter); ({ dt, dline, drect, rAlign } = mk()); header(); y = 716 }
      dt(label, ML, y, { bold:true, size:7.5, color:darkGreen }); y -= 11
      for (const ln of lines) { dt(ln.replace(/^[-•]\s*/, '•  '), ML+8, y, { size:7.5, color:gray, maxWidth: PW-16 }); y -= 10 }
      y -= 8
    }
    section('INCLUDED IN BID', SEC.includedInBid.split('|').map(s=>s.trim()).join('\n'))
    if (!isGW) section('ASSEMBLY & INSTALLATION', SEC.assembly)
    section('NOT INCLUDED', SEC.notIncluded)
    if (notes && notes.trim()) section('PROPOSAL NOTES', notes)
    section('TERMS', SEC.bottomNotes + `\nProposal valid through ${fmtDate(validUntil)}.`)

    // Sender block
    if (y < 130) { page = pdfDoc.addPage(PageSizes.Letter); ({ dt, dline, drect, rAlign } = mk()); header(); y = 716 }
    y = Math.min(y, 150)
    dline(y); y -= 14
    const si = isGW
      ? { name: 'Anthony (Willy) Ramirez', title: 'Greenworks Renovations LLC', phone: '619-718-1578', email: 'greenworksrenovationsllc@gmail.com' }
      : (SENDERS[sender] || SENDERS.Cole)
    dt('Prepared by', ML, y, { size:6.5, color:gray, bold:true }); y -= 12
    dt(si.name, ML, y, { size:9, bold:true })
    rAlign(si.phone || '', MR, y, { size:8, color:gray }); y -= 11
    dt(si.title, ML, y, { size:7.5, color:gray })
    rAlign(si.email, MR, y, { size:8, color:gray })

    const bytes = await pdfDoc.save()
    if (jobId) {
      await supabase.from('activity_log').insert({ job_id: jobId, user_name: si.name, action: `CT proposal generated — ${proposalNum} · ${fmtMoney(sell)} · ${margin}% margin${isGW ? ' · Greenworks-branded' : ''}` })
    }
    return new Response(Buffer.from(bytes), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${proposalNum}.pdf"` },
    })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
