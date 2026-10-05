import * as vscode from 'vscode';

/**
 * Same source Dagster Designer's own backend uses (confirmed: grepped
 * backend/app/api/templates_registry.py for its MANIFEST_URL rather than
 * guessing) -- 1296 real community components as of this writing, each
 * with a real `component.py` (a Component subclass) + `example.yaml`
 * (the defs.yaml shape to adapt), confirmed live by fetching a real
 * sample (ab_controls) rather than assuming the shape from the manifest
 * schema alone.
 */
const MANIFEST_URL = 'https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/main/manifest.json';
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface CatalogComponent {
  id: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  componentUrl: string;
  exampleUrl: string;
  requirementsUrl?: string;
  pipDependencies: string[];
}

interface RawManifest {
  total: number;
  components: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    tags?: string[];
    component_url: string;
    example_url: string;
    requirements_url?: string;
    dependencies?: { pip?: string[] };
  }>;
}

let memoryCache: { fetchedAt: number; components: CatalogComponent[] } | null = null;

function toCatalogComponent(raw: RawManifest['components'][number]): CatalogComponent {
  return {
    id: raw.id,
    name: raw.name,
    category: raw.category,
    description: raw.description,
    tags: raw.tags ?? [],
    componentUrl: raw.component_url,
    exampleUrl: raw.example_url,
    requirementsUrl: raw.requirements_url,
    pipDependencies: raw.dependencies?.pip ?? [],
  };
}

function diskCachePath(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'component-catalog-manifest.json');
}

export async function fetchComponentCatalog(context: vscode.ExtensionContext): Promise<CatalogComponent[]> {
  if (memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryCache.components;
  }

  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as RawManifest;
    const components = raw.components.map(toCatalogComponent);
    memoryCache = { fetchedAt: Date.now(), components };

    try {
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      await vscode.workspace.fs.writeFile(diskCachePath(context), Buffer.from(JSON.stringify(raw)));
    } catch {
      // Disk cache is a nice-to-have fallback, not required for this call to succeed.
    }
    return components;
  } catch (e) {
    // GitHub unreachable/rate-limited -- fall back to the last successful
    // fetch on disk rather than leaving the catalog empty.
    try {
      const bytes = await vscode.workspace.fs.readFile(diskCachePath(context));
      const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as RawManifest;
      const components = raw.components.map(toCatalogComponent);
      memoryCache = { fetchedAt: Date.now(), components };
      return components;
    } catch {
      throw e;
    }
  }
}
