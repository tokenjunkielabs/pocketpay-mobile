import { server } from '../../services/stellar';
import { useWalletStore, type TransactionRecord } from '../../store/walletStore';

export type TransactionHashStatus =
  | { status: 'confirmed'; transaction: any }
  | { status: 'failed'; transaction: any }
  | { status: 'unknown'; transaction: null };

const isNotFoundError = (error: any): boolean =>
  error?.response?.status === 404 || /not found/i.test(error?.message || '');

/**
 * Resolve one submitted Stellar transaction by transaction hash.
 *
 * Horizon's transaction endpoint is the authority for a known hash. A 404 is
 * intentionally treated as "unknown": it can mean the submission has not
 * reached/been indexed by Horizon yet and must never be converted into a
 * failed payment. Network/SDK errors are rethrown so the UI can keep the
 * existing local state and offer another explicit refresh.
 *
 * This is an explicit user-driven refresh, not a background poller. Callers
 * decide when to retry; there is no hidden interval, timeout loop, or forced
 * expiry of optimistic pending entries.
 */
export async function fetchTransactionStatusByHash(
  transactionHash: string
): Promise<TransactionHashStatus> {
  try {
    const transaction = await server
      .transactions()
      .transaction(transactionHash)
      .call();

    return transaction.successful === false
      ? { status: 'failed', transaction }
      : { status: 'confirmed', transaction };
  } catch (error: any) {
    if (isNotFoundError(error)) {
      return { status: 'unknown', transaction: null };
    }
    throw error;
  }
}

/**
 * Refresh a hash and reconcile any matching optimistic wallet-store entry only
 * after Horizon returns a definitive transaction result.
 */
export async function refreshTransactionStatus(
  transactionHash: string
): Promise<TransactionHashStatus> {
  const result = await fetchTransactionStatusByHash(transactionHash);
  if (result.status === 'unknown') return result;

  const confirmed = result.status === 'confirmed';
  const nextStatus: TransactionRecord['status'] = confirmed ? 'confirmed' : 'failed';

  useWalletStore.setState((state) => {
    const nextPending = { ...state.pendingTransactions };
    delete nextPending[transactionHash];

    const matchesHash = (tx: TransactionRecord) =>
      tx.id === transactionHash ||
      tx.hash === transactionHash ||
      tx.transaction_hash === transactionHash;

    return {
      pendingTransactions: nextPending,
      transactions: state.transactions.map((tx) =>
        matchesHash(tx)
          ? {
              ...tx,
              hash: tx.hash || transactionHash,
              status: nextStatus,
              is_pending: false,
              transaction_successful: confirmed,
            }
          : tx
      ),
    };
  });

  return result;
}
