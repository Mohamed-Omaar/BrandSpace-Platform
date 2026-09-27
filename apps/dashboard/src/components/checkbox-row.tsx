import { spacingTokens, typographyTokens } from '@brandspace/ui';

/**
 * A checkbox, composed rather than created — moved here from the Approvals
 * screen when the approval rules moved to Settings (A8), and reused by the
 * Settings notification switches.
 *
 * `Field` renders a text control, and a checkbox is the one shape it does not
 * cover. It uses the same label typography, the same focus treatment and the
 * same spacing tokens as everything else — UI-FIDELITY-CONTRACT §6.2 rule 4
 * asks for a recorded reason when something new appears, and this is it.
 *
 * THE WHOLE ROW IS THE TARGET, and it is at least 24px tall: WCAG 2.2 AA 2.5.8
 * sets a 24×24 minimum and a native checkbox renders at about 13×13. Growing
 * the box alone would fix the number and leave a fiddly target; making the
 * LABEL the target is what the criterion asks for.
 */
export function CheckboxRow({
  name,
  label,
  checked,
  testId,
  value,
  hint,
}: {
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
  readonly testId: string;
  readonly value?: string | undefined;
  /** A second line under the label, saying what the switch changes. */
  readonly hint?: string | undefined;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: spacingTokens.xs,
        alignItems: hint ? 'flex-start' : 'center',
        minBlockSize: '24px',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        name={name}
        {...(value !== undefined ? { value } : {})}
        defaultChecked={checked}
        data-testid={testId}
        style={{
          inlineSize: '20px',
          blockSize: '20px',
          margin: 0,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      />
      <span style={{ display: 'grid', gap: '0.125rem' }}>
        <span style={typographyTokens.bodySm}>{label}</span>
        {hint ? <span style={typographyTokens.caption}>{hint}</span> : null}
      </span>
    </label>
  );
}
