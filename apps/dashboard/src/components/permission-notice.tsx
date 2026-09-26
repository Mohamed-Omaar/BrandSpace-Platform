import { StateMessage } from '@brandspace/ui';
import { denialText } from '../server/denial';

/**
 * A CONTROL THE ROLE DOES NOT OFFER, EXPLAINED (A5, E6).
 *
 * Stands where the control would be — the invite form, the plan buttons — so a
 * member sees why it is missing instead of a gap. Composed from the existing
 * `StateMessage` `forbidden` state; no new visual treatment (CLAUDE.md §4.2).
 */
export function PermissionNotice({
  locale,
  permissionKey,
  memberName,
  ownerName,
  testId,
}: {
  readonly locale: string;
  readonly permissionKey: string;
  readonly memberName: string;
  readonly ownerName: string;
  readonly testId?: string;
}) {
  const text = denialText(locale, { permissionKey, memberName, ownerName });
  return (
    <StateMessage
      kind="forbidden"
      title={text.title}
      description={text.body}
      testId={testId ?? `permission-notice-${permissionKey}`}
    />
  );
}
