import * as mcl from "mcl-wasm";
import { panel, text, heading } from "@metamask/snaps-ui";
import {
  createPublicClient,
  formatUnits,
  getContract,
  keccak256,
  parseGwei,
  toBytes,
  encodeAbiParameters, custom
} from "viem";

import { CHAIN_PARAMS, CHAINS } from "./constants/networks.js";
import { ADDRESSES } from "./constants/addresses";
import { FIRN_ABI, ORACLE_ABI, ARB_GAS_INFO_ABI } from "./constants/abis";
import { ElGamal, N, algebra } from "./crypto/algebra";
import { Client, EPOCH_LENGTH } from "./crypto/client";
import { nextEpoch } from "./utils/nextEpoch";
import { optimismTxCompressedSize } from "./utils/gas";
import { relayFetch } from "./utils/relay";


const FEE = 128;
export const WITHDRAWAL_GAS = 3850000n;
const WITHDRAWAL_TX_COMPRESSED_SIZE = 2900n;
const WITHDRAWAL_CALLDATA_SIZE = 3076n;
const BLOB_BASE_FEE_SCALAR = 810949n;
const BASE_FEE_SCALAR = 1368n;


/**
 * Handle incoming JSON-RPC requests, sent through `wallet_invokeSnap`.
 *
 * @param args - The request handler args as object.
 * @param args.origin - The origin of the request, e.g., the website that
 * invoked the snap.
 * @param args.request - A validated JSON-RPC request object.
 * @returns `null` if the request succeeded.
 * @throws If the request method is not valid for this snap.
 * @throws If the `snap_confirm` call failed.
 */
