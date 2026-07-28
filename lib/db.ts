// → วางไว้ที่  lib/db.ts
// ตัวช่วยคุย Supabase ทั้งหมดรวมไว้ที่นี่

import { createClient } from '@supabase/supabase-js';

export const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export type Group = {
  id: string;
  line_group_id: string;
  name: string | null;
  open_time: string;
  close_time: string;
};

/** หากลุ่ม ถ้ายังไม่มีให้สร้าง */
export async function upsertGroup(lineGroupId: string): Promise<Group> {
  const { data: existing } = await db
    .from('groups').select('*').eq('line_group_id', lineGroupId).maybeSingle();
  if (existing) return existing as Group;

  const { data, error } = await db
    .from('groups').insert({ line_group_id: lineGroupId }).select().single();
  if (error) throw error;
  return data as Group;
}

/** หาสมาชิก ถ้ายังไม่มีให้สร้าง แล้วผูกเข้ากลุ่ม */
export async function upsertMember(
  lineUserId: string,
  displayName?: string | null,
  groupId?: string,
) {
  const { data, error } = await db
    .from('members')
    .upsert(
      { line_user_id: lineUserId, ...(displayName ? { display_name: displayName } : {}) },
      { onConflict: 'line_user_id' },
    )
    .select()
    .single();
  if (error) throw error;

  if (groupId) {
    await db.from('group_members')
      .upsert({ group_id: groupId, member_id: data.id }, { onConflict: 'group_id,member_id' });
  }
  return data as { id: string; line_user_id: string; display_name: string | null; is_following: boolean };
}

export async function setFollowing(lineUserId: string, following: boolean) {
  await db.from('members')
    .upsert({ line_user_id: lineUserId, is_following: following }, { onConflict: 'line_user_id' });
}

export type NewTask = {
  group_id: string;
  assignee_id: string | null;
  created_by_id: string | null;
  detail: string;
  due_at: string | null;
  due_text: string | null;
  status: 'draft' | 'open';
  source: 'command' | 'ai';
  raw_message: string;
  line_message_id?: string;
};

export async function createTask(t: NewTask) {
  const { data, error } = await db.from('tasks').insert(t).select().single();
  if (error) throw error;
  await logEvent(t.status === 'draft' ? 'ai_suggested' : 'task_created', t.group_id, data.id);
  return data;
}

export async function getTask(id: string) {
  const { data } = await db.from('tasks').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function updateTaskStatus(
  id: string,
  status: 'open' | 'done' | 'cancelled',
) {
  const patch: Record<string, unknown> = { status };
  if (status === 'done') patch.completed_at = new Date().toISOString();

  const { data, error } = await db
    .from('tasks').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function markDmSent(id: string) {
  await db.from('tasks').update({ dm_sent: true }).eq('id', id);
}

export async function logEvent(
  kind: string,
  groupId?: string | null,
  taskId?: string | null,
  payload?: unknown,
) {
  await db.from('events').insert({
    kind,
    group_id: groupId ?? null,
    task_id: taskId ?? null,
    payload: payload ?? null,
  });
}

/** งานค้างของทุกคนในกลุ่ม (ใช้ทำสรุปตอนเช้า) */
export async function openTasksByGroup(lineGroupId: string) {
  const { data } = await db
    .from('v_open_tasks').select('*')
    .eq('line_group_id', lineGroupId)
    .order('due_at', { ascending: true, nullsFirst: false });
  return data ?? [];
}

/** งานค้างทั้งหมด (cron สรุปรายวัน) */
export async function allOpenTasks() {
  const { data } = await db
    .from('v_open_tasks').select('*')
    .order('due_at', { ascending: true, nullsFirst: false });
  return data ?? [];
}
