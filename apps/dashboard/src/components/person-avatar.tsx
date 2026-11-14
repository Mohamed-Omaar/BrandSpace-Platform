/**
 * PR D (D-609) — A PERSON, AS A TILE: their avatar in a circle, or the
 * prototype's coloured initials (`.bsp-tm-av[data-c]`) when they have none.
 *
 * Two ways to be read. Beside the person's written name the tile is
 * decoration (`aria-hidden`). Where the tile STANDS FOR the name — a post's
 * "created by" — pass `label`: the tile is then an image named for the person,
 * and the same words are its tooltip.
 */
export function PersonAvatar({
  initials,
  index,
  src,
  label,
  size,
  className,
  testId,
}: {
  readonly initials: string;
  /** The person's place in the list, for the prototype's four colours. */
  readonly index: number;
  readonly src?: string | null | undefined;
  /** "Created by Sara" — set when the tile replaces the written name. */
  readonly label?: string | undefined;
  readonly size?: 36 | 48 | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <span
      className={className ? `bsp-tm-av ${className}` : 'bsp-tm-av'}
      data-c={Math.max(0, index) % 4}
      data-size={size}
      data-pic={src ? 'true' : undefined}
      data-testid={testId}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
    >
      {src ? <img className="bsp-pic" src={src} alt="" /> : initials}
    </span>
  );
}
