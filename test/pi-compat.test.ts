import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { MIN_PI_VERSION, supportsPiVersion } from "../src/version.js";
import { assertSdkCapabilities, assertUiAdapterCapabilities } from "../src/worker/sdk-compat.js";

test("Pi minimum version admits newer stable releases, not an exact-version whitelist", () => {
  assert.equal(MIN_PI_VERSION, "0.85.1");
  for (const version of ["0.85.1", "0.85.2", "0.86.0", "1.0.0", "2.0.0", "1.0.0+build.7"]) assert.ok(supportsPiVersion(version), version);
  for (const version of ["0.84.99", "0.85.0", "1.0.0-rc.1", "01.0.0", "1.0", "v1.0.0", "1.0.0 junk", "", undefined, 1, "999999999999999999999.0.0"]) assert.equal(supportsPiVersion(version), false, String(version));
});

test("SDK capability gate accepts installed Pi and diagnoses removed APIs", () => {
  assertSdkCapabilities(sdk);
  assert.throws(() => assertSdkCapabilities({ ...sdk, createAgentSessionServices: undefined }), /CLOUD_SDK_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertSdkCapabilities({ ...sdk, AgentSession: class {} }), /CLOUD_SDK_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertUiAdapterCapabilities({}, {}, {}), /CLOUD_SDK_UI_ADAPTER_UNAVAILABLE/);
});
