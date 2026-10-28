import { DefaultLoadingManager } from 'three';

/** Keep room assets portable between root hosting and a project subdirectory. */
export const appURL = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
DefaultLoadingManager.setURLModifier(url => {
  const base = import.meta.env.BASE_URL;
  if (base === '/' || !url.startsWith('/') || url.startsWith('//') || url.startsWith(base)) return url;
  return appURL(url);
});
for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
  anchor.href = appURL(anchor.getAttribute('href')!);
}
