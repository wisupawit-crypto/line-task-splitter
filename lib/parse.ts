// → วางไว้ที่  lib/parse.ts
// แกะคำสั่ง /งาน และแปลงคำบอกเวลาภาษาไทยเป็น timestamp จริง

export type Mentionee = {
  index: number;
  length: number;
  userId?: string;
  type?: 'user' | 'all';
};

export type ParsedCommand = {
  ok: true;
  assigneeUserIds: string[];
  detail: string;
  dueText: string | null;
} | {
  ok: false;
  reason: 'not_command' | 'no_mention' | 'no_detail';
};

const CMD_RE = /^\/(งาน|task|มอบ)\s*/i;

/**
 * แกะคำสั่งจากข้อความกลุ่ม
 *
 * LINE ส่ง mentionees มาพร้อม index/length ที่ชี้ตำแหน่งใน "ข้อความดิบ"
 * เราตัดช่วงเหล่านั้นออกเพื่อให้เหลือแต่รายละเอียดงาน
 * และได้ userId จริงมาเลย ไม่ต้องเดาจากชื่อเล่น
 */
export function parseCommand(text: string, mentionees: Mentionee[] = []): ParsedCommand {
  if (!CMD_RE.test(text)) return { ok: false, reason: 'not_command' };

  const userIds = mentionees
    .filter(m => m.type !== 'all' && m.userId)
    .map(m => m.userId as string);

  if (userIds.length === 0) return { ok: false, reason: 'no_mention' };

  // ตัดช่วง mention ออกจากข้อความ (ไล่จากท้ายมาหน้า ไม่งั้น index เพี้ยน)
  let stripped = text;
  [...mentionees]
    .sort((a, b) => b.index - a.index)
    .forEach(m => {
      stripped = stripped.slice(0, m.index) + stripped.slice(m.index + m.length);
    });

  const detail = stripped.replace(CMD_RE, '').replace(/\s+/g, ' ').trim();
  if (!detail) return { ok: false, reason: 'no_detail' };

  return { ok: true, assigneeUserIds: userIds, detail, dueText: detectDueText(detail) };
}

// ─── ตรวจจับข้อความบอกเวลา ─────────────────────────────────────
// เรียงจากเฉพาะเจาะจงมากไปน้อย เจอตัวแรกใช้ตัวนั้น
const DUE_PATTERNS: RegExp[] = [
  /ก่อนเที่ยงวัน/, /ก่อนเที่ยง/, /ภายในเที่ยง/, /เที่ยงตรง/, /เที่ยงวัน/,
  /ก่อนบ่าย\s?\d{1,2}(\s?โมง)?/, /บ่าย\s?\d{1,2}(\s?โมง)?/,
  /ก่อน\s?\d{1,2}\s?โมง(เช้า|เย็น)?/, /\d{1,2}\s?โมง(เช้า|เย็น)?/,
  /\d{1,2}[:.]\d{2}\s?น\.?/, /\d{1,2}[:.]\d{2}/,
  /\d{1,2}\s?ทุ่ม/, /เที่ยงคืน/,
  /ตอนปิดร้าน/, /ก่อนปิดร้าน/, /ตอนเปิดร้าน/, /ก่อนเปิดร้าน/,
  /ก่อนเลิกงาน/, /ภายในวันนี้/, /ภายในพรุ่งนี้/,
];

