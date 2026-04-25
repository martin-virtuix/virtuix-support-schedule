import type { DocumentBrand } from './constants';

export function trimLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, '');
}

export function normalizeStoragePath(path: string): string {
  return trimLeadingSlashes(path).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

export function resolveStorageItemPath(folder: string, itemName: string, brand: DocumentBrand): string {
  const rawName = trimLeadingSlashes(itemName);
  if (rawName.startsWith(`${brand}/`)) {
    return rawName;
  }

  const rawFolder = trimLeadingSlashes(folder);
  return `${rawFolder}/${itemName}`.replace(/^\/+/, '');
}

export function getDocumentRelativePath(path: string, brand: DocumentBrand): string | null {
  const normalizedPath = normalizeStoragePath(path);
  const prefix = `${brand}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }
  return normalizedPath.slice(prefix.length);
}

export function getDocumentTopLevelFolder(path: string, brand: DocumentBrand): string | null {
  const relativePath = getDocumentRelativePath(path, brand);
  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return null;
  }
  return segments[0];
}

export type SupportDocumentLike = {
  brand: DocumentBrand;
  path: string;
};

export function getFolderOptionsForBrand(documents: SupportDocumentLike[], brand: DocumentBrand): string[] {
  const folders = new Set<string>();
  documents.forEach((document) => {
    if (document.brand !== brand) return;
    const folder = getDocumentTopLevelFolder(document.path, brand);
    if (folder) folders.add(folder);
  });
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

export function filterDocumentsByFolder<T extends SupportDocumentLike>(
  documents: T[],
  brand: DocumentBrand,
  topLevelFolder: string | null,
): T[] {
  if (!topLevelFolder || topLevelFolder === 'all') {
    return documents.filter((document) => document.brand === brand);
  }
  return documents.filter(
    (document) => document.brand === brand && getDocumentTopLevelFolder(document.path, brand) === topLevelFolder,
  );
}

export function getFirstDocumentPath<T extends SupportDocumentLike>(
  documentsByBrand: Record<DocumentBrand, T[]>,
  brand: DocumentBrand,
  topLevelFolder: string | null,
): string | null {
  const byFolder = filterDocumentsByFolder(documentsByBrand[brand] || [], brand, topLevelFolder);
  if (byFolder.length > 0) {
    return byFolder[0].path;
  }
  return (documentsByBrand[brand] || [])[0]?.path || null;
}

export function flattenDocumentsByBrand<T>(documentsByBrand: Record<DocumentBrand, T[]>): T[] {
  return Object.values(documentsByBrand).flat();
}
