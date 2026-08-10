import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role needed for storage operations
)

const BUCKET = 'job-files'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })

  try {
    const { data, error } = await supabase.storage.from(BUCKET).list(jobId, {
      limit: 200, offset: 0, sortBy: { column: 'created_at', order: 'desc' }
    })
    if (error) throw error

    const files = (data || []).map(f => ({
      name:       f.name,
      size:       f.metadata?.size || 0,
      created_at: f.created_at,
      path:       `${jobId}/${f.name}`,
      category:   f.name.split('__')[0] || 'Other',
      label:      (f.name.split('__')[1] || f.name).replace(/\.[^.]+$/, ''),
    }))
    return Response.json({ files })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const jobId    = formData.get('jobId')
    const category = formData.get('category') || 'Other'
    const file     = formData.get('file')

    if (!jobId || !file) return Response.json({ error: 'jobId and file required' }, { status: 400 })

    // Prefix with category so files sort/filter cleanly
    const timestamp = Date.now()
    const safeName  = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    const storagePath = `${jobId}/${category}__${timestamp}__${safeName}`

    const buffer = await file.arrayBuffer()
    const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
    if (error) throw error

    // Log the upload
    await supabase.from('activity_log').insert({
      job_id: jobId, user_name: 'Cole',
      action: `File uploaded: ${category} — ${file.name}`,
    })

    return Response.json({ success: true, path: storagePath })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(request) {
  try {
    const { jobId, path } = await request.json()
    if (!jobId || !path) return Response.json({ error: 'jobId and path required' }, { status: 400 })
    if (!path.startsWith(jobId + '/')) return Response.json({ error: 'Unauthorized' }, { status: 403 })

    const { error } = await supabase.storage.from(BUCKET).remove([path])
    if (error) throw error
    return Response.json({ success: true })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

export async function PUT(request) {
  // Signed URL for download
  try {
    const { path } = await request.json()
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300) // 5 min
    if (error) throw error
    return Response.json({ url: data.signedUrl })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
