/// <reference lib="webworker" />
import { getPageCount, mergePdfs, PdfToolError, splitPdf, type PageGroup } from "@tool/core";

export type WorkerRequest =
  | { op: "pageCount"; data: ArrayBuffer; name: string }
  | { op: "merge"; sources: { data: ArrayBuffer; name: string }[] }
  | { op: "split"; data: ArrayBuffer; name: string; groups: PageGroup[] };

export type WorkerResponse =
  | { id: number; ok: true; result: number | Uint8Array | Uint8Array[] }
  | { id: number; ok: false; message: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<WorkerRequest & { id: number }>) => {
  const { id, ...req } = event.data;
  try {
    let result: number | Uint8Array | Uint8Array[];
    switch (req.op) {
      case "pageCount":
        result = await getPageCount(req.data, req.name);
        break;
      case "merge":
        result = await mergePdfs(req.sources);
        break;
      case "split":
        result = await splitPdf(req.data, req.groups, req.name);
        break;
    }
    const transfer =
      typeof result === "number"
        ? []
        : (Array.isArray(result) ? result : [result]).map((r) => r.buffer as ArrayBuffer);
    self.postMessage({ id, ok: true, result } satisfies WorkerResponse, transfer);
  } catch (err) {
    const message =
      err instanceof PdfToolError ? err.message : "處理時發生未預期的錯誤，請再試一次。";
    if (!(err instanceof PdfToolError)) console.error(err);
    self.postMessage({ id, ok: false, message } satisfies WorkerResponse);
  }
};
