'use client'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

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

  // Hardware count formula (Blake's Reference Guide v2)
  function calcHardware(sku) {
    const SPECIAL = { 'CVDB36BDHL':5,'BLS36R':1,'CW2436R':1,'B30FH':2,'CVSDB36HFHR':2,'EPT90':0,'CVSDB48-DB15L':6 }
    const u = (sku || '').toUpperCase().trim()
    if (!u) return null
    const ZERO_PRE = ['F330','F342','F396','TRP','BRP','TKPW','TKC','OCM']
    const ZERO_EX  = ['PLYS','EPT','AD21']
    if (ZERO_EX.some(p => u === p || u.startsWith(p))) return 0
    if (ZERO_PRE.some(p => u.startsWith(p))) return 0
    if (SPECIAL[u] !== undefined) return SPECIAL[u]
    const skylM = u.match(/^(\d+)(DB|VDB|DWR)/)
    if (skylM) return parseInt(skylM[1])
    const dashM = u.match(/-(\d+)[A-Z]?$/)
    if (dashM) { const n = parseInt(dashM[1]); if (n >= 1 && n <= 9) return n }
    if (/^BB/.test(u)) return 1
    if (/^BW/.test(u)) return 1
    if (/^BLS/.test(u)) return 1
    if (/^CW/.test(u)) return 1
    if (/^HC/.test(u)) return 2
    if (/^LC/.test(u)) return 2
    if (/^P\d/.test(u)) return 2
    const VALID_W = new Set([9,12,15,18,21,24,27,30,33,36,39,42,45,48])
    function getW(s) {
      const n = s.replace(/^\d+/,'').replace(/^[A-Z]+/i,'')
      if (n.length >= 2) { const t = parseInt(n.substring(0,2)); if (VALID_W.has(t)) return t }
      if (n.length >= 3) return parseInt(n.substring(0,3))
      return null
    }
    const w = getW(u)
    if (/^(B|SB)/.test(u))                      return (w||99) <= 21 ? 2 : 3
    if (/^W/.test(u))                            return (w||99) <= 21 ? 1 : 2
    if (/^(VSB|VDB|CVDB|CVSDB|VSD|VS)/.test(u)) return (w||99) <= 21 ? 1 : 2
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
    formData.append('specs', specs)
    files.forEach(f => formData.append('files', f))
    const res = await fetch('/api/takeoff', { method: 'POST', body: formData, signal: AbortSignal.timeout(600000) })
    const result = await res.json()
    setUploading(false)
    if (result.success) {
      setExtractedData(result.data)
      setSummary(result.summary)
      setEditData(JSON.parse(JSON.stringify(result.data)))
      setStage(2)
    } else {
      alert('Extraction failed: ' + (result.error || 'Unknown error'))
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

  async function saveToJob() {
    if (!selectedJobId) return alert('Select a job to save this cabinet list to')
    setSaving(true)
    await supabase.from('cabinet_line_items').delete().eq('job_id', selectedJobId)
    await supabase.from('unit_types').delete().eq('job_id', selectedJobId)
    let grandTotal = 0
    for (let i = 0; i < editData.unit_types.length; i++) {
      const ut = editData.unit_types[i]
      const cabsPerUnit = (ut.skus?.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0) || 0)
        + (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0)
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
      action: `Takeoff finalized — ${editData.unit_types.length} unit types · ${grandTotal.toLocaleString()} total cabinets`,
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
    (ut.skus?.reduce((s, sk) => s + (Number(sk.quantity_per_unit) || 0), 0) || 0) +
    (ut.fillers?.reduce((s, f) => s + (Number(f.quantity_per_unit) || 0), 0) || 0)

  const grandTotal = editData?.unit_types?.reduce((s, ut) => s + getCabsPerUnit(ut) * (ut.unit_quantity || 1), 0) || 0

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

  return (
    <div>
      {/* ── STAGE 1: UPLOAD ── */}
      {stage === 1 && (
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <div style={card}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>AI Takeoff Engine</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 20 }}>
              Upload your full plan set PDF. The smart pre-processor scans every page, identifies relevant sheets automatically, and extracts all cabinet data.
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Link to Job (optional)</label>
              <select value={selectedJobId} onChange={e => setSelectedJobId(e.target.value)} style={{ width: '100%', ...inp }}>
                <option value="">— Select a job to save results to —</option>
                {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
              </select>
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
            <div style={{ marginBottom: 20 }}>
              <label style={lbl}>Cabinet Specs (optional — AI will find in plans or mark TBD)</label>
              <textarea value={specs} onChange={e => setSpecs(e.target.value)}
                placeholder="e.g. Northern Contours — Flat Panel — 2212 Braelyn laminate"
                style={{ width: '100%', ...inp, height: 60, resize: 'vertical' }} />
            </div>
            <div style={{ background: '#f0f4ff', border: '0.5px solid #c5d0f0', borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 11, color: '#444', lineHeight: 1.8 }}>
              <strong>How it works:</strong> Stage 1 scans full PDF in 5-page chunks using Haiku (fast + cheap). Stage 2 extracts only the relevant pages. Stage 3 runs full Opus extraction. You then review, add elevation pages if needed, and finalize.
            </div>
            <button onClick={runExtraction} disabled={uploading || files.length === 0}
              style={{ width: '100%', padding: 12, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 8, cursor: uploading ? 'default' : 'pointer', fontSize: 14, fontWeight: 600, opacity: uploading ? 0.8 : 1 }}>
              {uploading ? '⏳ Smart Processing — Do Not Close This Tab' : '🔍 Extract Cabinet List from Plans'}
            </button>
            {uploading && (
              <div style={{ marginTop: 14, background: '#f5f5ff', borderRadius: 8, padding: 14, fontSize: 11, color: '#555' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {['Splitting PDF into 5-page chunks', 'Haiku scanning chunks in parallel', 'Extracting relevant pages only', 'Opus full cabinet extraction'].map((s, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ background: '#3C3489', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                      {s}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, color: '#888' }}>Full plan sets: 5–10 min · Small sets: 1–3 min</div>
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
                  {summary?.unit_type_count} unit types · {summary?.total_units} total units · {grandTotal.toLocaleString()} total cabinets
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
                            {ut.skus.map((sk, si) => (
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
                            {ut.skus.length === 0 && <tr><td colSpan={6} style={{ padding: '8px 6px', color: '#aaa', fontSize: 11 }}>No SKUs yet — add manually or upload elevation pages</td></tr>}
                          </tbody>
                        </table>
                      </div>

                      {/* Fillers */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ fontWeight: 500, fontSize: 12 }}>Fillers</div>
                          <button onClick={() => addFiller(ui)} style={{ fontSize: 10, padding: '3px 10px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Add Filler</button>
                        </div>
                        {ut.fillers.length === 0 && <div style={{ fontSize: 11, color: '#aaa' }}>No fillers</div>}
                        {ut.fillers.map((f, fi) => (
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
            {grandTotal.toLocaleString()} total cabinets saved across {editData?.unit_types?.length} unit types
          </div>
          <button onClick={() => { setStage(1); setFiles([]); setExtractedData(null); setEditData(null); setMergeStats(null) }}
            style={{ padding: '8px 20px', fontSize: 13, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 8, cursor: 'pointer' }}>
            Run Another Takeoff
          </button>
        </div>
      )}
    </div>
  )
}
