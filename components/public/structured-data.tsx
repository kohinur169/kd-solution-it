// path: components/public/structured-data.tsx
import type { ReactNode } from "react";
import { serializeStructuredData, type StructuredData } from "./seo";

/**
 * The JSON-LD blocks of a public page, written with the response's content security policy nonce.
 *
 * ## Why the nonce is not optional here
 *
 * A `<script type="application/ld+json">` element does not execute, but the policy this platform
 * sends does not care: `script-src` applies to every script element in the document unless the
 * element carries a nonce the header named, and a browser that blocks the element is a browser in
 * which the structured data simply does not exist. The root layout already reads the nonce for the
 * pre-paint theme script and fails loudly when it is missing; this component takes the same value
 * as a prop rather than reading it again, so one request reads one nonce and there is nothing to
 * disagree about.
 *
 * ## Why the object is serialised by hand, and why the block is a child rather than markup
 *
 * A script element's content is raw text: React writes it verbatim, quoting and angle brackets
 * included, because the browser does not parse what is inside it as markup. That is exactly why the
 * escape matters - `serializeStructuredData` (in `./seo`) turns `<`, `>` and `&` into their JSON
 * unicode escapes, so a value carrying `</script>` stays a string inside the block instead of
 * closing the element and letting the rest of the payload become markup.
 *
 * The block is therefore rendered as an ordinary child rather than as raw markup: the platform
 * keeps exactly one place that writes markup from a string (the root layout's pre-paint theme
 * script, a constant), and a JSON-LD block does not need to be the second. React escapes a text
 * child; a script child it writes as it is, which is what this needs - and the gate proves the
 * escaping by parsing the serialised payload back into the object it came from.
 *
 * ## One element per object
 *
 * Two small blocks - the organisation and the site - rather than one array: a search engine reads
 * both, and a failure in one is easier to see in a view source than a failure inside a top level
 * array. The key is the schema type, which is unique per block by construction.
 */

export interface StructuredDataProperties {
  /** The per-response content security policy nonce, read by the layout that renders this. */
  readonly nonce: string;
  readonly blocks: readonly StructuredData[];
}

export function StructuredDataBlocks({ nonce, blocks }: StructuredDataProperties): ReactNode {
  return (
    <>
      {blocks.map((block) => {
        const type = typeof block["@type"] === "string" ? block["@type"] : "Thing";

        return (
          <script key={type} nonce={nonce} type="application/ld+json">
            {serializeStructuredData(block)}
          </script>
        );
      })}
    </>
  );
}
