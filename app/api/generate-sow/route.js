import { createClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { readFileSync } from 'fs'
import { join } from 'path'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// POST /api/generate-sow { jobId } → printable Scope of Work PDF for GC approval
export async function POST(request) {
  try {
    const { jobId } = await request.json()
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single()
    if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
    const rows = Array.isArray(job.scope_of_work) ? job.scope_of_work : []
    if (!rows.length) return Response.json({ error: 'No Scope of Work on this job yet' }, { status: 422 })

    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const navy = rgb(0.10, 0.20, 0.42), gray = rgb(0.35, 0.35, 0.35), line = rgb(0.75, 0.75, 0.75)

    let page = pdf.addPage([612, 792])
    let y = 742
    const ML = 54, MR = 558

    const ensure = (need) => {
      if (y - need < 60) { page = pdf.addPage([612, 792]); y = 742 }
    }
    const dt = (t, x, yy, f = font, size = 9, color = rgb(0.1,0.1,0.1)) =>
      page.drawText(String(t), { x, y: yy, size, font: f, color })

    try {
      const logo = await pdf.embedPng(readFileSync(join(process.cwd(), 'public', 'mdsg-logo.png')))
      // square logo: cap by height, keep fully inside the header band
      const lh = 54, lw = (logo.width / logo.height) * lh
      page.drawImage(logo, { x: MR - lw, y: 792 - 26 - lh, width: lw, height: lh })
    } catch {}
    dt('SCOPE OF WORK', ML, y, bold, 18, navy); y -= 16
    dt(job.name || '', ML, y, bold, 11, gray); y -= 12
    dt(`${job.gc_name || ''}${job.address ? '  ·  ' + job.address : ''}`, ML, y, font, 9, gray); y -= 8
    page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 1, color: navy }); y -= 18

    for (const [label, value] of rows) {
      const isSection = String(label).startsWith('— ')
      if (isSection) {
        ensure(30)
        y -= 6
        page.drawRectangle({ x: ML, y: y - 3, width: MR - ML, height: 14, color: rgb(0.92, 0.92, 0.96) })
        dt(String(label).replace(/—/g, '').trim(), ML + 6, y, bold, 9, navy)
        y -= 18
      } else {
        ensure(16)
        dt(label, ML + 6, y, bold, 8.5, gray)
        dt(value || '', ML + 210, y, font, 8.5)
        page.drawLine({ start: { x: ML + 208, y: y - 3 }, end: { x: MR, y: y - 3 }, thickness: 0.4, color: line })
        y -= 15
      }
    }

    // GC approval block
    ensure(90)
    y -= 14
    page.drawLine({ start: { x: ML, y }, end: { x: MR, y }, thickness: 1, color: navy }); y -= 20
    dt('GENERAL CONTRACTOR APPROVAL', ML, y, bold, 10, navy); y -= 26
    dt('SIGNED BY:', ML, y, bold, 9, gray)
    page.drawLine({ start: { x: ML + 70, y: y - 2 }, end: { x: ML + 300, y: y - 2 }, thickness: 0.6, color: gray })
    dt('DATE:', ML + 330, y, bold, 9, gray)
    page.drawLine({ start: { x: ML + 370, y: y - 2 }, end: { x: MR, y: y - 2 }, thickness: 0.6, color: gray })
    y -= 30
    dt('MDSG Cabinets  ·  Manufacturer Direct Sales Group', ML, y, font, 7.5, gray)

    const bytes = await pdf.save()
    await supabase.from('activity_log').insert({ job_id: jobId, user_name: 'MDSG', action: 'Scope of Work PDF generated' })
    return new Response(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${(job.name || 'Job').replace(/[^a-zA-Z0-9_-]/g, '_')}_Scope_of_Work.pdf"`,
      },
    })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
