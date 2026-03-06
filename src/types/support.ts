export type Ticket = {
  ticket_id: number;
  brand: string;
  subject: string;
  status: string;
  priority: string | null;
  requester_email: string | null;
  requester_name: string | null;
  assignee_email: string | null;
  zendesk_updated_at: string | null;
  ticket_url: string | null;
  summary_text: string | null;
};

export type TicketSummary = {
  ticket_id: number;
  summary_text: string;
  key_actions: string[];
  next_steps: string[];
  updated_at: string;
};

export type Digest = {
  id: string;
  title: string;
  source: string;
  filters: Record<string, unknown>;
  ticket_ids: number[];
  content_markdown: string;
  content_table: Array<Record<string, unknown>>;
  created_at: string;
};

export type SyncZendeskResponse = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  run_id?: string;
  brand?: string;
  backfill_year?: boolean;
  tickets_fetched?: number;
  tickets_upserted?: number;
  cursor?: number;
  start_cursor?: number | null;
  target_backfill_cursor?: number | null;
  max_pages?: number;
  pages_processed?: number;
  has_more?: boolean;
  end_of_stream_reached?: boolean;
  error?: string;
};

export type SummarizeTicketResponse = {
  ok: boolean;
  cached: boolean;
  ticket_id: number;
  summary_text: string;
  key_actions: string[];
  next_steps: string[];
  updated_at: string;
  model?: string;
  error?: string;
};

export type CreateDigestResponse = {
  ok: boolean;
  digest: Digest;
  ticket_count: number;
  error?: string;
};

export type SendToSlackResponse = {
  ok: boolean;
  type: "digest" | "ticket_summary" | "plain_text";
  digest_id?: string;
  ticket_id?: number;
  error?: string;
};

export type CopilotCitation = {
  source_type: "document" | "ticket";
  title: string;
  reference: string;
  url?: string | null;
  excerpt?: string | null;
  similarity?: number | null;
  ticket_id?: number | null;
  brand?: string | null;
  status?: string | null;
};

export type CopilotChatResponse = {
  ok: boolean;
  reply: string;
  citations?: CopilotCitation[];
  model?: string;
  error?: string;
};

export type HubAnalyticsTrackResponse = {
  ok: boolean;
  error?: string;
};

export type HubAnalyticsBaselineRow = {
  period_start_date: string;
  period_end_date: string;
  total_events: number;
  unique_users: number;
  copilot_queries: number;
  citation_clicks: number;
  weekly_reports_refreshed: number;
  rollup_reports_refreshed: number;
  sql_reports_generated: number;
};

export type SemanticSearchDocumentResult = {
  chunk_id: string;
  file_id: string;
  brand: string;
  storage_path: string;
  file_name: string;
  top_level_folder: string | null;
  page_number: number | null;
  similarity: number;
  snippet: string;
};

export type SemanticSearchDocumentsResponse = {
  ok?: boolean;
  query?: string;
  model?: string;
  count?: number;
  results?: SemanticSearchDocumentResult[];
  error?: string;
};

export type WeeklyTicketReportRow = {
  period_start_date: string;
  period_end_date: string;
  brand: string;
  received_count: number;
  solved_closed_count: number;
  still_open_count: number;
  resolution_rate: number;
};

export type TicketReceivedRollupRow = {
  period_type: "month" | "quarter" | "year" | string;
  period_start_date: string;
  period_end_date: string;
  brand: string;
  received_count: number;
  previous_period_start_date: string;
  previous_period_end_date: string;
  previous_received_count: number;
  delta: number;
  delta_pct: number | null;
};

export type TicketDataCoverageRow = {
  earliest_created_at: string | null;
  latest_created_at: string | null;
  total_tickets: number;
  tickets_with_created_at: number;
  tickets_missing_created_at: number;
  latest_sync_started_at: string | null;
  latest_sync_finished_at: string | null;
  latest_sync_status: string | null;
  latest_sync_cursor: number | null;
  latest_sync_error: string | null;
};
