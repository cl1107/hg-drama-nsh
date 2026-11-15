import { signal } from "nsh";
import { loadHome, type Section } from "./providers/catalog";
type CatalogState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; sections: Section[] } | { kind: "error"; message: string };
const state = signal<CatalogState>({ kind: "idle" });
let pending: AbortController | undefined;
export const catalog = () => state();
export async function refreshCatalog() {
 pending?.abort();
 const request = new AbortController(); pending = request;
 state.set({ kind: "loading" });
 const timeout = setTimeout(() => request.abort(), 15000);
 try {
  const sections = await loadHome(request.signal);
  if (pending === request) state.set({ kind: "ready", sections });
 } catch (error) {
  if (pending === request) state.set({ kind: "error", message: request.signal.aborted ? "请求超时，请重试" : error instanceof Error ? error.message : "目录加载失败" });
 } finally { clearTimeout(timeout); }
}
export function cancelCatalog() { pending?.abort(); pending = undefined; }
