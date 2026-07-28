// → วางไว้ที่  test/parse.test.ts
// รันด้วย:  npm test     (ใช้ tsx เป็น loader)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, detectDueText, toClock, resolveDueAt } from '../lib/parse.js';

// ─── คำสั่ง ────────────────────────────────────────────────────
test('แกะคำสั่งพร้อม mention เดียว', () => {
  const text = '/งาน @ฝน เช็คสต็อกแก้วกับหลอด ก่อนบ่าย 3';
  const mentionees = [{ index: 5, length: 3, userId: 'U001', type: 'user' as const }];
  const r = parseCommand(text, mentionees);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assigneeUserIds, ['U001']);
  assert.equal(r.detail, 'เช็คสต็อกแก้วกับหลอด ก่อนบ่าย 3');
  assert.equal(r.dueText, 'ก่อนบ่าย 3');
});

test('mention หลายคนพร้อมกัน', () => {
  const text = '/งาน @ฝน @โบ๊ท เติมน้ำเชื่อม ก่อนเปิดร้าน';
  const mentionees = [
    { index: 5, length: 3, userId: 'U001', type: 'user' as const },
    { index: 9, length: 5, userId: 'U002', type: 'user' as const },
  ];
  const r = parseCommand(text, mentionees);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assigneeUserIds, ['U001', 'U002']);
  assert.equal(r.dueText, 'ก่อนเปิดร้าน');
});

test('ไม่ใช่คำสั่ง', () => {
  const r = parseCommand('ฝนช่วยเช็คสต็อกหน่อย', []);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'not_command');
});

test('คำสั่งแต่ลืม @', () => {
  const r = parseCommand('/งาน เช็คสต็อกแก้ว', []);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no_mention');
});

// ─── เวลา ──────────────────────────────────────────────────────
test('จับข้อความบอกเวลา', () => {
  assert.equal(detectDueText('เช็คของ ก่อนบ่าย 3'),      'ก่อนบ่าย 3');
  assert.equal(detectDueText('ไปรับของ 10 โมง'),          '10 โมง');
  assert.equal(detectDueText('ส่งยอด ก่อนเที่ยง'),        'ก่อนเที่ยง');
  assert.equal(detectDueText('ล้างเครื่อง ตอนปิดร้าน'),  'ตอนปิดร้าน');
  assert.equal(detectDueText('สั่งนม ภายในวันนี้'),      'ภายในวันนี้');
  assert.equal(detectDueText('ประชุม 14:30'),             '14:30');
  assert.equal(detectDueText('ไม่มีเวลาในประโยคนี้'),     null);
});

test('แปลงเป็นเวลา 24 ชม.', () => {
  const h = { open: '09:00', close: '21:00' };
  assert.deepEqual(toClock('ก่อนบ่าย 3', h),   { hour: 15, minute: 0 });
  assert.deepEqual(toClock('บ่าย 2 โมง', h),   { hour: 14, minute: 0 });
  assert.deepEqual(toClock('10 โมง', h),        { hour: 10, minute: 0 });
  assert.deepEqual(toClock('5 โมงเย็น', h),     { hour: 17, minute: 0 });
  assert.deepEqual(toClock('2 ทุ่ม', h),        { hour: 20, minute: 0 });
  assert.deepEqual(toClock('ก่อนเที่ยง', h),    { hour: 12, minute: 0 });
  assert.deepEqual(toClock('ตอนปิดร้าน', h),   { hour: 21, minute: 0 });
  assert.deepEqual(toClock('ก่อนเปิดร้าน', h), { hour: 9,  minute: 0 });
  assert.deepEqual(toClock('14:30', h),         { hour: 14, minute: 30 });
  assert.deepEqual(toClock('ภายในวันนี้', h),  { hour: 23, minute: 59 });
});

test('เวลาปิดร้านของแต่ละร้านไม่เท่ากัน', () => {
  assert.deepEqual(toClock('ตอนปิดร้าน', { open: '07:00', close: '18:30' }),
                   { hour: 18, minute: 30 });
});

test('resolveDueAt คำนวณบนเขตเวลาไทย', () => {
  // 2026-07-28 02:00 UTC = 09:00 ไทย
  const now = new Date('2026-07-28T02:00:00Z');
  const due = resolveDueAt('เช็คสต็อก ก่อนบ่าย 3', now);
  // บ่าย 3 ไทย = 15:00+07 = 08:00 UTC วันเดียวกัน
  assert.equal(due?.toISOString(), '2026-07-28T08:00:00.000Z');
});

test('เลยเวลาไปแล้ว → เลื่อนเป็นพรุ่งนี้', () => {
  // 2026-07-28 14:00 UTC = 21:00 ไทย (เลย 10 โมงเช้าไปแล้ว)
  const now = new Date('2026-07-28T14:00:00Z');
  const due = resolveDueAt('ไปรับของ 10 โมง', now);
  // 10 โมงไทยของวันที่ 29 = 03:00 UTC
  assert.equal(due?.toISOString(), '2026-07-29T03:00:00.000Z');
});

test('ระบุพรุ่งนี้ชัดเจน', () => {
  const now = new Date('2026-07-28T02:00:00Z'); // 09:00 ไทย
  const due = resolveDueAt('พรุ่งนี้เปิดร้าน 9 โมง', now);
  assert.equal(due?.toISOString(), '2026-07-29T02:00:00.000Z');
});

test('ไม่มีเวลา → null', () => {
  assert.equal(resolveDueAt('เช็คสต็อกแก้ว'), null);
});
