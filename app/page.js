'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import TakeoffEngine from './components/TakeoffEngine'
import CountertopCalc from './components/CountertopCalc'
import { calculateHardware, getSection, isAppliance } from '@/lib/hardwareUtils'
import AgentPipeline from './components/AgentPipeline'


// Merge duplicate unit_type rows — same name (accent-normalized) collapses into one,
// preferring the row with a manufacturer price and the highest cabinet count.
function mergeUnitTypes(rows) {
  const norm = s => (s || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const groups = {}
  ;[...rows].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).forEach(ut => {
    const k = norm(ut.unit_type_name)
    if (!groups[k]) groups[k] = []
    groups[k].push(ut)
  })
  return Object.values(groups).map(g => {
    const priced   = g.find(r => (r.manufacturer_price || 0) > 0) || g[0]
    const maxQty   = Math.max(...g.map(r => r.unit_quantity || 1))
    const maxCabs  = Math.max(...g.map(r => r.cabinet_count || 0))
    const perUnit  = maxCabs > 0 && maxQty > 1 && maxCabs % maxQty === 0 && maxCabs / maxQty <= 60 ? maxCabs / maxQty : maxCabs
    const maxPrice = Math.max(...g.map(r => r.manufacturer_price || 0))
    return { ...priced, unit_quantity: maxQty, cabinet_count: perUnit, manufacturer_price: maxPrice }
  })
}

const STAGE_COLORS = {
  'RFQ':            { bg: '#EEEDFE', text: '#3C3489' },
  'Open Proposals': { bg: '#E6F1FB', text: '#0C447C' },
  'On Hold':        { bg: '#FAF3DA', text: '#7A6206' },
  'Awarded':        { bg: '#EAF3DE', text: '#3B6D11' },
  'Shop Drawings':  { bg: '#FAEEDA', text: '#633806' },
  'Ordered':        { bg: '#E6F1FB', text: '#0C447C' },
  'Delivered':      { bg: '#E1F5EE', text: '#085041' },
  'Closeout':       { bg: '#EAF3DE', text: '#27500A' },
  'Lost':           { bg: '#FCEBEB', text: '#A32D2D' },
  // Legacy stage names still render (existing jobs keep working until re-staged)
  'Bid':            { bg: '#EEEDFE', text: '#3C3489' },
  'Pricing':        { bg: '#E6F1FB', text: '#0C447C' },
  'Proposal Sent':  { bg: '#E6F1FB', text: '#0C447C' },
  'Active':         { bg: '#EEEDFE', text: '#3C3489' },
  'Rebid':          { bg: '#FAF3DA', text: '#7A6206' },
  'Installed':      { bg: '#EAF3DE', text: '#27500A' },
}

const SHIPMENT_STATUS_COLORS = {
  'Scheduled':  { bg: '#E6F1FB', text: '#0C447C' },
  'In Transit': { bg: '#FAEEDA', text: '#633806' },
  'Delivered':  { bg: '#EAF3DE', text: '#27500A' },
  'Delayed':    { bg: '#FCEBEB', text: '#A32D2D' },
}

const STAGES = ['RFQ', 'Open Proposals', 'On Hold', 'Awarded', 'Shop Drawings', 'Ordered', 'Delivered', 'Closeout', 'Lost']
const CARRIERS = ['UPS Freight', 'FedEx Freight', 'Old Dominion', 'XPO Logistics', 'Estes Express', 'R+L Carriers', 'Other']
const fmt = (n) => n ? '$' + Math.round(n).toLocaleString() : '—'
const fmtPct = (n) => n ? (n * 100).toFixed(1) + '%' : '—'

const emptyShipment = {
  load_number: 1, total_loads: 1, carrier: 'UPS Freight',
  tracking_number: '', floors_covered: '', cabinet_count: '',
  scheduled_date: '', delivery_contact: '', notes: '', status: 'Scheduled',
}

