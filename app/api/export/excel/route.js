/**
 * MDSG Cabinet Schedule — Excel Export API
 * POST /api/export/excel
 * Body: { takeoffData, projectName, supplierName, catalogRef, printDate }
 *
 * Produces a workbook matching the Veterans Villa format:
 *   - Master Summary tab
 *   - One tab per unit type
 *   - Total Cabinet List & Hardware tab
 *
 * Stack: Next.js — uses ExcelJS for formatting, colors, formulas
 */

import ExcelJS from 'exceljs'
import { FILLER_RE } from '@/lib/skuRules'
import {
  calculateHardware,
  getSection,
  parseDimensions,
  normalizeHinge,
  sectionSortIndex,
  isAppliance,
} from '@/lib/hardwareUtils'

// ── Color palette (matches Veterans Villa exactly) ────────────────────────────
const COLORS = {
  bannerBase:         'FFCC99', // Amber/Gold — Base cabinets
  bannerVanity:       'E6CCFF', // Lavender — Vanity bases
  bannerWall:         'CCE5FF', // Light Blue — Wall cabinets
  bannerTall:         '6699CC', // Steel Blue — Tall cabinets
  bannerFiller:       'FFFF99', // Yellow — Fillers/Scribes/OCM
  bannerToeKick:      'CCFFCC', // Green — Toe Kick
  bannerEndPanel:     'D9D9D9', // Light Gray — End Panels
  headerRow:          'D9E1F2', // Blue-gray — column header row
  subtotalRow:        'F2F2F2', // Light gray — subtotals
  grandTotal:         'BDD7EE', // Blue — grand total
  qtyHighlight:       'BDD7EE', // Blue — qty > 1 per unit
  title:              '1F3864', // Dark navy — title text
  white:              'FFFFFF',
}

const SECTION_BANNER_COLORS = {
  'Base - Drawer':        COLORS.bannerBase,
  'Base - Sink':          COLORS.bannerBase,
  'Base':                 COLORS.bannerBase,
  'Corner Vanity Base':   COLORS.bannerVanity,
  'Vanity Base':          COLORS.bannerVanity,
  'Vanity Base - Sink':   COLORS.bannerVanity,
  'Wall':                 COLORS.bannerWall,
  'Tall Cabinet':         COLORS.bannerTall,
  'Filler':               COLORS.bannerFiller,
  'Scribe':               COLORS.bannerFiller,   // same yellow as filler
  'Toe Kick':             COLORS.bannerToeKick,
  'End Panel':            COLORS.bannerEndPanel,
}

// UKON section names map our internal names to the competitor quote format
const UKON_SECTION_NAMES = {
  'Base - Drawer':       'Base - Drawer',
  'Base - Sink':         'Base - Sink',
  'Base':                'Base',
  'Corner Vanity Base':  'Vanity - Sink',
  'Vanity Base':         'Vanity - Drawer',
  'Vanity Base - Sink':  'Vanity - Sink',
  'Wall':                'Wall',
  'Tall Cabinet':        'Tall Cabinet',
  'Filler':              'Filler',
  'Scribe':              'Scribe',
  'Toe Kick':            'Toe Kick',
  'End Panel':           'End Panel',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bannerLabel(section) {
  return `── ${section.toUpperCase()} ──`
}

function fill(hex) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } }
}

function boldFont(size = 10, color = '000000') {
  return { bold: true, size, color: { argb: `FF${color}` } }
}

function normalFont(size = 10) {
  return { size }
}

function thinBorder() {
  const s = { style: 'thin', color: { argb: 'FFD0D0D0' } }
  return { top: s, left: s, bottom: s, right: s }
}

function setRow(ws, rowNum, values, opts = {}) {
  const row = ws.getRow(rowNum)
  values.forEach((v, i) => {
    const cell = row.getCell(i + 1)
    cell.value = v
    if (opts.fill) cell.fill = opts.fill
    if (opts.font) cell.font = opts.font
    if (opts.alignment) cell.alignment = opts.alignment
    if (opts.border) cell.border = opts.border
    if (opts.numFmt) cell.numFmt = opts.numFmt
  })
  row.commit()
  return row
}

function mergeFill(ws, rowNum, fromCol, toCol, label, fillColor, fontColor = '000000') {
  ws.mergeCells(rowNum, fromCol, rowNum, toCol)
  const cell = ws.getCell(rowNum, fromCol)
  cell.value = label
  cell.fill = fill(fillColor)
  cell.font = boldFont(10, fontColor)
  cell.alignment = { horizontal: 'left', vertical: 'middle' }
  ws.getRow(rowNum).commit()
}

// Same visual banner but WITHOUT merging — keeps rows filter/sort friendly.
function fillLabel(ws, rowNum, fromCol, toCol, label, fillColor, fontColor = '000000') {
  for (let col = fromCol; col <= toCol; col++) {
    ws.getCell(rowNum, col).fill = fill(fillColor)
  }
  const cell = ws.getCell(rowNum, fromCol)
  cell.value = label
  cell.font = boldFont(10, fontColor)
  cell.alignment = { horizontal: 'left', vertical: 'middle' }
  ws.getRow(rowNum).commit()
}

// ── Group SKUs by section, sorted per Blake's section order ──────────────────
function groupBySection(skus, fillers = []) {
  const all = [
    ...skus.map(s => ({ ...s, isZero: false })),
    ...fillers.map(f => ({ ...f, isZero: true })),
  ]

  const groups = {}
  all.forEach(item => {
    const section = getSection(item.sku)
    if (section === 'Appliance') return   // never include appliances in cabinet schedule
    if (!groups[section]) groups[section] = []
    groups[section].push(item)
  })

  return Object.entries(groups)
    .sort(([a], [b]) => sectionSortIndex(a) - sectionSortIndex(b))
}

