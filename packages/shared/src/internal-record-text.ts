/**
 * IS THIS THE PLATFORM'S OWN MACHINE TEXT, NOT PROSE? (review of #67)
 *
 * The analytics evidence a model reasons from is written as records —
 * `e3 | METRIC | metric.total | metric=clicks | value=40 | unit=COUNT |
 * from=… | to=…` — so that the model cites `e3` instead of narrating numbers.
 * A model (or the development double) that copies such a record into its
 * answer produced text that passes every numeric check once its digits are
 * gone, and a customer then read `e | METRIC | metric.total | unit=COUNT` on
 * the Performance screen.
 *
 * That text must never reach a person. This is the one test of it, used in
 * three places: the grounding gate refuses a generation that contains it, the
 * development double never emits it, and every screen that shows stored model
 * prose drops a line that carries it — rows stored before the gate existed
 * included.
 *
 * WHAT IT LOOKS FOR, and why it cannot misfire on prose: a `|` followed by a
 * `key=` pair (`| unit=COUNT`, `| metric=clicks`), or a record head — an `e`
 * ordinal and an upper-case kind between pipes (`e3 | METRIC |`). Neither
 * shape occurs in a sentence a person or a model would write to a customer.
 */
const KEY_VALUE_FIELD = /\|\s*[a-z][a-z_]*=/i;
const RECORD_HEAD = /(?:^|\s)e\d*\s*\|\s*[A-Z][A-Z_]+\s*\|/;

export function isInternalRecordText(text: string): boolean {
  return KEY_VALUE_FIELD.test(text) || RECORD_HEAD.test(text);
}
