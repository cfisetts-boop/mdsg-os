'use client'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { storageKey: 'mdsg-countertop-calc', persistSession: false } }
)

const inp = { padding: '6px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }
const lbl = { fontSize: 10, color: '#888', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }
const card = { background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, padding: 20, marginBottom: 16 }

const KITCHEN_DEPTH = 25.5  // standard kitchen counter depth in inches
const VANITY_DEPTH  = 22.5  // standard bathroom vanity depth in inches
const SPLASH_HEIGHT = 4     // standard backsplash return height in inches

function sfFromRun(lf, depthIn) { return ((lf || 0) * (depthIn || 0)) / 12 }

// Format decimal feet as X'-Y" (e.g. 17.0 → 17'-0", 12.25 → 12'-3", 4.75 → 4'-9")
function fmtLF(decFt) {
  if (decFt === null || decFt === undefined || isNaN(decFt)) return '—'
  const totalIn = Math.round(decFt * 12)
  const ft = Math.floor(totalIn / 12)
  const inches = totalIn % 12
  return inches === 0 ? `${ft}'-0"` : `${ft}'-${inches}"`
}

// Format SF to 1 decimal
function fmtSF(sf) {
  if (!sf || isNaN(sf)) return '—'
  return `${sf.toFixed(1)} SF`
}

function unitTotals(ut) {
  const kRuns    = ut.kitchen?.runs          || []
  const vRuns    = ut.vanity?.runs           || []
  const splashes = ut.kitchen?.side_splashes || []
  const kitchenSF    = kRuns.reduce((s, r) => s + sfFromRun(r.lf, r.depth_in || KITCHEN_DEPTH), 0)
  const vanitySF     = vRuns.reduce((s, r) => s + sfFromRun(r.lf, r.depth_in || VANITY_DEPTH), 0)
  const kitchenLF    = kRuns.reduce((s, r) => s + (r.lf || 0), 0)
  const vanityLF     = vRuns.reduce((s, r) => s + (r.lf || 0), 0)
  const autoBackLF   = kitchenLF
  const backsplashLF = ut.kitchen?.backsplash_lf || autoBackLF
  const sidesSF      = splashes.reduce((s, sp) => s + sfFromRun(sp.height_in || SPLASH_HEIGHT, sp.depth_in || KITCHEN_DEPTH), 0)
  const sidesLF      = splashes.reduce((s, sp) => s + (sp.depth_in || KITCHEN_DEPTH) / 12, 0)
  const sinkCutouts  = [...kRuns, ...vRuns].filter(r => r.has_sink).length
  return { kitchenSF, vanitySF, kitchenLF, vanityLF, backsplashLF, sidesSF, sidesLF, sinkCutouts, autoBackLF }
}

function projectTotals(uts) {
  let kSF = 0, vSF = 0, kLF = 0, vLF = 0, backLF = 0, sideSF = 0, sidesLF = 0, cuts = 0
  uts.forEach(ut => {
    const qty = ut.unit_quantity || 1
    const t = unitTotals(ut)
    kSF     += t.kitchenSF    * qty
    vSF     += t.vanitySF     * qty
    kLF     += t.kitchenLF    * qty
    vLF     += t.vanityLF     * qty
    backLF  += t.backsplashLF * qty
    sideSF  += t.sidesSF      * qty
    sidesLF += t.sidesLF      * qty
    cuts    += t.sinkCutouts  * qty
  })
  const materialSF = kSF + vSF + sideSF
  const totalLF    = kLF + vLF
  return { kSF, vSF, kLF, vLF, backLF, sideSF, sidesLF, cuts, materialSF, totalLF }
}

export default function CountertopCalc({ jobs }) {
  const [stage,         setStage]         = useState(1)
  const [selectedJobId, setSelectedJobId] = useState('')
  const [files,         setFiles]         = useState([])
  const [extracting,    setExtracting]    = useState(false)
  const [unitTypes,     setUnitTypes]     = useState([])
  const [expanded,      setExpanded]      = useState(null)
  const [wastePct,      setWastePct]      = useState(10)
  const [generating,    setGenerating]    = useState(false)
  const [showMatrix,    setShowMatrix]    = useState(false)
  const [savingToJob,    setSavingToJob]    = useState(false)
  const [ctMatrix,         setCtMatrix]         = useState([])
  const [ctMatrixDone,     setCtMatrixDone]     = useState(false)
  const [ctMatrixReading,  setCtMatrixReading]  = useState(false)
  const [flaggedTypes,     setFlaggedTypes]     = useState([])
  const [elevUploadFor,    setElevUploadFor]    = useState({})
  const [unitUploads,      setUnitUploads]      = useState({})
  const [manualInputs,     setManualInputs]     = useState({})  // {typeName: {kLF:'', vLF:'', sinks:''}}
  const [ctLabels,       setCtLabels]       = useState('')
  const [elevationScale, setElevationScale] = useState('1/2" = 1\'-0"')  // kitchen/bath elevation sheets
  const [planScale,      setPlanScale]      = useState('1/4" = 1\'-0"')  // floor plan top-down sheets
  const [propConfig,    setPropConfig]    = useState({
    material_type: 'Quartz', fabricator: 'CAPO',
    color: '', thickness: '3CM', edge: 'Eased Edge',
  })

  // ── helpers ──────────────────────────────────────────────────────────────
  function mutate(fn) { setUnitTypes(p => { const u = JSON.parse(JSON.stringify(p)); fn(u); return u }) }

  function ensureSection(u, ui, section) {
    if (!u[ui][section]) u[ui][section] = { runs: [], backsplash_lf: 0, side_splashes: [] }
  }

  function addRun(ui, section) {
    mutate(u => {
      ensureSection(u, ui, section)
      u[ui][section].runs.push({ label: section === 'kitchen' ? 'Counter run' : 'Vanity', lf: 0, depth_in: section === 'kitchen' ? KITCHEN_DEPTH : VANITY_DEPTH, has_sink: false })
    })
  }

  function setRun(ui, section, ri, field, value) {
    mutate(u => { u[ui][section].runs[ri][field] = value })
  }

  function removeRun(ui, section, ri) {
    mutate(u => { u[ui][section].runs.splice(ri, 1) })
  }

  function addSplash(ui) {
    mutate(u => {
      ensureSection(u, ui, 'kitchen')
      u[ui].kitchen.side_splashes.push({ label: 'Side splash', depth_in: KITCHEN_DEPTH, height_in: SPLASH_HEIGHT })
    })
  }

  function setSplash(ui, si, field, value) {
    mutate(u => { u[ui].kitchen.side_splashes[si][field] = value })
  }

  function removeSplash(ui, si) {
    mutate(u => { u[ui].kitchen.side_splashes.splice(si, 1) })
  }

  function setUnitField(ui, field, value) {
    mutate(u => { u[ui][field] = value })
  }

  function setSectionField(ui, section, field, value) {
    mutate(u => { ensureSection(u, ui, section); u[ui][section][field] = value })
  }

  // ── Extract matrix from uploaded file (PDF or image) ─────────────────────
  async function readMatrixFromFile(fileList) {
    const files = Array.from(fileList)
    if (!files.length) return
    setCtMatrixReading(true)
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const res    = await fetch('/api/takeoff/ct-matrix', { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) })
      const result = await res.json()
      if (result.success && result.units?.length) {
        setCtMatrix(result.units)
      } else {
        alert('Could not extract unit types: ' + (result.error || 'No unit types found. Try a clearer image or different pages.'))
      }
    } catch (err) {
      alert('Error: ' + err.message)
    }
    setCtMatrixReading(false)
  }

  // ── AI extraction ─────────────────────────────────────────────────────────
  async function runExtraction() {
    if (!files.length) return alert('Upload shop drawings or floor plans first')
    setExtracting(true)
    const fd = new FormData()
    if (selectedJobId) fd.append('jobId', selectedJobId)
    if (ctLabels.trim())       fd.append('ctLabels', ctLabels.trim())
    if (elevationScale.trim()) fd.append('elevationScale', elevationScale.trim())
    if (planScale.trim())      fd.append('planScale', planScale.trim())
    if (ctMatrix.length)       fd.append('unitMatrix', JSON.stringify(ctMatrix))
    files.forEach(f => fd.append('files', f))
    try {
      const res    = await fetch('/api/takeoff/countertops', { method: 'POST', body: fd, signal: AbortSignal.timeout(300000) })
      const result = await res.json()
      if (result.success) {
        setUnitTypes(result.unit_types)
        setFlaggedTypes(result.flagged_unit_types || [])
        setStage(2)
      }
      else alert('Extraction failed: ' + (result.error || 'Unknown error'))
    } catch (err) { alert('Error: ' + err.message) }
    setExtracting(false)
  }

  function startManual() {
    setUnitTypes([{ unit_type_name: 'Unit Type 1', unit_quantity: 1,
      kitchen: { runs: [], backsplash_lf: 0, side_splashes: [] },
      vanity:  { runs: [] } }])
    setStage(2)
  }

  // ── Extract elevations for a single flagged unit type ────────────────────
  async function extractElevationsForType(typeName, files) {
    if (!files?.length) return
    setElevUploadFor(p => ({ ...p, [typeName]: 'uploading' }))
    try {
      const matrixEntry = ctMatrix.find(u => u.name === typeName)
      const qty = matrixEntry?.quantity || 1

      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('files', f))
      fd.append('typeName', typeName)

      const res    = await fetch('/api/takeoff/measure-elevation', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) })
      const result = await res.json()

      if (!result.success) {
        setElevUploadFor(p => ({ ...p, [typeName]: 'error' }))
        alert(`Could not extract measurements for ${typeName}:\n${result.error || 'No dimensions found.'}`)
        return
      }

      const extracted = {
        unit_type_name: typeName,
        unit_quantity:  qty,
        kitchen: {
          runs: result.kitchen_lf ? [{ label:'Kitchen counter', lf:result.kitchen_lf, depth_in:25.5, has_sink:result.sink_cutouts>0, backsplash_lf:result.kitchen_lf, sf:result.kitchen_sf }] : [],
          backsplash_lf: result.kitchen_lf || 0, side_splashes: [],
        },
        vanity: {
          runs: result.vanity_lf ? [{ label:'Bathroom vanity', lf:result.vanity_lf, depth_in:22.5, has_sink:true, backsplash_lf:result.vanity_lf, sf:result.vanity_sf }] : [],
        },
      }

      // Add to unitTypes (or replace if already exists as a blank flagged entry)
      mutate(u => {
        const existing = u.findIndex(x => x.unit_type_name === typeName)
        if (existing >= 0) {
          u[existing] = { ...extracted }
        } else {
          u.push({ ...extracted })
        }
      })

      setFlaggedTypes(p => p.filter(n => n !== typeName))
      setElevUploadFor(p => ({ ...p, [typeName]: 'done' }))
      setExpanded(unitTypes.length)  // open the new/updated card
    } catch (err) {
      setElevUploadFor(p => ({ ...p, [typeName]: 'error' }))
      alert(`Upload error for ${typeName}: ${err.message}`)
    }
  }

  // ── Apply manual LF inputs to unitUploads result ─────────────────────────────
  function applyManualInput(typeName, field, rawValue) {
    const qty   = ctMatrix.find(u => u.name === typeName)?.quantity || 1
    const value = rawValue === '' ? '' : rawValue

    setManualInputs(p => {
      const cur   = { kLF: '', vLF: '', sinks: '1', ...(p[typeName] || {}) }
      const next  = { ...cur, [field]: value }

      const kLF   = parseFloat(next.kLF) || 0
      const vLF   = parseFloat(next.vLF) || 0
      const sinks = parseInt(next.sinks) || 0

      if (!kLF && !vLF) {
        // Both empty — remove result so card shows pending
        setUnitUploads(prev => ({ ...prev, [typeName]: { ...prev[typeName], status: 'pending', result: null } }))
        return { ...p, [typeName]: next }
      }

      const result = {
        unit_type_name: typeName,
        unit_quantity:  qty,
        kitchen: {
          runs: kLF > 0 ? [{ label: 'Kitchen counter (manual)', lf: kLF, depth_in: 25.5, has_sink: sinks > 0, backsplash_lf: kLF, sf: +(kLF * 2.125).toFixed(2), _manual: true }] : [],
          backsplash_lf: kLF,
          side_splashes: [],
        },
        vanity: {
          runs: vLF > 0 ? [{ label: 'Bathroom vanity (manual)', lf: vLF, depth_in: 22.5, has_sink: true, backsplash_lf: vLF, sf: +(vLF * 1.875).toFixed(2), _manual: true }] : [],
        },
      }

      setUnitUploads(prev => ({ ...prev, [typeName]: { ...prev[typeName], status: 'done', result } }))
      return { ...p, [typeName]: next }
    })
  }

  // ── Clear kitchen or vanity runs for a unit type ─────────────────────────────
  function clearSurface(typeName, surface) {
    const qty = ctMatrix.find(u => u.name === typeName)?.quantity || 1
    setUnitUploads(prev => {
      const cur = prev[typeName]?.result
      if (!cur) return prev
      const newKitchen = surface === 'kitchen'
        ? { runs: [], backsplash_lf: 0, side_splashes: [] }
        : cur.kitchen
      const newVanity = surface === 'vanity'
        ? { runs: [] }
        : cur.vanity
      const stillHasData = (newKitchen?.runs?.length || 0) + (newVanity?.runs?.length || 0) > 0
      return {
        ...prev,
        [typeName]: {
          ...prev[typeName],
          status: stillHasData ? 'done' : 'pending',
          result: stillHasData ? { ...cur, kitchen: newKitchen, vanity: newVanity } : null,
        },
      }
    })
  }

  // ── Upload elevation sheets for one unit type (Stage 1 per-unit flow) ───────
  async function uploadForUnit(typeName, files, wallType = '') {
    if (!files?.length) return
    const matrixEntry = ctMatrix.find(u => u.name === typeName)
    const qty = matrixEntry?.quantity || 1
    const wallHint = wallType || ''
    const fileList = Array.from(files)

    setUnitUploads(p => ({ ...p, [typeName]: { ...p[typeName], status: 'uploading', error: '' } }))

    try {
      // ── Step 1: fetch all results first (no state updates yet) ──────────
      const apiResults = []
      for (const file of fileList) {
        const fd = new FormData()
        fd.append('files', file)
        fd.append('typeName', typeName)
        if (wallHint) fd.append('wallHint', wallHint)

        const res = await fetch('/api/takeoff/measure-elevation', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) })
        const result = await res.json()

        if (!result.success) {
          console.log(`measure-elevation error for ${typeName} / ${file.name}:`, result.error)
        } else {
          apiResults.push({ ...result, fileName: file.name })
        }
      }

      if (!apiResults.length) {
        setUnitUploads(p => ({ ...p, [typeName]: { ...p[typeName], status: 'error', error: 'No measurements extracted from any file' } }))
        return
      }

      // ── Step 2: merge all results into one state update ─────────────────
      // ONE setState call — no stale-state accumulation bug
      setUnitUploads(prev => {
        const cur = prev[typeName]?.result
        let kitchenRuns = [...(cur?.kitchen?.runs || [])]
        let vanityRuns  = [...(cur?.vanity?.runs  || [])]

        for (const result of apiResults) {
          const est = result.has_estimates ? ' ⚑ est.' : ''
          if (result.kitchen_lf) {
            kitchenRuns.push({
              label: `Kitchen wall ${kitchenRuns.length + 1}${est}`,
              lf: result.kitchen_lf, depth_in: 25.5,
              has_sink: result.sink_cutouts > 0,
              backsplash_lf: result.kitchen_lf, sf: result.kitchen_sf,
              _estimated: !!result.has_estimates,
              _fileName: result.fileName || '',
            })
          }
          if (result.vanity_lf) {
            vanityRuns.push({
              label: `Vanity ${vanityRuns.length + 1}${est}`,
              lf: result.vanity_lf, depth_in: 22.5, has_sink: true,
              backsplash_lf: result.vanity_lf, sf: result.vanity_sf,
              _estimated: !!result.has_estimates,
              _fileName: result.fileName || '',
            })
          }
        }

        const totalKLF = kitchenRuns.reduce((s, r) => s + (r.lf||0), 0)
        const extracted = {
          unit_type_name: typeName,
          unit_quantity:  qty,
          kitchen: { runs: kitchenRuns, backsplash_lf: totalKLF, side_splashes: [] },
          vanity:  { runs: vanityRuns },
        }
        // Sync AI results back into manual input fields so user can see and edit them
        const newKLF = kitchenRuns.reduce((s, r) => s + (r.lf||0), 0)
        const newVLF = vanityRuns.reduce((s, r) => s + (r.lf||0), 0)
        const newSinks = kitchenRuns.some(r => r.has_sink) || vanityRuns.length > 0 ? 1 : 0
        setManualInputs(p => ({
          ...p,
          [typeName]: {
            kLF:   newKLF  > 0 ? newKLF.toFixed(2)  : (p[typeName]?.kLF  || ''),
            vLF:   newVLF  > 0 ? newVLF.toFixed(2)  : (p[typeName]?.vLF  || ''),
            sinks: String(newSinks || p[typeName]?.sinks || '1'),
          },
        }))

        return { ...prev, [typeName]: { ...prev[typeName], status: 'done', result: extracted } }
      })

    } catch (err) {
      setUnitUploads(p => ({ ...p, [typeName]: { ...p[typeName], status: 'error', error: err.message } }))
    }
  }

  // Proceed from per-unit uploads to Stage 2 review
  function proceedToReview() {
    const done    = Object.entries(unitUploads).filter(([, v]) => v.status === 'done').map(([, v]) => v.result)
    const missing = ctMatrix.filter(u => !unitUploads[u.name] || unitUploads[u.name].status !== 'done').map(u => u.name)
    mutate(u => { u.length = 0; done.forEach(r => u.push(r)) })
    setFlaggedTypes(missing)
    setStage(2)
  }

  // ── Save takeoff to job ───────────────────────────────────────────────────
  async function saveToJob() {
    if (!selectedJobId) return alert('Select a job at the top first')
    setSavingToJob(true)
    const t = totals
    const payload = {
      kSF:       t.kSF,
      vSF:       t.vSF,
      kLF:       t.kLF,
      vLF:       t.vLF,
      backLF:    t.backLF,
      sideSF:    t.sideSF,
      sidesLF:   t.sidesLF,
      cuts:      t.cuts,
      materialSF: t.materialSF,
      totalLF:   t.totalLF,
      unitTypes,
      savedAt:   new Date().toISOString(),
    }
    await supabase.from('activity_log').insert({
      job_id:    selectedJobId,
      user_name: 'Cole',
      action:    '__CT_TAKEOFF__:' + JSON.stringify(payload),
    })
    setSavingToJob(false)
    alert(`✓ Countertop takeoff saved — ${t.materialSF.toFixed(1)} SF · ${t.totalLF.toFixed(1)} LF · ${t.cuts} cutouts`)
  }

  // ── Proposal PDF ──────────────────────────────────────────────────────────
  async function generateProposal() {
    setGenerating(true)
    try {
      const totals = projectTotals(unitTypes)
      const job    = jobs.find(j => j.id === selectedJobId)
      const res = await fetch('/api/generate-countertop-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJobId, unitTypes, totals, wastePct, propConfig }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed') }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = `MDSG-Countertop-${(job?.name || 'Project').replace(/[^a-z0-9]/gi, '-')}.pdf`
      a.click(); URL.revokeObjectURL(url)
    } catch (err) { alert('Error: ' + err.message) }
    setGenerating(false)
  }

  const totals       = projectTotals(unitTypes)
  const withWaste    = totals.materialSF * (1 + wastePct / 100)

  // ── STAGE 1: Upload ───────────────────────────────────────────────────────
  if (stage === 1) return (
    <div style={{ maxWidth: 660, margin: '0 auto' }}>

      {/* ── STEP 0: UNIT MATRIX ── */}
      <div style={{ ...card, border: ctMatrixDone ? '1.5px solid #2D7A3A' : '0.5px solid #e5e5e0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            <span style={{ background: ctMatrixDone ? '#2D7A3A' : '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>1</span>
            Unit Matrix
            <span style={{ fontSize: 11, color: '#888', fontWeight: 400, marginLeft: 6 }}>— enter unit types so Claude knows what to look for</span>
          </div>
          {ctMatrixDone && (
            <span style={{ fontSize: 11, color: '#2D7A3A', fontWeight: 600 }}>
              ✓ {ctMatrix.length} types · {ctMatrix.reduce((s,u)=>s+(u.quantity||0),0)} total units
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
          List every unit type and how many of each exist in the building. Claude will search each elevation for these types and flag any it cannot find.
        </div>

        {!ctMatrixDone ? (
          <>
            {/* ── Upload to auto-fill ── */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', border: `1.5px dashed ${ctMatrixReading ? '#3C3489' : '#c5d0f0'}`, borderRadius: 8, padding: 12, textAlign: 'center', cursor: 'pointer', background: '#f5f7ff', position: 'relative' }}>
                <div style={{ fontSize: 12, color: '#3C3489', fontWeight: 500, marginBottom: 2 }}>
                  {ctMatrixReading ? '⏳ Reading unit types...' : '📋 Upload unit schedule — PDF or image snip'}
                </div>
                <div style={{ fontSize: 10, color: '#888' }}>
                  Select one or more files · PDF, JPEG, PNG · upload each floor separately if needed
                </div>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  multiple
                  disabled={ctMatrixReading}
                  style={{ display: 'none' }}
                  onChange={e => { if (e.target.files.length) readMatrixFromFile(e.target.files); e.target.value = '' }}
                />
              </label>
              {ctMatrix.length > 0 && (
                <div style={{ fontSize: 10, color: '#2D7A3A', marginTop: 4, textAlign: 'center' }}>
                  ✓ {ctMatrix.length} unit types · {ctMatrix.reduce((s,u)=>s+(u.quantity||0),0)} total units — review and edit below
                </div>
              )}
            </div>

            <div style={{ background: '#f9f9f9', border: '0.5px solid #ddd', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 28px', padding: '6px 10px', background: '#eee', fontSize: 10, fontWeight: 600, color: '#555', gap: 8 }}>
                <span>UNIT TYPE NAME</span><span style={{ textAlign: 'center' }}>QTY</span><span />
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                {ctMatrix.map((row, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 28px', padding: '4px 10px', borderBottom: '0.5px solid #eee', alignItems: 'center', gap: 8 }}>
                    <input value={row.name} onChange={e => setCtMatrix(p => p.map((r,j) => j===i ? {...r, name: e.target.value} : r))}
                      placeholder="e.g. 1BR 1 or STU 3"
                      style={{ ...inp, padding: '3px 8px', fontSize: 12 }} />
                    <input type="number" min="0" value={row.quantity}
                      onChange={e => setCtMatrix(p => p.map((r,j) => j===i ? {...r, quantity: parseInt(e.target.value)||0} : r))}
                      style={{ ...inp, padding: '3px 8px', fontSize: 12, textAlign: 'center' }} />
                    <button onClick={() => setCtMatrix(p => p.filter((_,j) => j!==i))}
                      style={{ background: '#fee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, color: '#c00', padding: '2px 4px' }}>✕</button>
                  </div>
                ))}
                {ctMatrix.length === 0 && (
                  <div style={{ padding: '12px 10px', color: '#aaa', fontSize: 11 }}>
                    No unit types yet — upload a schedule above or click Add Row
                  </div>
                )}
              </div>
              <div style={{ padding: '6px 10px', borderTop: '0.5px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button onClick={() => setCtMatrix(p => [...p, { name: '', quantity: 1 }])}
                  style={{ fontSize: 11, padding: '3px 12px', background: '#f0f4ff', border: '0.5px solid #3C3489', borderRadius: 6, cursor: 'pointer', color: '#3C3489' }}>+ Add Row</button>
                {ctMatrix.length > 0 && (
                  <span style={{ fontSize: 11, color: '#555', fontWeight: 600 }}>
                    {ctMatrix.reduce((s,u)=>s+(u.quantity||0),0)} total units
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {ctMatrix.filter(r => r.name.trim()).length > 0 && (
                <button onClick={() => setCtMatrixDone(true)}
                  style={{ flex: 1, padding: 9, background: '#2D7A3A', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  ✓ Confirm Unit Matrix
                </button>
              )}
              <button onClick={() => { setCtMatrix([]); setCtMatrixDone(true) }}
                style={{ padding: '9px 16px', background: '#f5f5f3', color: '#888', border: '0.5px solid #ccc', borderRadius: 8, cursor: 'pointer', fontSize: 12 }}>
                Skip — extract without matrix
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ctMatrix.length > 0
                ? ctMatrix.map((u,i) => (
                    <span key={i} style={{ fontSize: 10, background: '#e8f5e9', color: '#2D7A3A', padding: '2px 10px', borderRadius: 10, fontWeight: 500 }}>
                      {u.name}: {u.quantity}
                    </span>
                  ))
                : <span style={{ fontSize: 11, color: '#888' }}>No matrix — Claude will discover unit types from drawings</span>
              }
            </div>
            <button onClick={() => setCtMatrixDone(false)} style={{ fontSize: 10, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Edit</button>
          </div>
        )}
      </div>

      {/* ── STEP 2: DRAWING SETTINGS (scale + labels) ── */}
      <div style={{ ...card, opacity: !ctMatrixDone ? 0.45 : 1, pointerEvents: !ctMatrixDone ? 'none' : 'auto' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
          <span style={{ background: '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>2</span>
          Drawing Settings
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Elevation Scale</label>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
              {['1/2" = 1\'-0"', '3/8" = 1\'-0"', '1/4" = 1\'-0"'].map(s => (
                <button key={s} onClick={() => setElevationScale(s)}
                  style={{ padding: '2px 7px', fontSize: 9, borderRadius: 6, cursor: 'pointer', border: '0.5px solid #ccc', background: elevationScale===s?'#3C3489':'#fff', color: elevationScale===s?'#fff':'#555', fontWeight: elevationScale===s?600:400 }}>{s}</button>
              ))}
            </div>
            <input value={elevationScale} onChange={e => setElevationScale(e.target.value)} style={{ width:'100%', ...inp, fontSize:11 }} />
          </div>
          <div>
            <label style={lbl}>Plan Scale</label>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
              {['1/4" = 1\'-0"', '1/8" = 1\'-0"', '3/16" = 1\'-0"'].map(s => (
                <button key={s} onClick={() => setPlanScale(s)}
                  style={{ padding: '2px 7px', fontSize: 9, borderRadius: 6, cursor: 'pointer', border: '0.5px solid #ccc', background: planScale===s?'#2D7A3A':'#fff', color: planScale===s?'#fff':'#555', fontWeight: planScale===s?600:400 }}>{s}</button>
              ))}
            </div>
            <input value={planScale} onChange={e => setPlanScale(e.target.value)} style={{ width:'100%', ...inp, fontSize:11 }} />
          </div>
          <div>
            <label style={lbl}>Countertop Labels</label>
            <input value={ctLabels} onChange={e => setCtLabels(e.target.value)} placeholder="QT01, CT, STONE, QUARTZ" style={{ width:'100%', ...inp, fontSize:11 }} />
            <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:5 }}>
              {['QT01','CT','STONE','QUARTZ','GRANITE','LAM'].map(l => (
                <button key={l} onClick={() => setCtLabels(p => p?(p.includes(l)?p:p+', '+l):l)}
                  style={{ padding:'1px 6px', fontSize:9, borderRadius:10, cursor:'pointer', border:'0.5px solid #ccc', background: ctLabels.includes(l)?'#e8f5e9':'#f5f5f3', color: ctLabels.includes(l)?'#2D7A3A':'#555' }}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8, marginBottom:4 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <label style={{...lbl, marginBottom:0}}>Job</label>
            <select value={selectedJobId} onChange={e => setSelectedJobId(e.target.value)} style={{ ...inp, fontSize:11, minWidth:160 }}>
              <option value="">— Link to job (optional) —</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── STEP 3: UPLOAD ELEVATIONS PER UNIT TYPE ── */}
      {ctMatrixDone && ctMatrix.length > 0 && (
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            <span style={{ background: '#3C3489', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>3</span>
            Upload Elevations Per Unit Type
          </div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 14 }}>
            Each unit type has a separate kitchen row and vanity row. Upload elevations into the correct row — no cross-contamination possible.
          </div>

          {/* Unit type upload cards — two rows each */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            {ctMatrix.map((u, i) => {
              const up = unitUploads[u.name] || { status: 'pending' }
              const kRuns = up.result?.kitchen?.runs || []
              const vRuns = up.result?.vanity?.runs  || []
              const kLF   = kRuns.reduce((s, r) => s + (Number(r.lf)||0), 0)
              const vLF   = vRuns.reduce((s, r) => s + (Number(r.lf)||0), 0)
              const hasAny = kRuns.length > 0 || vRuns.length > 0

              return (
                <div key={i} style={{ border: `1px solid ${hasAny ? '#2D7A3A' : '#e5e5e0'}`, borderRadius: 10, overflow: 'hidden' }}>
                  {/* Unit header + PRIMARY manual entry */}
                  {(() => {
                    const mi = manualInputs[u.name] || { kLF: '', vLF: '', sinks: '1' }
                    const kSF = parseFloat(mi.kLF) > 0 ? (parseFloat(mi.kLF) * 2.125).toFixed(2) : '—'
                    const vSF = parseFloat(mi.vLF) > 0 ? (parseFloat(mi.vLF) * 1.875).toFixed(2) : '—'
                    return (
                      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid #e5e5e0' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div>
                            <span style={{ fontWeight: 700, fontSize: 13 }}>{u.name}</span>
                            <span style={{ fontSize: 10, color: '#888', marginLeft: 8 }}>{u.quantity} unit{u.quantity !== 1 ? 's' : ''}</span>
                          </div>
                          {up.status === 'uploading' && <span style={{ fontSize: 10, color: '#3C3489' }}>⏳ Extracting…</span>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px', gap: 10 }}>
                          {/* Kitchen LF */}
                          <div>
                            <label style={{ fontSize: 9, color: '#3C3489', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 3 }}>Kitchen LF</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <input
                                type="number" step="0.01" min="0"
                                value={mi.kLF}
                                onChange={e => applyManualInput(u.name, 'kLF', e.target.value)}
                                placeholder="e.g. 7.75"
                                style={{ ...inp, flex: 1, fontSize: 14, fontWeight: 600, color: '#3C3489', borderColor: mi.kLF ? '#3C3489' : '#ccc' }}
                              />
                            </div>
                            <div style={{ fontSize: 9, color: '#888', marginTop: 2 }}>
                              SF: <strong style={{ color: '#3C3489' }}>{kSF}</strong>{mi.kLF ? ` (${parseFloat(mi.kLF).toFixed(2)} × 2.125)` : ''}
                            </div>
                          </div>
                          {/* Vanity LF */}
                          <div>
                            <label style={{ fontSize: 9, color: '#0C447C', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 3 }}>Vanity LF</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <input
                                type="number" step="0.01" min="0"
                                value={mi.vLF}
                                onChange={e => applyManualInput(u.name, 'vLF', e.target.value)}
                                placeholder="e.g. 4.67"
                                style={{ ...inp, flex: 1, fontSize: 14, fontWeight: 600, color: '#0C447C', borderColor: mi.vLF ? '#0C447C' : '#ccc' }}
                              />
                            </div>
                            <div style={{ fontSize: 9, color: '#888', marginTop: 2 }}>
                              SF: <strong style={{ color: '#0C447C' }}>{vSF}</strong>{mi.vLF ? ` (${parseFloat(mi.vLF).toFixed(2)} × 1.875)` : ''}
                            </div>
                          </div>
                          {/* Sinks */}
                          <div>
                            <label style={{ fontSize: 9, color: '#555', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 3 }}>Sinks</label>
                            <input
                              type="number" step="1" min="0" max="9"
                              value={mi.sinks}
                              onChange={e => applyManualInput(u.name, 'sinks', e.target.value)}
                              style={{ ...inp, width: '100%', fontSize: 14, fontWeight: 600 }}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })()}

                  {/* Kitchen row */}
                  <div style={{ padding: '10px 14px', borderBottom: '0.5px solid #f0f0ec' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: kRuns.length > 0 ? 6 : 0 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: kRuns.length > 0 ? '#3C3489' : '#ddd', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#3C3489', flex: 1 }}>
                        Kitchen Elevations {kRuns.length > 0 && <span style={{ fontWeight: 400, color: '#888' }}>({kRuns.length} file{kRuns.length!==1?'s':''})</span>}
                      </span>
                      {kRuns.length > 0 && (
                        <button onClick={() => clearSurface(u.name, 'kitchen')}
                          style={{ fontSize: 9, padding: '2px 7px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
                          ✕ Clear
                        </button>
                      )}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 10px', fontSize: 10, background: '#3C3489', color: '#fff', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        + Add Kitchen Wall
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple style={{ display: 'none' }}
                          onChange={e => { if (e.target.files?.length) { uploadForUnit(u.name, e.target.files, 'kitchen elevation'); e.target.value='' } }} />
                      </label>
                    </div>
                    {kRuns.length > 0 ? (
                      <div style={{ background: '#f5f5ff', border: '0.5px solid #dde', borderRadius: 6, padding: '6px 10px' }}>
                        {kRuns.map((r, ri) => (
                          <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0', borderBottom: ri < kRuns.length-1 ? '0.5px solid #eee' : 'none' }}>
                            <span style={{ color: '#555' }}>
                              📄 {r._fileName || `Wall ${ri+1}`}{r._estimated ? ' ⚑' : ''}
                            </span>
                            <strong style={{ color: '#3C3489' }}>{fmtLF(r.lf)}</strong>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 4, paddingTop: 4, borderTop: '1px solid #dde' }}>
                          <span style={{ color: '#888' }}>Total kitchen LF</span>
                          <strong style={{ color: '#3C3489' }}>{fmtLF(kLF)}</strong>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: '#aaa', paddingLeft: 18 }}>No kitchen elevations uploaded yet</div>
                    )}
                  </div>

                  {/* Vanity row */}
                  <div style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: vRuns.length > 0 ? 6 : 0 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: vRuns.length > 0 ? '#0C447C' : '#ddd', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#0C447C', flex: 1 }}>
                        Vanity Elevations {vRuns.length > 0 && <span style={{ fontWeight: 400, color: '#888' }}>({vRuns.length} file{vRuns.length!==1?'s':''})</span>}
                      </span>
                      {vRuns.length > 0 && (
                        <button onClick={() => clearSurface(u.name, 'vanity')}
                          style={{ fontSize: 9, padding: '2px 7px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
                          ✕ Clear
                        </button>
                      )}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 10px', fontSize: 10, background: '#0C447C', color: '#fff', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        + Add Vanity
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple style={{ display: 'none' }}
                          onChange={e => { if (e.target.files?.length) { uploadForUnit(u.name, e.target.files, 'bathroom vanity'); e.target.value='' } }} />
                      </label>
                    </div>
                    {vRuns.length > 0 ? (
                      <div style={{ background: '#f0f4ff', border: '0.5px solid #b8caee', borderRadius: 6, padding: '6px 10px' }}>
                        {vRuns.map((r, ri) => (
                          <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0', borderBottom: ri < vRuns.length-1 ? '0.5px solid #dde' : 'none' }}>
                            <span style={{ color: '#555' }}>
                              📄 {r._fileName || `Vanity ${ri+1}`}{r._estimated ? ' ⚑' : ''}
                            </span>
                            <strong style={{ color: '#0C447C' }}>{fmtLF(r.lf)}</strong>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 4, paddingTop: 4, borderTop: '1px solid #b8caee' }}>
                          <span style={{ color: '#888' }}>Total vanity LF</span>
                          <strong style={{ color: '#0C447C' }}>{fmtLF(vLF)}</strong>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: '#aaa', paddingLeft: 18 }}>No vanity elevations uploaded yet</div>
                    )}
                  </div>

                  {/* Error */}
                  {up.status === 'error' && up.error && (
                    <div style={{ padding: '6px 14px', background: '#fcebeb', fontSize: 10, color: '#A32D2D', borderTop: '0.5px solid #f5c5c5' }}>{up.error}</div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Progress summary + Proceed button */}
          {(() => {
            const doneCount    = ctMatrix.filter(u => {
              const mi = manualInputs[u.name] || {}
              return unitUploads[u.name]?.status === 'done' || parseFloat(mi.kLF) > 0 || parseFloat(mi.vLF) > 0
            }).length
            const pendingCount = ctMatrix.length - doneCount
            const allDone      = doneCount === ctMatrix.length
            return (
              <div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 10, textAlign: 'center' }}>
                  {doneCount} of {ctMatrix.length} unit types extracted
                  {pendingCount > 0 && ` · ${pendingCount} still needed`}
                </div>
                <button
                  onClick={proceedToReview}
                  disabled={doneCount === 0}
                  style={{ width: '100%', padding: 12, fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', cursor: doneCount > 0 ? 'pointer' : 'default',
                    background: allDone ? '#2D7A3A' : doneCount > 0 ? '#3C3489' : '#ccc',
                    color: doneCount > 0 ? '#fff' : '#888' }}>
                  {allDone ? '✓ All Done — Go to Review' : doneCount > 0 ? `→ Review ${doneCount} Unit Type${doneCount!==1?'s':''} (${pendingCount} pending)` : 'Upload at least one unit type to continue'}
                </button>
                <div style={{ textAlign: 'center', marginTop: 8, fontSize: 10, color: '#aaa' }}>
                  <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={startManual}>Skip — enter all measurements manually →</span>
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )

  // ── STAGE 2: Review & Edit ────────────────────────────────────────────────
  if (stage === 2) return (
    <div>
      {/* Header bar */}
      <div style={{ ...card }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: showMatrix ? 14 : 0 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Countertop Review & Edit</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              {unitTypes.length} unit type{unitTypes.length !== 1 ? 's' : ''} · {unitTypes.reduce((s, u) => s + (u.unit_quantity || 1), 0)} total units
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setStage(1)} style={{ padding: '6px 12px', fontSize: 11, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>← Re-upload</button>
            <button onClick={() => mutate(u => u.push({ unit_type_name: 'New Unit Type', unit_quantity: 1, kitchen: { runs: [], backsplash_lf: 0, side_splashes: [] }, vanity: { runs: [] } }))}
              style={{ padding: '6px 12px', fontSize: 11, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Unit Type</button>
            <button onClick={() => setShowMatrix(p => !p)}
              style={{ padding: '6px 12px', fontSize: 11, background: showMatrix ? '#3C3489' : '#f5f5f3', color: showMatrix ? '#fff' : '#333', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer', fontWeight: showMatrix ? 600 : 400 }}>
              {showMatrix ? '✕ Close Matrix' : '# Unit Counts'}
            </button>
            <button onClick={saveToJob} disabled={savingToJob || !selectedJobId}
              style={{ padding: '6px 14px', fontSize: 12, background: savingToJob ? '#888' : selectedJobId ? '#2D7A3A' : '#ccc', color: '#fff', border: 'none', borderRadius: 6, cursor: savingToJob || !selectedJobId ? 'default' : 'pointer', fontWeight: 500 }}>
              {savingToJob ? 'Saving...' : selectedJobId ? '✓ Save to Job' : 'Select job first'}
            </button>
            <button onClick={() => setStage(3)} style={{ padding: '6px 20px', fontSize: 12, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>
              → Generate Proposal
            </button>
          </div>
        </div>

        {/* ── UNIT MATRIX ── */}
        {showMatrix && (
          <div style={{ background: '#f5f7ff', border: '0.5px solid #3C3489', borderRadius: 8, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: '#3C3489', marginBottom: 4 }}>Unit Mix — Set Quantities</div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 10 }}>
              Enter the number of each unit type in the building. This multiplies all measurements to get project totals.
              Kitchen: {KITCHEN_DEPTH}" deep · Vanity: {VANITY_DEPTH}" deep · Laundry: {KITCHEN_DEPTH}" deep (edit per run if different)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 12 }}>
              {unitTypes.map((ut, ui) => {
                const t = unitTotals(ut)
                const qty = ut.unit_quantity || 1
                return (
                  <div key={ui} style={{ background: '#fff', border: '0.5px solid #dde', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{ut.unit_type_name}</div>
                      <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
                        Kitchen: {fmtLF(t.kitchenLF)} · {fmtSF(t.kitchenSF)}
                      </div>
                      <div style={{ fontSize: 10, color: '#888' }}>
                        Vanity: {fmtLF(t.vanityLF)} · {fmtSF(t.vanitySF)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <input
                        type="number" min="0"
                        value={ut.unit_quantity || ''}
                        onChange={e => mutate(u => { u[ui].unit_quantity = parseInt(e.target.value) || 0 })}
                        style={{ width: 64, padding: '4px 8px', border: '1px solid #3C3489', borderRadius: 6, fontSize: 14, fontWeight: 700, textAlign: 'center', color: '#3C3489' }}
                        placeholder="0"
                      />
                      <div style={{ fontSize: 9, color: '#aaa' }}>units</div>
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ background: '#EEF0FF', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#3C3489', display: 'flex', gap: 20 }}>
              <span>Total units: <strong>{unitTypes.reduce((s, u) => s + (u.unit_quantity || 0), 0)}</strong></span>
              <span>Kitchen SF: <strong>{(unitTypes.reduce((s,u) => { const t=unitTotals(u); return s+t.kitchenSF*(u.unit_quantity||1) },0)).toFixed(1)}</strong></span>
              <span>Vanity SF: <strong>{(unitTypes.reduce((s,u) => { const t=unitTotals(u); return s+t.vanitySF*(u.unit_quantity||1) },0)).toFixed(1)}</strong></span>
              <span>Total LF: <strong>{(unitTypes.reduce((s,u) => { const t=unitTotals(u); return s+(t.kitchenLF+t.vanityLF)*(u.unit_quantity||1) },0)).toFixed(1)}</strong></span>
            </div>
          </div>
        )}
      </div>

      {/* ── FLAGGED: unit types from matrix not found in drawings ── */}
      {flaggedTypes.length > 0 && (
        <div style={{ background: '#FFF8F0', border: '1px solid #EF9F27', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#633806', marginBottom: 4 }}>
            ⚑ {flaggedTypes.length} Unit Type{flaggedTypes.length > 1 ? 's' : ''} Not Found in Drawings
          </div>
          <div style={{ fontSize: 11, color: '#854F0B', marginBottom: 12 }}>
            For each type, upload its specific elevation sheet for automatic extraction — or enter measurements manually.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {flaggedTypes.map((name, i) => {
              const alreadyAdded = unitTypes.some(u => u.unit_type_name === name)
              const matrixEntry  = ctMatrix.find(u => u.name === name)
              const uploadState  = elevUploadFor[name] || 'idle'
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#fff', border: '0.5px solid #EF9F27', borderRadius: 8, padding: '8px 14px', flexWrap: 'wrap' }}>
                  {/* Name + unit count */}
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#633806' }}>{name}</span>
                    {matrixEntry && <span style={{ fontSize: 10, color: '#aaa', marginLeft: 6 }}>{matrixEntry.quantity} units</span>}
                  </div>

                  {alreadyAdded ? (
                    <span style={{ fontSize: 10, color: '#2D7A3A', fontWeight: 600 }}>✓ Extracted</span>
                  ) : uploadState === 'uploading' ? (
                    <span style={{ fontSize: 10, color: '#3C3489' }}>⏳ Extracting…</span>
                  ) : uploadState === 'error' ? (
                    <span style={{ fontSize: 10, color: '#A32D2D' }}>✕ Failed — try again</span>
                  ) : (
                    <>
                      {/* Upload elevations button */}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', fontSize: 10, background: '#3C3489', color: '#fff', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        ⬆ Upload Elevations
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,.webp"
                          multiple
                          style={{ display: 'none' }}
                          onChange={e => {
                            if (e.target.files?.length) {
                              extractElevationsForType(name, e.target.files)
                              e.target.value = ''
                            }
                          }}
                        />
                      </label>

                      {/* Manual entry button */}
                      <button
                        onClick={() => {
                          const qty = matrixEntry?.quantity || 1
                          mutate(u => u.push({
                            unit_type_name: name,
                            unit_quantity:  qty,
                            _flagged:       true,
                            kitchen: { runs: [], backsplash_lf: 0, side_splashes: [] },
                            vanity:  { runs: [] },
                          }))
                          setFlaggedTypes(p => p.filter(n => n !== name))
                          setExpanded(unitTypes.length)
                        }}
                        style={{ padding: '4px 12px', fontSize: 10, background: '#FFF0CC', color: '#7a5800', border: '0.5px solid #cc9900', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        ✏ Enter Manually
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Unit type cards */}
      {unitTypes.map((ut, ui) => {
        const t   = unitTotals(ut)
        const qty = ut.unit_quantity || 1
        const isExp = expanded === ui
        const verifyRuns = [...(ut.kitchen?.runs||[]),...(ut.vanity?.runs||[])].filter(r=>String(r.lf).toUpperCase()==='VERIFY')
        return (
          <div key={ui} style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
            <div onClick={() => setExpanded(isExp ? null : ui)}
              style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fafafa' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11 }}>{isExp ? '▼' : '▶'}</span>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {ut.unit_type_name}
                    {verifyRuns.length > 0 && (
                      <span style={{ fontSize: 9, background: '#FCEBEB', color: '#A32D2D', padding: '1px 8px', borderRadius: 10, fontWeight: 700 }}>
                        ⚑ {verifyRuns.length} VERIFY
                      </span>
                    )}
                    {ut._flagged && <span style={{ fontSize: 9, background: '#FFF0CC', color: '#7a5800', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>✏ MANUAL ENTRY</span>}
                    {!ut._flagged && verifyRuns.length === 0 && (ut.kitchen?.runs?.length > 0 || ut.vanity?.runs?.length > 0) && <span style={{ fontSize: 9, background: '#e8f5e9', color: '#2D7A3A', padding: '1px 7px', borderRadius: 10 }}>AI extracted</span>}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
                    {qty} unit{qty !== 1 ? 's' : ''} ·
                    Kitchen: <span style={{ color: '#2D7A3A', fontWeight: 500 }}>{fmtLF(t.kitchenLF)}</span> → {fmtSF(t.kitchenSF * qty)} total ·
                    Vanity: <span style={{ color: '#0C447C', fontWeight: 500 }}>{fmtLF(t.vanityLF)}</span> → {fmtSF(t.vanitySF * qty)} total ·
                    {t.sinkCutouts * qty} cutout{t.sinkCutouts * qty !== 1 ? 's' : ''}
                    {t.sidesSF > 0 ? ` · Sides: ${(t.sidesSF * qty).toFixed(1)} SF` : ''}
                  </div>
                </div>
              </div>
              <button onClick={e => { e.stopPropagation(); mutate(u => { u.splice(ui, 1) }); setExpanded(null) }}
                style={{ fontSize: 10, padding: '2px 8px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Remove</button>
            </div>

            {isExp && (
              <div style={{ padding: 16, borderTop: '0.5px solid #eee' }}>
                {/* Name + qty */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 16 }}>
                  <div><label style={lbl}>Unit Type Name</label>
                    <input value={ut.unit_type_name} onChange={e => setUnitField(ui, 'unit_type_name', e.target.value)} style={{ width: '100%', ...inp }} /></div>
                  <div><label style={lbl}>Unit Count</label>
                    <input type="number" min="0" value={ut.unit_quantity || 1} onChange={e => setUnitField(ui, 'unit_quantity', Number(e.target.value))} style={{ width: '100%', ...inp }} /></div>
                </div>

                {/* ── KITCHEN ── */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '2px solid #3C3489', paddingBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: '#3C3489' }}>Kitchen Countertop</div>
                    <button onClick={() => addRun(ui, 'kitchen')} style={{ fontSize: 10, padding: '3px 10px', background: '#f0f4ff', border: '0.5px solid #3C3489', borderRadius: 6, cursor: 'pointer', color: '#3C3489' }}>+ Add Counter Run</button>
                  </div>

                  {(ut.kitchen?.runs || []).length === 0 && (
                    <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>No runs yet — click "+ Add Counter Run"</div>
                  )}

                  {/* Column headers */}
                  {(ut.kitchen?.runs || []).length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px 28px', gap: 6, marginBottom: 4 }}>
                      {['Label', 'LF', 'Depth"', 'SF', 'Sink', ''].map(h => (
                        <div key={h} style={{ fontSize: 9, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.3 }}>{h}</div>
                      ))}
                    </div>
                  )}

                  {(ut.kitchen?.runs || []).map((run, ri) => (
                    <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                      <input value={run.label} onChange={e => setRun(ui,'kitchen',ri,'label',e.target.value)} style={{ ...inp }} placeholder="e.g. Left run" />
                      <input type="number" step="0.25" min="0" value={String(run.lf).toUpperCase()==='VERIFY'?'':run.lf||''} onChange={e => setRun(ui,'kitchen',ri,'lf',Number(e.target.value))} style={{ ...inp, borderColor: String(run.lf).toUpperCase()==='VERIFY'?'#A32D2D':'#ccc' }} placeholder={String(run.lf).toUpperCase()==='VERIFY'?'⚑ VERIFY':''} />
                      <input type="number" step="1" min="12" max="48" value={run.depth_in || KITCHEN_DEPTH} onChange={e => setRun(ui,'kitchen',ri,'depth_in',Number(e.target.value))} style={{ ...inp }} />
                      <div style={{ fontSize: 11, fontWeight: 500, textAlign: 'center', color: String(run.lf).toUpperCase()==='VERIFY'?'#A32D2D':'#3C3489' }}>
                        {String(run.lf).toUpperCase()==='VERIFY' ? '⚑' : sfFromRun(run.lf, run.depth_in || KITCHEN_DEPTH).toFixed(2)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={run.has_sink || false} onChange={e => setRun(ui,'kitchen',ri,'has_sink',e.target.checked)} id={`ks-${ui}-${ri}`} />
                        <label htmlFor={`ks-${ui}-${ri}`} style={{ fontSize: 10 }}>yes</label>
                      </div>
                      <button onClick={() => removeRun(ui,'kitchen',ri)} style={{ padding: '3px 6px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>✕</button>
                    </div>
                  ))}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                    <div>
                      <label style={lbl}>Backsplash LF {t.autoBackLF > 0 ? `(auto: ${t.autoBackLF.toFixed(1)} LF)` : ''}</label>
                      <input type="number" step="0.25" min="0"
                        value={ut.kitchen?.backsplash_lf || ''}
                        placeholder={t.autoBackLF > 0 ? `${t.autoBackLF.toFixed(1)} (auto)` : '0'}
                        onChange={e => setSectionField(ui,'kitchen','backsplash_lf', Number(e.target.value) || 0)}
                        style={{ width: '100%', ...inp }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      <button onClick={() => addSplash(ui)} style={{ width: '100%', padding: '7px 12px', fontSize: 11, background: '#fff8e1', border: '0.5px solid #cc9900', borderRadius: 6, cursor: 'pointer', color: '#7a5800' }}>
                        + Side / End Splash
                      </button>
                    </div>
                  </div>

                  {(ut.kitchen?.side_splashes || []).length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>Side &amp; End Splashes</div>
                      {(ut.kitchen?.side_splashes || []).map((sp, si) => (
                        <div key={si} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                          <input value={sp.label} onChange={e => setSplash(ui,si,'label',e.target.value)} style={{ ...inp }} placeholder="e.g. Window side" />
                          <div><label style={lbl}>Depth"</label>
                            <input type="number" step="1" min="0" value={sp.depth_in || KITCHEN_DEPTH} onChange={e => setSplash(ui,si,'depth_in',Number(e.target.value))} style={{ ...inp, width: '100%' }} /></div>
                          <div><label style={lbl}>Height"</label>
                            <input type="number" step="1" min="0" value={sp.height_in || SPLASH_HEIGHT} onChange={e => setSplash(ui,si,'height_in',Number(e.target.value))} style={{ ...inp, width: '100%' }} /></div>
                          <div style={{ fontSize: 11, fontWeight: 500, textAlign: 'center', color: '#cc9900' }}>{(((sp.depth_in||KITCHEN_DEPTH) * (sp.height_in||SPLASH_HEIGHT)) / 144).toFixed(2)} SF</div>
                          <button onClick={() => removeSplash(ui, si)} style={{ padding: '3px 6px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── VANITY ── */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '2px solid #2D7A3A', paddingBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: '#2D7A3A' }}>Vanity Countertop</div>
                    <button onClick={() => addRun(ui, 'vanity')} style={{ fontSize: 10, padding: '3px 10px', background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: 6, cursor: 'pointer', color: '#2D7A3A' }}>+ Add Vanity Run</button>
                  </div>

                  {(ut.vanity?.runs || []).length === 0 && (
                    <div style={{ fontSize: 11, color: '#aaa' }}>No vanity runs yet</div>
                  )}

                  {(ut.vanity?.runs || []).length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px 28px', gap: 6, marginBottom: 4 }}>
                      {['Label', 'LF', 'Depth"', 'SF', 'Sink', ''].map(h => (
                        <div key={h} style={{ fontSize: 9, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.3 }}>{h}</div>
                      ))}
                    </div>
                  )}

                  {(ut.vanity?.runs || []).map((run, ri) => (
                    <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                      <input value={run.label} onChange={e => setRun(ui,'vanity',ri,'label',e.target.value)} style={{ ...inp }} placeholder="e.g. Bathroom vanity" />
                      <input type="number" step="0.25" min="0" value={String(run.lf).toUpperCase()==='VERIFY'?'':run.lf||''} onChange={e => setRun(ui,'vanity',ri,'lf',Number(e.target.value))} style={{ ...inp, borderColor: String(run.lf).toUpperCase()==='VERIFY'?'#A32D2D':'#ccc' }} placeholder={String(run.lf).toUpperCase()==='VERIFY'?'⚑ VERIFY':''} />
                      <input type="number" step="1" min="12" max="36" value={run.depth_in || VANITY_DEPTH} onChange={e => setRun(ui,'vanity',ri,'depth_in',Number(e.target.value))} style={{ ...inp }} />
                      <div style={{ fontSize: 11, fontWeight: 500, textAlign: 'center', color: String(run.lf).toUpperCase()==='VERIFY'?'#A32D2D':'#2D7A3A' }}>
                        {String(run.lf).toUpperCase()==='VERIFY' ? '⚑' : sfFromRun(run.lf, run.depth_in || VANITY_DEPTH).toFixed(2)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={run.has_sink || false} onChange={e => setRun(ui,'vanity',ri,'has_sink',e.target.checked)} id={`vs-${ui}-${ri}`} />
                        <label htmlFor={`vs-${ui}-${ri}`} style={{ fontSize: 10 }}>yes</label>
                      </div>
                      <button onClick={() => removeRun(ui,'vanity',ri)} style={{ padding: '3px 6px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Grand total footer — SF Takeoff */}
      <div style={{ marginTop: 16, background: '#1a1a2e', borderRadius: '10px 10px 0 0', padding: '10px 20px' }}>
        <div style={{ color: '#4a9eff', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>SQUARE FOOTAGE TAKEOFF</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12 }}>
          {[
            ['Kitchen Counter', fmtSF(totals.kSF), ''],
            ['Vanity',          fmtSF(totals.vSF), ''],
            ['Side / End Splash', totals.sideSF.toFixed(1), 'SF'],
            ['Total Material', totals.materialSF.toFixed(1), 'SF'],
            ['Order Qty', withWaste.toFixed(1), 'SF'],
          ].map(([label, val, unit]) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ color: '#666', fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
              <div style={{ color: '#fff', fontSize: 18, fontWeight: 700 }}>{val}</div>
              <div style={{ color: '#555', fontSize: 8 }}>{unit}</div>
            </div>
          ))}
        </div>
      </div>

      {/* LF Takeoff strip */}
      <div style={{ background: '#12122a', padding: '10px 20px', borderTop: '0.5px solid #2a2a4a' }}>
        <div style={{ color: '#f4a261', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>LINEAL FOOTAGE TAKEOFF</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12 }}>
          {[
            ['Kitchen Counter', fmtLF(totals.kLF), ''],
            ['Vanity Counter',  fmtLF(totals.vLF), ''],
            ['Total Counter LF', fmtLF(totals.totalLF), ''],
            ['Backsplash',      fmtLF(totals.backLF), ''],
            ['Sink Cutouts',    totals.cuts, 'EA'],
          ].map(([label, val, unit]) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ color: '#776655', fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
              <div style={{ color: '#f4c18a', fontSize: 18, fontWeight: 700 }}>{val}</div>
              <div style={{ color: '#664', fontSize: 8 }}>{unit}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: '#232343', borderRadius: '0 0 10px 10px', padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#aaa' }}>Waste factor:</span>
          <input type="number" min="0" max="30" step="1" value={wastePct} onChange={e => setWastePct(Number(e.target.value))}
            style={{ width: 44, padding: '3px 6px', background: '#333', border: '0.5px solid #555', borderRadius: 4, color: '#fff', fontSize: 12, textAlign: 'center' }} />
          <span style={{ fontSize: 12, color: '#aaa' }}>% → Order Qty: <strong style={{ color: '#fff' }}>{withWaste.toFixed(1)} SF</strong></span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Order Qty (with waste)</div>
          <div style={{ color: '#fff', fontSize: 22, fontWeight: 700 }}>{withWaste.toFixed(1)} SF</div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setStage(3)} style={{ padding: '9px 28px', fontSize: 13, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
          → Generate Countertop Proposal PDF
        </button>
      </div>
    </div>
  )

  // ── STAGE 3: Generate Proposal ────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 580, margin: '0 auto' }}>
      <div style={card}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16 }}>Generate Countertop Proposal</div>

        {/* Summary recap */}
        <div style={{ marginBottom: 16 }}>
          {/* SF Takeoff */}
          <div style={{ background: '#e8f5e9', border: '0.5px solid #2D7A3A', borderRadius: '8px 8px 0 0', padding: '10px 14px' }}>
            <div style={{ fontWeight: 600, fontSize: 10, color: '#2D7A3A', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Square Footage Takeoff</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
              {[['Kitchen SF', fmtSF(totals.kSF)], ['Vanity SF', fmtSF(totals.vSF)], ['Side/End SF', fmtSF(totals.sideSF)], ['Total Material SF', fmtSF(totals.materialSF)]].map(([l,v])=>(
                <div key={l}><div style={{ fontSize: 8, color: '#555', textTransform: 'uppercase' }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: '#2D7A3A' }}>{v}</div></div>
              ))}
            </div>
            <div style={{ marginTop: 8, background: '#2D7A3A', borderRadius: 6, padding: '4px 10px', display: 'inline-block' }}>
              <span style={{ fontSize: 11, color: '#fff', fontWeight: 600 }}>Order Qty: {withWaste.toFixed(1)} SF</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginLeft: 8 }}>(+{wastePct}% waste)</span>
            </div>
          </div>
          {/* LF Takeoff */}
          <div style={{ background: '#e0f2f1', border: '0.5px solid #00796b', borderRadius: '0 0 8px 8px', borderTop: 'none', padding: '10px 14px' }}>
            <div style={{ fontWeight: 600, fontSize: 10, color: '#00695c', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Lineal Footage Takeoff</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
              {[['Kitchen LF', fmtLF(totals.kLF)], ['Vanity LF', fmtLF(totals.vLF)], ['Total Counter LF', fmtLF(totals.totalLF)], ['Backsplash LF', fmtLF(totals.backLF)]].map(([l,v])=>(
                <div key={l}><div style={{ fontSize: 8, color: '#555', textTransform: 'uppercase' }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: '#00695c' }}>{v}</div></div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: '#555' }}>
              Sink Cutouts: <strong>{totals.cuts}</strong>
            </div>
          </div>
        </div>

        {/* Config */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <div><label style={lbl}>Material Type</label>
            <select value={propConfig.material_type} onChange={e => setPropConfig(p=>({...p,material_type:e.target.value}))} style={{ width:'100%', ...inp }}>
              <option>Quartz</option><option>Solid Surface</option><option>Laminate</option><option>Cultured Marble</option><option>Granite</option>
            </select></div>
          <div><label style={lbl}>Fabricator</label>
            <input value={propConfig.fabricator} onChange={e => setPropConfig(p=>({...p,fabricator:e.target.value}))} style={{ width:'100%', ...inp }} placeholder="e.g. CAPO" /></div>
          <div><label style={lbl}>Color / Pattern</label>
            <input value={propConfig.color} onChange={e => setPropConfig(p=>({...p,color:e.target.value}))} style={{ width:'100%', ...inp }} placeholder="e.g. MSI Calacatta" /></div>
          <div><label style={lbl}>Thickness</label>
            <select value={propConfig.thickness} onChange={e => setPropConfig(p=>({...p,thickness:e.target.value}))} style={{ width:'100%', ...inp }}>
              <option>3CM</option><option>2CM</option><option>1.5CM</option>
            </select></div>
          <div><label style={lbl}>Edge Profile</label>
            <input value={propConfig.edge} onChange={e => setPropConfig(p=>({...p,edge:e.target.value}))} style={{ width:'100%', ...inp }} placeholder="e.g. Eased Edge" /></div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setStage(2)} style={{ flex: 1, padding: 10, fontSize: 12, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>← Back to Edit</button>
          <button onClick={generateProposal} disabled={generating} style={{ flex: 2, padding: 10, fontSize: 13, background: generating ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: generating ? 'default' : 'pointer', fontWeight: 600 }}>
            {generating ? 'Generating...' : '⬇ Download Countertop Proposal PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
