import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SHOP_PROMPT = `You are an expert cabinet takeoff specialist reading Cyncly shop drawings for MDSG.

These shop drawings follow a completely consistent format. Each page = exactly one unit type.

PAGE FORMAT:
- Top right: Project name, then "UNIT_TYPE_NAME - N TOTAL UNITS"
- Below that: "AS SHOWN: [unit numbers]" and/or "REVERSE: [unit numbers]" or "REVERSE-N UNITS"
- Left side: Kitchen elevation showing cabinet SKUs labeled inside each box
- Right side: Bathroom/vanity elevation showing vanity SKUs labeled inside each box
- Fillers are labeled between cabinets (F330L, F330.5L, F630L, F630.5L, etc.)
- Top overall dimension of kitchen run = countertop linear feet (divide inches by 12)
- Top overall dimension of vanity run = vanity linear feet (divide inches by 12)

SKU NAMING RULES:
- W = Wall cabinet (W3030 = 30 wide x 30 high)
- B = Base cabinet (B24 = 24 wide)
- DB = Drawer base (DB18-3 = 18 wide, 3 drawers)
- SB = Sink base (SB33 = 33 wide)
- BB = Blind base
- BW = Blind wall
- EPB = End panel base
- BMC = Base microwave cabinet
- T = Tall cabinet
- VB = Vanity base
- VDB = Vanity drawer base (VDB18H-3 = 18 wide, H height, 3 drawers)
- VSB = Vanity sink base (VSB36 = 36 wide)
- VDB with H suffix = handicap/ADA height vanity
- HCB = Handicap cabinet base
- UFASIOHCSB = Under frame accessible sink base
- F330L, F330.5L, F630L, F630.5L = Fillers (go in fillers array, NOT skus)
- RANGE1.30, DISHW18, DISH-IQ6 = Appliances (EXCLUDE from output entirely)

ADA/ACCESSIBLE UNITS:
- If the page title contains "ADA", "ACCESSIBLE", or "HC", mark is_ada: true
- Keep ADA units completely separate from standard units — never merge

COUNTERTOP LF CALCULATION:
- Find the largest overall dimension spanning the full kitchen run (usually labeled at top)
- Divide by 12 to get linear feet, round to 1 decimal
- For L-shaped kitchens with two runs, add both dimensions

VANITY LF CALCULATION:
- Find the overall dimension spanning the full vanity run
- Divide by 12 to get linear feet, round to 1 decimal
- If multiple separate vanities, add them

EXTRACT from EVERY PAGE and return this exact JSON:
{
  "project_name": "string from title block",
  "unit_types": [
    {
      "unit_type_name": "1BR-A",
      "total_units": 12,
      "as_shown_count": 10,
      "reverse_count": 2,
      "is_ada": false,
      "kitchen_skus": [
        { "sku": "W3030", "quantity": 1, "location": "kitchen" },
        { "sku": "B24", "quantity": 1, "location": "kitchen" }
      ],
      "bathroom_skus": [
        { "sku": "VSB36", "quantity": 1, "location": "bathroom" },
        { "sku": "VDB18H-3", "quantity": 1, "location": "bathroom" }
      ],
      "fillers": [
        { "sku": "F330L", "quantity": 1, "location": "kitchen" }
      ],
      "countertop_lf": 12.9,
      "vanity_lf": 4.6
    }
  ]
}

CRITICAL RULES:
1. One entry per page — never skip a page
2. Never merge ADA units with standard units
3. Never include appliances (RANGE, DISH, DW, REF, MICRO) in skus or fillers
4. Fillers (F330L, F630.5L, etc.) go in fillers array only
5. Count SKUs exactly as labeled — if W3030 appears twice in a layout, quantity = 2
6. Return ONLY valid JSON, no other text`

function safeParseJSON(raw) {
  try { return JSON.parse(raw) } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.substring(s, e + 1)) } catch (_) {}
  }
  throw new Error('Could not parse JSON from AI response')
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files')

    if (!files || files.length === 0) {
      return Response.json({ error: 'No files uploaded' }, { status: 400 })
    }

    // Merge all PDFs into one base64 string — send directly to Opus
    const pdfFile = files[0]
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer())
    const base64 = pdfBytes.toString('base64')

    console.log(`Shop drawing extraction: ${files.length} file(s), ${Math.round(pdfBytes.length / 1024)}KB`)

    const res = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 12000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64
            }
          },
          {
            type: 'text',
            text: SHOP_PROMPT
          }
        ]
      }]
    })

    const raw = res.content[0].text
    const parsed = safeParseJSON(raw)

    if (!parsed.unit_types || !Array.isArray(parsed.unit_types)) {
      return Response.json({ error: 'AI did not return valid unit types' }, { status: 422 })
    }

    // Normalize into the format TakeoffEngine expects for shopCabinetData
    const shopCabinetData = parsed.unit_types.map(ut => ({
      unit_type_name: ut.unit_type_name,
      unit_count: ut.total_units || 1,
      as_shown_count: ut.as_shown_count || ut.total_units || 1,
      reverse_count: ut.reverse_count || 0,
      is_ada: ut.is_ada || false,
      countertop_lf: ut.countertop_lf || 0,
      vanity_lf: ut.vanity_lf || 0,
      skus: [
        ...(ut.kitchen_skus || []).map(s => ({
          sku: s.sku,
          qty: s.quantity || 1,
          type: 'cabinet',
          location: 'kitchen',
          description: s.sku,
        })),
        ...(ut.bathroom_skus || []).map(s => ({
          sku: s.sku,
          qty: s.quantity || 1,
          type: 'cabinet',
          location: 'bathroom',
          description: s.sku,
        })),
      ],
      fillers: (ut.fillers || []).map(f => ({
        sku: f.sku,
        qty: f.quantity || 1,
        type: 'filler',
        location: f.location || 'kitchen',
        description: f.sku,
      })),
    }))

    return Response.json({
      success: true,
      project_name: parsed.project_name || '',
      unit_types: shopCabinetData,
      summary: {
        unit_type_count: shopCabinetData.length,
        total_units: shopCabinetData.reduce((s, u) => s + (u.unit_count || 1), 0),
      }
    })

  } catch (error) {
    console.error('Shop extraction error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}
