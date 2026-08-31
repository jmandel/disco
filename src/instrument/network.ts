// HTTP / WebSocket / SSE capture (GUIDANCE §3.4). Bodies fetched eagerly on loadingFinished; textual
// bodies land in `bodies.text` (FTS), everything in blobs. Attribution decided at requestWillBeSent.
import type { CdpEvent } from "../cdp.ts";
import type { Daemon, TargetState } from "../daemon.ts";
import type { RequestWillBeSent, ResponseReceived, LoadingFinished, LoadingFailed, WebSocketFrame } from "../protocol.ts";
import { defaults } from "../../defaults.ts";
import { isTextual } from "../store.ts";
import { fireSentinel } from "../sentinels.ts";

export interface InflightRequest { id: string; targetId: string; frameId: string | null; url: string; family: string; tStart: number; actionId: string | null; attribution: string; resourceType: string | undefined; mime?: string; status?: number; streaming?: boolean; stalled?: boolean; lastData?: number; stallTimer?: ReturnType<typeof setTimeout>; method: string; writeKind: string }

export function handleNetwork(d: Daemon, t: TargetState, e: CdpEvent): void {
  const p = e.params;
  switch (e.method) {
    case "Network.requestWillBeSent": return onRequest(d, t, p as RequestWillBeSent);
    case "Network.responseReceived": return onResponse(d, t, p as ResponseReceived);
    case "Network.loadingFinished": { void onFinished(d, t, p as LoadingFinished); return; }
    case "Network.loadingFailed": return onFailed(d, t, p as LoadingFailed);
    case "Network.dataReceived": {
      const id = d.reqAlias.get(p.requestId) ?? p.requestId;
      const inf = d.inflight.get(id);
      if (inf) { inf.lastData = d.now(); if (inf.stallTimer) { clearTimeout(inf.stallTimer); armStallTimer(d, t, inf); } }
      return;
    }
    case "Network.requestServedFromCache": { const id = d.reqAlias.get(p.requestId) ?? p.requestId; d.store.update("requests", { from_cache: 1 }, "id=?", [id]); return; }
    case "Network.webSocketCreated": {
      const now = d.now();
      const actionId = d.windowFor(t.targetId, now)?.actionId ?? null;
      d.store.upsert("websockets", { id: p.requestId, target_id: t.targetId, url: p.url, t_open: now, action_id: actionId });
      d.wsUrls.set(p.requestId, p.url);
      d.publish({ kind: "ws_open", t: now, targetId: t.targetId, actionId, ref: p.requestId, summary: { url: p.url } });
      return;
    }
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": return onWsFrame(d, t, p as WebSocketFrame, e.method.endsWith("Sent") ? "out" : "in");
    case "Network.webSocketFrameError": {
      const at = d.monoToT(p.timestamp);
      d.store.insert("ws_frames", { ws_id: p.requestId, t: at, dir: "in", opcode: -1, size: 0, payload: `[error] ${p.errorMessage}`, action_id: d.windowFor(t.targetId, at)?.actionId ?? null });
      return;
    }
    case "Network.webSocketClosed": {
      const at = d.monoToT(p.timestamp);
      d.store.update("websockets", { t_close: at }, "id=?", [p.requestId]);
      d.publish({ kind: "ws_close", t: at, targetId: t.targetId, ref: p.requestId, summary: { url: d.wsUrls.get(p.requestId) } });
      return;
    }
    case "Network.eventSourceMessageReceived": {
      const at = d.monoToT(p.timestamp);
      const id = d.reqAlias.get(p.requestId) ?? p.requestId;
      const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
      const seq = d.store.insert("sse_events", { t: at, request_id: id, event: p.eventName, event_id: p.eventId, data: String(p.data ?? "").slice(0, defaults.wsPayloadCap), action_id: actionId });
      d.publish({ kind: "sse", t: at, targetId: t.targetId, actionId, ref: seq, summary: { req: id, event: p.eventName, preview: String(p.data ?? "").slice(0, 80) } });
      return;
    }
  }
}

