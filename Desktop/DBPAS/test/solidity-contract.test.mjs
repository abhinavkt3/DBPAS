import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import solc from "solc";

const contractPath = path.join(
  process.cwd(),
  "chaincode",
  "solidity-dbpas",
  "DBPASProduct.sol"
);

test("compiles the revised DBPAS Solidity contract and exposes the expected API", () => {
  const source = fs.readFileSync(contractPath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      "DBPASProduct.sol": {
        content: source
      }
    },
    settings: {
      optimizer: {
        enabled: false
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");

  assert.deepEqual(
    errors.map((entry) => entry.formattedMessage),
    []
  );

  const contract = output.contracts["DBPASProduct.sol"]?.DBPASProduct;
  assert.ok(contract, "DBPASProduct contract should be present in compiler output");
  assert.ok(
    contract.evm.bytecode.object.length > 0,
    "Compiled bytecode should not be empty"
  );

  const abiFunctions = contract.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name);

  for (const expected of [
    "registerProduct",
    "atomicCheckpoint",
    "verifyProduct",
    "getProductAsset",
    "getOwnerHistory",
    "transferFrom",
    "safeTransferFrom"
  ]) {
    assert.ok(
      abiFunctions.includes(expected),
      `Expected Solidity ABI to include ${expected}`
    );
  }
});
