import * as mcl from "mcl-wasm";
import { toHex } from "viem/utils";

import { FIRN_ABI, READER_ABI } from "../constants/abis";
import { ADDRESSES } from "../constants/addresses";
import { nextEpoch } from "../utils/nextEpoch";
import { ElGamal, ElGamalVector, N, PointVector } from "./algebra";
import { BN128 } from "./bn128";
import { WithdrawalProof } from "./withdrawal";

export const EPOCH_LENGTH = 60;

class State {
  constructor() {
    // should i be using BNs?
    this.available = 0;
    this.pending = 0;
  }

  rollOver() {
    // is epoch necessary? will be called async.
    this.available += this.pending;
    this.pending = 0;
  }
}

export class Client {
  constructor({ secret }) {
    this.secret = secret;
    this.pub = BN128.toCompressed(mcl.mul(BN128.BASE, this.secret)); // we already computed this elsewhere, but...

    this.state = new State();
  }

  async initialize(publicClient, block, present, future) {
    // params won't be retained.
    this.blockNumber = block.blockNumber; // slightly after `present` and `future` were fetched?
    this.state.available += this.readBalance(present);
    this.state.pending += this.readBalance(future.sub(present));
    // +=, not equal, in case that reading takes long, and we receive funds in the mean time (possibly with a rollover).
    nextEpoch(publicClient, block).then((block) => {
      this.state.rollOver();
    });
  }

  readBalance(account) {
    const exponent = ElGamal.decrypt(account, this.secret);
    let accumulator = new mcl.G1();
    for (let i = 0; i < 2 ** 32; i++) {
      if (accumulator.isEqual(exponent)) return i;
      accumulator = mcl.add(accumulator, BN128.BASE);
    }
    // just do brute force, since worker seems very hard to do. not clear that we were ever gaining much through the workers, actually.
  }

  async withdraw(publicClient, amount, epoch, fee, destination, data, name) {
    const random = new Uint8Array(32);
    self.crypto.getRandomValues(random); // can i do this in snap?!?
    const anonset = await publicClient.readContract({
      address: ADDRESSES[name].READER,
      abi: READER_ABI,
      functionName: "sampleAnonset",
      args: [toHex(random), amount],
    });

    self.crypto.getRandomValues(random); // below only reads from {1, ..., N - 1}. relying on N ≤ 32?
    for (let i = N - 1; i > 0; i--) {
      const j = random[i] % (i + 1);
      const swap = anonset[j];
      anonset[j] = anonset[i];
      anonset[i] = swap;
    }
    let index;
    for (let i = 0; i < N; i++) {
      // am i or the recipient already in the anonset?
      if (anonset[i] === this.pub) index = i;
    }
    if (index === undefined) {
      index = random[0] & (N - 1);
      anonset[index] = this.pub; // is this secure?
    }
    const accounts = await publicClient.readContract({
      address: ADDRESSES[name].PROXY,
      abi: FIRN_ABI,
      functionName: "simulateAccounts",
      args: [anonset, epoch],
    });
    const Y = new PointVector(anonset.map(BN128.fromCompressed));
    const r = BN128.randomScalar();
    const D = mcl.mul(BN128.BASE, r);
    const C = new ElGamalVector(
      Y.vector.map((pub, i) => {
        let message = new mcl.G1();
        if (i === index) {
          const exponent = new mcl.Fr();
          exponent.setInt(-amount - fee);
          message = mcl.mul(ElGamal.base.g, exponent);
        }
        return new ElGamal(mcl.add(message, mcl.mul(pub, r)), D); // wastes a curve addition
      }),
    );
    const Cn = new ElGamalVector(
      accounts.map((account, i) =>
        ElGamal.deserialize(account).add(C.vector[i]),
      ),
    );
    const u = mcl.mul(BN128.gEpoch(epoch), this.secret);
    const proof = WithdrawalProof.prove(
      Y,
      Cn,
      C,
      epoch,
      this.secret,
      r,
      amount,
      this.state.available - amount - fee,
      index,
      fee,
      destination,
      data,
    );
    return [
      Y.vector.map(BN128.toCompressed),
      C.vector.map((ciphertext) => BN128.toCompressed(ciphertext.left)),
      BN128.toCompressed(D),
      BN128.toCompressed(u),
      proof.serialize(),
    ];
  }
}
