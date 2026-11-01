import { Card, Field, Stack, buttonClass, spacingTokens } from '@brandspace/ui';
import { extendTrialAction } from '../../app/[locale]/console/workspaces/actions';
import { simpleCopy } from '../../i18n/simple';

/**
 * EXTEND A FREE TRIAL (D-584). Shown to a platform user who may assign plans,
 * for a workspace on its trial or just past it. Composed only from the shared
 * `Card`, `Field` and `Stack`: no inline style, no literal (D-581).
 */
export function ExtendTrialCard({
  locale,
  workspaceId,
}: {
  readonly locale: string;
  readonly workspaceId: string;
}) {
  const copy = simpleCopy(locale);
  return (
    <Card
      title={copy('cd.extendTrial')}
      description={copy('cd.extendTrialHint')}
      testId="customer-extend-trial"
    >
      <form action={extendTrialAction}>
        <Stack gap={spacingTokens.xs}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <Field label={copy('cd.extendTrialDays')} htmlFor="simple-trial-days">
            <input
              id="simple-trial-days"
              name="days"
              type="number"
              min={1}
              max={365}
              step={1}
              required
              className="bs-control bs-field"
              data-testid="simple-trial-days"
            />
          </Field>
          <Field
            label={copy('common.reason')}
            htmlFor="trial-reason"
            hint={copy('common.reasonHint')}
          >
            <input
              className="bs-control bs-field"
              id="trial-reason"
              name="reason"
              required
              minLength={8}
              data-testid="trial-reason"
            />
          </Field>
          <div>
            <button
              type="submit"
              className={buttonClass('primary')}
              data-testid="simple-trial-submit"
            >
              {copy('cd.apply')}
            </button>
          </div>
        </Stack>
      </form>
    </Card>
  );
}
