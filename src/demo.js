import { DEMO, DEMO_SETUP_HELP } from "./demo-manifest.js";
import { preparePaks } from "./pak.js";

async function download(spec, { fetcher, signal, onProgress }) {
  let response;
  try { response = await fetcher(`/demo/${spec.name}`, { signal, cache: "no-store" }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Could not load the LibreQuake demo (${spec.name}). ${DEMO_SETUP_HELP}`, { cause: error });
  }
  if (!response.ok) throw new Error(`LibreQuake demo unavailable (${spec.name}, HTTP ${response.status}). ${DEMO_SETUP_HELP}`);
  const bytes = new Uint8Array(spec.size);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > bytes.byteLength) throw new Error(`${spec.name}: unexpected demo archive size.`);
      bytes.set(value, offset); offset += value.byteLength;
      onProgress(offset);
    }
    if (offset !== spec.size) throw new Error(`${spec.name}: incomplete demo download.`);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  signal?.throwIfAborted();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (hash !== spec.sha256) throw new Error(`${spec.name}: demo integrity check failed. ${DEMO_SETUP_HELP}`);
  return { name: spec.name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
}

/** Download only the pinned local-server bundle; no model or proprietary data is fetched. */
export async function loadDemo({ signal, onProgress = () => {}, fetcher = fetch, manifest = DEMO } = {}) {
  const total = manifest.files.reduce((n, spec) => n + spec.size, 0);
  let completed = 0;
  const files = [];
  for (const spec of manifest.files) {
    signal?.throwIfAborted();
    onProgress({ name: spec.name, loaded: completed, total });
    files.push(await download(spec, { fetcher, signal, onProgress: (n) => onProgress({ name: spec.name, loaded: completed + n, total }) }));
    completed += spec.size;
  }
  signal?.throwIfAborted();
  const data = await preparePaks(files);
  if (!data.maps.includes(manifest.map)) throw new Error(`The demo level is missing. ${DEMO_SETUP_HELP}`);
  return data;
}