// ── Build Unit Type tab ───────────────────────────────────────────────────────
// Pre-scan all unit type names; any name occurring 2+ times gets (1), (2)... suffixes on EVERY occurrence
let sheetNameCounts = {}
let sheetNameSeen = {}
function prepSheetNames(unitTypes) {
  sheetNameCounts = {}
  sheetNameSeen = {}
  unitTypes.forEach(ut => {
    const base = (ut.unit_type_name || 'Unit').replace(/[*?:\\/\[\]]/g, '-').substring(0, 31).toUpperCase()
    sheetNameCounts[base] = (sheetNameCounts[base] || 0) + 1
  })
}
function uniqueSheetName(rawName) {
  const base = (rawName || 'Unit').replace(/[*?:\\/\[\]]/g, '-').substring(0, 31)
  const key = base.toUpperCase()
  if ((sheetNameCounts[key] || 1) <= 1) return base
  sheetNameSeen[key] = (sheetNameSeen[key] || 0) + 1
  const suffix = ` (${sheetNameSeen[key]})`
  return base.substring(0, 31 - suffix.length) + suffix
}

// Prefer the hardware count imported from the source Excel (col E, stored as
// hardware_count on each SKU) — the sheet is the law. Fall back to the
// reference-guide calculation only when the sheet didn't provide a value.
function resolveHW(item) {
  const fromSheet = Number(item.hardware_count)
  if (Number.isFinite(fromSheet) && fromSheet > 0) {
    return { hardware: fromSheet, specialCase: false, note: 'From source Excel (col E)' }
  }
  return calculateHardware(item.sku)
}

function buildUnitTab(wb, unitType, projectName, supplierName, catalogRef) {
  const safeName = uniqueSheetName(unitType.unit_type_name)
  const ws = wb.addWorksheet(safeName)
  ws.columns = [
    { width: 5 },   // #
    { width: 22 },  // SKU
    { width: 22 },  // Section
    { width: 9 },   // Width
    { width: 9 },   // Height
    { width: 9 },   // Depth
    { width: 9 },   // Hinge
    { width: 12 },  // Qty/Unit
    { width: 14 },  // Total Qty
  ]

  const qty = unitType.unit_quantity || 1
  let r = 1

  // Row 1: Title
  ws.mergeCells(r, 1, r, 9)
  const titleCell = ws.getCell(r, 1)
  titleCell.value = `${projectName.toUpperCase()} — ${unitType.unit_type_name}   (${qty} units)`
  titleCell.font = boldFont(13, COLORS.title)
  titleCell.fill = fill(COLORS.white)
  ws.getRow(r).height = 20
  r++

  // Row 2: Supplier line
  ws.mergeCells(r, 1, r, 9)
  const utCtSF = typeof unitType.excelSubtotalSF === 'number' ? unitType.excelSubtotalSF
               : (unitType.countertop_sf > 0 ? unitType.countertop_sf : null)
  ws.getCell(r, 1).value = `${projectName} — ${unitType.unit_type_name}  |  ${supplierName}  ${catalogRef}${utCtSF !== null ? `  |  Countertop: ${utCtSF.toFixed(2)} SF (all ${qty} units)` : ''}`
  ws.getCell(r, 1).font = normalFont(9)
  r++

  // Row 3: blank
  r++

  // Row 4: Headers
  const headers = ['#', 'SKU / User Code', 'Section', 'Width', 'Height', 'Depth', 'Hinge', 'Qty / Unit', 'Total Qty\n(× Units)']
  const headerRow = ws.getRow(r)
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = h
    cell.fill = fill(COLORS.headerRow)
    cell.font = boldFont(10)
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = thinBorder()
  })
  headerRow.height = 30
  headerRow.commit()
  r++

  // Data rows
  const groups = groupBySection(unitType.skus || [], unitType.fillers || [])
  let rowNum = 1
  const dataStartRow = r
  let totalPerUnit = 0

  groups.forEach(([section, items]) => {
    // Section banner
    const bannerColor = SECTION_BANNER_COLORS[section] || COLORS.bannerBase
    mergeFill(ws, r, 1, 9, bannerLabel(section), bannerColor)
    r++

    items.forEach(item => {
      const qpu = Number(item.quantity_per_unit) || 1
      const dims = parseDimensions(item.sku, section)
      const hinge = normalizeHinge(item.hinge_side)
      const hw = resolveHW(item)

      const dataRow = ws.getRow(r)
      const rowValues = [rowNum, item.sku, section, dims.width, dims.height, dims.depth, hinge, qpu, qpu * qty]
      rowValues.forEach((v, i) => {
        const cell = dataRow.getCell(i + 1)
        cell.value = v
        cell.border = thinBorder()
        cell.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' }
        // Blue highlight for qty > 1
        if (i === 7 && qpu > 1) cell.fill = fill(COLORS.qtyHighlight)
      })
      dataRow.commit()
      rowNum++
      r++
      totalPerUnit += qpu
    })
  })

  // Subtotal — cabinets = true box SKUs only (excludes fillers/toe kicks/end panels/trim)
  const NON_CAB = new Set(['Filler', 'Scribe', 'Toe Kick', 'End Panel'])
  const uniqueSkuCount = (unitType.skus || []).length
  const cabinetCount = (unitType.skus || []).reduce((s, sk) => {
    const sec = getSection(sk.sku)
    return s + (!NON_CAB.has(sec) ? (Number(sk.quantity_per_unit) || 0) : 0)
  }, 0)
  const fillerCount = (unitType.skus || []).reduce((s, sk) => {
    const sec = getSection(sk.sku)
    return s + (NON_CAB.has(sec) ? (Number(sk.quantity_per_unit) || 0) : 0)
  }, 0) + (unitType.fillers || []).reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0)

  ws.mergeCells(r, 1, r, 7)
  ws.getCell(r, 1).value = `SUBTOTAL PER UNIT  —  ${uniqueSkuCount} unique SKUs  |  ${cabinetCount} cabinets  |  ${fillerCount} fillers/misc`
  ws.getCell(r, 1).font = boldFont(10)
  ws.getCell(r, 1).fill = fill(COLORS.subtotalRow)
  ws.getCell(r, 8).value = totalPerUnit
  ws.getCell(r, 8).font = boldFont(10)
  ws.getCell(r, 8).fill = fill(COLORS.subtotalRow)
  ws.getCell(r, 9).value = totalPerUnit * qty
  ws.getCell(r, 9).font = boldFont(10)
  ws.getCell(r, 9).fill = fill(COLORS.subtotalRow)
  ws.getRow(r).commit()
  r++

  // Total all units
  ws.mergeCells(r, 1, r, 7)
  ws.getCell(r, 1).value = `TOTAL ALL ${qty} UNITS  —  ${totalPerUnit * qty} total pieces`
  ws.getCell(r, 1).font = boldFont(10)
  ws.getCell(r, 1).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 8).value = totalPerUnit
  ws.getCell(r, 8).font = boldFont(10)
  ws.getCell(r, 8).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 9).value = totalPerUnit * qty
  ws.getCell(r, 9).font = boldFont(10)
  ws.getCell(r, 9).fill = fill(COLORS.grandTotal)
  ws.getRow(r).commit()
  r++

  // ── Discrepancy / notes rows ──────────────────────────────────────────────
  if (unitType.tab_notes?.length) {
    r++ // blank gap
    unitType.tab_notes.forEach(note => {
      ws.mergeCells(r, 1, r, 9)
      const cell = ws.getCell(r, 1)
      cell.value = `⚠ ${note}`
      cell.font = { italic: true, size: 8.5, color: { argb: 'FF8B4513' } }  // brown italic
      cell.fill = fill('FFF8E7')  // light amber
      ws.getRow(r).commit()
      r++
    })
  }

  return ws
}

