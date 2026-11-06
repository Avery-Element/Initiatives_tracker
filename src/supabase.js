// All Supabase access for the Initiatives Tracker (same pattern as the other Element apps:
// screens call these functions, never the client directly). Each resolves { data } or { error }.
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { flowType: 'implicit' } }
)

// --- Accounts (shared with Stanley, Shipping, Maintenance) ---

// Username accounts sign in as <username>@LOGIN_DOMAIN. Must match Stanley's admin-users function.
export const LOGIN_DOMAIN = 'users.elementcontract.com'
export const toLoginEmail = (identifier) => {
  const id = (identifier || '').trim().toLowerCase()
  return id.includes('@') ? id : `${id}@${LOGIN_DOMAIN}`
}
export const loginName = (email, username) => username || email || ''

// { user_id, email, username, display_name, must_change_password, disabled, init_role, person_id, person_name, today, week_start }
export async function fetchMyAccess() {
  const { data, error } = await supabase.rpc('init_my_access')
  if (error) { console.error('fetchMyAccess error:', error); return null }
  return data
}
export async function markPasswordChanged() {
  const { error } = await supabase.rpc('app_password_changed')
  if (error) console.error('markPasswordChanged error:', error)
}
export async function logSignIn() {
  const { error } = await supabase.rpc('init_log_signin')
  if (error) console.error('logSignIn error:', error)
}

// --- Helpers ---

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) { console.error(`${name} error:`, error); return { error: error.message } }
  return { data }
}
async function run(q, label) {
  const { data, error } = await q
  if (error) { console.error(`${label} error:`, error); return { error: error.message } }
  return { data: data ?? null }
}

// --- Boards ---

export const fetchProjects = () =>
  run(supabase.from('init_project_board').select('*').order('sort_order').order('name'), 'fetchProjects')
export const fetchTasks = () =>
  run(supabase.from('init_task_board').select('*').eq('project_archived', false).order('position'), 'fetchTasks')
export const fetchPeople = () =>
  run(supabase.from('init_people_board').select('*').order('display_name'), 'fetchPeople')
export const fetchAssignable = () => rpc('init_assignable_people')
export const fetchDigest = (weekStart) => rpc('init_digest', { p_week_start: weekStart || null })

// --- Projects ---

export const saveProject = (id, fields) => id
  ? run(supabase.from('init_projects').update(fields).eq('id', id).select().single(), 'saveProject')
  : run(supabase.from('init_projects').insert(fields).select().single(), 'saveProject')

// --- Tasks ---

export const addTask = (fields) => run(supabase.from('init_tasks').insert(fields).select().single(), 'addTask')
export const updateTask = (id, patch) => run(supabase.from('init_tasks').update(patch).eq('id', id).select('id'), 'updateTask')
export const deleteTask = (id) => run(supabase.from('init_tasks').delete().eq('id', id), 'deleteTask')
export const setAssignees = (taskId, personIds) => rpc('init_set_assignees', { p_task_id: taskId, p_person_ids: personIds })
export const addNote = (taskId, body) => rpc('init_add_note', { p_task_id: taskId, p_body: body })
export const reorderTasks = (projectId, taskIds) => rpc('init_reorder_tasks', { p_project_id: projectId, p_task_ids: taskIds })

export const fetchTaskActivity = (taskId) =>
  run(supabase.from('init_activity').select('*').eq('task_id', taskId).order('at', { ascending: false }).limit(100), 'fetchTaskActivity')
export const fetchActivity = ({ projectId, limit = 300 } = {}) => {
  let q = supabase.from('init_activity').select('*').order('at', { ascending: false }).limit(limit)
  if (projectId) q = q.eq('project_id', projectId)
  return run(q, 'fetchActivity')
}

// --- People + logins (admin) ---

// Everyone on the people list, including inactive (Admin → People)
export const fetchAllPeople = () => run(supabase.from('init_people').select('*').order('display_name'), 'fetchAllPeople')
export const savePerson = (id, fields) => id
  ? run(supabase.from('init_people').update(fields).eq('id', id).select().single(), 'savePerson')
  : run(supabase.from('init_people').insert(fields).select().single(), 'savePerson')
export const listLogins = () => rpc('init_list_users')
export const setUserRole = (userId, role) => rpc('init_set_user_role', { p_user_id: userId, p_role: role })

// --- Email (admin) ---

export const fetchSettings = () => run(supabase.from('init_settings').select('*').maybeSingle(), 'fetchSettings')
export const saveSettings = (patch) => rpc('init_update_settings', { p_patch: patch })
export const sendDigestNow = (weekStart) => rpc('init_send_digest_now', { p_week_start: weekStart || null })
export const sendRemindersNow = () => rpc('init_send_reminders_now')
export const sendTest = (to) => rpc('init_send_test', { p_to: to || null })
export const fetchOutbox = () =>
  run(supabase.from('init_outbox').select('id, key, kind, recipients, subject, created_at, sent_at, attempts, last_error')
    .order('created_at', { ascending: false }).limit(40), 'fetchOutbox')

// --- Live updates ---

// Calls onChange (debounced) when projects, tasks, assignments or people change
export function subscribeToChanges(onChange) {
  let timer = null
  const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 400) }
  const channel = supabase.channel('init-board')
  for (const table of ['init_projects', 'init_tasks', 'init_task_assignees', 'init_people'])
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire)
  channel.subscribe(status => { if (status === 'CHANNEL_ERROR') console.error('Realtime channel error — live updates disabled') })
  return () => { clearTimeout(timer); supabase.removeChannel(channel) }
}
