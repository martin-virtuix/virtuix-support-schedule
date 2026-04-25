import type { Ticket } from '@/types/support';

export const ACTIVE_TICKET_STATUSES = new Set(['new', 'open', 'pending']);
const REPORT_BACKLOG_STATUSES = new Set(['open', 'pending']);

export type ReportCountEntry = {
  label: string;
  count: number;
};

const TICKET_THEME_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Display / TV', pattern: /\b(tv|display|screen|monitor)\b/i },
  { label: 'PC / Hardware', pattern: /\b(pc|computer|gpu|cpu|motherboard|power supply|ssd|hardware)\b/i },
  { label: 'Cabling / Electrical', pattern: /\b(cable|he cable|wiring|connector|usb|hdmi|ethernet|power cable)\b/i },
  { label: 'Mechanical / Parts', pattern: /\b(agg|ring handle|handle|latch|arm|bracket|frame|strap|foot tracker|tracker)\b/i },
  { label: 'Setup / Calibration', pattern: /\b(setup|set up|install|assemble|pair|calibration|calibrate|adjust)\b/i },
  { label: 'Shipping / RMA', pattern: /\b(rma|shipping|shipment|return|warranty|replacement|replace)\b/i },
  { label: 'Software / Account', pattern: /\b(software|firmware|app|launcher|steam|login|password|account)\b/i },
  { label: 'Billing / Orders', pattern: /\b(billing|invoice|payment|refund|charge|order|purchase|quote)\b/i },
];

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function isReportBacklogStatus(status: string): boolean {
  return REPORT_BACKLOG_STATUSES.has(status.toLowerCase());
}

export function getOpenPendingTickets(rows: Ticket[]): Ticket[] {
  return rows.filter((ticket) => isReportBacklogStatus(ticket.status));
}

export function getOpenPendingStatusCounts(rows: Ticket[]): { open: number; pending: number; total: number } {
  const counts = rows.reduce(
    (accumulator, ticket) => {
      const normalizedStatus = ticket.status.toLowerCase();
      if (normalizedStatus === 'open') accumulator.open += 1;
      if (normalizedStatus === 'pending') accumulator.pending += 1;
      return accumulator;
    },
    { open: 0, pending: 0 },
  );

  return {
    ...counts,
    total: counts.open + counts.pending,
  };
}

export function getTicketStatusCounts(rows: Ticket[]): { open: number; pending: number; new: number; active: number } {
  return rows.reduce(
    (accumulator, ticket) => {
      const normalizedStatus = ticket.status.toLowerCase();
      if (normalizedStatus === 'open') accumulator.open += 1;
      if (normalizedStatus === 'pending') accumulator.pending += 1;
      if (normalizedStatus === 'new') accumulator.new += 1;
      if (ACTIVE_TICKET_STATUSES.has(normalizedStatus)) accumulator.active += 1;
      return accumulator;
    },
    { open: 0, pending: 0, new: 0, active: 0 },
  );
}

export function toTopCounts(values: Array<string | null | undefined>, limit = 3): ReportCountEntry[] {
  const counts = new Map<string, number>();

  values.forEach((value) => {
    const normalized = value?.trim();
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function getTicketTheme(subject: string): string {
  const normalizedSubject = subject.trim();
  if (normalizedSubject.length === 0) return 'General Support';

  const matchedRule = TICKET_THEME_RULES.find((rule) => rule.pattern.test(normalizedSubject));
  return matchedRule?.label || 'General Support';
}

export function getTopTicketThemes(rows: Ticket[], limit = 3): ReportCountEntry[] {
  return toTopCounts(rows.map((ticket) => getTicketTheme(ticket.subject)), limit);
}

export function getTicketRequesterLabel(ticket: Ticket): string {
  const requester = firstNonEmptyString(ticket.requester_name, ticket.requester_email);
  if (!requester) return 'Unknown requester';
  return requester;
}

export function getTopTicketRequesters(rows: Ticket[], limit = 5): ReportCountEntry[] {
  return toTopCounts(rows.map((ticket) => getTicketRequesterLabel(ticket)), limit);
}
