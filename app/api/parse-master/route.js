import ExcelJS from 'exceljs'

// POST /api/parse-master — reads the MDSG Master Cost Worksheet (xlsx) and
// returns the CAB-HRDWR-INSTALL inputs for the worksheet grid.
export async function POST(request) {
  try {
    const buf = Buffer.from(await request.arrayBuffer())
    if (!buf.length) return Response.json({ error: 'No file received' }, { status: 400 })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets.find(w => /CAB/i.test(w.name)) || wb.worksheets[0]
    if (!ws) return Response.json({ error: 'No worksheet found' }, { status: 422 })

    const num = (v) => { if (v == null) return null
      if (typeof v === 'object') v = v.result ?? v.value ?? null
      const n = Number(v); return isFinite(n) ? n : null }
    const rows = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        let v = cell.value
        if (v && typeof v === 'object' && 'result' in v) v = v.result
        cells.push(v)
      })
      rows.push(cells)
    })
    const findRow = (re, from = 0) => {
      for (let i = from; i < rows.length; i++)
        if (rows[i].some(c => typeof c === 'string' && re.test(c))) return i
      return -1
    }
    const numsIn = (i) => (i < 0 ? [] : rows[i].map(num).filter(n => n !== null))

    const out = {}
    const rCab = findRow(/^CABINET COST/i);      out.cabCost = numsIn(rCab)[0] ?? null
    const rDisc = findRow(/^DISCOUNT$/i);        const d = numsIn(rDisc)[0]; out.discountPct = d != null ? (d <= 1 ? d * 100 : d) : null
    const rMar = findRow(/^MARGIN$/i);           out.marginMult = numsIn(rMar)[0] ?? null
    const rTax = findRow(/SALES TAX RATE/i);     const t = numsIn(rTax)[0]; out.taxRate = t != null ? (t < 1 ? t * 100 : t) : 0
    const rFr = findRow(/^FREIGHT/i);            const fr = numsIn(rFr); out.trucks = fr[1] ?? null; out.perTruck = fr[2] ?? null
    const rHw = findRow(/^HARDWARE$/i);          const hw = numsIn(rHw); out.hwPieces = hw[0] ?? null; out.hwEach = hw[1] ?? null
    const rHwM = rHw >= 0 ? findRow(/^MARGIN$/i, rHw) : -1
    out.hwMargin = numsIn(rHwM)[0] ?? null
    const rIns = findRow(/TOTAL NO\.? CABINETS/i); const ins = numsIn(rIns); out.installCabs = ins[0] ?? null; out.installRate = ins[1] ?? null
    const rRta = findRow(/RTA ASSEMBLY/i);       const rt = numsIn(rRta); out.rtaQty = rt[0] ?? 0; out.rtaRate = rt[1] ?? 25
    const rStg = findRow(/UNLOADING|STAGING/i);  const st = numsIn(rStg); out.stagingQty = st[0] ?? 0; out.stagingRate = st[1] ?? 10
    return Response.json({ success: true, parsed: out, sheet: ws.name })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
