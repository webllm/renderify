/**
 * Whether `value` can sit inside an inline `<script>` element without ending
 * it early. Besides `</script`, the HTML tokenizer's double-escaped state
 * (entered by `<!--` followed by `<script`) makes the real closing tag lose
 * its meaning, so text containing both is rejected too.
 */
export function isSafeInlineScriptText(value: string): boolean {
  // `[<]` keeps the patterns from containing the sequences they reject.
  return (
    !/[<]\/script/i.test(value) &&
    !(/[<]!--/.test(value) && /[<]script/i.test(value))
  );
}
