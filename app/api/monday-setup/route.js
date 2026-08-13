export async function GET(request) {
  const token  = process.env.MONDAY_API_KEY
  const secret = process.env.MONDAY_WEBHOOK_SECRET
  const boardId = '18392215392'
  const webhookUrl = 'https://mdsg-os.vercel.app/api/monday-webhook'

  if (!token) {
    return Response.json({ error: 'MONDAY_API_KEY not set in environment variables' }, { status: 500 })
  }

  const results = []

  // Register webhook for both events
  for (const event of ['create_item', 'change_column_value', 'change_name']) {
    try {
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
          'API-Version': '2024-01',
        },
        body: JSON.stringify({
          query: `
            mutation {
              create_webhook(
                board_id: ${boardId},
                url: "${webhookUrl}",
                event: ${event}
              ) {
                id
                board_id
              }
            }
          `
        }),
      })

      const data = await res.json()

      if (data.errors) {
        results.push({ event, success: false, error: data.errors[0].message })
      } else {
        results.push({ event, success: true, webhook_id: data.data?.create_webhook?.id })
      }
    } catch (err) {
      results.push({ event, success: false, error: err.message })
    }
  }

  const allGood = results.every(r => r.success)

  // Return a simple HTML page so it's readable in the browser
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Monday Webhook Setup</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; }
        h1 { color: #3C3489; }
        .ok  { background: #e8f5e9; border: 1px solid #4caf50; border-radius: 8px; padding: 16px; margin: 12px 0; }
        .err { background: #fdecea; border: 1px solid #f44336; border-radius: 8px; padding: 16px; margin: 12px 0; }
        code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
      </style>
    </head>
    <body>
      <h1>Monday Webhook Setup</h1>
      <p>Board: <code>${boardId}</code> → <code>${webhookUrl}</code></p>
      ${results.map(r => `
        <div class="${r.success ? 'ok' : 'err'}">
          <strong>${r.success ? '✓' : '✗'} ${r.event}</strong><br/>
          ${r.success
            ? `Webhook registered — ID: <code>${r.webhook_id}</code>`
            : `Error: ${r.error}`
          }
        </div>
      `).join('')}
      ${allGood
        ? `<p><strong>All done!</strong> Your Monday board will now push jobs to MDSG OS automatically. Add a test item to your board to confirm it appears in the OS within a few seconds.</p>`
        : `<p>Some webhooks failed — check that your MONDAY_API_KEY is correct and has admin access to the board.</p>`
      }
    </body>
    </html>
  `

  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