// ── Build Master Summary tab ──────────────────────────────────────────────────
function buildMasterSummary(wb, unitTypes, projectName, supplierName, catalogRef, printDate, totalUnits, sheetTotals) {
  const ws = wb.addWorksheet('Master Summary')
  ws.moveToBeginning ? ws.moveToBeginning() : null // keep it first

  ws.columns = [
    { width: 5 },   // #
    { width: 22 },  // SKU
    { width: 22 },  // Section
    { width: 9 },   // Width
    { width: 9 },   // Height
    { width: 9 },   // Depth
    { width: 9 },   // Hinge
    { width: 16 },  // Total Qty (all units)
    { width: 12 },  // HW / EA (per unit)
    { width: 14 },  // Total HW (units x each)
  ]

  // Build unit type summary string
  const unitSummary = unitTypes
    .map(u => `${u.unit_type_name} (${u.unit_quantity || 1})`)
    .join(' | ')

  let r = 1

  // Title
  ws.mergeCells(r, 1, r, 10)
  ws.getCell(r, 1).value = `${projectName.toUpperCase()} — CABINET MASTER SUMMARY`
  ws.getCell(r, 1).font = boldFont(13, COLORS.title)
  ws.getRow(r).height = 20
  r++

  // Supplier info
  ws.mergeCells(r, 1, r, 10)
  ws.getCell(r, 1).value = `Supplier: ${supplierName}  |  Catalog: ${catalogRef}  |  Print Date: ${printDate}  |  ${totalUnits} Total Units: ${unitSummary}`
  ws.getCell(r, 1).font = normalFont(9)
  r++

  // Blank
  r++

  // Headers
  const headers = ['#', 'SKU / User Code', 'Section', 'Width', 'Height', 'Depth', 'Hinge', 'Total Qty\n(All Units)', 'HW / EA', 'Total HW\n(Units × EA)']
  const headerRow = ws.getRow(r)
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = h
    cell.fill = fill(COLORS.headerRow)
    cell.font = boldFont(10)
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = thinBorder()
  })
  headerRow.height = 30
  headerRow.commit()
  r++

  // Aggregate SKUs across all unit types
  const skuMap = {}
  unitTypes.forEach(ut => {
    const allItems = [...(ut.skus || []), ...(ut.fillers || [])]
    allItems.forEach(item => {
      const key = item.sku.toUpperCase()
      if (!skuMap[key]) {
        skuMap[key] = { ...item, totalQty: 0, hwTotal: 0 }
      }
      const q = (Number(item.quantity_per_unit) || 1) * (ut.unit_quantity || 1)
      skuMap[key].totalQty += q
      const hwEach = resolveHW(item).hardware
      if (hwEach !== null && hwEach > 0) skuMap[key].hwTotal += hwEach * q
    })
  })

  // Group by section
  const allSkus = Object.values(skuMap)
  const groups = {}
  allSkus.forEach(item => {
    const section = getSection(item.sku)
    if (!groups[section]) groups[section] = []
    groups[section].push(item)
  })

  const sortedGroups = Object.entries(groups)
    .sort(([a], [b]) => sectionSortIndex(a) - sectionSortIndex(b))

  const NON_CAB_SECTIONS = new Set(['Filler', 'Scribe', 'Toe Kick', 'End Panel'])
  let rowNum = 1
  let totalCabQty = 0, totalCabUnique = 0
  let totalFillerQty = 0, totalFillerUnique = 0
  let totalHW = 0
  // Sheet-authoritative grand hardware: when every unit carries the source
  // spreadsheet's own per-unit hardware subtotal, that sum is the law and
  // overrides the per-SKU aggregation (source files sometimes carry orphan
  // hardware values on blank rows that only their subtotal formula captures).
  const sheetHWGrand = unitTypes.every(ut => typeof ut.excelSubtotalHW === 'number')
    ? unitTypes.reduce((s, ut) => s + ut.excelSubtotalHW * (ut.unit_quantity || 1), 0)
    : null

  sortedGroups.forEach(([section, items]) => {
    const bannerColor = SECTION_BANNER_COLORS[section] || COLORS.bannerBase
    fillLabel(ws, r, 1, 10, bannerLabel(section), bannerColor)
    r++

    items.forEach(item => {
      const dims = parseDimensions(item.sku, section)
      const hinge = normalizeHinge(item.hinge_side)
      const hw = resolveHW(item)
      const hwTotalExact = item.hwTotal !== undefined ? item.hwTotal : (hw.hardware > 0 ? hw.hardware * item.totalQty : 0)
      const hwEach = hw.hardware !== null && hw.hardware > 0
        ? hw.hardware
        : hwTotalExact > 0 ? Math.round(hwTotalExact / item.totalQty) : (hw.hardware === 0 ? 0 : null)
      const hwEachDisplay  = hwEach === null ? '?' : hwEach === 0 ? '—' : hwEach
      const hwTotalDisplay = hwEach === null ? '?' : hwTotalExact > 0 ? hwTotalExact : '—'

      const row = ws.getRow(r)
      const vals = [rowNum, item.sku, section, dims.width, dims.height, dims.depth, hinge, item.totalQty, hwEachDisplay, hwTotalDisplay]
      vals.forEach((v, i) => {
        const cell = row.getCell(i + 1)
        cell.value = v
        cell.border = thinBorder()
        cell.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' }
      })
      row.commit()
      rowNum++
      r++

      if (NON_CAB_SECTIONS.has(section)) {
        totalFillerQty += item.totalQty
        totalFillerUnique++
      } else {
        totalCabQty += item.totalQty
        totalCabUnique++
        totalHW += item.hwTotal !== undefined ? item.hwTotal : (hw.hardware > 0 ? hw.hardware * item.totalQty : 0)
      }
    })
  })

  // ── Footer: TOTAL CABINETS ────────────────────────────────────────────────
  r++ // blank gap
  fillLabel(ws, r, 1, 8, `TOTAL CABINETS  —  ${totalCabUnique} unique SKUs  |  ${totalCabQty.toLocaleString()} total cabinet pieces`, COLORS.subtotalRow)
  ws.getCell(r, 8).value = totalCabQty
  ws.getCell(r, 8).font = boldFont(10)
  ws.getCell(r, 10).value = sheetHWGrand ?? totalHW
  ws.getCell(r, 10).font = boldFont(10)
  ws.getCell(r, 10).fill = fill(COLORS.subtotalRow)
  ws.getCell(r, 9).value = 'Total HW →'
  ws.getCell(r, 9).font = normalFont(9)
  ws.getCell(r, 9).fill = fill(COLORS.subtotalRow)
  ws.getRow(r).commit()
  r++

  // ── Footer: TOTAL FILLERS & MISC ─────────────────────────────────────────
  fillLabel(ws, r, 1, 8, `TOTAL FILLERS & MISC  —  ${totalFillerUnique} unique SKUs  |  ${totalFillerQty.toLocaleString()} total pieces`, COLORS.subtotalRow)
  ws.getCell(r, 8).value = totalFillerQty
  ws.getCell(r, 8).font = boldFont(10)
  ws.getCell(r, 9).value = '—'
  ws.getCell(r, 9).fill = fill(COLORS.subtotalRow)
  ws.getCell(r, 10).value = '—'
  ws.getCell(r, 10).fill = fill(COLORS.subtotalRow)
  ws.getRow(r).commit()
  r++

  // ── Footer: GRAND TOTAL ───────────────────────────────────────────────────
  for (let col = 1; col <= 10; col++) ws.getCell(r, col).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 1).value = `GRAND TOTAL — ALL ${totalUnits} UNITS`
  ws.getCell(r, 1).font = boldFont(11)
  ws.getCell(r, 8).value = totalCabQty + totalFillerQty
  ws.getCell(r, 8).font = boldFont(11)
  ws.getCell(r, 9).value = 'Total HW →'
  ws.getCell(r, 9).font = normalFont(9)
  ws.getCell(r, 10).value = sheetHWGrand ?? totalHW
  ws.getCell(r, 10).font = boldFont(11)
  ws.getRow(r).commit()
  r++

  // ── Footer: COUNTERTOPS (from source Excel — the sheet is the law) ────────
  const ctNet    = sheetTotals && typeof sheetTotals.netSF    === 'number' ? sheetTotals.netSF    : null
  const ctSplash = sheetTotals && typeof sheetTotals.splashSF === 'number' ? sheetTotals.splashSF : 0
  const ctTotal  = sheetTotals && typeof sheetTotals.totalSF  === 'number' ? sheetTotals.totalSF
                 : (ctNet !== null ? ctNet + ctSplash : null)
  if (ctNet !== null || ctTotal !== null) {
    r++ // blank gap
    fillLabel(ws, r, 1, 8, `COUNTERTOPS  —  Net: ${ctNet !== null ? ctNet.toFixed(2) : '—'} SF  |  Splash: ${ctSplash.toFixed(2)} SF`, COLORS.subtotalRow)
    ws.getCell(r, 9).value = 'ORDER SF'
    ws.getCell(r, 9).font = boldFont(10)
    ws.getCell(r, 9).fill = fill(COLORS.subtotalRow)
    ws.getCell(r, 10).value = ctTotal !== null ? Number(ctTotal.toFixed(2)) : '—'
    ws.getCell(r, 10).font = boldFont(11)
    ws.getCell(r, 10).fill = fill(COLORS.grandTotal)
    ws.getRow(r).commit()
    r++
  }

  return ws
}

