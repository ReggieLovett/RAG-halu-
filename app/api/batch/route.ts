import { batchReportCsv, readBatchRequest, runBatch } from "../../../lib/rag/batch";
import { apiError } from "../../../lib/rag/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = await readBatchRequest(request);
    const report = await runBatch(input, request.signal);
    const url = new URL(request.url);
    const csv = url.searchParams.get("format") === "csv";
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (csv || url.searchParams.get("download") === "1") {
      headers["Content-Disposition"] = `attachment; filename="rag-batch-report.${csv ? "csv" : "json"}"`;
    }
    if (csv) return new Response(batchReportCsv(report), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    return Response.json(report, { headers });
  } catch (error) { return apiError(error); }
}
