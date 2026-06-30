import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
    const jobId = request.headers.get('x-job-id')
    const fileName = request.headers.get('x-file-name') || 'quote.pdf'
    const pdfBuffer = await request.arrayBuffer()
    if (!pdfBuffer || pdfBuffer.byteLength === 0) {
      return Response.json({ error: 'No PDF data received' }, { status: 400 })
    }
    const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `Parse this cabinet manufacturer quote PDF and return ONLY a JSON object, no markdown, no explanation. Use this structure:
{"manufacturer":"Leedo","quote_number":"","rep_name":"","quote_date":null,"expiry_date":null,"project_name":"","totals":{"gross_amount":0,"freight_amount":0,"tax_amount":0,"grand_total":0,"freight_load_count":0},"unit_types":[{"unit_type_name":"","unit_quantity":1,"cabinet_count":0,"total_cubes":0,"gross_price":0,"line_items":[{"sku":"","description":"","door_style":"","finish":"","hinge_side":"","quantity":0,"extended_price":0}]}]}` }
        ]
      }]
    })
    const rawText = extraction.content[0].text
    let parsedQuote
    try {
      parsedQuote = JSON.parse(rawText.replace(/```json|```/g, '').trim())
    } catch (e) {
      return Response.json({ error: 'Could not parse AI response', raw: rawText.substring(0, 500) }, { status: 422 })
    }
    if (jobId) {
      await supabase.from('manufacturer_quotes').insert({
        job_id: jobId, manufacturer: parsedQuote.manufacturer,
        quote_number: parsedQuote.quote_number, rep_name: parsedQuote.rep_name,
        quote_date: parsedQuote.quote_date, expiry_date: parsedQuote.expiry_date,
        raw_extracted_json: parsedQuote,
        gross_amount: parsedQuote.totals?.gross_amount || 0,
        freight_amount: parsedQuote.totals?.freight_amount || 0,
        grand_total: parsedQuote.totals?.grand_total || 0,
        total_units: parsedQuote.unit_types?.reduce((s,u)=>s+(u.unit_quantity||0),0)||0,
        total_cabinets: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        file_name: fileName, parsed_at: new Date().toISOString(),
      })
      for (let i = 0; i < (parsedQuote.unit_types||[]).length; i++) {
        const ut = parsedQuote.unit_types[i]
        const { data: utData } = await supabase.from('unit_types').insert({
          job_id: jobId, unit_type_name: ut.unit_type_name,
          unit_quantity: ut.unit_quantity||1, cabinet_count: ut.cabinet_count||0,
          total_cubes: ut.total_cubes||0, manufacturer_price: ut.gross_price||0, sort_order: i,
        }).select().single()
        if (utData && ut.line_items?.length > 0) {
          await supabase.from('cabinet_line_items').insert(
            ut.line_items.map((item,j)=>({
              unit_type_id: utData.id, job_id: jobId, sku: item.sku,
              description: item.description, door_style: item.door_style,
              finish: item.finish, hinge_side: item.hinge_side,
              quantity: item.quantity||1, extended_price: item.extended_price||0, sort_order: j,
            }))
          )
        }
      }
      await supabase.from('jobs').update({
        manufacturer: parsedQuote.manufacturer,
        manufacturer_quote_number: parsedQuote.quote_number,
        manufacturer_rep: parsedQuote.rep_name,
        manufacturer_gross_cost: parsedQuote.totals?.gross_amount||0,
        freight_cost: parsedQuote.totals?.freight_amount||0,
        total_cabinet_count: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        unit_type_count: parsedQuote.unit_types?.length||0,
      }).eq('id', jobId)
      await supabase.from('activity_log').insert({
        job_id: jobId, user_name: 'System',
        action: `Quote parsed — ${parsedQuote.manufacturer} #${parsedQuote.quote_number} · $${parsedQuote.totals?.grand_total?.toLocaleString()} grand total`,
      })
    }
    return Response.json({
      success: true, parsed: parsedQuote,
      summary: {
        manufacturer: parsedQuote.manufacturer,
        quote_number: parsedQuote.quote_number,
        unit_type_count: parsedQuote.unit_types?.length||0,
        total_cabinets: parsedQuote.unit_types?.reduce((s,u)=>s+(u.cabinet_count||0),0)||0,
        grand_total: parsedQuote.totals?.grand_total||0,
      },
    })
  } catch (error) {
    console.error('Parse quote error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}