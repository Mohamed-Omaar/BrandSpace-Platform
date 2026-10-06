import type { PermissionGroupView } from '../server/permission-groups';

/**
 * A ROLE'S PERMISSIONS AS THE PROTOTYPE SHOWS THEM (round 4, 2.1): two columns
 * of `.card`s, one per group, each row the action's plain-language name, its
 * note when it has one, and where it comes from. Read-only — the product has
 * no per-member override (E6/Q4), so where the prototype draws its toggle the
 * row states the role's answer. No permission key is ever rendered.
 */
export function PermissionGroupsList({
  groups,
  t,
  testId,
}: {
  readonly groups: readonly PermissionGroupView[];
  readonly t: (key: never) => string;
  readonly testId: string;
}) {
  const say = t as (key: string) => string;
  return (
    <div className="bsp-pg" data-testid={testId}>
      {groups.map((group) => (
        <section
          key={group.id}
          className="bsp-card bsp-pg-card"
          data-testid={`${testId}-${group.id}`}
        >
          <div className="bsp-pg-h">{say(group.title)}</div>
          {group.rows.map((row) => (
            <div
              key={row.id}
              className="bsp-row bsp-pg-row"
              data-state={row.state}
              data-testid={`${testId}-row-${row.id}`}
            >
              <span className="bsp-pg-main">
                <span className="bsp-pg-label">{say(row.label)}</span>
                {row.note ? (
                  <span className="bsp-pg-note" data-sensitive={row.sensitive || undefined}>
                    {say(row.note)}
                  </span>
                ) : null}
              </span>
              <span className="bsp-pill bsp-p-neu" data-testid={`${testId}-state-${row.id}`}>
                {say(
                  row.state === 'role'
                    ? 'perms.fromRole'
                    : row.state === 'ownerOnly'
                      ? 'perms.ownerOnly'
                      : 'perms.notInRole',
                )}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
