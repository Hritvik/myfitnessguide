/**
 * A form's own refusal: what to type to make it right (ticket 67). A polite
 * status that is always in the tree, so a screen reader hears its words
 * change, named "What to fix" so it is told apart from the form's save line
 * and preview. It makes no box of its own (display: contents), so it takes
 * no space while empty and its text sits where the old line did. `inline`
 * puts the text straight in a span, for a line that already holds it.
 */
import { Text } from "./layout/Text";

export function FormError({ text, className, inline = false }: { text: string | null; className?: string; inline?: boolean }) {
  if (inline) {
    return (
      <Text as="span" className="form-error" role="status" aria-label="What to fix">
        {text ?? ""}
      </Text>
    );
  }
  return (
    <div className="form-error" role="status" aria-label="What to fix">
      {text ? (
        <Text as="p" className={className}>
          {text}
        </Text>
      ) : null}
    </div>
  );
}