// ── Build Total Cabinet List & Hardware tab ───────────────────────────────────
function buildHardwareTab(wb, unitTypes, projectName, supplierName, catalogRef) {
  const ws = wb.addWorksheet('Total Cabinet List & Hardware')
  ws.columns = [
    { width: 12 }, { width: 22 }, { width: 13 }, { width: 13 },
    { width: 13 }, { width: 13 },
    { width: 12 }, // PRICE EA  (manufacturer fills)
    { width: 14 }, // PRICE EXT (manufacturer fills)
  ]

  let r = 1

  // Title
  ws.mergeCells(r, 1, r, 8)
  ws.getCell(r, 1).value = `${projectName.toUpperCase()} — TOTAL CABINET LIST & HARDWARE`
  ws.getCell(r, 1).font = boldFont(13, COLORS.title)
  ws.getRow(r).height = 20
  r++

  // Supplier line
  ws.mergeCells(r, 1, r, 8)
  ws.getCell(r, 1).value = `Supplier: ${supplierName}  |  Catalog: ${catalogRef}  |  Hardware: Width-based by category; dash-# = drawer count; Special cases confirmed from catalog PDF`
  ws.getCell(r, 1).font = normalFont(9)
  r++

  // Blank
  r++

  let grandTotalCabs = 0
  let grandTotalHw = 0

  unitTypes.forEach(ut => {
    const qty = ut.unit_quantity || 1

    // Unit type banner
    ws.mergeCells(r, 1, r, 8)
    ws.getCell(r, 1).value = `${ut.unit_type_name.toUpperCase()} — ${qty} UNITS`
    ws.getCell(r, 1).font = boldFont(11, COLORS.title)
    ws.getCell(r, 1).fill = fill(COLORS.headerRow)
    ws.getRow(r).commit()
    r++

    // Column headers
    const hwHeaders = ['QTY / UNIT', 'SKU', 'UNIT COUNT', 'TOTAL CABS', 'HRDWR / CAB', 'HRDWR TOTAL', 'PRICE EA', 'PRICE EXT']
    const hwHeaderRow = ws.getRow(r)
    hwHeaders.forEach((h, i) => {
      const cell = hwHeaderRow.getCell(i + 1)
      cell.value = h
      cell.fill = fill(COLORS.headerRow)
      cell.font = boldFont(9)
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border = thinBorder()
    })
    hwHeaderRow.commit()
    r++

    const allItems = [...(ut.skus || []), ...(ut.fillers || [])]

    // Compute subtotals as plain values — no Excel formulas (avoids circular ref warnings)
    let totalQpu = 0
    let totalHwForUnit = 0

    allItems.forEach(item => {
      const qpu = Number(item.quantity_per_unit) || 1
      const hw = resolveHW(item)
      const hwVal = (hw.hardware !== null && hw.hardware > 0) ? hw.hardware : 0
      const hwTotal = qpu * qty * hwVal

      totalQpu += qpu
      totalHwForUnit += hwTotal

      const row = ws.getRow(r)
      row.getCell(1).value = qpu
      row.getCell(2).value = item.sku
      row.getCell(3).value = qty
      row.getCell(4).value = qpu * qty
      row.getCell(5).value = hwVal > 0 ? hwVal : null
      row.getCell(6).value = hwTotal > 0 ? hwTotal : null

      ;[1, 2, 3, 4, 5, 6, 7, 8].forEach(col => {
        row.getCell(col).border = thinBorder()
        row.getCell(col).alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' }
      })
      ;[7, 8].forEach(col => { row.getCell(col).fill = fill('FFF9E3'); row.getCell(col).numFmt = '$#,##0.00' })
      row.commit()
      r++
    })

    // Subtotal row — plain computed values
    const subtotalRow = ws.getRow(r)
    subtotalRow.getCell(1).value = totalQpu
    subtotalRow.getCell(2).value = 'SUBTOTALS'
    subtotalRow.getCell(3).value = qty
    subtotalRow.getCell(4).value = totalQpu * qty
    subtotalRow.getCell(5).value = null
    subtotalRow.getCell(6).value = totalHwForUnit

    ;[1, 2, 3, 4, 5, 6, 7, 8].forEach(col => {
      subtotalRow.getCell(col).fill = fill(COLORS.subtotalRow)
      subtotalRow.getCell(col).font = boldFont(10)
      subtotalRow.getCell(col).border = thinBorder()
    })
    subtotalRow.getCell(8).numFmt = '$#,##0.00'
    subtotalRow.commit()

    grandTotalCabs += totalQpu * qty
    grandTotalHw   += totalHwForUnit
    r += 2 // subtotal + blank gap
  })

  // Grand total — plain computed values
  ws.mergeCells(r, 1, r, 3)
  ws.getCell(r, 1).value = 'GRAND TOTAL — ALL UNITS'
  ws.getCell(r, 1).font = boldFont(11)
  ws.getCell(r, 1).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 4).value = grandTotalCabs
  ws.getCell(r, 4).font = boldFont(11)
  ws.getCell(r, 4).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 6).value = grandTotalHw
  ws.getCell(r, 6).font = boldFont(11)
  ws.getCell(r, 6).fill = fill(COLORS.grandTotal)
  ws.getRow(r).commit()
  r += 2

  // Special cases note
  const specialSkus = []
  unitTypes.forEach(ut => {
    ;[...(ut.skus || []), ...(ut.fillers || [])].forEach(item => {
      const hw = resolveHW(item)
      if (hw.specialCase && hw.hardware !== null) {
        specialSkus.push(`${item.sku} = ${hw.hardware} hardware (${hw.note})`)
      }
    })
  })

  if (specialSkus.length > 0) {
    ws.mergeCells(r, 1, r, 8)
    ws.getCell(r, 1).value = `SPECIAL CASES — Confirmed from catalog PDF:  ${[...new Set(specialSkus)].join('  |  ')}`
    ws.getCell(r, 1).font = { italic: true, size: 9 }
    ws.getRow(r).commit()
  }

  return ws
}

