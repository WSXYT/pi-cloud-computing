import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLocale,
  MESSAGE_KEYS,
  resolveLocale,
  translate,
} from "../src/i18n.js";

test("keeps Chinese and English catalogs in parity", () => {
  assert.equal(MESSAGE_KEYS.length, 38);
  for (const key of MESSAGE_KEYS) {
    assert.notEqual(translate("zh-CN", key), "");
    assert.notEqual(translate("en", key), "");
  }
});

test("resolves locale aliases and falls back to English", () => {
  assert.equal(resolveLocale("zh_CN"), "zh-CN");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("fr-FR"), "en");
  assert.equal(detectLocale(undefined, { LANG: "zh_CN.UTF-8" }), "zh-CN");
});

test("interpolates structured parameters", () => {
  assert.equal(
    translate("en", "task.submitted", { address: "10.0.0.1:9443" }),
    "Task submitted to 10.0.0.1:9443",
  );
});
