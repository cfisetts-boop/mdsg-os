import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request) {
  try {
    const arrayBuffer = await request.arrayBuffer()
    const b64 = Buffer.from(arrayBuffer).toString('base64')
    const jobId = request.headers.get('x-job-id')

    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: `Extract the key details from this countertop fabricator quote. Return ONLY valid JSON:
{
  "fabricator": "company name",
  "material_type": "Quartz / Granite / Laminate / Solid Surface / Cultured Marble",
  "color": "color or pattern name",
  "total_amount": 12500.00,
  "includes_installation": true,
  "notes": "any important scope notes or exclusions"
}

total_amount = the grand total or subtotal before tax. If installation is separate, note it.` }
        ],
      }],
    })

    const raw = res.content[0].text.trim().replace(/^```[a-z]*\n?/gm,'').replace(/^```\n?/gm,'').trim()
    const f = raw.indexOf('{'), l = raw.lastIndexOf('}')
    let parsed = null
    if (f !== -1 && l > f) try { parsed = JSON.parse(raw.substring(f, l+1)) } catch(_) {}

    if (!parsed?.total_amount) {
      return Response.json({ error: 'Could not extract a total amount from this PDF. Make sure it is a fabricator quote with a clear total.' }, { status: 422 })
    }

    if (jobId) {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      await supabase.from('activity_log').insert({
        job_id: jobId,
        user_name: 'System',
        action: `Countertop quote uploaded — ${parsed.fabricator || 'Fabricator'} · ${parsed.material_type || ''} · $${Math.round(parsed.total_amount).toLocaleString()}`,
      })
    }

    return Response.json({ success: true, ...parsed })
  } catch (err) {
    console.error('Countertop quote parse error:', err)
    return Response.json({ error: err.message }, { status: 500 })
  }
}
