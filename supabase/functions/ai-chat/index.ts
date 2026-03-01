import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders } from '../_shared/cors.ts'

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_projects',
      description: 'List all projects in the current workspace/organization',
      parameters: { type: 'object', properties: { status: { type: 'string', description: 'Filter by status: active, completed, on_hold, cancelled' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_project',
      description: 'Create a new project',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Project description' },
          status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'cancelled'] },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_project',
      description: 'Update an existing project by ID',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          name: { type: 'string' }, description: { type: 'string' },
          status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'cancelled'] },
          due_date: { type: 'string' },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_tasks',
      description: 'List tasks, optionally filtered by project_id, status, or assigned user',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string' }, status: { type: 'string' }, assigned_to: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Create a new task in a project',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'The project UUID' },
          title: { type: 'string' }, description: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          due_date: { type: 'string' }, assigned_to: { type: 'string', description: 'User UUID to assign' },
        },
        required: ['project_id', 'title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update an existing task by ID',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task UUID' },
          title: { type: 'string' }, description: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          due_date: { type: 'string' }, assigned_to: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_task',
      description: 'Delete a task by ID',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_contacts',
      description: 'List contacts in the workspace, optionally by company',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_contact',
      description: 'Create a new contact',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
          company_id: { type: 'string' }, type: { type: 'string', enum: ['primary', 'billing', 'technical', 'other'] },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_companies',
      description: 'List companies in the workspace',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_company',
      description: 'Create a new company',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, industry: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'link_project_company',
      description: 'Associate a company with a project (linking all its contacts)',
      parameters: { type: 'object', properties: { project_id: { type: 'string' }, company_id: { type: 'string' } }, required: ['project_id', 'company_id'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'link_project_contact',
      description: 'Associate an individual contact with a project',
      parameters: { type: 'object', properties: { project_id: { type: 'string' }, contact_id: { type: 'string' } }, required: ['project_id', 'contact_id'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_project_member',
      description: 'Add a user to a project team',
      parameters: {
        type: 'object',
        properties: { project_id: { type: 'string' }, user_id: { type: 'string' }, role: { type: 'string' } },
        required: ['project_id', 'user_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_org_users',
      description: 'List all users in the current workspace/organization',
      parameters: { type: 'object', properties: {} },
    },
  },
]

async function executeTool(name: string, args: Record<string, string>, orgId: string, userId: string) {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  switch (name) {
    case 'list_projects': {
      let q = admin.from('projects').select('id, name, description, status, due_date, created_at').eq('org_id', orgId).order('updated_at', { ascending: false })
      if (args.status) q = q.eq('status', args.status)
      const { data, error } = await q
      return error ? { error: error.message } : data
    }
    case 'create_project': {
      const { data, error } = await admin.from('projects').insert({
        org_id: orgId, name: args.name, description: args.description || null,
        status: args.status || 'active', due_date: args.due_date || null, created_by: userId,
      }).select('id, name').single()
      if (error) return { error: error.message }
      await admin.from('project_members').insert({ project_id: (data as { id: string }).id, user_id: userId, role: 'owner' })
      return data
    }
    case 'update_project': {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (args.name) updates.name = args.name
      if (args.description !== undefined) updates.description = args.description || null
      if (args.status) updates.status = args.status
      if (args.due_date !== undefined) updates.due_date = args.due_date || null
      const { data, error } = await admin.from('projects').update(updates).eq('id', args.project_id).eq('org_id', orgId).select('id, name, status').single()
      return error ? { error: error.message } : data
    }
    case 'list_tasks': {
      let q = admin.from('tasks').select('id, title, status, priority, due_date, assigned_to, project_id, description').eq('org_id', orgId).order('created_at', { ascending: false })
      if (args.project_id) q = q.eq('project_id', args.project_id)
      if (args.status) q = q.eq('status', args.status)
      if (args.assigned_to) q = q.eq('assigned_to', args.assigned_to)
      const { data, error } = await q
      return error ? { error: error.message } : data
    }
    case 'create_task': {
      const { data, error } = await admin.from('tasks').insert({
        project_id: args.project_id, org_id: orgId, title: args.title,
        description: args.description || null, status: args.status || 'todo',
        priority: args.priority || 'medium', due_date: args.due_date || null,
        assigned_to: args.assigned_to || null, created_by: userId,
      }).select('id, title, status').single()
      return error ? { error: error.message } : data
    }
    case 'update_task': {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (args.title) updates.title = args.title
      if (args.description !== undefined) updates.description = args.description || null
      if (args.status) updates.status = args.status
      if (args.priority) updates.priority = args.priority
      if (args.due_date !== undefined) updates.due_date = args.due_date || null
      if (args.assigned_to !== undefined) updates.assigned_to = args.assigned_to || null
      const { data, error } = await admin.from('tasks').update(updates).eq('id', args.task_id).eq('org_id', orgId).select('id, title, status').single()
      return error ? { error: error.message } : data
    }
    case 'delete_task': {
      const { error } = await admin.from('tasks').delete().eq('id', args.task_id).eq('org_id', orgId)
      return error ? { error: error.message } : { success: true }
    }
    case 'list_contacts': {
      let q = admin.from('contacts').select('id, name, email, phone, company_id, type').eq('org_id', orgId).order('name')
      if (args.company_id) q = q.eq('company_id', args.company_id)
      const { data, error } = await q
      return error ? { error: error.message } : data
    }
    case 'create_contact': {
      const { data, error } = await admin.from('contacts').insert({
        org_id: orgId, name: args.name, email: args.email || null, phone: args.phone || null,
        company_id: args.company_id || null, type: args.type || 'primary',
      }).select('id, name').single()
      return error ? { error: error.message } : data
    }
    case 'list_companies': {
      const { data, error } = await admin.from('companies').select('id, name, industry').eq('org_id', orgId).order('name')
      return error ? { error: error.message } : data
    }
    case 'create_company': {
      const { data, error } = await admin.from('companies').insert({
        org_id: orgId, name: args.name, industry: args.industry || null,
      }).select('id, name').single()
      return error ? { error: error.message } : data
    }
    case 'link_project_company': {
      const { error } = await admin.from('project_companies').insert({ project_id: args.project_id, company_id: args.company_id })
      return error ? { error: error.message } : { success: true, message: `Company linked to project. All contacts under this company are now associated.` }
    }
    case 'link_project_contact': {
      const { error } = await admin.from('project_contacts').insert({ project_id: args.project_id, contact_id: args.contact_id })
      return error ? { error: error.message } : { success: true }
    }
    case 'add_project_member': {
      const { error } = await admin.from('project_members').insert({
        project_id: args.project_id, user_id: args.user_id, role: args.role || 'member',
      })
      return error ? { error: error.message } : { success: true }
    }
    case 'list_org_users': {
      const { data, error } = await admin.from('organization_users').select('user_id, profiles(display_name, email)').eq('org_id', orgId)
      if (error) return { error: error.message }
      return (data ?? []).map((r: { user_id: string; profiles: { display_name: string | null; email: string | null } | { display_name: string | null; email: string | null }[] | null }) => {
        const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
        return { user_id: r.user_id, display_name: p?.display_name, email: p?.email }
      })
    }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser(token)
    if (authErr || !user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const body = await req.json()
    const { message, orgId, history } = body as { message: string; orgId: string; history?: { role: string; content: string }[] }

    if (!orgId) return new Response(JSON.stringify({ error: 'orgId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    if (!OPENAI_API_KEY) return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not configured. Set it via: supabase secrets set OPENAI_API_KEY=sk-...' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const systemPrompt = `You are jolo, an AI assistant for business project management. You help users manage projects, tasks, contacts, and companies within their workspace. Be concise and helpful. When creating or modifying things, confirm what you did. If the user asks to do something and you need more info, ask for it. Use the available tools to interact with the database. The current user's ID is ${user.id}.`

    const messages: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []),
      { role: 'user', content: message },
    ]

    let assistantMessage = ''
    let maxIterations = 5

    while (maxIterations-- > 0) {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
        }),
      })

      if (!openaiRes.ok) {
        const errText = await openaiRes.text()
        return new Response(JSON.stringify({ error: `OpenAI error: ${errText}` }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const completion = await openaiRes.json()
      const choice = completion.choices?.[0]
      const msg = choice?.message

      if (!msg) break

      messages.push(msg)

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function.name
          const fnArgs = JSON.parse(tc.function.arguments || '{}')
          const result = await executeTool(fnName, fnArgs, orgId, user.id)
          messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id })
        }
        continue
      }

      assistantMessage = msg.content ?? ''
      break
    }

    return new Response(JSON.stringify({ message: assistantMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
