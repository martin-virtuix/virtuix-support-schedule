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
  tickets_fetched?: number;
  tickets_upserted?: number;
  cursor?: number;
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

export type CopilotChatResponse = {
  ok: boolean;
  reply: string;
  model?: string;
  error?: string;
};
