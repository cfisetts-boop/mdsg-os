import ExcelJS from 'exceljs'

const FILLER_RE    = /^(WF|TF|BF|TK8|SCM|OCM|BEP|DWEP|EPT|PLYS)/i
const APPLIANCE_RE = /^(DISH|DW|DISW|RANGE|REF|MICRO|OTR|WASH|DRYER|OVEN|HOOD|VENT)/i
const BASE_RE      = /^(B[^WF]|SB|DB|BMC|BB|HC)/i   // base cabinets (not BW blind wall, not BF3 filler)
const VANITY_RE    = /^V(SB|DB|B)/i

// Auto-apply -32.5 suffix for ADA units if not already present
function applyADA(sku) {
  if (!sku) return sku
  const u = sku.toUpperCase()
  if (u.includes('32.5')) return sku                              // already has ADA height
  const isVanity = VANITY_RE.test(u)
  const isBase   = BASE_RE.test(u)
  if (!isVanity && !isBase) return sku                            // not height-sensitive
  if (isVanity && /(\d|-)T([LR])?$/i.test(sku)) return sku      // tall vanity T = 34.5", leave as-is
  // Hinge is trailing L or R preceded by a digit (not part of RF, FH, etc.)
  const hingeMatch = sku.match(/(\d)([LR])$/i)
  if (hingeMatch) {
    const hinge = hingeMatch[2]
    return sku.slice(0, -1) + '-32.5' + hinge
  }
  return sku + '-32.5'
}

// Parse SKU into a readable description
// Height suffixes: -32.5 = ADA 32.5" ht · T (before hinge or end) = Tall 34.5" ht
function skuDesc(sku) {
  if (!sku) return sku
  // Extract height indicator BEFORE stripping for parsing
  const hasADA  = sku.includes('32.5')
  const hasTall = !hasADA && /(\d|-)T([LR])?$/i.test(sku)   // digit/dash then T = tall vanity
  const htNote  = hasADA ? ' · ADA 32.5\"ht' : hasTall ? ' · Tall 34.5\"ht' : ''

  // Strip height markers for dimension parsing
  const base = sku.replace(/-?32\.5/g,'').replace(/[- ]T([LR])?$/i,'$1').toUpperCase()
  const u    = base

  // Hinge: trailing L or R preceded by a digit
  const hingeM = u.match(/(\d)([LR])$/)
  const hinge  = hingeM ? ' · ' + hingeM[2] + ' hinge' : ''
  const uClean = hingeM ? u.slice(0,-1) : u  // strip hinge for width/height parsing

  function wallDims(nums) {
    if (nums.length === 3) return { w: parseInt(nums[0]),         h: parseInt(nums.slice(1)) }
    if (nums.length === 4) return { w: parseInt(nums.slice(0,2)), h: parseInt(nums.slice(2)) }
    if (nums.length === 6) return { w: parseInt(nums.slice(0,2)), h: parseInt(nums.slice(2,4)), d: parseInt(nums.slice(4)) }
    return null
  }

  // Wall / upper cabinets
  if (/^W(?:BC|HL|O)?/.test(u)) {
    const prefix = /^WBC/.test(u)?'WBC':/^WHL/.test(u)?'WHL':/^WO/.test(u)?'WO':'W'
    const type   = prefix==='WBC'?'Wall bridge':prefix==='WHL'?'Wall hamper':prefix==='WO'?'Wall open':'Wall'
    const nums   = uClean.replace(new RegExp('^'+prefix),'').replace(/[^0-9]/g,'')
    const d      = wallDims(nums)
    if (d) return `${type} ${d.w}\" × ${d.h}\"h${hinge}${htNote}`
    return sku
  }
  // Drawer base
  if (/^DB/.test(u)) {
    const m = uClean.match(/^DB(\d+)-?(\d+)?/)
    if (m) return `Drawer base ${m[1]}\"w${m[2]?' · '+m[2]+' drw':''}${hinge}${htNote}`
  }
  // Sink base
  if (/^SB/.test(u)) {
    const m = uClean.match(/^SB(\d+)/)
    if (m) return `Sink base ${m[1]}\"w${hinge}${htNote}`
  }
  // Microwave base
  if (/^BMC/.test(u)) {
    const m = uClean.match(/^BMC(\d+)/)
    if (m) return `Microwave base ${m[1]}\"w${htNote}`
  }
  // Blind base
  if (/^BB/.test(u)) {
    const m = uClean.match(/^BB(\d+)/)
    if (m) return `Blind base ${m[1]}\"w${hinge}${htNote}`
  }
  // Regular base (not BF, BEP, BW)
  if (/^B[^FEPW]/.test(u)) {
    const m = uClean.match(/^B(\d+)/)
    if (m) return `Base ${m[1]}\"w${hinge}${htNote}`
  }
  // Vanity sink base
  if (/^VSB/.test(u)) {
    const m = uClean.match(/^VSB(\d+)/)
    if (m) return `Vanity sink ${m[1]}\"w${hinge}${htNote}`
  }
  // Vanity drawer base
  if (/^VDB/.test(u)) {
    const m = uClean.match(/^VDB(\d+)-?(\d+)?/)
    if (m) return `Vanity drawer ${m[1]}\"w${m[2]?' · '+m[2]+' drw':''}${hinge}${htNote}`
  }
  // Vanity base
  if (/^VB/.test(u)) {
    const m = uClean.match(/^VB(\d+)/)
    if (m) return `Vanity base ${m[1]}\"w${hinge}${htNote}`
  }
  // Tall cabinet
  if (/^T\d/.test(u)) {
    const m = uClean.match(/^T(\d{2})(\d{2})(\d{2})/)
    if (m) return `Tall ${m[1]}\"w × ${m[2]}\"h × ${m[3]}\"d${htNote}`
  }
  // Linen / pantry tall
  if (/^(LT|PT|LC)/.test(u)) {
    const m = uClean.match(/^(LT|PT|LC)(\d{2})(\d{2})(\d{2})/)
    if (m) return `${m[1]==='LC'?'Linen':m[1]==='LT'?'Linen tall':'Pantry tall'} ${m[2]}\"w${htNote}`
  }
  return sku  // fallback
}

