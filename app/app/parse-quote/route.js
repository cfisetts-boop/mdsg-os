import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../../lib/supabase'

export const config = {
  api: {
    bodyParser: false,
  },
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// ─── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Read the raw PDF bytes from the request body
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const pdfBuffer = Buffer.concat(chunks)

    if (!pdfBuffer || pdfBuffer.length === 0) {
      return res.status(400).json({ error: 'No PDF data received' })
    }

    const jobId = req.headers['x-job-id'] || null
    const fileName = req.headers['x-file-name'] || 'quote.pdf'

    // Convert PDF to base64 for Claude
    const pdfBase64 = pdfBuffer.toString('base64')

    // ─── Ask Claude to extract the quote data ──────────────────────────────
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
            },
            {
              type: 'text',
              text: `You are parsing a cabinet manufacturer quote PDF for MDSG (Manufacturer Direct Sales Group), a cabinet distributor.

Extract ALL data from this quote and return it as a single valid JSON object. No explanation, no markdown, just the JSON.

Return this exact structure:
{
  "manufacturer": "Leedo or Skyline or SMART or Ukon",
  "quote_number": "the quote/document number",
  "rep_name": "manufacturer sales rep name",
  "quote_date": "YYYY-MM-DD or null",
  "expiry_date": "YYYY-MM-DD or null",
  "project_name": "project name from the document",
  "bill_to": "company being billed",
  "ship_to_address": "shipping address",
  "totals": {
    "gross_amount": 0.00,
    "freight_amount": 0.00,
    "tax_amount": 0.00,
    "grand_total": 0.00,
    "freight_load_count": 0
  },
  "unit_types": [
    {
      "unit_type_name": "e.g. 1BR/2BR (67)",
      "unit_quantity": 1,
      "cabinet_count": 0,
      "total_cubes": 0.00,
      "gross_price": 0.00,
      "line_items": [
        {
          "sku": "e.g. W2436R",
          "description": "cabinet description",
          "door_style": "door style name",
          "finish": "color/finish name",
          "hinge_side": "L or R or L/R or NA",
          "quantity": 0,
          "extended_price": 0.00
        }
      ]
    }
  ],
  "summary_notes": "any important notes from the document"
}

Be precise with numbers — copy them exactly from the document. If a field is not present, use null.`,
            },
          ],
        },
      ],
    })

    // Parse Claude's JSON response
    const rawText = extraction.content[0].text
    let parsedQuote

    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/```json|```/g, '').trim()
      parsedQuote = JSON.parse(cleaned)
    } catch (parseError) {
      console.error('JSON parse error:', parseError)
      return res.status(422).json({
        error: 'Could not parse AI response as JSON',
        raw: rawText.substring(0, 500),
      })
    }

    // ─── Save to Supabase if a jobId was provided ──────────────────────────
    let savedQuote = null

    if (jobId) {
      const { data, error } = await supabase
        .from('manufacturer_quotes')
        .insert({
          job_id: jobId,
          manufacturer: parsedQuote.manufacturer,
          quote_number: parsedQuote.quote_number,
          rep_name: parsedQuote.rep_name,
          quote_date: parsedQuote.quote_date,
          expiry_date: parsedQuote.expiry_date,
          raw_extracted_json: parsedQuote,
          gross_amount: parsedQuote.totals?.gross_amount || 0,
          freight_amount: parsedQuote.totals?.freight_amount || 0,
          grand_total: parsedQuote.totals?.grand_total || 0,
          total_units: parsedQuote.unit_types?.reduce((sum, u) => sum + (u.unit_quantity || 0), 0) || 0,
          total_cabinets: parsedQuote.unit_types?.reduce((sum, u) => sum + (u.cabinet_count || 0), 0) || 0,
          file_name: fileName,
          parsed_at: new Date().toISOString(),
        })
        .select()
        .single()

      if (error) {
        console.error('Supabase insert error:', error)
      } else {
        savedQuote = data
      }

      // Also save the unit types and line items if we have a jobId
      if (parsedQuote.unit_types && parsedQuote.unit_types.length > 0) {
        for (let i = 0; i < parsedQuote.unit_types.length; i++) {
          const unitType = parsedQuote.unit_types[i]

          const { data: utData, error: utError } = await supabase
            .from('unit_types')
            .insert({
              job_id: jobId,
              unit_type_name: unitType.unit_type_name,
              unit_quantity: unitType.unit_quantity || 1,
              cabinet_count: unitType.cabinet_count || 0,
              total_cubes: unitType.total_cubes || 0,
              manufacturer_price: unitType.gross_price || 0,
              sort_order: i,
            })
            .select()
            .single()

          if (!utError && utData && unitType.line_items) {
            const lineItems = unitType.line_items.map((item, j) => ({
              unit_type_id: utData.id,
              job_id: jobId,
              sku: item.sku,
              description: item.description,
              door_style: item.door_style,
              finish: item.finish,
              hinge_side: item.hinge_side,
              quantity: item.quantity || 1,
              extended_price: item.extended_price || 0,
              sort_order: j,
            }))

            await supabase.from('cabinet_line_items').insert(lineItems)
          }
        }

        // Update the job's totals
        await supabase
          .from('jobs')
          .update({
            manufacturer: parsedQuote.manufacturer,
            manufacturer_quote_number: parsedQuote.quote_number,
            manufacturer_rep: parsedQuote.rep_name,
            manufacturer_gross_cost: parsedQuote.totals?.gross_amount || 0,
            freight_cost: parsedQuote.totals?.freight_amount || 0,
            total_cabinet_count: parsedQuote.unit_types?.reduce((sum, u) => sum + (u.cabinet_count || 0), 0) || 0,
            unit_type_count: parsedQuote.unit_types?.length || 0,
          })
          .eq('id', jobId)

        // Log the activity
        await supabase.from('activity_log').insert({
          job_id: jobId,
          user_name: 'System',
          action: `Manufacturer quote parsed — ${parsedQuote.manufacturer} quote #${parsedQuote.quote_number} · $${parsedQuote.totals?.grand_total?.toLocaleString()} grand total`,
        })
      }
    }

    return res.status(200).json({
      success: true,
      parsed: parsedQuote,
      saved_quote_id: savedQuote?.id || null,
      summary: {
        manufacturer: parsedQuote.manufacturer,
        quote_number: parsedQuote.quote_number,
        unit_type_count: parsedQuote.unit_types?.length || 0,
        total_cabinets: parsedQuote.unit_types?.reduce((sum, u) => sum + (u.cabinet_count || 0), 0) || 0,
        grand_total: parsedQuote.totals?.grand_total || 0,
      },
    })
  } catch (error) {
    console.error('Parse quote error:', error)
    return res.status(500).json({
      error: 'Failed to parse quote',
      message: error.message,
    })
  }
}
