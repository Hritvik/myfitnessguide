import type { ReactNode } from "react";
import { Stack } from "../layout/Stack";
import { Text } from "../layout/Text";

/**
 * A record's section as a card (wide-layout spec §5, Catalogue A): its heading, then its content. Drawn only on a wide screen.
 * `span` lays it across the section grid's full width (a recipe's Lines, so its line names and buttons keep their room).
 */
export function RecordSection({ title, span = false, children }: { title: string; span?: boolean; children: ReactNode }) {
  return (
    <Stack wide gap={8} as="section" className={span ? "rsec rsec-span" : "rsec"} aria-label={title}>
      <Text as="h3">{title}</Text>
      {children}
    </Stack>
  );
}