function cellVal(row, col) {
  const v = row.getCell(col).value
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.result !== undefined) return v.result  // formula cell
  return v
}

function parseSheet(sheet) {
  const unitTypes = []
  let current = null

  sheet.eachRow((row) => {
    const a = cellVal(row, 1)   // Col A: qty per unit OR unit name
    const b = cellVal(row, 2)   // Col B: SKU OR unit count
    const e = cellVal(row, 5)   // Col E: hardware count
    const j = cellVal(row, 10)  // Col J: countertop SF

    const aStr = String(a ?? '').trim()
    const bStr = String(b ?? '').trim()

    // ── Unit header row ─────────────────────────────────────────────────
    if (aStr.toUpperCase().startsWith('UNIT ')) {
      const qty = parseInt(bStr) || 1
      current = {
        unit_type_name:        aStr,
        is_ada:                aStr.toUpperCase().includes('ADA'),
        unit_quantity:         qty,
        is_amenity:            false,
        sheet_reference:       '',
        skus:                  [],
        fillers:               [],
        countertop_sf:         0,
        kitchenSF:             0,
        vanitySF:              0,
        kitchenLF:             0,
        vanityLF:              0,
        sinks:                 0,
        toe_kick_lf:           0,
        total_cabinets_per_unit: 0,
      }
      unitTypes.push(current)
      return
    }

    if (!current) return

    // ── Skip totals/summary rows (first value is large number > 20) ────
    const aNum = parseFloat(aStr)
    if (!isNaN(aNum) && aNum > 20) return

    // ── Skip blank rows or non-item rows ────────────────────────────────
    const qty = parseInt(aStr) || 0
    const sku = bStr
    if (!sku || qty < 1 || qty > 10) return
    if (APPLIANCE_RE.test(sku)) return

    // ── Filler / trim ───────────────────────────────────────────────────
    if (FILLER_RE.test(sku)) {
      if (/^TK8/i.test(sku)) {
        current.toe_kick_lf += qty * (8 / 12)
      }
      current.fillers.push({
        sku,
        description:       sku,
        quantity_per_unit: qty,
        location:          'kitchen',
      })
      return
    }

    // ── Cabinet SKU ─────────────────────────────────────────────────────
    const hardware  = parseFloat(String(e ?? '0')) || 0
    const ctLength  = parseFloat(String(cellVal(row, 7) ?? '0')) || 0  // Col G: length (inches)
    const ctDepth   = parseFloat(String(cellVal(row, 8) ?? '0')) || 0  // Col H: depth (inches)
    // Col I and J are formulas — compute directly from raw values
    const ctSF      = ctLength > 0 && ctDepth > 0 ? (ctLength * ctDepth) / 144 : 0

    // Hinge: trailing L or R on SKU, LDRD = double door
    let hinge = 'L/R'
    if (/LDRD/i.test(sku)) hinge = 'L/R'
    else if (/L$/i.test(sku) && !/^(BLS|BW|BRL)/i.test(sku)) hinge = 'L'
    else if (/R$/i.test(sku) && !/^(BSR|WOR|EPR)/i.test(sku)) hinge = 'R'

    const location = /^V(SB|DB|B)/i.test(sku) ? 'bathroom' : 'kitchen'

    const finalSku = current.is_ada ? applyADA(sku) : sku
    current.skus.push({
      sku:               finalSku,
      description:       skuDesc(finalSku),
      quantity_per_unit: qty,
      hinge_side:        hinge,
      location,
      notes:             '',
      hardware_count:    hardware,
    })

    // Accumulate countertop SF by type
    if (ctSF > 0) {
      const isVanityForSF = VANITY_RE.test(finalSku)
      if (isVanityForSF) current.vanitySF  = (current.vanitySF  || 0) + (ctSF * qty)
      else               current.kitchenSF = (current.kitchenSF || 0) + (ctSF * qty)
      current.countertop_sf = (current.countertop_sf || 0) + (ctSF * qty)
    }
    // Accumulate kitchen vs vanity LF
    if (ctLength > 0) {
      const isVanity = VANITY_RE.test(finalSku)
      const lf = (ctLength * qty) / 12
      if (isVanity) current.vanityLF  = (current.vanityLF  || 0) + lf
      else          current.kitchenLF = (current.kitchenLF || 0) + lf
    }
    // Count sink bases
    if (/^(SB|VSB)/i.test(finalSku)) current.sinks = (current.sinks || 0) + qty
  })

  // Final totals
  unitTypes.forEach(ut => {
    ut.total_cabinets_per_unit =
      ut.skus.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0)
    ut.toe_kick_lf = Math.ceil(ut.toe_kick_lf * 2) / 2
    ut.kitchenLF  = Math.round(ut.kitchenLF  * 100) / 100
    ut.vanityLF   = Math.round(ut.vanityLF   * 100) / 100
    ut.kitchenSF  = Math.round(ut.kitchenSF  * 100) / 100
    ut.vanitySF   = Math.round(ut.vanitySF   * 100) / 100
  })

  return unitTypes
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files    = formData.getAll('files')

    const xlsxFile = files.find(f =>
      f.name?.toLowerCase().endsWith('.xlsx') ||
      f.name?.toLowerCase().endsWith('.xlsm')
    )
    if (!xlsxFile) return Response.json({ error: 'No Excel file found' }, { status: 400 })

    const buffer   = Buffer.from(await xlsxFile.arrayBuffer())
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)

    // Try all known tab names, fall back to first sheet
    let sheet = workbook.getWorksheet('CAB LIST')
               || workbook.getWorksheet('CABINET LIST')
               || workbook.getWorksheet('Cabinet List')
               || workbook.getWorksheet('Cab List')
               || workbook.worksheets[0]
    if (!sheet) return Response.json({ error: 'No worksheet found in Excel file' }, { status: 400 })

    // Extract specs from header rows (rows 1-18) if filled in
  const specs = { cabinet_line: 'TBD', door_style: 'TBD', finish: 'TBD', box_construction: 'TBD', hardware: 'TBD' }
  const SPEC_MAP = {
    'DOOR STYLE':       'door_style',
    'FINISH':           'finish',
    'FINISH (COLOR)':   'finish',
    'BOX CONSTRUCTION': 'box_construction',
    'DRAWER BOX':       'box_construction',
    'MANUFACTURER':     'cabinet_line',
    'CABINET LINE':     'cabinet_line',
  }
  sheet.eachRow((row, rowNum) => {
    if (rowNum > 20) return  // only check header area
    const label = String(cellVal(row, 1) ?? '').replace(':', '').trim().toUpperCase()
    const value = String(cellVal(row, 2) ?? '').trim()
    if (value && value !== 'null' && value !== 'undefined') {
      const key = Object.keys(SPEC_MAP).find(k => label.includes(k))
      if (key) specs[SPEC_MAP[key]] = value
    }
  })

  const unitTypes = parseSheet(sheet)

    if (!unitTypes.length) {
      return Response.json({
        error: 'No unit types found. Make sure the Excel file has rows starting with "UNIT X" as unit headers.',
      }, { status: 422 })
    }

    const totalCabinets = unitTypes.reduce(
      (s, ut) => s + ut.total_cabinets_per_unit * (ut.unit_quantity || 1), 0
    )
    const totalCtSF = unitTypes.reduce(
      (s, ut) => s + (ut.countertop_sf || 0), 0
    )

    return Response.json({
      success:  true,
      source:   'excel',
      filename: xlsxFile.name,
      data: {
        project_name:          null,
        gc_name:               null,
        address:               null,
        specs,
        unit_types:            unitTypes,
        flags:                 [],
        extraction_confidence: 'high',
        extraction_notes:      `Imported from Excel (${xlsxFile.name}) — ${unitTypes.length} unit types, ${totalCabinets.toLocaleString()} total cabinets, ${totalCtSF.toFixed(1)} SF countertop`,
      },
      summary: {
        unit_type_count: unitTypes.length,
        total_units:     unitTypes.reduce((s, u) => s + (u.unit_quantity || 0), 0),
        total_cabinets:  totalCabinets,
        countertop_sf:   parseFloat(totalCtSF.toFixed(2)),
        confidence:      'high',
      },
    })

  } catch (err) {
    console.error('Excel import error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
