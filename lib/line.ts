// → วางไว้ที่  lib/line.ts
// ห่อ LINE Messaging API + ตรวจลายเซ็น webhook

const API = 'https://api.line.me/v2/bot';
const TOKEN = () => process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';

/** เทียบสตริงแบบเวลาคงที่ กัน timing attack */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * ตรวจลายเซ็น webhook — สำคัญมาก ห้ามข้าม
 * ถ้าไม่ตรวจ ใครก็ยิง request ปลอมมาสร้างงานในระบบได้
 *
 * ต้องเทียบกับ "raw body" เป๊ะ ๆ เท่านั้น
 * (JSON.parse แล้ว stringify ใหม่จะได้ byte ไม่ตรง ลายเซ็นพัง)
 *
 * ใช้ WebCrypto เพราะรันบน Edge runtime ซึ่งไม่มี node:crypto
 */
export async function verifySignature(
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));

  let bin = '';
  for (const byte of new Uint8Array(mac)) bin += String.fromCharCode(byte);
  return timingSafeEqual(btoa(bin), signature);
}

async function call(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error(`LINE API ${path} failed ${res.status}:`, detail);
  }
  return res;
}

export const reply = (replyToken: string, messages: unknown[]) =>
  call('/message/reply', { replyToken, messages });

export const push = (to: string, messages: unknown[]) =>
  call('/message/push', { to, messages });

/** ดึงชื่อโปรไฟล์ของสมาชิกในกลุ่ม */
export async function getGroupMemberProfile(groupId: string, userId: string) {
  const res = await fetch(`${API}/group/${groupId}/member/${userId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as { displayName: string; pictureUrl?: string };
}

// ─── ตัวช่วยสร้างข้อความ ────────────────────────────────────────

export const text = (t: string) => ({ type: 'text', text: t });

/** ข้อความพร้อมปุ่ม quick reply (ใช้ตอนบอทสะกิดถาม) */
export function textWithQuickReply(
  t: string,
  buttons: { label: string; data: string }[],
) {
  return {
    type: 'text',
    text: t,
    quickReply: {
      items: buttons.map(b => ({
        type: 'action',
        action: { type: 'postback', label: b.label, data: b.data, displayText: b.label },
      })),
    },
  };
}

/** การ์ดสรุปงานที่ DM หาแต่ละคน พร้อมปุ่มกดเสร็จ */
export function taskCard(opts: {
  title: string;
  detail: string;
  dueLabel: string;
  taskId: string;
}) {
  return {
    type: 'flex',
    altText: `งานใหม่: ${opts.detail}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: opts.title, size: 'xs', color: '#06C755', weight: 'bold' },
          { type: 'text', text: opts.detail, wrap: true, size: 'md', weight: 'bold' },
          {
            type: 'box',
            layout: 'baseline',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '⏰', size: 'sm', flex: 0 },
              { type: 'text', text: opts.dueLabel, size: 'sm', color: '#7b8794', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            height: 'sm',
            action: {
              type: 'postback',
              label: '✅ ทำเสร็จแล้ว',
              data: `action=done&task=${opts.taskId}`,
              displayText: 'ทำเสร็จแล้ว',
            },
          },
        ],
      },
    },
  };
}