// ── UKON / Competitor Quote Request tab ──────────────────────────────────────
// Single flat sheet with pricing columns — sent to SMART, UKON, SKYLINE for quotes
function buildUkonQuoteTab(wb, unitTypes, projectName, printDate) {
  const ws = wb.addWorksheet('Quote Request (UKON-SMART-SKY)')
  ws.columns = [
    { width: 5  }, // #
    { width: 24 }, // SKU
    { width: 22 }, // Section
    { width: 9  }, // Width
    { width: 9  }, // Height
    { width: 9  }, // Depth
    { width: 9  }, // Hinge
    { width: 14 }, // Total Qty
    { width: 16 }, // HW/EA
    { width: 12 }, // OPT1 EACH
    { width: 12 }, // OPT1 TOTAL
    { width: 12 }, // OPT2 EACH
  ]

  const totalUnits = unitTypes.reduce((s, u) => s + (u.unit_quantity || 1), 0)
  let r = 1

  // Row 1 — Title
  ws.mergeCells(r, 1, r, 12)
  const t = ws.getCell(r, 1)
  t.value = `${projectName.toUpperCase()} — CABINET QUOTE REQUEST`
  t.font = boldFont(13, COLORS.title); t.fill = fill(COLORS.white)
  ws.getRow(r).height = 20; r++

  // Row 2 — Supplier / info line
  ws.mergeCells(r, 1, r, 9)
  ws.getCell(r, 1).value = `Supplier: _______________  |  Print Date: ${printDate}  |  ${totalUnits} Total Units`
  ws.getCell(r, 1).font = normalFont(9); r++

  // Row 3 — Door style / specs
  ws.mergeCells(r, 1, r, 9)
  ws.getCell(r, 1).value = 'DOOR STYLE:  FULL OVERLAY SLAB or SHAKER  |  MAPLE - STAIN or PAINT  |  LAMINATE or THERMOFOIL'
  ws.getCell(r, 1).font = normalFont(9); r++

  // Row 4 — Option headers
  ws.getCell(r, 10).value = 'OPTION 1'; ws.getCell(r, 10).font = boldFont(9)
  ws.getCell(r, 12).value = 'OPTION 2'; ws.getCell(r, 12).font = boldFont(9)
  r++

  // Row 5 — Spec options
  const specLabels = ['BOX CONSTRUCTION:', 'BOX MATERIAL:', 'DRAWER BOX:', 'DRAWER GLIDE:', 'HINGES:']
  const opt1 = ['FRAMED', '1/2" PB', 'STANDARD', 'STANDARD', 'STANDARD']
  const opt2 = ['FRAMED', 'PLYWOOD', 'DOVETAIL', 'UM-SC', 'SC']
  specLabels.forEach((lbl, i) => {
    ws.mergeCells(r, 1, r, 9)
    ws.getCell(r, 1).value = lbl; ws.getCell(r, 1).font = normalFont(9)
    ws.getCell(r, 10).value = opt1[i]; ws.getCell(r, 10).font = normalFont(9)
    ws.getCell(r, 12).value = opt2[i]; ws.getCell(r, 12).font = normalFont(9)
    r++
  })

  // Header row
  const hdrs = ['#', 'SKU / User Code', 'Section', 'Width', 'Height', 'Depth', 'Hinge', 'Total Qty\n(All Units)', 'HW / EA\n(Total HW)', 'EACH', 'TOTAL', 'EACH']
  const hRow = ws.getRow(r)
  hdrs.forEach((h, i) => {
    const cell = hRow.getCell(i + 1)
    cell.value = h; cell.fill = fill(COLORS.headerRow); cell.font = boldFont(10)
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = thinBorder()
  })
  hRow.height = 30; hRow.commit(); r++

  // Aggregate all SKUs across unit types (same as master summary)
  const skuMap = {}
  unitTypes.forEach(ut => {
    const allItems = [...(ut.skus || []), ...(ut.fillers || [])]
    allItems.forEach(item => {
      const key = item.sku.toUpperCase()
      if (!skuMap[key]) skuMap[key] = { ...item, totalQty: 0, hwTotal: 0 }
      const q2 = (Number(item.quantity_per_unit) || 1) * (ut.unit_quantity || 1)
      skuMap[key].totalQty += q2
      const hwEach2 = resolveHW(item).hardware
      if (hwEach2 !== null && hwEach2 > 0) skuMap[key].hwTotal += hwEach2 * q2
    })
  })

  // Group by section using UKON naming
  const groups = {}
  Object.values(skuMap).forEach(item => {
    const sec = getSection(item.sku)
    if (sec === 'Appliance') return
    const ukonSec = UKON_SECTION_NAMES[sec] || sec
    if (!groups[ukonSec]) groups[ukonSec] = []
    groups[ukonSec].push({ ...item, _section: sec })
  })

  // Sort sections by internal order
  const sectionOrder = ['Base - Drawer','Base - Sink','Base','Vanity - Drawer','Vanity - Sink','Wall','Tall Cabinet','Filler','Scribe','Toe Kick','End Panel']
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    return (sectionOrder.indexOf(a) === -1 ? 99 : sectionOrder.indexOf(a)) -
           (sectionOrder.indexOf(b) === -1 ? 99 : sectionOrder.indexOf(b))
  })

  let rowNum = 1
  const NON_CAB = new Set(['Filler','Scribe','Toe Kick','End Panel'])
  let totalCabQty = 0, totalMiscQty = 0, totalHW = 0
  const sheetHWGrandQ = unitTypes.every(ut => typeof ut.excelSubtotalHW === 'number')
    ? unitTypes.reduce((s, ut) => s + ut.excelSubtotalHW * (ut.unit_quantity || 1), 0)
    : null

  sortedGroups.forEach(([section, items]) => {
    const bannerColor = SECTION_BANNER_COLORS[items[0]?._section] || COLORS.bannerBase
    mergeFill(ws, r, 1, 12, bannerLabel(section), bannerColor)
    r++

    items.forEach(item => {
      const dims = parseDimensions(item.sku, item._section)
      const hinge = normalizeHinge(item.hinge_side)
      const hw = resolveHW(item)
      const hwTotalExactQ = item.hwTotal !== undefined ? item.hwTotal : (hw.hardware > 0 ? hw.hardware * item.totalQty : 0)
      const hwDisplay = hwTotalExactQ > 0 ? `${hw.hardware > 0 ? hw.hardware : Math.round(hwTotalExactQ / item.totalQty)}  (${hwTotalExactQ})` : '—'

      const row = ws.getRow(r)
      const vals = [rowNum, item.sku, section, dims.width, dims.height, dims.depth, hinge, item.totalQty, hwDisplay, '$0.00', '$0.00', '$0.00']
      vals.forEach((v, i) => {
        const cell = row.getCell(i + 1)
        cell.value = v; cell.border = thinBorder()
        cell.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' }
        // Gray out pricing cells so supplier fills them in
        if (i >= 9) { cell.fill = fill('F9F9F9'); cell.font = { color: { argb: 'FFAAAAAA' }, size: 9 } }
      })
      row.commit(); rowNum++; r++

      if (NON_CAB.has(section)) totalMiscQty += item.totalQty
      else { totalCabQty += item.totalQty; totalHW += item.hwTotal !== undefined ? item.hwTotal : (hw.hardware > 0 ? hw.hardware * item.totalQty : 0) }
    })
  })

  // Totals footer
  r++
  const totRows = [
    ['TOTAL CABINETS', totalCabQty, '', COLORS.subtotalRow],
    ['TOTAL FILLERS & MISC', totalMiscQty, '—', COLORS.subtotalRow],
    ['SUBTOTAL', '', '', COLORS.grandTotal],
    ['FREIGHT', '', '', 'FFFFFF'],
    ['TARIFF', '', '', 'FFFFFF'],
    ['TOTAL', '', '', COLORS.grandTotal],
  ]
  totRows.forEach(([label, qty, hw, bg]) => {
    ws.mergeCells(r, 1, r, 7)
    ws.getCell(r, 1).value = label; ws.getCell(r, 1).font = boldFont(10); ws.getCell(r, 1).fill = fill(bg)
    if (qty !== '') { ws.getCell(r, 8).value = qty; ws.getCell(r, 8).font = boldFont(10); ws.getCell(r, 8).fill = fill(bg) }
    if (hw !== '') { ws.getCell(r, 9).value = hw; ws.getCell(r, 9).fill = fill(bg) }
    ws.getCell(r, 11).value = '$0.00'; ws.getCell(r, 11).font = boldFont(10); ws.getCell(r, 11).fill = fill(bg)
    ws.getRow(r).commit(); r++
  })

  return ws
}

