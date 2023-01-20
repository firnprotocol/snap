import { ethers } from "ethers";
import * as mcl from "mcl-wasm";

import { CHAIN_ID, CHAIN_PARAMS } from "./constants/networks.js";
import { N, promise } from "./crypto/algebra";
import { FIRN_ABI, READER_ABI } from "./constants/abis";
import { ADDRESSES } from "./constants/addresses";
import { Client } from "./crypto/client";
import { optimismTxDataGas } from "./utils/gas";
import { Relay } from "./utils/relay";
import { EPOCH_LENGTH } from "./crypto/client";
import { nextEpoch } from "./utils/nextEpoch";

const FEE = 256;
const WITHDRAWAL_GAS = ethers.BigNumber.from(3600000); // undercutting
const WITHDRAWAL_TX_DATA_GAS = 46500;
const FIXED_OVERHEAD = 2100;
const DYNAMIC_OVERHEAD = 1.24;
const WITHDRAWAL_CALLDATA_SIZE = ethers.BigNumber.from(3076);

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
      const provider = new ethers.providers.Web3Provider(wallet);
      const accounts = await provider.listAccounts();
      const { chainId } = await provider.getNetwork();
      if (!Object.values(CHAIN_ID).includes(chainId))
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const signature = await wallet.request({
        method: "personal_sign",
        params: [accounts[0], CHAIN_PARAMS[chainId].message],
      });
      const plaintext = ethers.utils.keccak256(signature);
      await wallet.request({
        method: "snap_manageState",
        params: ["update", { plaintext }]
      });
      return; // return nothing for now
    }
    case "requestBalance": {
      const state = await wallet.request({
        method: "snap_manageState",
        params: ["get"]
      }); // works
      if (state === null)
        throw new Error("User hasn't logged into Firn yet.");
      const plaintext = state.plaintext;
      const provider = new ethers.providers.Web3Provider(wallet);
      const { chainId } = await provider.getNetwork();
      if (!Object.values(CHAIN_ID).includes(chainId))
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      // do a bunch of other stuff...
      await promise;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(ethers.utils.arrayify(plaintext));
      const firnContract = new ethers.Contract(ADDRESSES[chainId]["PROXY"], FIRN_ABI, provider);
      const client = new Client({ secret, firnContract });
      await client.initialize(provider);
      const balance = client.state.available + client.state.pending;
      const approved = await wallet.request({
        method: "snap_confirm",
        params: [{
          prompt: `Confirm balance disclosure`,
          description: `${origin} wants to know your Firn account's balance. Please determine whether you want to share this information.`,
          textAreaContent: JSON.stringify({
            balance: `${(balance / 1000).toFixed(3)} ETH`,
            chainId: chainId,
          }, null, " "),
        }],
        // todo: potentially try to do an etherscan lookup and decode the data...
      });
      if (!approved) throw new Error("Client rejected the balance prompt.");
      return balance;
    }
    case "transact": {
      const state = await wallet.request({
        method: "snap_manageState",
        params: ["get"]
      }); // works
      if (state === null)
        throw new Error("User hasn't logged into Firn yet.");
      const plaintext = state.plaintext;
      const provider = new ethers.providers.Web3Provider(wallet);
      const { chainId } = await provider.getNetwork();
      if (!Object.values(CHAIN_ID).includes(chainId))
        throw new Error(`The chain ID ${chainId} is not supported by Firn.`);
      const unsignedTx = { ...request.params };
      if (!ethers.utils.isAddress(unsignedTx.to))
        throw new Error("Input transaction's \"to\" field is not a valid Ethereum address.");
      if (!ethers.utils.isBytesLike(unsignedTx.data))
        throw new Error("Input transaction's \"data\" field is not bytes-like.");
      let value;
      try {
        value = ethers.BigNumber.from(unsignedTx.value);
      } catch (error) {
        throw new Error("Input transaction's \"value\" field is not a valid big number.");
      }
      if (!value.mod(ethers.BigNumber.from(10).pow(15)).isZero())
        throw new Error("Input transaction's value must be a multiple of 0.001 ETH.");

      await promise;
      const secret = new mcl.Fr();
      secret.setBigEndianMod(ethers.utils.arrayify(plaintext));
      const firnContract = new ethers.Contract(ADDRESSES[chainId]["PROXY"], FIRN_ABI, provider);
      const readerContract = new ethers.Contract(ADDRESSES[chainId]["READER"], READER_ABI, provider);
      const client = new Client({ secret, firnContract, readerContract });
      await client.initialize(provider);

      const amount = Number(ethers.utils.formatUnits(value, 15)); // value, amount, etc etc.
      const fee = Math.floor(amount / FEE);
      let gas = ethers.BigNumber.from(0);
      const feeData = await provider.getFeeData();
      if (chainId === CHAIN_ID.ETHEREUM) {
        const l1GasPrice = feeData.lastBaseFeePerGas;
        const l1Gas = WITHDRAWAL_GAS;
        const maxPriorityFeePerGas = ethers.utils.parseUnits("3", "gwei");
        const maxFeePerGas = l1GasPrice.add(maxPriorityFeePerGas); // l1GasPrice = lastBaseFeePerGas
        gas = l1Gas.mul(maxFeePerGas); // todo: accommodate data
      } else if (chainId === CHAIN_ID.OPTIMISM) {
        // const l2Provider = asL2Provider(provider);
        const l1GasPrice = ethers.utils.parseUnits("30", "gwei"); // await getL1GasPrice(l2Provider);
        const l2Gas = WITHDRAWAL_GAS;
        const txDataGas = WITHDRAWAL_TX_DATA_GAS + optimismTxDataGas(data);
        const l1DataFee = l1GasPrice.mul(ethers.BigNumber.from(Math.ceil((txDataGas + FIXED_OVERHEAD) * DYNAMIC_OVERHEAD)));
        const l2ExecutionFee = feeData.gasPrice.mul(l2Gas);
        gas = l1DataFee.add(l2ExecutionFee);
      } else if (chainId === CHAIN_ID.ARBITRUM) {
        const l1GasPrice = ethers.utils.parseUnits("300", "gwei"); // this was imputed from real data... overest... about 258
        const l2Gas = WITHDRAWAL_GAS;
        const l1CalldataSize = WITHDRAWAL_CALLDATA_SIZE.add(ethers.BigNumber.from((data.length - 2) / 2));
        gas = l2Gas.mul(feeData.gasPrice).add(l1GasPrice.mul(l1CalldataSize));
      }
      const balance = client.state.available + client.state.pending;
      const tip = Math.ceil(parseFloat(ethers.utils.formatUnits(gas, 15)));
      const max = Math.max(0, Math.ceil((balance - tip) * FEE / (FEE + 1)) - ((balance - tip + 1) % (FEE + 1) === 0 ? 1 : 0));
      // note: right now, don't bother checking pending. we're assuming that they have 0 pending balance, or more generally
      // that their pending balance won't make or break
      if (balance < amount + fee + tip) throw new Error(`Insufficient balance for transaction. The requested withdrawal amount of ${(amount / 1000).toFixed(3)} ETH, together with the withdrawal fee of ${(fee / 1000).toFixed(3)} ETH and gas costs of ${(tip / 1000).toFixed(3)} ETH, for a total of ${((amount + fee + tip) / 1000).toFixed(3)} ETH, exceeds the user's current balance of ${(balance / 1000).toFixed(3)} ETH. The maximum currently withdrawable amount is ${(max / 1000).toFixed(3)} ETH.`);

      const approved = await wallet.request({
        method: "snap_confirm",
        params: [{
          prompt: `Confirm private transaction`,
          description: `${origin} wants to privately send the following raw transaction from your Firn account. Please review the transaction carefully.`,
          textAreaContent: JSON.stringify({
            to: unsignedTx.to,
            value: `${Number(ethers.utils.formatUnits(value, "ether")).toFixed(3)} ETH`,
            data: unsignedTx.data,
          }, null, " "),
        }],
      });
      if (!approved) throw new Error("Client rejected the transaction confirmation prompt.");

      const relay = new Relay();
      let block = await provider.getBlock("latest");
      let epoch = Math.floor(block.timestamp / EPOCH_LENGTH);
      const away = (Math.floor(block.timestamp / EPOCH_LENGTH) + 1) * EPOCH_LENGTH - block.timestamp;
      // crude attempt to determine how much time is left in the epoch. typically this will be an underestimate
      const delay = amount > client.state.available || away < 20;
      if (delay) {
        block = await nextEpoch(provider, block);
        epoch = Math.floor(block.timestamp / EPOCH_LENGTH);
      }
      const nextBlock = nextEpoch(provider, block); // start counting; note that we don't await.
      const [Y, C, D, u, proof] = await client.withdraw(amount, epoch, tip + fee, unsignedTx.to, unsignedTx.data);
      const hash = ethers.utils.solidityKeccak256([`bytes32[${N}]`, `bytes32[${N}]`, "bytes32",], [Y, C, D,]);
      const body = { Y, C, D, u, epoch, tip, proof, destination: unsignedTx.to, data: unsignedTx.data, amount };
      try {
        const transactionReceipt = await Promise.race([ // could be an event..
          relay.fetch(`withdrawal${chainId}`, body).then((json) => {
            console.log(json.hash);
            return Promise.race([
              provider.waitForTransaction(json.hash),
              nextBlock.then((block) => {
                // this guy handles the case where the relay _does_ respond with the tx hash, but then nobody mines it,
                // and we sit around waiting until we're sure that the thing has expired....
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    reject({
                      statusText: "Took too long",
                      hash: json.hash, // ...json
                    });
                  }, 15000);
                });
              })
            ]);
          }).then((transactionReceipt) => {
            if (transactionReceipt.status === 1) {
              return transactionReceipt;
            } else {
              return nextBlock.then((block) => {
                // this whole block is only for the extremely weird edge case where our thing got _certifiably_ reverted,
                // but we wait around anyway, in case someone else mined it, but we haven't received word of that yet.
                // warning: if `waitForTransaction` takes super-long, _and_ the thing fails (i.e., resolves with status === 0),
                // then code won't flow over the below until _after_ `nextBlock` has resolved (i.e., could be > 5 seconds after).
                // in this event, the below generic waiter could throw before this one does, even when our thing got reverted.
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    reject(transactionReceipt);
                  }, 15000);
                });
              });
            }
          }),
          new Promise((resolve) => {
            const listener = async (Y, C, D, amount, destination, data, event) => {
              const candidate = ethers.utils.solidityKeccak256([`bytes32[${N}]`, `bytes32[${N}]`, "bytes32",], [Y, C, D,]); // these shadow.
              if (hash === candidate) {
                firnContract.off("WithdrawalOccurred", listener);
                resolve(event);
              }
            };
            firnContract.on("WithdrawalOccurred", listener);
          }),
          nextBlock.then((block) => { // start the process NOW for a full rejection...!!! in case relay takes forever.
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
        ]);
        const { to, from, blockHash, transactionHash, blockNumber, confirmations, status, type } = transactionReceipt
        return { to, from, blockHash, transactionHash, blockNumber, confirmations, status, type }; // messy. need to exclude fields...
      } catch (error) {
        console.error(error); // will prob do nothing
        if (error.message === "Failed to fetch")
          throw new Error("Failed to reach the Firn relay; please try again.");
        else if (error.status === 0)
          throw new Error("The Firn transaction was mined, but reverted, and no other transaction effecting the same withdrawal was detected. This may be a timing issue.");
        else if (error.statusText === "No response")
          throw new Error("The relay hung while responding to the transaction, and the proof expired. This is probably a connectivity issue; please try again.");
        else if (error.statusText === "Took too long")
          throw new Error("The relay successfully broadcast the relevant transaction, but it was not mined in time, and has now expired. Please try again.");
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
