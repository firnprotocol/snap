import * as mcl from "mcl-wasm";
import { panel, text, heading } from "@metamask/snaps-ui";
import { createPublicClient, http, formatUnits, getContract, keccak256, parseGwei, toBytes } from "viem";

import { CHAIN_ID, CHAIN_PARAMS } from "./constants/networks.js";
import { ADDRESSES } from "./constants/addresses";
import { FIRN_ABI, READER_ABI, ORACLE_ABI, ARB_GAS_INFO_ABI } from "./constants/abis";
import { ElGamal, promise } from "./crypto/algebra";
import { Client, EPOCH_LENGTH } from "./crypto/client";
import { nextEpoch } from "./utils/nextEpoch";
import { optimismTxDataGas } from "./utils/gas";
import { Relay } from "./utils/relay";


const FEE = 128;
export const WITHDRAWAL_GAS = 3750000n;
const WITHDRAWAL_TX_DATA_GAS = 46500;
const WITHDRAWAL_CALLDATA_SIZE = 3076n;
const FIXED_OVERHEAD = 2100;
const DYNAMIC_OVERHEAD = 1.24;

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
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state !== null) return;  // they're already logged in.
      const [address] = await ethereum.request({
        method: "eth_requestAccounts"
      });
      const signature = await ethereum.request({
        method: "personal_sign",
        params: ["This message will log you into your Firn account.", address],
      });
      const plaintext = keccak256(signature);
      await snap.request({
        method: "snap_manageState",
        params: {
          newState: { plaintext },
          operation: "update"
        }
      }); // return nothing for now
      return;
    }
    case "requestBalance": {
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state === null)
        throw new Error("User hasn't logged into Firn yet.");
      const plaintext = state.plaintext;
      await promise;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(toBytes(plaintext));

      const chainId = await ethereum.request({
        method: "eth_chainId",
      });
      if (!Object.keys(CHAIN_ID).includes(chainId))
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const name = CHAIN_ID[chainId];
      const publicClient = createPublicClient({
        chain: CHAIN_PARAMS[name].chain, // ???
        transport: http(), // 'https://eth-mainnet.g.alchemy.com/v2/WM5ly1JW2TrWhk8byZfTt2cpRVTpRUnw' //
      });

      const block = await publicClient.getBlock();
      const epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      const nextEpoch = (publicClient, block) => Promise.resolve(block); // dummy
      const client = new Client({ secret, nextEpoch });
      const contract = getContract({
        address: ADDRESSES[name].PROXY,
        abi: FIRN_ABI,
        publicClient,
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
            text(`Your current balance on the chain **${name}** is **${(balance / 1000).toFixed(3)}** ETH.`),
            text(`Would you like to disclose this information to **${origin}**?`),
          ]),
        }
      });
      if (!approved) throw new Error("Client rejected the balance prompt.");
      return balance;
    }
    case "transact": {
      const state = await snap.request({
        method: "snap_manageState",
        params: {
          operation: "get"
        }
      });
      if (state === null)
        throw new Error("User hasn't logged into Firn yet.");
      const plaintext = state.plaintext;
      await promise;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(toBytes(plaintext));

      const chainId = await ethereum.request({
        method: "eth_chainId",
      });
      if (!Object.keys(CHAIN_ID).includes(chainId))
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const name = CHAIN_ID[chainId];
      const publicClient = createPublicClient({
        chain: CHAIN_PARAMS[name].chain, // ???
        transport: http(), // 'https://eth-mainnet.g.alchemy.com/v2/WM5ly1JW2TrWhk8byZfTt2cpRVTpRUnw'
      });
      const transaction = request.params;
      let block = await publicClient.getBlock();
      let epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      const client = new Client({ secret, nextEpoch });
      // const contract = getContract({
      //   address: ADDRESSES[name].PROXY,
      //   abi: FIRN_ABI,
      //   publicClient,
      // });
      // const reader = getContract({
      //   address: ADDRESSES[name].READER,
      //   abi: READER_ABI,
      //   publicClient,
      // });
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
        "OP Mainnet": async (l2Gas, txDataGas) => {
          const oracle = getContract({
            address: ADDRESSES[name].ORACLE,
            abi: ORACLE_ABI,
            publicClient
          });
          const l1BaseFee = await oracle.read.l1BaseFee();
          const l2GasPrice = await publicClient.getGasPrice(); // could try to batch these... fuqit
          const l1DataFee = l1BaseFee * BigInt(Math.ceil((txDataGas + FIXED_OVERHEAD) * DYNAMIC_OVERHEAD));
          const l2ExecutionFee = l2GasPrice * l2Gas;
          return l1DataFee + l2ExecutionFee;
        },
        "Arbitrum One": async (l2Gas, l1CalldataSize) => {
          const arbitrum = getContract({
            address: ADDRESSES[name].ARB_GAS_INFO,
            abi: ARB_GAS_INFO_ABI,
            publicClient,
          });
          const l2GasPrice = await publicClient.getGasPrice();
          const data = await arbitrum.getPricesInWei();
          const l1GasPrice = data[1];
          return l2Gas * l2GasPrice + l1GasPrice * l1CalldataSize;
        }
      };

      const amount = transaction.value; // value, amount, etc etc.
      const data = transaction.data; // assert isBytes(data);
      const fee = Math.floor(amount / FEE);
      let gas = 0n;
      if (name === "Ethereum") {
        const l1Gas = WITHDRAWAL_GAS;
        const maxPriorityFeePerGas = parseGwei("1.5");
        gas = await calculators["Ethereum"](l1Gas, maxPriorityFeePerGas);
        // if (data !== "0x") increase tip somehow... TODO. revisit.
      } else if (name === "OP Mainnet" || name === "Base") {
        const l2Gas = WITHDRAWAL_GAS;
        const txDataGas = WITHDRAWAL_TX_DATA_GAS + optimismTxDataGas(data);
        gas = await calculators["OP Mainnet"](l2Gas, txDataGas);
      } else if (name === "Arbitrum One") {
        const l2Gas = WITHDRAWAL_GAS;
        const l1CalldataSize = WITHDRAWAL_CALLDATA_SIZE + BigInt(data.length - 2 >> 1);
        gas = await calculators["Arbitrum One"](l2Gas, l1CalldataSize);
      }
      const balance = client.state.available + client.state.pending;
      const tip = Math.ceil(parseFloat(formatUnits(gas, 15)));
      // note: right now, don't bother checking pending. we're assuming that they have 0 pending balance, or more generally
      // that their pending balance won't make or break
      // if (balance < amount + fee + tip) throw new Error("Insufficient balance for transaction.");
      const approved = await snap.request({
        method: "snap_dialog",
        params: {
          type: "confirmation",
          content: panel([
            heading("Transaction Approval Request"),
            text(`The site **${origin}** is proposing the following Firn transaction on your behalf.`),
            text(`**Destination Address:** ${transaction.to}.`),
            text(`**Value:** ${(amount / 1000).toFixed(3)} ETH.`),
            text(`**Data:** ${data}.`),
            text(`Would you like to proceed with this transaction?`),
          ]),
        },
      });
      if (!approved) throw new Error("Client rejected the transaction confirmation prompt.");

      const relay = new Relay();
      block = await publicClient.getBlock();
      epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
      //   // const away = (Math.floor(block.timestamp / EPOCH_LENGTH) + 1) * EPOCH_LENGTH - block.timestamp;
      //   // crude attempt to determine how much time is left in the epoch. typically this will be an underestimate
      //   // const delay = amount > client.state.available || away < 20;
      //   // if (delay) {
      //   //   block = await nextEpoch(provider, block);
      //   //   epoch = Math.floor(block.timestamp / EPOCH_LENGTH);
      //   // }
      //   const nextBlock = nextEpoch(provider, block); // start counting; note that we don't await.
      //   // const [Y, C, D, u, proof] = await client.withdraw(amount, epoch, tip + fee, unsignedTx.to, unsignedTx.data);
      //   // const hash = ethers.utils.solidityKeccak256([`bytes32[${N}]`, `bytes32[${N}]`, "bytes32",], [Y, C, D,]);
      //   // const body = { Y, C, D, u, epoch, tip, proof, destination: unsignedTx.to, data: unsignedTx.data, amount };
      //   try {
      //     const transactionReceipt = await Promise.race([ // could be an event..
      //       relay.fetch(`withdrawal${chainId}`, {}).then((json) => {
      //         console.log(json.hash);
      //         return Promise.race([
      //           provider.waitForTransaction(json.hash),
      //           nextBlock.then((block) => {
      //             // this guy handles the case where the relay _does_ respond with the tx hash, but then nobody mines it,
      //             // and we sit around waiting until we're sure that the thing has expired....
      //             return new Promise((resolve, reject) => {
      //               setTimeout(() => {
      //                 reject({
      //                   statusText: "Took too long",
      //                   hash: json.hash, // ...json
      //                 });
      //               }, 15000);
      //             });
      //           })
      //         ]);
      //       }).then((transactionReceipt) => {
      //         if (transactionReceipt.status === 1) {
      //           return transactionReceipt;
      //         } else {
      //           return nextBlock.then((block) => {
      //             // this whole block is only for the extremely weird edge case where our thing got _certifiably_ reverted,
      //             // but we wait around anyway, in case someone else mined it, but we haven't received word of that yet.
      //             // warning: if `waitForTransaction` takes super-long, _and_ the thing fails (i.e., resolves with status === 0),
      //             // then code won't flow over the below until _after_ `nextBlock` has resolved (i.e., could be > 5 seconds after).
      //             // in this event, the below generic waiter could throw before this one does, even when our thing got reverted.
      //             return new Promise((resolve, reject) => {
      //               setTimeout(() => {
      //                 reject(transactionReceipt);
      //               }, 15000);
      //             });
      //           });
      //         }
      //       }),
      //       new Promise((resolve) => {
      //         const listener = async (Y, C, D, amount, destination, data, event) => {
      //           const candidate = ethers.utils.solidityKeccak256([`bytes32[${N}]`, `bytes32[${N}]`, "bytes32",], [Y, C, D,]); // these shadow.
      //           if (hash === candidate) {
      //             firnContract.off("WithdrawalOccurred", listener);
      //             resolve(event);
      //           }
      //         };
      //         firnContract.on("WithdrawalOccurred", listener);
      //       }),
      //       nextBlock.then((block) => { // start the process NOW for a full rejection...!!! in case relay takes forever.
      //         return new Promise((resolve, reject) => {
      //           setTimeout(() => {
      //             reject({ statusText: "No response" });
      //           }, 20000);
      //         });
      //       }),
      //       // give a huge grace period here of 20 seconds _after_ next epoch starts. i guess the idea is that
      //       // the response can take a while to come back, even though the thing has actually successfully been mined.
      //       // i'd rather have the user wait a little longer than necessary before being notified of the failure,
      //       // than inappropriately alert them of a failure (false negative).
      //     ]);
      //     const { to, from, blockHash, transactionHash, blockNumber, confirmations, status, type } = transactionReceipt;
      //     return { to, from, blockHash, transactionHash, blockNumber, confirmations, status, type }; // messy. need to exclude fields...
      //   } catch (error) {
      //     console.error(error); // will prob do nothing
      //     if (error.message === "Failed to fetch")
      //       throw new Error("Failed to reach the Firn relay; please try again.");
      //     else if (error.status === 0)
      //       throw new Error("The Firn transaction was mined, but reverted, and no other transaction effecting the same withdrawal was detected. This may be a timing issue.");
      //     else if (error.statusText === "No response")
      //       throw new Error("The relay hung while responding to the transaction, and the proof expired. This is probably a connectivity issue; please try again.");
      //     else if (error.statusText === "Took too long")
      //       throw new Error("The relay successfully broadcast the relevant transaction, but it was not mined in time, and has now expired. Please try again.");
      //     else if (error.status === 500) {
      //       if (error.statusText === "Tip too low")
      //         throw new Error("The relay rejected the transaction's gas fee as excessively low. This can happen if gas prices fluctuate rapidly; please try again.");
      //       else if (error.statusText === "Wrong epoch")
      //         throw new Error("The relay refused to broadcast the transaction, citing a clock synchronization issue. Please try again.");
      //       else
      //         throw new Error("The relay refused to broadcast the transaction, citing an undisclosed issue. Please contact us directly to report this bug.");
      //     } else
      //       throw error; // pass on the misc error?! this is different from the front-end.
      //   }
    }
    default:
      throw new Error("Method not found");
  }
};
