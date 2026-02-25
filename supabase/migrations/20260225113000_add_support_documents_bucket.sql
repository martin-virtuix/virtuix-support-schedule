-- Support Hub PDF documents bucket + authenticated read access.
insert into storage.buckets (id, name, public)
values ('support-documents', 'support-documents', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated users can read support documents'
  ) then
    create policy "Authenticated users can read support documents"
      on storage.objects
      for select
      to authenticated
      using (bucket_id = 'support-documents');
  end if;
end;
$$;
