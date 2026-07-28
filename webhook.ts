// → วางไว้ที่  api/webhook.ts
// จุดรับ webhook จาก LINE — หัวใจของบอททั้งตัว
//
// ตั้ง Webhook URL ใน LINE Developers Console เป็น
//   https://<your-app>.vercel.app/api/webhook

import { verifySignature, reply, push, getGroupMemberProfile,
         text, textWithQuickReply, taskCard } from '../lib/line.js';
import { parseCommand, resolveDueAt, formatDue } from '../lib/parse.js';
import { suggestTask, worthAsking } from '../lib/llm.js';
import * as store from '../lib/db.js';

// ใช้ Edge runtime เพราะ:
//  1. ได้ raw body เป๊ะ ๆ ผ่าน req.text() — จำเป็นต่อการตรวจลายเซ็น
//     (Node runtime ของ Vercel parse body ให้อัตโนมัติ ทำให้ byte ไม่ตรง)
//  2. ไม่ถูกแช่แข็งกลางคันหลังส่ง response
export const config = { runtime: 'edge' };

// ─── entry point ───────────────────────────────────────────────
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const raw = await req.text();
  const ok = await verifySignature(raw, req.headers.get('x-line-signature') ?? undefined);
  if (!ok) {
    console.warn('signature mismatch — ปฏิเสธ request');
    return new Response('Unauthorized', { status: 401 });
  }

  // ต้องทำงานให้เสร็จ "ก่อน" ตอบกลับ ไม่งั้น serverless อาจตัดกลางคัน
  // LINE ยอมรอได้หลายวินาที และจะ retry ให้ถ้า timeout
  const body = JSON.parse(raw) as { events?: any[] };
  for (const ev of body.events ?? []) {
    try {
      await route(ev);
    } catch (err) {
      console.error('event error', ev.type, err);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── routing ───────────────────────────────────────────────────
async function route(ev: any) {
  switch (ev.type) {
    case 'message':
      if (ev.message?.type === 'text') return onTextMessage(ev);
      return;
    case 'postback':  return onPostback(ev);
    case 'follow':    return store.setFollowing(ev.source.userId, true);
    case 'unfollow':  return store.setFollowing(ev.source.userId, false);
    case 'join':      return onJoinGroup(ev);
    default:          return;
  }
}

// ─── บอทถูกเชิญเข้ากลุ่ม ────────────────────────────────────────
async function onJoinGroup(ev: any) {
  const groupId = ev.source.groupId;
  if (!groupId) return;
  await store.upsertGroup(groupId);

  await reply(ev.replyToken, [text(
    'สวัสดีค่ะ 🌱 ฉันจะช่วยเก็บงานที่สั่งกันในกลุ่มนี้ไม่ให้หลุด\n\n' +
    'วิธีสั่งงาน:\n' +
    '/งาน @ชื่อคน รายละเอียด เวลา\n\n' +
    'ตัวอย่าง:\n' +
    '/งาน @ฝน เช็คสต็อกแก้ว ก่อนบ่าย 3\n\n' +
    '⚠️ สำคัญ: ทุกคนต้องแอดฉันเป็นเพื่อนก่อน ฉันถึงจะส่งงานไปหาในแชทส่วนตัวได้\n\n' +
    'พิมพ์ /งานค้าง เพื่อดูงานที่ยังไม่เสร็จทั้งหมด',
  )]);
}

// ─── ข้อความในกลุ่ม ────────────────────────────────────────────
async function onTextMessage(ev: any) {
  const groupId: string | undefined = ev.source.groupId ?? ev.source.roomId;
  const senderId: string | undefined = ev.source.userId;
  const body: string = ev.message.text ?? '';

  // แชทส่วนตัวกับบอท → ใช้ดูงานของตัวเอง
  if (!groupId) return onDirectMessage(ev, senderId, body);
  if (!senderId) return;

  const group = await store.upsertGroup(groupId);
  const sender = await store.upsertMember(
    senderId,
    (await getGroupMemberProfile(groupId, senderId))?.displayName,
    group.id,
  );

  // /ช่วยเหลือ
  if (/^\/(help|ช่วยเหลือ|วิธีใช้)/i.test(body)) {
    return reply(ev.replyToken, [text(
      'วิธีใช้งาน:\n\n' +
      '📌 สั่งงาน\n/งาน @ชื่อ รายละเอียด เวลา\n' +
      'เช่น /งาน @ฝน เช็คสต็อก ก่อนบ่าย 3\n' +
      '(สั่งหลายคนพร้อมกันได้ ใส่ @ หลายชื่อ)\n\n' +
      '📋 ดูงานค้าง\n/งานค้าง\n\n' +
      '💡 ถ้าลืมใช้คำสั่ง ฉันจะสะกิดถามให้เอง',
    )]);
  }

  // /งานค้าง
  if (/^\/งานค้าง/.test(body)) return showOpenTasks(ev, groupId);

  // ── ทางหลัก: คำสั่ง ──────────────────────────────────────────
  const cmd = parseCommand(body, ev.message.mention?.mentionees ?? []);

  if (cmd.ok) return createFromCommand(ev, group, sender, cmd, body);

  if (cmd.reason === 'no_mention') {
    return reply(ev.replyToken, [text(
      'ยังไม่ได้ระบุว่าใครรับงานค่ะ ต้องพิมพ์ @ แล้วเลือกชื่อจากรายการที่เด้งขึ้นมา\n\n' +
      'เช่น /งาน @ฝน เช็คสต็อกแก้ว ก่อนบ่าย 3',
    )]);
  }
  if (cmd.reason === 'no_detail') {
    return reply(ev.replyToken, [text('ยังไม่ได้บอกว่าให้ทำอะไรค่ะ 😅')]);
  }

  // ── ตาข่ายกันตก: บอทสะกิดถาม ─────────────────────────────────
  if (!worthAsking(body)) return;

  const s = await suggestTask(body, { senderName: sender.display_name ?? undefined });
  if (!s?.isTask || s.confidence < 0.55) return;

  // สร้างเป็น draft รอคนกดยืนยัน — ยังไม่ผูกคนรับ เพราะ LLM เดาได้แค่ "ชื่อ"
  const draft = await store.createTask({
    group_id: group.id,
    assignee_id: null,
    created_by_id: sender.id,
    detail: s.detail,
    due_at: null,
    due_text: s.dueText,
    status: 'draft',
    source: 'ai',
    raw_message: body,
    line_message_id: ev.message.id,
  });

  const who = s.assigneeName ? `ของ${s.assigneeName}` : '';
  await reply(ev.replyToken, [textWithQuickReply(
    `🤔 นี่เป็นงาน${who}ใช่ไหมคะ?\n「${s.detail}」${s.dueText ? `\n⏰ ${s.dueText}` : ''}\n\n` +
    `ถ้าใช่ กดยืนยันแล้ว @ คนรับได้เลยค่ะ`,
    [
      { label: '✅ ใช่ สร้างเลย', data: `action=confirm&task=${draft.id}` },
      { label: '✕ ไม่ใช่งาน',    data: `action=reject&task=${draft.id}` },
    ],
  )]);
}

// ─── สร้างงานจากคำสั่ง ──────────────────────────────────────────
async function createFromCommand(ev: any, group: any, sender: any, cmd: any, raw: string) {
  const hours = { open: group.open_time?.slice(0, 5) ?? '09:00',
                  close: group.close_time?.slice(0, 5) ?? '21:00' };
  const dueAt = resolveDueAt(cmd.detail, new Date(), hours);

  const lines: string[] = [];
  const notFollowing: string[] = [];

  for (const uid of cmd.assigneeUserIds) {
    const profile = await getGroupMemberProfile(group.line_group_id, uid);
    const assignee = await store.upsertMember(uid, profile?.displayName, group.id);

    const task = await store.createTask({
      group_id: group.id,
      assignee_id: assignee.id,
      created_by_id: sender.id,
      detail: cmd.detail,
      due_at: dueAt?.toISOString() ?? null,
      due_text: cmd.dueText,
      status: 'open',
      source: 'command',
      raw_message: raw,
      line_message_id: ev.message.id,
    });

    const name = assignee.display_name ?? 'สมาชิก';

    // DM ได้ต่อเมื่อเขาแอดบอทเป็นเพื่อนแล้ว
    if (assignee.is_following) {
      await push(uid, [taskCard({
        title: `งานใหม่จาก ${sender.display_name ?? 'หัวหน้า'}`,
        detail: cmd.detail,
        dueLabel: cmd.dueText ? `${cmd.dueText} (${formatDue(dueAt)})` : 'ไม่มีกำหนด',
        taskId: task.id,
      })]);
      await store.markDmSent(task.id);
      lines.push(`✅ ${name} — ส่งเข้าแชทส่วนตัวแล้ว`);
    } else {
      notFollowing.push(name);
      lines.push(`⚠️ ${name} — ยังไม่ได้แอดฉันเป็นเพื่อน`);
    }
  }

  let msg = `📌 ${cmd.detail}\n⏰ ${cmd.dueText ?? 'ไม่มีกำหนด'}` +
            `${dueAt ? ` (${formatDue(dueAt)})` : ''}\n\n${lines.join('\n')}`;
  if (notFollowing.length) {
    msg += `\n\n💡 ${notFollowing.join(', ')} แอดฉันเป็นเพื่อนก่อนนะคะ ` +
           `จะได้รับงานในแชทส่วนตัว (งานถูกบันทึกไว้แล้ว ไม่หาย)`;
  }
  await reply(ev.replyToken, [text(msg)]);
}

// ─── ปุ่มต่าง ๆ ─────────────────────────────────────────────────
async function onPostback(ev: any) {
  const params = new URLSearchParams(ev.postback?.data ?? '');
  const action = params.get('action');
  const taskId = params.get('task');
  if (!taskId) return;

  const task = await store.getTask(taskId);
  if (!task) return reply(ev.replyToken, [text('ไม่พบงานนี้แล้วค่ะ')]);

  if (action === 'confirm') {
    await store.updateTaskStatus(taskId, 'open');
    await store.logEvent('ai_accepted', task.group_id, taskId);
    return reply(ev.replyToken, [text(
      `บันทึกแล้วค่ะ 📌 ${task.detail}\n\n` +
      `พิมพ์ /งาน @ชื่อ ${task.detail} เพื่อระบุคนรับและส่งเข้าแชทส่วนตัวได้เลยค่ะ`,
    )]);
  }

  if (action === 'reject') {
    await store.updateTaskStatus(taskId, 'cancelled');
    await store.logEvent('ai_rejected', task.group_id, taskId);
    return reply(ev.replyToken, [text('โอเคค่ะ ข้ามให้แล้ว 👌')]);
  }

  if (action === 'done') {
    await store.updateTaskStatus(taskId, 'done');
    await store.logEvent('task_done', task.group_id, taskId);
    return reply(ev.replyToken, [text(`เยี่ยมเลยค่ะ ✅\n「${task.detail}」 เสร็จแล้ว`)]);
  }
}

// ─── /งานค้าง ──────────────────────────────────────────────────
async function showOpenTasks(ev: any, lineGroupId: string) {
  const rows = await store.openTasksByGroup(lineGroupId);
  if (rows.length === 0) {
    return reply(ev.replyToken, [text('ไม่มีงานค้างเลยค่ะ 🎉')]);
  }

  const byPerson = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.assignee_name ?? 'ยังไม่ระบุคน';
    const due = r.due_text ? ` (⏰ ${r.due_text})` : '';
    const late = r.is_overdue ? ' 🔴เลยกำหนด' : '';
    if (!byPerson.has(name)) byPerson.set(name, []);
    byPerson.get(name)!.push(`  • ${r.detail}${due}${late}`);
  }

  const out = [...byPerson.entries()]
    .map(([name, items]) => `👤 ${name} (${items.length})\n${items.join('\n')}`)
    .join('\n\n');

  return reply(ev.replyToken, [text(`📋 งานค้างทั้งหมด ${rows.length} งาน\n\n${out}`)]);
}

// ─── แชทส่วนตัวกับบอท ───────────────────────────────────────────
async function onDirectMessage(ev: any, userId: string | undefined, body: string) {
  if (!userId) return;
  await store.setFollowing(userId, true);

  if (/^\/?(งานฉัน|งานของฉัน|mytasks)/i.test(body.trim())) {
    const all = await store.allOpenTasks();
    const mine = all.filter(t => t.assignee_line_id === userId);
    if (mine.length === 0) return reply(ev.replyToken, [text('ไม่มีงานค้างค่ะ 🎉')]);

    const list = mine
      .map((t, i) => `${i + 1}. ${t.detail}${t.due_text ? ` (⏰ ${t.due_text})` : ''}` +
                     `${t.is_overdue ? ' 🔴' : ''}`)
      .join('\n');
    return reply(ev.replyToken, [text(`📋 งานค้างของคุณ ${mine.length} งาน\n\n${list}`)]);
  }

  return reply(ev.replyToken, [text(
    'สวัสดีค่ะ 🌱 ฉันจะส่งงานที่ได้รับมอบหมายมาให้ที่นี่\n\n' +
    'พิมพ์ "งานฉัน" เพื่อดูงานค้างทั้งหมดค่ะ',
  )]);
}
