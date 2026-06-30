'use client'

import { useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'


const inp = { padding: '6px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }
const lbl = { fontSize: 10, color: '#888', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }
const card = { background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, padding: 20, marginBottom: 16 }

export default function TakeoffEngine({ jobs, onComplete }) {
  const [stage, setStage] = useState(1)
  const [selectedJobId, setSelectedJobId] = useState('')
  const [files, setFiles] = useState([])
  const [specs, setSpecs] = useState('')
  const [uploading, setUploading] = useState(false)
  const [merging, setMerging] = useState(false)
  const [extractedData, setExtractedData] = useState(null)
  const [summary, setSummary] = useState(null)
  const [editData, setEditData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [expandedUnit, setExpandedUnit] = useState(null)
  const [supplementFiles, setSupplementFiles] = useState([])
  const [showAddPages, setShowAddPages] = useState(false)
  const [mergeStats, setMergeStats] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showUnitMix, setShowUnitMix] = useState(false)
  const [shopFiles, setShopFiles] = useState([])
  const [shopConfirmed, setShopConfirmed] = useState(false)
  const [shopCabinetData, setShopCabinetData] = useState(null)   // full per-unit SKU list from shops
  const [shopExtracting, setShopExtracting] = useState(false)
  const [summaryFiles, setSummaryFiles] = useState([])
  const [summaryData, setSummaryData] = useState(null)          // [{sku, qty, description, type, unit_type, unit_qty}]
  const [summaryUnitTypes, setSummaryUnitTypes] = useState([])   // [{name, quantity}] extracted from the doc
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryConfirmed, setSummaryConfirmed] = useState(false)
  const [matrixFiles, setMatrixFiles] = useState([])
  const [matrixData, setMatrixData] = useState(null)  // [{name, quantity, sheet}]
  const [matrixLoading, setMatrixLoading] = useState(false)
  const [matrixConfirmed, setMatrixConfirmed] = useState(false)
  const abortRef = useRef(null)
  const [classificationData, setClassificationData] = useState(null)
  const [classifying, setClassifying] = useState(false)

  // Mirrors lib/hardwareUtils.js isAppliance() — keep in sync
  function isApplianceSku(sku) {
    const u = (sku || '').toUpperCase().trim()
    return /^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|WASH|DRYER|OVEN|HOOD|VENT)/.test(u)
  }

  // Returns false for anything that should NOT count as a cabinet box
  function isTrueCabinet(sku) {
    const u = (sku || '').toUpperCase().trim()
    if (isApplianceSku(u)) return false                                    // appliances
    if (/^(EPT|PLYS|AD21)/.test(u)) return false                          // end panels
    if (/^(WF|TF|BF|BEP|EPB|F\d|TK8|TSK|TKPW|TKC|TRP|BRP|OCM)/.test(u)) return false  // fillers/toe kicks
    if (/^SCM/.test(u)) return false                                       // scribe molding
    if (/SCRIBE|SCRI|SKIN|SHELF/.test(u)) return false                    // trim
    if (/^CROWN|^MOLD|^VALANCE/.test(u)) return false                     // decorative
    return true
  }

  // Infer hinge side from SKU suffix — L = Left, R = Right, else Both
  function hingeFromSku(sku) {
    const u = (sku || '').toUpperCase().trim()
    // Ignore known suffixes that aren't hinge indicators
    if (/^(EPT|PLYS|TKPW|TKC|TK8|F\d)/.test(u)) return ''
    if (/L$/.test(u) && !/^(BLS|BW|BRL|CTRL|SCRL)/.test(u)) return 'L'
    if (/R$/.test(u) && !/^(BSR|WOR|EPR)/.test(u)) return 'R'
    return 'L/R'
  }

  // Hardware count — mirrors lib/hardwareUtils.js calculateHardware() exactly
  // Reference: Blake's Cabinet Schedule Reference Guide v2 (April 2026)
  function calcHardware(sku) {
    const SPECIAL = { 'CVDB36BDHL':5,'BLS36R':1,'CW2436R':1,'B30FH':2,'CVSDB36HFHR':2,'EPT90':0,'CVSDB48-DB15L':6 }
    const u = (sku || '').toUpperCase().trim()
    if (!u) return null
    // Zero-hardware items
    const ZERO_PRE = ['F3','F4','F5','F6','TRP','BRP','TKPW','TKC','TK8','TSK','OCM','WF','TF','BEP','EPB']
    const ZERO_EX  = ['PLYS','EPT','AD21']
    if (ZERO_EX.some(p => u === p || u.startsWith(p))) return 0
    if (ZERO_PRE.some(p => u.startsWith(p))) return 0
    // Strip -32.5 accessible suffix before matching
    const ub = u.replace(/-32\.5$/,'').replace(/-32\.5-/,'-')
    // Special cases — use ub (stripped) for lookup, fixing -32.5 mismatch bug
    if (SPECIAL[ub] !== undefined) return SPECIAL[ub]
    // SKYL numeric prefix (20-20 Tech): 3DB15 = 3
    const skylM = ub.match(/^(\d+)(DB|VDB|DWR)/)
    if (skylM) return parseInt(skylM[1])
    // Dash-number suffix = drawer/door count (max 6 per reference guide)
    const dashM = ub.match(/-(\d+)[A-Z]?$/)
    if (dashM) { const n = parseInt(dashM[1]); if (n >= 1 && n <= 6) return n }
    // Fixed-count categories (reference guide §4 + §11)
    if (/^BB/.test(ub))  return 1   // Blind Base
    if (/^BW/.test(ub))  return 1   // Blind Wall
    if (/^BLS/.test(ub)) return 1   // Lazy Susan
    if (/^CW/.test(ub))  return 1   // Corner Wall
    if (/^HC/.test(ub))  return 2   // Handicap Accessible (HC, HCA, HCSB, HCAC)
    if (/^EB/.test(ub))  return 2   // Easy Accessible Base
    if (/^BMC/.test(ub)) return 2   // Base Microwave Cabinet
    if (/^(LC|LT|PT)/.test(ub)) return 2   // Tall Linen / Pantry
    if (/^(T\d|P\d)/.test(ub))  return 2   // Tall / Pantry
    // Width extraction
    const VALID_W = new Set([9,12,15,18,21,24,27,30,33,36,39,42,45,48])
    function getW(s) {
      const n = s.replace(/-32\.5/,'').replace(/^\d+/,'').replace(/^[A-Z]+/i,'')
      if (n.length >= 2) { const t = parseInt(n.substring(0,2)); if (VALID_W.has(t)) return t }
      if (n.length >= 3) return parseInt(n.substring(0,3))
      return null
    }
    const w = getW(ub)
    if (/^(WBC|WHL|WO)/.test(ub)) return (w||99) <= 21 ? 1 : 2
    if (/^DB/.test(ub))  return (w||99) <= 21 ? 2 : 3   // Drawer Base no dash — estimated
    if (/^(B|SB)/.test(ub)) return (w||99) <= 21 ? 2 : 3   // Base / Sink Base
    if (/^W/.test(ub))   return (w||99) <= 21 ? 1 : 2   // Wall
    if (/^(VSB|VDB|CVDB|CVSDB|VSD|VB|VS)/.test(ub)) return (w||99) <= 21 ? 1 : 2   // Vanity
    return null
  }

  // Excel export
  async function exportToExcel() {
    setExporting(true)
    try {
      const res = await fetch('/api/export/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          takeoffData: editData,
          projectName: editData.project_name || 'MDSG Project',
          supplierName: editData.specs?.cabinet_line || 'TBD',
          catalogRef: 'TBD',
          printDate: new Date().toLocaleDateString('en-US'),
        }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed') }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${(editData.project_name || 'Cabinet_Schedule').replace(/[^a-zA-Z0-9_-]/g,'_')}_Cabinet_Schedule.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Export failed: ' + err.message)
    }
    setExporting(false)
  }

  async function runExtraction() {
    if (files.length === 0) return alert('Upload at least one PDF plan page')
    setUploading(true)
    const formData = new FormData()
    if (selectedJobId) formData.append('jobId', selectedJobId)
    const specsStr = [shopFiles.length > 0 ? 'Shop drawings included — prioritize SKUs and elevations from shop drawing pages.' : '', specs].filter(Boolean).join(' ')
    formData.append('specs', specsStr)
    if (matrixData && matrixConfirmed) formData.append('unitMatrix', JSON.stringify(matrixData))
    if (classificationData) formData.append('classificationData', JSON.stringify(classificationData))
    if (summaryData && summaryConfirmed) formData.append('cabinetSummary', JSON.stringify(summaryData))
    shopFiles.forEach(f => formData.append('files', f))
    files.forEach(f => formData.append('files', f))
    abortRef.current = new AbortController()
    const timeout = setTimeout(() => abortRef.current?.abort(), 600000)
    try {
      const res = await fetch('/api/takeoff', { method: 'POST', body: formData, signal: abortRef.current.signal })
      clearTimeout(timeout)
      const result = await res.json()
      setUploading(false)
      abortRef.current = null
      if (result.success) {
        setExtractedData(result.data)
        setSummary(result.summary)
        setEditData(JSON.parse(JSON.stringify(result.data)))
        setStage(2)
      } else {
        alert('Extraction failed: ' + (result.error || 'Unknown error'))
      }
    } catch (err) {
      clearTimeout(timeout)
      setUploading(false)
      abortRef.current = null
      if (err.name !== 'AbortError') alert('Extraction error: ' + err.message)
      // AbortError = user cancelled — silently stop
    }
  }

  async function runSupplement() {
    if (supplementFiles.length === 0) return alert('Select elevation/floor plan pages to add')
    setMerging(true)
    const formData = new FormData()
    formData.append('existingData', JSON.stringify(editData))
    formData.append('specs', specs)
    supplementFiles.forEach(f => formData.append('files', f))
    const res = await fetch('/api/takeoff', { method: 'PUT', body: formData })
    const result = await res.json()
    setMerging(false)
    if (result.success) {
      setEditData(result.data)
      setSummary(result.summary)
      setMergeStats(result.merge_stats)
      setShowAddPages(false)
      setSupplementFiles([])
    } else {
      alert('Merge failed: ' + (result.error || 'Unknown error'))
    }
  }

  async function runClassification() {
    if (files.length === 0) return alert('Upload a PDF first')
    setClassifying(true)
    setClassificationData(null)
    try {
      const file = files[0]
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/takeoff/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: base64 }),
      })
      const result = await res.json()
      if (result.success) {
        setClassificationData(result)
      } else {
        alert('Classification failed: ' + (result.error || 'Unknown error'))
      }
    } catch (err) {
      alert('Classification error: ' + err.message)
    }
    setClassifying(false)
  }

  async function exportSummaryToExcel() {
    if (!summaryData?.length) return
    setExporting(true)
    try {
      const job         = jobs.find(j => j.id === selectedJobId)
      const projectName = job?.name || 'Cabinet Schedule'
      const NON_CAB     = new Set(['filler', 'toe_kick', 'end_panel'])

      // ── Build unit_types for the Excel export ────────────────────────────
      // Strategy A: items have unit_type populated → group into per-unit tabs
      // Strategy B: summaryUnitTypes from doc + matrixData → distribute items across unit types
      // Strategy C: fallback → single "All Units" tab with total quantities

      // Strategy 0: shop cabinet data — full per-unit SKU list from elevations (most accurate)
      if (shopCabinetData?.length > 0) {
        // Build a lookup of summary unit counts by normalized name (summary is authoritative)
        const summaryCountMap = {}
        ;(summaryUnitTypes || []).forEach(u => {
          const key = u.name?.trim().toUpperCase()
          if (key) summaryCountMap[key] = u.quantity
        })

        unitTypesForExport = shopCabinetData.map(ut => {
          const cabSkus   = (ut.skus || []).filter(s => s.type === 'cabinet' || (!s.type && isTrueCabinet(s.sku)))
          const fillItems = (ut.skus || []).filter(s => s.type !== 'cabinet' && s.type !== undefined)
          const shopCount = ut.unit_count || 1

          // Check if summary overrides the unit count
          const nameKey = ut.unit_type_name?.trim().toUpperCase()
          const summaryCount = summaryCountMap[nameKey]
          const finalCount   = summaryCount ?? shopCount
          const tab_notes    = []

          if (summaryCount !== undefined && summaryCount !== shopCount) {
            tab_notes.push(
              `Unit count: Summary shows ${summaryCount} units — Shop drawings show ${shopCount} units. Summary value used (${summaryCount}).`
            )
          }
          if (!summaryCount && summaryUnitTypes?.length > 0) {
            tab_notes.push(
              `This unit type name was not found in the Leedo summary — verify unit count (${shopCount} from shops).`
            )
          }

          return {
            unit_type_name: ut.unit_type_name,
            unit_quantity:  finalCount,
            cabinet_count:  cabSkus.reduce((s, r) => s + (r.qty || 1), 0),
            tab_notes:      tab_notes.length > 0 ? tab_notes : undefined,
            skus: cabSkus.map(r => ({
              sku: r.sku,
              description: r.description || '',
              quantity_per_unit: r.qty || 1,
              hinge_side: r.hinge_side || hingeFromSku(r.sku),
            })),
            fillers: fillItems.map(r => ({
              sku: r.sku,
              description: r.description || '',
              quantity_per_unit: r.qty || 1,
            })),
          }
        })

        const res = await fetch('/api/export/excel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            takeoffData: { project_name: projectName, unit_types: unitTypesForExport, specs: { cabinet_line: job?.manufacturer || 'TBD', door_style: job?.door_style || 'TBD', finish: job?.finish_color || 'TBD', box_construction: job?.box_construction || 'TBD' } },
            projectName,
            supplierName: job?.manufacturer || 'TBD',
            catalogRef: 'TBD',
            printDate: new Date().toLocaleDateString('en-US'),
          }),
        })
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed') }
        const blob = await res.blob()
        const url  = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url
        a.download = `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}_Cabinet_Schedule.xlsx`
        a.click(); URL.revokeObjectURL(url)
        setExporting(false)
        return
      }

      // Determine which unit types to use for tabs — pick the best available source
      const hasItemUnitTypes = summaryData.some(r => r.unit_type && r.unit_type.trim() !== '')
      const docUnitTypes     = summaryUnitTypes?.length > 0 ? summaryUnitTypes : null
      const matrixTypes      = matrixData?.length && matrixConfirmed ? matrixData.map(u => ({ name: u.name, quantity: u.quantity || 1 })) : null
      const sourceUnitTypes  = docUnitTypes || matrixTypes || null   // best available

      let unitTypesForExport = []

      if (hasItemUnitTypes) {
        // Strategy A: items already have per-unit quantities and unit_type groupings from the doc
        const groups = {}
        const unitQtyMap = {}
        ;(summaryUnitTypes || []).forEach(ut => { unitQtyMap[ut.name] = ut.quantity })
        summaryData.forEach(item => {
          const key = item.unit_type || 'Other'
          if (!groups[key]) groups[key] = []
          groups[key].push(item)
          if (!unitQtyMap[key]) unitQtyMap[key] = item.unit_qty || 1
        })
        unitTypesForExport = Object.entries(groups).map(([name, items]) => {
          const qty = unitQtyMap[name] || 1
          return {
            unit_type_name: name,
            unit_quantity:  qty,
            cabinet_count:  items.filter(r => !NON_CAB.has(r.type)).reduce((s, r) => s + (r.qty || 0), 0),
            skus:    items.filter(r => !NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0, hinge_side: r.hinge_side || '' })),
            fillers: items.filter(r =>  NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0 })),
          }
        })

      } else if (sourceUnitTypes) {
        // Strategy B: we have unit types (from doc or matrix) but only flat totals
        // Compute per-unit qty = round(total_qty / unit_count) for each SKU per unit type
        // This works correctly for projects where all unit types share the same cabinet layout
        const totalUnitsAll = sourceUnitTypes.reduce((s, u) => s + (u.quantity || 1), 0)
        const allSkus = summaryData.filter(r => !NON_CAB.has(r.type))
        const allFill = summaryData.filter(r =>  NON_CAB.has(r.type))

        unitTypesForExport = sourceUnitTypes.map(ut => {
          const utQty = ut.quantity || 1
          // Per-unit qty = round(total_qty / total_all_units)
          // This correctly distributes flat totals when all unit types share the same layout.
          // No Math.max(1) — if a SKU genuinely has 0 per unit it should show 0.
          const qpu = (item) => Math.round((item.qty || 0) / totalUnitsAll) || 0
          return {
            unit_type_name: ut.name,
            unit_quantity:  utQty,
            cabinet_count:  allSkus.reduce((s, r) => s + qpu(r), 0),
            skus:    allSkus.filter(r => qpu(r) > 0).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: qpu(r), hinge_side: r.hinge_side || '' })),
            fillers: allFill.filter(r => qpu(r) > 0).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: qpu(r) })),
          }
        })

      } else {
        // Strategy C: no unit type info at all — single "All Units" tab with totals as-is
        unitTypesForExport = [{
          unit_type_name: 'All Units',
          unit_quantity:  1,
          cabinet_count:  summaryData.filter(r => !NON_CAB.has(r.type)).reduce((s, r) => s + (r.qty || 0), 0),
          skus:    summaryData.filter(r => !NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0, hinge_side: r.hinge_side || '' })),
          fillers: summaryData.filter(r =>  NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0 })),
        }]
      }

      const takeoffData = {
        project_name: projectName,
        unit_types:   unitTypesForExport,
        specs: {
          cabinet_line:     job?.manufacturer     || 'TBD',
          door_style:       job?.door_style        || 'TBD',
          finish:           job?.finish_color       || 'TBD',
          box_construction: job?.box_construction  || 'TBD',
        },
      }

      const res = await fetch('/api/export/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          takeoffData,
          projectName,
          supplierName: job?.manufacturer || 'TBD',
          catalogRef:   'TBD',
          printDate:    new Date().toLocaleDateString('en-US'),
        }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed') }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a'); a.href = url
      a.download = `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}_Cabinet_Schedule.xlsx`
      a.click(); URL.revokeObjectURL(url)
    } catch (err) {
      alert('Export failed: ' + err.message)
    }
    setExporting(false)
  }

  async function runSummaryExtraction() {
    if (summaryFiles.length === 0) return alert('Upload the cabinet summary / order doc first')
    setSummaryLoading(true)
    try {
      const formData = new FormData()
      summaryFiles.forEach(f => formData.append('files', f))
      const res = await fetch('/api/takeoff/cabinet-summary', { method: 'POST', body: formData, signal: AbortSignal.timeout(480000) })
      const result = await res.json()
      if (result.success) {
        setSummaryData(result.items)
        setSummaryUnitTypes(result.unit_types || [])
        setSummaryConfirmed(false)
      } else {
        alert('Extraction failed: ' + (result.error || 'Unknown error'))
      }
    } catch (err) {
      alert('Error: ' + err.message)
    }
    setSummaryLoading(false)
  }

  async function runMatrixExtraction() {
    if (matrixFiles.length === 0) return alert('Upload the unit schedule pages first')
    setMatrixLoading(true)
    try {
      const formData = new FormData()
      matrixFiles.forEach(f => formData.append('files', f))
      const res = await fetch('/api/takeoff/matrix', { method: 'POST', body: formData, signal: AbortSignal.timeout(120000) })
      const result = await res.json()
      if (result.success) {
        setMatrixData(result.units)
        setMatrixConfirmed(false)
      } else {
        alert('Matrix extraction failed: ' + (result.error || 'Unknown error'))
      }
    } catch (err) {
      alert('Matrix extraction error: ' + err.message)
    }
    setMatrixLoading(false)
  }

  async function saveToJob() {
    if (!selectedJobId) return alert('Select a job to save this cabinet list to')
    setSaving(true)
    await supabase.from('cabinet_line_items').delete().eq('job_id', selectedJobId)
    await supabase.from('unit_types').delete().eq('job_id', selectedJobId)
    let grandTotal = 0
    for (let i = 0; i < editData.unit_types.length; i++) {
      const ut = editData.unit_types[i]
      const cabsPerUnit = ut.skus?.reduce((s, sk) => s + (isTrueCabinet(sk.sku) ? (Number(sk.quantity_per_unit) || 0) : 0), 0) || 0
      grandTotal += cabsPerUnit * (ut.unit_quantity || 1)
      const { data: utData } = await supabase.from('unit_types').insert({
        job_id: selectedJobId, unit_type_name: ut.unit_type_name,
        unit_quantity: ut.unit_quantity || 1, cabinet_count: cabsPerUnit,
        total_cubes: 0, manufacturer_price: 0, sort_order: i,
      }).select().single()
      if (utData) {
        const lineItems = [
          ...(ut.skus || []).map((sk, j) => ({ unit_type_id: utData.id, job_id: selectedJobId, sku: sk.sku, description: sk.description || '', door_style: editData.specs?.door_style || '', finish: editData.specs?.finish || '', hinge_side: sk.hinge_side || '', quantity: Number(sk.quantity_per_unit) || 1, extended_price: 0, sort_order: j })),
          ...(ut.fillers || []).map((f, j) => ({ unit_type_id: utData.id, job_id: selectedJobId, sku: f.sku, description: f.description || '', door_style: '', finish: '', hinge_side: '', quantity: Number(f.quantity_per_unit) || 1, extended_price: 0, sort_order: 1000 + j })),
        ]
        if (lineItems.length > 0) await supabase.from('cabinet_line_items').insert(lineItems)
      }
    }
    await supabase.from('jobs').update({
      door_style: editData.specs?.door_style || '',
      finish_color: editData.specs?.finish || '',
      box_construction: editData.specs?.box_construction || '',
      total_cabinet_count: grandTotal,
      unit_type_count: editData.unit_types.length,
    }).eq('id', selectedJobId)
    await supabase.from('activity_log').insert({
      job_id: selectedJobId, user_name: 'Cole',
      action: `Takeoff finalized — ${editData.unit_types.length} unit types · ${grandTotal.toLocaleString()} cabinets · ${grandTotalFillers.toLocaleString()} fillers`,
    })
    setSaving(false)
    setStage(3)
    if (onComplete) onComplete()
  }

  function updateUnitField(idx, field, value) {
    const u = { ...editData }; u.unit_types[idx][field] = value; setEditData(u)
  }
  function updateSku(ui, si, field, value) {
    const u = { ...editData }; u.unit_types[ui].skus[si][field] = value; setEditData(u)
  }
  function updateFiller(ui, fi, field, value) {
    const u = { ...editData }; u.unit_types[ui].fillers[fi][field] = value; setEditData(u)
  }
  function addSku(ui) {
    const u = { ...editData }; u.unit_types[ui].skus.push({ sku: '', description: '', quantity_per_unit: 1, hinge_side: '', location: 'kitchen', notes: '' }); setEditData(u)
  }
  function removeSku(ui, si) {
    const u = { ...editData }; u.unit_types[ui].skus.splice(si, 1); setEditData(u)
  }
  function addFiller(ui) {
    const u = { ...editData }; u.unit_types[ui].fillers.push({ sku: 'F330', description: 'Filler 3 inch', quantity_per_unit: 1, location: '' }); setEditData(u)
  }
  function removeFiller(ui, fi) {
    const u = { ...editData }; u.unit_types[ui].fillers.splice(fi, 1); setEditData(u)
  }
  function addUnitType() {
    const u = { ...editData }; u.unit_types.push({ unit_type_name: 'New Unit Type', unit_quantity: 1, is_amenity: false, sheet_reference: '', skus: [], fillers: [], toe_kick_lf: 0, toe_kick_notes: '', total_cabinets_per_unit: 0 }); setEditData(u); setExpandedUnit(u.unit_types.length - 1)
  }
  function removeUnitType(idx) {
    if (!confirm('Remove this unit type?')) return
    const u = { ...editData }; u.unit_types.splice(idx, 1); setEditData(u); setExpandedUnit(null)
  }

  const getCabsPerUnit = (ut) =>
    (ut.skus?.reduce((s, sk) => s + (isTrueCabinet(sk.sku) ? (Number(sk.quantity_per_unit) || 0) : 0), 0) || 0)

  const getNonCabinetsPerUnit = (ut) =>
    (ut.skus?.reduce((s, sk) => s + (!isTrueCabinet(sk.sku) ? (Number(sk.quantity_per_unit) || 0) : 0), 0) || 0)

  const getFillersPerUnit = (ut) =>
    (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0)

  const grandTotal            = editData?.unit_types?.reduce((s, ut) => s + getCabsPerUnit(ut)        * (ut.unit_quantity || 1), 0) || 0
  const grandTotalFillers     = editData?.unit_types?.reduce((s, ut) => s + getFillersPerUnit(ut)     * (ut.unit_quantity || 1), 0) || 0
  const grandTotalNonCabinets = editData?.unit_types?.reduce((s, ut) => s + getNonCabinetsPerUnit(ut) * (ut.unit_quantity || 1), 0) || 0

  // Build Pages Needed summary from unit types
  function getPagesNeeded() {
    if (!editData?.unit_types) return { withSkus: [], withoutSkus: [], allSheets: [] }
    const withSkus = []
    const withoutSkus = []
    const allSheets = []
    editData.unit_types.forEach(ut => {
      const sheet = ut.sheet_reference
      if (sheet) allSheets.push(sheet)
      if (ut.skus?.length > 0) withSkus.push({ name: ut.unit_type_name, sheet })
      else withoutSkus.push({ name: ut.unit_type_name, sheet })
    })
    return {
      withSkus,
      withoutSkus,
      allSheets: [...new Set(allSheets)].sort(),
      sheetsNeeded: [...new Set(withoutSkus.map(u => u.sheet).filter(Boolean))].sort(),
    }
  }

  // ── Save to job (works from summary or full takeoff) ─────────────────────
  async function saveCurrentToJob() {
    if (!selectedJobId) return alert('Select a job above first')
    setSaving(true)

    // Build unit types from whichever source is available
    const NON_CAB = new Set(['filler', 'toe_kick', 'end_panel'])
    let unitTypesToSave = []

    if (editData?.unit_types?.length) {
      // Full takeoff completed — use editData
      unitTypesToSave = editData.unit_types
    } else if (shopCabinetData?.length) {
      // Shop drawing extraction — use summary count as override when available
      const summaryCountMap = {}
      ;(summaryUnitTypes || []).forEach(u => { summaryCountMap[u.name?.trim().toUpperCase()] = u.quantity })
      unitTypesToSave = shopCabinetData.map(ut => {
        const key = ut.unit_type_name?.trim().toUpperCase()
        const finalQty = summaryCountMap[key] ?? ut.unit_count ?? 1
        return {
        unit_type_name: ut.unit_type_name,
        unit_quantity:  finalQty,
        skus:    (ut.skus || []).filter(s => s.type === 'cabinet' || (!s.type && isTrueCabinet(s.sku))).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 1, hinge_side: r.hinge_side || hingeFromSku(r.sku) })),
        fillers: (ut.skus || []).filter(s => s.type && s.type !== 'cabinet').map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 1 })),
        }
      })
    } else if (summaryData?.length && summaryConfirmed) {
      // Summary-only flow — build from summaryData + unit types
      const docUnitTypes  = summaryUnitTypes?.length > 0 ? summaryUnitTypes : null
      const matrixTypes   = matrixData?.length && matrixConfirmed ? matrixData.map(u => ({ name: u.name, quantity: u.quantity || 1 })) : null
      const sourceTypes   = docUnitTypes || matrixTypes

      if (sourceTypes) {
        const totalUnitsAll = sourceTypes.reduce((s, u) => s + (u.quantity || 1), 0)
        const hasItemTypes  = summaryData.some(r => r.unit_type && r.unit_type.trim() !== '')
        if (hasItemTypes) {
          const groups = {}
          summaryData.forEach(item => {
            const key = item.unit_type || 'Other'
            if (!groups[key]) groups[key] = []
            groups[key].push(item)
          })
          unitTypesToSave = Object.entries(groups).map(([name, items]) => {
            const ut = sourceTypes.find(u => u.name === name) || { quantity: 1 }
            return { unit_type_name: name, unit_quantity: ut.quantity, skus: items.filter(r => !NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0, hinge_side: r.hinge_side || '' })), fillers: items.filter(r => NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0 })) }
          })
        } else {
          const qpu = (item) => Math.round((item.qty || 0) / totalUnitsAll) || 0
          unitTypesToSave = sourceTypes.map(ut => ({
            unit_type_name: ut.name, unit_quantity: ut.quantity || 1,
            skus:    summaryData.filter(r => !NON_CAB.has(r.type) && qpu(r) > 0).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: qpu(r), hinge_side: r.hinge_side || '' })),
            fillers: summaryData.filter(r =>  NON_CAB.has(r.type) && qpu(r) > 0).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: qpu(r) })),
          }))
        }
      } else {
        unitTypesToSave = [{ unit_type_name: 'All Units', unit_quantity: 1, skus: summaryData.filter(r => !NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0, hinge_side: r.hinge_side || '' })), fillers: summaryData.filter(r => NON_CAB.has(r.type)).map(r => ({ sku: r.sku, description: r.description || '', quantity_per_unit: r.qty || 0 })) }]
      }
    } else {
      setSaving(false)
      return alert('No cabinet data to save yet — complete the extraction or upload a cabinet summary first')
    }

    // Delete existing and re-insert
    await supabase.from('cabinet_line_items').delete().eq('job_id', selectedJobId)
    await supabase.from('unit_types').delete().eq('job_id', selectedJobId)
    let grandTotal = 0
    for (let i = 0; i < unitTypesToSave.length; i++) {
      const ut = unitTypesToSave[i]
      const cabsPerUnit = (ut.skus || []).reduce((s, sk) => s + (isTrueCabinet(sk.sku) ? (Number(sk.quantity_per_unit) || 0) : 0), 0)
      grandTotal += cabsPerUnit * (ut.unit_quantity || 1)
      const { data: utData } = await supabase.from('unit_types').insert({
        job_id: selectedJobId, unit_type_name: ut.unit_type_name,
        unit_quantity: ut.unit_quantity || 1, cabinet_count: cabsPerUnit,
        total_cubes: 0, manufacturer_price: 0, sort_order: i,
      }).select().single()
      if (utData) {
        const lineItems = [
          ...(ut.skus || []).map((sk, j) => ({ unit_type_id: utData.id, job_id: selectedJobId, sku: sk.sku, description: sk.description || '', door_style: '', finish: '', hinge_side: sk.hinge_side || '', quantity: Number(sk.quantity_per_unit) || 1, extended_price: 0, sort_order: j })),
          ...(ut.fillers || []).map((f, j) => ({ unit_type_id: utData.id, job_id: selectedJobId, sku: f.sku, description: f.description || '', door_style: '', finish: '', hinge_side: '', quantity: Number(f.quantity_per_unit) || 1, extended_price: 0, sort_order: 1000 + j })),
        ]
        if (lineItems.length > 0) await supabase.from('cabinet_line_items').insert(lineItems)
      }
    }
    await supabase.from('jobs').update({
      total_cabinet_count: grandTotal,
      unit_type_count: unitTypesToSave.length,
    }).eq('id', selectedJobId)
    await supabase.from('activity_log').insert({
      job_id: selectedJobId, user_name: 'Cole',
      action: `Cabinet list saved — ${unitTypesToSave.length} unit types · ${grandTotal.toLocaleString()} cabinets`,
    })
    setSaving(false)
    if (onComplete) onComplete()
    alert(`✓ Saved — ${grandTotal.toLocaleString()} cabinets across ${unitTypesToSave.length} unit types`)
  }

  return (
    <div>
      {/* ── JOB SELECTOR + SAVE — always visible at top ── */}
      <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, color: '#888', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>Link to Job</label>
          <select value={selectedJobId} onChange={e => setSelectedJobId(e.target.value)} style={{ width: '100%', padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }}>
            <option value="">— Select a job —</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </div>
        <div style={{ paddingTop: 16 }}>
          <button onClick={saveCurrentToJob} disabled={saving || !selectedJobId}
            style={{ padding: '8px 20px', fontSize: 12, background: saving ? '#888' : selectedJobId ? '#2D7A3A' : '#ccc', color: '#fff', border: 'none', borderRadius: 6, cursor: saving || !selectedJobId ? 'default' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {saving ? 'Saving...' : '✓ Save to Job'}
          </button>
        </div>
        {selectedJobId && (() => {
          const job = jobs.find(j => j.id === selectedJobId)
          return job?.total_cabinet_count > 0 ? (
            <div style={{ paddingTop: 16, fontSize: 11, color: '#888', whiteSpace: 'nowrap' }}>
              Last saved: <strong style={{ color: '#3C3489' }}>{job.total_cabinet_count.toLocaleString()} cabs</strong>
            </div>
          ) : null
        })()}
      </div>

      {/* ── STAGE 1: UPLOAD ── */}
      {stage === 1 && (
        <div style={{ maxWidth: 680, margin: '0 auto' }}>

          {/* ── STEP 1: SHOP DRAWINGS ── */}
          <div style={{ ...card, border: shopConfirmed ? '1.5px solid #2D7A3A' : '0.5px solid #e5e5e0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                <span style={{ background: shopConfirmed ? '#2D7A3A' : '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>1</span>
                Shop Drawings <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>— Upload shop drawing PDFs</span>
              </div>
              {shopConfirmed && <span style={{ fontSize: 11, color: '#2D7A3A', fontWeight: 600 }}>✓ {shopFiles.length > 0 ? `${shopFiles.length} file${shopFiles.length !== 1 ? 's' : ''} ready` : 'Skipped'}</span>}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              Upload the shop drawings — cabinet elevation sheets, SKU schedules, and unit layouts. The AI uses these as the primary source for cabinet SKU extraction. Skip if you only have architectural plans.
            </div>

            {!shopConfirmed ? (
              <>
                <label style={{ display: 'block', border: `1.5px dashed ${shopFiles.length > 0 ? '#2D7A3A' : '#ccc'}`, borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer', background: '#fafaf8', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>
                    {shopFiles.length === 0 ? '📐 Click to upload shop drawing PDFs' : `${shopFiles.length} file${shopFiles.length > 1 ? 's' : ''} selected`}
                  </div>
                  {shopFiles.length > 0 && (
                    <div style={{ marginTop: 8, textAlign: 'left' }}>
                      {shopFiles.map((f, i) => <div key={i} style={{ fontSize: 10, color: '#555', padding: '2px 0' }}>📄 {f.name} ({(f.size / 1024 / 1024).toFixed(1)} MB)</div>)}
                    </div>
                  )}
                  <input type="file" accept=".pdf" multiple onChange={e => setShopFiles(Array.from(e.target.files))} style={{ display: 'none' }} />
                </label>
                {shopFiles.length > 0 && (
                  <button onClick={() => setShopConfirmed(true)}
                    style={{ width: '100%', padding: 10, background: '#2D7A3A', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                    ✓ Confirm Shop Drawings — Proceed to Step 2
                  </button>
                )}
                <div style={{ fontSize: 10, color: '#aaa', textAlign: 'center' }}>
                  Skip if running from plan set only · <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setShopConfirmed(true)}>Skip →</span>
                </div>
              </>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: shopFiles.length > 0 ? 8 : 0 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {shopFiles.length > 0
                      ? shopFiles.map((f, i) => (
                          <span key={i} style={{ fontSize: 10, background: '#e8f5e9', color: '#2D7A3A', padding: '2px 8px', borderRadius: 10, fontWeight: 500 }}>📄 {f.name}</span>
                        ))
                      : <span style={{ fontSize: 11, color: '#888' }}>Skipped — plan set only</span>
                    }
                  </div>
                  <button onClick={() => setShopConfirmed(false)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Edit</button>
                </div>
                {shopFiles.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* Button A — unit counts only (fast) */}
                    {!matrixConfirmed && (
                      <button
                        onClick={async () => {
                          setMatrixLoading(true)
                          try {
                            const fd = new FormData()
                            shopFiles.forEach(f => fd.append('files', f))
                            const res = await fetch('/api/takeoff/matrix', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) })
                            const result = await res.json()
                            if (result.success) { setMatrixData(result.units); setMatrixConfirmed(true) }
                            else alert('Could not extract unit counts: ' + (result.error || 'Unknown'))
                          } catch (err) { alert('Error: ' + err.message) }
                          setMatrixLoading(false)
                        }}
                        disabled={matrixLoading || shopExtracting}
                        style={{ width: '100%', padding: '7px 12px', fontSize: 11, background: matrixLoading ? '#888' : '#2D7A3A', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                        {matrixLoading ? '⏳ Reading Unit Counts...' : '📋 Extract Unit Counts from Shops'}
                      </button>
                    )}

                    {/* Button B — full cabinet list from elevations */}
                    <button
                      onClick={async () => {
                        setShopExtracting(true)
                        try {
                          const fd = new FormData()
                          shopFiles.forEach(f => fd.append('files', f))
                          const res = await fetch('/api/takeoff/shops', { method: 'POST', body: fd, signal: AbortSignal.timeout(300000) })
                          const result = await res.json()
                          if (result.success) {
                            setShopCabinetData(result.unit_types)
                            // Also populate matrix from the summary so unit counts are confirmed
                            if (result.summary?.length) {
                              setMatrixData(result.summary.map(u => ({ name: u.name, quantity: u.quantity, sheet: null })))
                              setMatrixConfirmed(true)
                            }
                          } else {
                            alert('Shop extraction failed: ' + (result.error || 'Unknown error'))
                          }
                        } catch (err) { alert('Error: ' + err.message) }
                        setShopExtracting(false)
                      }}
                      disabled={shopExtracting || matrixLoading}
                      style={{ width: '100%', padding: '8px 12px', fontSize: 12, background: shopExtracting ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: shopExtracting ? 'default' : 'pointer', fontWeight: 700 }}>
                      {shopExtracting ? '⏳ Reading Cabinet SKUs from Elevations...' : '🔍 Extract Full Cabinet List from Shop Drawings'}
                    </button>
                  </div>
                )}

                {shopCabinetData?.length > 0 && (
                  <div style={{ marginTop: 8, background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: 8, padding: '8px 12px', fontSize: 11, color: '#2D7A3A' }}>
                    ✓ Cabinet list extracted from shops: {shopCabinetData.map(u => `${u.unit_type_name} (${u.skus.filter(s=>s.type==='cabinet').reduce((s,r)=>s+(r.qty||1),0)} cabs)`).join(' · ')}
                  </div>
                )}
                {matrixConfirmed && matrixData?.length > 0 && !shopCabinetData && (
                  <div style={{ fontSize: 10, color: '#2D7A3A', marginTop: 4 }}>
                    ✓ Unit counts: {matrixData.map(u => `${u.name} (${u.quantity})`).join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── STEP 2: UNIT MATRIX ── */}
          <div style={{ ...card, border: matrixConfirmed ? '1.5px solid #2D7A3A' : '0.5px solid #e5e5e0', opacity: !shopConfirmed ? 0.55 : 1, pointerEvents: !shopConfirmed ? 'none' : 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                <span style={{ background: matrixConfirmed ? '#2D7A3A' : '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>2</span>
                Unit Matrix <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>— Optional: upload unit schedule pages</span>
              </div>
              {matrixConfirmed && <span style={{ fontSize: 11, color: '#2D7A3A', fontWeight: 600 }}>✓ {matrixData?.length} unit types · {matrixData?.reduce((s,u)=>s+(u.quantity||0),0)} total units confirmed</span>}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              Find the unit schedule / unit mix pages in your plan set (usually 1–2 pages showing plan types and counts per floor). Export just those pages as a PDF and upload here. The AI reads the counts — you verify before the full run.
            </div>

            {!matrixConfirmed && (
              <>
                <label style={{ display: 'block', border: `1.5px dashed ${matrixFiles.length > 0 ? '#3C3489' : '#ccc'}`, borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer', background: '#fafaf8', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>
                    {matrixFiles.length === 0 ? '📋 Click to upload unit schedule PDF pages' : `${matrixFiles.length} file${matrixFiles.length > 1 ? 's' : ''} selected`}
                  </div>
                  {matrixFiles.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {matrixFiles.map((f,i) => <div key={i} style={{ fontSize: 10, color: '#555' }}>📄 {f.name}</div>)}
                    </div>
                  )}
                  <input type="file" accept=".pdf" multiple onChange={e => setMatrixFiles(Array.from(e.target.files))} style={{ display: 'none' }} />
                </label>

                {matrixFiles.length > 0 && !matrixData && (
                  <button onClick={runMatrixExtraction} disabled={matrixLoading}
                    style={{ width: '100%', padding: 10, background: matrixLoading ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: matrixLoading ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
                    {matrixLoading ? '⏳ Reading Unit Schedule...' : '🔍 Extract Unit Mix'}
                  </button>
                )}

                {matrixData && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#333', marginBottom: 6 }}>
                      AI extracted {matrixData.length} unit types — verify and edit before confirming:
                    </div>
                    <div style={{ background: '#f9f9f9', border: '0.5px solid #ddd', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 28px', padding: '6px 10px', background: '#eee', fontSize: 10, fontWeight: 600, color: '#555', gap: 8 }}>
                        <span>PLAN TYPE</span><span style={{textAlign:'center'}}>QTY</span><span style={{textAlign:'center'}}>SHEET REF</span><span/>
                      </div>
                      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                        {matrixData.map((u, i) => (
                          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 28px', padding: '4px 10px', borderBottom: '0.5px solid #eee', alignItems: 'center', gap: 8 }}>
                            <input value={u.name} onChange={e => setMatrixData(p => p.map((r,j) => j===i ? {...r, name: e.target.value} : r))}
                              style={{ ...inp, padding: '3px 6px', fontSize: 11 }} />
                            <input type="number" value={u.quantity} onChange={e => setMatrixData(p => p.map((r,j) => j===i ? {...r, quantity: parseInt(e.target.value)||0} : r))}
                              style={{ ...inp, padding: '3px 6px', fontSize: 11, textAlign: 'center' }} />
                            <input value={u.sheet || ''} onChange={e => setMatrixData(p => p.map((r,j) => j===i ? {...r, sheet: e.target.value} : r))}
                              style={{ ...inp, padding: '3px 6px', fontSize: 11, textAlign: 'center' }} placeholder="A410" />
                            <button onClick={() => setMatrixData(p => p.filter((_,j) => j!==i))}
                              style={{ background: '#fee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, color: '#c00', padding: '2px 4px' }}>✕</button>
                          </div>
                        ))}
                      </div>
                      <div style={{ padding: '6px 10px', borderTop: '0.5px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <button onClick={() => setMatrixData(p => [...p, {name:'New Unit', quantity:1, sheet:''}])}
                          style={{ fontSize: 11, padding: '3px 10px', background: '#f0f4ff', border: '0.5px solid #3C3489', borderRadius: 6, cursor: 'pointer', color: '#3C3489' }}>+ Add Row</button>
                        <span style={{ fontSize: 11, color: '#555', fontWeight: 600 }}>
                          Total: {matrixData.reduce((s,u)=>s+(u.quantity||0),0)} units
                        </span>
                      </div>
                    </div>
                    <button onClick={() => setMatrixConfirmed(true)}
                      style={{ width: '100%', padding: 10, background: '#2D7A3A', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      ✓ Confirm Unit Matrix — Proceed to Step 3
                    </button>
                  </div>
                )}

                <div style={{ fontSize: 10, color: '#aaa', textAlign: 'center' }}>
                  Skip this step and the AI will guess unit counts from the plan set (less accurate)
                  {!matrixData && <> · <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setMatrixConfirmed(true)}>Skip →</span></>}
                </div>
              </>
            )}

            {matrixConfirmed && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(matrixData || []).slice(0, 8).map((u, i) => (
                    <span key={i} style={{ fontSize: 10, background: '#e8f5e9', color: '#2D7A3A', padding: '2px 8px', borderRadius: 10, fontWeight: 500 }}>
                      {u.name}: {u.quantity}
                    </span>
                  ))}
                  {(matrixData || []).length > 8 && <span style={{ fontSize: 10, color: '#888' }}>+{(matrixData||[]).length - 8} more</span>}
                  {!(matrixData || []).length && <span style={{ fontSize: 11, color: '#888' }}>Skipped</span>}
                </div>
                <button onClick={() => setMatrixConfirmed(false)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Edit</button>
              </div>
            )}
          </div>

          {/* ── STEP 2.5: CABINET SUMMARY / ORDER DOC ── */}
          <div style={{ ...card, border: summaryConfirmed ? '1.5px solid #2D7A3A' : '0.5px solid #e5e5e0', opacity: !shopConfirmed ? 0.55 : 1, pointerEvents: !shopConfirmed ? 'none' : 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                <span style={{ background: summaryConfirmed ? '#2D7A3A' : '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>2.5</span>
                Cabinet Summary <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>— Optional: upload Leedo printable summary or order doc</span>
              </div>
              {summaryConfirmed && (
                <span style={{ fontSize: 11, color: '#2D7A3A', fontWeight: 600 }}>
                  ✓ {summaryData?.length} SKUs · {summaryData?.reduce((s, r) => s + (r.qty || 0), 0).toLocaleString()} total cabinets confirmed
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              Upload the Leedo PrintableSummary, order confirmation, or any manufacturer cabinet list PDF. Claude extracts every SKU and quantity — this becomes the authoritative count that locks in your totals before the AI reads the plans.
            </div>

            {!summaryConfirmed ? (
              <>
                <label style={{ display: 'block', border: `1.5px dashed ${summaryFiles.length > 0 ? '#3C3489' : '#ccc'}`, borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer', background: '#fafaf8', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>
                    {summaryFiles.length === 0 ? '📋 Click to upload cabinet summary PDF' : `${summaryFiles.length} file${summaryFiles.length > 1 ? 's' : ''} selected`}
                  </div>
                  {summaryFiles.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {summaryFiles.map((f, i) => <div key={i} style={{ fontSize: 10, color: '#555' }}>📄 {f.name} ({(f.size/1024/1024).toFixed(1)} MB)</div>)}
                    </div>
                  )}
                  <input type="file" accept=".pdf" multiple onChange={e => { setSummaryFiles(Array.from(e.target.files)); setSummaryData(null) }} style={{ display: 'none' }} />
                </label>

                {summaryFiles.length > 0 && !summaryData && (
                  <button onClick={runSummaryExtraction} disabled={summaryLoading}
                    style={{ width: '100%', padding: 10, background: summaryLoading ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: summaryLoading ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
                    {summaryLoading ? '⏳ Reading Cabinet Summary...' : '🔍 Extract Cabinet List'}
                  </button>
                )}

                {summaryData && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#333', marginBottom: 6 }}>
                      Extracted {summaryData.length} SKUs · {summaryData.reduce((s, r) => s + (r.qty || 0), 0).toLocaleString()} total pieces — verify before confirming:
                    </div>
                    {/* Type summary badges */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                      {[['cabinet','Cabinet Boxes','#e8f5e9','#2D7A3A'],['filler','Fillers','#fff8e1','#7a5800'],['toe_kick','Toe Kick','#e8f5ff','#3C3489'],['end_panel','End Panels','#f0f0f0','#555']].map(([type,label,bg,color]) => {
                        const count = summaryData.filter(r=>r.type===type).reduce((s,r)=>s+(r.qty||0),0)
                        return count > 0 ? <span key={type} style={{ fontSize: 10, background: bg, color, padding: '2px 8px', borderRadius: 10, fontWeight: type==='cabinet'?700:500 }}>{count.toLocaleString()} {label}</span> : null
                      })}
                    </div>
                    <div style={{ background: '#f9f9f9', border: '0.5px solid #ddd', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 72px 56px 28px', padding: '5px 10px', background: '#eee', fontSize: 10, fontWeight: 600, color: '#555', gap: 6 }}>
                        <span>SKU</span><span>DESCRIPTION</span><span style={{textAlign:'center'}}>TYPE</span><span style={{textAlign:'center'}}>QTY</span><span/>
                      </div>
                      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                        {summaryData.map((row, i) => {
                          const typeColors = {cabinet:'#2D7A3A',filler:'#7a5800',toe_kick:'#3C3489',end_panel:'#666',hardware:'#444'}
                          const typeBg    = {cabinet:'#e8f5e9',filler:'#fff8e1',toe_kick:'#e8f5ff',end_panel:'#f0f0f0',hardware:'#f5f5f5'}
                          return (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 72px 56px 28px', padding: '3px 10px', borderBottom: '0.5px solid #eee', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 600, color: '#3C3489' }}>{row.sku}</span>
                              <input value={row.description || ''} onChange={e => setSummaryData(p => p.map((r, j) => j === i ? { ...r, description: e.target.value } : r))}
                                style={{ ...inp, padding: '2px 5px', fontSize: 10 }} />
                              <select value={row.type || 'cabinet'} onChange={e => setSummaryData(p => p.map((r, j) => j === i ? { ...r, type: e.target.value } : r))}
                                style={{ fontSize: 9, padding: '2px 3px', border: '0.5px solid #ccc', borderRadius: 4, background: typeBg[row.type]||'#fff', color: typeColors[row.type]||'#333', fontWeight: 600 }}>
                                <option value="cabinet">Cabinet</option>
                                <option value="filler">Filler</option>
                                <option value="toe_kick">Toe Kick</option>
                                <option value="end_panel">End Panel</option>
                                <option value="hardware">Hardware</option>
                              </select>
                              <input type="number" value={row.qty} onChange={e => setSummaryData(p => p.map((r, j) => j === i ? { ...r, qty: parseInt(e.target.value) || 0 } : r))}
                                style={{ ...inp, padding: '2px 5px', fontSize: 11, textAlign: 'center' }} />
                              <button onClick={() => setSummaryData(p => p.filter((_, j) => j !== i))}
                                style={{ background: '#fee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, color: '#c00', padding: '2px 4px' }}>✕</button>
                            </div>
                          )
                        })}
                      </div>
                      <div style={{ padding: '6px 10px', borderTop: '0.5px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <button onClick={() => setSummaryData(p => [...p, { sku: '', description: '', qty: 1, type: 'cabinet' }])}
                          style={{ fontSize: 11, padding: '3px 10px', background: '#f0f4ff', border: '0.5px solid #3C3489', borderRadius: 6, cursor: 'pointer', color: '#3C3489' }}>+ Add Row</button>
                        <div style={{ fontSize: 11, color: '#555', fontWeight: 600 }}>
                          <span style={{ color: '#2D7A3A' }}>{summaryData.filter(r=>r.type==='cabinet').reduce((s,r)=>s+(r.qty||0),0).toLocaleString()}</span> cabinets &nbsp;·&nbsp;
                          <span style={{ color: '#888' }}>{summaryData.filter(r=>r.type!=='cabinet').reduce((s,r)=>s+(r.qty||0),0).toLocaleString()} fillers/misc</span>
                        </div>
                      </div>
                    </div>
                    <button onClick={() => setSummaryConfirmed(true)}
                      style={{ width: '100%', padding: 10, background: '#2D7A3A', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      ✓ Confirm Cabinet Summary — Use as Ground Truth
                    </button>
                  </div>
                )}

                <div style={{ fontSize: 10, color: '#aaa', textAlign: 'center' }}>
                  Skip if you don't have an order doc · <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setSummaryConfirmed(true)}>Skip →</span>
                </div>
              </>
            ) : (
              <div>
                {summaryData ? (() => {
                  // qty × unit_qty when per-unit data exists; qty alone when it's already a total
                  const sumType = (type) => summaryData.filter(r => r.type === type).reduce((s, r) => {
                    return s + ((r.unit_qty && r.unit_qty > 0) ? (r.qty || 0) * r.unit_qty : (r.qty || 0))
                  }, 0)
                  const hasPerUnit = summaryData.some(r => r.unit_qty && r.unit_qty > 0)
                  return (
                  <>
                    {hasPerUnit && summaryUnitTypes.length > 0 && (
                      <div style={{ fontSize: 10, color: '#2D7A3A', background: '#e8f5e9', borderRadius: 6, padding: '4px 10px', marginBottom: 8 }}>
                        ✓ {summaryUnitTypes.length} unit types detected — will generate per-unit tabs in Excel
                      </div>
                    )}
                    {/* Totals by type */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                      {[
                        ['Cabinet Boxes', sumType('cabinet'),   '#e8f5e9', '#2D7A3A'],
                        ['Fillers',       sumType('filler'),    '#fff8e1', '#7a5800'],
                        ['Toe Kick',      sumType('toe_kick'),  '#e8f5ff', '#3C3489'],
                        ['End Panels',    sumType('end_panel'), '#f5f5f3', '#555'],
                      ].map(([label, count, bg, color]) => count > 0 && (
                        <span key={label} style={{ fontSize: 11, background: bg, color, padding: '2px 10px', borderRadius: 10, fontWeight: label === 'Cabinet Boxes' ? 700 : 500 }}>
                          {count.toLocaleString()} {label}
                        </span>
                      ))}
                    </div>
                    {/* Export button */}
                    <button onClick={exportSummaryToExcel} disabled={exporting}
                      style={{ width: '100%', padding: '8px 12px', fontSize: 12, background: exporting ? '#888' : '#2D7A3A', color: '#fff', border: 'none', borderRadius: 8, cursor: exporting ? 'default' : 'pointer', fontWeight: 600, marginBottom: 8 }}>
                      {exporting ? '⏳ Generating...' : '⬇ Export Cabinet Schedule (Excel) — No Plan Upload Needed'}
                    </button>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={() => setSummaryConfirmed(false)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Edit summary</button>
                    </div>
                  </>
                  )
                })() : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#888' }}>Skipped</span>
                    <button onClick={() => setSummaryConfirmed(false)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Edit</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── STEP 3: FULL PLAN SET ── */}
          <div style={{ ...card, opacity: (!shopConfirmed || (!matrixConfirmed && matrixData)) ? 0.55 : 1, pointerEvents: !shopConfirmed ? 'none' : 'auto' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
              <span style={{ background: '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>3</span>
              Full Plan Set <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>— Upload complete plan set PDF</span>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Upload Full Plan Set PDF</label>
              <label style={{ display: 'block', border: '1.5px dashed #ccc', borderRadius: 8, padding: 24, textAlign: 'center', cursor: 'pointer', background: '#fafaf8' }}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 4 }}>
                  {files.length === 0 ? 'Click to select PDF — full plan set OK' : `${files.length} file${files.length > 1 ? 's' : ''} selected`}
                </div>
                <div style={{ fontSize: 11, color: '#999' }}>Smart pre-processor finds relevant pages automatically — no manual page selection needed</div>
                {files.length > 0 && (
                  <div style={{ marginTop: 8, textAlign: 'left' }}>
                    {files.map((f, i) => <div key={i} style={{ fontSize: 11, color: '#555', padding: '2px 0' }}>📄 {f.name} ({(f.size / 1024 / 1024).toFixed(1)} MB)</div>)}
                  </div>
                )}
                <input type="file" accept=".pdf" multiple onChange={e => setFiles(Array.from(e.target.files))} style={{ display: 'none' }} />
              </label>
            </div>
            {/* ── PAGE CLASSIFICATION PANEL ── */}
            {files.length > 0 && (
              <div style={{ background: classificationData ? '#f0fdf4' : '#faf5ff', border: `0.5px solid ${classificationData ? '#2D7A3A' : '#c4b5fd'}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: classificationData ? 8 : 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: classificationData ? '#2D7A3A' : '#5b21b6' }}>
                    {classificationData ? '✓ Pages Classified' : '🔍 Classify Pages First (Recommended)'}
                  </div>
                  {!classificationData && (
                    <button onClick={runClassification} disabled={classifying}
                      style={{ padding: '5px 14px', fontSize: 11, background: classifying ? '#888' : '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: classifying ? 'default' : 'pointer', fontWeight: 600 }}>
                      {classifying ? '⏳ Classifying...' : 'Classify Pages'}
                    </button>
                  )}
                  {classificationData && (
                    <button onClick={() => setClassificationData(null)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Re-classify</button>
                  )}
                </div>
                {!classificationData && !classifying && (
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                    Identifies elevation, floor plan, and schedule pages so the AI only reads what matters — faster and more accurate.
                  </div>
                )}
                {classifying && (
                  <div style={{ fontSize: 11, color: '#5b21b6', marginTop: 6 }}>
                    Reading all pages — this takes about 30 seconds...
                  </div>
                )}
                {classificationData && (
                  <div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {Object.entries(classificationData.summary).map(([type, count]) => {
                        const colorMap = { elevation: ['#f5f3ff','#5b21b6'], floor_plan: ['#e0f2fe','#0369a1'], unit_schedule: ['#d1fae5','#065f46'], amenity: ['#ffedd5','#9a3412'] }
                        const [bg, color] = colorMap[type] || ['#f3f4f6','#374151']
                        return (
                          <span key={type} style={{ fontSize: 10, background: bg, color, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>
                            {count} {type.replace(/_/g,' ')}
                          </span>
                        )
                      })}
                    </div>
                    <div style={{ fontSize: 10, color: '#2D7A3A' }}>
                      ✓ AI will focus on {classificationData.pagesByType?.elevation?.length || 0} elevation + {classificationData.pagesByType?.unit_schedule?.length || 0} schedule pages
                      {classificationData.unitTypesFound?.length > 0 && ` · Unit types found: ${classificationData.unitTypesFound.join(', ')}`}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={{ marginBottom: 20 }}>
              <label style={lbl}>Cabinet Specs (optional — AI will find in plans or mark TBD)</label>
              <textarea value={specs} onChange={e => setSpecs(e.target.value)}
                placeholder="e.g. Northern Contours — Flat Panel — 2212 Braelyn laminate"
                style={{ width: '100%', ...inp, height: 60, resize: 'vertical' }} />
            </div>
            {(shopConfirmed && shopFiles.length > 0) && (
              <div style={{ background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 11, color: '#2D7A3A' }}>
                ✓ Shop drawings included — AI will prioritize SKUs and elevations from shop drawing pages
              </div>
            )}
            {summaryConfirmed && summaryData && (
              <div style={{ background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 11, color: '#2D7A3A' }}>
                ✓ Cabinet summary locked — {summaryData.reduce((s, r) => s + (r.qty || 0), 0).toLocaleString()} pieces across {summaryData.length} SKUs (authoritative count)
              </div>
            )}
            {matrixConfirmed && matrixData?.length > 0 && (
              <div style={{ background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 11, color: '#2D7A3A' }}>
                ✓ Unit matrix confirmed — AI will use exact quantities and sheet references from your unit schedule
              </div>
            )}
            <div style={{ background: '#f0f4ff', border: '0.5px solid #c5d0f0', borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 11, color: '#444', lineHeight: 1.8 }}>
              <strong>How it works:</strong> Scans all uploaded PDFs in 5-page chunks (Haiku, fast). Extracts only relevant pages. Runs full Opus cabinet extraction. You then review, add elevation pages if needed, and finalize.
            </div>
            {!uploading ? (
              <button onClick={runExtraction} disabled={files.length === 0}
                style={{ width: '100%', padding: 12, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                🔍 Extract Cabinet List from Plans
              </button>
            ) : (
              <div>
                <div style={{ background: '#f5f5ff', borderRadius: 8, padding: 14, fontSize: 11, color: '#555' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 600, color: '#3C3489' }}>⏳ Smart Processing in Progress</span>
                    <button onClick={() => { abortRef.current?.abort() }}
                      style={{ padding: '4px 14px', fontSize: 11, background: '#FCEBEB', color: '#A32D2D', border: '0.5px solid #E8BABA', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                      ✕ Cancel
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {['Splitting PDFs into 5-page chunks', 'Haiku scanning chunks in parallel', 'Extracting relevant pages only', 'Opus full cabinet extraction'].map((s, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ background: '#3C3489', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                        {s}
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 10, color: '#888' }}>Full plan sets: 5–10 min · Small sets: 1–3 min</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STAGE 2: REVIEW ── */}
      {stage === 2 && editData && (() => {
        const pages = getPagesNeeded()
        const unitsWithSkus = editData.unit_types?.filter(u => u.skus?.length > 0).length || 0
        const unitsWithout = editData.unit_types?.filter(u => !u.skus || u.skus.length === 0).length || 0

        return (
          <div>
            {/* Header */}
            <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Review & Edit Takeoff</div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {summary?.unit_type_count} unit types · {summary?.total_units} total units · {grandTotal.toLocaleString()} cabinets · {(grandTotalFillers + grandTotalNonCabinets).toLocaleString()} fillers & misc
                  {summary?.amenity_count > 0 && ` · ${summary.amenity_count} amenity spaces`}
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: summary?.confidence === 'high' ? '#EAF3DE' : summary?.confidence === 'medium' ? '#FAEEDA' : '#FCEBEB', color: summary?.confidence === 'high' ? '#3B6D11' : summary?.confidence === 'medium' ? '#633806' : '#A32D2D', fontWeight: 500 }}>
                    {(summary?.confidence || 'unknown').toUpperCase()} CONFIDENCE
                  </span>
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11', fontWeight: 500 }}>{unitsWithSkus} units have SKUs</span>
                  {unitsWithout > 0 && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#FAEEDA', color: '#633806', fontWeight: 500 }}>{unitsWithout} units need elevations</span>}
                  {mergeStats && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#E6F1FB', color: '#0C447C', fontWeight: 500 }}>+{mergeStats.unit_types_updated} updated from supplement</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button onClick={() => setStage(1)} style={{ padding: '6px 12px', fontSize: 11, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>← Re-upload</button>
                <button onClick={addUnitType} style={{ padding: '6px 12px', fontSize: 11, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Unit Type</button>
                <button onClick={() => setShowUnitMix(p => !p)}
                  style={{ padding: '6px 12px', fontSize: 11, background: showUnitMix ? '#3C3489' : '#f5f5f3', color: showUnitMix ? '#fff' : '#333', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>
                  {showUnitMix ? '✕ Close Mix' : '# Unit Mix'}
                </button>
                <button onClick={() => setShowAddPages(!showAddPages)} style={{ padding: '6px 12px', fontSize: 11, background: showAddPages ? '#3C3489' : '#f5f5f3', color: showAddPages ? '#fff' : '#333', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>
                  {showAddPages ? '✕ Cancel' : '+ Add Elevation Pages'}
                </button>
                <button onClick={exportToExcel} disabled={exporting || !editData}
                  style={{ padding: '6px 16px', fontSize: 12, background: exporting ? '#888' : '#2D7A3A', color: '#fff', border: 'none', borderRadius: 6, cursor: exporting ? 'default' : 'pointer', fontWeight: 500 }}>
                  {exporting ? '⏳ Exporting...' : '⬇ Export Excel'}
                </button>
                <button onClick={saveToJob} disabled={saving || !selectedJobId}
                  style={{ padding: '6px 16px', fontSize: 12, background: saving ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: saving ? 'default' : 'pointer', fontWeight: 500 }}>
                  {saving ? 'Saving...' : selectedJobId ? '✓ Finalize & Save' : 'Select job first'}
                </button>
              </div>
            </div>

            {/* ── PAGES NEEDED PANEL ── */}
            {unitsWithout > 0 && (
              <div style={{ background: '#FFF8F0', border: '0.5px solid #EF9F27', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ fontWeight: 500, fontSize: 13, color: '#633806', marginBottom: 10 }}>
                  📋 Elevation Pages Still Needed — {unitsWithout} unit type{unitsWithout > 1 ? 's' : ''} have no SKUs yet
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#633806', marginBottom: 6 }}>UNIT TYPES NEEDING ELEVATIONS:</div>
                    <div style={{ background: '#fff', borderRadius: 6, padding: 10, maxHeight: 160, overflowY: 'auto' }}>
                      {pages.withoutSkus.map((u, i) => (
                        <div key={i} style={{ fontSize: 11, padding: '3px 0', borderBottom: '0.5px solid #f5f0e8', display: 'flex', justifyContent: 'space-between' }}>
                          <span>{u.name}</span>
                          {u.sheet && <span style={{ color: '#3C3489', fontWeight: 500 }}>{u.sheet}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#633806', marginBottom: 6 }}>SHEETS TO FIND IN PLAN SET:</div>
                    <div style={{ background: '#fff', borderRadius: 6, padding: 10 }}>
                      {pages.sheetsNeeded.length > 0 ? (
                        <>
                          <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#3C3489', fontWeight: 500, lineHeight: 1.8 }}>
                            {pages.sheetsNeeded.join(', ')}
                          </div>
                          <button onClick={() => navigator.clipboard.writeText(pages.sheetsNeeded.join(', '))}
                            style={{ marginTop: 8, padding: '4px 10px', fontSize: 10, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>
                            Copy Sheet Numbers
                          </button>
                        </>
                      ) : (
                        <div style={{ fontSize: 11, color: '#888' }}>Sheet references not found — upload elevation PDFs to fill in SKUs</div>
                      )}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 10, color: '#888' }}>
                      Find these sheets in your plan set, export them as PDF, then click "+ Add Elevation Pages" above to merge them in.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── UNIT MIX EDITOR ── */}
            {showUnitMix && (
              <div style={{ background: '#F5F7FF', border: '0.5px solid #3C3489', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#3C3489' }}>Unit Mix — Set Quantities</div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
                      Override AI-guessed unit counts with actual quantities from the unit schedule. Updates export totals automatically.
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#3C3489', fontWeight: 500 }}>
                    Total: {editData.unit_types.reduce((s, u) => s + (Number(u.unit_quantity) || 0), 0)} units
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                  {editData.unit_types.map((ut, ui) => (
                    <div key={ui} style={{ background: '#fff', border: '0.5px solid #dde', borderRadius: 8, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 500, color: '#222' }}>{ut.unit_type_name}</div>
                        <div style={{ fontSize: 10, color: '#888' }}>{ut.skus?.length || 0} SKUs · {getCabsPerUnit(ut)} cabs/unit{getFillersPerUnit(ut) > 0 ? ` · ${getFillersPerUnit(ut)} fillers` : ''}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <input
                          type="number"
                          min="0"
                          value={ut.unit_quantity || ''}
                          onChange={e => {
                            const val = parseInt(e.target.value) || 0
                            setEditData(p => ({
                              ...p,
                              unit_types: p.unit_types.map((u, i) => i === ui ? { ...u, unit_quantity: val } : u)
                            }))
                          }}
                          style={{ width: 60, padding: '4px 8px', border: '1px solid #3C3489', borderRadius: 6, fontSize: 13, fontWeight: 600, textAlign: 'center', color: '#3C3489' }}
                          placeholder="0"
                        />
                        <div style={{ fontSize: 9, color: '#aaa' }}>units</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, padding: '8px 12px', background: '#EEF0FF', borderRadius: 8, fontSize: 11, color: '#3C3489' }}>
                  💡 Tip: Find unit counts in the Unit Schedule sheets of your plan set. For Hangar: Floor 1 = 54 units, Floor 2 = 66, Floor 3 = 70, Floor 4 = 69 = <strong>259 total</strong>
                </div>
              </div>
            )}

            {/* ── ADD MORE PAGES PANEL ── */}
            {showAddPages && (
              <div style={{ background: '#EEF2FF', border: '0.5px solid #3C3489', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ fontWeight: 500, fontSize: 13, color: '#3C3489', marginBottom: 8 }}>Add Elevation Pages</div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 12 }}>
                  Upload the kitchen and bathroom elevation sheets. The AI will match them to existing unit types and fill in the missing SKUs — existing data is preserved.
                </div>
                <label style={{ display: 'block', border: '1.5px dashed #3C3489', borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer', background: '#fff', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#3C3489' }}>
                    {supplementFiles.length === 0 ? 'Click to select elevation PDF pages' : `${supplementFiles.length} file${supplementFiles.length > 1 ? 's' : ''} selected`}
                  </div>
                  {supplementFiles.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {supplementFiles.map((f, i) => <div key={i} style={{ fontSize: 10, color: '#555' }}>📄 {f.name}</div>)}
                    </div>
                  )}
                  <input type="file" accept=".pdf" multiple onChange={e => setSupplementFiles(Array.from(e.target.files))} style={{ display: 'none' }} />
                </label>
                <button onClick={runSupplement} disabled={merging || supplementFiles.length === 0}
                  style={{ width: '100%', padding: 10, background: merging ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: merging ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                  {merging ? '⏳ Scanning & Merging — Do Not Close...' : '🔀 Merge Elevation Data into Takeoff'}
                </button>
              </div>
            )}

            {/* Flags */}
            {editData.flags?.length > 0 && (
              <div style={{ background: '#FAEEDA', border: '0.5px solid #EF9F27', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                <div style={{ fontWeight: 500, fontSize: 12, color: '#633806', marginBottom: 6 }}>⚑ Flags for Manual Review</div>
                {editData.flags.map((flag, i) => <div key={i} style={{ fontSize: 11, color: '#633806', padding: '2px 0' }}>• {flag}</div>)}
              </div>
            )}

            {/* AI notes */}
            {editData.extraction_notes && (
              <div style={{ background: '#E6F1FB', border: '0.5px solid #85B7EB', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 11, color: '#0C447C' }}>
                <strong>AI Notes:</strong> {editData.extraction_notes}
              </div>
            )}

            {/* Specs */}
            <div style={card}>
              <div style={{ fontWeight: 500, marginBottom: 12 }}>Project Specs</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                {[['Cabinet Line', 'cabinet_line'], ['Door Style', 'door_style'], ['Finish / Color', 'finish'], ['Box Construction', 'box_construction'], ['Hardware', 'hardware']].map(([label, key]) => (
                  <div key={key}>
                    <label style={lbl}>{label}</label>
                    <input value={editData.specs?.[key] || ''} onChange={e => setEditData(p => ({ ...p, specs: { ...p.specs, [key]: e.target.value } }))}
                      style={{ width: '100%', ...inp }} placeholder="TBD" />
                  </div>
                ))}
              </div>
            </div>

            {/* Unit types */}
            {editData.unit_types.map((ut, ui) => {
              const isExp = expandedUnit === ui
              const cabsPerUnit = getCabsPerUnit(ut)
              const hasSkus = ut.skus?.length > 0
              return (
                <div key={ui} style={{ background: '#fff', border: `0.5px solid ${ut.is_amenity ? '#85B7EB' : hasSkus ? '#e5e5e0' : '#EF9F27'}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
                  <div onClick={() => setExpandedUnit(isExp ? null : ui)}
                    style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: ut.is_amenity ? '#f0f5ff' : hasSkus ? '#fafafa' : '#FFFBF5' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12 }}>{isExp ? '▼' : '▶'}</span>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {ut.unit_type_name}
                          {!hasSkus && <span style={{ fontSize: 9, background: '#FAEEDA', color: '#633806', padding: '1px 6px', borderRadius: 10 }}>NEEDS ELEVATIONS</span>}
                          {hasSkus && <span style={{ fontSize: 9, background: '#EAF3DE', color: '#3B6D11', padding: '1px 6px', borderRadius: 10 }}>✓ {ut.skus.length} SKUs</span>}
                          {ut.is_amenity && <span style={{ fontSize: 9, background: '#E6F1FB', color: '#0C447C', padding: '1px 6px', borderRadius: 10 }}>AMENITY</span>}
                        </div>
                        <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
                          {ut.unit_quantity} unit{ut.unit_quantity !== 1 ? 's' : ''} · {cabsPerUnit} cabs/unit · {(cabsPerUnit * (ut.unit_quantity || 1)).toLocaleString()} total
                          {ut.toe_kick_lf > 0 && ` · ${ut.toe_kick_lf} LF toe kick`}
                          {ut.sheet_reference && ` · Sheet ${ut.sheet_reference}`}
                        </div>
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); removeUnitType(ui) }} style={{ fontSize: 10, padding: '2px 8px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Remove</button>
                  </div>

                  {isExp && (
                    <div style={{ padding: 16, borderTop: '0.5px solid #eee' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 14 }}>
                        <div><label style={lbl}>Unit Type Name</label><input value={ut.unit_type_name} onChange={e => updateUnitField(ui, 'unit_type_name', e.target.value)} style={{ width: '100%', ...inp }} /></div>
                        <div><label style={lbl}>Unit Count</label><input type="number" min="0" value={ut.unit_quantity} onChange={e => updateUnitField(ui, 'unit_quantity', Number(e.target.value))} style={{ width: '100%', ...inp }} /></div>
                        <div><label style={lbl}>Toe Kick (LF)</label><input type="number" step="0.5" min="0" value={ut.toe_kick_lf} onChange={e => updateUnitField(ui, 'toe_kick_lf', Number(e.target.value))} style={{ width: '100%', ...inp }} /></div>
                        <div><label style={lbl}>Sheet Ref</label><input value={ut.sheet_reference || ''} onChange={e => updateUnitField(ui, 'sheet_reference', e.target.value)} style={{ width: '100%', ...inp }} placeholder="e.g. A424" /></div>
                      </div>
                      {ut.toe_kick_notes && <div style={{ fontSize: 10, color: '#888', marginBottom: 10, fontStyle: 'italic' }}>{ut.toe_kick_notes}</div>}

                      {/* SKU table */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ fontWeight: 500, fontSize: 12 }}>Cabinet SKUs</div>
                          <button onClick={() => addSku(ui)} style={{ fontSize: 10, padding: '3px 10px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>+ Add SKU</button>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                          <thead><tr style={{ background: '#f5f5f3' }}>
                            {['SKU', 'Description', 'Qty/Unit', 'Hinge', 'Location', 'Hardware', ''].map(h => (
                              <th key={h} style={{ padding: '5px 7px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 10 }}>{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {(ut.skus || []).map((sk, si) => (
                              <tr key={si} style={{ borderBottom: '0.5px solid #f5f5f3' }}>
                                <td style={{ padding: '4px 5px' }}><input value={sk.sku} onChange={e => updateSku(ui, si, 'sku', e.target.value)} style={{ ...inp, width: 90, fontFamily: 'monospace', fontWeight: 500 }} /></td>
                                <td style={{ padding: '4px 5px' }}><input value={sk.description} onChange={e => updateSku(ui, si, 'description', e.target.value)} style={{ ...inp, width: '100%' }} /></td>
                                <td style={{ padding: '4px 5px' }}><input type="number" min="0" value={sk.quantity_per_unit} onChange={e => updateSku(ui, si, 'quantity_per_unit', Number(e.target.value))} style={{ ...inp, width: 52 }} /></td>
                                <td style={{ padding: '4px 5px' }}>
                                  <select value={sk.hinge_side || ''} onChange={e => updateSku(ui, si, 'hinge_side', e.target.value)} style={{ ...inp, width: 64 }}>
                                    <option value="">—</option><option>L</option><option>R</option><option>L/R</option><option>NA</option>
                                  </select>
                                </td>
                                <td style={{ padding: '4px 5px' }}>
                                  <select value={sk.location || 'kitchen'} onChange={e => updateSku(ui, si, 'location', e.target.value)} style={{ ...inp, width: 90 }}>
                                    <option>kitchen</option><option>bathroom</option><option>closet</option><option>pantry</option><option>amenity</option>
                                  </select>
                                </td>
                                <td style={{ padding: '4px 5px', textAlign: 'center' }}>
                                  {(() => {
                                    const hw = calcHardware(sk.sku)
                                    if (hw === null) return <span style={{ fontSize: 10, background: '#FCEBEB', color: '#A32D2D', padding: '2px 6px', borderRadius: 10 }}>?</span>
                                    if (hw === 0)    return <span style={{ fontSize: 10, color: '#aaa' }}>—</span>
                                    return <span style={{ fontSize: 11, fontWeight: 600, background: '#EAF3DE', color: '#3B6D11', padding: '2px 8px', borderRadius: 10 }}>{hw}</span>
                                  })()}
                                </td>
                                <td style={{ padding: '4px 5px' }}><button onClick={() => removeSku(ui, si)} style={{ padding: '3px 6px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>✕</button></td>
                              </tr>
                            ))}
                            {(ut.skus || []).length === 0 && <tr><td colSpan={6} style={{ padding: '8px 6px', color: '#aaa', fontSize: 11 }}>No SKUs yet — add manually or upload elevation pages</td></tr>}
                          </tbody>
                        </table>
                      </div>

                      {/* Fillers */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ fontWeight: 500, fontSize: 12 }}>Fillers</div>
                          <button onClick={() => addFiller(ui)} style={{ fontSize: 10, padding: '3px 10px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Add Filler</button>
                        </div>
                        {(ut.fillers || []).length === 0 && <div style={{ fontSize: 11, color: '#aaa' }}>No fillers</div>}
                        {(ut.fillers || []).map((f, fi) => (
                          <div key={fi} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                            <input value={f.sku} onChange={e => updateFiller(ui, fi, 'sku', e.target.value)} style={{ ...inp, width: 80, fontFamily: 'monospace' }} placeholder="F330" />
                            <input value={f.description} onChange={e => updateFiller(ui, fi, 'description', e.target.value)} style={{ ...inp, flex: 1 }} placeholder="Description" />
                            <input value={f.location} onChange={e => updateFiller(ui, fi, 'location', e.target.value)} style={{ ...inp, width: 120 }} placeholder="Location" />
                            <input type="number" min="0" value={f.quantity_per_unit} onChange={e => updateFiller(ui, fi, 'quantity_per_unit', Number(e.target.value))} style={{ ...inp, width: 52 }} />
                            <button onClick={() => removeFiller(ui, fi)} style={{ padding: '3px 8px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 10 }}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Grand total footer */}
            <div style={{ background: '#1a1a2e', borderRadius: 10, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <div style={{ color: '#aaa', fontSize: 12 }}>{editData.unit_types.length} unit types · {editData.unit_types.reduce((s, u) => s + (u.unit_quantity || 0), 0)} total units · {unitsWithSkus} with SKUs</div>
              <div>
                <div style={{ color: '#aaa', fontSize: 10, textAlign: 'right' }}>GRAND TOTAL CABINETS</div>
                <div style={{ color: '#fff', fontSize: 20, fontWeight: 600 }}>{grandTotal.toLocaleString()}</div>
                <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 }}>+ {(grandTotalFillers + grandTotalNonCabinets).toLocaleString()} fillers & misc</div>
              </div>
            </div>

            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setStage(1)} style={{ padding: '8px 16px', fontSize: 12, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>← Re-upload</button>
              <button onClick={saveToJob} disabled={saving || !selectedJobId}
                style={{ padding: '8px 20px', fontSize: 13, background: saving ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'default' : 'pointer', fontWeight: 600 }}>
                {saving ? 'Saving...' : selectedJobId ? '✓ Finalize & Save Cabinet List' : 'Select a job above first'}
              </button>
            </div>
          </div>
        )
      })()}

      {/* ── STAGE 3: COMPLETE ── */}
      {stage === 3 && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8, color: '#3B6D11' }}>Takeoff Complete</div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 32 }}>
            {grandTotal.toLocaleString()} cabinets · {(grandTotalFillers + grandTotalNonCabinets).toLocaleString()} fillers & misc saved across {editData?.unit_types?.length} unit types
          </div>
          <button onClick={() => { setStage(1); setFiles([]); setShopFiles([]); setShopConfirmed(false); setSummaryFiles([]); setSummaryData(null); setSummaryUnitTypes([]); setSummaryConfirmed(false); setShopCabinetData(null); setExtractedData(null); setEditData(null); setMergeStats(null); setMatrixData(null); setMatrixConfirmed(false); setMatrixFiles([]); setClassificationData(null); setClassifying(false) }}
            style={{ padding: '8px 20px', fontSize: 13, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 8, cursor: 'pointer' }}>
            Run Another Takeoff
          </button>
        </div>
      )}
    </div>
  )
}
