/** The prototype's preview size line (`GEO`, `Main.dc.html` line 2357). */
export function previewGeometry(contentType: string, platformKey: string): string {
  if (contentType === 'REEL' || contentType === 'STORY' || platformKey === 'tiktok') {
    return '1080 × 1920 · 9:16';
  }
  if (platformKey === 'linkedin') return '1200 × 1200 · 1:1';
  return '1080 × 1350 · 4:5';
}
