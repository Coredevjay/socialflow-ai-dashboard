/**
 * WalletService - Manages wallet connections and transactions
 */

import { StrKey } from '@stellar/stellar-sdk';
import { NETWORKS, NetworkConfig } from '../config/networks';

export interface WalletInfo {
  publicKey: string;
  name: string;
  isConnected: boolean;
}

export interface WalletDisconnectEvent {
  type: 'disconnect';
  timestamp: number;
}

type DisconnectListener = (event: WalletDisconnectEvent) => void;

/** Subset of the injected Freighter API used by this service */
interface FreighterApi {
  getPublicKey(): Promise<string>;
  getNetworkDetails?(): Promise<{ networkPassphrase: string }>;
  signTransaction(xdr: string, opts: { network: string }): Promise<string>;
  on?(event: string, handler: () => void): void;
}

/** Subset of the injected Albedo API used by this service */
interface AlbedoApi {
  publicKey(): Promise<{ publicKey: string }>;
  tx(params: { xdr: string; network: string }): Promise<{ signed_envelope_xdr: string }>;
}

type WalletWindow = Window & { freighter?: FreighterApi; albedo?: AlbedoApi };

const getFreighter = (): FreighterApi | undefined => (window as WalletWindow).freighter;
const getAlbedo = (): AlbedoApi | undefined => (window as WalletWindow).albedo;

/** Wallet-reported keys are untrusted input: only accept well-formed Stellar account addresses */
function assertValidPublicKey(key: unknown): string {
  if (typeof key !== 'string' || !StrKey.isValidEd25519PublicKey(key)) {
    throw new Error('Wallet returned an invalid Stellar public key');
  }
  return key;
}

/** Resolve a lowercase network name (e.g. "testnet") to its configured Stellar network */
function resolveNetwork(network: string): NetworkConfig {
  const config = NETWORKS[network.toUpperCase()];
  if (!config) {
    throw new Error(`Unsupported Stellar network: ${network}`);
  }
  return config;
}

export class WalletService {
  private wallet: WalletInfo | null = null;
  private disconnectListeners: Set<DisconnectListener> = new Set();
  private isListeningForDisconnect = false;
  /** Bound reference to the visibilitychange handler — stored so we can removeEventListener later */
  private boundVisibilityHandler: (() => void) | null = null;

  /**
   * Auto-connect to available wallet
   */
  async autoConnect(): Promise<WalletInfo | null> {
    try {
      // Try Freighter first
      const freighter = getFreighter();
      if (freighter) {
        const publicKey = assertValidPublicKey(await freighter.getPublicKey());
        this.wallet = {
          publicKey,
          name: 'Freighter',
          isConnected: true,
        };
        this.setupDisconnectListener();
        return this.wallet;
      }

      // Try Albedo
      const albedo = getAlbedo();
      if (albedo) {
        const result = await albedo.publicKey();
        this.wallet = {
          publicKey: assertValidPublicKey(result.publicKey),
          name: 'Albedo',
          isConnected: true,
        };
        this.setupDisconnectListener();
        return this.wallet;
      }

      return null;
    } catch (error) {
      console.error('Failed to auto-connect wallet:', error);
      return null;
    }
  }

  /**
   * Setup listener for wallet disconnection events
   */
  private setupDisconnectListener(): void {
    if (this.isListeningForDisconnect) return;

    this.isListeningForDisconnect = true;

    // Listen for Freighter disconnect
    getFreighter()?.on?.('disconnect', () => {
      this.handleDisconnect();
    });

    // Store the bound handler so it can be removed in disconnect()
    this.boundVisibilityHandler = () => {
      if (document.hidden === false) {
        this.checkWalletConnection();
      }
    };

    // Listen for visibility changes (user may switch wallets)
    window.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  /**
   * Check if wallet is still connected
   */
  private async checkWalletConnection(): Promise<void> {
    if (!this.wallet) return;

    try {
      const freighter = getFreighter();
      if (freighter) {
        const publicKey = await freighter.getPublicKey();
        if (publicKey !== this.wallet.publicKey) {
          this.handleDisconnect();
        }
      }
    } catch (error) {
      this.handleDisconnect();
    }
  }

  /**
   * Handle wallet disconnection
   */
  private handleDisconnect(): void {
    if (!this.wallet) return;

    const event: WalletDisconnectEvent = {
      type: 'disconnect',
      timestamp: Date.now(),
    };

    this.wallet = null;
    this.disconnectListeners.forEach(listener => listener(event));

    // Remove the visibilitychange listener to prevent leaks
    if (this.boundVisibilityHandler) {
      window.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    this.isListeningForDisconnect = false;
  }

  /**
   * Sign a transaction
   */
  async signTransaction(xdr: string, network: string): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not connected');
    }

    try {
      const freighter = getFreighter();
      if (freighter) {
        // Refuse to sign unless the wallet is on the same network we are targeting
        const expected = resolveNetwork(network);
        const details = await freighter.getNetworkDetails?.();
        if (details?.networkPassphrase !== expected.networkPassphrase) {
          throw new Error(`Wallet network does not match ${expected.name}`);
        }

        return await freighter.signTransaction(xdr, {
          network,
        });
      }

      const albedo = getAlbedo();
      if (albedo) {
        resolveNetwork(network);
        const result = await albedo.tx({
          xdr,
          network,
        });
        return result.signed_envelope_xdr;
      }

      throw new Error('No wallet available for signing');
    } catch (error) {
      // Check if disconnection caused the error
      if (error instanceof Error && error.message.includes('disconnect')) {
        this.handleDisconnect();
      }
      throw error;
    }
  }

  /**
   * Subscribe to disconnect events
   */
  onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  /**
   * Disconnect wallet
   */
  disconnect(): void {
    // Remove the visibilitychange listener to prevent leaks
    if (this.boundVisibilityHandler) {
      window.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    this.wallet = null;
    this.isListeningForDisconnect = false;
  }

  /**
   * Get current wallet info
   */
  getWallet(): WalletInfo | null {
    return this.wallet;
  }

  /**
   * Check if wallet is connected
   */
  isConnected(): boolean {
    return this.wallet !== null;
  }
}

export const walletService = new WalletService();