function onRequest(d: Daemon, t: TargetState, p: RequestWillBeSent) {
  d.learnClock(p.timestamp, p.wallTime);
  const tStart = d.monoToT(p.timestamp);
  let id = p.requestId;
  let redirectFrom: string | null = null;
  if (p.redirectResponse) {
    // finalize the previous hop; this event *is* the next hop of the same requestId
    const prevId = d.reqAlias.get(p.requestId) ?? p.requestId;
    const rr = p.redirectResponse;
    d.store.update("requests", { t_response: tStart, t_end: tStart, status: rr.status, status_text: rr.statusText, mime: rr.mimeType, resp_headers: JSON.stringify(rr.headers), encoded_size: rr.encodedDataLength, body_state: "none" }, "id=?", [prevId]);
    const prev = d.inflight.get(prevId);
    if (prev) { d.inflight.delete(prevId); d.attrib.observeEnd(prevId, tStart); d.publish({ kind: "response", t: tStart, targetId: t.targetId, actionId: prev.actionId, ref: prevId, summary: { s: rr.status, u: short(prev.url), ms: Math.round(tStart - prev.tStart), a: prev.attribution, redirect: short(p.request.url) } }); }
    const n = (d.redirectCount.get(p.requestId) ?? 0) + 1;
    d.redirectCount.set(p.requestId, n);
    id = `${p.requestId}:r${n}`;
    redirectFrom = prevId;
  }
  d.reqAlias.set(p.requestId, id);
  const a = d.attrib.observeRequest({ id, method: p.request.method, url: p.request.url, tStart, targetId: t.targetId, initiatorType: p.initiator?.type, redirectFrom, postData: p.request.postData ?? null, resourceType: p.type });
  // Trailing attribution (dry-run friction #3): a non-ambient request starting shortly after a window
  // closed on this root — with no new window open — is causally downstream of that action (delayed
  // validations, optimistic-save status checks). Tagged "trailing"; never fed to settlement.
  let actionId = a.actionId; let attribution: string = a.attribution;
  if (!actionId && attribution === "none" && !d.attrib.isAmbient(a.family)) {
    const rootId = d.targets.get(t.targetId)?.rootTargetId ?? t.targetId;
    const lc = d.lastClosed.get(rootId);
    if (lc && tStart - lc.tClosed <= defaults.trailingAttributionMs && !d.windows.get(rootId)) { actionId = lc.actionId; attribution = "trailing"; }
  }
  const initiator = p.initiator ? { type: p.initiator.type, url: p.initiator.url, line: p.initiator.lineNumber, stack: p.initiator.stack?.callFrames?.slice(0, 6).map((f) => `${f.functionName || "(anon)"}@${short(f.url, 80)}:${f.lineNumber}`) } : null;
  d.store.insert("requests", {
    id, target_id: t.targetId, frame_id: p.frameId ?? null, t_start: tStart, method: p.request.method, url: p.request.url, host: a.host, path: a.path, family: a.family,
    resource_type: p.type ?? null, initiator_type: p.initiator?.type ?? null, initiator: initiator ? JSON.stringify(initiator) : null,
    req_headers: JSON.stringify(p.request.headers ?? {}), req_body: p.request.postData ? p.request.postData.slice(0, 100_000) : null,
    body_state: "pending", redirect_from: redirectFrom, action_id: actionId, attribution, write_kind: a.writeKind,
  });
  const inf: InflightRequest = { id, targetId: t.targetId, frameId: p.frameId ?? null, url: p.request.url, family: a.family, tStart, actionId, attribution, resourceType: p.type, method: p.request.method, writeKind: a.writeKind };
  d.inflight.set(id, inf);
  d.capMap(d.reqAlias); d.capMap(d.redirectCount as Map<string, unknown>); d.capMap(d.wsUrls); // review F12
  d.publish({ kind: "request", t: tStart, targetId: t.targetId, frameId: p.frameId, actionId, ref: id, summary: { m: p.request.method, u: short(p.request.url), f: a.family, a: attribution, rt: p.type, ...(a.writeKind !== "read" ? { w: a.writeKind } : {}) } });
}