// ── Main Export Handler ───────────────────────────────────────────────────────

// ── Manufacturer Pricing Sheet: one line per unique SKU, Leedo-style detail
//    columns, two price columns (EA fillable, EXT auto-formula) ─────────────
function buildPricingSheet(wb, unitTypes, projectName, supplierName, printDate, specs = {}) {
  const ws = wb.addWorksheet('Master Pricing Sheet')
  ws.columns = [
    { width: 20 },  // SKU
    { width: 24 },  // Cabinet Type / Drawer Box
    { width: 13 },  // Door Style
    { width: 13 },  // Finish
    { width: 20 },  // Interior / Door Back
    { width: 13 },  // Hinge Type
    { width: 9 },   // Hinge Side
    { width: 8 },   // Shelf
    { width: 11 },  // TOTAL QTY
    { width: 12 },  // PRICE EA
    { width: 14 },  // PRICE EXT
  ]

  let r = 1
  ws.mergeCells(r, 1, r, 11)
  ws.getCell(r, 1).value = `${projectName.toUpperCase()} — MASTER PRICING SHEET`
  ws.getCell(r, 1).font = boldFont(13, COLORS.title)
  ws.getRow(r).height = 20
  r++
  ws.mergeCells(r, 1, r, 11)
  ws.getCell(r, 1).value = `Supplier: ${supplierName}  |  Print Date: ${printDate}  |  Enter PRICE EA per piece — PRICE EXT calculates automatically`
  ws.getCell(r, 1).font = normalFont(9)
  r += 2

  const hdrs = ['SKU', 'Cabinet Type / Drawer Box', 'Door Style', 'Finish', 'Interior / Door Back', 'Hinge Type', 'Hinge Side', 'Shelf', 'TOTAL QTY', 'PRICE EA', 'PRICE EXT']
  const hrow = ws.getRow(r)
  hdrs.forEach((t, i) => {
    const cell = hrow.getCell(i + 1)
    cell.value = t
    cell.font = boldFont(9, 'FFFFFF')
    cell.fill = fill(COLORS.headerBar)
    cell.border = thinBorder()
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  hrow.height = 24
  hrow.commit()
  r++

  // Aggregate unique SKUs across the whole project (reclassified fillers excluded)
  const skuMap = {}
  unitTypes.forEach(ut => {
    ;[...(ut.skus || []), ...(ut.fillers || [])].forEach(item => {
      const key = (item.sku || '').toUpperCase()
      if (!key) return
      if (!skuMap[key]) skuMap[key] = { ...item, totalQty: 0 }
      skuMap[key].totalQty += (Number(item.quantity_per_unit) || 1) * (ut.unit_quantity || 1)
    })
  })

  const doorStyle = specs.door_style || specs.cabinet_line || ''
  const finish    = specs.finish_color || specs.finish || ''

  const rows = Object.values(skuMap).sort((a, b) => {
    const sa = sectionSortIndex(getSection(a.sku)), sb = sectionSortIndex(getSection(b.sku))
    return sa !== sb ? sa - sb : a.sku.localeCompare(b.sku)
  })

  let currentSection = null
  rows.forEach(item => {
    const section = getSection(item.sku)
    if (section !== currentSection) {
      currentSection = section
      fillLabel(ws, r, 1, 11, `──  ${section.toUpperCase()}  ──`, COLORS.sectionBand || 'E8E8E4')
      r++
    }
    const row = ws.getRow(r)
    const vals = [
      item.sku,
      'Standard/PB Standard',
      doorStyle,
      finish,
      '',
      'Euro 6 Way',
      normalizeHinge(item.hinge_side) || 'L/R',
      '3/4',
      item.totalQty,
      null,  // PRICE EA — manufacturer fills
      { formula: `I${r}*J${r}` },  // PRICE EXT = QTY × EA
    ]
    vals.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      if (v !== null) cell.value = v
      cell.border = thinBorder()
      cell.alignment = { horizontal: i === 0 || i === 1 ? 'left' : 'center', vertical: 'middle' }
    })
    row.getCell(10).fill = fill('FFF9E3')
    row.getCell(10).numFmt = '$#,##0.00'
    row.getCell(11).numFmt = '$#,##0.00'
    row.commit()
    r++
  })

  // Grand total row: sums the EXT column
  r++
  fillLabel(ws, r, 1, 8, `TOTAL  —  ${rows.length} unique SKUs  |  ${rows.reduce((s, x) => s + x.totalQty, 0).toLocaleString()} total pieces`, COLORS.grandTotal)
  ws.getCell(r, 9).value = rows.reduce((s, x) => s + x.totalQty, 0)
  ws.getCell(r, 9).font = boldFont(10)
  ws.getCell(r, 9).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 11).value = { formula: `SUM(K5:K${r - 2})` }
  ws.getCell(r, 11).font = boldFont(11)
  ws.getCell(r, 11).fill = fill(COLORS.grandTotal)
  ws.getCell(r, 11).numFmt = '$#,##0.00'
  ws.getRow(r).commit()
}

