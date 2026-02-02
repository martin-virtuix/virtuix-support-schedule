// CSV URLs for schedule data
export const CURRENT_WEEK_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT_P-MDtJ5_22Dftrk9JC9gQmaWzIM_YLBVEJ7n_hyU4bm4PSgzUbWOdIB-e184eJpaL2SUqB92tumS/pub?gid=0&single=true&output=csv";
export const NEXT_WEEK_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT_P-MDtJ5_22Dftrk9JC9gQmaWzIM_YLBVEJ7n_hyU4bm4PSgzUbWOdIB-e184eJpaL2SUqB92tumS/pub?gid=251849400&single=true&output=csv";

// CSV URL for excluded sites - expects columns: Name, Flag (optional), Note (optional)
export const EXCLUDED_SITES_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT_P-MDtJ5_22Dftrk9JC9gQmaWzIM_YLBVEJ7n_hyU4bm4PSgzUbWOdIB-e184eJpaL2SUqB92tumS/pub?gid=https://docs.google.com/spreadsheets/d/e/2PACX-1vT_P-MDtJ5_22Dftrk9JC9gQmaWzIM_YLBVEJ7n_hyU4bm4PSgzUbWOdIB-e184eJpaL2SUqB92tumS/pub?gid=74514299&single=true&output=csv&single=true&output=csv";

export interface ExcludedSite {
  name: string;
  flag?: string;
  note?: string;
}

export function parseExcludedSitesCSV(text: string): ExcludedSite[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const delimiter = lines[0].includes(";") ? ";" : ",";
  const sites: ExcludedSite[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(delimiter);

    const name = (cols[0] || "").trim();
    if (!name) continue;

    const flag = (cols[1] || "").trim() || undefined;
    const note = (cols[2] || "").trim() || undefined;

    sites.push({ name, flag, note });
  }

  return sites;
}

export async function loadExcludedSites(csvUrl: string): Promise<ExcludedSite[]> {
  const res = await fetch(csvUrl);
  const csv = await res.text();
  return parseExcludedSitesCSV(csv);
}

export const keyByIndex = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const dayLabel: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export const displayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface ScheduleBundle {
  schedule: Record<string, string[]>;
  businessHours: Record<string, { open: string; close: string }>;
  notesByDay: Record<string, string>;
}

export function parseCSV(text: string): ScheduleBundle | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const delimiter = lines[0].includes(";") ? ";" : ",";

  const schedule: Record<string, string[]> = {};
  const businessHours: Record<string, { open: string; close: string }> = {};
  const notesByDay: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(delimiter);

    const dayKey = (cols[0] || "").trim().toLowerCase();
    if (!dayKey) continue;

    const open = (cols[1] || "").trim() || "10:00";
    const close = (cols[2] || "").trim() || "18:00";
    const onDutyRaw = (cols[3] || "").trim();
    const notesRaw = (cols[4] || "").trim();

    const people = onDutyRaw
      ? onDutyRaw
          .split(/[;|]/)
          .map((p) => p.trim())
          .filter(Boolean)
      : [];

    schedule[dayKey] = people;
    businessHours[dayKey] = { open, close };
    notesByDay[dayKey] = notesRaw;
  }

  return { schedule, businessHours, notesByDay };
}

export async function loadScheduleBundle(csvUrl: string): Promise<ScheduleBundle> {
  const res = await fetch(csvUrl);
  const csv = await res.text();
  const bundle = parseCSV(csv);
  if (!bundle) throw new Error("CSV parse failed");
  return bundle;
}

export function isOpenNow(
  dayKey: string,
  now: Date,
  businessHours: Record<string, { open: string; close: string }>,
): boolean {
  const hours = businessHours[dayKey];
  if (!hours) return false;

  const [openH, openM] = hours.open.split(":").map(Number);
  const [closeH, closeM] = hours.close.split(":").map(Number);

  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

export function formatHours(dayKey: string, businessHours: Record<string, { open: string; close: string }>): string {
  const hours = businessHours[dayKey];
  if (!hours) return "Closed";

  const to12h = (timeStr: string) => {
    const [hStr, mStr] = timeStr.split(":");
    let h = Number(hStr);
    const m = mStr;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${m}${suffix}`;
  };

  return `${to12h(hours.open)} – ${to12h(hours.close)}`;
}
