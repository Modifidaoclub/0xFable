/**
 * Manages updates to the state so that the whole state is always consistent.
 *
 * @module store/update
 */

// =================================================================================================


import { getAccount, getNetwork, getPublicClient } from "wagmi/actions"

import { AccountResult, Address, chains, NetworkResult } from "src/chain"
import { subscribeToGame } from "src/store/subscriptions"
import * as store from "src/store/atoms"
import * as net from "src/store/network"
import { THROTTLED, ZOMBIE } from "src/utils/throttled-fetch"
import { formatTimestamp, parseBigInt } from "src/utils/js-utils"
import { GameStatus } from "src/store/types"
import { getBlock } from "viem/actions"
import { setError } from "src/store/actions"
import { getGameStatus } from "src/game/status"
import { contractWriteThrowing } from "src/actions/libContractWrite"
import { deployment } from "src/deployment"
import { gameABI } from "src/generated"
import { PROOF_CURVE_ORDER } from "src/game/constants"

// =================================================================================================
// CHANGE LISTENERS

/**
 * Called whenever the connected wallet address changes. Makes sure to clear the address if the
 * wallet is disconnected, as well as the game data.
 */
export function updatePlayerAddress(result: AccountResult) {
  const oldAddress = store.get(store.playerAddress)
  const newAddress = result.status === 'disconnected' || !isNetworkValid()
    ? null
    : (result.address || null) // undefined --> null

  if (oldAddress !== newAddress) {
    console.log(`player address changed from ${oldAddress} to ${newAddress}`)
    store.set(store.playerAddress, newAddress)

    // TODO the below should go away if we stop saving the gameID in browser storage and just fetch
    //      the gameID a player is in instead

    // The check is important: on a page load when already connected, the address will transition
    // from null to the connected address, and we don't want to throw away the game ID.
    //
    // If the old address is null, there is also nothing to reset (excepted at load).
    if (oldAddress !== null)
      // New player means current game & game data is stale, reset it.
      store.set(store.gameID, null)
  }
}

// -------------------------------------------------------------------------------------------------

/** Returns true if the network we are connected to is the one we support ({@link chains}). */
function isNetworkValid(network: NetworkResult = getNetwork()) {
  return chains.some(chain => chain.id === network.chain?.id)
}

// -------------------------------------------------------------------------------------------------

/**
 * Called whenever the network we are connected to changes. Makes sure to clear the game data if the
 * network is unsupported.
 */
export function updateNetwork(result: NetworkResult) {
  if (result.chain === undefined)
    console.log("disconnected from network")
  else
    console.log(`network changed to chain with ID ${result.chain?.id}`)

  if (!isNetworkValid(result))
    store.set(store.gameID, null) // resets all game data

  // Update player address, setting it or clearing it depending on whether the network is supported.
  // Note the account listener won't fire by itself because the address (wagmi-level) didn't change,
  // but our invariant is that is that playerAddress === null if not connected to a supported chain.
  updatePlayerAddress(getAccount())
}

// -------------------------------------------------------------------------------------------------

/**
 * Called whenever the game ID is updated. This clears the old game data (to avoid inconsistent
 * states), triggers a refresh of the game data, and makes sure we're subscribed to game updates.
 *
 * The game ID can be `null`, in which case there is no new subscription and no data refresh.
 *
 * This is called whenever the game ID changes (from actions in this tab or in other tabs), and
 * possibly when the game ID is loaded from storage at boot time.
 *
 * It never causes race conditions or weird data states: this resets all associated states, and if
 * a refresh lands with another ID, it will be ignored.
 */
export function gameIDListener(ID: bigint|null) {
  console.log(`transitioning to game ID ${ID}`)

  // avoid using inconsistent data
  store.set(store.gameData, null)
  store.set(store.cards, null)
  store.set(store.hasVisitedBoard, false)

  subscribeToGame(ID) // will unusubscribe if ID is null
  if (ID === null) return // no need to refresh data

  // We might be jumping into an in-progress game, so fetch cards.
  void refreshGameData()
}

// =================================================================================================
// REFRESH GAME DATA

// -------------------------------------------------------------------------------------------------

/**
 * Returns whether an update for the given gameID and player address is stale, i.e. if the current
 * store gameID and player address are different, meaning they change underneath the fetch and the
 * fetched data should be discarded.
 */
function isStaleVerbose(ID: bigint, player: Address): boolean {
  const storeID = store.get(store.gameID)
  const storePlayer = store.get(store.playerAddress)
  if (player !== storePlayer) {
    console.log(`Rejected stale data with player ${player} (current: ${storePlayer})`)
    return true
  }
  if (ID !== storeID) {
    console.log(`Rejected stale data with game ID ${ID} (current: ${storeID})`)
    return true
  }
  return false
}

// -------------------------------------------------------------------------------------------------

