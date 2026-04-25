function getRequiredEnvValue(...keys: string[]): string {
  for (const key of keys) {
    const value = import.meta.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable. Tried: ${keys.join(', ')}`);
}

export const SUPABASE_URL = getRequiredEnvValue('VITE_SUPABASE_URL');
export const SUPABASE_PUBLISHABLE_KEY = getRequiredEnvValue(
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
);
export const SUPPORT_DOCUMENTS_BUCKET = import.meta.env.VITE_SUPPORT_DOCUMENTS_BUCKET || 'support-documents';
