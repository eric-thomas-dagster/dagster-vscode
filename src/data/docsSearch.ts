/**
 * Dagster's docs site (docs.dagster.io -> dagster.io/docs) is a Docusaurus
 * site using Algolia DocSearch -- confirmed live by fetching the page and
 * its compiled JS bundle, not guessed. The appId/apiKey/indexName below
 * are the exact values Docusaurus's `theme-search-algolia` plugin embeds
 * client-side for everyone (Algolia's own DocSearch program is designed
 * around this key being public: read-only, rate-limited, meant to power
 * exactly this kind of third-party search box). Deliberately NOT calling
 * Algolia's separate "Ask AI" feature also present on the site -- that's
 * a metered LLM-generation product layered on the same key, with its own
 * lazy-loaded, harder-to-reverse-engineer request flow, and uncertain
 * cost/ToS implications for programmatic reuse outside their own widget.
 */
const ALGOLIA_APP_ID = 'ZAPZSHIEAY';
const ALGOLIA_API_KEY = 'b3274515427bdc58790a225912bae270';
const ALGOLIA_INDEX_NAME = 'dagster docs crawler';

export interface DocsSearchHit {
  url: string;
  title: string;
  breadcrumb: string;
  snippet: string;
}

interface RawHit {
  url: string;
  content: string | null;
  hierarchy: Record<string, string | null>;
  _snippetResult?: { content?: { value: string } };
}

function stripHighlightTags(s: string): string {
  return s.replace(/<\/?span[^>]*>/g, '');
}

export async function searchDagsterDocs(query: string, hitsPerPage = 8): Promise<DocsSearchHit[]> {
  const res = await fetch(
    `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${encodeURIComponent(ALGOLIA_INDEX_NAME)}/query`,
    {
      method: 'POST',
      headers: {
        'X-Algolia-API-Key': ALGOLIA_API_KEY,
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`Algolia search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { hits: RawHit[] };

  return data.hits.map((hit) => {
    const levels = Object.values(hit.hierarchy).filter((v): v is string => !!v);
    const title = levels[levels.length - 1] ?? hit.url;
    const breadcrumb = levels.slice(0, -1).join(' › ');
    const snippet = stripHighlightTags(hit._snippetResult?.content?.value ?? hit.content ?? '').trim();
    return { url: hit.url, title, breadcrumb, snippet };
  });
}