export async function POST(request) {
  try {
    const body = await request.json()
    const {
      takeoffData,
      projectName = takeoffData?.project_name || 'MDSG Project',
      supplierName = 'TBD',
      mode = 'internal',
      catalogRef = 'TBD',
      printDate = new Date().toLocaleDateString('en-US'),
    } = body

    if (!takeoffData?.unit_types?.length) {
      return Response.json({ error: 'No unit type data provided' }, { status: 400 })
    }

    const unitTypes = takeoffData.unit_types
    const totalUnits = unitTypes.reduce((s, u) => s + (u.unit_quantity || 1), 0)
    prepSheetNames(unitTypes)   // figure out which names need (1)/(2) suffixes
    const wb = new ExcelJS.Workbook()

    wb.creator = 'MDSG OS'
    wb.lastModifiedBy = 'MDSG OS'
    wb.created = new Date()
    wb.modified = new Date()

    // Build tabs — Leedo format + UKON quote request
    // Reclassify: any sku row matching the filler pattern moves to fillers —
    // keeps exports honest even for lists saved before a pattern was added
    unitTypes.forEach(ut => {
      const stay = [], moved = []
      ;(ut.skus || []).forEach(rw => (FILLER_RE.test(rw.sku || '') ? moved : stay).push(rw))
      if (moved.length) { ut.skus = stay; ut.fillers = [...(ut.fillers || []), ...moved] }
    })

    if (mode === 'manufacturer') {
      buildPricingSheet(wb, unitTypes, projectName, supplierName, printDate, takeoffData.specs || {})
    } else {
          buildMasterSummary(wb, unitTypes, projectName, supplierName, catalogRef, printDate, totalUnits, takeoffData.sheet_totals || null)
      unitTypes.forEach(ut => buildUnitTab(wb, ut, projectName, supplierName, catalogRef))
      buildHardwareTab(wb, unitTypes, projectName, supplierName, catalogRef)
      buildUkonQuoteTab(wb, unitTypes, projectName, printDate)
    }

    // Stream back as .xlsx
    const buffer = await wb.xlsx.writeBuffer()
    const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_')

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safeName}_${mode === 'manufacturer' ? 'Quote' : 'Full_List'}.xlsx"`,
      },
    })
  } catch (err) {
    console.error('Excel export error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
