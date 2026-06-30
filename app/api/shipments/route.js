import { createClient } from '@supabase/supabase-js'

export async function GET(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const { searchParams } = new URL(request.url)
    const jobId = searchParams.get('jobId')

    let query = supabase
      .from('shipments')
      .select('*, jobs(name, gc_name, stage)')
      .order('scheduled_date', { ascending: true })

    if (jobId) {
      query = query.eq('job_id', jobId)
    } else {
      // Dashboard view — only active shipments (not delivered)
      query = query.neq('status', 'Delivered')
    }

    const { data, error } = await query
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json(data || [])
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const body = await request.json()
    const { action } = body

    // Create new shipment
    if (action === 'create') {
      const { data, error } = await supabase
        .from('shipments')
        .insert({
          job_id: body.job_id,
          load_number: body.load_number || 1,
          total_loads: body.total_loads || 1,
          tracking_number: body.tracking_number || null,
          carrier: body.carrier || 'UPS Freight',
          floors_covered: body.floors_covered || null,
          cabinet_count: body.cabinet_count || null,
          scheduled_date: body.scheduled_date || null,
          actual_delivery_date: body.actual_delivery_date || null,
          status: body.status || 'Scheduled',
          delivery_contact: body.delivery_contact || null,
          notes: body.notes || null,
        })
        .select()
        .single()

      if (error) return Response.json({ error: error.message }, { status: 500 })

      // Log activity
      await supabase.from('activity_log').insert({
        job_id: body.job_id,
        user_name: body.user || 'System',
        action: `Shipment added — Load ${body.load_number} of ${body.total_loads} · ${body.carrier} · Expected ${body.scheduled_date || 'TBD'}`,
      })

      return Response.json({ success: true, shipment: data })
    }

    // Update shipment status or details
    if (action === 'update') {
      const updateData = {}
      if (body.status !== undefined) updateData.status = body.status
      if (body.tracking_number !== undefined) updateData.tracking_number = body.tracking_number
      if (body.scheduled_date !== undefined) updateData.scheduled_date = body.scheduled_date
      if (body.actual_delivery_date !== undefined) updateData.actual_delivery_date = body.actual_delivery_date
      if (body.floors_covered !== undefined) updateData.floors_covered = body.floors_covered
      if (body.cabinet_count !== undefined) updateData.cabinet_count = body.cabinet_count
      if (body.carrier !== undefined) updateData.carrier = body.carrier
      if (body.delivery_contact !== undefined) updateData.delivery_contact = body.delivery_contact
      if (body.notes !== undefined) updateData.notes = body.notes

      const { data, error } = await supabase
        .from('shipments')
        .update(updateData)
        .eq('id', body.id)
        .select()
        .single()

      if (error) return Response.json({ error: error.message }, { status: 500 })

      // Log status changes
      if (body.status) {
        await supabase.from('activity_log').insert({
          job_id: data.job_id,
          user_name: body.user || 'System',
          action: `Shipment Load ${data.load_number} status → ${body.status}${body.status === 'Delivered' ? ' ✓' : ''}`,
        })

        // Auto-update job stage to Delivered if all loads delivered
        if (body.status === 'Delivered' && body.job_id) {
          const { data: allShipments } = await supabase
            .from('shipments')
            .select('status')
            .eq('job_id', body.job_id)

          const allDelivered = allShipments?.every(s => s.status === 'Delivered')
          if (allDelivered) {
            await supabase.from('jobs').update({ stage: 'Delivered' }).eq('id', body.job_id)
            await supabase.from('activity_log').insert({
              job_id: body.job_id,
              user_name: 'System',
              action: 'All loads delivered — job stage updated to Delivered',
            })
          }
        }
      }

      return Response.json({ success: true, shipment: data })
    }

    // Delete shipment
    if (action === 'delete') {
      const { error } = await supabase.from('shipments').delete().eq('id', body.id)
      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json({ success: true })
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
