// main.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const kv = await Deno.openKv();

// generate short code
function genCode(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

serve(async (req) => {
  const url = new URL(req.url);

  // Homepage info
  if (url.pathname === "/") {
    return new Response(
      "Deno Proxy Shortlink\n\nCreate: /new?url=<encoded url>\nUse proxied URL: /p/<code>",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Create new mapping: /new?url=https://...
  if (url.pathname === "/new") {
    const long = url.searchParams.get("url");
    if (!long) return new Response("Missing ?url=", { status: 400 });
    if (!/^https?:\/\//.test(long)) return new Response("URL must start with http:// or https://", { status: 400 });

    // generate unique code
    let code: string;
    let tries = 0;
    do {
      code = genCode(6);
      const ex = await kv.get(["proxy", code]);
      if (!ex.value) break;
      tries++;
    } while (tries < 20);

    await kv.set(["proxy", code], { url: long, created: Date.now() });
    const host = url.host;
    return new Response(`https://${host}/p/${code}`, { headers: { "content-type": "text/plain" } });
  }

  // optional: list mappings (admin) - remove or protect in production
  if (url.pathname === "/list") {
    const lines: string[] = [];
    for await (const e of kv.list({ prefix: ["proxy"] })) {
      lines.push(`${e.key[1]} -> ${(e.value as any).url}`);
    }
    return new Response(lines.join("\n") || "No links", { headers: { "content-type": "text/plain" } });
  }

  // Proxy route: /p/<code>
  if (url.pathname.startsWith("/p/")) {
    const code = url.pathname.split("/")[2];
    if (!code) return new Response("Missing code", { status: 400 });

    const record = await kv.get(["proxy", code]);
    if (!record.value) return new Response("Not found", { status: 404 });

    const target = (record.value as any).url as string;

    // Validate allowed scheme
    if (!/^https?:\/\//.test(target)) return new Response("Invalid target URL", { status: 400 });

    // Forward Range header for seeking (video)
    const range = req.headers.get("range");
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = range;

    // Optional: set a safer User-Agent/Referer to mimic a browser
    headers["User-Agent"] = "Mozilla/5.0 (compatible; DenoProxy/1.0)";
    // follow redirects (default fetch follows) and stream body
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(target, {
        method: "GET",
        headers,
        redirect: "follow",
      });
    } catch (err) {
      return new Response("Upstream fetch failed", { status: 502 });
    }

    // If upstream rejected or error
    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      return new Response(`Upstream error: ${upstreamResp.status}`, { status: 502 });
    }

    // Prepare response headers to client
    const respHeaders = new Headers();
    const ct = upstreamResp.headers.get("content-type") ?? "application/octet-stream";
    respHeaders.set("Content-Type", ct);

    const cl = upstreamResp.headers.get("content-length");
    if (cl) respHeaders.set("Content-Length", cl);

    const acceptRanges = upstreamResp.headers.get("accept-ranges");
    if (acceptRanges) respHeaders.set("Accept-Ranges", acceptRanges);

    const contentRange = upstreamResp.headers.get("content-range");
    if (contentRange) respHeaders.set("Content-Range", contentRange);

    // prevent caching by default
    respHeaders.set("Cache-Control", "no-store");

    // CORS if needed
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Range");

    // Stream upstream body directly back
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  return new Response("Not found", { status: 404 });
});
