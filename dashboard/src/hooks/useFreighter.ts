"use client";
import { useCallback, useEffect, useState } from "react";
import {
  isConnected,
  getAddress,
  requestAccess,
  getNetwork,
} from "@stellar/freighter-api";
import { describeFreighterApiError } from "@/lib/actions/actionError";

export function useFreighter() {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const { isConnected: installed, error } = await isConnected();
      if (error || !installed) return;

      const { address: addr, error: addressError } = await getAddress();
      if (addressError || !addr) return;

      const { network: net, error: networkError } = await getNetwork();
      if (networkError || ignore) return;
      setConnected(true);
      setAddress(addr);
      setNetwork(net);
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const connect = useCallback(async () => {
    const { isConnected: installed, error } = await isConnected();
    if (error || !installed) {
      throw new Error("Freighter extension not installed. Install it from stellar.org/freighter.");
    }

    const { address: addr, error: accessError } = await requestAccess();
    if (accessError) {
      throw new Error(describeFreighterApiError(accessError).description);
    }

    const { network: net, error: networkError } = await getNetwork();
    if (networkError) {
      throw new Error(describeFreighterApiError(networkError).description);
    }
    setConnected(true);
    setAddress(addr);
    setNetwork(net);

    return addr;
  }, []);

  const disconnect = useCallback(() => {
    setConnected(false);
    setAddress(null);
    setNetwork(null);
  }, []);

  return { connected, address, network, connect, disconnect };
}
