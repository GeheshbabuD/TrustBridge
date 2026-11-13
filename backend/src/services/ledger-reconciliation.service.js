import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

const unavailable = () => new ApiError(503, "LEDGER_RECONCILIATION_UNAVAILABLE", "Ledger reconciliation is temporarily unavailable");

const addIssue = (counts, code) => { counts[code] = (counts[code] ?? 0) + 1; };
const liabilityDelta = (entries) => entries.reduce((total, entry) => {
  if (entry.account?.accountCode !== "ESCROW_LIABILITY") return total;
  const amount = BigInt(entry.amountMinor);
  return total + (entry.direction === "CREDIT" ? amount : entry.direction === "DEBIT" ? -amount : 0n);
}, 0n);

export const evaluateEscrowLedgerSnapshot = ({ transaction, escrow, ledgerAccounts = [], ledgerJournals = [], escrowOperations = [] }) => {
  const issueCounts = {};
  const liabilityAccounts = ledgerAccounts.filter((account) => account.accountCode === "ESCROW_LIABILITY" && (!escrow || account.escrowId === escrow.id));

  if (!escrow) {
    if (["FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED", "RELEASE_PENDING", "REFUND_PENDING", "COMPLETED", "REFUNDED"].includes(transaction.status)) addIssue(issueCounts, "ESCROW_RECORD_MISSING");
    if (ledgerJournals.length || liabilityAccounts.length) addIssue(issueCounts, "LEDGER_WITHOUT_ESCROW_RECORD");
  }

  let ledgerLiabilityBalance = 0n;
  for (const account of liabilityAccounts) {
    if (account.accountType !== "LIABILITY" || account.currency.trim() !== transaction.currency.trim()) addIssue(issueCounts, "ESCROW_LIABILITY_ACCOUNT_MISMATCH");
    for (const entry of account.entries ?? []) {
      if (entry.transactionId !== transaction.id || entry.currency.trim() !== transaction.currency.trim()) addIssue(issueCounts, "LEDGER_ENTRY_SCOPE_MISMATCH");
      const amount = BigInt(entry.amountMinor);
      if (amount <= 0n) addIssue(issueCounts, "NON_POSITIVE_LEDGER_ENTRY");
      if (entry.direction === "CREDIT") ledgerLiabilityBalance += amount;
      else if (entry.direction === "DEBIT") ledgerLiabilityBalance -= amount;
      else addIssue(issueCounts, "INVALID_LEDGER_DIRECTION");
    }
  }

  const journalById = new Map();
  const journalOperationCounts = new Map();
  for (const journal of ledgerJournals) {
    journalById.set(journal.id, journal);
    journalOperationCounts.set(journal.operationId, (journalOperationCounts.get(journal.operationId) ?? 0) + 1);
    const entries = journal.entries ?? [];
    if (entries.length < 2) addIssue(issueCounts, "JOURNAL_MISSING_ENTRIES");
    let debits = 0n; let credits = 0n;
    const lineSignatures = new Set();
    for (const entry of entries) {
      const amount = BigInt(entry.amountMinor);
      if (amount <= 0n) addIssue(issueCounts, "NON_POSITIVE_LEDGER_ENTRY");
      const lineSignature = `${entry.accountId ?? entry.account?.accountCode ?? "?"}:${entry.direction}:${amount}`;
      if (lineSignatures.has(lineSignature)) addIssue(issueCounts, "DUPLICATE_JOURNAL_ENTRY");
      lineSignatures.add(lineSignature);
      if (entry.direction === "DEBIT") debits += amount;
      else if (entry.direction === "CREDIT") credits += amount;
      else addIssue(issueCounts, "INVALID_LEDGER_DIRECTION");
      if (entry.transactionId !== transaction.id || entry.currency.trim() !== journal.currency.trim() || journal.currency.trim() !== transaction.currency.trim()) addIssue(issueCounts, "JOURNAL_SCOPE_MISMATCH");
    }
    if (debits !== credits) addIssue(issueCounts, "UNBALANCED_JOURNAL");
  }
  if ([...journalOperationCounts.values()].some((count) => count > 1)) addIssue(issueCounts, "DUPLICATE_JOURNAL_OPERATION_ID");

  if (escrow) {
    if (escrow.balanceMinor < 0n) addIssue(issueCounts, "NEGATIVE_ESCROW_BALANCE");
    if (escrow.balanceMinor !== ledgerLiabilityBalance) addIssue(issueCounts, "ESCROW_LEDGER_BALANCE_MISMATCH");
    if (escrow.balanceMinor > 0n && liabilityAccounts.length === 0) addIssue(issueCounts, "ESCROW_LIABILITY_ACCOUNT_MISSING");
    if (["UNFUNDED", "RELEASED", "REFUNDED"].includes(escrow.status) && escrow.balanceMinor !== 0n) addIssue(issueCounts, "ESCROW_STATUS_BALANCE_MISMATCH");
    if (escrow.status === "FUNDED" && escrow.balanceMinor <= 0n) addIssue(issueCounts, "ESCROW_STATUS_BALANCE_MISMATCH");
    const expectedTransactionStates = {
      UNFUNDED: ["AWAITING_PAYMENT"],
      FUNDED: ["FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED"],
      RELEASE_PENDING: ["RELEASE_PENDING"],
      REFUND_PENDING: ["REFUND_PENDING"],
      RELEASED: ["COMPLETED"],
      REFUNDED: ["REFUNDED"],
    };
    if (!expectedTransactionStates[escrow.status]?.includes(transaction.status)) addIssue(issueCounts, "TRANSACTION_ESCROW_STATUS_MISMATCH");
  }

  const linkedJournals = new Set();
  const fundingAttempts = new Set();
  for (const operation of escrowOperations) {
    if (operation.type === "FUNDING" && operation.paymentAttemptId) {
      if (fundingAttempts.has(operation.paymentAttemptId)) addIssue(issueCounts, "DUPLICATE_FUNDING_OPERATION");
      fundingAttempts.add(operation.paymentAttemptId);
    }
    if (operation.status === "SUCCEEDED") {
      const journal = operation.ledgerJournalId ? journalById.get(operation.ledgerJournalId) : null;
      if (!journal) { addIssue(issueCounts, "SUCCEEDED_OPERATION_MISSING_JOURNAL"); continue; }
      linkedJournals.add(journal.id);
      if (journal.transactionId !== operation.transactionId || journal.currency.trim() !== operation.currency.trim()) addIssue(issueCounts, "OPERATION_JOURNAL_SCOPE_MISMATCH");
      const delta = liabilityDelta(journal.entries ?? []);
      const expectedDelta = operation.type === "FUNDING" ? BigInt(operation.amountMinor) : -BigInt(operation.amountMinor);
      if (delta !== expectedDelta) addIssue(issueCounts, "OPERATION_JOURNAL_AMOUNT_MISMATCH");
    } else if (operation.ledgerJournalId) addIssue(issueCounts, "NON_SUCCESS_OPERATION_HAS_JOURNAL");
  }
  for (const journal of ledgerJournals) if (!linkedJournals.has(journal.id)) addIssue(issueCounts, journal.reversalOfJournalId ? "REVERSAL_WITHOUT_ESCROW_OPERATION" : "JOURNAL_WITHOUT_ESCROW_OPERATION");
  for (const type of ["RELEASE", "REFUND"]) if (escrowOperations.filter((operation) => operation.type === type && operation.status === "SUCCEEDED").length > 1) addIssue(issueCounts, `DUPLICATE_SUCCESSFUL_${type}_OPERATION`);
  if (escrowOperations.filter((operation) => operation.type === "FUNDING" && operation.status === "SUCCEEDED").length > 1) addIssue(issueCounts, "DUPLICATE_SUCCESSFUL_FUNDING_OPERATION");

  const discrepancies = Object.entries(issueCounts).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
  return Object.freeze({
    transactionId: transaction.id,
    transactionStatus: transaction.status,
    escrowStatus: escrow?.status ?? null,
    currency: transaction.currency.trim(),
    escrowBalanceMinor: escrow?.balanceMinor.toString() ?? null,
    ledgerLiabilityBalanceMinor: ledgerLiabilityBalance.toString(),
    journalCount: ledgerJournals.length,
    operationCount: escrowOperations.length,
    status: discrepancies.length === 0 ? "CONSISTENT" : "DISCREPANCY",
    discrepancies,
  });
};