export function detectDueText(text: string): string | null {
  for (const p of DUE_PATTERNS) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

export function detectDayOffset(text: string): number {
  if (/มะรืน/.test(text)) return 2;
  if (/พรุ่งนี้/.test(text)) return 1;
  return 0;
}

const TH_DIGITS: Record<string, string> = {
  '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4','๕':'5','๖':'6','๗':'7','๘':'8','๙':'9',
};
const normalizeDigits = (s: string) => s.replace(/[๐-๙]/g, d => TH_DIGITS[d]);

export type StoreHours = { open: string; close: string }; // "HH:MM"

/**
 * แปลงข้อความเวลาไทย → { hour, minute } แบบ 24 ชม.
 * คืน null ถ้าตีความไม่ได้
 */
export function toClock(
  dueText: string,
  hours: StoreHours = { open: '09:00', close: '21:00' },
): { hour: number; minute: number } | null {
  const t = normalizeDigits(dueText);
  const hm = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return { hour: h, minute: m };
  };

  if (/ตอนปิดร้าน|ก่อนปิดร้าน|ก่อนเลิกงาน/.test(t)) return hm(hours.close);
  if (/ตอนเปิดร้าน|ก่อนเปิดร้าน/.test(t))          return hm(hours.open);
  if (/เที่ยงคืน/.test(t))                          return { hour: 23, minute: 59 };
  if (/เที่ยง/.test(t))                             return { hour: 12, minute: 0 };
  if (/ภายในวันนี้|ภายในพรุ่งนี้/.test(t))          return { hour: 23, minute: 59 };

  // HH:MM
  let m = t.match(/(\d{1,2})[:.](\d{2})/);
  if (m) {
    const h = +m[1], min = +m[2];
    if (h <= 23 && min <= 59) return { hour: h, minute: min };
  }

  // N ทุ่ม  → 18:00 + N   (1 ทุ่ม = 19:00)
  m = t.match(/(\d{1,2})\s?ทุ่ม/);
  if (m) {
    const h = 18 + +m[1];
    if (h <= 23) return { hour: h, minute: 0 };
  }

  // บ่าย N (โมง) → 12 + N
  m = t.match(/บ่าย\s?(\d{1,2})/);
  if (m) {
    const n = +m[1];
    return { hour: n <= 11 ? 12 + n : n, minute: 0 };
  }

  // N โมงเย็น → 12 + N  (ถ้า N ≤ 6)
  m = t.match(/(\d{1,2})\s?โมงเย็น/);
  if (m) {
    const n = +m[1];
    return { hour: n <= 6 ? 12 + n : n, minute: 0 };
  }

  // N โมง / N โมงเช้า → ตามตัวเลข
  m = t.match(/(\d{1,2})\s?โมง/);
  if (m) {
    const n = +m[1];
    if (n <= 23) return { hour: n, minute: 0 };
  }

  return null;
}

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * แปลงข้อความเวลา → timestamptz จริง (อิงเขต Asia/Bangkok)
 * ถ้าเวลาที่ได้เลยไปแล้วในวันนี้ และไม่ได้ระบุ "พรุ่งนี้" → เลื่อนเป็นวันถัดไป
 */
export function resolveDueAt(
  detail: string,
  now: Date = new Date(),
  hours: StoreHours = { open: '09:00', close: '21:00' },
): Date | null {
  const dueText = detectDueText(detail);
  if (!dueText) return null;

  const clock = toClock(dueText, hours);
  if (!clock) return null;

  // ทำงานบนเวลาไทยโดยเลื่อน epoch แล้วค่อยเลื่อนกลับ
  const bkkNow = new Date(now.getTime() + BKK_OFFSET_MS);
  const y = bkkNow.getUTCFullYear();
  const mo = bkkNow.getUTCMonth();
  let d = bkkNow.getUTCDate() + detectDayOffset(detail);

  let due = new Date(Date.UTC(y, mo, d, clock.hour, clock.minute) - BKK_OFFSET_MS);

  // เลยเวลาไปแล้วและไม่ได้บอกว่าพรุ่งนี้ → ถือว่าหมายถึงพรุ่งนี้
  if (due.getTime() <= now.getTime() && detectDayOffset(detail) === 0) {
    due = new Date(due.getTime() + 24 * 60 * 60 * 1000);
  }
  return due;
}

/** จัดข้อความเวลาให้อ่านง่ายสำหรับแสดงผล เช่น "อ. 28 ก.ค. 15:00" */
export function formatDue(due: Date | null): string {
  if (!due) return 'ไม่มีกำหนด';
  const b = new Date(due.getTime() + BKK_OFFSET_MS);
  const days = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${days[b.getUTCDay()]} ${b.getUTCDate()} ${months[b.getUTCMonth()]} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}
