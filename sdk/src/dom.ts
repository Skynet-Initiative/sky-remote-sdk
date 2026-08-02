/** DOM helpers shared by the two things this SDK puts on a merchant's page.
 *
 *  The consent panel and the presence overlay are both our own elements living in someone
 *  else's document, which gives them two problems in common: the merchant's stylesheet must not
 *  be able to move them, and our own serializer must not mirror them back to the console. Both
 *  answers live here so adding a third piece of chrome is one import rather than a search.
 */

/** The attribute namespace every element this SDK creates carries. */
const SKY_ATTRIBUTE_PREFIX = "data-sky-";

/**
 * Is this element ours rather than the customer's page?
 *
 * One predicate over the namespace, not a list of specific attributes. The list version had
 * already been outgrown: it tested `data-sky-consent` and `data-sky-presence` exactly, while
 * `ConsentHost` appends a `<style data-sky-consent-style>` to `document.head` — for which
 * `getAttribute("data-sky-consent")` is `null`. Nothing skipped it, so the SDK's own dialog and
 * backdrop CSS was serialized as part of the customer's page and shipped to the agent.
 *
 * Matching the namespace means a new piece of chrome is covered by naming its attribute
 * `data-sky-*`, which is the convention already in use, rather than by remembering to edit two
 * predicates in two files.
 */
export function isSkyOwned(el: Element): boolean {
  if (!el.attributes) return false;
  for (const attr of el.attributes) {
    if (attr.name.startsWith(SKY_ATTRIBUTE_PREFIX)) return true;
  }
  return false;
}

/**
 * Apply declarations as `!important`.
 *
 * Every declaration on an element we own has to win against the merchant's stylesheet, because
 * a rule as ordinary as `div { position: static }` or `iframe { position: static !important }`
 * would otherwise unpin the consent panel or strand the presence cursor. There is no case where
 * we want a merchant's cascade to move our own chrome, so the strength is not a per-call
 * decision.
 */
export function important(el: HTMLElement, declarations: Record<string, string>): void {
  for (const [property, value] of Object.entries(declarations)) {
    el.style.setProperty(property, value, "important");
  }
}

/**
 * Close a socket without caring whether it was already closing.
 *
 * `WebSocket.close()` on a socket in `CLOSING` or `CLOSED` is a no-op, but a socket that never
 * finished connecting can throw — and every caller here is on a teardown path where that is not
 * a different outcome. Written once because it was written out six times in one file.
 */
export function closeQuietly(socket: { close(): void } | null | undefined): void {
  try {
    socket?.close();
  } catch {
    /* already closing */
  }
}
