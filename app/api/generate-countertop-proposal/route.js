import { createClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib'
import { readFileSync } from 'fs'
import { join } from 'path'

// Compute per-unit countertop totals (mirrors CountertopCalc.js logic)
function unitCalc(ut) {
  const KD = 25, VD = 22, SH = 18
  const sf = (lf, d) => ((lf||0) * (d||0)) / 144
  const kRuns  = ut.kitchen?.runs          || []
  const vRuns  = ut.vanity?.runs           || []
  const splashes = ut.kitchen?.side_splashes || []
  const kSF    = kRuns.reduce((s,r) => s + sf(r.lf, r.depth_in||KD), 0)
  const vSF    = vRuns.reduce((s,r) => s + sf(r.lf, r.depth_in||VD), 0)
  const kLF    = kRuns.reduce((s,r) => s + (r.lf||0), 0)
  const vLF    = vRuns.reduce((s,r) => s + (r.lf||0), 0)
  const backLF = ut.kitchen?.backsplash_lf || kLF
  const sideSF = splashes.reduce((s,sp) => s + sf(sp.height_in||SH, sp.depth_in||KD), 0)
  const sidesLF = splashes.reduce((s,sp) => s + (sp.depth_in||KD)/12, 0)
  const cuts   = [...kRuns,...vRuns].filter(r=>r.has_sink).length
  return { kSF, vSF, kLF, vLF, backLF, sideSF, sidesLF, cuts }
}

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const { jobId, unitTypes = [], totals, wastePct = 10, propConfig = {} } = await request.json()

    let job = null
    if (jobId) {
      const { data } = await supabase.from('jobs').select('*').eq('id', jobId).single()
      job = data
    }

    const withWaste  = (totals.materialSF || 0) * (1 + wastePct / 100)
    const today      = new Date()
    const validUntil = new Date(today); validUntil.setDate(validUntil.getDate() + 90)
    const fmtDate    = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const f1         = (n) => (typeof n === 'number' ? n.toFixed(1) : String(n || '—'))
    const proposalNum = `MDSG-CT-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}${job ? '-' + job.name.substring(0,3).toUpperCase() : ''}`

    // ── Build PDF (2 pages) ───────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create()
    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)

    let logo = null
    try { logo = await pdfDoc.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png'))) } catch {}

    // Colors — sage green brand
    const brandGreen = rgb(0.44, 0.61, 0.47)
    const darkGreen  = rgb(0.26, 0.40, 0.28)
    const tealGreen  = rgb(0.10, 0.48, 0.42)
    const amber      = rgb(0.60, 0.35, 0.05)
    const white = rgb(1,1,1), black = rgb(0.13,0.13,0.13)
    const gray  = rgb(0.45,0.45,0.45), lgray = rgb(0.94,0.94,0.94)
    const dgray = rgb(0.60,0.60,0.60)

    const ML = 50, PW = 512, MR = ML + PW, MID = ML + 256

    function makePage() {
      const page = pdfDoc.addPage(PageSizes.Letter)
      const dt = (text, x, y, opts = {}) => {
        if (text === null || text === undefined) return
        page.drawText(String(text), { x, y, size: opts.size||9, font: opts.bold?bold:regular, color: opts.color||black, maxWidth: opts.maxWidth||(MR-x) })
      }
      const dline = (y, x1=ML, x2=MR) => page.drawLine({ start:{x:x1,y}, end:{x:x2,y}, thickness:0.5, color:rgb(0.80,0.85,0.81) })
      const drect = (x,y,w,h,color) => page.drawRectangle({x,y,width:w,height:h,color})
      const rAlign = (text, rx, y, opts={}) => {
        const f = opts.bold ? bold : regular
        dt(text, rx - f.widthOfTextAtSize(String(text), opts.size||9), y, opts)
      }
      return { page, dt, dline, drect, rAlign }
    }

    function pageHeader(dt, drect, page, title, subline) {
      drect(ML, 762, PW, 30, white)
      if (logo) {
        const d = logo.scaleToFit(100, 26)
        page.drawImage(logo, { x: ML+6, y: 764, width: d.width, height: d.height })
      }
      dt('MANUFACTURER DIRECT SALES GROUP, LLC', ML+118, 780, { bold:true, size:11.5, color:darkGreen })
      dt('23463 E. Moraine Pl., Aurora, CO 80016  |  mdsgcabinets.com', ML+118, 767, { size:7.5, color:brandGreen })
      drect(ML, 744, PW, 18, darkGreen)
      dt(title, ML+10, 750, { bold:true, size:9.5, color:white })
      if (subline) dt(subline, MR-8-(bold.widthOfTextAtSize(subline,7.5)), 750, { size:7.5, color:rgb(0.80,0.92,0.82) })
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 1 — Proposal / Specifications / Takeoff Summaries
    // ══════════════════════════════════════════════════════════════════════
    const { page: p1, dt, dline, drect, rAlign } = makePage()

    pageHeader(dt, drect, p1, `${propConfig.material_type?.toUpperCase()||'COUNTERTOP'} PROPOSAL`, `Proposal No. ${proposalNum}`)

    // Info block
    dt('DATE / VALID UNTIL', ML, 740, { size:6.5, color:gray, bold:true })
    dt('CUSTOMER',           MID+14, 740, { size:6.5, color:gray, bold:true })
    dt(fmtDate(today),       ML, 729, { size:8.5 })
    if (job) {
      dt(job.gc_name||'—',   MID+14, 729, { size:9, bold:true, maxWidth:MR-MID-14 })
      dt(job.name,           MID+14, 718, { size:8, maxWidth:MR-MID-14 })
      const addr = [job.address,job.city,job.state,job.zip].filter(Boolean).join(', ')
      if (addr) dt(addr, MID+14, 707, { size:7.5, color:gray, maxWidth:MR-MID-14 })
    }
    dt('Valid until: '+fmtDate(validUntil), ML, 718, { size:7.5, color:gray })
    dline(699)

    // Specs
    const totalUnitsAll = unitTypes.reduce((s,u)=>s+(u.unit_quantity||1),0)
    const specL = [['MATERIAL TYPE:', propConfig.material_type||'—'], ['FABRICATOR:', propConfig.fabricator||'—'], ['COLOR / PATTERN:', propConfig.color||'TBD'], ['THICKNESS:', propConfig.thickness||'3CM'], ['EDGE PROFILE:', propConfig.edge||'Eased Edge']]
    const specR = [['NO. OF UNITS:', String(job?.total_residential_units||totalUnitsAll)], ['UNIT TYPES:', String(unitTypes.length)], ['SINK CUTOUTS:', String(totals.cuts||0)]]
    let sy = 689
    dt('SPECIFICATIONS', ML, 695, { bold:true, size:9, color:darkGreen }); sy = 683
    specL.forEach(([lb,v])=>{ dt(lb,ML,sy,{size:7.5,color:gray}); dt(v,ML+110,sy,{size:7.5}); sy-=11 })
    sy = 683
    specR.forEach(([lb,v])=>{ dt(lb,MID+14,sy,{size:7.5,color:gray}); dt(v,MID+100,sy,{size:7.5}); sy-=11 })

    const afterSpecs = Math.min(683-(specL.length*11)-4, 683-(specR.length*11)-4)
    dline(afterSpecs)

    // ── SQUARE FOOTAGE TAKEOFF SUMMARY ─────────────────────────────────────
    let py = afterSpecs - 14
    drect(ML, py, PW, 12, darkGreen)
    dt('SQUARE FOOTAGE TAKEOFF — SUMMARY', ML + PW/2 - bold.widthOfTextAtSize('SQUARE FOOTAGE TAKEOFF — SUMMARY',8)/2, py+4, { bold:true, size:8, color:white })
    py -= 14

    drect(ML, py, PW, 12, lgray)
    const sfCols = [['Unit Type',ML+6,190], ['Units',ML+198,28], ['Kitchen SF',ML+232,52], ['Vanity SF',ML+288,52], ['Side SF',ML+344,48], ['Material SF/Unit',ML+396,72], ['Total SF',ML+470,42]]
    sfCols.forEach(([h,x])=>dt(h,x,py+3,{size:6.5,bold:true,color:gray}))
    py -= 13

    let grandKSF=0, grandVSF=0, grandSideSF=0, grandMatSF=0
    unitTypes.forEach((ut,i)=>{
      const qty = ut.unit_quantity||1
      const c = unitCalc(ut)
      const matPerUnit = c.kSF+c.vSF+c.sideSF
      if (i%2===0) drect(ML,py,PW,11,rgb(0.97,0.97,0.97))
      dt(ut.unit_type_name, ML+6, py+2, {size:6.5, maxWidth:188})
      dt(String(qty),       ML+198, py+2, {size:6.5})
      dt(f1(c.kSF*qty),     ML+232, py+2, {size:6.5})
      dt(f1(c.vSF*qty),     ML+288, py+2, {size:6.5})
      dt(f1(c.sideSF*qty),  ML+344, py+2, {size:6.5})
      dt(f1(matPerUnit),    ML+396, py+2, {size:6.5})
      dt(f1(matPerUnit*qty),ML+470, py+2, {size:6.5})
      grandKSF+=c.kSF*qty; grandVSF+=c.vSF*qty; grandSideSF+=c.sideSF*qty; grandMatSF+=matPerUnit*qty
      py -= 11
    })
    // Totals row
    drect(ML, py, PW, 12, rgb(0.88,0.95,0.90))
    dt('PROJECT TOTALS', ML+6, py+3, {bold:true, size:6.5})
    dt(f1(grandKSF),    ML+232, py+3, {bold:true, size:6.5})
    dt(f1(grandVSF),    ML+288, py+3, {bold:true, size:6.5})
    dt(f1(grandSideSF), ML+344, py+3, {bold:true, size:6.5})
    dt(f1(grandMatSF),  ML+470, py+3, {bold:true, size:6.5})
    py -= 12
    dline(py-2)

    // ── LINEAL FOOTAGE TAKEOFF SUMMARY ─────────────────────────────────────
    py -= 10
    drect(ML, py, PW, 12, tealGreen)
    dt('LINEAL FOOTAGE TAKEOFF — SUMMARY', ML + PW/2 - bold.widthOfTextAtSize('LINEAL FOOTAGE TAKEOFF — SUMMARY',8)/2, py+4, { bold:true, size:8, color:white })
    py -= 14

    drect(ML, py, PW, 12, lgray)
    const lfCols = [['Unit Type',ML+6], ['Units',ML+198], ['Kitchen LF',ML+232], ['Vanity LF',ML+295], ['Total LF/Unit',ML+358], ['Total LF',ML+428], ['Backsplash LF',ML+468]]
    lfCols.forEach(([h,x])=>dt(h,x,py+3,{size:6.5,bold:true,color:gray}))
    py -= 13

    let grandKLF=0, grandVLF=0, grandBackLF=0
    unitTypes.forEach((ut,i)=>{
      const qty = ut.unit_quantity||1
      const c = unitCalc(ut)
      const totalPerUnit = c.kLF+c.vLF
      if (i%2===0) drect(ML,py,PW,11,rgb(0.97,0.97,0.97))
      dt(ut.unit_type_name, ML+6,  py+2, {size:6.5, maxWidth:188})
      dt(String(qty),       ML+198,py+2, {size:6.5})
      dt(f1(c.kLF),         ML+232,py+2, {size:6.5})
      dt(f1(c.vLF),         ML+295,py+2, {size:6.5})
      dt(f1(totalPerUnit),  ML+358,py+2, {size:6.5})
      dt(f1(totalPerUnit*qty), ML+428, py+2, {size:6.5})
      dt(f1(c.backLF*qty),  ML+468,py+2, {size:6.5})
      grandKLF+=c.kLF*qty; grandVLF+=c.vLF*qty; grandBackLF+=c.backLF*qty
      py -= 11
    })
    drect(ML, py, PW, 12, rgb(0.88,0.93,0.95))
    dt('PROJECT TOTALS', ML+6, py+3, {bold:true, size:6.5})
    dt(f1(grandKLF),  ML+232,py+3, {bold:true, size:6.5})
    dt(f1(grandVLF),  ML+295,py+3, {bold:true, size:6.5})
    dt(f1(grandKLF+grandVLF), ML+428, py+3, {bold:true, size:6.5})
    dt(f1(grandBackLF), ML+468, py+3, {bold:true, size:6.5})
    py -= 12
    dline(py-2)

    // ── ORDER SUMMARY BOXES ───────────────────────────────────────────────
    py -= 14
    // SF box
    const boxH = 38
    drect(ML, py-boxH, PW/2-4, boxH, darkGreen)
    dt('TOTAL MATERIAL SF (ORDER QTY)', ML+8, py-14, { bold:true, size:7.5, color:white })
    rAlign(`${withWaste.toFixed(1)} SF`, ML+PW/2-10, py-14, { bold:true, size:15, color:white })
    dt(`${f1(grandMatSF)} SF material + ${wastePct}% waste`, ML+8, py-27, { size:6, color:rgb(0.75,0.95,0.80) })

    // LF box
    const lfBoxX = ML + PW/2 + 4
    drect(lfBoxX, py-boxH, PW/2-4, boxH, tealGreen)
    dt('TOTAL LINEAL FOOTAGE', lfBoxX+8, py-14, { bold:true, size:7.5, color:white })
    rAlign(`${f1(grandKLF+grandVLF)} LF`, MR-8, py-14, { bold:true, size:15, color:white })
    dt(`Kitchen: ${f1(grandKLF)} LF  +  Vanity: ${f1(grandVLF)} LF`, lfBoxX+8, py-27, { size:6, color:rgb(0.75,0.95,0.95) })
    py -= boxH + 10

    // Backsplash note
    drect(ML, py-14, PW, 14, rgb(0.97,0.97,0.90))
    dt('Backsplash LF:', ML+8, py-9, { size:8, color:amber })
    dt(`${f1(grandBackLF)} LF`, ML+80, py-9, { bold:true, size:8, color:amber })
    dt('(= total kitchen counter lineal footage requiring tile/backsplash material)', ML+120, py-9, { size:7, color:dgray })
    dt('Sink Cutouts:', ML+370, py-9, { size:8, color:gray })
    dt(String(totals.cuts||0), ML+430, py-9, { bold:true, size:8 })
    py -= 20

    dline(py)
    py -= 10

    // Included / Not Included
    dt('INCLUDED IN BID:', ML, py, { bold:true, size:7.5, color:darkGreen }); py -= 10
    dt('Sales Tax  |  Delivery to Job Site  |  Sink cutouts per sink specifications', ML+8, py, { size:7, color:gray }); py -= 13
    dt('INSTALLATION:', ML, py, { bold:true, size:7.5, color:darkGreen }); py -= 10
    dt('By Greenworks Renovations under separate contract — Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com', ML+8, py, { size:7, color:gray, maxWidth:PW-8 }); py -= 13
    dt('NOT INCLUDED IN BID:', ML, py, { bold:true, size:7.5, color:darkGreen }); py -= 10
    ;['Installation — under separate contract with Greenworks Renovations', 'Plumbing connections, faucets, undermount sink brackets', 'Tile backsplash installation or materials', 'Model unit "Out of Phase" delivery']
      .forEach(l=>{ dt(`• ${l}`, ML+8, py, {size:6.5, color:gray, maxWidth:PW-8}); py-=9 })

    dline(py-2); py -= 10
    dt('NOTES:', ML, py, { bold:true, size:7, color:darkGreen })
    dt('Final price subject to approved shop drawings. All quantities are estimated — field measurements prevail.', ML+36, py, { size:6.5, color:gray, maxWidth:PW-36 }); py -= 11
    dt('Thank you for the opportunity. Unit pricing honored for 90 days from proposal date.', ML, py, { size:6.5, color:gray }); py -= 14

    dt('Accepted by:', ML, py, { size:8 })
    p1.drawLine({ start:{x:ML+78,y:py-2}, end:{x:ML+290,y:py-2}, thickness:0.5, color:rgb(0.6,0.6,0.6) })
    dt('Date:', MR-130, py, { size:8 })
    p1.drawLine({ start:{x:MR-95,y:py-2}, end:{x:MR,y:py-2}, thickness:0.5, color:rgb(0.6,0.6,0.6) })

    // Footer p1
    p1.drawLine({ start:{x:ML,y:32}, end:{x:MR,y:32}, thickness:1.5, color:brandGreen })
    dt('CORPORATE OFFICES: 23463 E. Moraine Pl., Aurora, CO 80016  |  Pamela Isetts, President  |  651/301-1063  |  pam@mdsgcabinets.com  |  csr@mdsgcabinets.com', ML, 20, { size:6.5, color:gray, maxWidth:PW })

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 2 — Detailed run-by-run takeoff
    // ══════════════════════════════════════════════════════════════════════
    const { page: p2, dt: dt2, dline: dl2, drect: dr2, rAlign: ra2 } = makePage()

    pageHeader(dt2, dr2, p2, 'DETAILED COUNTERTOP TAKEOFF — BY UNIT TYPE', `${proposalNum} · Page 2`)

    let dp = 730
    dl2(dp); dp -= 12

    unitTypes.forEach(ut => {
      const qty = ut.unit_quantity || 1
      const c   = unitCalc(ut)
      const kRuns  = ut.kitchen?.runs || []
      const vRuns  = ut.vanity?.runs  || []
      const splashes = ut.kitchen?.side_splashes || []

      if (dp < 100) return  // safety — would need page 3 for very large projects

      // Unit type header
      dr2(ML, dp, PW, 13, darkGreen)
      dt2(`${ut.unit_type_name}`, ML+6, dp+3, { bold:true, size:8, color:white })
      dt2(`${qty} unit${qty!==1?'s':''}`, ML+200, dp+3, { size:7.5, color:rgb(0.80,0.92,0.82) })
      dt2(`Kitchen: ${f1(c.kSF*qty)} SF  |  ${f1(c.kLF*qty)} LF     Vanity: ${f1(c.vSF*qty)} SF  |  ${f1(c.vLF*qty)} LF     Material: ${f1((c.kSF+c.vSF+c.sideSF)*qty)} SF`, ML+250, dp+3, { size:7, color:rgb(0.80,0.92,0.82) })
      dp -= 12

      // SF sub-section
      if (kRuns.length) {
        dt2('KITCHEN', ML+6, dp, { size:6.5, bold:true, color:brandGreen }); dp -= 9
        dr2(ML, dp, PW, 10, lgray)
        ;['Run', 'LF/Unit', 'Depth"', 'SF/Unit', 'Total LF', 'Total SF', 'Sink'].forEach((h,i) => {
          const xs = [ML+6, ML+106, ML+166, ML+220, ML+280, ML+340, ML+410]
          dt2(h, xs[i], dp+2, { size:6, bold:true, color:gray })
        })
        dp -= 10
        kRuns.forEach(run => {
          const runSF = ((run.lf||0)*(run.depth_in||25))/144
          ;[run.label||'Run', f1(run.lf||0)+'\'', String(run.depth_in||25)+'"', f1(runSF), f1((run.lf||0)*qty)+'\'', f1(runSF*qty), run.has_sink?'Sink cutout':'—'].forEach((v,i) => {
            const xs = [ML+6, ML+106, ML+166, ML+220, ML+280, ML+340, ML+410]
            dt2(v, xs[i], dp, { size:6.5 })
          })
          dp -= 9
        })
        if (splashes.length) {
          dt2('Side/End Splashes:', ML+6, dp, { size:6.5, color:gray })
          splashes.forEach(sp => {
            const spSF = ((sp.depth_in||25)*(sp.height_in||18))/144
            dt2(`${sp.label||'Splash'}: ${sp.depth_in||25}"D × ${sp.height_in||18}"H = ${f1(spSF)} SF/unit (${f1(spSF*qty)} total)`, ML+90, dp, { size:6.5 })
            dp -= 9
          })
        }
      }

      if (vRuns.length) {
        dt2('VANITY', ML+6, dp, { size:6.5, bold:true, color:tealGreen }); dp -= 9
        dr2(ML, dp, PW, 10, lgray)
        ;['Run', 'LF/Unit', 'Depth"', 'SF/Unit', 'Total LF', 'Total SF', 'Sink'].forEach((h,i) => {
          const xs = [ML+6, ML+106, ML+166, ML+220, ML+280, ML+340, ML+410]
          dt2(h, xs[i], dp+2, { size:6, bold:true, color:gray })
        })
        dp -= 10
        vRuns.forEach(run => {
          const runSF = ((run.lf||0)*(run.depth_in||22))/144
          ;[run.label||'Vanity', f1(run.lf||0)+'\'', String(run.depth_in||22)+'"', f1(runSF), f1((run.lf||0)*qty)+'\'', f1(runSF*qty), run.has_sink?'Sink cutout':'—'].forEach((v,i) => {
            const xs = [ML+6, ML+106, ML+166, ML+220, ML+280, ML+340, ML+410]
            dt2(v, xs[i], dp, { size:6.5 })
          })
          dp -= 9
        })
      }

      dp -= 4
    })

    // Footer p2
    p2.drawLine({ start:{x:ML,y:32}, end:{x:MR,y:32}, thickness:1.5, color:brandGreen })
    dt2('CORPORATE OFFICES: 23463 E. Moraine Pl., Aurora, CO 80016  |  pam@mdsgcabinets.com  |  csr@mdsgcabinets.com', ML, 20, { size:6.5, color:gray })

    const pdfBytes = await pdfDoc.save()

    if (jobId) {
      await supabase.from('activity_log').insert({
        job_id: jobId, user_name: 'Cole',
        action: `Countertop proposal generated — ${withWaste.toFixed(1)} SF material · ${f1(grandKLF+grandVLF)} LF total · ${totals.cuts} cutouts`,
      }).maybeSingle()
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${proposalNum}.pdf"`,
      },
    })
  } catch (err) {
    console.error('Countertop proposal error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
