/**
 * The input chokepoint.
 *
 * The one place an agent's event reaches this page. The engine already enforced the
 * capability, the allowlist, liveness, expiry and the tier; this layer enforces the one
 * thing only it can know — whether the coordinate lands somewhere the serializer could
 * represent.
 *
 * The enforcement is **not** against the marked tree. At dispatch the coordinate is
 * resolved against the **live** DOM, so a region that became opaque since the last mirror
 * frame is refused too, and a node the serializer never emitted is refused as `unknown`
 * rather than allowed by omission. There is no branch here that dispatches something the
 * checks did not clear, and no variant of `event` that could grow into "run this".
 */

import type { InputEvent_, Refusal } from "../../protocol/src/index.js";
import { NAMED_KEYS, isSendableKey } from "../../protocol/src/index.js";
import type { Serializer } from "./serializer.js";

const BUTTONS: Record<string, number> = { primary: 0, secondary: 2, middle: 1, none: 0 };

export interface ChokepointHost {
  serializer: Serializer;
  /** The consent surface's iframe, excluded geometrically as an independent check rather
   *  than as a consequence of it being a frame. docs/03 §2a asks for both layers by name,
   *  and this one holds even if the frame were somehow not marked opaque. */
  consentFrame: () => HTMLIFrameElement | null;
}

export class Chokepoint {
  constructor(private readonly host: ChokepointHost) {}

  /** Why a normalised coordinate may not be acted on, or null. */
  representability(x: number, y: number): Refusal | null {
    return this.resolve(x, y).refusal;
  }

  /**
   * Hit-test once, and report both what is there and why it may not be touched.
   *
   * `dispatch` needs the element *and* the verdict, and computing them separately meant two
   * `elementFromPoint` calls per agent pointer event — each one forcing a style and layout
   * flush, on the customer's device, at pointer rate for the length of a gesture.
   */
  private resolve(
    x: number,
    y: number
  ): { target: Element | null; refusal: Refusal | null; px: number; py: number } {
    const px = x * (window.innerWidth || 1);
    const py = y * (window.innerHeight || 1);

    const frame = this.host.consentFrame();
    if (frame) {
      const r = frame.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        return { target: null, refusal: "consent-surface", px, py };
      }
    }

    const target = document.elementFromPoint(px, py);
    if (!target) return { target: null, refusal: "unknown", px, py };
    return { target, refusal: this.walk(target), px, py };
  }

  /** `Serializer.representability`, which is the one place this rule lives. */
  private walk(from: Element | null): Refusal | null {
    return this.host.serializer.representability(from);
  }

  /** Deliver one validated event. Returns null, or the refusal. */
  dispatch(event: InputEvent_): Refusal | null {
    let target: Element | null;
    let px = 0;
    let py = 0;
    if (event.kind === "key") {
      target = document.activeElement as Element | null;
      if (!target) return "unknown";
      const refusal = this.walk(target);
      if (refusal) return refusal;
    } else {
      // One hit test, answering both questions. `pointer` and `scroll` are gated on the
      // verdict; the other kinds carry coordinates but are not coordinate-gated, and still
      // need the element underneath.
      const hit = this.resolve("x" in event ? event.x : 0, "y" in event ? event.y : 0);
      if ((event.kind === "pointer" || event.kind === "scroll") && hit.refusal) {
        return hit.refusal;
      }
      if (!hit.target) return "unknown";
      target = hit.target;
      px = hit.px;
      py = hit.py;
    }

    switch (event.kind) {
      case "pointer": {
        const type =
          event.action === "move" ? "pointermove" : event.action === "down" ? "pointerdown" : "pointerup";
        target.dispatchEvent(pointerEvent(type, px, py, event.button));
        target.dispatchEvent(
          mouseEvent(
            event.action === "move" ? "mousemove" : event.action === "down" ? "mousedown" : "mouseup",
            px,
            py,
            event.button
          )
        );
        if (event.action === "up") {
          target.dispatchEvent(mouseEvent("click", px, py, event.button));
          (target as HTMLElement).focus?.();
        }
        return null;
      }
      case "scroll": {
        const scroller = scrollableAncestor(target);
        if (scroller === window) window.scrollBy(event.dx, event.dy);
        else (scroller as Element).scrollBy(event.dx, event.dy);
        return null;
      }
      case "key":
        return dispatchKey(target, event);
      default:
        return "unknown";
    }
  }
}

function pointerEvent(type: string, x: number, y: number, button: string): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: BUTTONS[button] ?? 0,
    pointerType: "mouse",
    isPrimary: true
  });
}

function mouseEvent(type: string, x: number, y: number, button: string): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: BUTTONS[button] ?? 0
  });
}

function scrollableAncestor(el: Element): Element | Window {
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    // Size test first: `getComputedStyle` resolves style for the node, and almost no ancestor
    // overflows. This runs per level per agent scroll event, on the customer's device.
    if (n.scrollHeight > n.clientHeight && /(auto|scroll)/.test(window.getComputedStyle(n).overflowY)) {
      return n;
    }
  }
  return window;
}

function dispatchKey(target: Element, event: Extract<InputEvent_, { kind: "key" }>): Refusal | null {
  // The engine already refused `SecureAttention` below T2. It has no meaning in a browser
  // at all, so it is refused here too rather than being quietly dropped.
  if (event.code === "SecureAttention") return "unknown";
  if (!isSendableKey(event.code)) return "unknown";
  // Named keys move a caret or submit; a single character is text. The two are edited
  // differently below, which is the only reason this end cares which it got.
  const named = NAMED_KEYS.includes(event.code) ? event.code : null;
  const key = event.code;

  const type = event.action === "down" ? "keydown" : "keyup";
  target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true }));

  // Typing into a field is a value change, not just a key event: dispatching `keydown`
  // alone moves nothing, because the browser only edits fields for trusted events.
  if (event.action === "down" && isEditable(target)) {
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    const value = field.value == null ? "" : String(field.value);
    // Respect the caret. Appending to the end regardless put every corrected character in
    // the wrong place the moment the customer had clicked back into the middle of a field.
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? start;
    if (named === "Backspace") {
      if (start === end && start === 0) return null;
      const from = start === end ? start - 1 : start;
      field.value = value.slice(0, from) + value.slice(end);
      setCaret(field, from);
    } else if (named === "Delete") {
      if (start === end && start >= value.length) return null;
      const to = start === end ? end + 1 : end;
      field.value = value.slice(0, start) + value.slice(to);
      setCaret(field, start);
    } else if (!named) {
      field.value = value.slice(0, start) + key + value.slice(end);
      setCaret(field, start + key.length);
    } else {
      return null;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return null;
}

function setCaret(field: HTMLInputElement | HTMLTextAreaElement, at: number): void {
  try {
    field.setSelectionRange(at, at);
  } catch {
    // `setSelectionRange` throws on input types that have no text selection — `number`,
    // `date`, `color`. The value change already landed, which is the part that matters.
  }
}

function isEditable(el: Element): boolean {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}
