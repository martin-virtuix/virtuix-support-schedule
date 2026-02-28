-- One-time historical bootstrap: populate ticket_cache from legacy zendesk_tickets history.
-- This closes reporting gaps when old sync jobs filled zendesk_tickets but not ticket_cache.

insert into public.ticket_cache (
  ticket_id,
  brand,
  subject,
  status,
  priority,
  requester_email,
  requester_name,
  assignee_email,
  zendesk_created_at,
  zendesk_updated_at,
  ticket_url,
  raw_payload,
  synced_at
)
select
  z.ticket_id,
  z.brand,
  z.subject,
  z.status,
  z.priority,
  z.requester_email,
  nullif(
    trim(
      coalesce(
        z.raw_payload -> 'requester' ->> 'name',
        z.raw_payload -> 'submitter' ->> 'name',
        ''
      )
    ),
    ''
  ) as requester_name,
  z.assignee_email,
  z.zendesk_created_at,
  z.zendesk_updated_at,
  case
    when coalesce(z.raw_payload ->> 'url', '') = '' then null
    else regexp_replace(
      z.raw_payload ->> 'url',
      '/api/v2/tickets/([0-9]+)\\.json$',
      '/agent/tickets/\1'
    )
  end as ticket_url,
  z.raw_payload,
  coalesce(z.synced_at, now())
from public.zendesk_tickets as z
on conflict (ticket_id) do update
set
  brand = excluded.brand,
  subject = excluded.subject,
  status = excluded.status,
  priority = excluded.priority,
  requester_email = coalesce(excluded.requester_email, ticket_cache.requester_email),
  requester_name = coalesce(excluded.requester_name, ticket_cache.requester_name),
  assignee_email = coalesce(excluded.assignee_email, ticket_cache.assignee_email),
  zendesk_created_at = coalesce(ticket_cache.zendesk_created_at, excluded.zendesk_created_at),
  zendesk_updated_at = case
    when ticket_cache.zendesk_updated_at is null then excluded.zendesk_updated_at
    when excluded.zendesk_updated_at is null then ticket_cache.zendesk_updated_at
    else greatest(ticket_cache.zendesk_updated_at, excluded.zendesk_updated_at)
  end,
  ticket_url = coalesce(excluded.ticket_url, ticket_cache.ticket_url),
  raw_payload = coalesce(excluded.raw_payload, ticket_cache.raw_payload),
  synced_at = case
    when ticket_cache.synced_at is null then excluded.synced_at
    when excluded.synced_at is null then ticket_cache.synced_at
    else greatest(ticket_cache.synced_at, excluded.synced_at)
  end;