export const createLedgerReconciliationService = ({ getClient = getPrismaClient } = {}) => {
  const reconcileTransaction = async ({ transactionId }) => {
    const prisma = await getClient();
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const transaction = await tx.transaction.findUnique({
          where: { id: transactionId },
          select: {
            id: true, status: true, currency: true,
            escrow: { select: { id: true, status: true, balanceMinor: true, currency: true } },
            ledgerAccounts: { select: { id: true, escrowId: true, accountCode: true, accountType: true, currency: true, entries: { select: { transactionId: true, currency: true, amountMinor: true, direction: true } } } },
            ledgerJournals: { select: { id: true, transactionId: true, operationId: true, currency: true, reversalOfJournalId: true, entries: { select: { transactionId: true, currency: true, accountId: true, amountMinor: true, direction: true, account: { select: { accountCode: true } } } } } },
            escrowOperations: { select: { id: true, transactionId: true, type: true, status: true, paymentAttemptId: true, ledgerJournalId: true, amountMinor: true, currency: true } },
          },
        });
        if (!transaction) return { transactionId, status: "NOT_FOUND", discrepancies: [{ code: "TRANSACTION_NOT_FOUND", count: 1 }] };
        return evaluateEscrowLedgerSnapshot({ transaction, escrow: transaction.escrow, ledgerAccounts: transaction.ledgerAccounts, ledgerJournals: transaction.ledgerJournals, escrowOperations: transaction.escrowOperations });
      }, { isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };
  return Object.freeze({ reconcileTransaction });
};
