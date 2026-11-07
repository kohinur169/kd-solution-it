// path: app/(public)/README.md
# app/(public)

Owner: STEP 231-238 (public website, CMS and blog).

The public marketing and content surfaces: Home, Product, Pricing, Company, Legal, Support, Blog,
Contact and the policy pages, each editable through the CMS with generated SEO metadata and sitemap
entries. No merchant, payment or identity data is read inside this route group.

What the group holds today:

| Path | What it is |
| --- | --- |
| `layout.tsx` | The public shell: the metadata base every page resolves against, the site header, the content and the footer, plus the organisation and website structured data |
| `page.tsx` | The home page, inside the shell (STEP 232 replaces its copy with the published content) |
| `sitemap.ts` | `GET /sitemap.xml`, generated from the public route table |

Every public page is declared in `components/public/site.ts` and appears in the header, the footer
and the sitemap from that one entry. `components/public/verify.ts` resolves each entry to a
`page.tsx` here and each page back to an entry, so a page cannot ship without navigation and a
navigation item cannot point at a page that does not exist.

`GET /robots.txt` is served by `app/robots.ts`, at the root of the app directory rather than inside
this group: Next collects a robots file only from that root, while the rules it returns - the private
prefix list and the sitemap's address - are built by `components/public/seo.ts` and kept equal to the
application's own tree by the same gate.
