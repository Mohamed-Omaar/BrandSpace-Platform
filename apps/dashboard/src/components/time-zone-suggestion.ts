/**
 * THE ZONE A FORM SHOWS AFTER THE COUNTRY CHANGES (Q7, prototype v94 Phase 2B-1).
 *
 * Choosing a country PRESELECTS its usual zone (`suggestedTimeZones()` in
 * `@brandspace/shared`, computed on the server and handed to the form). The
 * new country's suggestion replaces the zone only while the zone is still
 * EMPTY or still the previous country's own suggestion — the person has not
 * chosen one themselves. A zone somebody picked is never overwritten, and
 * nothing is saved that they did not confirm (D-194).
 *
 * No imports, so the client forms that call it pull nothing server-side in.
 */
export function timeZoneAfterCountryChange(input: {
  readonly previousCountry: string;
  readonly nextCountry: string;
  readonly currentZone: string;
  readonly suggestions: Readonly<Record<string, string>>;
}): string {
  const untouched =
    input.currentZone === '' || input.currentZone === input.suggestions[input.previousCountry];
  if (!untouched) return input.currentZone;
  return input.suggestions[input.nextCountry] ?? input.currentZone;
}
