'use client'
import { useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { storageKey: 'mdsg-agent-pipeline', persistSession: false } }
)

// ── Light theme ──────────────────────────────────────────────────────────────
const BG     = '#f5f5f3'
const SIDE   = '#ffffff'
const CARD   = '#ffffff'
const BORDER = '#e5e5e0'
const TEXT   = '#1a1a1a'
const MUTED  = '#888888'
const dinp   = { background: '#fff', border: `0.5px solid #ccc`, color: TEXT, borderRadius: 6, padding: '7px 10px', fontSize: 12, boxSizing: 'border-box', outline: 'none', width: '100%' }
const dlbl   = { fontSize: 10, color: MUTED, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }
const dcard  = { background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 10, padding: 20, marginBottom: 16 }

const AGENTS = [
  { key: 'upload',     label: 'Upload',            desc: 'Plan set PDF',        color: '#6366f1', step: 1 },
  { key: 'classify',   label: 'Page Classifier',   desc: 'Sort page types',     color: '#7c3aed', step: 2 },
  { key: 'matrix',     label: 'Unit Matrix',       desc: 'Types + counts',      color: '#0d9488', step: 3 },
  { key: 'elevation',  label: 'Elevation Engine',  desc: 'SKU extraction',      color: '#8b5cf6', step: 4 },
  { key: 'countertop', label: 'Countertop Agent',  desc: 'LF → SF calc',        color: '#d97706', step: 5 },
  { key: 'export',     label: 'Export',            desc: 'Excel + PDF',         color: '#16a34a', step: 6 },
]

// ── Cabinet helpers (from TakeoffEngine) ─────────────────────────────────────
function isApplianceSku(sku) {
  const u = (sku || '').toUpperCase().trim()
  return /^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|WASH|DRYER|OVEN|HOOD|VENT)/.test(u)
}
function isTrueCabinet(sku) {
  const u = (sku || '').toUpperCase().trim()
  if (isApplianceSku(u)) return false
  if (/^(EPT|PLYS|AD21)/.test(u)) return false
  if (/^(WF|TF|BF|BEP|EPB|F\d|TK8|TSK|TKPW|TKC|TRP|BRP|OCM)/.test(u)) return false
  if (/^SCM/.test(u)) return false
  if (/SCRIBE|SCRI|SKIN|SHELF/.test(u)) return false
  if (/^CROWN|^MOLD|^VALANCE/.test(u)) return false
  return true
}
function hingeFromSku(sku) {
  const u = (sku || '').toUpperCase().trim()
  if (/^(EPT|PLYS|TKPW|TKC|TK8|F\d)/.test(u)) return ''
  if (/L$/.test(u) && !/^(BLS|BW|BRL|CTRL|SCRL)/.test(u)) return 'L'
  if (/R$/.test(u) && !/^(BSR|WOR|EPR)/.test(u)) return 'R'
  return 'L/R'
}
function calcHardware(sku) {
  const SPECIAL = { 'CVDB36BDHL':5,'BLS36R':1,'CW2436R':1,'B30FH':2,'CVSDB36HFHR':2,'EPT90':0,'CVSDB48-DB15L':6 }
  const u = (sku || '').toUpperCase().trim()
  if (!u) return null
  const ZERO_PRE = ['F3','F4','F5','F6','TRP','BRP','TKPW','TKC','TK8','TSK','OCM','WF','TF','BEP','EPB']
  const ZERO_EX  = ['PLYS','EPT','AD21']
  if (ZERO_EX.some(p => u === p || u.startsWith(p))) return 0
  if (ZERO_PRE.some(p => u.startsWith(p))) return 0
  const ub = u.replace(/-32\.5$/,'').replace(/-32\.5-/,'-')
  if (SPECIAL[ub] !== undefined) return SPECIAL[ub]
  const skylM = ub.match(/^(\d+)(DB|VDB|DWR)/)
  if (skylM) return parseInt(skylM[1])
  const dashM = ub.match(/-(\d+)[A-Z]?$/)
  if (dashM) { const n = parseInt(dashM[1]); if (n >= 1 && n <= 6) return n }
  if (/^BB/.test(ub)) return 1
  if (/^BW/.test(ub)) return 1
  if (/^BLS/.test(ub)) return 1
  if (/^CW/.test(ub)) return 1
  if (/^HC/.test(ub)) return 2
  if (/^EB/.test(ub)) return 2
  if (/^BMC/.test(ub)) return 2
  if (/^(LC|LT|PT)/.test(ub)) return 2
  if (/^(T\d|P\d)/.test(ub)) return 2
  const VALID_W = new Set([9,12,15,18,21,24,27,30,33,36,39,42,45,48])
  function getW(s) {
    const n = s.replace(/-32\.5/,'').replace(/^\d+/,'').replace(/^[A-Z]+/i,'')
    if (n.length >= 2) { const t = parseInt(n.substring(0,2)); if (VALID_W.has(t)) return t }
    if (n.length >= 3) return parseInt(n.substring(0,3))
    return null
  }
  const w = getW(ub)
  if (/^(WBC|WHL|WO)/.test(ub)) return (w||99) <= 21 ? 1 : 2
  if (/^DB/.test(ub))  return (w||99) <= 21 ? 2 : 3
  if (/^(B|SB)/.test(ub)) return (w||99) <= 21 ? 2 : 3
  if (/^W/.test(ub))   return (w||99) <= 21 ? 1 : 2
  if (/^(VSB|VDB|CVDB|CVSDB|VSD|VB|VS)/.test(ub)) return (w||99) <= 21 ? 1 : 2
  return null
}

