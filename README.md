# Firn Protocol's Snap

Firn's Snap allows websites to securely invoke Firn Protocol on behalf of users.

An end-to-end, open-source working example exhibiting the below methods is available, and hosted, at [Tome](https://tome.fm); see also [`firnprotocol/tome`](https://github.com/firnprotocol/tome) for the source.

## API

### Connecting

Connect to the Firn Snap in [the standard way](https://docs.metamask.io/guide/snaps-development-guide.html#the-snap-source-code); that is:

```javascript
await provider.request({
  method: "wallet_requestSnaps",
  params: { "npm:@firnprotocol/snap": {} },
});
```

### Initialize

The `initialize` method prompts the user to "log into" his Firn account, on behalf of his currently logged-in Ethereum account (in practice, this entails signing a special message). As a side effect, it caches the user's secret Firn key in secure, encrypted storage (visible only within the Firn snap, and not to the calling website). If this method is called more than once, then the additional calls will be no-ops.

This method must be called before either of the below methods are. In practice, you may want to call this method immediately after prompting the user to connect the Snap in the first place.

```javascript
await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: { snapId: "npm:@firnprotocol/snap", request: { method: "initialize" } }
});
```

This method will either return nothing (upon success) or will throw an error (upon a failure).

### Request Balance

The `requestBalance` method prompts the user to disclose his Firn balance. The RPC method will _either_ return the user's Firn balance—denominated in _milliether_ (!)—as a plain JavaScript number, or will throw an error. Here's an example invocation:

```javascript
const balance = await window.ethereum.request({ // might throw; will be handled above
  method: "wallet_invokeSnap",
  params: { snapId: "npm:@firnprotocol/snap", request: { method: "requestBalance" } }
});
console.log(`User's Firn balance is ${(balance / 1000).toFixed(3)} ETH.`);
```

### Transact

The `transact` method prompts the user to anonymously execute a prescribed `transaction` using his Firn account. It will either return the `transactionHash` of the resulting successful, _mined_ transaction, or else will throw a descriptive error. Here's an example invocation:

```javascript
import { encodeFunctionData } from "viem";

const TOME_ABI = [{
  "inputs": [
    {
      "internalType": "string",
      "name": "message",
      "type": "string"
    }
  ],
  "name": "broadcast",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
}];
const data = encodeFunctionData({
  abi: TOME_ABI,
  functionName: "broadcast",
  args: ["A test message."],
});
const transaction = {
  to: "0x0D9993a3e3A0e73633c153CCf49A0bD17159A60D", // Tome address on Base
  data, // a bytes-like hex string
  value: 0, // a plain `Number`, denominated in milli-ether
};
const transactionHash = await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: { snapId: defaultSnapOrigin, request: { method: "transact", params: transaction } },
});
console.log(`Transaction successful! Its hash is ${transactionHash}.`);
```

Further details and usage examples can be found at [Tome](https://tome.fm).