export const onRpcRequest = async ({ origin, request }) => {
  switch (request.method) {
    case "initialize": {
      const [address] = await ethereum.request({
        method: "eth_requestAccounts"
      });
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state !== null && address in state) return;  // they're already logged in.
      const signature = await ethereum.request({
        method: "personal_sign",
        params: ["This message will log you into your Firn account.", address],
      });
      const plaintext = keccak256(signature);
      await snap.request({
        method: "snap_manageState",
        params: {
          newState: { ...state, [address]: plaintext },
          operation: "update"
        }
      }); // return nothing for now
      return;
    }
    case "requestBalance": {
      const [address] = await ethereum.request({
        method: "eth_requestAccounts"
      });
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state === null || !(address in state))
        throw new Error("User has not yet logged in under this address.");
      const plaintext = state[address];
      await algebra;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(toBytes(plaintext));

      const chainId = Number(await ethereum.request({ method: "eth_chainId" }));
      const name = CHAINS[chainId];
      if (name === undefined)
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const publicClient = createPublicClient({
        chain: CHAIN_PARAMS[name].chain,
        transport: custom(ethereum),
      });

      const block = await publicClient.getBlock();
      const epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      const client = new Client({ secret });
      const contract = getContract({
        address: ADDRESSES[name].PROXY,
        abi: FIRN_ABI,
        client: publicClient
      });
      const result = await contract.read.simulateAccounts([[client.pub], epoch]);
      const future = ElGamal.deserialize(result[0]);
      await client.initialize(publicClient, block, future, future);
      const balance = client.state.available + client.state.pending;
      const approved = await snap.request({
        method: "snap_dialog",
        params: {
          type: "confirmation",
          content: panel([
            heading("Balance Disclosure Request"),
            text(`The site **${origin}** is requesting to see your Firn account balance.`),
            text(`Your current balance on the chain **${name}** is **${(balance / 1000).toFixed(3)} ETH**.`),
            text(`Would you like to disclose this information to **${origin}**?`),
          ]),
        }
      });
      if (!approved) throw new Error("User rejected the request.");
      return balance;
    }
    case "transact": {
      const [address] = await ethereum.request({
        method: "eth_requestAccounts"
      });
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state === null || !(address in state))
        throw new Error("User has not yet logged in under this address.");
      const plaintext = state[address];
      await algebra;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(toBytes(plaintext));

      const chainId = Number(await ethereum.request({ method: "eth_chainId" }));
      const name = CHAINS[chainId];
      if (name === undefined)
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const publicClient = createPublicClient({
        chain: CHAIN_PARAMS[name].chain, // ???
        transport: custom(ethereum),
      });
      const transaction = request.params;
      let block = await publicClient.getBlock();
      let epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      const client = new Client({ secret });
      const result = await publicClient.multicall({
        contracts: [
          {
            address: ADDRESSES[name].PROXY,
            abi: FIRN_ABI,
            functionName: "simulateAccounts",
            args: [[client.pub], epoch],
          },
          {
            address: ADDRESSES[name].PROXY,
            abi: FIRN_ABI,
            functionName: "simulateAccounts",
            args: [[client.pub], epoch + 1],
          },
        ]
      });
      const present = ElGamal.deserialize(result[0].result[0]);
      const future = ElGamal.deserialize(result[1].result[0]);
      await client.initialize(publicClient, block, present, future);
      const calculators = {  // now imperative.....
        "Ethereum": async (l1Gas, maxPriorityFeePerGas) => {
          const feeHistory = await publicClient.getFeeHistory({
            blockCount: 1,
            rewardPercentiles: []
          });
          const l1GasPrice = feeHistory.baseFeePerGas[0];
          const maxFeePerGas = l1GasPrice + maxPriorityFeePerGas; // l1GasPrice = lastBaseFeePerGas
          return l1Gas * maxFeePerGas;
        },
        "OP Mainnet": async (l2Gas, txCompressedSize) => {
          const oracle = getContract({
            address: ADDRESSES[name].ORACLE,
            abi: ORACLE_ABI,
            client: publicClient
          });
          const l1BaseFee = await oracle.read.l1BaseFee();
          const blobBaseFee = await oracle.read.blobBaseFee();
          const weightedGasPrice = 16n * BASE_FEE_SCALAR * l1BaseFee / 1000000n + BLOB_BASE_FEE_SCALAR * blobBaseFee;
          const l1DataFee = txCompressedSize * weightedGasPrice
          const { maxFeePerGas: l2GasPrice } = await publicClient.estimateFeesPerGas() // getGasPrice(); ???
          const l2ExecutionFee = l2GasPrice * l2Gas;
          return l1DataFee + l2ExecutionFee;
        },
        "Arbitrum One": async (l2Gas, l1CalldataSize) => {
          const arbitrum = getContract({
            address: ADDRESSES[name].ARB_GAS_INFO,
            abi: ARB_GAS_INFO_ABI,
            client: publicClient
          });
          const l2GasPrice = await publicClient.getGasPrice();
          const data = await arbitrum.read.getPricesInWei();
          const l1GasPrice = data[1];
          return l2Gas * l2GasPrice + l1GasPrice * l1CalldataSize;
        }
      };
      const amount = transaction.value; // value, amount, etc etc.
      const data = transaction.data; // assert isBytes(data);
      const recipient = transaction.to; // assert isAddress(recipient)?
      const fee = Math.floor(amount / FEE);
      let gas = 0n;
      if (name === "Ethereum") {
        const l1Gas = WITHDRAWAL_GAS;
        const maxPriorityFeePerGas = parseGwei("1.5");
        gas = await calculators["Ethereum"](l1Gas, maxPriorityFeePerGas);
        // if (data !== "0x") increase tip somehow... TODO. revisit.
      } else if (name === "OP Mainnet" || name === "Base") {
        const l2Gas = WITHDRAWAL_GAS;
        const txCompressedSize = WITHDRAWAL_TX_COMPRESSED_SIZE + optimismTxCompressedSize(data);
        gas = await calculators["OP Mainnet"](l2Gas, txCompressedSize);
      } else if (name === "Arbitrum One") {
        const l2Gas = WITHDRAWAL_GAS;
        const l1CalldataSize = WITHDRAWAL_CALLDATA_SIZE + BigInt(data.length - 2 >> 1);
        gas = await calculators["Arbitrum One"](l2Gas, l1CalldataSize);
      }
      const balance = client.state.available + client.state.pending;
      const tip = Math.round(parseFloat(formatUnits(gas, 15)));
      // note: right now, don't bother checking pending. we're assuming that they have 0 pending balance, or more generally
      // that their pending balance won't make or break
      if (balance < amount + fee + tip) throw new Error("Insufficient balance for transaction.");
      const approved = await snap.request({
        method: "snap_dialog",
        params: {
          type: "confirmation",
          content: panel([
            heading("Transaction Approval Request"),
            text(`The site **${origin}** is proposing the following transaction on your behalf.`),
            text(`**Destination Address:** ${recipient}.`),
            text(`**Value:** ${(amount / 1000).toFixed(3)} ETH.`),
            text(`**Data:** ${data}.`),
            text(`Your fees, including gas, will be ${((fee + tip) / 1000).toFixed(3)} ETH.`),
            text(`Would you like to execute this transaction privately via Firn?`),
          ]),
        },
      });
      if (!approved) throw new Error("User rejected the request.");

      block = await publicClient.getBlock(); // i guess get it again, in case they tarried.
      epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      const away = (Math.floor(Number(block.timestamp) / EPOCH_LENGTH) + 1) * EPOCH_LENGTH - Number(block.timestamp);
      // crude attempt to determine how much time is left in the epoch. typically this will be an underestimate
      const delay = amount > client.state.available || away < 10;
      if (delay) {
        block = await nextEpoch(publicClient, block);
        epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      }
      const promise = nextEpoch(publicClient, block);
      const [Y, C, D, u, proof] = await client.withdraw(publicClient, amount, epoch, tip + fee, recipient, data, name);
      const hash = keccak256(encodeAbiParameters([
        { name: "", type: "bytes32[" + N + "]" },
        { name: "", type: "bytes32[" + N + "]" },
        { name: "", type: "bytes32" },
      ], [
        Y,
        C,
        D,
      ]));

      const alternative = new Promise((resolve) => {
        const unwatch = publicClient.watchContractEvent({
          address: ADDRESSES[name].PROXY,
          abi: FIRN_ABI,
          eventName: "WithdrawalOccurred",
          onLogs(logs) {
            logs.forEach((log) => {
              const { Y, C, D } = log.args;
              const candidate = keccak256(encodeAbiParameters([
                { name: "", type: "bytes32[" + N + "]" },
                { name: "", type: "bytes32[" + N + "]" },
                { name: "", type: "bytes32" },
              ], [
                Y,
                C,
                D,
              ]));
              if (hash === candidate) {
                unwatch();
                resolve(log);
              }
            });
          },
        });
        setTimeout(() => { unwatch(); }, 180000);
      });

      const body = { Y, C, D, u, epoch, tip, proof };

      body.destination = recipient;
      body.data = data; // relay will overwrite this anyway for now...
      body.amount = amount;

      try { // where should `try` start....? kind of subtle question
        const transactionReceipt = await Promise.race([ // could be an event..
          relayFetch(`withdrawal${Number(chainId)}`, body).then((json) => {
            return Promise.race([
              publicClient.waitForTransactionReceipt(json).catch((error) => {
                // apparently, when the thing reverts, instead of returning a receipt with { status: "reverted" }, it just throws.
                // "CallExecutionError: Execution reverted for an unknown reason." ... "Details: execution reverted".

                // what can _also_ happen is TransactionNotFoundError: Transaction with hash "0x____" could not be found
                // this seems to be a bug: the whole goal is to _wait_ for the transaction, not to throw, if it's not there yet.
                // in fact at one point i even confirmed with jxom that this is a bug, but he said it should be "fixed"
                // don't know (yet) how to detect this programmatically...
                console.error(error);
                return { status: "reverted", transactionHash: json.hash }; // if (error.details === "execution reverted")
              }),
              promise.then((block) => {
                // this guy handles the case where the relay _does_ respond with the tx hash, but then nobody mines it,
                // and we sit around waiting until we're sure that the thing has expired....
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    reject({
                      statusText: "Took too long",
                      transactionHash: json.hash, // ...json
                    });
                  }, 15000);
                });
              })
            ]);
          }).then((data) => {
            if (data.status === "success") {
              return data;
            } else {
              return promise.then((block) => {
                // this whole block is only for the extremely weird edge case where our thing got _certifiably_ reverted,
                // but we wait around anyway, in case someone else mined it, but we haven't received word of that yet.
                // warning: if `waitForTransaction` takes super-long, _and_ the thing fails (i.e., resolves with status === 0),
                // then code won't flow over the below until _after_ `nextBlock` has resolved (i.e., could be > 5 seconds after).
                // in this event, the below generic waiter could throw before this one does, even when our thing got reverted.
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    reject(data);
                  }, 15000);
                });
              });
            }
          }),
          alternative,
          promise.then((block) => { // start the process NOW for a full rejection...!!! in case relay takes forever.
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                reject({ statusText: "No response" });
              }, 20000);
            });
          }),
          // give a huge grace period here of 20 seconds _after_ next epoch starts. i guess the idea is that
          // the response can take a while to come back, even though the thing has actually successfully been mined.
          // i'd rather have the user wait a little longer than necessary before being notified of the failure,
          // than inappropriately alert them of a failure (false negative).
          new Promise((resolve, reject) => {
            setTimeout(() => {
              reject({ statusText: "Radio silence" });
            }, 180000);
          }),
        ]);
        return transactionReceipt.transactionHash;
      } catch (error) {
        if (error.message === "Failed to fetch")
          throw new Error("Failed to reach the Firn relay; please try again.");
        else if (error.status === "reverted")
          throw new Error("Your Firn transaction was mined, but reverted. This may be a timing issue.");
        else if (error.statusText === "No response")
          throw new Error("The relay hung while responding to the transaction, and the proof expired. This is probably a connectivity issue; please try again.");
        else if (error.statusText === "Took too long")
          throw new Error("The relay successfully broadcast the relevant transaction, but it was not mined in time, and has now expired. Please try again.");
        else if (error.statusText === "Radio silence")
          throw new Error("We lost contact with the network while trying to broadcast your transaction; this is probably a connectivity issue.");
        else if (error.status === 500) {
          if (error.statusText === "Tip too low")
            throw new Error("The relay rejected the transaction's gas fee as excessively low. This can happen if gas prices fluctuate rapidly; please try again.");
          else if (error.statusText === "Wrong epoch")
            throw new Error("The relay refused to broadcast the transaction, citing a clock synchronization issue. Please try again.");
          else
            throw new Error("The relay refused to broadcast the transaction, citing an undisclosed issue. Please contact us directly to report this bug.");
        } else
          throw error; // pass on the misc error?! this is different from the front-end.
      }
    }
    default:
      throw new Error("Method not found");
  }
};
