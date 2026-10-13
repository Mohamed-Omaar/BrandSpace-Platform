/**
 * PR F (b), Q9 — "AI isn't available yet." The one line a surface shows in
 * place of its AI controls while no AI task it offers can run (D-507). Plain
 * text in the upload line's treatment (`.bsp-up-noscan`): no button, no link,
 * no detail about why — a customer has nothing to do about it.
 */
export function AiUnavailableLine({
  text,
  testId = 'ai-unavailable',
}: {
  readonly text: string;
  readonly testId?: string;
}) {
  return (
    <p className="bsp-ai-off" data-testid={testId}>
      {text}
    </p>
  );
}
