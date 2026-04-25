export const ALLOWED_DOMAIN = '@virtuix.com';
export const SUPPORT_DOCUMENTS_BRANDS = ['omni_one', 'omni_arena'] as const;
export type DocumentBrand = (typeof SUPPORT_DOCUMENTS_BRANDS)[number];

export function isDocumentBrand(value: string): value is DocumentBrand {
  return value === 'omni_one' || value === 'omni_arena';
}