function onResponse(d: Daemon, t: TargetState, p: ResponseReceived) {
  const id = d.reqAlias.get(p.requestId) ?? p.requestId;
  const at = d.monoToT(p.timestamp);
  const r = p.response;
  const inf = d.inflight.get(id);
  const streaming = p.type === "EventSource" || /event-stream/i.test(r.mimeType ?? "");
  if (inf) { inf.mime = r.mimeType; inf.status = r.status; inf.streaming = streaming; }
  d.store.update("requests", { t_response: at, status: r.status, status_text: r.statusText, mime: r.mimeType, resp_headers: JSON.stringify(r.headers ?? {}), from_cache: r.fromDiskCache ? 1 : 0, ...(streaming ? { body_state: "streaming" } : {}) }, "id=?", [id]);
  if (streaming && inf) {
    // Streaming requests never "finish"; for settlement purposes they are done once headers arrive.
    d.inflight.delete(id);
    d.publish({ kind: "response", t: at, targetId: t.targetId, actionId: inf.actionId, ref: id, summary: { s: r.status, u: short(inf.url), ms: Math.round(at - inf.tStart), a: inf.attribution, streaming: true } });
  }
  if (inf && !streaming) armStallTimer(d, t, inf);
  // Any non-ambient 4xx/5xx on a scoped target fires the error sentinel — including between-action
  // failures (delayed async validations, optimistic-UI status checks): DECISIONS #24, GUIDANCE §8.
  if (r.status >= 400 && inf && inf.attribution !== "ambient") {
    void fireSentinel(d, t, "error", { status: r.status, url: short(inf.url), method: inf.method, request: id }, { t: at });
  }
}

/** Unread-body demotion (DECISIONS #22): headers arrived, then silence — the page never consumed the
 *  body, so loadingFinished may never come. Release the request from settlement; keep it inflight for
 *  the eventual (possible) completion. */
function armStallTimer(d: Daemon, t: TargetState, inf: InflightRequest) {
  if (inf.stallTimer) clearTimeout(inf.stallTimer);
  inf.stallTimer = setTimeout(async () => {
    if (!d.inflight.has(inf.id) || inf.stalled) return;
    inf.stalled = true;
    const at = d.now();
    // The body may already be buffered even though the page never read it — try before giving up
    // (dry-run friction #5: a 401 body is premium discovery data).
    try {
      const res = await d.send<{ body: string; base64Encoded: boolean }>(t, "Network.getResponseBody", { requestId: inf.id.split(":")[0] });
      const bytes = res.base64Encoded ? Buffer.from(res.body, "base64") : new TextEncoder().encode(res.body);
      const stored = d.store.storeBody(new Uint8Array(bytes), inf.mime ?? null);
      d.store.update("requests", { body_hash: stored.hash, resp_size: stored.size, body_state: "unread" }, "id=? AND t_end IS NULL", [inf.id]);
    } catch { d.store.update("requests", { body_state: "unread" }, "id=? AND t_end IS NULL", [inf.id]); }
    d.publish({ kind: "response", t: at, targetId: t.targetId, actionId: inf.actionId, ref: inf.id, summary: { s: inf.status, u: short(inf.url), a: inf.attribution, stalled: true, bs: "unread" } });
    setTimeout(() => { d.inflight.delete(inf.id); }, defaults.stalledEvictMs); // review F4: do not haunt diagnoses forever
  }, defaults.unreadBodyGraceMs);
}

