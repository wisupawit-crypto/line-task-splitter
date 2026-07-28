// → วางไว้ที่  api/daily-digest.ts
// Cron ของ Vercel เรียกทุกวัน 08:00 น. ไทย (= 01:00 UTC, ตั้งไว้ใน vercel.json)
// ส่งสรุปงานค้างเข้ากลุ่ม + เตือนคนที่มีงานเลยกำหนด

import { push, text } from '../lib/line.js';
import { allOpenTasks } from '../lib/db.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  // Vercel cron แนบ header นี้มา — กันคนนอกยิงเล่น
  if (process.env.CRON_SECRET &&
      req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rows = await allOpenTasks();

  // จัดกลุ่มตาม LINE group
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byGroup.has(r.line_group_id)) byGroup.set(r.line_group_id, []);
    byGroup.get(r.line_group_id)!.push(r);
  }

  let sent = 0;
  for (const [groupId, items] of byGroup) {
    const byPerson = new Map<string, typeof items>();
    for (const t of items) {
      const name = t.assignee_name ?? 'ยังไม่ระบุคน';
      if (!byPerson.has(name)) byPerson.set(name, []);
      byPerson.get(name)!.push(t);
    }

    const overdue = items.filter(t => t.is_overdue).length;
    const header = `☀️ สรุปงานค้างเช้านี้ — ${items.length} งาน` +
                   (overdue ? `\n🔴 เลยกำหนดแล้ว ${overdue} งาน` : '');

    const body = [...byPerson.entries()]
      .map(([name, list]) => {
        const lines = list
          .map(t => `  • ${t.detail}${t.due_text ? ` (⏰ ${t.due_text})` : ''}` +
                    `${t.is_overdue ? ' 🔴' : ''}`)
          .join('\n');
        return `👤 ${name} (${list.length})\n${lines}`;
      })
      .join('\n\n');

    await push(groupId, [text(`${header}\n\n${body}`)]);
    sent++;
  }

  return new Response(
    JSON.stringify({ ok: true, groups: sent, tasks: rows.length }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
