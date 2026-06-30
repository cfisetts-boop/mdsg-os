import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function POST(request) {
  try {
    const { pdfBase64 } = await request.json();

    if (!pdfBase64) {
      return Response.json({ error: 'No PDF data received' }, { status: 400 });
    }

    console.log('Starting page classification...');

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
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
              text: `You are analyzing a multifamily apartment construction plan set for a cabinet and countertop takeoff.

Classify EVERY single page in this PDF. Return ONLY a valid JSON array — no markdown, no explanation, no extra text.

Page type definitions:
- "elevation": cabinet elevation drawings showing cabinet door and drawer layout — THESE ARE THE MOST IMPORTANT PAGES
- "floor_plan": unit floor plan showing room layout and dimensions
- "unit_schedule": table listing unit types, quantities, and square footages
- "finish_schedule": finish, material, or specification schedules
- "amenity": common area plans — clubhouse, fitness center, leasing office, lobby, mail room, pool deck
- "site_plan": site layout or building location plan
- "detail": construction detail drawings
- "cover_sheet": title page, index page, or sheet list
- "other": mechanical, electrical, plumbing, structural, or anything not listed above

For each page return exactly these four fields:
- page: page number starting at 1
- type: one of the exact strings listed above
- label: short description, max 6 words (e.g. "Unit 1A kitchen elevation", "Unit count schedule", "Clubhouse floor plan")
- unit_type: for floor_plan and elevation pages only, the unit type shown such as "1A", "2B", "1A-ADA". For all other pages use null.

Return ONLY a JSON array like this, nothing else:
[{"page":1,"type":"cover_sheet","label":"Title sheet and index","unit_type":null},{"page":2,"type":"elevation","label":"Unit 1A kitchen elevation","unit_type":"1A"}]`
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text.trim();

    // Safely extract JSON array from response
    let classification;
    try {
      const jsonStart = rawText.indexOf('[');
      const jsonEnd = rawText.lastIndexOf(']');
      if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('No JSON array found in AI response');
      }
      const jsonString = rawText.substring(jsonStart, jsonEnd + 1);
      classification = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Classification parse error:', parseError);
      return Response.json({
        error: 'Failed to parse AI classification response',
        raw: rawText.substring(0, 500)
      }, { status: 500 });
    }

    // Count pages by type
    const summary = classification.reduce((acc, page) => {
      acc[page.type] = (acc[page.type] || 0) + 1;
      return acc;
    }, {});

    // Get unique unit types found across all pages
    const unitTypesFound = [...new Set(
      classification
        .filter(p => p.unit_type !== null && p.unit_type !== undefined)
        .map(p => p.unit_type)
    )].sort();

    // Build page number lists by type — used by downstream agents
    const pagesByType = classification.reduce((acc, page) => {
      if (!acc[page.type]) acc[page.type] = [];
      acc[page.type].push(page.page);
      return acc;
    }, {});

    // Build page number lists by unit type — used by Elevation Engine
    const pagesByUnitType = classification.reduce((acc, page) => {
      if (page.unit_type) {
        if (!acc[page.unit_type]) acc[page.unit_type] = [];
        acc[page.unit_type].push(page.page);
      }
      return acc;
    }, {});

    console.log('Classification complete. Summary:', summary);
    console.log('Unit types found:', unitTypesFound);

    return Response.json({
      success: true,
      totalPages: classification.length,
      classification,
      summary,
      unitTypesFound,
      pagesByType,
      pagesByUnitType
    });

  } catch (error) {
    console.error('Classifier error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
