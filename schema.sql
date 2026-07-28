-- ═══════════════════════════════════════════════════════════
--  LINE Task Splitter — Supabase schema
--  → วางไว้ที่  supabase/schema.sql
--  รันใน Supabase Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── กลุ่ม LINE ที่บอทถูกเชิญเข้าไป ────────────────────────────
create table if not exists groups (
  id            uuid primary key default gen_random_uuid(),
  line_group_id text unique not null,
  name          text,
  -- เวลาเปิด/ปิดร้าน ใช้แปลง "ตอนปิดร้าน" / "ก่อนเปิดร้าน" เป็นเวลาจริง
  open_time     time not null default '09:00',
  close_time    time not null default '21:00',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── สมาชิก (1 แถวต่อ 1 LINE user) ─────────────────────────────
-- is_following = แอดบอทเป็นเพื่อนแล้วหรือยัง
-- ถ้ายังไม่แอด บอท DM หาไม่ได้ ต้องเตือนในกลุ่มแทน
create table if not exists members (
  id            uuid primary key default gen_random_uuid(),
  line_user_id  text unique not null,
  display_name  text,
  is_following  boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ── ใครอยู่กลุ่มไหน ───────────────────────────────────────────
create table if not exists group_members (
  group_id  uuid references groups(id)  on delete cascade,
  member_id uuid references members(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, member_id)
);

-- ── งาน ───────────────────────────────────────────────────────
-- status: draft     = บอทเดาเอง รอคนกดยืนยันในกลุ่ม
--         open      = ยืนยันแล้ว รอทำ
--         done      = เสร็จแล้ว
--         cancelled = ถูกปฏิเสธ / ยกเลิก
-- source: command = มาจาก /งาน , ai = บอทเดาแล้วมีคนยืนยัน
create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups(id) on delete cascade,
  assignee_id     uuid references members(id) on delete set null,
  created_by_id   uuid references members(id) on delete set null,

  detail          text not null,
  due_at          timestamptz,
  due_text        text,            -- ข้อความเวลาดิบ เช่น "ก่อนบ่าย 3"

  status          text not null default 'open'
                  check (status in ('draft','open','done','cancelled')),
  source          text not null default 'command'
                  check (source in ('command','ai')),

  raw_message     text,            -- ข้อความต้นฉบับในกลุ่ม
  line_message_id text,
  dm_sent         boolean not null default false,

  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists idx_tasks_assignee_status on tasks(assignee_id, status);
create index if not exists idx_tasks_group_status    on tasks(group_id, status);
create index if not exists idx_tasks_due             on tasks(due_at) where status = 'open';

-- ── log เหตุการณ์ (ดีบัก + วัดว่า AI เดาแม่นแค่ไหน) ────────────
create table if not exists events (
  id         bigserial primary key,
  kind       text not null,   -- task_created | ai_suggested | ai_accepted | ai_rejected | task_done
  group_id   uuid references groups(id) on delete set null,
  task_id    uuid references tasks(id)  on delete set null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_kind_time on events(kind, created_at desc);

-- ── VIEW: งานค้างรายคน (ใช้ทำสรุปตอนเช้า) ─────────────────────
create or replace view v_open_tasks as
select
  t.id,
  g.line_group_id,
  g.name           as group_name,
  m.line_user_id   as assignee_line_id,
  m.display_name   as assignee_name,
  m.is_following,
  t.detail,
  t.due_at,
  t.due_text,
  t.source,
  t.created_at,
  (t.due_at is not null and t.due_at < now()) as is_overdue
from tasks t
join groups g on g.id = t.group_id
left join members m on m.id = t.assignee_id
where t.status = 'open';

-- ── RLS ───────────────────────────────────────────────────────
-- บอทเชื่อมด้วย service_role key ซึ่งข้าม RLS อยู่แล้ว
-- เปิด RLS ไว้กันเผลอเปิด anon key ให้คนนอกอ่านข้อมูลงาน
alter table groups        enable row level security;
alter table members       enable row level security;
alter table group_members enable row level security;
alter table tasks         enable row level security;
alter table events        enable row level security;
-- ไม่สร้าง policy = anon key อ่านไม่ได้เลย (ตั้งใจ)
