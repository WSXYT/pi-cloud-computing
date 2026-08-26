import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shell installer guides language, role, IP, Pi reuse, and pairing", async () => {
  const script = await readFile("scripts/install.sh", "utf8");
  assert.match(script, /选择语言 \/ Choose language/);
  assert.match(script, /What do you want to install/);
  assert.match(script, /Found existing Pi/);
  assert.match(script, /api\.ipify\.org/);
  assert.match(script, /pair-command=/);
  assert.match(script, /Copy the complete \/cloud-pair line/);
});

test("PowerShell installer reuses Pi and configures the selected language", async () => {
  const script = await readFile("scripts/install.ps1", "utf8");
  assert.match(script, /Get-Command pi/);
  assert.match(script, /Found existing Pi/);
  assert.match(script, /state\.locale = \$Language/);
  assert.match(script, /输入 \/cloud/);
});
