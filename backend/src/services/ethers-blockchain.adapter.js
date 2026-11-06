import { Contract, JsonRpcProvider, isAddress, isHexString } from "ethers";

export const TRUSTBRIDGE_ANCHOR_ABI = Object.freeze([
  "function anchor(bytes32 operationKey, bytes32 eventHash)",
  "function getEventHash(bytes32 operationKey) view returns (bytes32)",
  "function writers(address) view returns (bool)",
  "event EventAnchored(bytes32 indexed operationKey, bytes32 indexed eventHash, address indexed submitter)",
]);

const validHash = (value) => typeof value === "string" && isHexString(`0x${value.replace(/^0x/, "")}`, 32);
const safeFailure = () => Object.assign(new Error("Blockchain provider operation failed"), { code: "BLOCKCHAIN_PROVIDER_FAILURE" });

/** Ethers v6 adapter. Signer is supplied by an external key-custody integration; no key is loaded here. */
export const createEthersBlockchainAdapter = ({ rpcUrl, chainId, contractAddress, signer, confirmations, providerFactory = (url, id) => new JsonRpcProvider(url, id, { staticNetwork: true }), contractFactory = (address, abi, runner) => new Contract(address, abi, runner), abi = TRUSTBRIDGE_ANCHOR_ABI } = {}) => {
  if (typeof rpcUrl !== "string" || !Number.isSafeInteger(chainId) || chainId < 1 || !isAddress(contractAddress) || contractAddress.toLowerCase() === `0x${"0".repeat(40)}` || !signer || typeof signer.getAddress !== "function" || !Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 256) throw new TypeError("Blockchain adapter configuration is incomplete");
  const provider = providerFactory(rpcUrl, chainId);
  const runner = typeof signer.connect === "function" ? signer.connect(provider) : signer;
  const contract = contractFactory(contractAddress, abi, runner);
  const hasAnchorLog = (receipt, operationKey, eventHash) => receipt.logs?.some((log) => {
    if (String(log.address).toLowerCase() !== contractAddress.toLowerCase()) return false;
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === "EventAnchored"
        && String(parsed.args.operationKey).toLowerCase() === operationKey.toLowerCase()
        && String(parsed.args.eventHash).toLowerCase() === eventHash.toLowerCase();
    } catch { return false; }
  }) === true;
  let verified = false;
  const verifyNetwork = async () => {
    if (verified) return;
    const [reportedChainId, code, signerAddress] = await Promise.all([provider.send("eth_chainId", []), provider.getCode(contractAddress), runner.getAddress()]);
    const authorizedWriter = await contract.writers(signerAddress);
    if (BigInt(reportedChainId) !== BigInt(chainId) || !code || code === "0x" || authorizedWriter !== true) throw safeFailure();
    verified = true;
  };
  const submitAnchor = async ({ operationKey, eventHash }) => {
    if (!validHash(operationKey) || !validHash(eventHash)) throw new TypeError("Invalid blockchain commitment");
    try {
      await verifyNetwork();
      const existing = await contract.getEventHash(operationKey);
      if (String(existing).toLowerCase() !== `0x${eventHash.replace(/^0x/, "").toLowerCase()}` && String(existing) !== `0x${"0".repeat(64)}`) throw Object.assign(new Error("Blockchain idempotency conflict"), { code: "BLOCKCHAIN_IDEMPOTENCY_CONFLICT" });
      const tx = await contract.anchor(operationKey, eventHash);
      if (!tx || typeof tx.hash !== "string" || typeof tx.wait !== "function") throw safeFailure();
      // Persist the transaction hash before waiting for confirmations; reconciliation owns finality.
      return { transactionHash: tx.hash, blockNumber: null, blockHash: null, status: "SUBMITTED" };
    } catch (error) {
      if (error?.code === "BLOCKCHAIN_IDEMPOTENCY_CONFLICT") throw error;
      throw safeFailure();
    }
  };
  const reconcile = async ({ operationKey, eventHash, transactionHash, blockNumber, blockHash }) => {
    if (!validHash(operationKey) || !validHash(eventHash)) throw new TypeError("Invalid blockchain commitment");
    try {
      await verifyNetwork();
      const anchored = await contract.getEventHash(operationKey);
      if (String(anchored).toLowerCase() !== `0x${eventHash.replace(/^0x/, "").toLowerCase()}`) return { status: "PENDING" };
      if (!transactionHash) return { status: "SUBMITTED" };
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt) return { status: "SUBMITTED", transactionHash };
      if (blockNumber !== null && blockNumber !== undefined && BigInt(receipt.blockNumber) !== BigInt(blockNumber)) return { status: "SUBMITTED", transactionHash };
      if (blockHash && receipt.blockHash.toLowerCase() !== blockHash.toLowerCase()) return { status: "SUBMITTED", transactionHash };
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block || block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: "SUBMITTED", transactionHash };
      // Avoid the provider's short-lived block-number cache when deciding confirmation depth.
      const head = Number(BigInt(await provider.send("eth_blockNumber", [])));
      if (head - receipt.blockNumber + 1 < confirmations) return { status: "SUBMITTED", transactionHash };
      if (receipt.status !== 1) return { status: "FAILED", transactionHash, blockNumber: BigInt(receipt.blockNumber), blockHash: receipt.blockHash, errorCode: "BLOCKCHAIN_TX_REVERTED" };
      if (!hasAnchorLog(receipt, operationKey, `0x${eventHash.replace(/^0x/, "")}`)) return { status: "SUBMITTED", transactionHash };
      return { status: "CONFIRMED", transactionHash, blockNumber: BigInt(receipt.blockNumber), blockHash: receipt.blockHash };
    } catch { throw safeFailure(); }
  };
  return Object.freeze({ submitAnchor, reconcile, verifyNetwork });
};
