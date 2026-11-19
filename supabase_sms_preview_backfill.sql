-- One-time backfill: inbox previews of Google LSA message leads.
--
-- sms_conversations.last_preview used to be the first 160 chars of the raw
-- text. A Google LSA lead arrives wrapped in Google's template ("You have
-- received a new message from a customer via Google Local Services Ads. Customer
-- name: … Location: … Service: … Message: …"), which alone runs ~150 chars, so
-- the inbox showed three or four of the customer's characters, or none.
-- sms.js previewOf() now takes the template off before cutting; this rewrites
-- the rows stored before that, from each thread's latest message.
--
-- Mirrors previewOf() / pushSummary.js parseLsa(): the customer's words, else
-- "Location · Service", else "Google LSA message". Safe to run twice: it only
-- touches previews that still start with Google's template.

with latest as (
  -- the message the roll-up took its preview from: the newest one that is not a Google relay notice
  select distinct on (m.conversation_id) m.conversation_id, m.content
  from public.sms_messages m
  join public.sms_conversations c on c.id = m.conversation_id
  where c.last_preview ~* '^(\(\d+/\d+\)\s*)?You have received a new message from a customer via Google Local Services Ads'
    and btrim(coalesce(m.content, ''), E' \t\r\n') !~* '^(\(\d+/\d+\)\s*)?(Replies to this number will be sent to the customer|This customer requested only message replies)'
  order by m.conversation_id, m.created_at desc
),
src as (
  select conversation_id,
         regexp_replace(btrim(replace(content, E'\r\n', E'\n'), E' \t\r\n'), '^\(\d+/\d+\)\s*', '') as raw
  from latest
),
body as (
  select conversation_id,
         regexp_replace(raw, '^You have received a new message from a customer via Google Local Services Ads\.?', '', 'i') as rest
  from src
  where raw ~* '^You have received a new message from a customer via Google Local Services Ads'
),
parts as (
  select conversation_id,
         -- what the customer typed, without Google's "[Notes from LSA: …]" tail
         btrim(regexp_replace(coalesce(substring(rest from 'Message:\s*(.*)$'), ''), '\s*\[Notes from LSA:\s*[^\]]*\]?\.?\s*$', ''), E' \t\r\n') as txt,
         nullif(btrim(regexp_replace(coalesce(substring(rest from 'Location:[ \t]*([^\n]*)'), ''), '[ \t]+Service:.*$', ''), E' \t'), '') as location,
         nullif(substring(rest from 'Service:[ \t]*([a-z0-9_]*)'), '') as service
  from body
),
cleaned as (
  select conversation_id, location, service,
         -- Google appends a period to every message ("4352324434.", "... gilbert .")
         btrim(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(txt, '\s+\.$', ''), '\.\.$', '.'), '^([\d\s()+-]{7,})\.$', '\1'),
           '\s+', ' ', 'g'), ' ') as txt
  from parts
),
labelled as (
  select c.conversation_id, c.txt, c.location,
         coalesce(l.label,
                  nullif(upper(left(w.words, 1)) || substr(w.words, 2), '')) as service_label
  from cleaned c
  left join (values
    ('water_damage_cleanup_repair', 'Water damage cleanup'),
    ('water_damage_mold_removal', 'Mold removal'),
    ('water_damage_mold_inspection', 'Mold inspection'),
    ('water_damage_remodeling', 'Water damage remodeling'),
    ('water_damage_sewage_cleanup', 'Sewage cleanup'),
    ('water_damage_other', 'Water damage (other)'),
    ('water_damage_flooring', 'Water damage flooring'),
    ('water_damage_plumbing', 'Water damage plumbing'),
    ('water_damage_painting', 'Water damage painting'),
    ('fire_damage_cleanup_repair', 'Fire damage cleanup')
  ) as l(code, label) on l.code = c.service
  cross join lateral (select regexp_replace(btrim(coalesce(c.service, ''), '_'), '_+', ' ', 'g') as words) w
),
fixed as (
  select conversation_id,
         left(coalesce(nullif(txt, ''), nullif(concat_ws(' · ', location, service_label), ''), 'Google LSA message'), 160) as preview
  from labelled
)
update public.sms_conversations c
set last_preview = f.preview
from fixed f
where c.id = f.conversation_id
  and c.last_preview is distinct from f.preview;
