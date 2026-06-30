'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import TakeoffEngine from './components/TakeoffEngine'
import CountertopCalc from './components/CountertopCalc'
import AgentPipeline from './components/AgentPipeline'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { storageKey: 'mdsg-main' } }
)

const STAGE_COLORS = {
  'Bid':           { bg: '#EEEDFE', text: '#3C3489' },
  'Awarded':       { bg: '#EAF3DE', text: '#3B6D11' },
  'Shop Drawings': { bg: '#FAEEDA', text: '#633806' },
  'Ordered':       { bg: '#E6F1FB', text: '#0C447C' },
  'Delivered':     { bg: '#E1F5EE', text: '#085041' },
  'Installed':     { bg: '#EAF3DE', text: '#27500A' },
  'Lost':          { bg: '#FCEBEB', text: '#A32D2D' },
}

const SHIPMENT_STATUS_COLORS = {
  'Scheduled':  { bg: '#E6F1FB', text: '#0C447C' },
  'In Transit': { bg: '#FAEEDA', text: '#633806' },
  'Delivered':  { bg: '#EAF3DE', text: '#27500A' },
  'Delayed':    { bg: '#FCEBEB', text: '#A32D2D' },
}

const STAGES = ['Bid', 'Awarded', 'Shop Drawings', 'Ordered', 'Delivered', 'Installed']
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
  const [proposalMarkup, setProposalMarkup] = useState(1.34)
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
        door_style: selectedJob.door_style || '',
        finish_color: selectedJob.finish_color || '',
        box_construction: selectedJob.box_construction || '',
        hardware_allowance: selectedJob.hardware_allowance || 0,
        scope_notes: selectedJob.scope_notes || '',
      })
      setEditUnitTypes(
        (selectedJob.unit_types || []).sort((a, b) => a.sort_order - b.sort_order).map(ut => ({ ...ut }))
      )
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
      door_style: editFields.door_style,
      finish_color: editFields.finish_color,
      box_construction: editFields.box_construction,
      hardware_allowance: Number(editFields.hardware_allowance) || 0,
      scope_notes: editFields.scope_notes,
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
      headers: { 'x-job-id': selectedJob.id, 'x-file-name': file.name, 'Content-Type': 'application/pdf' },
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
        body: JSON.stringify({ jobId: selectedJob.id, unitTypes: unitTypesPayload, totals: totalsPayload, wastePct: 10, propConfig }),
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
        body: JSON.stringify({ jobId: selectedJob.id, sender: proposalSender, notes: proposalNotes, markupMultiplier: Number(proposalMarkup), salesTaxPct: Number(proposalSalesTax), additionalLineItems }),
      })
      if (!response.ok) { const err = await response.json(); throw new Error(err.error || 'Failed') }
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
  const activeBids = jobs.filter(j => j.stage === 'Bid').length
  const awardedValue = jobs.filter(j => !['Bid', 'Lost'].includes(j.stage)).reduce((s, j) => s + (j.bid_value || 0), 0)
  const avgMargin = jobs.filter(j => j.gross_margin_pct > 0).reduce((s, j, _, arr) => s + j.gross_margin_pct / arr.length, 0)
  const overdueReminders = reminders.filter(r => r.due_date <= new Date().toISOString().split('T')[0])
  const markupMarginPreview = proposalMarkup > 1 ? ((1 - 1 / Number(proposalMarkup)) * 100).toFixed(1) : '0.0'
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8 }}>
                {STAGES.map(stage => (
                  <div key={stage} style={{ background: '#f5f5f3', borderRadius: 8, padding: 10, minHeight: 80 }}>
                    <div style={{ fontSize: 10, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                      {stage} <span style={{ background: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{jobs.filter(j => j.stage === stage).length}</span>
                    </div>
                    {jobs.filter(j => j.stage === stage).map(job => (
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
          {view === 'jobs' && (
            <div style={{ background: '#fff', border: '0.5px solid #e5e5e0', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ background: '#f5f5f3' }}>
                  {['Project', 'GC', 'Stage', 'Manufacturer', 'Cabinets', 'Bid Value', 'Margin', 'Owner'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500, color: '#888', borderBottom: '0.5px solid #e5e5e0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#888' }}>Loading...</td></tr>
                  : jobs.map(job => {
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
          )}

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
                            {editUnitTypes.map(ut => (
                              <div key={ut.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: '0.5px solid #f5f5f3' }}>
                                <span>{ut.unit_type_name}</span>
                                <span style={{ color: '#888' }}>{ut.unit_quantity} units · {ut.cabinet_count} cabs</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
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

                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 12 }}>Upload Manufacturer Quote PDF</div>
                    <label style={{ display: 'block', border: '1.5px dashed #ccc', borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer', background: '#fafaf8' }}>
                      <div style={{ color: '#555', fontSize: 13 }}>{quoteUploading ? 'Parsing with AI...' : 'Click to upload PDF quote'}</div>
                      <div style={{ color: '#999', fontSize: 11, marginTop: 4 }}>Leedo · Skyline · SMART · Ukon</div>
                      <input type="file" accept=".pdf" onChange={handleQuoteUpload} style={{ display: 'none' }} disabled={quoteUploading} />
                    </label>
                    {quoteResult && (
                      <div style={{ marginTop: 12, padding: 12, background: '#EAF3DE', borderRadius: 8, fontSize: 12 }}>
                        <div style={{ fontWeight: 500, color: '#3B6D11', marginBottom: 4 }}>Parsed successfully</div>
                        <div>Manufacturer: {quoteResult.summary.manufacturer} · Unit types: {quoteResult.summary.unit_type_count} · Cabinets: {quoteResult.summary.total_cabinets?.toLocaleString()}</div>
                        <div style={{ fontWeight: 500 }}>Grand total: {fmt(quoteResult.summary.grand_total)}</div>
                      </div>
                    )}
                  </div>

                  <div style={card}>
                    <div style={{ fontWeight: 500, marginBottom: 14 }}>Generate Proposal PDF</div>
                    <div style={{ marginBottom: 14 }}>
                      <label style={lbl}>Markup Multiplier</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <input type="number" step="0.01" min="1.00" max="2.00" value={proposalMarkup} onChange={e => setProposalMarkup(e.target.value)} style={{ width: 80, padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 6, fontSize: 13 }} />
                        <span style={{ fontSize: 12, color: '#3B6D11', fontWeight: 500 }}>= {markupMarginPreview}% margin</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[1.25, 1.30, 1.34, 1.40, 1.50].map(m => (<button key={m} onClick={() => setProposalMarkup(m)} style={{ padding: '4px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer', background: Number(proposalMarkup) === m ? '#3C3489' : '#f5f5f3', color: Number(proposalMarkup) === m ? '#fff' : '#555', border: '0.5px solid #ddd' }}>{m}×</button>))}
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
                  <input type="file" accept=".pdf" onChange={handleQuoteUpload} style={{ display: 'none' }} disabled={quoteUploading} />
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
