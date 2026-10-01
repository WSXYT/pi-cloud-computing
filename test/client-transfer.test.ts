import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import test from "node:test";
import { CloudConnection, CloudRequestError } from "../src/client-network.js";
import { ensureSelfSignedCertificate } from "../src/worker/tls.js";

for (const scenario of ["cancel", "response-timeout"] as const) {
  test(`upload ${scenario} reports actual phase and bounded socket progress`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-transfer-"));
    const tls = await ensureSelfSignedCertificate(root, "127.0.0.1");
    const server = createServer({ key: tls.privateKey, cert: tls.certificate }, req => { req.on("error", () => {}); req.resume(); });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    const original = TLSSocket.prototype.setTimeout;
    t.mock.method(TLSSocket.prototype, "setTimeout", function(this: TLSSocket, ms: number, callback?: () => void) {
      return original.call(this, ms === 30_000 ? 250 : ms, callback);
    });
    const connection = new CloudConnection(`https://127.0.0.1:${address.port}`, tls.fingerprint, "fixture");
    const controller = new AbortController();
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    await assert.rejects(connection.upload("transfer", data, "application/octet-stream", controller.signal, p => {
      if (scenario === "cancel" && p.sentBytes > 0) controller.abort();
    }), (error: unknown) => {
      assert.ok(error instanceof CloudRequestError);
      assert.equal(error.progress.operation, "artifact_upload");
      assert.equal(error.progress.totalBytes, data.length);
      assert.equal(error.progress.receivedBytes, 0);
      if (scenario === "cancel") {
        assert.equal(error.code, "CLOUD_CANCELLED");
        assert.equal(error.progress.phase, "upload");
        assert.equal(error.progress.sentBytes, 64 * 1024);
      } else {
        assert.equal(error.code, "HTTP_RESPONSE_TIMEOUT");
        assert.equal(error.progress.phase, "response");
        assert.equal(error.progress.sentBytes, data.length, "body was sent; timeout was waiting for acknowledgement, not an oversized upload");
      }
      return true;
    });
  });
}