export default function Home() {
  const [jobs, setJobs] = useState([])
  const [view, setView] = useState('dashboard')
  const [selectedJob, setSelectedJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showNewJob, setShowNewJob] = useState(false)
  const [newJob, setNewJob] = useState({ name: '', gc_name: '', address: '', city: 'Denver', state: 'CO', owner: 'Cole', stage: 'Bid', manufacturer: 'TBD' })
  const [quoteUploading, setQuoteUploading] = useState(false)
  const [quoteResult, setQuoteResult] = useState(null)
  const [reminders, setReminders] = useState([])
  const [proposalSender, setProposalSender] = useState('Cole')
  const [proposalNotes, setProposalNotes] = useState('')
  const DEFAULT_CT_BID_SECTIONS = {
    includedInBid: 'Sales Tax  |  Delivery to Job Site  |  Sink cutouts per sink specifications',
    assembly: 'By Greenworks Renovations under separate contract — Contact: Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com',
    notIncluded: 'Installation — under separate contract with Greenworks Renovations\nPlumbing connections, faucets, undermount sink brackets\nTile backsplash installation or materials\nModel unit "Out of Phase" delivery',
    bottomNotes: 'Final price subject to approved shop drawings. All quantities are estimated — field measurements and approved shop drawings will prevail.',
  }
  const [ctSender,      setCtSender]      = useState('Cole')
  const [ctWastePct,    setCtWastePct]    = useState(10)
  const [ctMargin,      setCtMargin]      = useState(20)
  const [ctGross,       setCtGross]       = useState('')
  const [ctNotes,       setCtNotes]       = useState('')
  const [ctBidSections, setCtBidSections] = useState(DEFAULT_CT_BID_SECTIONS)
  const DEFAULT_BID_SECTIONS = {
    includedInBid: 'Sales Tax  |  Delivery to Job Site',
    assembly: 'By Greenworks Renovations under separate contract — Contact: Anthony (Willy) Ramirez  |  619-718-1578  |  greenworksrenovationsllc@gmail.com',
    notIncluded: 'Installation — under separate contract with Greenworks Renovations\nAttic stock, locks, labor, shims, screws, supports, grommets, castors, blocking or backing\nCrown molding, scribe or base shoe unless included in writing\nRecessed linen cabinets, desks, entry benches, floating shelves or undercabinet lighting unless included in writing\nModel unit "Out of Phase" delivery',
    bottomNotes: 'Final price subject to approved shop drawings. The first red-line revision is free — subsequent revisions subject to additional fees.',
    aliases: '',
  }
  const [bidSections, setBidSections] = useState(DEFAULT_BID_SECTIONS)
  useEffect(() => {
    setBidSections(selectedJob?.proposal_sections ? { ...DEFAULT_BID_SECTIONS, ...selectedJob.proposal_sections } : DEFAULT_BID_SECTIONS)
    setProposalGross(selectedJob?.manufacturer_gross_cost > 0 ? String(selectedJob.manufacturer_gross_cost) : '')
    setProposalFreight(selectedJob?.freight_cost > 0 ? String(selectedJob.freight_cost) : '')
    setProposalMfrTax('')
    setJobFiles([])
    setCabList(null)
    if (selectedJob?.id) {
      setFilesLoading(true)
      fetch('/api/job-files?jobId=' + selectedJob.id)
        .then(r => r.json()).then(d => { setJobFiles(d.files || []); setFilesLoading(false) })
        .catch(() => setFilesLoading(false))
      setCabListLoading(true)
      fetch('/api/cab-list?jobId=' + selectedJob.id)
        .then(r => r.json()).then(d => {
          setCabList(d.cabList || null); setCabLoadedAt(d.updatedAt || null); setCabListLoading(false)
          const uts = d.cabList?.unit_types || []
          const pieces = uts.reduce((s,u)=>s+(u.skus||[]).reduce((x,r2)=>x+(Number(r2.hardware_count)||0)*(Number(r2.quantity_per_unit)||0),0)*(Number(u.unit_quantity)||1),0)
          if (pieces > 0) setHwPieces(String(pieces))
          const leedo = d.cabList?.leedo
          if (leedo?.freight > 0) setProposalFreight(String(leedo.freight))
          if (leedo?.grandTotal > 0 && leedo?.grossAmount > 0) {
            const t = Math.max(0, leedo.grandTotal - leedo.grossAmount - (leedo.freight || 0))
            if (t > 0) setProposalMfrTax(t.toFixed(2))
          }
        })
        .catch(() => setCabListLoading(false))
      setCabEditing(false); setCabDraft(null)
    }
  }, [selectedJob?.id])
  const [proposalMargin, setProposalMargin] = useState(20)
  const [proposalGross,  setProposalGross]  = useState('')
  const [proposalFreight, setProposalFreight] = useState('')
  const [proposalMfrTax,  setProposalMfrTax]  = useState('')
  const [applyDiscount,   setApplyDiscount]   = useState(true)
  const [hwPieces,        setHwPieces]        = useState('')
  const [hwRate,          setHwRate]          = useState('4.00')
  const [quoteCheck,      setQuoteCheck]      = useState(null)
  const [quoteChecking,   setQuoteChecking]   = useState(false)
  const [skuSuggest,      setSkuSuggest]      = useState([])
  const [productLine,     setProductLine]     = useState('framed')
  const [hideUnitPricing, setHideUnitPricing] = useState(false)
  const FILE_CATEGORIES = ['Drawings', 'Contract', 'Quote', 'Change Order', 'Proposal', 'Photo', 'Other']
  const [jobFiles,       setJobFiles]       = useState([])
  const [filesLoading,   setFilesLoading]   = useState(false)
  const [fileUploading,  setFileUploading]  = useState(false)
  const [fileCategory,   setFileCategory]   = useState('Drawings')
  const CAB_CATEGORIES = ['BASES', 'VANITIES', 'WALLS', 'TALLS', 'ACCESSORIES', 'TRIM', 'HARDWARE ALLOWANCES']
  const [cabList,        setCabList]        = useState(null)
  const [cabListLoading, setCabListLoading] = useState(false)
  const [cabSeeding,     setCabSeeding]     = useState(false)
  const [cabEditing,     setCabEditing]     = useState(false)
  const [cabDraft,       setCabDraft]       = useState(null)
  const [cabLoadedAt,    setCabLoadedAt]    = useState(null)
  const [cabSaving,      setCabSaving]      = useState(false)
  const [cabExporting,   setCabExporting]   = useState(false)
  const [cabCopyTarget,  setCabCopyTarget]  = useState('')
  const [jobSearch,      setJobSearch]      = useState('')
  const [ownerFilter,    setOwnerFilter]    = useState('All')
  const [gcFilter,       setGcFilter]       = useState('All')
  const [proposalSalesTax, setProposalSalesTax] = useState(9.15)
  const [proposalLoading, setProposalLoading] = useState(false)
  const [stageUpdating, setStageUpdating] = useState(false)
  const [showReminderForm, setShowReminderForm] = useState(false)
  const [newReminder, setNewReminder] = useState({ due_date: '', reminder_type: 'Bid Follow-up', message: '', assigned_to: 'Cole' })
  const [editingProposal, setEditingProposal] = useState(false)
  const [editFields, setEditFields] = useState({})
  const [editUnitTypes, setEditUnitTypes] = useState([])
  const [additionalLineItems, setAdditionalLineItems] = useState([])
  const [savingEdits, setSavingEdits] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletingJob, setDeletingJob] = useState(false)

  // Countertop state
  const [ctSavedData,       setCtSavedData]       = useState(null)
  const [ctQuoteUploading,  setCtQuoteUploading]  = useState(false)
  const [ctQuoteResult,     setCtQuoteResult]     = useState(null)
  const [ctMarkup,          setCtMarkup]          = useState(1.25)
  const [ctIncludeCabinets, setCtIncludeCabinets] = useState(true)
  const [ctGenerating,      setCtGenerating]      = useState(false)

  // Shipment state
  const [shipments, setShipments] = useState([])
  const [allActiveShipments, setAllActiveShipments] = useState([])
  const [showShipmentForm, setShowShipmentForm] = useState(false)
  const [newShipment, setNewShipment] = useState(emptyShipment)
  const [editingShipment, setEditingShipment] = useState(null)
  const [savingShipment, setSavingShipment] = useState(false)

  const loadJobs = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('jobs')
      .select('*, unit_types(*), activity_log(*), reminders(*)')
      .order('created_at', { ascending: false })
    if (data) setJobs(data)
    setLoading(false)
  }, [])

  const loadReminders = useCallback(async () => {
    const res = await fetch('/api/reminders')
    const data = await res.json()
    if (Array.isArray(data)) setReminders(data)
  }, [])

  const loadAllActiveShipments = useCallback(async () => {
    const res = await fetch('/api/shipments')
    const data = await res.json()
    if (Array.isArray(data)) setAllActiveShipments(data)
  }, [])

  const loadJobShipments = useCallback(async (jobId) => {
    const res = await fetch(`/api/shipments?jobId=${jobId}`)
    const data = await res.json()
    if (Array.isArray(data)) setShipments(data)
  }, [])

  useEffect(() => { loadJobs(); loadReminders(); loadAllActiveShipments() }, [loadJobs, loadReminders, loadAllActiveShipments])

  useEffect(() => {
    if (selectedJob) {
      setEditFields({
        name: selectedJob.name || '',
        door_style: selectedJob.door_style || '',
        finish_color: selectedJob.finish_color || '',
        box_construction: selectedJob.box_construction || '',
        hardware_allowance: selectedJob.hardware_allowance || 0,
        scope_notes: selectedJob.scope_notes || '',
        gc_name:      selectedJob.gc_name      || '',
        address:      selectedJob.address      || '',
        city:         selectedJob.city         || '',
        state:        selectedJob.state        || '',
        zip:          selectedJob.zip          || '',
        manufacturer: selectedJob.manufacturer || '',
        bid_due_date: selectedJob.bid_due_date || '',
        gc_contact:   selectedJob.gc_contact   || '',
        gc_phone:     selectedJob.gc_phone     || '',
        gc_email:     selectedJob.gc_email     || '',
      })
      setEditUnitTypes(mergeUnitTypes(selectedJob.unit_types || []))
      setAdditionalLineItems([])
      setEditingProposal(false)
      setConfirmDelete(false)
      setCtSavedData(null)
      setCtQuoteResult(null)
      setShipments([])
      setShowShipmentForm(false)
      loadJobShipments(selectedJob.id)
      supabase.from('activity_log')
        .select('action, created_at')
        .eq('job_id', selectedJob.id)
        .like('action', '__CT_TAKEOFF__:%')
        .order('created_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data?.[0]) {
            try { setCtSavedData(JSON.parse(data[0].action.replace('__CT_TAKEOFF__:', ''))) } catch(_) {}
          }
        })
    }
  }, [selectedJob?.id, loadJobShipments])

  async function saveProposalEdits() {
    if (!selectedJob) return
    setSavingEdits(true)
    await supabase.from('jobs').update({
      name: editFields.name || selectedJob.name,
      door_style: editFields.door_style,
      finish_color: editFields.finish_color,
      box_construction: editFields.box_construction,
      hardware_allowance: Number(editFields.hardware_allowance) || 0,
      scope_notes: editFields.scope_notes,
      gc_name:      editFields.gc_name,
      address:      editFields.address,
      city:         editFields.city,
      state:        editFields.state,
      zip:          editFields.zip,
      manufacturer: editFields.manufacturer,
      bid_due_date: editFields.bid_due_date || null,
      gc_contact:   editFields.gc_contact,
      gc_phone:     editFields.gc_phone,
      gc_email:     editFields.gc_email,
    }).eq('id', selectedJob.id)
    for (const ut of editUnitTypes) {
      await supabase.from('unit_types').update({ unit_quantity: ut.unit_quantity }).eq('id', ut.id)
    }
    await supabase.from('activity_log').insert({ job_id: selectedJob.id, user_name: 'Cole', action: 'Proposal details edited' })
    const { data } = await supabase.from('jobs').select('*, unit_types(*), activity_log(*), reminders(*)').eq('id', selectedJob.id).single()
    if (data) setSelectedJob(data)
    setSavingEdits(false)
    setEditingProposal(false)
    loadJobs()
  }

  async function createShipment() {
    if (!selectedJob) return
    setSavingShipment(true)
    const res = await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', job_id: selectedJob.id, user: 'Pam', ...newShipment }),
    })
    const result = await res.json()
    if (result.success) {
      setShowShipmentForm(false)
      setNewShipment(emptyShipment)
      loadJobShipments(selectedJob.id)
      loadAllActiveShipments()
      loadJobs()
    } else {
      alert('Error: ' + result.error)
    }
    setSavingShipment(false)
  }

  async function updateShipmentStatus(id, status, jobId) {
    await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id, status, job_id: jobId, user: 'Pam' }),
    })
    loadJobShipments(selectedJob?.id || jobId)
    loadAllActiveShipments()
    loadJobs()
  }

  async function saveShipmentEdit() {
    if (!editingShipment) return
    setSavingShipment(true)
    await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', ...editingShipment, user: 'Pam' }),
    })
    setEditingShipment(null)
    loadJobShipments(selectedJob.id)
    loadAllActiveShipments()
    setSavingShipment(false)
  }

  async function deleteShipment(id) {
    if (!confirm('Delete this shipment record?')) return
    await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
    loadJobShipments(selectedJob.id)
    loadAllActiveShipments()
  }

  async function createJob() {
    if (!newJob.name) return alert('Job name is required')
    const { data, error } = await supabase.from('jobs').insert(newJob).select().single()
    if (error) return alert('Error: ' + error.message)
    await supabase.from('activity_log').insert({ job_id: data.id, user_name: newJob.owner, action: `Job created — ${newJob.name}` })
    setShowNewJob(false)
    setNewJob({ name: '', gc_name: '', address: '', city: 'Denver', state: 'CO', owner: 'Cole', stage: 'Bid', manufacturer: 'TBD' })
    loadJobs()
  }

  async function deleteJob() {
    if (!selectedJob) return
    setDeletingJob(true)
    await supabase.from('activity_log').delete().eq('job_id', selectedJob.id)
    await supabase.from('reminders').delete().eq('job_id', selectedJob.id)
    await supabase.from('cabinet_line_items').delete().eq('job_id', selectedJob.id)
    await supabase.from('unit_types').delete().eq('job_id', selectedJob.id)
    await supabase.from('shipments').delete().eq('job_id', selectedJob.id)
    await supabase.from('jobs').delete().eq('id', selectedJob.id)
    setDeletingJob(false)
    setConfirmDelete(false)
    setSelectedJob(null)
    setView('jobs')
    loadJobs()
  }

  async function handleQuoteUpload(e) {
    const file = e.target.files[0]
    if (!file || !file.name.endsWith('.pdf')) return alert('Please select a PDF file')
    if (!selectedJob) return alert('Select a job first')
    setQuoteUploading(true)
    setQuoteResult(null)
    const arrayBuffer = await file.arrayBuffer()
    const response = await fetch('/api/parse-quote', {
      method: 'POST',
      headers: { 'x-job-id': selectedJob.id, 'x-file-name': file.name, 'Content-Type': 'application/octet-stream' },
      body: arrayBuffer,
    })
    const result = await response.json()
    setQuoteUploading(false)
    if (result.success) {
      setQuoteResult(result)
      loadJobs()
      const { data } = await supabase.from('jobs').select('*, unit_types(*), activity_log(*), reminders(*)').eq('id', selectedJob.id).single()
      if (data) setSelectedJob(data)
    } else {
      alert('Error parsing quote: ' + (result.error || 'Unknown error'))
    }
  }

  async function handleCtQuoteUpload(e) {
    const file = e.target.files[0]
    if (!file || !file.name.endsWith('.pdf')) return alert('Please select a PDF file')
    setCtQuoteUploading(true)
    const arrayBuffer = await file.arrayBuffer()
    const res = await fetch('/api/parse-countertop-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'x-job-id': selectedJob?.id || '' },
      body: arrayBuffer,
    })
    const result = await res.json()
    setCtQuoteUploading(false)
    if (result.success) {
      setCtQuoteResult(result)
      loadJobs()
    } else {
      alert('Error parsing quote: ' + (result.error || 'Unknown error'))
    }
  }

  async function saveCabList(list, source) {
    await fetch('/api/cab-list', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: selectedJob.id, cabList: list, source }) })
    setCabList(list)
  }

  async function seedCabListFromExcel(e) {
    const file = e.target.files?.[0]; if (!file) return
    setCabSeeding(true)
    try {
      const fd = new FormData()
      fd.append('files', file)
      const res = await fetch('/api/takeoff/excel', { method: 'POST', body: fd })
      const result = await res.json()
      if (result.success && result.data) {
        await saveCabList({ ...result.data, product_line: productLine }, 'seeded from Excel')
      } else {
        alert('Could not parse that file: ' + (result.error || 'unknown error'))
      }
    } catch (err) { alert('Seed failed: ' + err.message) }
    setCabSeeding(false); e.target.value = ''
  }

  async function importLeedoSummary(e) {
    const file = e.target.files?.[0]; if (!file) return
    setCabSeeding(true)
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch('/api/parse-leedo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-job-id': selectedJob.id, 'x-file-name': file.name },
        body: buf,
      })
      const result = await res.json()
      if (result.success && result.cabList) {
        const v = result.cabList.verification || {}
        await saveCabList({ ...result.cabList, product_line: productLine }, 'Leedo summary import')
        const msg = v.leedoUnits != null
          ? `Imported ${result.cabList.unit_types.length} unit types.\nLeedo summary says: ${v.leedoUnits} units / ${v.leedoCabinets} cabinets.\nParsed: ${v.parsedUnits} units / ${v.parsedCabs} total pieces (incl. accessories).${v.unitsMatch ? '\n✓ Unit counts match.' : '\n⚠ UNIT COUNT MISMATCH — review before sending for pricing.'}${v.quoteRecorded === false ? '\n⚠ Quote history NOT recorded — quote check will not see this import.' : v.quoteRecorded ? '\n✓ Recorded in quote history.' : ''}`
          : `Imported ${result.cabList.unit_types.length} unit types.`
        alert(msg)
      } else {
        alert('Leedo import failed: ' + (result.error || 'unknown error'))
      }
    } catch (err) { alert('Leedo import failed: ' + err.message) }
    setCabSeeding(false); e.target.value = ''
  }

  async function startBlankCabList() {
    await saveCabList({ project_name: selectedJob.name, product_line: productLine, unit_types: [], sheet_totals: null }, 'started blank')
  }

  async function fetchSkuSuggestions(q) {
    const line = (cabEditing ? cabDraft : cabList)?.product_line || 'framed'
    if (!q || q.length < 2) { setSkuSuggest([]); return }
    try {
      const r = await fetch(`/api/leedo-catalog?line=${line}&q=${encodeURIComponent(q)}`)
      const d = await r.json()
      setSkuSuggest(d.items || [])
    } catch { setSkuSuggest([]) }
  }

  function startCabEdit() {
    setCabDraft(JSON.parse(JSON.stringify(cabList)))  // deep copy
    setCabEditing(true)
  }
  function cabDraftUpdate(fn) {
    setCabDraft(d => { const n = JSON.parse(JSON.stringify(d)); fn(n); return n })
  }
  async function saveCabEdit() {
    setCabSaving(true)
    try {
      const res = await fetch('/api/cab-list', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJob.id, cabList: cabDraft, source: 'editor', baseUpdatedAt: cabLoadedAt }),
      })
      if (res.status === 409) {
        const d = await res.json()
        alert(d.message || 'Conflict — reload the job first.')
      } else if (res.ok) {
        setCabList(cabDraft); setCabEditing(false); setCabDraft(null)
        setCabLoadedAt(new Date().toISOString())
      } else {
        const d = await res.json(); alert('Save failed: ' + (d.error || 'unknown'))
      }
    } catch (err) { alert('Save failed: ' + err.message) }
    setCabSaving(false)
  }
  async function exportCabList() {
    if (!cabList) return
    setCabExporting(true)
    try {
      const base = { takeoffData: cabList, projectName: cabList.project_name || selectedJob.name, supplierName: cabList.specs?.cabinet_line || selectedJob.manufacturer || 'TBD', catalogRef: 'TBD', printDate: new Date().toLocaleDateString('en-US') }
      const safe = (cabList.project_name || selectedJob.name || 'Cabinet_Schedule').replace(/[^a-zA-Z0-9_-]/g, '_')
      for (const [mode, suffix] of [['internal', 'Full_List'], ['manufacturer', 'Quote']]) {
        const res = await fetch('/api/export/excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, mode }) })
        if (!res.ok) throw new Error('Export failed (' + mode + ')')
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = safe + '_' + suffix + '.xlsx'; a.click(); URL.revokeObjectURL(url)
        await new Promise(r => setTimeout(r, 400))
      }
    } catch (err) { alert(err.message) }
    setCabExporting(false)
  }

  async function runQuoteCheck() {
    setQuoteChecking(true); setQuoteCheck(null)
    try {
      const r = await fetch('/api/quote-check?jobId=' + selectedJob.id)
      const d = await r.json()
      setQuoteCheck(d.error ? { error: d.error } : d)
    } catch (err) { setQuoteCheck({ error: err.message }) }
    setQuoteChecking(false)
  }

  async function copyCabListToJob() {
    if (!cabCopyTarget || !cabList) return
    const target = jobs.find(j => j.id === cabCopyTarget)
    if (!target) return
    // Warn if the target already has a list
    const check = await fetch('/api/cab-list?jobId=' + cabCopyTarget).then(r => r.json()).catch(() => ({}))
    if (check.cabList && !confirm(`${target.name} already has a cabinet list. Overwrite it?`)) return
    if (!check.cabList && !confirm(`Copy this cabinet list to ${target.name}?`)) return
    const copy = JSON.parse(JSON.stringify(cabList))
    copy.project_name = target.name
    const res = await fetch('/api/cab-list', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: cabCopyTarget, cabList: copy, source: `copied from ${selectedJob.name}` }),
    })
    if (res.ok) { alert(`Copied to ${target.name}`); setCabCopyTarget('') }
    else alert('Copy failed')
  }

  async function uploadJobFile(e) {
    const file = e.target.files?.[0]; if (!file) return
    setFileUploading(true)
    const fd = new FormData()
    fd.append('jobId', selectedJob.id)
    fd.append('category', fileCategory)
    fd.append('file', file)
    try {
      await fetch('/api/job-files', { method: 'POST', body: fd })
      const r = await fetch('/api/job-files?jobId=' + selectedJob.id)
      const d = await r.json(); setJobFiles(d.files || [])
    } catch {}
    setFileUploading(false); e.target.value = ''
  }
  async function downloadJobFile(path, name) {
    const r = await fetch('/api/job-files', { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path }) })
    const d = await r.json()
    if (d.url) { const a = document.createElement('a'); a.href = d.url; a.target='_blank'; a.download = name; a.click() }
  }
  async function deleteJobFile(path) {
    if (!confirm('Delete this file?')) return
    await fetch('/api/job-files', { method: 'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jobId: selectedJob.id, path }) })
    setJobFiles(f => f.filter(x => x.path !== path))
  }
  async function generateCtProposal() {
    if (!selectedJob || !ctSavedData) return alert('No countertop takeoff data saved for this job yet')
    setCtGenerating(true)
    try {
      const quoteTotal   = ctQuoteResult?.total_amount || 0
      const ctBidToGC    = quoteTotal * ctMarkup
      const unitTypesPayload = ctSavedData.unitTypes || []
      const totalsPayload = {
        kSF:       ctSavedData.kSF       || 0,
        vSF:       ctSavedData.vSF       || 0,
        kLF:       ctSavedData.kLF       || 0,
        vLF:       ctSavedData.vLF       || 0,
        backLF:    ctSavedData.backLF    || 0,
        sideSF:    ctSavedData.sideSF    || 0,
        sidesLF:   ctSavedData.sidesLF   || 0,
        cuts:      ctSavedData.cuts      || 0,
        materialSF: (ctSavedData.kSF||0) + (ctSavedData.vSF||0) + (ctSavedData.sideSF||0),
        totalLF:   (ctSavedData.kLF||0) + (ctSavedData.vLF||0),
      }
      const propConfig = {
        material_type: ctQuoteResult?.material_type || 'Countertop',
        fabricator:    ctQuoteResult?.fabricator    || '—',
        color:         ctQuoteResult?.color         || '',
        thickness:     '3CM',
        edge:          'Eased Edge',
        quote_total:   quoteTotal,
        markup:        ctMarkup,
        bid_to_gc:     ctBidToGC,
        include_cabinets: ctIncludeCabinets,
      }
      const res = await fetch('/api/generate-countertop-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJob.id, unitTypes: unitTypesPayload, totals: totalsPayload, wastePct: ctWastePct, propConfig, sender: ctSender, bidSections: ctBidSections, marginPct: Number(ctMargin), grossCostOverride: Number(ctGross) || 0, notes: ctNotes }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed') }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a'); a.href = url
      a.download = `MDSG-CT-Proposal-${selectedJob.name.replace(/[^a-z0-9]/gi,'-')}.pdf`
      a.click(); URL.revokeObjectURL(url)
      loadJobs()
    } catch (err) { alert('Error: ' + err.message) }
    setCtGenerating(false)
  }

  async function generateProposal() {
    if (!selectedJob) return
    setProposalLoading(true)
    try {
      const response = await fetch('/api/generate-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJob.id, sender: proposalSender, notes: proposalNotes, marginPct: Number(proposalMargin), grossCostOverride: Number(proposalGross) || 0, salesTaxPct: Number(proposalSalesTax), additionalLineItems, bidSections, freightPassThrough: proposalFreight !== '' ? Number(proposalFreight) : null, mfrTaxPassThrough: Number(proposalMfrTax) || 0, applyDealerDiscount: applyDiscount, hideUnitPricing, hwPieces: Number(hwPieces) || 0, hwRate: Number(hwRate) || 4 }),
      })
      if (!response.ok) { const err = await response.json(); throw new Error(err.error || 'Failed') }
      // Persist the bid sections on the job so they reload next time (needs jobs.proposal_sections jsonb column)
      supabase.from('jobs').update({ proposal_sections: bidSections }).eq('id', selectedJob.id).then(() => {})
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `MDSG-Proposal-${selectedJob.name.replace(/[^a-z0-9]/gi, '-')}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      loadJobs()
      const { data } = await supabase.from('jobs').select('*, unit_types(*), activity_log(*), reminders(*)').eq('id', selectedJob.id).single()
      if (data) setSelectedJob(data)
    } catch (err) { alert('Error: ' + err.message) }
    setProposalLoading(false)
  }

  async function updateStage(newStage) {
    if (!selectedJob || stageUpdating) return
    setStageUpdating(true)
    const res = await fetch('/api/update-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: selectedJob.id, stage: newStage, user: 'Cole' }),
    })
    const result = await res.json()
    if (result.success) { setSelectedJob(prev => ({ ...prev, stage: newStage })); loadJobs(); loadReminders() }
    setStageUpdating(false)
  }

  async function completeReminder(id) {
    await fetch('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete', id }) })
    loadReminders()
  }

  async function createReminder() {
    if (!newReminder.due_date || !newReminder.message) return alert('Date and message required')
    await fetch('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', job_id: selectedJob?.id, ...newReminder }) })
    setShowReminderForm(false)
    setNewReminder({ due_date: '', reminder_type: 'Bid Follow-up', message: '', assigned_to: 'Cole' })
    loadReminders()
  }

  const pipelineValue = jobs.reduce((s, j) => s + (j.bid_value || 0), 0)
  const activeBids = jobs.filter(j => ['RFQ', 'Open Proposals', 'Bid', 'Pricing', 'Proposal Sent'].includes(j.stage)).length
  const awardedValue = jobs.filter(j => !['RFQ', 'Open Proposals', 'Bid', 'Pricing', 'Proposal Sent', 'Lost', 'On Hold'].includes(j.stage)).reduce((s, j) => s + (j.bid_value || 0), 0)
  const avgMargin = jobs.filter(j => j.gross_margin_pct > 0).reduce((s, j, _, arr) => s + j.gross_margin_pct / arr.length, 0)
  const overdueReminders = reminders.filter(r => r.due_date <= new Date().toISOString().split('T')[0])
  const marginPricePreview = Number(proposalGross) > 0 && Number(proposalMargin) > 0 && Number(proposalMargin) < 95 ? '$' + Math.round(Number(proposalGross) / (1 - Number(proposalMargin) / 100)).toLocaleString() : null
  const inTransitCount = allActiveShipments.filter(s => s.status === 'In Transit').length
  const delayedCount = allActiveShipments.filter(s => s.status === 'Delayed').length

  const nav = (id, label) => (
    <div onClick={() => { setView(id); if (id !== 'job-detail') setSelectedJob(null) }}
      style={{ padding: '8px 16px', cursor: 'pointer', fontSize: 13,
        color: view === id ? '#1a1a1a' : '#666',
        background: view === id ? '#f5f5f3' : 'transparent',
        borderLeft: view === id ? '2px solid #3C3489' : '2px solid transparent',
        fontWeight: view === id ? 500 : 400 }}>
      {label}
    </div>
  )

  const inp = { width: '100%', padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }
  const lbl = { fontSize: 10, color: '#888', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }
  const card = { background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, padding: 20, marginBottom: 16 }

  const ShipmentBadge = ({ status }) => {
    const c = SHIPMENT_STATUS_COLORS[status] || SHIPMENT_STATUS_COLORS['Scheduled']
    return <span style={{ background: c.bg, color: c.text, borderRadius: 10, padding: '2px 8px', fontSize: 10, fontWeight: 500 }}>{status}</span>
  }

  const StatusButtons = ({ shipment }) => (
    <div style={{ display: 'flex', gap: 4 }}>
      {['Scheduled', 'In Transit', 'Delivered', 'Delayed'].map(s => (
        <button key={s} onClick={() => updateShipmentStatus(shipment.id, s, shipment.job_id)}
          style={{ padding: '3px 8px', fontSize: 10, borderRadius: 6, cursor: 'pointer',
            background: shipment.status === s ? SHIPMENT_STATUS_COLORS[s].bg : '#f5f5f3',
            color: shipment.status === s ? SHIPMENT_STATUS_COLORS[s].text : '#888',
            border: shipment.status === s ? `1px solid ${SHIPMENT_STATUS_COLORS[s].text}` : '0.5px solid #ddd',
            fontWeight: shipment.status === s ? 600 : 400 }}>
          {s}
        </button>
      ))}
    </div>
  )

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', fontSize: 14, background: '#f5f5f3' }}>

      {/* Sidebar */}
      <div style={{ width: 200, background: '#fff', borderRight: '0.5px solid #e5e5e0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, borderBottom: '0.5px solid #e5e5e0' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>MDSG OS</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Manufacturer Direct Sales</div>
        </div>
        <div style={{ padding: '8px 0', flex: 1 }}>
          {nav('dashboard', 'Dashboard')}
          {nav('jobs', 'Jobs')}
          {nav('agent-pipeline', '⚡ Agent Pipeline')}
          {nav('takeoff', 'Upload Mfr Quote')}
          {nav('shipments', `Shipments${inTransitCount > 0 ? ` (${inTransitCount})` : ''}`)}
          {nav('reminders', `Reminders${reminders.length > 0 ? ` (${reminders.length})` : ''}`)}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '0.5px solid #e5e5e0' }}>
          <div style={{ fontWeight: 500, fontSize: 12 }}>Cole Isetts</div>
          <div style={{ color: '#888', fontSize: 11 }}>Sales · Aurora, CO</div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 24px', background: '#fff', borderBottom: '0.5px solid #e5e5e0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 500, fontSize: 16 }}>
            {view === 'dashboard' && 'Dashboard'}
            {view === 'jobs' && 'Jobs'}
            {view === 'takeoff' && 'Upload Manufacturer Quote'}
            {view === 'agent-pipeline' && '⚡ Agent Pipeline'}
            {view === 'shipments' && 'Shipments'}
            {view === 'reminders' && 'Reminders'}
            {view === 'job-detail' && selectedJob?.name}
          </div>
          <button onClick={() => setShowNewJob(true)} style={{ padding: '6px 14px', fontSize: 12, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>+ New Job</button>
        </div>

        <div style={{ padding: view === 'agent-pipeline' ? 0 : 24, flex: 1 }}>

          {/* DASHBOARD */}
          {view === 'dashboard' && (
            <div>
              {(overdueReminders.length > 0 || delayedCount > 0) && (
                <div style={{ background: '#FAEEDA', border: '0.5px solid #EF9F27', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#633806', display: 'flex', gap: 16 }}>
                  {overdueReminders.length > 0 && <span>⚑ {overdueReminders.length} reminder{overdueReminders.length > 1 ? 's' : ''} overdue — <span onClick={() => setView('reminders')} style={{ textDecoration: 'underline', cursor: 'pointer' }}>view</span></span>}
                  {delayedCount > 0 && <span>🚚 {delayedCount} shipment{delayedCount > 1 ? 's' : ''} delayed — <span onClick={() => setView('shipments')} style={{ textDecoration: 'underline', cursor: 'pointer' }}>view</span></span>}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Pipeline Value', value: fmt(pipelineValue), sub: `${jobs.length} total jobs` },
                  { label: 'Active Bids', value: activeBids, sub: 'in bid stage' },
                  { label: 'Avg Margin', value: fmtPct(avgMargin), sub: 'across priced jobs' },
                  { label: 'In Transit', value: inTransitCount, sub: 'loads on the way', alert: delayedCount > 0 },
                ].map(m => (
                  <div key={m.label} style={{ background: m.alert ? '#FAEEDA' : '#f5f5f3', borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, color: '#888', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{m.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 500, color: m.alert ? '#854F0B' : 'inherit' }}>{loading ? '—' : m.value}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{m.sub}</div>
                  </div>
                ))}
              </div>

              {allActiveShipments.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13 }}>Active Shipments</div>
                  <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead><tr style={{ background: '#f5f5f3' }}>
                        {['Job', 'Load', 'Carrier', 'Expected', 'Floors / Units', 'Cabinets', 'Status'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {allActiveShipments.map(s => (
                          <tr key={s.id} style={{ borderBottom: '0.5px solid #f0f0ec', background: s.status === 'Delayed' ? '#FFF8F0' : '' }}
                            onClick={() => { const job = jobs.find(j => j.id === s.job_id); if (job) { setSelectedJob(job); setView('job-detail') } }}
                            onMouseEnter={e => e.currentTarget.style.cursor = 'pointer'}>
                            <td style={{ padding: '8px 12px', fontWeight: 500 }}>{s.jobs?.name || '—'}</td>
                            <td style={{ padding: '8px 12px', color: '#555' }}>Load {s.load_number} of {s.total_loads}</td>
                            <td style={{ padding: '8px 12px', color: '#555' }}>{s.carrier}</td>
                            <td style={{ padding: '8px 12px', color: s.status === 'Delayed' ? '#A32D2D' : '#555', fontWeight: s.status === 'Delayed' ? 500 : 400 }}>{s.scheduled_date || '—'}</td>
                            <td style={{ padding: '8px 12px', color: '#555' }}>{s.floors_covered || '—'}</td>
                            <td style={{ padding: '8px 12px', color: '#555' }}>{s.cabinet_count ? s.cabinet_count.toLocaleString() : '—'}</td>
                            <td style={{ padding: '8px 12px' }}><ShipmentBadge status={s.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13 }}>Job Pipeline</div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGES.length - 1},1fr)`, gap: 8, overflowX: 'auto' }}>
                {STAGES.filter(s => s !== 'Lost').map(stage => (
                  <div key={stage} style={{ background: '#f5f5f3', borderRadius: 8, padding: 10, minHeight: 80 }}>
                    <div style={{ fontSize: 10, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                      {stage} <span style={{ background: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{jobs.filter(j => j.stage === stage).length}</span>
                    </div>
                    {jobs.filter(j => j.stage === stage).sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(job => (
                      <div key={job.id} onClick={() => { setSelectedJob(job); setView('job-detail') }}
                        style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 6, padding: 10, marginBottom: 6, cursor: 'pointer' }}>
                        <div style={{ fontWeight: 500, fontSize: 12 }}>{job.name}</div>
                        <div style={{ fontSize: 11, color: '#888' }}>{job.gc_name || '—'}</div>
                        <div style={{ fontSize: 12, fontWeight: 500, color: '#3C3489', marginTop: 4 }}>{fmt(job.bid_value)}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {jobs.filter(j => j.stage === 'Lost').length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13, color: '#A32D2D', display: 'flex', alignItems: 'center', gap: 8 }}>
                    Jobs Lost
                    <span style={{ background: '#FCEBEB', color: '#A32D2D', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 500 }}>
                      {jobs.filter(j => j.stage === 'Lost').length}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {jobs.filter(j => j.stage === 'Lost').map(job => (
                      <div key={job.id} onClick={() => { setSelectedJob(job); setView('job-detail') }}
                        style={{ background: '#FCEBEB', border: '0.5px solid #E8BABA', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: 12, color: '#A32D2D' }}>{job.name}</div>
                          <div style={{ fontSize: 11, color: '#C06060' }}>{job.gc_name || '—'}</div>
                        </div>
                        {job.bid_value > 0 && <div style={{ fontSize: 12, color: '#A32D2D', fontWeight: 500 }}>{fmt(job.bid_value)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* JOBS LIST */}
          {view === 'jobs' && (() => {
            const owners = ['All', ...[...new Set(jobs.map(j => j.owner).filter(Boolean))].sort()]
            const gcs = ['All', ...[...new Set(jobs.map(j => (j.gc_name || '').trim()).filter(Boolean))].sort()]
            const q = jobSearch.trim().toLowerCase()
            const filteredJobs = jobs.filter(j =>
              (ownerFilter === 'All' || j.owner === ownerFilter) &&
              (gcFilter === 'All' || (j.gc_name || '').trim() === gcFilter) &&
              (!q || [j.name, j.gc_name, j.manufacturer, j.address, j.city, j.stage].some(v => (v || '').toLowerCase().includes(q)))
            )
            return (
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  value={jobSearch}
                  onChange={e => setJobSearch(e.target.value)}
                  placeholder="🔍 Search jobs — name, GC, manufacturer, city..."
                  style={{ flex: 1, minWidth: 240, padding: '9px 14px', border: '0.5px solid #ccc', borderRadius: 8, fontSize: 13 }}
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  {owners.map(o => (
                    <button key={o} onClick={() => setOwnerFilter(o)}
                      style={{ padding: '6px 14px', fontSize: 12, borderRadius: 8, cursor: 'pointer', fontWeight: 500,
                        background: ownerFilter === o ? '#3C3489' : '#f5f5f3',
                        color: ownerFilter === o ? '#fff' : '#555',
                        border: '0.5px solid ' + (ownerFilter === o ? '#3C3489' : '#ddd') }}>
                      {o}{o !== 'All' ? ` (${jobs.filter(j => j.owner === o).length})` : ''}
                    </button>
                  ))}
                </div>
                <select value={gcFilter} onChange={e => setGcFilter(e.target.value)} style={{ padding: '7px 10px', fontSize: 12, border: '0.5px solid #ccc', borderRadius: 8, maxWidth: 200 }}>
                  {gcs.map(g => <option key={g} value={g}>{g === 'All' ? 'All GCs' : g}</option>)}
                </select>
                <span style={{ fontSize: 11, color: '#888' }}>{filteredJobs.length} of {jobs.length}</span>
              </div>
            <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ background: '#f5f5f3' }}>
                  {['Project', 'GC', 'Stage', 'Manufacturer', 'Cabinets', 'Bid Value', 'Margin', 'Owner'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#888' }}>Loading...</td></tr>
                  : filteredJobs.map(job => {
                    const c = STAGE_COLORS[job.stage] || STAGE_COLORS['Bid']
                    return (
                      <tr key={job.id} onClick={() => { setSelectedJob(job); setView('job-detail') }}
                        style={{ cursor: 'pointer', borderBottom: '0.5px solid #f0f0ec' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#fafaf8'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        <td style={{ padding: '10px 14px', fontWeight: 500 }}>{job.name}</td>
                        <td style={{ padding: '10px 14px', color: '#555' }}>{job.gc_name || '—'}</td>
                        <td style={{ padding: '10px 14px' }}><span style={{ background: c.bg, color: c.text, borderRadius: 10, padding: '2px 8px', fontSize: 10, fontWeight: 500 }}>{job.stage}</span></td>
                        <td style={{ padding: '10px 14px', color: '#555' }}>{job.manufacturer}</td>
                        <td style={{ padding: '10px 14px', color: '#555' }}>{job.total_cabinet_count || '—'}</td>
                        <td style={{ padding: '10px 14px', fontWeight: 500 }}>{fmt(job.bid_value)}</td>
                        <td style={{ padding: '10px 14px', color: (job.gross_margin_pct || 0) >= 0.25 ? '#3B6D11' : '#854F0B', fontWeight: 500 }}>{fmtPct(job.gross_margin_pct)}</td>
                        <td style={{ padding: '10px 14px', color: '#555' }}>{job.owner}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          
            </div>
            )
          })()}

          {/* JOB DETAIL */}
          {view === 'job-detail' && selectedJob && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div onClick={() => { setView('jobs'); setConfirmDelete(false) }} style={{ fontSize: 12, color: '#888', cursor: 'pointer' }}>← <span style={{ color: '#3C3489' }}>Jobs</span> / {selectedJob.name}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {confirmDelete ? (
                    <>
                      <span style={{ fontSize: 11, color: '#A32D2D' }}>Delete "{selectedJob.name}" and all its data?</span>
                      <button onClick={deleteJob} disabled={deletingJob} style={{ padding: '4px 12px', fontSize: 11, background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 6, cursor: deletingJob ? 'default' : 'pointer', fontWeight: 600 }}>{deletingJob ? 'Deleting...' : 'Yes, Delete'}</button>
                      <button onClick={() => setConfirmDelete(false)} style={{ padding: '4px 10px', fontSize: 11, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDelete(true)} style={{ padding: '4px 10px', fontSize: 11, background: '#FCEBEB', color: '#A32D2D', border: '0.5px solid #E8BABA', borderRadius: 6, cursor: 'pointer' }}>Delete Job</button>
                  )}
                </div>
              </div>

              <div style={{ ...card, marginBottom: 16, padding: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 10 }}>Pipeline Stage</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {STAGES.map(stage => {
                    const c = STAGE_COLORS[stage]; const isCurrent = selectedJob.stage === stage
                    return <button key={stage} onClick={() => updateStage(stage)} disabled={stageUpdating}
                      style={{ padding: '6px 12px', fontSize: 11, borderRadius: 6, cursor: 'pointer', fontWeight: isCurrent ? 600 : 400,
                        background: isCurrent ? c.bg : '#f5f5f3', color: isCurrent ? c.text : '#888',
                        border: isCurrent ? `1.5px solid ${c.text}` : '0.5px solid #ddd' }}>{stage}</button>
                  })}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 16 }}>{selectedJob.name}</div>
                    {[['General Contractor', selectedJob.gc_name], ['Address', [selectedJob.address, selectedJob.city, selectedJob.state, selectedJob.zip].filter(Boolean).join(', ')], ['Manufacturer', selectedJob.manufacturer], ['Quote #', selectedJob.manufacturer_quote_number], ['Total Units', selectedJob.total_residential_units], ['Total Cabinets', selectedJob.total_cabinet_count], ['Bid Due', selectedJob.bid_due_date], ['Owner', selectedJob.owner]].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label} style={{ marginBottom: 10 }}>
                        <div style={lbl}>{label}</div>
                        <div style={{ fontSize: 13 }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  <div style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                      <div style={{ fontWeight: 500 }}>Proposal Details</div>
                      {!editingProposal
                        ? <button onClick={() => setEditingProposal(true)} style={{ fontSize: 11, padding: '4px 12px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>Edit</button>
                        : <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={saveProposalEdits} disabled={savingEdits} style={{ fontSize: 11, padding: '4px 12px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{savingEdits ? 'Saving...' : 'Save'}</button>
                            <button onClick={() => setEditingProposal(false)} style={{ fontSize: 11, padding: '4px 12px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                          </div>
                      }
                    </div>
                    {!editingProposal ? (
                      <div>
                        {[['Door Style', selectedJob.door_style], ['Finish / Color', selectedJob.finish_color], ['Box Construction', selectedJob.box_construction], ['Hardware Allowance', selectedJob.hardware_allowance ? fmt(selectedJob.hardware_allowance) : null], ['Scope Notes', selectedJob.scope_notes]].filter(([, v]) => v).map(([label, value]) => (
                          <div key={label} style={{ marginBottom: 10 }}>
                            <div style={lbl}>{label}</div>
                            <div style={{ fontSize: 13 }}>{value}</div>
                          </div>
                        ))}
                        {editUnitTypes.length > 0 && (
                          <div style={{ marginTop: 10 }}>
                            <div style={lbl}>Unit Types</div>
                            {editUnitTypes.map((ut,i) => (
                              <div key={ut.id||i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: '0.5px solid #f5f5f3' }}>
                                <span>{ut.unit_type_name}</span>
                                <span style={{ color: '#888' }}>{ut.unit_quantity} unit{ut.unit_quantity!==1?'s':''} · {ut.cabinet_count} cab{ut.cabinet_count!==1?'s':''}{ut.manufacturer_price>0?' · $'+ut.manufacturer_price.toLocaleString():''}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div style={{ fontSize:11, color:'#888', fontWeight:600, textTransform:'uppercase', letterSpacing:0.4, marginBottom:8 }}>Job Info</div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={lbl}>Job Name</label>
                          <input value={editFields.name} onChange={e => setEditFields(pv => ({ ...pv, name: e.target.value }))} style={{ ...inp, fontWeight: 600 }} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                          <div><label style={lbl}>General Contractor</label><input value={editFields.gc_name} onChange={e => setEditFields(p => ({ ...p, gc_name: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>Manufacturer</label><input value={editFields.manufacturer} onChange={e => setEditFields(p => ({ ...p, manufacturer: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>Address</label><input value={editFields.address} onChange={e => setEditFields(p => ({ ...p, address: e.target.value }))} style={inp} /></div>
                          <div style={{ display:'flex', gap:6 }}>
                            <div style={{ flex:2 }}><label style={lbl}>City</label><input value={editFields.city} onChange={e => setEditFields(p => ({ ...p, city: e.target.value }))} style={inp} /></div>
                            <div style={{ flex:1 }}><label style={lbl}>State</label><input value={editFields.state} onChange={e => setEditFields(p => ({ ...p, state: e.target.value }))} style={inp} /></div>
                            <div style={{ flex:1 }}><label style={lbl}>Zip</label><input value={editFields.zip} onChange={e => setEditFields(p => ({ ...p, zip: e.target.value }))} style={inp} /></div>
                          </div>
                          <div><label style={lbl}>GC Contact</label><input value={editFields.gc_contact} onChange={e => setEditFields(p => ({ ...p, gc_contact: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>GC Phone</label><input value={editFields.gc_phone} onChange={e => setEditFields(p => ({ ...p, gc_phone: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>GC Email</label><input value={editFields.gc_email} onChange={e => setEditFields(p => ({ ...p, gc_email: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>Bid Due Date</label><input type="date" value={editFields.bid_due_date} onChange={e => setEditFields(p => ({ ...p, bid_due_date: e.target.value }))} style={inp} /></div>
                        </div>
                        <div style={{ fontSize:11, color:'#888', fontWeight:600, textTransform:'uppercase', letterSpacing:0.4, marginBottom:8, marginTop:4 }}>Cabinet Specs</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                          <div><label style={lbl}>Door Style</label><input value={editFields.door_style} onChange={e => setEditFields(p => ({ ...p, door_style: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>Finish / Color</label><input value={editFields.finish_color} onChange={e => setEditFields(p => ({ ...p, finish_color: e.target.value }))} style={inp} /></div>
                        </div>
                        <div style={{ marginBottom: 12 }}><label style={lbl}>Box Construction</label><input value={editFields.box_construction} onChange={e => setEditFields(p => ({ ...p, box_construction: e.target.value }))} style={inp} /></div>
                        <div style={{ marginBottom: 12 }}><label style={lbl}>Hardware Allowance ($)</label><input type="number" value={editFields.hardware_allowance} onChange={e => setEditFields(p => ({ ...p, hardware_allowance: e.target.value }))} style={{ ...inp, width: 120 }} /></div>
                        <div style={{ marginBottom: 14 }}><label style={lbl}>Scope Notes</label><textarea value={editFields.scope_notes} onChange={e => setEditFields(p => ({ ...p, scope_notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} /></div>
                        {editUnitTypes.length > 0 && (
                          <div style={{ marginBottom: 14 }}>
                            <label style={lbl}>Unit Type Quantities</label>
                            <div style={{ background: '#f9f9f9', borderRadius: 6, padding: 10 }}>
                              {editUnitTypes.map((ut, i) => (
                                <div key={ut.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                  <span style={{ flex: 1, fontSize: 12 }}>{ut.unit_type_name}</span>
                                  <label style={{ fontSize: 10, color: '#888' }}>Units:</label>
                                  <input type="number" min="0" value={ut.unit_quantity}
                                    onChange={e => { const u = [...editUnitTypes]; u[i] = { ...ut, unit_quantity: Number(e.target.value) }; setEditUnitTypes(u) }}
                                    style={{ width: 60, padding: '4px 6px', border: '0.5px solid #ccc', borderRadius: 4, fontSize: 12 }} />
                                  <span style={{ fontSize: 11, color: '#888' }}>{ut.cabinet_count} cabs</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <label style={lbl}>Additional Line Items</label>
                            <button onClick={() => setAdditionalLineItems(p => [...p, { description: '', amount: 0 }])} style={{ fontSize: 10, padding: '3px 8px', background: 'transparent', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Add</button>
                          </div>
                          {additionalLineItems.length === 0 && <div style={{ fontSize: 11, color: '#aaa' }}>No additional items</div>}
                          {additionalLineItems.map((item, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                              <input placeholder="Description" value={item.description} onChange={e => { const u = [...additionalLineItems]; u[i] = { ...item, description: e.target.value }; setAdditionalLineItems(u) }} style={{ flex: 1, padding: '6px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12 }} />
                              <input type="number" placeholder="$" value={item.amount} onChange={e => { const u = [...additionalLineItems]; u[i] = { ...item, amount: Number(e.target.value) }; setAdditionalLineItems(u) }} style={{ width: 80, padding: '6px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12 }} />
                              <button onClick={() => setAdditionalLineItems(p => p.filter((_, j) => j !== i))} style={{ padding: '4px 8px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ fontWeight: 500 }}>Cabinet Schedule</div>
                      {selectedJob.total_cabinet_count > 0 && (
                        <button onClick={async () => {
                            try {
                              const { data: uts } = await supabase.from('unit_types').select('*, cabinet_line_items(*)').eq('job_id', selectedJob.id).order('sort_order')
                              if (!uts?.length) return alert('No cabinet data saved yet')
                              const takeoffData = {
                                project_name: selectedJob.name,
                                unit_types: uts.map(ut => ({
                                  unit_type_name: ut.unit_type_name, unit_quantity: ut.unit_quantity || 1, cabinet_count: ut.cabinet_count || 0,
                                  skus:    (ut.cabinet_line_items || []).filter(li => li.sort_order < 1000).map(li => ({ sku: li.sku, description: li.description, quantity_per_unit: li.quantity, hinge_side: li.hinge_side })),
                                  fillers: (ut.cabinet_line_items || []).filter(li => li.sort_order >= 1000).map(li => ({ sku: li.sku, description: li.description, quantity_per_unit: li.quantity })),
                                })),
                                specs: { cabinet_line: selectedJob.manufacturer || 'TBD', door_style: selectedJob.door_style || 'TBD', finish: selectedJob.finish_color || 'TBD', box_construction: selectedJob.box_construction || 'TBD' },
                              }
                              const res = await fetch('/api/export/excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ takeoffData, projectName: selectedJob.name, supplierName: selectedJob.manufacturer || 'TBD', catalogRef: 'TBD', printDate: new Date().toLocaleDateString('en-US') }) })
                              if (!res.ok) throw new Error('Export failed')
                              const blob = await res.blob(); const url = URL.createObjectURL(blob)
                              const a = document.createElement('a'); a.href = url
                              a.download = `${selectedJob.name.replace(/[^a-zA-Z0-9_-]/g,'_')}_Cabinet_Schedule.xlsx`
                              a.click(); URL.revokeObjectURL(url)
                            } catch (err) { alert('Download failed: ' + err.message) }
                          }}
                          style={{ padding: '4px 12px', fontSize: 11, background: '#2D7A3A', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>
                          ⬇ Download Excel
                        </button>
                      )}
                    </div>
                    {selectedJob.total_cabinet_count > 0 ? (
                      <div>
                        <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                          <div><div style={lbl}>Total Cabinets</div><div style={{ fontSize: 22, fontWeight: 700, color: '#3C3489' }}>{selectedJob.total_cabinet_count.toLocaleString()}</div></div>
                          <div><div style={lbl}>Unit Types</div><div style={{ fontSize: 22, fontWeight: 700, color: '#3C3489' }}>{(selectedJob.unit_types || []).length}</div></div>
                        </div>
                        {(selectedJob.unit_types || []).sort((a,b) => a.sort_order - b.sort_order).map(ut => (
                          <div key={ut.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: '0.5px solid #f0f0ec' }}>
                            <span>{ut.unit_type_name}</span>
                            <span style={{ color: '#888' }}>{ut.unit_quantity} units · {(ut.cabinet_count || 0).toLocaleString()} cabs · {((ut.cabinet_count || 0) * (ut.unit_quantity || 1)).toLocaleString()} total</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: '#aaa', fontSize: 12 }}>No cabinet data saved yet — use the <span style={{ color: '#3C3489', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setView('agent-pipeline')}>⚡ Agent Pipeline</span> to extract and save</div>
                    )}
                  </div>

                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 12 }}>Upload Manufacturer Quote PDF</div>
                    <label style={{ display: 'block', border: '1.5px dashed #ccc', borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer', background: '#fafaf8' }}>
                      <div style={{ color: '#555', fontSize: 13 }}>{quoteUploading ? 'Parsing with AI...' : 'Click to upload PDF quote'}</div>
                      <div style={{ color: '#999', fontSize: 11, marginTop: 4 }}>Leedo · Skyline · SMART · Ukon</div>
                      <input type="file" accept=".pdf,.xlsx,.xlsm" onChange={handleQuoteUpload} style={{ display: 'none' }} disabled={quoteUploading} />
                    </label>
                    {quoteResult && (
                      <div style={{ marginTop: 12, padding: 12, background: '#EAF3DE', borderRadius: 8, fontSize: 12 }}>
                        <div style={{ fontWeight: 500, color: '#3B6D11', marginBottom: 4 }}>Parsed successfully</div>
                        <div>Manufacturer: {quoteResult.summary.manufacturer} · Unit types: {quoteResult.summary.unit_type_count} · Cabinets: {quoteResult.summary.total_cabinets?.toLocaleString()}</div>
                        <div style={{ fontWeight: 500 }}>Grand total: {fmt(quoteResult.summary.grand_total)}</div>
                        {quoteResult.quote_recorded === false && <div style={{ color:'#A32D2D', fontWeight:600, marginTop:4 }}>⚠ Quote history NOT saved: {quoteResult.quote_record_error}</div>}
                        {quoteResult.quote_recorded === true && <div style={{ color:'#2D7A3A', marginTop:4 }}>✓ Saved to quote history</div>}
                      </div>
                    )}
                    <div style={{ marginTop: 10 }}>
                      <button onClick={runQuoteCheck} disabled={quoteChecking} style={{ padding:'6px 14px', fontSize:12, background:'#8B4513', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:500 }}>{quoteChecking ? 'Checking...' : '⚖ Check Quote vs Cabinet List'}</button>
                      <span style={{ fontSize:11, color:'#999', marginLeft:8 }}>Compares the latest uploaded quote against this job's cabinet list</span>
                    </div>
                    {quoteCheck && (
                          <div style={{ marginBottom:10, border:'0.5px solid ' + (quoteCheck.error ? '#ddd' : quoteCheck.clean ? '#4caf50' : '#e0a800'), borderRadius:8, padding:'10px 12px', background: quoteCheck.error ? '#fafaf8' : quoteCheck.clean ? '#f0f9f0' : '#fdf8ec' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                              <div style={{ fontSize:12, fontWeight:600, color: quoteCheck.error ? '#888' : quoteCheck.clean ? '#2D7A3A' : '#8B6914' }}>
                                {quoteCheck.error ? quoteCheck.error : (quoteCheck.clean ? '✓ ' : '⚠ ') + quoteCheck.summary}
                              </div>
                              <button onClick={()=>setQuoteCheck(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:13 }}>✕</button>
                            </div>
                            {!quoteCheck.error && quoteCheck.issues?.length > 0 && (
                              <div style={{ maxHeight:180, overflowY:'auto', marginTop:8 }}>
                                {quoteCheck.issues.map((iss, ix) => (
                                  <div key={ix} style={{ fontSize:11, padding:'3px 0', borderTop:'0.5px dotted #eee', color: iss.level==='unit' ? '#A32D2D' : '#8B6914' }}>
                                    <strong>{iss.unit}</strong>{iss.sku ? ' · ' + iss.sku : ''} — {iss.detail}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                  </div>

                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 14 }}>Generate Proposal PDF</div>
                    <div style={{ marginBottom: 14 }}>
                      <label style={lbl}>Manufacturer Gross Cost ($ — from Leedo printable summary)</label>
                      <input type="number" min="0" value={proposalGross} placeholder="e.g. 140000" onChange={e => setProposalGross(e.target.value)} style={{ width: 160, padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13, marginBottom: 10 }} />
                      <div style={{ display:'flex', gap:10, marginBottom:10 }}>
                        <div>
                          <label style={lbl}>Freight $ (pass-through)</label>
                          <input type="number" min="0" value={proposalFreight} placeholder="0" onChange={e=>setProposalFreight(e.target.value)} style={{ width:120, padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:13 }}/>
                        </div>
                        <div>
                          <label style={lbl}>Mfr Tax $ (pass-through)</label>
                          <input type="number" min="0" value={proposalMfrTax} placeholder="0" onChange={e=>setProposalMfrTax(e.target.value)} style={{ width:120, padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:13 }}/>
                        </div>
                      </div>
                      <label style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, cursor:'pointer', fontSize:12, color:'#555' }}>
                        <input type="checkbox" checked={applyDiscount} onChange={e=>setApplyDiscount(e.target.checked)} style={{ width:15, height:15, cursor:'pointer' }}/>
                        Apply dealer discount ({((selectedJob?.dealer_discount_pct || 0.05)*100).toFixed(0)}%) to gross cost
                      </label>
                      <label style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, cursor:'pointer', fontSize:12, color:'#555' }}>
                        <input type="checkbox" checked={hideUnitPricing} onChange={e=>setHideUnitPricing(e.target.checked)} style={{ width:15, height:15, cursor:'pointer' }}/>
                        Hide unit breakdown — lump sum only (shows unit/amenity counts, no per-unit table)
                      </label>
                      <div style={{ display:'flex', gap:10, alignItems:'flex-end', marginBottom:12 }}>
                        <div>
                          <label style={lbl}>Hardware Pieces</label>
                          <input type="number" min="0" value={hwPieces} placeholder="0" onChange={e=>setHwPieces(e.target.value)} style={{ width:100, padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:13 }}/>
                        </div>
                        <div>
                          <label style={lbl}>$/Piece (our cost)</label>
                          <input type="number" min="0" step="0.25" value={hwRate} onChange={e=>setHwRate(e.target.value)} style={{ width:90, padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:13 }}/>
                        </div>
                        {Number(hwPieces)>0 && <span style={{ fontSize:11, color:'#2D7A3A', paddingBottom:9 }}>= ${(Number(hwPieces)*Number(hwRate)).toLocaleString(undefined,{maximumFractionDigits:0})} cost → marked up with margin</span>}
                      </div>
                      <label style={lbl}>Gross Margin %</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <input type="number" step="1" min="0" max="60" value={proposalMargin} onChange={e => setProposalMargin(e.target.value)} style={{ width: 80, padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }} />
                        {marginPricePreview && <span style={{ fontSize: 12, color: '#3B6D11', fontWeight: 500 }}>→ sell price ≈ {marginPricePreview} (before freight/discount/tax)</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[15, 20, 25, 30, 35].map(m => (<button key={m} onClick={() => setProposalMargin(m)} style={{ padding: '4px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer', background: Number(proposalMargin) === m ? '#3C3489' : '#f5f5f3', color: Number(proposalMargin) === m ? '#fff' : '#555', border: '0.5px solid #ddd' }}>{m}%</button>))}
                      </div>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                      <label style={lbl}>Sales Tax %</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="number" step="0.01" min="0" max="20" value={proposalSalesTax} onChange={e => setProposalSalesTax(e.target.value)} style={{ width: 80, padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }} />
                        <span style={{ fontSize: 12, color: '#555' }}>%</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {[0, 7.65, 8.00, 9.15].map(t => (<button key={t} onClick={() => setProposalSalesTax(t)} style={{ padding: '3px 8px', fontSize: 10, borderRadius: 6, cursor: 'pointer', background: Number(proposalSalesTax) === t ? '#3C3489' : '#f5f5f3', color: Number(proposalSalesTax) === t ? '#fff' : '#555', border: '0.5px solid #ddd' }}>{t === 0 ? 'None' : `${t}%`}</button>))}
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Sender</label>
                      <select value={proposalSender} onChange={e => setProposalSender(e.target.value)} style={{ width: '100%', padding: '8px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }}>
                        <option>Cole</option><option>Pam</option><option>Blake</option>
                      </select>
                    </div>
                    {[
                      ['includedInBid', 'Included in Bid', 40],
                      ['assembly', 'Assembly, Staging & Installation', 48],
                      ['notIncluded', 'Not Included in Bid (one bullet per line)', 90],
                      ['bottomNotes', 'Proposal Notes (bottom of PDF)', 48],
                      ['aliases', 'Unit Name Aliases — merge quote names into takeoff names (QUOTE NAME=TAKEOFF NAME, one per line, e.g. UNIT B=UNIT X-B)', 40],
                    ].map(([key, label, h]) => (
                      <div key={key} style={{ marginBottom: 12 }}>
                        <label style={lbl}>{label}</label>
                        <textarea value={bidSections[key]} onChange={e => setBidSections(p => ({ ...p, [key]: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 11.5, height: h, resize: 'vertical', fontFamily: 'inherit' }} />
                      </div>
                    ))}
                    <button onClick={() => setBidSections(DEFAULT_BID_SECTIONS)} style={{ marginBottom: 14, padding: '4px 10px', fontSize: 11, borderRadius: 6, cursor: 'pointer', background: '#f5f5f3', color: '#555', border: '0.5px solid #ddd' }}>↺ Reset bid sections to defaults</button>
                    <div style={{ marginBottom: 16 }}>
                      <label style={lbl}>Notes (optional)</label>
                      <textarea value={proposalNotes} onChange={e => setProposalNotes(e.target.value)} placeholder="Any additional notes..." style={{ width: '100%', padding: '8px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, height: 60, resize: 'vertical' }} />
                    </div>
                    <button onClick={generateProposal} disabled={proposalLoading} style={{ width: '100%', padding: 10, background: proposalLoading ? '#888' : '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: proposalLoading ? 'default' : 'pointer', fontSize: 13, fontWeight: 500 }}>
                      {proposalLoading ? 'Generating PDF...' : 'Generate & Download Proposal PDF'}
                    </button>
                  </div>
                </div>

                <div>
                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 16 }}>Pricing Summary</div>
                    {[['Manufacturer Gross', selectedJob.manufacturer_gross_cost], ['Freight', selectedJob.freight_cost]].map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, borderBottom: '0.5px solid #f0f0ec' }}>
                        <span style={{ color: '#555' }}>{label}</span><span style={{ fontWeight: 500 }}>{fmt(value)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, borderBottom: '0.5px solid #f0f0ec', color: '#3B6D11' }}>
                      <span>Dealer Discount ({((selectedJob.dealer_discount_pct || 0.05) * 100).toFixed(0)}%)</span>
                      <span style={{ fontWeight: 500 }}>− {fmt((selectedJob.manufacturer_gross_cost || 0) * (selectedJob.dealer_discount_pct || 0.05))}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', fontSize: 16, fontWeight: 500 }}>
                      <span>Bid to GC</span><span style={{ color: '#3C3489' }}>{fmt(selectedJob.bid_value)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                      <span style={{ color: '#888' }}>Gross Margin</span>
                      <span style={{ color: (selectedJob.gross_margin_pct || 0) >= 0.25 ? '#3B6D11' : '#854F0B', fontWeight: 500 }}>{fmtPct(selectedJob.gross_margin_pct)}</span>
                    </div>
                  </div>

                  {/* ── Cab List ───────────────────────────────────────── */}
                  <div style={card}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                      <div style={{ fontWeight:500 }}>Cabinet List</div>
                      {cabList && !cabEditing && (
                        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                          {['framed','frameless'].map(pl => (
                            <button key={pl} onClick={async()=>{ const upd2 = { ...cabList, product_line: pl }; await saveCabList(upd2, 'product line → ' + pl) }} style={{ padding:'4px 10px', fontSize:11, borderRadius:6, cursor:'pointer', textTransform:'capitalize', background:(cabList.product_line||'framed')===pl?'#3C3489':'#f5f5f3', color:(cabList.product_line||'framed')===pl?'#fff':'#888', border:'0.5px solid #ddd' }}>{pl}</button>
                          ))}
                          <button onClick={exportCabList} disabled={cabExporting} style={{ padding:'4px 12px', fontSize:11, background:'#2D7A3A', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:500 }}>{cabExporting ? 'Exporting...' : '⬇ Export (2 files)'}</button>
                          <button onClick={startCabEdit} style={{ padding:'4px 12px', fontSize:11, background:'#3C3489', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:500 }}>✎ Edit</button>
                          <label style={{ padding:'4px 12px', fontSize:11, background:'#f5f5f3', color:'#555', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer' }}>
                            {cabSeeding ? 'Importing...' : 'Re-import'}
                            <input type="file" accept=".xlsx,.xlsm" onChange={seedCabListFromExcel} style={{ display:'none' }} disabled={cabSeeding}/>
                          </label>
                          <label style={{ padding:'4px 12px', fontSize:11, background:'#f5f5f3', color:'#1B5EA6', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer' }}>
                            Leedo PDF
                            <input type="file" accept=".pdf" onChange={importLeedoSummary} style={{ display:'none' }} disabled={cabSeeding}/>
                          </label>
                          <select value={cabCopyTarget} onChange={e=>setCabCopyTarget(e.target.value)} style={{ padding:'4px 8px', fontSize:11, border:'0.5px solid #ddd', borderRadius:6, maxWidth:150 }}>
                            <option value="">Copy to job...</option>
                            {jobs.filter(j => j.id !== selectedJob.id).map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
                          </select>
                          {cabCopyTarget && <button onClick={copyCabListToJob} style={{ padding:'4px 12px', fontSize:11, background:'#3C3489', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:500 }}>Copy</button>}
                          <button onClick={async()=>{ if(!confirm('Clear the entire cabinet list for this job? This cannot be undone.')) return; await fetch('/api/cab-list', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jobId: selectedJob.id }) }); setCabList(null); setQuoteCheck(null) }} style={{ padding:'4px 12px', fontSize:11, background:'#fff', color:'#A32D2D', border:'0.5px solid #e0b4b4', borderRadius:6, cursor:'pointer', marginLeft:'auto' }}>Clear List</button>
                        </div>
                      )}
                      {cabEditing && (
                      <datalist id="leedo-sku-suggest">
                        {skuSuggest.map(it => <option key={it.sku} value={it.sku}>{it.description || ''}</option>)}
                      </datalist>
                    )}
                    {cabList && cabEditing && (
                        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                          {['framed','frameless'].map(pl => (
                            <button key={pl} onClick={()=>cabDraftUpdate(n=>{ n.product_line = pl })} style={{ padding:'4px 10px', fontSize:11, borderRadius:6, cursor:'pointer', textTransform:'capitalize', background:(cabDraft?.product_line||'framed')===pl?'#3C3489':'#f5f5f3', color:(cabDraft?.product_line||'framed')===pl?'#fff':'#888', border:'0.5px solid #ddd' }}>{pl}</button>
                          ))}
                          <button onClick={saveCabEdit} disabled={cabSaving} style={{ padding:'4px 14px', fontSize:11, background:'#2D7A3A', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}>{cabSaving ? 'Saving...' : '✓ Save'}</button>
                          <button onClick={() => { setCabEditing(false); setCabDraft(null) }} style={{ padding:'4px 12px', fontSize:11, background:'#f5f5f3', color:'#555', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer' }}>Cancel</button>
                        </div>
                      )}
                    </div>
                    {cabListLoading && <div style={{ fontSize:11, color:'#888' }}>Loading...</div>}
                    {!cabListLoading && !cabList && (
                      <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                        <label style={{ padding:'8px 16px', fontSize:12, background:'#3C3489', color:'#fff', borderRadius:6, cursor:'pointer', fontWeight:500 }}>
                          {cabSeeding ? 'Importing...' : '⬆ Seed from Excel'}
                          <input type="file" accept=".xlsx,.xlsm" onChange={seedCabListFromExcel} style={{ display:'none' }} disabled={cabSeeding}/>
                        </label>
                        <span style={{ fontSize:11, color:'#888' }}>Product line:</span>
                        {['framed','frameless'].map(pl => (
                          <button key={pl} onClick={()=>setProductLine(pl)} style={{ padding:'6px 12px', fontSize:12, borderRadius:6, cursor:'pointer', textTransform:'capitalize', background:productLine===pl?'#3C3489':'#f5f5f3', color:productLine===pl?'#fff':'#555', border:'0.5px solid #ddd' }}>{pl}</button>
                        ))}
                        <label style={{ padding:'8px 16px', fontSize:12, background:'#1B5EA6', color:'#fff', borderRadius:6, cursor:'pointer', fontWeight:500 }}>
                          {cabSeeding ? 'Importing...' : '⬆ Import Leedo Summary (PDF)'}
                          <input type="file" accept=".pdf" onChange={importLeedoSummary} style={{ display:'none' }} disabled={cabSeeding}/>
                        </label>
                        <button onClick={startBlankCabList} style={{ padding:'8px 16px', fontSize:12, background:'#f5f5f3', color:'#555', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer' }}>Start Blank</button>
                        <span style={{ fontSize:11, color:'#bbb' }}>The editable cabinet list for this job lives here</span>
                      </div>
                    )}
                    {!cabListLoading && cabList && (() => {
                      const L = cabEditing ? cabDraft : cabList
                      const upd = cabDraftUpdate
                      return (
                      <div>
                        <div style={{ fontSize:11, color:'#888', marginBottom:10 }}>
                          {(() => {
                            const uts = L.unit_types || []
                            const totalUnits = uts.reduce((s,u)=>s+(Number(u.unit_quantity)||1),0)
                            const allPieces  = uts.reduce((s,u)=>s+([...(u.skus||[]),...(u.fillers||[])].reduce((x,r)=>x+(Number(r.quantity_per_unit)||0),0))*(Number(u.unit_quantity)||1),0)
                            const computedCabs = uts.reduce((s,u)=>s+(u.skus||[]).reduce((x,r)=>x+(Number(r.quantity_per_unit)||0),0)*(Number(u.unit_quantity)||1),0)
                            const trueCabs   = (cabEditing || L.sheet_totals?.cabinets == null) ? computedCabs : L.sheet_totals.cabinets
                            const extras     = Math.max(0, allPieces - trueCabs)
                            const kindCount = (k) => uts.filter(u => (u.kind || 'unit') === k).reduce((s,u)=>s+(Number(u.unit_quantity)||1),0)
                            const kindCabs  = (k) => uts.filter(u => (u.kind || 'unit') === k).reduce((s,u)=>s+(u.skus||[]).reduce((x,r)=>x+(Number(r.quantity_per_unit)||0),0)*(Number(u.unit_quantity)||1),0)
                            const nU = kindCount('unit'), nB = kindCount('bathroom'), nA = kindCount('amenity')
                            const kindStr = (nB > 0 || nA > 0)
                              ? `${nU} units (${kindCabs('unit').toLocaleString()} cabs)${nB > 0 ? ` · ${nB} bathrooms (${kindCabs('bathroom').toLocaleString()} cabs)` : ''}${nA > 0 ? ` · ${nA} amenities (${kindCabs('amenity').toLocaleString()} cabs)` : ''} · ${totalUnits} total areas`
                              : `${totalUnits} total units`
                            return `${uts.length} unit types · ${kindStr} · ${trueCabs.toLocaleString()} cabinets${extras > 0 ? ` · ${extras.toLocaleString()} additional pieces` : ''}`
                          })()}
                          {L.sheet_totals?.totalSF ? ` · ${L.sheet_totals.totalSF.toFixed(2)} SF countertop` : ''}
                          {L.product_line && <span style={{ color:'#3C3489', fontWeight:600, textTransform:'capitalize' }}> · {L.product_line}</span>}
                          {cabEditing && <span style={{ color:'#B8860B', fontWeight:600 }}> — EDITING</span>}
                        </div>
                        <div style={{ maxHeight:480, overflowY:'auto', border:'0.5px solid #eee', borderRadius:8 }}>
                          {(L.unit_types || []).map((ut, ui) => (
                            <div key={ui} style={{ borderBottom:'0.5px solid #eee' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'#EEEDFE', fontSize:12, fontWeight:600, position:'sticky', top:0, zIndex:1 }}>
                                {cabEditing ? (
                                  <>
                                    <input value={ut.unit_type_name} onChange={e=>upd(n=>{n.unit_types[ui].unit_type_name=e.target.value})} style={{ flex:1, padding:'3px 8px', border:'0.5px solid #ccc', borderRadius:4, fontSize:12, fontWeight:600 }}/>
                                    {['unit','bathroom','amenity'].map(k => (
                                      <button key={k} onClick={()=>upd(n=>{n.unit_types[ui].kind=k})}
                                        style={{ padding:'2px 8px', fontSize:10, borderRadius:5, cursor:'pointer', textTransform:'capitalize',
                                          background:(ut.kind||'unit')===k?'#3C3489':'#fff', color:(ut.kind||'unit')===k?'#fff':'#888',
                                          border:'0.5px solid '+((ut.kind||'unit')===k?'#3C3489':'#ccc') }}>{k}</button>
                                    ))}
                                    <label style={{ fontSize:10, color:'#888' }}>Qty:</label>
                                    <input type="number" min="1" value={ut.unit_quantity} onChange={e=>upd(n=>{n.unit_types[ui].unit_quantity=Number(e.target.value)||1})} style={{ width:56, padding:'3px 6px', border:'0.5px solid #ccc', borderRadius:4, fontSize:12 }}/>
                                    <button title="Duplicate unit" onClick={()=>upd(n=>{ const cp=JSON.parse(JSON.stringify(n.unit_types[ui])); cp.unit_type_name=cp.unit_type_name+' COPY'; n.unit_types.splice(ui+1,0,cp) })} style={{ background:'none', border:'none', cursor:'pointer', color:'#3C3489', fontSize:13 }}>⧉</button>
                                    <button onClick={()=>{ if(confirm(`Delete unit ${ut.unit_type_name}?`)) upd(n=>{n.unit_types.splice(ui,1)}) }} style={{ background:'none', border:'none', cursor:'pointer', color:'#A32D2D', fontSize:14 }}>✕</button>
                                  </>
                                ) : (
                                  <>
                                    <span style={{ flex:1 }}>{ut.unit_type_name}</span>
                                    <span style={{ color:'#3C3489' }}>{ut.unit_quantity} unit{ut.unit_quantity!==1?'s':''} · {(ut.skus||[]).reduce((s,r)=>s+(Number(r.quantity_per_unit)||0),0)} cabs/unit{typeof ut.excelSubtotalSF==='number' ? ` · ${ut.excelSubtotalSF.toFixed(2)} SF` : ''}</span>
                                  </>
                                )}
                              </div>
                              {[...CAB_CATEGORIES, ...[...new Set([...(ut.skus||[]),...(ut.fillers||[])].map(r=>r.category).filter(cat=>cat&&!CAB_CATEGORIES.includes(cat)))]].map(cat => {
                                const skuRows = (ut.skus||[]).map((r,i)=>({...r,__f:false,__i:i})).filter(r=>(r.category||'BASES')===cat)
                                const filRows = (ut.fillers||[]).map((r,i)=>({...r,__f:true,__i:i})).filter(r=>(r.category||'ACCESSORIES')===cat)
                                const rows = [...skuRows, ...filRows]
                                if (!rows.length && !cabEditing) return null
                                return (
                                  <div key={cat}>
                                    <div style={{ display:'flex', justifyContent:'space-between', padding:'3px 12px', fontSize:10, color:'#888', fontWeight:600, letterSpacing:0.4, background:'#fafaf8' }}>
                                      {cat}
                                      {cabEditing && <button onClick={()=>upd(n=>{n.unit_types[ui].skus.push({ sku:'', quantity_per_unit:1, category:cat, hardware_count:0, location:'kitchen', hinge_side:'L/R', description:'', notes:'' })})} style={{ background:'none', border:'none', cursor:'pointer', color:'#3C3489', fontSize:10, fontWeight:600 }}>+ row</button>}
                                    </div>
                                    {rows.map((r) => (
                                      <div key={(r.__f?'f':'s')+r.__i} style={{ display:'flex', gap:10, alignItems:'center', padding:'3px 12px', fontSize:12, borderTop:'0.5px dotted #f0f0ec' }}>
                                        {cabEditing ? (
                                          <>
                                            <input type="number" min="0" value={r.quantity_per_unit} onChange={e=>upd(n=>{ const t=r.__f?n.unit_types[ui].fillers:n.unit_types[ui].skus; t[r.__i].quantity_per_unit=Number(e.target.value)||0 })} style={{ width:48, padding:'2px 6px', border:'0.5px solid #ccc', borderRadius:4, fontSize:12, textAlign:'right' }}/>
                                            <input list="leedo-sku-suggest" value={r.sku} onChange={e=>{ const s=e.target.value.toUpperCase(); fetchSkuSuggestions(s); upd(n=>{ const t=r.__f?n.unit_types[ui].fillers:n.unit_types[ui].skus; t[r.__i].sku=s; if(!r.__f){ const hw=calculateHardware(s); t[r.__i].hardware_count=hw.hardware ?? 0 } }) }} style={{ flex:1, padding:'2px 8px', border:'0.5px solid ' + (r.sku && !r.__f && isAppliance(r.sku) ? '#e0a800' : '#ccc'), borderRadius:4, fontSize:12, fontWeight:500 }}/>
                                            {!r.__f && r.sku && (
                                              <span style={{ fontSize:10, color: isAppliance(r.sku) ? '#B8860B' : '#bbb', whiteSpace:'nowrap' }}>
                                                {isAppliance(r.sku) ? 'appliance — excluded' : `${getSection(r.sku)} · HW ${calculateHardware(r.sku).hardware ?? '?'}`}
                                              </span>
                                            )}
                                            <button onClick={()=>upd(n=>{ const t=r.__f?n.unit_types[ui].fillers:n.unit_types[ui].skus; t.splice(r.__i,1) })} style={{ background:'none', border:'none', cursor:'pointer', color:'#ccc', fontSize:12 }}>✕</button>
                                          </>
                                        ) : (
                                          <>
                                            <span style={{ width:28, textAlign:'right', color:'#888' }}>{r.quantity_per_unit}</span>
                                            <span style={{ fontWeight:500, color:r.__f?'#888':'#222' }}>{r.sku}</span>
                                            {!r.__f && r.hardware_count > 0 && <span style={{ marginLeft:'auto', fontSize:10, color:'#bbb' }}>HW {r.hardware_count}</span>}
                                          </>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )
                              })}
                            </div>
                          ))}
                          {cabEditing && (
                            <div style={{ padding:10 }}>
                              <button onClick={()=>upd(n=>{ if(!n.unit_types) n.unit_types=[]; n.unit_types.push({ unit_type_name:'NEW UNIT', unit_quantity:1, skus:[], fillers:[], is_ada:false, countertop_sf:0, excelSubtotalSF:null, excelSubtotalHW:null }) })} style={{ width:'100%', padding:8, fontSize:12, background:'#f5f5f3', border:'1px dashed #ccc', borderRadius:6, cursor:'pointer', color:'#3C3489', fontWeight:500 }}>+ Add Unit Type</button>
                            </div>
                          )}
                          {(L.unit_types || []).length === 0 && !cabEditing && (
                            <div style={{ padding:16, textAlign:'center' }}>
                              <button onClick={()=>{ const d = JSON.parse(JSON.stringify(cabList)); d.product_line = d.product_line || productLine; d.unit_types = [{ unit_type_name:'UNIT A', unit_quantity:1, kind:'unit', skus:[], fillers:[], is_ada:false, countertop_sf:0, excelSubtotalSF:null, excelSubtotalHW:null }]; setCabDraft(d); setCabEditing(true) }} style={{ padding:'10px 20px', fontSize:13, background:'#3C3489', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontWeight:500 }}>+ Start Building — Add First Unit</button>
                            </div>
                          )}
                        </div>
                      </div>
                      )
                    })()}
                  </div>

                  {/* ── Job Files ──────────────────────────────────────── */}
                  <div style={card}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                      <div style={{ fontWeight:500 }}>Job Files</div>
                      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                        <select value={fileCategory} onChange={e=>setFileCategory(e.target.value)} style={{ ...inp, width:130, padding:'4px 8px', fontSize:11 }}>
                          {FILE_CATEGORIES.map(cat=><option key={cat}>{cat}</option>)}
                        </select>
                        <label style={{ padding:'4px 12px', fontSize:11, background:'#3C3489', color:'#fff', borderRadius:6, cursor:fileUploading?'wait':'pointer', fontWeight:500 }}>
                          {fileUploading ? 'Uploading...' : '+ Upload'}
                          <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.csv" onChange={uploadJobFile} style={{ display:'none' }} disabled={fileUploading}/>
                        </label>
                      </div>
                    </div>
                    {filesLoading && <div style={{ fontSize:11, color:'#888' }}>Loading...</div>}
                    {!filesLoading && jobFiles.length === 0 && <div style={{ fontSize:11, color:'#bbb', padding:'6px 0' }}>No files yet — upload drawings, contracts, quotes, change orders</div>}
                    {FILE_CATEGORIES.map(cat => {
                      const catFiles = jobFiles.filter(f => f.category === cat)
                      if (!catFiles.length) return null
                      return (
                        <div key={cat} style={{ marginBottom:10 }}>
                          <div style={{ fontSize:10, color:'#888', fontWeight:600, textTransform:'uppercase', letterSpacing:0.4, marginBottom:4 }}>{cat}</div>
                          {catFiles.map(f => {
                            const parts = f.name.split('__')
                            const label = parts.length >= 3 ? parts.slice(2).join('__') : f.name
                            const sizeLabel = f.size > 0 ? (f.size > 1048576 ? (f.size/1048576).toFixed(1)+'MB' : Math.round(f.size/1024)+'KB') : ''
                            const ext2 = label.split('.').pop().toLowerCase(); const icon = ext2==='pdf'?'📄':['doc','docx'].includes(ext2)?'📝':['xls','xlsx','csv'].includes(ext2)?'📊':['jpg','jpeg','png'].includes(ext2)?'🖼️':'📎'
                            return (
                              <div key={f.path} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:6, background:'#f9f9f9', marginBottom:3 }}>
                                <span style={{ fontSize:13 }}>{icon}</span>
                                <button onClick={()=>downloadJobFile(f.path, label)} style={{ flex:1, textAlign:'left', background:'none', border:'none', cursor:'pointer', fontSize:11, color:'#3C3489', padding:0, fontWeight:500 }}>{label}</button>
                                {sizeLabel && <span style={{ fontSize:10, color:'#bbb' }}>{sizeLabel}</span>}
                                <button onClick={()=>deleteJobFile(f.path)} style={{ background:'none', border:'none', cursor:'pointer', color:'#ccc', fontSize:13, lineHeight:1, padding:'0 2px' }}>✕</button>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>

                  <div style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                      <div style={{ fontWeight: 500 }}>Shipments</div>
                      <button onClick={() => setShowShipmentForm(true)} style={{ fontSize: 11, padding: '4px 12px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>+ Add Load</button>
                    </div>
                    {showShipmentForm && (
                      <div style={{ background: '#f5f5f3', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div><label style={lbl}>Load #</label><input type="number" min="1" value={newShipment.load_number} onChange={e => setNewShipment(p => ({ ...p, load_number: Number(e.target.value) }))} style={inp} /></div>
                          <div><label style={lbl}>Total Loads</label><input type="number" min="1" value={newShipment.total_loads} onChange={e => setNewShipment(p => ({ ...p, total_loads: Number(e.target.value) }))} style={inp} /></div>
                        </div>
                        <div style={{ marginBottom: 8 }}><label style={lbl}>Carrier</label><select value={newShipment.carrier} onChange={e => setNewShipment(p => ({ ...p, carrier: e.target.value }))} style={inp}>{CARRIERS.map(c => <option key={c}>{c}</option>)}</select></div>
                        <div style={{ marginBottom: 8 }}><label style={lbl}>Tracking Number</label><input value={newShipment.tracking_number} onChange={e => setNewShipment(p => ({ ...p, tracking_number: e.target.value }))} style={inp} /></div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div><label style={lbl}>Expected Delivery</label><input type="date" value={newShipment.scheduled_date} onChange={e => setNewShipment(p => ({ ...p, scheduled_date: e.target.value }))} style={inp} /></div>
                          <div><label style={lbl}>Cabinets in Load</label><input type="number" value={newShipment.cabinet_count} onChange={e => setNewShipment(p => ({ ...p, cabinet_count: e.target.value }))} style={inp} /></div>
                        </div>
                        <div style={{ marginBottom: 8 }}><label style={lbl}>Floors / Units Covered</label><input value={newShipment.floors_covered} onChange={e => setNewShipment(p => ({ ...p, floors_covered: e.target.value }))} style={inp} /></div>
                        <div style={{ marginBottom: 8 }}><label style={lbl}>Site Contact</label><input value={newShipment.delivery_contact} onChange={e => setNewShipment(p => ({ ...p, delivery_contact: e.target.value }))} style={inp} /></div>
                        <div style={{ marginBottom: 12 }}><label style={lbl}>Notes</label><input value={newShipment.notes} onChange={e => setNewShipment(p => ({ ...p, notes: e.target.value }))} style={inp} /></div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={createShipment} disabled={savingShipment} style={{ flex: 1, padding: '7px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>{savingShipment ? 'Saving...' : 'Add Shipment'}</button>
                          <button onClick={() => { setShowShipmentForm(false); setNewShipment(emptyShipment) }} style={{ flex: 1, padding: '7px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {shipments.length === 0 && !showShipmentForm && <div style={{ color: '#888', fontSize: 12 }}>No shipments yet</div>}
                    {shipments.map(s => (
                      <div key={s.id} style={{ border: '0.5px solid #e5e5e0', borderRadius: 8, padding: 12, marginBottom: 10, background: s.status === 'Delayed' ? '#FFF8F0' : '#fff' }}>
                        {editingShipment?.id === s.id ? (
                          <div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                              <div><label style={lbl}>Tracking #</label><input value={editingShipment.tracking_number || ''} onChange={e => setEditingShipment(p => ({ ...p, tracking_number: e.target.value }))} style={inp} /></div>
                              <div><label style={lbl}>Expected Date</label><input type="date" value={editingShipment.scheduled_date || ''} onChange={e => setEditingShipment(p => ({ ...p, scheduled_date: e.target.value }))} style={inp} /></div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                              <div><label style={lbl}>Floors / Units</label><input value={editingShipment.floors_covered || ''} onChange={e => setEditingShipment(p => ({ ...p, floors_covered: e.target.value }))} style={inp} /></div>
                              <div><label style={lbl}>Cabinets</label><input type="number" value={editingShipment.cabinet_count || ''} onChange={e => setEditingShipment(p => ({ ...p, cabinet_count: e.target.value }))} style={inp} /></div>
                            </div>
                            <div style={{ marginBottom: 10 }}><label style={lbl}>Notes</label><input value={editingShipment.notes || ''} onChange={e => setEditingShipment(p => ({ ...p, notes: e.target.value }))} style={inp} /></div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={saveShipmentEdit} disabled={savingShipment} style={{ flex: 1, padding: '6px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>Save</button>
                              <button onClick={() => setEditingShipment(null)} style={{ flex: 1, padding: '6px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                              <div>
                                <div style={{ fontWeight: 500, fontSize: 13 }}>Load {s.load_number} of {s.total_loads}</div>
                                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.carrier}{s.tracking_number ? ` · ${s.tracking_number}` : ''}</div>
                              </div>
                              <ShipmentBadge status={s.status} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12, marginBottom: 10 }}>
                              {s.scheduled_date && <div><span style={{ color: '#888' }}>Expected: </span>{s.scheduled_date}</div>}
                              {s.cabinet_count && <div><span style={{ color: '#888' }}>Cabinets: </span>{Number(s.cabinet_count).toLocaleString()}</div>}
                              {s.floors_covered && <div style={{ gridColumn: '1/-1' }}><span style={{ color: '#888' }}>Floors/Units: </span>{s.floors_covered}</div>}
                              {s.notes && <div style={{ gridColumn: '1/-1', color: '#888', fontStyle: 'italic' }}>{s.notes}</div>}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <StatusButtons shipment={s} />
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => setEditingShipment({ ...s })} style={{ fontSize: 10, padding: '3px 8px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>Edit</button>
                                <button onClick={() => deleteShipment(s.id)} style={{ fontSize: 10, padding: '3px 8px', background: '#FCEBEB', color: '#A32D2D', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Remove</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ fontWeight: 500 }}>Reminders</div>
                      <button onClick={() => setShowReminderForm(true)} style={{ fontSize: 11, padding: '4px 10px', background: 'transparent', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>+ Add</button>
                    </div>
                    {showReminderForm && (
                      <div style={{ background: '#f5f5f3', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                        <input type="date" value={newReminder.due_date} onChange={e => setNewReminder(p => ({ ...p, due_date: e.target.value }))} style={{ width: '100%', padding: '6px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, marginBottom: 8 }} />
                        <select value={newReminder.reminder_type} onChange={e => setNewReminder(p => ({ ...p, reminder_type: e.target.value }))} style={{ width: '100%', padding: '6px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
                          <option>Bid Follow-up</option><option>Bid Deadline</option><option>Delivery Check</option><option>Payment</option><option>General</option>
                        </select>
                        <input placeholder="Message..." value={newReminder.message} onChange={e => setNewReminder(p => ({ ...p, message: e.target.value }))} style={{ width: '100%', padding: '6px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 12, marginBottom: 8 }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={createReminder} style={{ flex: 1, padding: '6px', background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Save</button>
                          <button onClick={() => setShowReminderForm(false)} style={{ flex: 1, padding: '6px', background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {(selectedJob.reminders || []).filter(r => !r.completed).map(r => (
                      <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12, borderBottom: '0.5px solid #f0f0ec' }}>
                        <div><div>{r.message}</div><div style={{ color: '#888', fontSize: 11 }}>{r.due_date} · {r.reminder_type}</div></div>
                        <button onClick={() => completeReminder(r.id)} style={{ fontSize: 10, padding: '3px 8px', background: '#EAF3DE', color: '#3B6D11', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Done</button>
                      </div>
                    ))}
                    {(selectedJob.reminders || []).filter(r => !r.completed).length === 0 && !showReminderForm && <div style={{ color: '#888', fontSize: 12 }}>No open reminders</div>}
                  </div>

                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 12 }}>Activity Log</div>
                    {(selectedJob.activity_log || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8).map(log => (
                      <div key={log.id} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: '0.5px solid #f0f0ec', fontSize: 12 }}>
                        <div>{log.action}</div>
                        <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{log.user_name} · {new Date(log.created_at).toLocaleDateString()}</div>
                      </div>
                    ))}
                    {(selectedJob.activity_log || []).length === 0 && <div style={{ color: '#888', fontSize: 12 }}>No activity yet</div>}
                  </div>

                  {/* ── Countertop Proposal Configuration ─────────────────────── */}
                  <div style={{ ...card, borderColor: '#2D7A3A', marginBottom: 16 }}>
                    <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 14 }}>Generate Countertop Proposal</div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Sender</label>
                      <select value={ctSender} onChange={e=>setCtSender(e.target.value)} style={{ ...inp, width: 180, marginBottom: 12 }}>
                        <option value="Cole">Cole Isetts — Sales Representative</option>
                        <option value="Pam">Pamela Isetts — President</option>
                        <option value="MDSG">MDSG Team</option>
                      </select>
                      <label style={lbl}>Waste Factor %</label>
                      <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:12 }}>
                        <input type="number" min="0" max="30" value={ctWastePct} onChange={e=>setCtWastePct(Number(e.target.value))} style={{ ...inp, width:70 }}/>
                        <span style={{ fontSize:11, color:'#2D7A3A' }}>{ctWastePct}% added to net SF for order quantity</span>
                      </div>
                      <label style={lbl}>Countertop Material Cost ($ — from supplier quote)</label>
                      <input type="number" min="0" value={ctGross} placeholder="e.g. 48000" onChange={e=>setCtGross(e.target.value)} style={{ ...inp, width:160, marginBottom:10 }}/>
                      <label style={lbl}>Gross Margin %</label>
                      <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:10 }}>
                        <input type="number" step="1" min="0" max="60" value={ctMargin} onChange={e=>setCtMargin(e.target.value)} style={{ ...inp, width:70 }}/>
                        {Number(ctGross)>0 && Number(ctMargin)>0 && <span style={{ fontSize:11, color:'#2D7A3A', fontWeight:500 }}>→ sell ≈ ${Math.round(Number(ctGross)/(1-Number(ctMargin)/100)).toLocaleString()}</span>}
                      </div>
                      <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                        {[15,20,25,30,35].map(m=><button key={m} onClick={()=>setCtMargin(m)} style={{ padding:'3px 9px', fontSize:11, borderRadius:6, cursor:'pointer', background:Number(ctMargin)===m?'#2D7A3A':'#f5f5f3', color:Number(ctMargin)===m?'#fff':'#555', border:'0.5px solid #ddd' }}>{m}%</button>)}
                      </div>
                      <label style={lbl}>Notes (appears on proposal)</label>
                      <textarea value={ctNotes} onChange={e=>setCtNotes(e.target.value)} style={{ width:'100%', padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:11, height:52, resize:'vertical', fontFamily:'inherit', marginBottom:4 }}/>
                    </div>
                    {[
                      ['includedInBid', 'Included in Bid', 38],
                      ['assembly', 'Assembly, Staging & Installation', 44],
                      ['notIncluded', 'Not Included in Bid (one bullet per line)', 80],
                      ['bottomNotes', 'Proposal Notes', 44],
                    ].map(([key, label, h]) => (
                      <div key={key} style={{ marginBottom: 10 }}>
                        <label style={lbl}>{label}</label>
                        <textarea value={ctBidSections[key]} onChange={e=>setCtBidSections(p=>({...p,[key]:e.target.value}))} style={{ width:'100%', padding:'7px 10px', border:'0.5px solid #ccc', borderRadius:6, fontSize:11, height:h, resize:'vertical', fontFamily:'inherit' }}/>
                      </div>
                    ))}
                    <button onClick={()=>setCtBidSections(DEFAULT_CT_BID_SECTIONS)} style={{ marginBottom:10, padding:'3px 10px', fontSize:11, borderRadius:6, cursor:'pointer', background:'#f5f5f3', color:'#555', border:'0.5px solid #ddd' }}>↺ Reset to defaults</button>
                  </div>

                  <div style={{ ...card, borderColor: ctSavedData ? '#2D7A3A' : '#e5e5e0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ fontWeight: 500 }}>Countertop</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button onClick={() => setCtIncludeCabinets(p => !p)} style={{ padding: '3px 10px', fontSize: 10, borderRadius: 10, cursor: 'pointer', fontWeight: 500, background: ctIncludeCabinets ? '#e8f5e9' : '#f5f5f3', color: ctIncludeCabinets ? '#2D7A3A' : '#888', border: ctIncludeCabinets ? '0.5px solid #2D7A3A' : '0.5px solid #ccc' }}>
                          {ctIncludeCabinets ? '✓ Cabinets in Proposal' : 'Cabinets Excluded'}
                        </button>
                        {ctSavedData && (
                          <button onClick={generateCtProposal} disabled={ctGenerating} style={{ padding: '4px 12px', fontSize: 11, background: ctGenerating ? '#888' : '#2D7A3A', color: '#fff', border: 'none', borderRadius: 6, cursor: ctGenerating ? 'default' : 'pointer', fontWeight: 500 }}>
                            {ctGenerating ? 'Generating...' : '⬇ CT Proposal PDF'}
                          </button>
                        )}
                      </div>
                    </div>
                    {ctSavedData ? (
                      <div style={{ background: '#f5fdf6', border: '0.5px solid #b2dfb4', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontSize: 10, color: '#2D7A3A', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Saved Takeoff</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                          {[['Kitchen SF', ((ctSavedData.kSF)||0).toFixed(1)], ['Vanity SF', ((ctSavedData.vSF)||0).toFixed(1)], ['Total Material SF', ((ctSavedData.kSF||0)+(ctSavedData.vSF||0)+(ctSavedData.sideSF||0)).toFixed(1)], ['Kitchen LF', ((ctSavedData.kLF)||0).toFixed(1)], ['Vanity LF', ((ctSavedData.vLF)||0).toFixed(1)], ['Backsplash LF', ((ctSavedData.backLF)||0).toFixed(1)]].map(([l,v]) => (
                            <div key={l}><div style={{ fontSize: 9, color: '#888', textTransform: 'uppercase' }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: '#2D7A3A' }}>{v}</div></div>
                          ))}
                        </div>
                        {ctSavedData.cuts > 0 && <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>Sink Cutouts: <strong>{ctSavedData.cuts}</strong></div>}
                      </div>
                    ) : (
                      <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12, padding: '10px 0' }}>
                        No countertop takeoff saved yet — use the <span style={{ color: '#3C3489', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setView('agent-pipeline')}>⚡ Agent Pipeline</span> to run a takeoff and save
                      </div>
                    )}
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 6 }}>Fabricator Quote</div>
                      <label style={{ display: 'block', border: '1.5px dashed #ccc', borderRadius: 8, padding: 14, textAlign: 'center', cursor: 'pointer', background: '#fafaf8' }}>
                        <div style={{ color: '#555', fontSize: 12 }}>{ctQuoteUploading ? '⏳ Reading quote...' : ctQuoteResult ? `✓ ${ctQuoteResult.fabricator || 'Quote'} — $${Math.round(ctQuoteResult.total_amount).toLocaleString()}` : 'Click to upload fabricator quote PDF'}</div>
                        {!ctQuoteResult && <div style={{ color: '#aaa', fontSize: 10, marginTop: 2 }}>CAPO · SFI · Hilton · any fabricator</div>}
                        <input type="file" accept=".pdf" onChange={handleCtQuoteUpload} style={{ display: 'none' }} disabled={ctQuoteUploading} />
                      </label>
                      {ctQuoteResult && (
                        <div style={{ marginTop: 8, padding: '8px 12px', background: '#f0f9f0', borderRadius: 6, fontSize: 11 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Fabricator cost:</span><span style={{ fontWeight: 500 }}>${Math.round(ctQuoteResult.total_amount).toLocaleString()}</span></div>
                          {ctQuoteResult.material_type && <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>{ctQuoteResult.material_type} · {ctQuoteResult.color || ''}</div>}
                        </div>
                      )}
                    </div>
                    {ctQuoteResult && (
                      <div style={{ borderTop: '0.5px solid #eee', paddingTop: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 8 }}>Markup & Pricing</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                          <label style={{ ...lbl, marginBottom: 0, minWidth: 110 }}>Markup Multiplier</label>
                          <input type="number" step="0.01" min="1.00" max="2.00" value={ctMarkup} onChange={e => setCtMarkup(Number(e.target.value))} style={{ width: 72, padding: '5px 8px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }} />
                          <span style={{ fontSize: 11, color: '#3B6D11', fontWeight: 500 }}>{ctMarkup > 1 ? ((1 - 1/Number(ctMarkup))*100).toFixed(1) : '0.0'}% margin</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                          {[1.20, 1.25, 1.30, 1.35].map(m => (<button key={m} onClick={() => setCtMarkup(m)} style={{ padding: '3px 9px', fontSize: 10, borderRadius: 6, cursor: 'pointer', background: Number(ctMarkup) === m ? '#3C3489' : '#f5f5f3', color: Number(ctMarkup) === m ? '#fff' : '#555', border: '0.5px solid #ddd' }}>{m}×</button>))}
                        </div>
                        <div style={{ background: '#1a1a2e', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div><div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 0.4 }}>Bid to GC — Countertop</div><div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>${Math.round((ctQuoteResult.total_amount || 0) * ctMarkup).toLocaleString()}</div></div>
                          <div style={{ textAlign: 'right' }}><div style={{ fontSize: 9, color: '#666' }}>Gross Profit</div><div style={{ fontSize: 14, fontWeight: 600, color: '#4a9' }}>${Math.round((ctQuoteResult.total_amount || 0) * (ctMarkup - 1)).toLocaleString()}</div></div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SHIPMENTS VIEW */}
          {view === 'shipments' && (
            <div>
              {delayedCount > 0 && (
                <div style={{ background: '#FCEBEB', border: '0.5px solid #E24B4A', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#A32D2D' }}>
                  ⚠ {delayedCount} shipment{delayedCount > 1 ? 's' : ''} marked as delayed
                </div>
              )}
              <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: '#f5f5f3' }}>
                    {['Job', 'GC', 'Load', 'Carrier', 'Tracking #', 'Expected', 'Floors / Units', 'Cabinets', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {allActiveShipments.length === 0
                      ? <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: '#888' }}>No active shipments</td></tr>
                      : allActiveShipments.map(s => (
                          <tr key={s.id} style={{ borderBottom: '0.5px solid #f0f0ec', background: s.status === 'Delayed' ? '#FFF8F0' : '' }}>
                            <td style={{ padding: '10px 12px', fontWeight: 500, cursor: 'pointer', color: '#3C3489' }} onClick={() => { const job = jobs.find(j => j.id === s.job_id); if (job) { setSelectedJob(job); setView('job-detail') } }}>{s.jobs?.name || '—'}</td>
                            <td style={{ padding: '10px 12px', color: '#555' }}>{s.jobs?.gc_name || '—'}</td>
                            <td style={{ padding: '10px 12px', color: '#555' }}>{s.load_number} of {s.total_loads}</td>
                            <td style={{ padding: '10px 12px', color: '#555' }}>{s.carrier}</td>
                            <td style={{ padding: '10px 12px', color: '#555', fontFamily: 'monospace', fontSize: 11 }}>{s.tracking_number || '—'}</td>
                            <td style={{ padding: '10px 12px', color: s.status === 'Delayed' ? '#A32D2D' : '#555', fontWeight: s.status === 'Delayed' ? 500 : 400 }}>{s.scheduled_date || '—'}</td>
                            <td style={{ padding: '10px 12px', color: '#555' }}>{s.floors_covered || '—'}</td>
                            <td style={{ padding: '10px 12px', color: '#555' }}>{s.cabinet_count ? Number(s.cabinet_count).toLocaleString() : '—'}</td>
                            <td style={{ padding: '10px 12px' }}><ShipmentBadge status={s.status} /></td>
                            <td style={{ padding: '10px 12px' }}>
                              <select value={s.status} onChange={e => updateShipmentStatus(s.id, e.target.value, s.job_id)} style={{ padding: '4px 6px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                                <option>Scheduled</option><option>In Transit</option><option>Delivered</option><option>Delayed</option>
                              </select>
                            </td>
                          </tr>
                        ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AGENT PIPELINE — new unified dark UI, always mounted so state survives navigation */}
          <div style={{ display: view === 'agent-pipeline' ? 'block' : 'none' }}>
            <AgentPipeline jobs={jobs} onComplete={() => { loadJobs(); setView('jobs') }} />
          </div>

          {/* UPLOAD MFR QUOTE */}
          {view === 'takeoff' && (
            <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, padding: 32, textAlign: 'center', maxWidth: 500, margin: '0 auto' }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Upload Manufacturer Quote PDF</div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 24 }}>Select a job then upload the PDF. Claude extracts all unit types, SKUs, and pricing automatically.</div>
              <select onChange={e => setSelectedJob(jobs.find(j => j.id === e.target.value))} style={{ width: '100%', padding: '8px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
                <option value="">Choose a job...</option>
                {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
              </select>
              {selectedJob && (
                <label style={{ display: 'block', border: '1.5px dashed #ccc', borderRadius: 8, padding: 32, cursor: 'pointer', background: '#fafaf8' }}>
                  <div style={{ fontSize: 13, color: '#555' }}>{quoteUploading ? 'AI is parsing your quote...' : 'Drop PDF here or click to upload'}</div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>Leedo · Skyline · SMART · Ukon</div>
                  <input type="file" accept=".pdf,.xlsx,.xlsm" onChange={handleQuoteUpload} style={{ display: 'none' }} disabled={quoteUploading} />
                </label>
              )}
            </div>
          )}

          {/* REMINDERS */}
          {view === 'reminders' && (
            <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ background: '#f5f5f3' }}>
                  {['Due Date', 'Job', 'Type', 'Message', 'Assigned To', ''].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {reminders.length === 0
                    ? <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#888' }}>No upcoming reminders</td></tr>
                    : reminders.map(r => {
                        const isOverdue = r.due_date <= new Date().toISOString().split('T')[0]
                        return (
                          <tr key={r.id} style={{ borderBottom: '0.5px solid #f0f0ec', background: isOverdue ? '#FCEBEB' : '' }}>
                            <td style={{ padding: '10px 14px', fontWeight: 500, color: isOverdue ? '#A32D2D' : '#333' }}>{r.due_date}</td>
                            <td style={{ padding: '10px 14px' }}>{r.jobs?.name || '—'}</td>
                            <td style={{ padding: '10px 14px', color: '#555' }}>{r.reminder_type}</td>
                            <td style={{ padding: '10px 14px', color: '#555' }}>{r.message}</td>
                            <td style={{ padding: '10px 14px', color: '#555' }}>{r.assigned_to}</td>
                            <td style={{ padding: '10px 14px' }}><button onClick={() => completeReminder(r.id)} style={{ fontSize: 10, padding: '3px 10px', background: '#EAF3DE', color: '#3B6D11', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Mark Done</button></td>
                          </tr>
                        )
                      })
                  }
                </tbody>
              </table>
            </div>
          )}

        </div>
      </div>

      {/* New Job Modal */}
      {showNewJob && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 440, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 20 }}>New Job</div>
            {[{ label: 'Project Name *', key: 'name' }, { label: 'General Contractor', key: 'gc_name' }, { label: 'Address', key: 'address' }, { label: 'City', key: 'city' }].map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={lbl}>{field.label}</label>
                <input value={newJob[field.key] || ''} onChange={e => setNewJob(p => ({ ...p, [field.key]: e.target.value }))} style={inp} />
              </div>
            ))}
            {[{ label: 'Owner', key: 'owner', options: ['Cole', 'Pam', 'Blake'] }, { label: 'Manufacturer', key: 'manufacturer', options: ['TBD', 'Leedo', 'Skyline', 'SMART', 'Ukon', 'Multiple'] }].map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={lbl}>{field.label}</label>
                <select value={newJob[field.key]} onChange={e => setNewJob(p => ({ ...p, [field.key]: e.target.value }))} style={inp}>
                  {field.options.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
            ))}
            <div style={{ marginBottom: 20 }}>
              <label style={lbl}>Bid Due Date</label>
              <input type="date" value={newJob.bid_due_date || ''} onChange={e => setNewJob(p => ({ ...p, bid_due_date: e.target.value }))} style={inp} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={createJob} style={{ flex: 1, padding: 8, background: '#3C3489', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>Create Job</button>
              <button onClick={() => setShowNewJob(false)} style={{ flex: 1, padding: 8, background: '#f5f5f3', border: '0.5px solid #ccc', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
