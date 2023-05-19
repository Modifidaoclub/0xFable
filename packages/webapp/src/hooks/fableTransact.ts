import { type TransactionReceipt } from "viem"

import { deployment } from "src/deployment"
import { cardsCollectionABI, deckAirdropABI, gameABI, inventoryABI } from "src/generated"
import { useEvents, useRead, UseReadResult, useWrite, UseWriteResult } from "src/hooks/transact"
import { type Hash } from "src/types"

// =================================================================================================
// use<Contract>Write: just `useWrite` with the contract address and ABI already set.

export type UseContractSpecificWriteParams = {
  functionName: string,
  args?: any[],
  onWrite?: () => void,
  onSigned?: (data: { hash: Hash }) => void,
  onSuccess?: (data: TransactionReceipt) => void,
  onError?: (err: Error) => void,
  setLoading?: (string) => void,
  enabled?: boolean
}

// -------------------------------------------------------------------------------------------------

export function useGameWrite(params: UseContractSpecificWriteParams): UseWriteResult {
  try {
    return useWrite({...params, contract: deployment.Game, abi: gameABI})
  } catch (e) {
    return { write: null }
  }
}

// -------------------------------------------------------------------------------------------------

export function useCardsCollectionWrite(params: UseContractSpecificWriteParams): UseWriteResult {
  try {
    return useWrite({...params, contract: deployment.CardsCollection, abi: cardsCollectionABI})
  } catch (e) {
    return { write: null }
  }
}

// -------------------------------------------------------------------------------------------------

export function useInventoryWrite(params: UseContractSpecificWriteParams): UseWriteResult {
  try {
    return useWrite({...params, contract: deployment.Inventory, abi: inventoryABI})
  } catch (e) {
    return { write: null }
  }
}

// -------------------------------------------------------------------------------------------------

export function useDeckAirdropWrite(params: UseContractSpecificWriteParams): UseWriteResult {
  try {
    return useWrite({...params, contract: deployment.DeckAirdrop, abi: deckAirdropABI})
  } catch (e) {
    return { write: null }
  }
}

// =================================================================================================
// use<Contract>Read: just `useRead` with the contract address and ABI already set.

export type UseContractSpecificReadParams = {
  functionName: string,
  args?: any[],
  // TODO type is wrong
  onSuccess?: (data: TransactionReceipt) => void,
  onError?: (err: Error) => void,
  enabled?: boolean
}

export function useGameRead<T>(params: UseContractSpecificReadParams): UseReadResult<T> {
  return useRead({ ...params, contract: deployment.Game, abi: gameABI })
}

// =================================================================================================
// use<Contract>Events: just `useEvents` with the contract address and ABI already set.

export function useGameEvents(eventNames, listener) {
  return useEvents(deployment.Game, gameABI, eventNames, listener)
}

// =================================================================================================



// =================================================================================================