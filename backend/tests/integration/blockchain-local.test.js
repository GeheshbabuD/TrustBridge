import test from "node:test";
import assert from "node:assert/strict";
import ganache from "ganache";
import solc from "solc";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createEthersBlockchainAdapter } from "../../src/services/ethers-blockchain.adapter.js";

const contractPath = fileURLToPath(new URL("../../contracts/TrustBridgeEventAnchor.sol", import.meta.url));

const compile = (source) => {
  const input = { language: "Solidity", sources: { "TrustBridgeEventAnchor.sol": { content: source } }, settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const failures = (output.errors ?? []).filter((item) => item.severity === "error");
  assert.deepEqual(failures, []);
  return output.contracts["TrustBridgeEventAnchor.sol"].TrustBridgeEventAnchor;
};

const freePort = async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
};

const startChain = async () => {
  const chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { deterministic: true } });
  const port = await freePort();
  await new Promise((resolve, reject) => chain.listen(port, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  return { chain, rpcUrl: `http://127.0.0.1:${port}` };
};

test("Ethers adapter anchors hash-only events on an isolated ephemeral local EVM and reconciles finality", async (t) => {
  const { chain, rpcUrl } = await startChain();
  const provider = new JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true });
  t.after(async () => { await provider.destroy(); await chain.close(); });
  const accounts = Object.values(chain.provider.getInitialAccounts());
  const signer = new Wallet(accounts[0].secretKey, provider);
  const artifact = compile(await readFile(contractPath, "utf8"));
  const deployed = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy();
  await deployed.waitForDeployment();
  const contractAddress = await deployed.getAddress();
  const adapter = createEthersBlockchainAdapter({ rpcUrl, chainId: 1337, contractAddress, signer, confirmations: 1 });
  const operationKey = `0x${"11".repeat(32)}`;
  const eventHash = `0x${"22".repeat(32)}`;
  const submitted = await adapter.submitAnchor({ operationKey, eventHash });
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(String(await deployed.getEventHash(operationKey)), eventHash);
  const reconciled = await adapter.reconcile({ operationKey, eventHash, ...submitted });
  assert.equal(reconciled.status, "CONFIRMED");
  assert.equal((await adapter.submitAnchor({ operationKey, eventHash })).status, "SUBMITTED", "same operation key is idempotent and remains subject to reconciliation");
  await assert.rejects(adapter.submitAnchor({ operationKey, eventHash: `0x${"33".repeat(32)}` }), { code: "BLOCKCHAIN_IDEMPOTENCY_CONFLICT" });
});

test("prototype contract denies an unauthorized signer and rejects operation-key substitution", async (t) => {
  const { chain, rpcUrl } = await startChain();
  const provider = new JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true });
  t.after(async () => { await provider.destroy(); await chain.close(); });
  const accounts = Object.values(chain.provider.getInitialAccounts());
  const owner = new Wallet(accounts[0].secretKey, provider);
  const other = new Wallet(accounts[1].secretKey, provider);
  const artifact = compile(await readFile(contractPath, "utf8"));
  const deployed = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy();
  await deployed.waitForDeployment();
  const key = `0x${"44".repeat(32)}`;
  const hash = `0x${"55".repeat(32)}`;
  await assert.rejects(deployed.connect(other).anchor(key, hash));
  await deployed.anchor(key, hash);
  await assert.rejects(deployed.anchor(key, `0x${"66".repeat(32)}`));
});
