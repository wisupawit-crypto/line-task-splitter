// → วางไว้ที่  lib/llm.ts
// ชั้น "สะกิดถาม" — ใช้ LLM เดาว่าข้อความที่ไม่ได้ใช้คำสั่งเป็นงานหรือเปล่า
//
// สำคัญ: LLM ไม่ได้สร้างงานเอง แค่ "เสนอ" เท่านั้น คนต้องกดยืนยันเสมอ
// เดาผิดจึงไม่เสียหาย และทำให้เราตั้ง threshold ได้หลวมกว่าปกติ

export type Suggestion = {
  isTask: boolean;
  detail: string;
  assigneeName: string | null;
  dueText: string | null;
  confidence: number; // 0–1
};

const SYSTEM = `คุณคือผู้ช่วยที่อ่านแชทกลุ่ม LINE ของร้านค้าไทย แล้วบอกว่าข้อความนั้นเป็น "การสั่งงาน" หรือไม่

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น รูปแบบ:
{"isTask":boolean,"detail":string,"assigneeName":string|null,"dueText":string|null,"confidence":number}

กติกา:
- isTask = true เฉพาะเมื่อมีคนถูกสั่งให้ "ทำอะไรบางอย่าง" ที่เป็นรูปธรรม
- ข้อความทักทาย ตอบรับ ("ได้ค่ะ" "รับทราบ") รายงานผล หรือคุยเล่น → isTask = false
- detail = สรุปงานสั้น ๆ เป็นภาษาไทย ไม่ต้องมีชื่อคน (เช่น "เช็คสต็อกแก้วกับหลอด")
- assigneeName = ชื่อคนที่ถูกสั่ง ตามที่ปรากฏในข้อความ ถ้าไม่ระบุชัดให้เป็น null
- dueText = ข้อความบอกเวลาตามต้นฉบับ เช่น "ก่อนบ่าย 3" "ตอนปิดร้าน" ถ้าไม่มีให้ null
- confidence = ความมั่นใจ 0–1`;

/**
 * ถาม LLM ว่าข้อความนี้เป็นงานไหม
 * คืน null ถ้าไม่ได้ตั้ง API key หรือเรียกไม่สำเร็จ (บอทจะทำงานโหมดคำสั่งอย่างเดียว)
 */
export async function suggestTask(
  message: string,
  context: { senderName?: string; memberNames?: string[] } = {},
): Promise<Suggestion | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const roster = context.memberNames?.length
    ? `\n\nสมาชิกในกลุ่ม: ${context.memberNames.join(', ')}`
    : '';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `ผู้พูด: ${context.senderName ?? 'ไม่ทราบ'}${roster}\n\nข้อความ: ${message}`,
        }],
      }),
    });

    if (!res.ok) {
      console.error('LLM call failed', res.status, await res.text());
      return null;
    }

    const json = await res.json() as { content: { type: string; text?: string }[] };
    const raw = json.content?.find(c => c.type === 'text')?.text ?? '';

    // เผื่อโมเดลห่อด้วย ```json
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as Suggestion;

    if (typeof parsed.isTask !== 'boolean' || typeof parsed.detail !== 'string') return null;
    return parsed;
  } catch (err) {
    console.error('LLM suggest error', err);
    return null;
  }
}

/**
 * กรองเบื้องต้นก่อนยิง LLM — ประหยัดทั้งเงินและเวลา
 * ข้อความส่วนใหญ่ในกลุ่มไม่ใช่งาน ไม่ต้องถาม LLM ทุกข้อความ
 */
const ACK = ['ได้ค่ะ','ได้ครับ','รับทราบ','โอเค','ครับผม','จ้า','ค่ะ','ครับ','โอเคค่ะ','ok','okay'];
const HINT = ['ช่วย','เช็ค','เช็ด','ตรวจ','สั่ง','รับของ','ไปรับ','ปิดยอด','ทำความสะอาด','ล้าง',
  'เตรียม','จัด','เติม','นับ','ส่ง','โทร','เปิดร้าน','ปิดร้าน','ดูแล','แพ็ค','ชง','สต็อก',
  'อย่าลืม','ฝาก','จ่าย','เก็บ','คีย์','ทำ','ซื้อ','แจ้ง','ติดต่อ','นัด'];

export function worthAsking(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('/')) return false;          // เป็นคำสั่งอยู่แล้ว
  if (t.length < 6 || t.length > 300) return false;
  if (t.length < 15 && ACK.some(a => t.replace(/\s/g, '').includes(a))) return false;
  if (/^https?:\/\//.test(t)) return false;
  return HINT.some(h => t.includes(h));
}
