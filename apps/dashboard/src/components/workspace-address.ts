/**
 * Step 7 (flow 7.1) — THE WORKSPACE ADDRESS IS SUGGESTED, NOT ASKED.
 *
 * The Business step asks two questions, as the prototype does, and the
 * address sits under "More" with the account's other facts. Left empty, it
 * stopped the step with a third required field. It is now suggested from the
 * business name — or, for a name with no Latin letters, from the account's
 * address — in the field's own pattern (`[a-z0-9][a-z0-9-]{1,48}[a-z0-9]`),
 * and stays the person's to change; the server still validates it and reports
 * an address already taken.
 */
const MAX = 50;

function slugOf(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');
}

export function suggestedWorkspaceAddress(name: string, email: string): string {
  const fromName = slugOf(name);
  if (fromName.length >= 3) return fromName;
  const fromEmail = slugOf(email.split('@')[0] ?? '');
  if (fromEmail.length >= 3) return fromEmail;
  return '';
}