async function onFinished(d: Daemon, t: TargetState, p: LoadingFinished) {
  const id = d.reqAlias.get(p.requestId) ?? p.requestId;
  const at = d.monoToT(p.timestamp);
  const inf = d.inflight.get(id);
  if (inf?.stallTimer) clearTimeout(inf.stallTimer);
  const patch: Record<string, unknown> = { t_end: at, encoded_size: p.encodedDataLength };
  let size: number | null = null;
  if (inf?.streaming) {
    patch.body_state = "streaming";
  } else if (inf?.method === "HEAD" || inf?.status === 204 || inf?.status === 304) {
    patch.body_state = "none";
  } else if (p.encodedDataLength > defaults.bodyBlobCap) {
    patch.body_state = "truncated";
  } else {
    try {
      const res = await d.send<{ body: string; base64Encoded: boolean }>(t, "Network.getResponseBody", { requestId: p.requestId });
      const bytes = res.base64Encoded ? Buffer.from(res.body, "base64") : new TextEncoder().encode(res.body);
      const stored = d.store.storeBody(new Uint8Array(bytes), inf?.mime ?? null);
      patch.body_hash = stored.hash; patch.resp_size = stored.size; patch.body_state = stored.truncated ? "truncated" : "ok";
      size = stored.size;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      patch.body_state = /No data found/i.test(m) ? "none" : /No resource with given identifier|Target closed|closed/i.test(m) ? "evicted" : "error";
      if (patch.body_state === "error") patch.error = m.slice(0, 200);
    }
  }
  d.store.update("requests", patch, "id=?", [id]);
  d.attrib.observeEnd(id, at);
  if (inf) {
    d.inflight.delete(id);
    d.publish({ kind: "response", t: at, targetId: t.targetId, actionId: inf.actionId, ref: id, summary: { s: inf.status, u: short(inf.url), mime: inf.mime, size, ms: Math.round(at - inf.tStart), a: inf.attribution, body: patch.body_hash ?? null, bs: patch.body_state } });
  }
}

function onFailed(d: Daemon, t: TargetState, p: LoadingFailed) {
  const id = d.reqAlias.get(p.requestId) ?? p.requestId;
  const at = d.monoToT(p.timestamp);
  const inf0 = d.inflight.get(id); if (inf0?.stallTimer) clearTimeout(inf0.stallTimer);
  d.store.update("requests", { t_end: at, error: p.errorText, body_state: p.canceled ? "none" : "error" }, "id=?", [id]);
  d.attrib.observeEnd(id, at);
  const inf = d.inflight.get(id);
  if (inf) {
    d.inflight.delete(id);
    d.publish({ kind: "response", t: at, targetId: t.targetId, actionId: inf.actionId, ref: id, summary: { u: short(inf.url), ms: Math.round(at - inf.tStart), a: inf.attribution, error: p.errorText, canceled: !!p.canceled } });
    if (!p.canceled && inf.attribution !== "ambient") void fireSentinel(d, t, "error", { url: short(inf.url), method: inf.method, error: p.errorText, request: id }, { t: at });
  }
}

function onWsFrame(d: Daemon, t: TargetState, p: WebSocketFrame, dir: "in" | "out") {
  const at = d.monoToT(p.timestamp);
  const payload = p.response.payloadData ?? "";
  const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
  const seq = d.store.insert("ws_frames", { ws_id: p.requestId, t: at, dir, opcode: p.response.opcode, size: payload.length, payload: payload.slice(0, defaults.wsPayloadCap), action_id: actionId });
  d.publish({ kind: "ws_frame", t: at, targetId: t.targetId, actionId, ref: seq, summary: { dir, size: payload.length, preview: payload.slice(0, 80), ws: short(d.wsUrls.get(p.requestId) ?? p.requestId, 60) } });
}

export function short(u: string | undefined, n = 120): string { if (!u) return ""; return u.length > n ? u.slice(0, n - 1) + "…" : u; }
export { isTextual };
