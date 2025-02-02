import { AmmImpl, DEVNET_POOL, PROGRAM_ID } from "@mercurial-finance/dynamic-amm-sdk"
import { clusterApiUrl, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet, AnchorProvider, BN } from '@coral-xyz/anchor';
import dotenv from "dotenv"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { derivePoolAddressWithConfig, getAssociatedTokenAccount } from "@mercurial-finance/dynamic-amm-sdk/dist/cjs/src/amm/utils";
import { SEEDS } from "@mercurial-finance/dynamic-amm-sdk/dist/cjs/src/amm/constants";
dotenv.config();

// function loadKeypairFromFile(filename: string): Keypair {
//     const secret = JSON.parse(fs.readFileSync(filename).toString()) as number[];
//     const secretKey = Uint8Array.from(secret);
//     return Keypair.fromSecretKey(secretKey);
// }

const mainnetConnection = new Connection('https://api.devnet.solana.com');
const payerKP = Keypair.fromSecretKey(bs58.decode(process.env.PAYER_SECRET_KEY || ""));
const payerWallet = new Wallet(payerKP);
console.log('payer %s', payerKP.publicKey);

const provider = new AnchorProvider(mainnetConnection, payerWallet, {
    commitment: 'confirmed',
});

type AllocationByPercentage = {
    address: PublicKey;
    percentage: number;
};

type AllocationByAmount = {
    address: PublicKey;
    amount: BN;
};
async function createPoolAndLockLiquidity(
    tokenAMint: PublicKey,
    tokenBMint: PublicKey,
    tokenAAmount: BN,
    tokenBAmount: BN,
    config: PublicKey,
    allocations: AllocationByPercentage[],
) {
    const programID = new PublicKey(PROGRAM_ID);
    const poolPubkey = derivePoolAddressWithConfig(tokenAMint, tokenBMint, config, programID);
    // Create the pool
    console.log('create pool %s', poolPubkey);
    let transactions = await AmmImpl.createPermissionlessConstantProductPoolWithConfig(
        provider.connection,
        payerWallet.publicKey,
        tokenAMint,
        tokenBMint,
        tokenAAmount,
        tokenBAmount,
        config,
    );
    for (const transaction of transactions) {
        transaction.sign(payerWallet.payer);
        const txHash = await provider.connection.sendRawTransaction(transaction.serialize());
        await provider.connection.confirmTransaction(txHash, 'finalized');
        console.log('transaction %s', txHash);
    }

    // Create escrow and lock liquidity
    const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from(SEEDS.LP_MINT), poolPubkey.toBuffer()], programID);
    const payerPoolLp = await getAssociatedTokenAccount(lpMint, payerWallet.publicKey);
    const payerPoolLpBalance = (await provider.connection.getTokenAccountBalance(payerPoolLp)).value.amount;
    console.log('payerPoolLpBalance %s', payerPoolLpBalance.toString());

    let allocationByAmounts = fromAllocationsToAmount(new BN(payerPoolLpBalance), allocations);
    const pool = await AmmImpl.create(provider.connection, poolPubkey);
    for (const allocation of allocationByAmounts) {
        console.log('Lock liquidity %s', allocation.address.toString());
        let transaction = await pool.lockLiquidity(allocation.address, allocation.amount, payerWallet.publicKey);
        transaction.sign(payerWallet.payer);
        const txHash = await provider.connection.sendRawTransaction(transaction.serialize());
        await provider.connection.confirmTransaction(txHash, 'finalized');
        console.log('transaction %s', txHash);
    }
}
function fromAllocationsToAmount(lpAmount: BN, allocations: AllocationByPercentage[]): AllocationByAmount[] {
    const sumPercentage = allocations.reduce((partialSum, a) => partialSum + a.percentage, 0);
    if (sumPercentage === 0) {
        throw Error('sumPercentage is zero');
    }

    let amounts: AllocationByAmount[] = [];
    let sum = new BN(0);
    for (let i = 0; i < allocations.length - 1; i++) {
        const amount = lpAmount.mul(new BN(allocations[i].percentage)).div(new BN(sumPercentage));
        sum = sum.add(amount);
        amounts.push({
            address: allocations[i].address,
            amount,
        });
    }
    // the last wallet get remaining amount
    amounts.push({
        address: allocations[allocations.length - 1].address,
        amount: lpAmount.sub(sum),
    });
    return amounts;
}

(async () => {
    console.log("Starting to create liquidity pool...")
    const tokenAMint = new PublicKey('CfmVE9LQqRAHmSGDVkUoRbtiHbPKERUDaZ7Skw8DT4zN');
    const tokenBMint = new PublicKey('BXTou3CvPxpFVAJvzvEZcAnRLGCHqT1LHKsFTSQft7s');

    // 2. Configuration address for the pool. It will decide the fees of the pool.
    const config = new PublicKey('21PjsfQVgrn56jSypUT5qXwwSjwKWvuoBCKbVZrgTLz4');

    // 3. Allocation of the locked LP to multiple address. In the below example
    // 4sBMz7zmDWPzdEnECJW3NA9mEcNwkjYtVnL2KySaWYAf will get 80% of the fee of the locked liquidity
    // CVV5MxfwA24PsM7iuS2ddssYgySf5SxVJ8PpAwGN2yVy will get 20% of the fee of the locked liquidity
    let allocations = [
        {
            address: new PublicKey('4sBMz7zmDWPzdEnECJW3NA9mEcNwkjYtVnL2KySaWYAf'),
            percentage: 80,
        },
        {
            address: new PublicKey('CVV5MxfwA24PsM7iuS2ddssYgySf5SxVJ8PpAwGN2yVy'),
            percentage: 20,
        },
    ];

    // 4. Amount of token A and B to be deposited to the pool, and will be locked.
    let tokenAAmount = new BN(100_000_000);
    let tokenBAmount = new BN(6000_000_000);

    await createPoolAndLockLiquidity(tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, config, allocations);
    console.log("Liquidity pool created at: ",)
})()