export default function AgentPipeline({ jobs = [], onComplete }) {
  // ── Agent state ──────────────────────────────────────────────────────────
  const initStatus   = () => Object.fromEntries(AGENTS.map(a => [a.key, 'pending']))
  const initProgress = () => Object.fromEntries(AGENTS.map(a => [a.key, 0]))
  const [activeAgent,  setActiveAgent]  = useState('upload')
  const [agentStatus,  setAgentStatus]  = useState(initStatus)
  const [agentProg,    setAgentProg]    = useState(initProgress)
  const [savedAt,      setSavedAt]      = useState({})  // {agentKey: timestamp}

  // ── Job ──────────────────────────────────────────────────────────────────
  const [selectedJobId, setSelectedJobId] = useState('')

  // ── Upload ──────────────────────────────────────────────────────────────
  const [files,     setFiles]     = useState([])
  const [shopFiles, setShopFiles] = useState([])
  const [specs,     setSpecs]     = useState('')

  // ── Classify ────────────────────────────────────────────────────────────
  const [classifyData, setClassifyData] = useState(null)

  // ── Matrix ──────────────────────────────────────────────────────────────
  const [matrixData,      setMatrixData]      = useState([])
  const [matrixFiles,     setMatrixFiles]     = useState([])
  const [matrixLoading,   setMatrixLoading]   = useState(false)

  // ── Elevation ───────────────────────────────────────────────────────────
  const [editData,      setEditData]      = useState(null)
  const [elevSummary,   setElevSummary]   = useState(null)
  const [expandedUnit,  setExpandedUnit]  = useState(null)
  const [saving,        setSaving]        = useState(false)
  const abortRef = useRef(null)
  const [unitFiles,      setUnitFiles]      = useState({})
  const [unitExtracting, setUnitExtracting] = useState({})
  const [excelImporting, setExcelImporting] = useState(false)

  const isExcelFile = (f) => /\.(xlsx|xlsm)$/i.test(f?.name || '')
  const hasExcel    = () => files.some(isExcelFile)

  // ── Countertop ──────────────────────────────────────────────────────────
  const [ctUnits,   setCtUnits]   = useState([])  // [{name, qty, kitchenLF, vanityLF, sinks}]
  const [wastePct,  setWastePct]  = useState(10)
  const [ctSaving,  setCtSaving]  = useState(false)

  // ── Export ──────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false)

  // ── Progress helpers ─────────────────────────────────────────────────────
  function startProgress(key) {
    const timer = setInterval(() => {
      setAgentProg(p => {
        const cur = p[key] || 0
        if (cur >= 92) { clearInterval(timer); return p }
        return { ...p, [key]: cur + (92 - cur) * 0.04 + 0.5 }
      })
    }, 350)
    return () => clearInterval(timer)
  }
  function setRunning(key) {
    setAgentStatus(p => ({ ...p, [key]: 'running' }))
    setAgentProg(p => ({ ...p, [key]: 2 }))
  }
  function setComplete(key) {
    setAgentProg(p => ({ ...p, [key]: 100 }))
    setAgentStatus(p => ({ ...p, [key]: 'complete' }))
  }
  function setAgentError(key) {
    setAgentStatus(p => ({ ...p, [key]: 'error' }))
    setAgentProg(p => ({ ...p, [key]: 0 }))
  }

  // ── Upload confirm ───────────────────────────────────────────────────────
  function confirmUpload() {
    if (!files.length) return alert('Select at least one file')
    setComplete('upload')
    setAgentStatus(p => ({ ...p, upload: 'complete' }))
    if (hasExcel()) {
      setAgentStatus(p => ({ ...p, classify: 'complete', matrix: 'complete' }))
      setAgentProg(p => ({ ...p, classify: 100, matrix: 100 }))
      setActiveAgent('elevation')
    } else if (files.some(f => f.type.startsWith('image/'))) {
      setAgentStatus(p => ({ ...p, classify: 'complete' }))
      setAgentProg(p => ({ ...p, classify: 100 }))
      setActiveAgent('matrix')
    } else {
      setActiveAgent('classify')
    }
  }

  // ── Page Classifier ──────────────────────────────────────────────────────
  async function runExcelImport() {
    const xlFile = files.find(isExcelFile)
    if (!xlFile) return alert('No Excel file found')
    setExcelImporting(true)
    setRunning('elevation')
    const stop = startProgress('elevation')
    try {
      const fd = new FormData()
      fd.append('files', xlFile)
      const res  = await fetch('/api/takeoff/excel', { method: 'POST', body: fd })
      stop()
      const result = await res.json()
      if (result.success) {
        const uts = result.data.unit_types || []
        if (matrixData?.length) {
          matrixData.forEach(mu => {
            const found = uts.find(ut => ut.unit_type_name?.toLowerCase().replace(/\s+/g,'') === mu.name?.toLowerCase().replace(/\s+/g,''))
            if (found && mu.quantity) found.unit_quantity = mu.quantity
          })
        }
        setEditData(JSON.parse(JSON.stringify(result.data)))
        setElevSummary(result.summary)
        setComplete('elevation')
        // Use Excel SF directly — back-calculate LF so display matches Excel totals
        setCtUnits(uts.map(ut => ({
          name:      ut.unit_type_name,
          qty:       ut.unit_quantity || 1,
          kitchenLF: ut.kitchenSF ? Math.round((ut.kitchenSF / 2.125) * 100) / 100 : (ut.kitchenLF || 0),
          vanityLF:  ut.vanitySF  ? Math.round((ut.vanitySF  / 1.875) * 100) / 100 : (ut.vanityLF  || 0),
          sinks:     ut.sinks     || 0,
        })))
        setWastePct(5)  // 5% for side splash per Excel standard
        setActiveAgent('countertop')
        alert('\u2713 Excel imported \u2014 ' + uts.length + ' unit types \u00b7 ' + (result.summary?.total_cabinets?.toLocaleString() || 0) + ' cabinets')
      } else {
        setAgentError('elevation')
        alert('Excel import failed: ' + (result.error || 'Unknown'))
      }
    } catch (err) {
      stop()
      setAgentError('elevation')
      alert('Error: ' + err.message)
    }
    setExcelImporting(false)
  }

  async function runClassify() {
    if (!files.length) return alert('Upload a plan set PDF first')
    setRunning('classify')
    const stop = startProgress('classify')
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result.split(',')[1])
        r.onerror = rej
        r.readAsDataURL(files[0])
      })
      const response = await fetch('/api/takeoff/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: base64 }),
      })
      stop()
      const data = await response.json()
      if (data.success) {
        setClassifyData(data)
        setComplete('classify')
        if (data.unitTypesFound?.length) {
          setMatrixData(data.unitTypesFound.map(n => ({ name: n, quantity: 0, sheet: '' })))
        }
        setActiveAgent('matrix')
      } else {
        setAgentError('classify')
        alert('Classification failed: ' + data.error)
      }
    } catch (err) {
      stop()
      setAgentError('classify')
      alert('Error: ' + err.message)
    }
  }

  // ── Unit Matrix ──────────────────────────────────────────────────────────
  async function runMatrixExtract() {
    if (!matrixFiles.length) return alert('Upload unit schedule pages first')
    setMatrixLoading(true)
    try {
      const fd = new FormData()
      matrixFiles.forEach(f => fd.append('files', f))
      const res = await fetch('/api/takeoff/matrix', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) })
      const result = await res.json()
      if (result.success) setMatrixData(result.units)
      else alert('Matrix extraction failed: ' + (result.error || 'Unknown'))
    } catch (err) { alert('Error: ' + err.message) }
    setMatrixLoading(false)
  }

  function confirmMatrix() {
    setComplete('matrix')
    setSavedAt(p => ({ ...p, matrix: new Date().toLocaleTimeString() }))
    setActiveAgent('elevation')
  }

  // ── Elevation Engine ─────────────────────────────────────────────────────
  async function runExtraction() {
    if (!files.length) return alert('No plan files uploaded')
    setRunning('elevation')
    const stop = startProgress('elevation')
    abortRef.current = new AbortController()
    const fd = new FormData()
    if (selectedJobId) fd.append('jobId', selectedJobId)
    fd.append('specs', specs)
    if (matrixData?.length) fd.append('unitMatrix', JSON.stringify(matrixData))
    if (classifyData)       fd.append('classificationData', JSON.stringify(classifyData))
    shopFiles.forEach(f => fd.append('files', f))
    files.forEach(f => fd.append('files', f))
    const timeout = setTimeout(() => abortRef.current?.abort(), 600000)
    try {
      const res = await fetch('/api/takeoff', { method: 'POST', body: fd, signal: abortRef.current.signal })
      clearTimeout(timeout)
      stop()
      const result = await res.json()
      if (result.success) {
        // Merge matrix unit types into result — ensures all units appear even if AI missed some
        const extractedUts = result.data.unit_types || []
        if (matrixData?.length) {
          matrixData.forEach(mu => {
            const found = extractedUts.find(ut =>
              ut.unit_type_name?.toLowerCase().replace(/\s+/g,'') === mu.name?.toLowerCase().replace(/\s+/g,'')
            )
            if (!found) {
              extractedUts.push({
                unit_type_name: mu.name,
                unit_quantity: mu.quantity || 1,
                skus: [], fillers: [],
                total_cabinets_per_unit: 0,
                is_amenity: false, sheet_reference: mu.sheet || '',
              })
            } else {
              // Always use confirmed matrix quantity
              if (mu.quantity) found.unit_quantity = mu.quantity
            }
          })
          result.data.unit_types = extractedUts
        }
        setEditData(JSON.parse(JSON.stringify(result.data)))
        setElevSummary(result.summary)
        setComplete('elevation')
        const uts = result.data.unit_types || []
        setCtUnits(uts.map(ut => ({ name: ut.unit_type_name, qty: ut.unit_quantity || 1, kitchenLF: 0, vanityLF: 0, sinks: 0 })))
        setActiveAgent('countertop')
      } else {
        setAgentError('elevation')
        alert('Extraction failed: ' + (result.error || 'Unknown error'))
      }
    } catch (err) {
      clearTimeout(timeout)
      stop()
      if (err.name !== 'AbortError') { setAgentError('elevation'); alert('Error: ' + err.message) }
    }
    abortRef.current = null
  }

  async function saveElevationToJob() {
    if (!selectedJobId) return alert('Select a job first')
    if (!editData?.unit_types) return alert('No elevation data to save')
    setSaving(true)
    await supabase.from('cabinet_line_items').delete().eq('job_id', selectedJobId)
    await supabase.from('unit_types').delete().eq('job_id', selectedJobId)
    let grandTotal = 0
    for (let i = 0; i < editData.unit_types.length; i++) {
      const ut = editData.unit_types[i]
      const cabs = (ut.skus||[]).reduce((s,sk)=>s+(isTrueCabinet(sk.sku)?Number(sk.quantity_per_unit)||0:0),0)
      grandTotal += cabs * (ut.unit_quantity||1)
      const { data: utData } = await supabase.from('unit_types').insert({
        job_id: selectedJobId, unit_type_name: ut.unit_type_name,
        unit_quantity: ut.unit_quantity||1, cabinet_count: cabs,
        total_cubes: 0, manufacturer_price: 0, sort_order: i,
      }).select().single()
      if (utData) {
        const lines = [
          ...(ut.skus||[]).map((sk,j)=>({ unit_type_id:utData.id, job_id:selectedJobId, sku:sk.sku, description:sk.description||'', door_style:'', finish:'', hinge_side:sk.hinge_side||'', quantity:Number(sk.quantity_per_unit)||1, extended_price:0, sort_order:j })),
          ...(ut.fillers||[]).map((f,j)=>({ unit_type_id:utData.id, job_id:selectedJobId, sku:f.sku, description:f.description||'', door_style:'', finish:'', hinge_side:'', quantity:Number(f.quantity_per_unit)||1, extended_price:0, sort_order:1000+j })),
        ]
        if (lines.length) await supabase.from('cabinet_line_items').insert(lines)
      }
    }
    await supabase.from('jobs').update({ total_cabinet_count: grandTotal, unit_type_count: editData.unit_types.length }).eq('id', selectedJobId)
    await supabase.from('activity_log').insert({ job_id:selectedJobId, user_name:'Cole', action:`Elevation saved — ${editData.unit_types.length} unit types · ${grandTotal.toLocaleString()} cabinets` })
    setSaving(false)
    setSavedAt(p => ({ ...p, elevation: new Date().toLocaleTimeString() }))
    alert(`✓ Saved — ${grandTotal.toLocaleString()} cabinets`)
  }

  // ── Countertop ───────────────────────────────────────────────────────────
  const ctTotals = ctUnits.reduce((acc, ut) => {
    const qty = ut.qty || 1
    acc.kitchenLF += (ut.kitchenLF||0) * qty
    acc.vanityLF  += (ut.vanityLF||0)  * qty
    acc.kitchenSF += (ut.kitchenLF||0) * 2.125 * qty
    acc.vanitySF  += (ut.vanityLF||0)  * 1.875 * qty
    acc.sinks     += (ut.sinks||0)     * qty
    return acc
  }, { kitchenLF:0, vanityLF:0, kitchenSF:0, vanitySF:0, sinks:0 })
  const ctMaterialSF  = ctTotals.kitchenSF + ctTotals.vanitySF
  const ctOrderSF     = ctMaterialSF * (1 + wastePct / 100)

  async function saveCountertopToJob() {
    if (!selectedJobId) return alert('Select a job first')
    setCtSaving(true)
    const payload = { kitchenLF: ctTotals.kitchenLF, vanityLF: ctTotals.vanityLF, kitchenSF: ctTotals.kitchenSF, vanitySF: ctTotals.vanitySF, materialSF: ctMaterialSF, orderSF: ctOrderSF, sinks: ctTotals.sinks, unitTypes: ctUnits, savedAt: new Date().toISOString() }
    await supabase.from('activity_log').insert({ job_id:selectedJobId, user_name:'Cole', action:'__CT_TAKEOFF__:' + JSON.stringify(payload) })
    setCtSaving(false)
    setComplete('countertop')
    setSavedAt(p => ({ ...p, countertop: new Date().toLocaleTimeString() }))
    alert(`✓ Countertop saved — ${ctMaterialSF.toFixed(1)} SF material · ${ctOrderSF.toFixed(1)} SF order`)
  }

  // ── Export ───────────────────────────────────────────────────────────────
  async function runExport() {
    if (!editData) return alert('Complete the Elevation step first')
    setExporting(true)
    setRunning('export')
    try {
      const res = await fetch('/api/export/excel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ takeoffData: editData, projectName: editData.project_name || 'MDSG Project', supplierName: editData.specs?.cabinet_line || 'TBD', catalogRef: 'TBD', printDate: new Date().toLocaleDateString('en-US') }),
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = `${(editData.project_name||'Cabinet_Schedule').replace(/[^a-zA-Z0-9_-]/g,'_')}_Cabinet_Schedule.xlsx`
      a.click(); URL.revokeObjectURL(url)
      setComplete('export')
      setSavedAt(p => ({ ...p, export: new Date().toLocaleTimeString() }))
    } catch (err) { setAgentError('export'); alert('Export failed: ' + err.message) }
    setExporting(false)
  }

  // ── Per-unit extraction ──────────────────────────────────────────────────────
  async function runUnitExtraction(unitName, ui) {
    const files = unitFiles[unitName]
    if (!files?.length) return alert('Select elevation files for ' + unitName + ' first')
    setUnitExtracting(p => ({ ...p, [unitName]: true }))
    const fd = new FormData()
    fd.append('specs', specs)
    fd.append('unitMatrix', JSON.stringify([{ name: unitName, quantity: 1, sheet: '' }]))
    files.forEach(f => fd.append('files', f))
    const timeout = setTimeout(() => {}, 300000)
    try {
      const res = await fetch('/api/takeoff', { method: 'POST', body: fd })
      clearTimeout(timeout)
      const result = await res.json()
      if (result.success) {
        const found = result.data?.unit_types?.find(u =>
          u.unit_type_name?.toUpperCase().includes(unitName.replace('UNIT ','').trim().toUpperCase())
        ) || result.data?.unit_types?.[0]
        if (found?.skus?.length) {
          setEditData(prev => {
            const u = JSON.parse(JSON.stringify(prev))
            u.unit_types[ui].skus = found.skus
            return u
          })
          alert('✓ ' + found.skus.length + ' SKUs extracted for ' + unitName)
        } else {
          alert('No SKUs found — check that the files show ' + unitName + ' cabinet elevations')
        }
      } else {
        alert('Extraction failed: ' + (result.error || 'Unknown'))
      }
    } catch (err) { clearTimeout(timeout); alert('Error: ' + err.message) }
    setUnitExtracting(p => ({ ...p, [unitName]: false }))
  }

  // ── Edit helpers ─────────────────────────────────────────────────────────
  function updateSku(ui, si, field, val) {
    const u = JSON.parse(JSON.stringify(editData)); u.unit_types[ui].skus[si][field] = val; setEditData(u)
  }
  function addSku(ui) {
    const u = JSON.parse(JSON.stringify(editData))
    u.unit_types[ui].skus.push({ sku:'', description:'', quantity_per_unit:1, hinge_side:'', location:'kitchen' })
    setEditData(u)
  }
  function removeSku(ui, si) {
    const u = JSON.parse(JSON.stringify(editData)); u.unit_types[ui].skus.splice(si,1); setEditData(u)
  }
  function getCabsPerUnit(ut) {
    return (ut.skus||[]).reduce((s,sk)=>s+(isTrueCabinet(sk.sku)?Number(sk.quantity_per_unit)||0:0),0)
  }


  // ── Pipeline bar (top strip, Option 2 layout) ────────────────────────────
  function PipelineBar() {
    const PDF_NODES = [
      { key:'upload',     label:'Upload'     },
      { key:'classify',   label:'Classify'   },
      { key:'matrix',     label:'Matrix'     },
      { key:'elevation',  label:'Elevation'  },
      { key:'countertop', label:'Countertop' },
      { key:'export',     label:'Export'     },
    ]
    const XL_NODES = [
      { key:'upload',    label:'Upload' },
      { key:'classify',  label:'Parse'  },
      { key:'elevation', label:'Review' },
    ]
    const isExcel = hasExcel()
    const base = { borderRadius:5, padding:'3px 9px', cursor:'pointer', fontSize:10, fontWeight:600, whiteSpace:'nowrap', transition:'all .15s', border:'0.5px solid' }

    return (
      <div style={{ background:SIDE, borderBottom:`0.5px solid ${BORDER}`, padding:'9px 20px 8px', flexShrink:0 }}>
        {/* PDF / AI row */}
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:6, opacity:isExcel?0.3:1, transition:'opacity .2s' }}>
          <span style={{ fontSize:8, color:'#534AB7', textTransform:'uppercase', letterSpacing:.4, fontWeight:600, minWidth:34 }}>PDF</span>
          {PDF_NODES.map((n,i) => {
            const status = agentStatus[n.key]
            const isAct  = !isExcel && activeAgent === n.key
            const isDone = !isExcel && status === 'complete'
            const agent  = AGENTS.find(a => a.key === n.key)
            const c      = agent?.color || '#6366f1'
            return (
              <div key={n.key} style={{ display:'flex', alignItems:'center', gap:3 }}>
                <div style={{ ...base,
                  background:  isAct||isDone ? c+'18' : CARD,
                  borderColor: isAct ? c : isDone ? c+'88' : BORDER,
                  borderWidth:  isAct ? '1px' : '0.5px',
                  color:       isAct||isDone ? c : MUTED,
                  boxShadow:   isAct ? `0 0 0 2px ${c}44` : 'none',
                }} onClick={() => !isExcel && setActiveAgent(n.key)}>
                  {isDone && <span style={{ marginRight:2 }}>✓</span>}{n.label}
                </div>
                {i < PDF_NODES.length-1 && <span style={{ fontSize:9, color:MUTED }}>›</span>}
              </div>
            )
          })}
        </div>
        {/* Excel row */}
        <div style={{ display:'flex', alignItems:'center', gap:4, opacity:isExcel?1:0.3, transition:'opacity .2s' }}>
          <span style={{ fontSize:8, color:'#0F6E56', textTransform:'uppercase', letterSpacing:.4, fontWeight:600, minWidth:34 }}>Excel</span>
          {XL_NODES.map((n,i) => {
            const status = agentStatus[n.key]
            const isAct  = isExcel && activeAgent === n.key
            const isDone = isExcel && status === 'complete'
            return (
              <div key={n.key+'-xl'} style={{ display:'flex', alignItems:'center', gap:3 }}>
                <div style={{ ...base,
                  background:  isAct||isDone ? '#E1F5EE' : CARD,
                  borderColor: isAct ? '#085041' : isDone ? '#0F6E56' : BORDER,
                  borderWidth:  isAct ? '1px' : '0.5px',
                  color:       isAct ? '#04342C' : isDone ? '#085041' : MUTED,
                  boxShadow:   isAct ? '0 0 0 2px #9FE1CB' : 'none',
                }} onClick={() => isExcel && setActiveAgent(n.key)}>
                  {isDone && <span style={{ marginRight:2 }}>✓</span>}{n.label}
                </div>
                {i < XL_NODES.length-1 && <span style={{ fontSize:9, color:MUTED }}>›</span>}
              </div>
            )
          })}
          <span style={{ fontSize:9, color:MUTED, marginLeft:3 }}>- - - › Export</span>
        </div>
      </div>
    )
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────
  function Sidebar() {
    const completedCount = Object.values(agentStatus).filter(s=>s==='complete').length
    return (
      <div style={{ width:240, background:SIDE, borderRight:`0.5px solid ${BORDER}`, display:'flex', flexDirection:'column', flexShrink:0, minHeight:'100vh', borderRight:`0.5px solid ${BORDER}` }}>
        {/* Header */}
        <div style={{ padding:'20px 16px 14px', borderBottom:`1px solid ${BORDER}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <div style={{ width:28, height:28, background:'linear-gradient(135deg,#7c3aed,#6366f1)', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>⚡</div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:TEXT, letterSpacing:0.5 }}>MDSG OS</div>
              <div style={{ fontSize:9, color:MUTED, letterSpacing:0.5 }}>AI TAKEOFF ENGINE</div>
            </div>
          </div>
        </div>
        {/* Job selector */}
        <div style={{ padding:'12px 14px', borderBottom:`1px solid ${BORDER}` }}>
          <label style={dlbl}>Active Job</label>
          <select value={selectedJobId} onChange={e=>setSelectedJobId(e.target.value)} style={{ ...dinp, padding:'5px 8px', fontSize:11 }}>
            <option value="">— Select job —</option>
            {jobs.map(j=><option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </div>
        {/* Compact step list */}
        <div style={{ flex:1, padding:'8px 0' }}>
          {AGENTS.map(agent => {
            const status = agentStatus[agent.key]
            const isAct  = activeAgent === agent.key
            return (
              <div key={agent.key} onClick={()=>setActiveAgent(agent.key)}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 14px', cursor:'pointer',
                  background: isAct ? `${agent.color}12` : 'transparent',
                  borderLeft: `2px solid ${isAct ? agent.color : 'transparent'}` }}>
                <div style={{ width:7, height:7, borderRadius:'50%', flexShrink:0,
                  background: status==='complete' ? agent.color : isAct ? agent.color : '#d1d5db',
                  boxShadow: isAct ? `0 0 5px ${agent.color}88` : 'none' }}/>
                <div style={{ fontSize:11, color:status==='pending'?MUTED:TEXT, flex:1, fontWeight:isAct?500:400 }}>
                  {agent.label}
                </div>
                {status==='complete' && <span style={{ fontSize:9, color:agent.color }}>✓</span>}
                {savedAt[agent.key] && <span style={{ fontSize:9, color:MUTED }}>{savedAt[agent.key]}</span>}
              </div>
            )
          })}
        </div>
                {/* Bottom */}
        <div style={{ padding:'12px 14px', borderTop:`1px solid ${BORDER}` }}>
          <div style={{ fontSize:10, color:MUTED, marginBottom:6 }}>{completedCount} / {AGENTS.length} complete</div>
          <div style={{ height:3, background:'#1a1a2e', borderRadius:2 }}>
            <div style={{ height:'100%', width:`${(completedCount/AGENTS.length)*100}%`, background:'linear-gradient(90deg,#6366f1,#16a34a)', borderRadius:2, transition:'width 0.4s' }}/>
          </div>
        </div>
      </div>
    )
  }

  // ── Panel header ─────────────────────────────────────────────────────────
  function PanelHeader({ agentKey, title, subtitle, action }) {
    const agent  = AGENTS.find(a=>a.key===agentKey)
    const status = agentStatus[agentKey]
    const prog   = agentProg[agentKey]
    return (
      <div style={{ ...dcard, marginBottom:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:status==='complete'?agent.color:status==='running'?agent.color:'#3a3a5a', boxShadow:status==='running'?`0 0 6px ${agent.color}`:'none' }}/>
              <div style={{ fontSize:16, fontWeight:600, color:TEXT }}>{title}</div>
            </div>
            <div style={{ fontSize:12, color:MUTED }}>{subtitle}</div>
          </div>
          {action}
        </div>
        {(status==='running'||status==='complete') && (
          <div style={{ marginTop:14, height:3, background:'#e5e5e0', borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${prog}%`, background:agent.color, transition:'width 0.4s ease', borderRadius:2 }}/>
          </div>
        )}
      </div>
    )
  }

  // ── Button helpers ───────────────────────────────────────────────────────
  function Btn({ label, onClick, disabled, color='#6366f1', small=false, outline=false }) {
    return (
      <button onClick={onClick} disabled={disabled} style={{ padding:small?'5px 14px':'9px 22px', fontSize:small?11:13, fontWeight:600, background:disabled?'#2a2a4a':outline?'transparent':color, color:disabled?MUTED:outline?color:TEXT, border:outline?`1px solid ${color}`:'none', borderRadius:7, cursor:disabled?'not-allowed':'pointer', transition:'opacity 0.15s', opacity:disabled?0.5:1 }}>
        {label}
      </button>
    )
  }

  function SaveBadge({ agentKey }) {
    const saved = savedAt[agentKey]
    return saved
      ? <div style={{ fontSize:10, color:'#16a34a', background:'#16a34a18', border:'1px solid #16a34a40', borderRadius:6, padding:'3px 10px' }}>✓ Saved {saved}</div>
      : null
  }

  // ── PANEL: Upload ─────────────────────────────────────────────────────────
  function UploadPanel() {
    return (
      <div>
        <PanelHeader agentKey="upload" title="Upload Plan Set" subtitle="Select the full plan set PDF — the Page Classifier will sort the pages for the other agents" />
        <div style={dcard}>
          <label style={dlbl}>Full Plan Set PDF</label>
          <label style={{ display:'block', border:`2px dashed ${files.length?'#6366f1':'#252545'}`, borderRadius:10, padding:28, textAlign:'center', cursor:'pointer', background:files.length?'#6366f110':'transparent', marginBottom:12, transition:'all 0.2s' }}>
            <div style={{ fontSize:14, color:files.length?TEXT:MUTED, marginBottom:4 }}>
              {hasExcel() ? ('📊 Excel ready: ' + (files.find(isExcelFile)?.name || '')) : files.length===0 ? '📤 Click to select PDF, JPEGs, or Excel (.xlsx)' : `${files.length} file${files.length>1?'s':''} selected`}
            </div>
            <div style={{ fontSize:11, color:MUTED }}>Full plan set OK — Page Classifier finds relevant pages automatically</div>
            {files.length>0 && (
              <div style={{ marginTop:10 }}>
                {files.map((f,i)=><div key={i} style={{ fontSize:11, color:'#6366f1', padding:'2px 0' }}>📄 {f.name} ({(f.size/1024/1024).toFixed(1)} MB)</div>)}
              </div>
            )}
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xlsm" multiple onChange={e=>setFiles(Array.from(e.target.files))} style={{ display:'none' }}/>
          </label>
          <label style={{ display:'block', border:`1px dashed ${shopFiles.length?'#0d9488':'#252545'}`, borderRadius:8, padding:14, textAlign:'center', cursor:'pointer', background:shopFiles.length?'#0d948810':'transparent', marginBottom:16, transition:'all 0.2s' }}>
            <div style={{ fontSize:12, color:shopFiles.length?TEXT:MUTED }}>
              {shopFiles.length===0 ? '📐 Shop drawings — optional, upload if available' : `✓ ${shopFiles.length} shop drawing file${shopFiles.length>1?'s':''}`}
            </div>
            <input type="file" accept=".pdf" multiple onChange={e=>setShopFiles(Array.from(e.target.files))} style={{ display:'none' }}/>
          </label>
          <div style={{ marginBottom:16 }}>
            <label style={dlbl}>Cabinet Specs (optional)</label>
            <input value={specs} onChange={e=>setSpecs(e.target.value)} style={dinp} placeholder="e.g. Northern Contours — Flat Panel — 2212 Braelyn laminate"/>
          </div>
          <Btn label={hasExcel() ? "Confirm Upload → Import from Excel" : files.some(f=>f.type.startsWith('image/')) ? "Confirm Upload → Skip to Elevation" : "Confirm Upload → Classify Pages"} onClick={confirmUpload} color="#6366f1" disabled={!files.length}/>
        </div>
      </div>
    )
  }

  // ── PANEL: Classify ───────────────────────────────────────────────────────
  function ClassifyPanel() {
    const typeColors = { elevation:'#7c3aed', floor_plan:'#0891b2', unit_schedule:'#0d9488', amenity:'#ea580c', finish_schedule:'#d97706', cover_sheet:'#6b7280', other:'#374151' }
    return (
      <div>
        <PanelHeader agentKey="classify" title="Page Classifier Agent" subtitle="Scans every page and labels it — elevation, floor plan, schedule, amenity, etc. Downstream agents only see pages they need."
          action={!classifyData && <Btn label={agentStatus.classify==='running'?'⏳ Classifying...':'Run Classifier'} onClick={runClassify} color="#7c3aed" disabled={agentStatus.classify==='running'}/>}
        />
        {!classifyData && agentStatus.classify!=='running' && (
          <div style={{ ...dcard, textAlign:'center', padding:40 }}>
            <div style={{ fontSize:32, marginBottom:12 }}>🔍</div>
            <div style={{ fontSize:14, color:MUTED, marginBottom:20 }}>Reads all {files.length} file{files.length>1?'s':''} and classifies every page by type.<br/>Takes about 30 seconds.</div>
            <Btn label="Run Page Classifier" onClick={runClassify} color="#7c3aed"/>
          </div>
        )}
        {agentStatus.classify==='running' && (
          <div style={{ ...dcard, textAlign:'center', padding:40 }}>
            <div style={{ fontSize:14, color:'#7c3aed', marginBottom:8 }}>● Classifying pages...</div>
            <div style={{ fontSize:12, color:MUTED }}>Reading all pages and identifying types. Do not close.</div>
          </div>
        )}
        {classifyData && (
          <div>
            <div style={{ ...dcard }}>
              <div style={{ fontSize:12, fontWeight:600, color:TEXT, marginBottom:12 }}>{classifyData.totalPages} pages classified</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:10, marginBottom:16 }}>
                {Object.entries(classifyData.summary).map(([type,count])=>(
                  <div key={type} style={{ background:'#1a1a2e', border:`1px solid ${typeColors[type]||BORDER}44`, borderRadius:8, padding:'12px 10px', textAlign:'center' }}>
                    <div style={{ fontSize:22, fontWeight:700, color:typeColors[type]||TEXT }}>{count}</div>
                    <div style={{ fontSize:10, color:MUTED, marginTop:3 }}>{type.replace(/_/g,' ')}</div>
                  </div>
                ))}
              </div>
              {classifyData.unitTypesFound?.length>0 && (
                <div style={{ background:'#7c3aed14', border:'1px solid #7c3aed40', borderRadius:8, padding:'10px 14px', marginBottom:12, fontSize:12 }}>
                  <span style={{ color:'#7c3aed', fontWeight:600 }}>{classifyData.unitTypesFound.length} unit types found:</span>
                  <span style={{ color:TEXT, marginLeft:8 }}>{classifyData.unitTypesFound.join(', ')}</span>
                </div>
              )}
              <div style={{ fontSize:11, color:MUTED }}>
                ✓ Elevation Engine will use {classifyData.pagesByType?.elevation?.length||0} elevation pages · Unit Matrix will use {classifyData.pagesByType?.unit_schedule?.length||0} schedule pages
              </div>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <Btn label="Continue to Unit Matrix →" onClick={()=>setActiveAgent('matrix')} color="#7c3aed"/>
              <Btn label="Re-classify" onClick={()=>{setClassifyData(null);setAgentStatus(p=>({...p,classify:'pending'}))}} outline color="#7c3aed" small/>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── PANEL: Matrix ─────────────────────────────────────────────────────────
  function MatrixPanel() {
    return (
      <div>
        <PanelHeader agentKey="matrix" title="Unit Matrix Agent" subtitle="Verify unit types and quantities. These counts drive every calculation downstream."
          action={<SaveBadge agentKey="matrix"/>}
        />
        <div style={dcard}>
          <div style={{ marginBottom:14 }}>
            <label style={dlbl}>Upload unit schedule pages (optional — or edit the table below)</label>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <label style={{ flex:1, border:`1px dashed ${matrixFiles.length?'#0d9488':BORDER}`, borderRadius:7, padding:'8px 14px', cursor:'pointer', fontSize:11, color:matrixFiles.length?TEXT:MUTED, textAlign:'center' }}>
                {matrixFiles.length ? `✓ ${matrixFiles.length} file${matrixFiles.length>1?'s':''} selected` : '📋 Click to upload unit schedule PDF'}
                <input type="file" accept=".pdf" multiple onChange={e=>setMatrixFiles(Array.from(e.target.files))} style={{ display:'none' }}/>
              </label>
              {matrixFiles.length>0 && <Btn label={matrixLoading?'Reading...':'Extract'} onClick={runMatrixExtract} disabled={matrixLoading} color="#0d9488" small/>}
            </div>
          </div>
          {/* Unit type table */}
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, marginBottom:14 }}>
            <thead>
              <tr style={{ background:'#1a1a2e' }}>
                {['Unit Type Name','Quantity','Sheet Ref',''].map(h=><th key={h} style={{ padding:'8px 10px', textAlign:'left', fontSize:10, color:MUTED, fontWeight:500, borderBottom:`1px solid ${BORDER}` }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrixData.map((u,i)=>(
                <tr key={i} style={{ borderBottom:`1px solid ${BORDER}22` }}>
                  <td style={{ padding:'5px 8px' }}><input value={u.name} onChange={e=>setMatrixData(p=>p.map((r,j)=>j===i?{...r,name:e.target.value}:r))} style={{ ...dinp, width:'100%' }}/></td>
                  <td style={{ padding:'5px 8px' }}><input
                      type="text"
                      inputMode="numeric"
                      value={u.quantity===0?'':String(u.quantity)}
                      placeholder="0"
                      onChange={e=>{
                        const val=e.target.value.replace(/[^0-9]/g,'')
                        setMatrixData(p=>p.map((r,j)=>j===i?{...r,quantity:val===''?0:parseInt(val)}:r))
                      }}
                      style={{ ...dinp, width:80, textAlign:'center', fontSize:13, fontWeight:600 }}
                    /></td>
                  <td style={{ padding:'5px 8px' }}><input value={u.sheet||''} onChange={e=>setMatrixData(p=>p.map((r,j)=>j===i?{...r,sheet:e.target.value}:r))} style={{ ...dinp, width:90 }} placeholder="A410"/></td>
                  <td style={{ padding:'5px 8px' }}><button onClick={()=>setMatrixData(p=>p.filter((_,j)=>j!==i))} style={{ background:'#dc262622', color:'#dc2626', border:'none', borderRadius:4, cursor:'pointer', padding:'3px 8px', fontSize:10 }}>✕</button></td>
                </tr>
              ))}
              {matrixData.length===0 && <tr><td colSpan={4} style={{ padding:'16px 10px', color:MUTED, fontSize:11, textAlign:'center' }}>No unit types yet — upload a unit schedule or add rows manually</td></tr>}
            </tbody>
          </table>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>setMatrixData(p=>[...p,{name:'New Unit',quantity:1,sheet:''}])} style={{ fontSize:11, padding:'5px 12px', background:'#0d948820', color:'#0d9488', border:'1px solid #0d948840', borderRadius:6, cursor:'pointer' }}>+ Add Row</button>
              {matrixData.length>0 && <span style={{ fontSize:11, color:MUTED, alignSelf:'center' }}>Total: {matrixData.reduce((s,u)=>s+(u.quantity||0),0)} units</span>}
            </div>
            <Btn label="✓ Confirm Matrix" onClick={confirmMatrix} color="#0d9488"/>
          </div>
        </div>
      </div>
    )
  }

  // ── PANEL: Elevation ──────────────────────────────────────────────────────
  function ElevationPanel() {
    const grandTotal = editData?.unit_types?.reduce((s,ut)=>s+getCabsPerUnit(ut)*(ut.unit_quantity||1),0)||0
    return (
      <div>
        <PanelHeader agentKey="elevation" title="Elevation Engine" subtitle="AI reads every elevation sheet and extracts cabinet SKUs, quantities, and hinge sides per unit type."
          action={
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <SaveBadge agentKey="elevation"/>
              {editData && <Btn label="↺ Re-run" onClick={()=>{setEditData(null);setElevSummary(null);setAgentStatus(p=>({...p,elevation:'pending'}));setAgentProg(p=>({...p,elevation:0}))}} color="#6366f1" small outline/>}
              {editData && <Btn label={saving?'Saving...':'Save to Job'} onClick={saveElevationToJob} disabled={saving||!selectedJobId} color="#0d9488" small/>}
            </div>
          }
        />
        {!editData && agentStatus.elevation!=='running' && (
          <div style={{ ...dcard, textAlign:'center', padding:40 }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⚡</div>
            <div style={{ fontSize:14, color:MUTED, marginBottom:8 }}>
              {matrixData.length>0 ? `Ready — ${matrixData.length} unit types · ${matrixData.reduce((s,u)=>s+(u.quantity||0),0)} total units confirmed` : 'Will extract unit types automatically from the plan set.'}
            </div>
            {classifyData && <div style={{ fontSize:11, color:'#7c3aed', marginBottom:16 }}>✓ Using {classifyData.pagesByType?.elevation?.length||0} elevation pages from classifier</div>}
            {hasExcel()
              ? <Btn label={excelImporting ? '⏳ Importing Excel...' : '📊 Import from Excel'} onClick={runExcelImport} disabled={excelImporting} color="#0d9488"/>
              : <Btn label="Run Elevation Engine" onClick={runExtraction} color="#8b5cf6"/>}
          </div>
        )}
        {agentStatus.elevation==='running' && (
          <div style={{ ...dcard, padding:32 }}>
            <div style={{ fontSize:13, color:'#8b5cf6', fontWeight:600, marginBottom:8 }}>● Extracting cabinet SKUs...</div>
            <div style={{ fontSize:11, color:MUTED, marginBottom:16 }}>Full plan sets take 5–10 minutes. Do not close the window.</div>
            <button onClick={()=>abortRef.current?.abort()} style={{ padding:'5px 14px', fontSize:11, background:'#dc262620', color:'#dc2626', border:'1px solid #dc262640', borderRadius:6, cursor:'pointer' }}>✕ Cancel</button>
          </div>
        )}
        {editData && (
          <div>
            {/* Summary bar */}
            <div style={{ ...dcard, background:'#f0eeff', border:`0.5px solid #8b5cf640` }}>
              <div style={{ display:'flex', gap:20, flexWrap:'wrap' }}>
                {[
                  ['Unit Types', editData.unit_types?.length||0],
                  ['Total Units', matrixData.reduce((s,u)=>s+(u.quantity||0),0)||editData.unit_types?.reduce((s,u)=>s+(u.unit_quantity||0),0)||0],
                  ['Total Cabinets', grandTotal.toLocaleString()],
                  ['Confidence', (elevSummary?.confidence||'?').toUpperCase()],
                ].map(([label,val])=>(
                  <div key={label}>
                    <div style={{ fontSize:9, color:MUTED, textTransform:'uppercase', letterSpacing:0.5, marginBottom:2 }}>{label}</div>
                    <div style={{ fontSize:18, fontWeight:700, color:TEXT }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Unit type cards */}
            {editData.unit_types.map((ut,ui)=>{
              const isExp = expandedUnit===ui
              const cabs  = getCabsPerUnit(ut)
              return (
                <div key={ui} style={{ ...dcard, padding:0, overflow:'hidden', marginBottom:8 }}>
                  <div onClick={()=>setExpandedUnit(isExp?null:ui)} style={{ padding:'10px 16px', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', background:isExp?'#1a1a35':CARD }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ fontSize:11, color:MUTED }}>{isExp?'▼':'▶'}</span>
                      <div>
                        <span style={{ fontWeight:500, fontSize:13, color:TEXT }}>{ut.unit_type_name}</span>
                        <span style={{ fontSize:10, color:ut.skus?.length>0?'#16a34a':'#d97706', marginLeft:8, background:ut.skus?.length>0?'#16a34a18':'#d9770618', border:`1px solid ${ut.skus?.length>0?'#16a34a40':'#d9770640'}`, borderRadius:4, padding:'1px 6px' }}>
                          {ut.skus?.length>0?`✓ ${ut.skus.length} SKUs`:'needs elevations'}
                        </span>
                      </div>
                    </div>
                    <div style={{ fontSize:11, color:MUTED }}>{ut.unit_quantity} units · {cabs} cabs/unit · {(cabs*(ut.unit_quantity||1)).toLocaleString()} total</div>
                  </div>
                  {isExp && (
                    <div style={{ padding:16, borderTop:`1px solid ${BORDER}` }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                        <div style={{ fontSize:11, fontWeight:500, color:TEXT }}>Cabinet SKUs</div>
                        <button onClick={()=>addSku(ui)} style={{ fontSize:10, padding:'3px 10px', background:'#8b5cf620', color:'#8b5cf6', border:'1px solid #8b5cf640', borderRadius:5, cursor:'pointer' }}>+ Add SKU</button>
                      </div>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                        <thead>
                          <tr style={{ background:'#1a1a2e' }}>
                            {['SKU','Description','Qty/Unit','Hinge','Hardware',''].map(h=><th key={h} style={{ padding:'5px 7px', textAlign:'left', fontSize:10, color:MUTED, fontWeight:500, borderBottom:`1px solid ${BORDER}` }}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {(ut.skus||[]).map((sk,si)=>{
                            const hw = calcHardware(sk.sku)
                            return (
                              <tr key={si} style={{ borderBottom:`1px solid ${BORDER}22` }}>
                                <td style={{ padding:'4px 5px' }}><input value={sk.sku} onChange={e=>updateSku(ui,si,'sku',e.target.value)} style={{ ...dinp, width:88, fontFamily:'monospace', fontWeight:600, fontSize:11 }}/></td>
                                <td style={{ padding:'4px 5px' }}><input value={sk.description} onChange={e=>updateSku(ui,si,'description',e.target.value)} style={{ ...dinp, width:'100%' }}/></td>
                                <td style={{ padding:'4px 5px' }}><input type="number" min="0" value={sk.quantity_per_unit} onChange={e=>updateSku(ui,si,'quantity_per_unit',Number(e.target.value))} style={{ ...dinp, width:50, textAlign:'center' }}/></td>
                                <td style={{ padding:'4px 5px' }}>
                                  <select value={sk.hinge_side||''} onChange={e=>updateSku(ui,si,'hinge_side',e.target.value)} style={{ ...dinp, width:58 }}>
                                    <option value="">—</option><option>L</option><option>R</option><option>L/R</option><option>NA</option>
                                  </select>
                                </td>
                                <td style={{ padding:'4px 5px', textAlign:'center' }}>
                                  {hw===null ? <span style={{ fontSize:10, background:'#dc262618', color:'#dc2626', padding:'2px 6px', borderRadius:10 }}>?</span>
                                   : hw===0  ? <span style={{ fontSize:10, color:MUTED }}>—</span>
                                   : <span style={{ fontSize:11, fontWeight:600, background:'#16a34a18', color:'#16a34a', padding:'2px 8px', borderRadius:10 }}>{hw}</span>}
                                </td>
                                <td style={{ padding:'4px 5px' }}><button onClick={()=>removeSku(ui,si)} style={{ padding:'3px 6px', background:'#dc262618', color:'#dc2626', border:'none', borderRadius:4, cursor:'pointer', fontSize:10 }}>✕</button></td>
                              </tr>
                            )
                          })}
                          {(ut.skus||[]).length===0 && (
                            <tr><td colSpan={6} style={{ padding:'10px 7px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                                <label style={{ flex:1, border:`1px dashed ${BORDER}`, borderRadius:7, padding:'8px 14px', cursor:'pointer', fontSize:11, color:unitFiles[ut.unit_type_name]?.length ? TEXT : MUTED, background: unitFiles[ut.unit_type_name]?.length ? '#f0eeff' : 'transparent' }}>
                                  {unitFiles[ut.unit_type_name]?.length
                                    ? `✓ ${unitFiles[ut.unit_type_name].length} file${unitFiles[ut.unit_type_name].length>1?'s':''} selected`
                                    : '📎 Upload elevation PDF or JPEG for this unit'}
                                  <input type="file" accept=".pdf,.jpg,.jpeg,.png" multiple style={{ display:'none' }}
                                    onChange={e => setUnitFiles(p => ({ ...p, [ut.unit_type_name]: Array.from(e.target.files) }))}/>
                                </label>
                                <button
                                  onClick={() => runUnitExtraction(ut.unit_type_name, ui)}
                                  disabled={unitExtracting[ut.unit_type_name] || !unitFiles[ut.unit_type_name]?.length}
                                  style={{ padding:'7px 16px', fontSize:12, fontWeight:600, background: unitExtracting[ut.unit_type_name]||!unitFiles[ut.unit_type_name]?.length ? '#e5e5e0' : '#8b5cf6', color: unitExtracting[ut.unit_type_name]||!unitFiles[ut.unit_type_name]?.length ? MUTED : '#fff', border:'none', borderRadius:7, cursor: unitExtracting[ut.unit_type_name]||!unitFiles[ut.unit_type_name]?.length ? 'not-allowed':'pointer', whiteSpace:'nowrap' }}>
                                  {unitExtracting[ut.unit_type_name] ? '⏳ Extracting...' : 'Extract SKUs'}
                                </button>
                              </div>
                            </td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
            <div style={{ display:'flex', gap:10, marginTop:8 }}>
              <Btn label={saving?'Saving...':'Save to Job'} onClick={saveElevationToJob} disabled={saving||!selectedJobId} color="#0d9488"/>
              <Btn label="Continue to Countertop →" onClick={()=>setActiveAgent('countertop')} color="#8b5cf6"/>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── PANEL: Countertop ─────────────────────────────────────────────────────
  function CountertopPanel() {
    return (
      <div>
        <PanelHeader agentKey="countertop" title="Countertop Agent" subtitle="Enter kitchen and vanity LF per unit type. SF calculated automatically using Kitchen × 2.125 and Vanity × 1.875."
          action={
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <SaveBadge agentKey="countertop"/>
              <Btn label={ctSaving?'Saving...':'Save to Job'} onClick={saveCountertopToJob} disabled={ctSaving||!selectedJobId} color="#d97706" small/>
            </div>
          }
        />
        {ctUnits.length===0 && (
          <div style={{ ...dcard, textAlign:'center', padding:32 }}>
            <div style={{ fontSize:13, color:MUTED }}>Complete the Elevation Engine step first — unit types will auto-populate here.<br/>Or add unit types manually below.</div>
            <button style={{ marginTop:16, padding:'7px 18px', fontSize:12, background:'#d9770620', color:'#d97706', border:'1px solid #d9770640', borderRadius:6, cursor:'pointer' }}
              onClick={()=>setCtUnits([{name:'Unit Type 1',qty:1,kitchenLF:0,vanityLF:0,sinks:0}])}>+ Add Unit Type</button>
          </div>
        )}
        {ctUnits.length>0 && (
          <div>
            <div style={dcard}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ background:'#1a1a2e' }}>
                    {['Unit Type','Qty','Kitchen LF','Kitchen SF','Vanity LF','Vanity SF','Sinks'].map(h=><th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:10, color:MUTED, fontWeight:500, borderBottom:`1px solid ${BORDER}` }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {ctUnits.map((ut,i)=>{
                    const kSF = (ut.kitchenLF||0)*2.125
                    const vSF = (ut.vanityLF||0)*1.875
                    return (
                      <tr key={i} style={{ borderBottom:`1px solid ${BORDER}22` }}>
                        <td style={{ padding:'5px 8px', fontSize:12, color:TEXT, fontWeight:500 }}>{ut.name}</td>
                        <td style={{ padding:'5px 8px' }}><input type="text" inputMode="numeric" value={ut.qty===1&&ut.qty===1?ut.qty:ut.qty} onChange={e=>setCtUnits(p=>p.map((r,j)=>j===i?{...r,qty:parseInt(e.target.value.replace(/[^0-9]/g,''))||1}:r))} style={{ ...dinp, width:65, textAlign:'center', fontWeight:600 }}/></td>
                        <td style={{ padding:'5px 8px' }}><input type="number" step="0.25" value={ut.kitchenLF||''} onChange={e=>setCtUnits(p=>p.map((r,j)=>j===i?{...r,kitchenLF:parseFloat(e.target.value)||0}:r))} style={{ ...dinp, width:75 }} placeholder="0"/></td>
                        <td style={{ padding:'5px 8px', fontSize:12, color:'#d97706', fontWeight:600 }}>{kSF>0?kSF.toFixed(1)+' SF':'—'}</td>
                        <td style={{ padding:'5px 8px' }}><input type="number" step="0.25" value={ut.vanityLF||''} onChange={e=>setCtUnits(p=>p.map((r,j)=>j===i?{...r,vanityLF:parseFloat(e.target.value)||0}:r))} style={{ ...dinp, width:75 }} placeholder="0"/></td>
                        <td style={{ padding:'5px 8px', fontSize:12, color:'#d97706', fontWeight:600 }}>{vSF>0?vSF.toFixed(1)+' SF':'—'}</td>
                        <td style={{ padding:'5px 8px' }}><input type="number" value={ut.sinks||0} onChange={e=>setCtUnits(p=>p.map((r,j)=>j===i?{...r,sinks:parseInt(e.target.value)||0}:r))} style={{ ...dinp, width:50, textAlign:'center' }}/></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <button style={{ marginTop:10, fontSize:11, padding:'4px 12px', background:'#d9770618', color:'#d97706', border:'1px solid #d9770640', borderRadius:5, cursor:'pointer' }}
                onClick={()=>setCtUnits(p=>[...p,{name:'New Unit',qty:1,kitchenLF:0,vanityLF:0,sinks:0}])}>+ Add Row</button>
            </div>

            {/* Totals */}
            <div style={{ background:'#f5f5f3', borderRadius:'10px 10px 0 0', border:`0.5px solid ${BORDER}`, borderBottom:'none', padding:'14px 20px' }}>
              <div style={{ fontSize:9, color:'#d97706', fontWeight:600, textTransform:'uppercase', letterSpacing:1, marginBottom:10 }}>SQUARE FOOTAGE TAKEOFF</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12 }}>
                {[['Kitchen Counter',ctTotals.kitchenSF.toFixed(1)+' SF'],['Vanity',ctTotals.vanitySF.toFixed(1)+' SF'],['Total Material',ctMaterialSF.toFixed(1)+' SF'],['Waste',wastePct+'%'],['Order Qty',ctOrderSF.toFixed(1)+' SF']].map(([l,v])=>(
                  <div key={l} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:8, color:MUTED, textTransform:'uppercase', letterSpacing:0.5, marginBottom:2 }}>{l}</div>
                    <div style={{ color:l==='Order Qty'?'#d97706':'#1a1a1a', fontSize:l==='Order Qty'?20:16, fontWeight:700 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background:'#eeeee9', borderRadius:'0 0 10px 10px', border:`0.5px solid ${BORDER}`, borderTop:'none', padding:'10px 20px', marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:11, color:MUTED }}>Waste factor:</span>
                <input type="number" min="0" max="30" value={wastePct} onChange={e=>setWastePct(Number(e.target.value))} style={{ ...dinp, width:50, textAlign:'center' }}/>
                <span style={{ fontSize:11, color:MUTED }}>% · LF Kitchen: {ctTotals.kitchenLF.toFixed(1)} · LF Vanity: {ctTotals.vanityLF.toFixed(1)} · Sinks: {ctTotals.sinks}</span>
              </div>
            </div>

            <div style={{ display:'flex', gap:10 }}>
              <Btn label={ctSaving?'Saving...':'Save Countertop to Job'} onClick={saveCountertopToJob} disabled={ctSaving||!selectedJobId} color="#d97706"/>
              <Btn label="Continue to Export →" onClick={()=>setActiveAgent('export')} color="#16a34a"/>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── PANEL: Export ─────────────────────────────────────────────────────────
  function ExportPanel() {
    const grandTotal = editData?.unit_types?.reduce((s,ut)=>s+getCabsPerUnit(ut)*(ut.unit_quantity||1),0)||0
    return (
      <div>
        <PanelHeader agentKey="export" title="Export" subtitle="Download the Excel cabinet schedule in Blake's workbook format — Master Summary + per-unit tabs + Hardware tab."
          action={<SaveBadge agentKey="export"/>}
        />
        <div style={dcard}>
          {/* Summary */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
            {[
              ['Total Cabinets', grandTotal.toLocaleString(), '#8b5cf6'],
              ['Unit Types',     editData?.unit_types?.length||0, '#0d9488'],
              ['CT Material SF', ctMaterialSF.toFixed(1)+' SF', '#d97706'],
              ['Sink Cutouts',   ctTotals.sinks, '#6366f1'],
            ].map(([label,val,color])=>(
              <div key={label} style={{ background:'#1a1a2e', border:`0.5px solid ${BORDER}`, borderRadius:8, padding:'14px 12px', textAlign:'center' }}>
                <div style={{ fontSize:9, color:MUTED, textTransform:'uppercase', letterSpacing:0.5, marginBottom:4 }}>{label}</div>
                <div style={{ fontSize:20, fontWeight:700, color }}>{val}</div>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <button onClick={runExport} disabled={exporting||!editData} style={{ padding:'12px 20px', fontSize:14, fontWeight:600, background:exporting||!editData?'#252545':'#16a34a', color:exporting||!editData?MUTED:TEXT, border:'none', borderRadius:8, cursor:exporting||!editData?'not-allowed':'pointer', transition:'opacity 0.15s' }}>
              {exporting?'⏳ Generating Excel...':'⬇ Download Cabinet Schedule (Excel)'}
            </button>
            {!editData && <div style={{ fontSize:11, color:'#d97706', textAlign:'center' }}>Complete the Elevation Engine step first to enable export</div>}
          </div>
        </div>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', background:BG, color:TEXT, fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', minHeight:'100vh' }}>
      <Sidebar/>
      <div style={{ flex:1, display:'flex', flexDirection:'column', minHeight:'100vh' }}>
      <PipelineBar/>
      <div style={{ flex:1, overflowY:'auto', padding:28, maxWidth:900 }}>
        {activeAgent==='upload'     && <UploadPanel/>}
        {activeAgent==='classify'   && <ClassifyPanel/>}
        {activeAgent==='matrix'     && <MatrixPanel/>}
        {activeAgent==='elevation'  && <ElevationPanel/>}
        {activeAgent==='countertop' && <CountertopPanel/>}
        {activeAgent==='export'     && <ExportPanel/>}
      </div>
      </div>
    </div>
  )
}