/**
 * Triggers a refresh of the game data, setting the {@link store.gameData} and {@link store.cards}
 * atoms. If the game ID or the player changes the while the refresh is in flight, the refresh is
 * ignored.
 *
 * If necessary, also fetches the cards.
 */
export async function refreshGameData() {
  const gameID = store.get(store.gameID)
  const player = store.get(store.playerAddress)
  let status = store.get(store.gameStatus)

  if (gameID === null) {
    console.error("refreshGameData called with null ID")
    return
  } else if (player === null) {
    console.error("refreshGameData called with null player")
    return
  }

  // Always fetch cards before game is started (easier). Don't fetch after, as they won't change,
  // but fetch if missing (e.g. browser refresh).
  const cards = store.get(store.cards)
  const shouldFetchCards = status < GameStatus.STARTED || cards === null

  const gameData = await net.fetchGameData(gameID, player, shouldFetchCards)

  if (gameData === ZOMBIE || gameData == THROTTLED || isStaleVerbose(gameID, player))
    // Either game changed (stale), or there should be a request in flight that will give us the
    // data (throttled), or we should have more recent data (zombie).
    return

  const oldGameData = store.get(store.gameData)
  if (oldGameData !== null && oldGameData.lastBlockNum >= gameData.lastBlockNum)
    // We already have more or as recent data, no need to trigger a store update.
    return oldGameData

  status = getGameStatus(gameData, player)

  if (status === GameStatus.ENDED && gameData.playersLeftToJoin > 0) {
    // The game was cancelled before starting.
    // We do not do this when the game ends after starting, as we may still want to peruse the
    // game board.
    store.set(store.gameID, null)
    // The above will cause the gameData to be cleared, return early.
    return
  }

  if (gameData.publicRandomness === 0n && status !== GameStatus.ENDED) {
    const block = await getBlock(getPublicClient())

    // This could be due to:
    // 1. The block used being used for the randomness being the last block. eth_call RPC calls
    //    are seemingly ran with the last block number, meaning the blockhash is unavailable.
    // 2.

    if (gameData.lastBlockNum < block.number - 256n) {
      // The block used for randomness is too old (> 256 blocks in the past), meaning the game
      // is timed out.

      const status = getGameStatus(gameData, player)
      const currentPlayer = gameData.players[gameData.currentPlayer]

      // TODO these things throw exception which we do not handle

      const sendTimeout = async () => {
        // TODO: this has no loading indicators while the game is cancelling
        await contractWriteThrowing({
          contract: deployment.Game,
          abi: gameABI,
          functionName: "timeout",
          args: [gameID]
        })
        setError(null)
      }

      if (status === GameStatus.STARTED) {
        if (currentPlayer === player) {
          setError({
            title: "Time out",
            message: "You didn't take an action within the time limit, and lost as a result.",
            buttons: [{ text: "Leave Game", onClick: sendTimeout }]})
        } else {
          setError({
            title: "Your opponent timed out",
            message: "Your opponent didn't take an action within the time limit, " +
              "and you won as a result.",
            buttons: [{ text: "Claim Victory", onClick: sendTimeout }]})}
      } else {
        // The game hasn't started yet, but some player didn't join.
        if (status === GameStatus.HAND_DRAWN) {
          // We've done our part, it's some other player that didn't join.
          setError({
            title: "Missing players",
            message: "Some players didn't join within the time limit, " +
              "the game got cancelled as a result.",
            buttons: [{ text: "Leave Game", onClick: sendTimeout }]})
        } else {
          setError({
            title: "Time out",
            message: "You couldn't join the game within the time limit, " +
              "the game got cancelled as a result.",
            buttons: [{
              text: "Leave Game",
              onClick: sendTimeout}]})
        }
      }
    } else {
      // The `eth_call` RPC call executes in the context of the last block, so it's likely that
      // `gameData.lastBlockNum` is the very last block and onchain its blockhash is not available.

      const lastGameBlock = block.number === gameData.lastBlockNum
        ? block
        : await getBlock(getPublicClient(), { blockNumber: gameData.lastBlockNum })

      // Note that this will also works when the publicRandomness is separate for players drawing
      // their hands: in the case where we're on the very last block, `gameData.lastBlockNum ===
      // playerData.joinBlockNum`.
      gameData.publicRandomness = parseBigInt(lastGameBlock.hash) % PROOF_CURVE_ORDER
    }
  }

  store.set(store.gameData, gameData)
  if (gameData.cards.length > 0)
    store.set(store.cards, gameData.cards)

  const timestamp = Date.now()
  console.groupCollapsed(
    "updated game data " +
    (shouldFetchCards ? "(including cards) " : "") +
    `(at ${formatTimestamp(timestamp)})`)
  console.dir(gameData)
  console.groupEnd()

  return gameData
}

// =================================================================================================